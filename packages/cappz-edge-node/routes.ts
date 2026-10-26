/**
 * COPE node crystallized.
 * Node ID: v15-12-00-edge-node-routes
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * --routes <port> (default 41450): the route host (src/lib/legacyPort/routeHost.ts)
 * that moves a PHP app off php-fpm one route at a time. nginx sends all traffic
 * here; routes not served yet are forwarded to PHP (CAPPZ_ROUTES_UPSTREAM).
 *
 *   CAPPZ_ROUTES_MODULE        your port module (exports `routes`; scaffold: tools/php-port.ts inventory)
 *   CAPPZ_ROUTES_UPSTREAM      the PHP app, e.g. http://127.0.0.1:8080 — unset once PHP is gone
 *   CAPPZ_ROUTES_DEFAULT_MODE  shadow (default: every written port is compared) | legacy | serve
 *                              (serve only with no upstream: an app whose PHP is already gone)
 *   CAPPZ_ROUTES_SAMPLE        fraction of shadow requests compared (default 1)
 *   CAPPZ_ROUTES_VERIFY=1      KeyZ Gate in front (evidence files as --verify)
 *   CAPPZ_ROUTE_OPERATORS      wallets whose signed cut-over / rollback requests count
 *   CAPPZ_CUTOVER_MIN_REQUESTS, CAPPZ_CUTOVER_MIN_DAYS   the gate (defaults 1000, 7)
 *   CAPPZ_ROUTES_REUSE_PORT=1  one process per core; give each CAPPZ_ROUTES_INSTANCE=<n> (its
 *                              evidence file); the control process merges them into one report
 *
 * Control on loopback only (<port>+1, CAPPZ_ROUTES_CONTROL_PORT; 0 = none, for extra reuse-port processes): GET /cappz/routes,
 * GET /cappz/routes/nginx (locations for ported routes only — unported ones stay nginx → php-fpm),
 * GET /cappz/routes/report?route=GET%20/api/x, POST /cappz/routes/mode (RFC 9421-signed
 * by an operator's declared key; { route, mode: serve|shadow|legacy, because }). A cut-over
 * is refused unless the route's report passes its gate at that moment; the node signs
 * LegacyRouteCutOver / LegacyRouteRolledBack into <CAPPZ_NODE_DATA>/edge-txs.jsonl, and
 * modes are replayed from those TXs. Effects a served port emits are signed and appended
 * there too. Shadow evidence persists in route-shadow.json every 30 s (atomic).
 */

import { createRouteHost, nginxLocations, replayRouteModes, type PortedRoute, type PortEffect, type RouteMode } from '../../src/lib/legacyPort/routeHost.ts';
import { createRouteShadow, DEFAULT_CUTOVER_POLICY, type RouteShadowState } from '../../src/lib/legacyPort/responseShadow.ts';
import { createReloader } from '../../src/lib/identity/evidenceReload.ts';
import { canonicalJson, sha256HexOf } from '../../src/lib/identity/canonical.ts';
import { signEdgeTx, type SignedEdgeTx, type UnsignedEdgeTx } from '../../src/lib/functions/edgeJobs.ts';
import { loadNodeKey } from './nodeKey.ts';
import { verifyGatewayFor } from './verifyGateway.ts';

const P = "m/44'/144'/100'/principles/cope/v1";
const env = (k: string) => Deno.env.get(k)?.trim() || undefined;
const moduleUrl = (p: string) => (p.startsWith('/') ? `file://${p}` : new URL(p, `file://${Deno.cwd()}/`).href);
const num = (k: string, d: number) => { const v = env(k); return v !== undefined && Number.isFinite(Number(v)) ? Number(v) : d; };

export async function serveRoutes(o: { port: number; dataDir: string; nodeAddress: string; routes?: PortedRoute[] }): Promise<void> {
  const routes = o.routes ?? (env('CAPPZ_ROUTES_MODULE') ? (await import(moduleUrl(env('CAPPZ_ROUTES_MODULE')!))).routes as PortedRoute[] : []);
  const key = await loadNodeKey();
  const logPath = `${o.dataDir}/edge-txs.jsonl`;
  await Deno.mkdir(o.dataDir, { recursive: true });

  // One evidence file per process (CAPPZ_ROUTES_INSTANCE with reuse-port); the control process merges them.
  const instance = env('CAPPZ_ROUTES_INSTANCE') ?? '0';
  const statePath = `${o.dataDir}/route-shadow${instance === '0' ? '' : `-${instance}`}.json`;
  let state: Record<string, RouteShadowState> | undefined;
  try { state = JSON.parse(await Deno.readTextFile(statePath)); } catch { /* first run */ }
  const policy = { ...DEFAULT_CUTOVER_POLICY, minRequests: num('CAPPZ_CUTOVER_MIN_REQUESTS', DEFAULT_CUTOVER_POLICY.minRequests), minDays: num('CAPPZ_CUTOVER_MIN_DAYS', DEFAULT_CUTOVER_POLICY.minDays) };
  const shadow = createRouteShadow({ state, policy });
  setInterval(() => { Deno.writeTextFile(`${statePath}.tmp`, JSON.stringify(shadow.state())).then(() => Deno.rename(`${statePath}.tmp`, statePath)).catch((e) => console.warn('[edge-node] route evidence not saved:', e?.message ?? e)); }, 5_000);
  const siblings = async (route: string): Promise<RouteShadowState[]> => {
    const out: RouteShadowState[] = [];
    for await (const e of Deno.readDir(o.dataDir)) {
      if (!/^route-shadow-[\w-]+\.json$/.test(e.name) || `${o.dataDir}/${e.name}` === statePath) continue;
      try { const st = JSON.parse(await Deno.readTextFile(`${o.dataDir}/${e.name}`)) as Record<string, RouteShadowState>; if (st[route]) out.push(st[route]); } catch { /* being written */ }
    }
    return out;
  };
  const cost = { instanceUsdPerHour: num('CAPPZ_COST_USD_PER_HOUR', 0.034), vcpus: num('CAPPZ_COST_VCPUS', 2), label: env('CAPPZ_COST_LABEL') ?? 'assumption: set CAPPZ_COST_USD_PER_HOUR to your instance price' };

  // Modes are replayed from the node's own signed TXs; re-read only when the log changes.
  let seenMtime = -1; let cached: Record<string, RouteMode> = {};
  const readModes = async () => {
    try {
      const st = await Deno.stat(logPath); const m = st.mtime?.getTime() ?? 0;
      if (m === seenMtime) return cached;
      const txs = (await Deno.readTextFile(logPath)).split('\n').filter((l) => l.includes('"LegacyRoute')).map((l) => JSON.parse(l) as SignedEdgeTx);
      const replayed = replayRouteModes(txs);
      // A rollback after a route's evidence began means the port changed: every process starts that route again.
      for (const [k, v] of Object.entries(replayed)) { const since = shadow.startedAt(k); if (v.mode !== 'serve' && since !== undefined && Date.parse(v.at) > since) shadow.reset(k); }
      cached = Object.fromEntries(Object.entries(replayed).map(([k, v]) => [k, v.mode])); seenMtime = m;
    } catch (e) { if (!(e instanceof Deno.errors.NotFound)) throw e; }
    return cached;
  };
  let modes = createReloader(readModes, 1000);

  const append = async (txs: UnsignedEdgeTx[]) => {
    if (!key) throw new Error('the node has no key (CAPPZ_NODE_KEY): it never writes an unsigned TX');
    const lines = (await Promise.all(txs.map((t) => signEdgeTx(t, key)))).map((t) => JSON.stringify(t)).join('\n') + '\n';
    await Deno.writeTextFile(logPath, lines, { append: true });
  };
  const write = async (effects: PortEffect[], route: string) => {
    const at = new Date().toISOString();
    await append(await Promise.all(effects.map(async (e) => ({
      txId: `${e.eventType}-${(await sha256HexOf(`${route}|${e.targetAddress}|${canonicalJson(e.payload)}|${at}`)).slice(0, 32)}`,
      timestamp: at, eventType: e.eventType, sourceAddress: o.nodeAddress, targetAddress: e.targetAddress,
      payload: { ...e.payload, portedRoute: route, governingPrinciple: (e.payload.governingPrinciple as string) ?? `${P}#local-first` },
    }))));
  };

  const defaultMode = (env('CAPPZ_ROUTES_DEFAULT_MODE') ?? 'shadow') as RouteMode;
  if (!['legacy', 'shadow', 'serve'].includes(defaultMode)) throw new Error('CAPPZ_ROUTES_DEFAULT_MODE must be legacy, shadow or serve');
  // Serving without a cut-over record is only for an app with no legacy runtime left to compare against.
  if (defaultMode === 'serve' && env('CAPPZ_ROUTES_UPSTREAM')) throw new Error('CAPPZ_ROUTES_DEFAULT_MODE=serve needs no legacy upstream: with PHP still running, routes move by edge.route.cutover on their report');
  const verify = env('CAPPZ_ROUTES_VERIFY') === '1' ? verifyGatewayFor(o.dataDir) : undefined;
  const host = createRouteHost({
    routes, upstream: env('CAPPZ_ROUTES_UPSTREAM'), modes: () => modes(), defaultMode,
    shadow, shadowSample: num('CAPPZ_ROUTES_SAMPLE', 1), write, verify, maxBodyBytes: num('CAPPZ_ROUTES_MAX_BODY', 10 * 1024 * 1024),
  });

  const hostname = env('CAPPZ_ROUTES_HOST') ?? '127.0.0.1';
  console.log(`[edge-node] route host ${hostname}:${o.port}  ${routes.length} route(s)${env('CAPPZ_ROUTES_UPSTREAM') ? `, legacy → ${env('CAPPZ_ROUTES_UPSTREAM')}` : ', no legacy upstream (PHP retired)'}${verify ? ', KeyZ Gate in front' : ''}`);
  Deno.serve({ port: o.port, hostname, reusePort: env('CAPPZ_ROUTES_REUSE_PORT') === '1', onListen: () => {} }, (req) => host.handle(req));

  // Control: loopback only, never behind the public proxy.
  const operators = new Set((env('CAPPZ_ROUTE_OPERATORS') ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  const gate = verifyGatewayFor(o.dataDir);
  const keys = [...new Set(routes.flatMap((r) => (Array.isArray(r.method) ? r.method : [r.method]).map((m) => `${m.toUpperCase()} ${r.path}`)))];
  const controlPort = num('CAPPZ_ROUTES_CONTROL_PORT', o.port + 1);
  if (controlPort === 0) return; // extra reuse-port processes: one process owns control
  Deno.serve({ port: controlPort, hostname: '127.0.0.1', onListen: () => console.log(`[edge-node] route control 127.0.0.1:${controlPort}  (GET /cappz/routes, POST /cappz/routes/mode)`) }, async (req) => {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/cappz/routes') {
      const m = await modes();
      return Response.json(await Promise.all(keys.map(async (k) => { const r = await shadow.report(k, cost, await siblings(k)); return { route: k, mode: m[k] ?? 'default', requests: r.requests, matchPct: r.matchPct, mismatches: r.counts.mismatch, portErrors: r.counts['port-error'], ready: r.cutover.ready, p50Ms: { legacy: r.latencyMs.legacy.p50, port: r.latencyMs.port.p50 } }; })));
    }
    if (req.method === 'GET' && url.pathname === '/cappz/routes/nginx') return new Response(nginxLocations(routes), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    if (req.method === 'GET' && url.pathname === '/cappz/routes/report') {
      const k = url.searchParams.get('route') ?? '';
      if (!keys.includes(k)) return Response.json({ error: 'unknown route', routes: keys }, { status: 404 });
      return Response.json(await shadow.report(k, cost, await siblings(k)));
    }
    if (req.method === 'POST' && url.pathname === '/cappz/routes/mode') {
      const raw = new Uint8Array(await req.arrayBuffer());
      const v = await gate.verifyRequest(req, raw);
      const wallet = v.walletAddress?.toLowerCase();
      if (!v.allowed || !wallet || !['declared', 'delegated', 'operator-listed'].includes(v.trust)) return Response.json({ error: `mode changes must be signed by a declared key: ${v.signature} ${v.trust}` }, { status: 401 });
      if (!operators.has(wallet)) return Response.json({ error: 'this wallet is not in CAPPZ_ROUTE_OPERATORS' }, { status: 403 });
      let body: { route?: string; mode?: string; because?: string; reviewedHash?: string };
      try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { return Response.json({ error: 'JSON body { route, mode, because }' }, { status: 400 }); }
      const route = body.route ?? '';
      if (!keys.includes(route)) return Response.json({ error: 'unknown route', routes: keys }, { status: 404 });
      const at = new Date().toISOString();
      const id = async (t: string) => `${t}-${(await sha256HexOf(`${route}|${at}|${wallet}`)).slice(0, 32)}`;
      let tx: UnsignedEdgeTx;
      if (body.mode === 'serve') {
        const r = await shadow.report(route, cost, await siblings(route));
        if (!r.cutover.ready) return Response.json({ error: 'the cut-over gate has not passed', because: r.cutover.because, reportHash: r.reportHash }, { status: 409 });
        tx = { txId: await id('LegacyRouteCutOver'), timestamp: at, eventType: 'LegacyRouteCutOver', sourceAddress: o.nodeAddress, targetAddress: `${o.nodeAddress}/routes`, payload: { route, reportHash: r.reportHash, reviewedHash: body.reviewedHash ?? null, requests: r.requests, days: r.days, matchPct: r.matchPct, operator: wallet, because: String(body.because ?? ''), governingPrinciple: P } };
      } else if (body.mode === 'legacy' || body.mode === 'shadow') {
        tx = { txId: await id('LegacyRouteRolledBack'), timestamp: at, eventType: 'LegacyRouteRolledBack', sourceAddress: o.nodeAddress, targetAddress: `${o.nodeAddress}/routes`, payload: { route, to: body.mode, operator: wallet, because: String(body.because ?? ''), governingPrinciple: P } };
      } else return Response.json({ error: 'mode must be serve, shadow or legacy' }, { status: 400 });
      try { await append([tx]); } catch (e) { return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 503 }); }
      modes = createReloader(readModes, 1000); seenMtime = -1;
      return Response.json({ ok: true, tx: tx.eventType, route, mode: body.mode, txId: tx.txId });
    }
    return Response.json({ error: 'GET /cappz/routes · GET /cappz/routes/report?route= · POST /cappz/routes/mode' }, { status: 404 });
  });
}
