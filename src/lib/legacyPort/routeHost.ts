/**
 * COPE node crystallized.
 * Node ID: v15-12-00-route-host
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * One Fetch handler that moves a legacy app (PHP) off its runtime one route at
 * a time — the strangler pattern with evidence at every step. Each route is in
 * one mode:
 *
 *   legacy   forwarded to the legacy upstream (php-fpm behind nginx) — the default
 *   shadow   forwarded; the legacy response is returned at once, and off the hot
 *            path the ported handler runs on the same request in dry-run mode
 *            (effects recorded, never written) and the two responses are compared
 *            (responseShadow.ts). Capacity-bounded: a shadow never slows a reply
 *   serve    the ported handler answers; the legacy runtime is not called
 *
 * Unknown paths go to the upstream; with no upstream (the legacy runtime is
 * gone) they answer 404. A handler still returning notPorted() always falls
 * back to legacy, so a scaffold can be deployed before any port is written.
 * Optional KeyZ Gate in front: requests are verified once, and handlers see
 * the verdict instead of re-checking signatures or sessions.
 *
 * Modes come from replayed LegacyRouteCutOver / LegacyRouteRolledBack TXs
 * (`replayRouteModes`), so who moved which route on what evidence is in the
 * record; the host only reads them. Matching is a precompiled table (exact
 * paths in a map, parameter patterns by segment count): no per-request I/O.
 */

import type { EdgeVerdict, VerifyGateway } from '../identity/edgeVerify.ts';
import { readBounded } from '../identity/edgeVerify.ts';
import { compareResponses, createRouteShadow, type CapturedResponse, type CompareRules } from './responseShadow.ts';

export type RouteMode = 'legacy' | 'shadow' | 'serve';

/** What a ported handler would write: the host signs and appends it in serve mode; in shadow it is only counted. */
export interface PortEffect { eventType: string; targetAddress: string; payload: Record<string, unknown> }

export interface RouteContext {
  params: Record<string, string>;
  query: URLSearchParams;
  /** 'shadow' = dry run: emit() records, nothing is written; do not call third parties. */
  mode: 'shadow' | 'serve';
  emit(effect: PortEffect): void;
  /** KeyZ Gate verdict when the host verifies (who signed, key trust); undefined otherwise. */
  verdict?: EdgeVerdict;
}

export interface PortedRoute {
  method: string | string[];
  /** /api/orders/:id — `:name` segments become params; a trailing `*` matches the rest. */
  path: string;
  handler(req: Request, ctx: RouteContext): Response | Promise<Response>;
  compare?: CompareRules;
  /** Where the legacy code lives (shown in reports and the plan), e.g. api/orders.php#show. */
  legacySource?: string;
}

const NOT_PORTED = 'cappz-not-ported';
/**
 * A scaffold stub (`handler: notPorted`): the host treats the route as legacy until the handler is
 * written, and nginxLocations() leaves it out, so unported routes go to PHP with no extra hop.
 * A handler may also return notPorted() for some requests to hand just those to legacy.
 */
export const notPorted = (): Response => new Response(null, { status: 501, headers: { [NOT_PORTED]: '1' } });
export const isPorted = (r: PortedRoute): boolean => r.handler !== notPorted;

/**
 * nginx locations for the ported routes only: include them in the server block above the PHP
 * location (`location =` for exact paths, an anchored regex for :params, `^~` for a trailing *).
 * Everything else keeps going straight to php-fpm.
 */
export function nginxLocations(routes: PortedRoute[], upstream = 'cappz_routes'): string {
  const seen = new Set<string>(); const out: string[] = ['# Generated: ported routes → the CAPPZ route host. Regenerate after each port; nginx -s reload.'];
  const body = `{ proxy_pass http://${upstream}; proxy_http_version 1.1; proxy_set_header Connection ""; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; }`;
  for (const r of routes.filter(isPorted)) {
    const segs = r.path.split('/').filter(Boolean);
    const loc = segs[segs.length - 1] === '*' ? `location ^~ /${segs.slice(0, -1).join('/')}/`
      : segs.some((x) => x.startsWith(':')) ? `location ~ ^/${segs.map((x) => (x.startsWith(':') ? '[^/]+' : x.replace(/[.^$*+?()[\]{}|\\]/g, '\\$&'))).join('/')}$`
        : `location = /${segs.join('/')}`;
    if (seen.has(loc)) continue; seen.add(loc);
    out.push(`${loc} ${body}`);
  }
  return out.join('\n') + '\n';
}
export const defineRoute = (r: PortedRoute): PortedRoute => r;
export const routeKey = (method: string, path: string) => `${method.toUpperCase()} ${path}`;

interface Compiled { key: string; route: PortedRoute; segments: string[]; rest: boolean }

/** Precompiled matcher: exact paths by `METHOD path`, parameter patterns by segment count. */
export function compileRoutes(routes: PortedRoute[]) {
  const exact = new Map<string, Compiled>(); const byLen = new Map<number, Compiled[]>(); const rest: Compiled[] = [];
  for (const route of routes) {
    for (const m of Array.isArray(route.method) ? route.method : [route.method]) {
      const segments = route.path.split('/').filter(Boolean);
      const isRest = segments[segments.length - 1] === '*';
      const c: Compiled = { key: routeKey(m, route.path), route, segments: isRest ? segments.slice(0, -1) : segments, rest: isRest };
      if (!isRest && !segments.some((s) => s.startsWith(':'))) exact.set(`${m.toUpperCase()} /${segments.join('/')}`, c);
      else if (isRest) rest.push(c);
      else { const l = byLen.get(segments.length) ?? []; l.push(c); byLen.set(segments.length, l); }
    }
  }
  return (method: string, pathname: string): { c: Compiled; params: Record<string, string> } | null => {
    const m = method.toUpperCase(); const norm = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
    const hit = exact.get(`${m} ${norm}`) ?? (m === 'HEAD' ? exact.get(`GET ${norm}`) : undefined);
    if (hit) return { c: hit, params: {} };
    const parts = norm.split('/').filter(Boolean);
    const tryOne = (c: Compiled): Record<string, string> | null => {
      const cm = c.key.slice(0, c.key.indexOf(' '));
      if (cm !== m && !(m === 'HEAD' && cm === 'GET')) return null;
      const params: Record<string, string> = {};
      for (let i = 0; i < c.segments.length; i++) {
        const s = c.segments[i];
        if (s.startsWith(':')) { try { params[s.slice(1)] = decodeURIComponent(parts[i]); } catch { return null; } } else if (s !== parts[i]) return null;
      }
      if (c.rest) params['*'] = parts.slice(c.segments.length).join('/');
      return params;
    };
    for (const c of byLen.get(parts.length) ?? []) { const p = tryOne(c); if (p) return { c, params: p }; }
    for (const c of rest) if (parts.length >= c.segments.length) { const p = tryOne(c); if (p) return { c, params: p }; }
    return null;
  };
}

/** Route modes from the record: the latest LegacyRouteCutOver / LegacyRouteRolledBack per route, in timestamp order. */
export function replayRouteModes(txs: Array<{ eventType: string; timestamp: string; payload: Record<string, unknown> }>): Record<string, { mode: RouteMode; reportHash?: string; at: string }> {
  const out: Record<string, { mode: RouteMode; reportHash?: string; at: string }> = {};
  for (const t of [...txs].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
    const route = typeof t.payload.route === 'string' ? t.payload.route : null;
    if (!route) continue;
    if (t.eventType === 'LegacyRouteCutOver') out[route] = { mode: 'serve', reportHash: String(t.payload.reportHash ?? ''), at: t.timestamp };
    else if (t.eventType === 'LegacyRouteRolledBack') out[route] = { mode: (t.payload.to === 'shadow' ? 'shadow' : 'legacy'), at: t.timestamp };
  }
  return out;
}

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'host', 'content-length', 'expect'];

export interface RouteHostOptions {
  routes: PortedRoute[];
  /** Legacy runtime: base URL (http://127.0.0.1:8080) or a fetch function; omit once it is gone. */
  upstream?: string | ((req: Request) => Promise<Response>);
  /** Current modes by route key; read per request, so make it cheap (createReloader over the TX log). */
  modes?: () => Record<string, RouteMode> | Promise<Record<string, RouteMode>>;
  /** Mode of a ported route with no recorded mode. 'shadow' compares every written port automatically. */
  defaultMode?: RouteMode;
  shadow?: ReturnType<typeof createRouteShadow>;
  /** Fraction of shadow-mode requests compared (0..1). Default 1. */
  shadowSample?: number;
  /** Concurrent background comparisons; beyond this a request is counted as skipped. Default 64. */
  maxShadowInflight?: number;
  /** Port handler budget in shadow (ms). Default 5000. */
  shadowTimeoutMs?: number;
  /** Serve mode: write what handlers emit (sign + append). */
  write?: (effects: PortEffect[], route: string) => Promise<void>;
  /** KeyZ Gate in front of every route; refused requests never reach legacy or port. */
  verify?: VerifyGateway;
  maxBodyBytes?: number;
  /** Bounded legacy response buffering (needed to compare and to avoid the streamed-reply stall). Default 8 MB. */
  maxLegacyBodyBytes?: number;
  now?: () => number;
}

export interface RouteHost {
  handle(req: Request): Promise<Response>;
  /** Wait for in-flight background comparisons (tests, graceful stop). */
  drain(): Promise<void>;
}

export function createRouteHost(o: RouteHostOptions): RouteHost {
  const match = compileRoutes(o.routes);
  const shadow = o.shadow ?? createRouteShadow();
  const sample = o.shadowSample ?? 1;
  const maxInflight = o.maxShadowInflight ?? 64;
  const perf = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const inflight = new Set<Promise<void>>();

  async function legacy(req: Request, url: URL, body: Uint8Array | undefined): Promise<Response> {
    if (!o.upstream) return Response.json({ error: 'not found (the legacy runtime is retired)' }, { status: 404 });
    const h = new Headers(req.headers);
    for (const x of [...HOP_BY_HOP, ...(req.headers.get('connection') ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)]) h.delete(x);
    h.set('x-original-host', url.host);
    const init: RequestInit = { method: req.method, headers: h, body: body && !['GET', 'HEAD'].includes(req.method) ? body as BodyInit : undefined, redirect: 'manual' };
    if (typeof o.upstream === 'function') return o.upstream(new Request(req.url, init));
    return fetch(o.upstream.replace(/\/$/, '') + url.pathname + url.search, init);
  }

  async function capture(res: Response, max: number): Promise<CapturedResponse | null> {
    if (!res.body) return { status: res.status, headers: res.headers, body: new Uint8Array() };
    const declared = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > max) { await res.body.cancel().catch(() => {}); return null; }
    const reader = res.body.getReader(); const parts: Uint8Array[] = []; let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > max) { await reader.cancel().catch(() => {}); return null; }
      parts.push(value);
    }
    const out = parts.length === 1 ? parts[0] : new Uint8Array(n);
    if (parts.length !== 1) { let off = 0; for (const p of parts) { out.set(p, off); off += p.length; } }
    return { status: res.status, headers: res.headers, body: out };
  }

  const reply = (c: CapturedResponse) => {
    const h = new Headers(c.headers); h.delete('content-encoding'); h.delete('transfer-encoding'); h.delete('content-length');
    return new Response(c.status === 204 || c.status === 304 ? null : c.body as BodyInit, { status: c.status, headers: h });
  };

  const run = async (route: PortedRoute, req: Request, ctx: RouteContext) => route.handler(req, ctx);

  function compareLater(key: string, route: PortedRoute, req: Request, url: URL, body: Uint8Array | undefined, params: Record<string, string>, verdict: EdgeVerdict | undefined, legacyRes: CapturedResponse, legacyMs: number): void {
    if (sample < 1 && Math.random() >= sample) { shadow.record(key, { outcome: 'skipped', method: req.method, path: url.pathname }); return; }
    if (inflight.size >= maxInflight) { shadow.record(key, { outcome: 'skipped', method: req.method, path: url.pathname }); return; }
    const p = (async () => {
      const effects: string[] = [];
      const ctx: RouteContext = { params, query: url.searchParams, mode: 'shadow', emit: (e) => { effects.push(e.eventType); }, verdict };
      const t0 = perf();
      try {
        const portReq = new Request(req.url, { method: req.method, headers: req.headers, body: body && !['GET', 'HEAD'].includes(req.method) ? body as BodyInit : undefined });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const res = await Promise.race([run(route, portReq, ctx), new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error('port timed out')), o.shadowTimeoutMs ?? 5000); })]).finally(() => clearTimeout(timer));
        const portMs = perf() - t0;
        if (res.headers.get(NOT_PORTED)) return;
        const c = await capture(res, o.maxLegacyBodyBytes ?? 8 * 1024 * 1024);
        if (!c) { shadow.record(key, { outcome: 'port-error', method: req.method, path: url.pathname, where: ['port body too large'], legacyMs, portMs }); return; }
        const where = compareResponses(legacyRes, c, req.method === 'HEAD' ? { ...route.compare, statusOnly: true } : route.compare);
        shadow.record(key, { outcome: where.length ? 'mismatch' : 'match', method: req.method, path: url.pathname, where, legacyStatus: legacyRes.status, portStatus: c.status, legacyMs, portMs, effects });
      } catch (e) {
        shadow.record(key, { outcome: 'port-error', method: req.method, path: url.pathname, where: [e instanceof Error ? e.message.slice(0, 120) : 'threw'], legacyStatus: legacyRes.status, legacyMs, portMs: perf() - t0 });
      }
    })().finally(() => { inflight.delete(p); });
    inflight.add(p);
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const hit = match(req.method, url.pathname);
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const needsBody = hasBody && (!!hit || !!o.verify);
    let body: Uint8Array | undefined;
    if (needsBody) {
      const b = await readBounded(req, o.maxBodyBytes ?? 10 * 1024 * 1024);
      if (!b) return Response.json({ error: 'request body too large' }, { status: 413 });
      body = b;
    }
    let verdict: EdgeVerdict | undefined;
    if (o.verify) {
      verdict = await o.verify.verifyRequest(req, body);
      if (!verdict.allowed) return Response.json(verdict, { status: verdict.status });
    }
    if (!hit) {
      const res = await legacy(req, url, hasBody ? body ?? new Uint8Array(await req.arrayBuffer()) : undefined);
      const c = await capture(res, o.maxLegacyBodyBytes ?? 8 * 1024 * 1024);
      return c ? reply(c) : Response.json({ error: 'legacy response too large to relay' }, { status: 502 });
    }
    const { c: compiled, params } = hit;
    const key = compiled.key;
    const modes = o.modes ? await o.modes() : {};
    const mode: RouteMode = isPorted(compiled.route) ? modes[key] ?? o.defaultMode ?? 'legacy' : 'legacy';

    if (mode === 'serve') {
      const effects: PortEffect[] = [];
      const res = await run(compiled.route, new Request(req.url, { method: req.method, headers: req.headers, body: body as BodyInit | undefined }), { params, query: url.searchParams, mode: 'serve', emit: (e) => { effects.push(e); }, verdict });
      if (!res.headers.get(NOT_PORTED)) {
        if (effects.length) {
          if (!o.write) return Response.json({ error: 'this port writes, but the host has no writer (node key)' }, { status: 503 });
          await o.write(effects, key);
        }
        return res;
      }
    }
    const t0 = perf();
    let legacyRes: CapturedResponse | null;
    try { legacyRes = await capture(await legacy(req, url, body), o.maxLegacyBodyBytes ?? 8 * 1024 * 1024); }
    catch (e) {
      if (mode === 'shadow') shadow.record(key, { outcome: 'legacy-error', method: req.method, path: url.pathname });
      return Response.json({ error: `legacy upstream unreachable: ${e instanceof Error ? e.message : e}` }, { status: 502 });
    }
    if (!legacyRes) return Response.json({ error: 'legacy response too large to relay' }, { status: 502 });
    const legacyMs = perf() - t0;
    if (mode === 'shadow') {
      if (legacyRes.status >= 500) shadow.record(key, { outcome: 'legacy-error', method: req.method, path: url.pathname, legacyStatus: legacyRes.status, legacyMs });
      else compareLater(key, compiled.route, req, url, body, params, verdict, legacyRes, legacyMs);
    }
    return reply(legacyRes);
  }

  return { handle, drain: async () => { while (inflight.size) await Promise.all([...inflight]); } };
}
