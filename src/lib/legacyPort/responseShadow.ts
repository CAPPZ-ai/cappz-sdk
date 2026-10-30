/**
 * COPE node crystallized.
 * Node ID: v15-12-00-response-shadow
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Move a legacy route (a PHP endpoint) to a ported handler on evidence. The
 * route host answers with the legacy response and, off the hot path, runs the
 * ported handler on the same request in dry-run mode; this module compares the
 * two responses and keeps per-route evidence:
 *
 *   match        same status, compared headers and body (after the route's rules)
 *   mismatch     different — the report keeps where (status, a header, a JSON path,
 *                text), never the bodies, so personal data does not pile up
 *   port-error   the ported handler threw or timed out
 *   legacy-error the legacy route itself failed (5xx / unreachable): not counted against the port
 *
 * Cut-over is ready only when enough requests over enough days matched with no
 * unexplained mismatch and no port error. Rules make known, harmless
 * differences explicit (a timestamp path, a CSRF token pattern) instead of
 * averaging them away. PHP's json_encode writes an empty associative array as
 * [], so [] and {} compare equal unless a route turns that off. The report is
 * hashed: edge.route.cutover → LegacyRouteCutOver cites exactly the evidence.
 */

import { canonicalJson, sha256HexOf } from '../identity/canonical.ts';
import { addHist, newHist, quantile, type CostAssumptions, type Histogram } from '../identity/shadowCompare.ts';

export interface CompareRules {
  /** Headers compared (lower-case). Default: content-type (media type only) and location. */
  headers?: string[];
  /** JSON paths ignored, e.g. $.generatedAt, $.items[*].updatedAt, $..requestId (any depth). */
  ignoreJsonPaths?: string[];
  /**
   * Spans blanked in text bodies before comparing (CSRF tokens, nonces): literal
   * text with `*` holes, e.g. `name="_token" value="*"`. A hole is a run without
   * the first character of the literal after it (here `"`); a trailing hole runs
   * to the end of the line; `\*` is a literal star. Never compiled as a regex.
   */
  ignoreTemplates?: string[];
  /**
   * Legacy: regular-expression sources. Only literals joined by `[^c]*` (where c
   * starts the next literal) are honoured, read as templates; any other pattern
   * is reported as a mismatch (`ignore rule unsupported`) instead of compiled.
   */
  ignorePatterns?: string[];
  /** Collapse whitespace between HTML tags and runs of whitespace. Default true for text/html. */
  normalizeHtml?: boolean;
  /** [] equals {} (PHP json_encode writes an empty associative array as []). Default true. */
  emptyArrayEqualsObject?: boolean;
  /** Compare only the status code (for routes whose body is legitimately different each time). */
  statusOnly?: boolean;
}

export interface CapturedResponse { status: number; headers: Headers; body: Uint8Array }
export type Outcome = 'match' | 'mismatch' | 'port-error' | 'legacy-error' | 'skipped';

const td = new TextDecoder();
const mediaType = (h: string | null) => (h ?? '').split(';')[0].trim().toLowerCase();

const segmentsOf = (p: string): string[] => Array.from(p.matchAll(/\.([^.[\]]+)|\[(\d+|\*)\]/g), (m) => (m[1] !== undefined ? m[1] : `[${m[2]}]`));
const segMatch = (pat: string, seg: string) => pat === '*' || pat === seg || (pat === '[*]' && seg.charCodeAt(0) === 91);
const render = (segs: string[]) => '$' + segs.map((s) => (s.charCodeAt(0) === 91 ? s : `.${s}`)).join('');

/** $.a.b, $.items[*].x and $.*.x match one segment per step; $..x matches x (or a deeper path ending in it) at any depth. */
interface Ignore { deep: boolean; segs: string[] }
const compiledIgnores = new WeakMap<CompareRules, Ignore[]>();
const ignoresOf = (r: CompareRules) => {
  let c = compiledIgnores.get(r);
  if (!c) { c = (r.ignoreJsonPaths ?? []).map((p) => (p.startsWith('$..') ? { deep: true, segs: segmentsOf(`$.${p.slice(3)}`) } : { deep: false, segs: segmentsOf(p) })); compiledIgnores.set(r, c); }
  return c;
};
function ignored(ig: Ignore[], segs: string[]): boolean {
  for (const p of ig) {
    const off = segs.length - p.segs.length;
    if (p.deep ? off < 0 : off !== 0) continue;
    let ok = true;
    for (let i = 0; i < p.segs.length; i++) if (!segMatch(p.segs[i], segs[off + i])) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const isEmpty = (x: unknown) => (Array.isArray(x) && x.length === 0) || (isObj(x) && Object.keys(x).length === 0);

// segs is the current path, pushed and popped in place: no strings are built unless a difference is reported.
function jsonDiff(a: unknown, b: unknown, segs: string[], ig: Ignore[], emptyEq: boolean, out: string[]): void {
  if (out.length >= 8 || a === b) return;
  if (ig.length && ignored(ig, segs)) return;
  if (emptyEq && isEmpty(a) && isEmpty(b)) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) { out.push(`${render(segs)} length ${a.length}≠${b.length}`); return; }
    for (let i = 0; i < a.length; i++) { segs.push(`[${i}]`); jsonDiff(a[i], b[i], segs, ig, emptyEq, out); segs.pop(); }
    return;
  }
  if (isObj(a) && isObj(b)) {
    for (const k in a) {
      segs.push(k);
      if (!own(b, k)) { if (!(ig.length && ignored(ig, segs))) out.push(`${render(segs)} missing in port`); }
      else jsonDiff(a[k], b[k], segs, ig, emptyEq, out);
      segs.pop();
    }
    for (const k in b) if (!own(a, k)) { segs.push(k); if (!(ig.length && ignored(ig, segs))) out.push(`${render(segs)} only in port`); segs.pop(); }
    return;
  }
  out.push(`${render(segs)} ${typeof a === typeof b ? 'value' : `type ${typeof a}≠${typeof b}`}`);
}

function normalText(s: string, html: boolean, templates: Template[]): string {
  let t = s;
  for (const tpl of templates) t = blankTemplate(t, tpl);
  if (html) t = t.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();
  return t;
}

/** Literal parts of an ignore template; a hole sits between consecutive parts (and after the last when `open`). */
interface Template { parts: string[]; open: boolean }

function parseTemplate(src: string): Template | null {
  const parts: string[] = []; let cur = '';
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\\' && src[i + 1] === '*') { cur += '*'; i++; }
    else if (src[i] === '*') { parts.push(cur); cur = ''; }
    else cur += src[i];
  }
  parts.push(cur);
  const open = parts.length > 1 && parts[parts.length - 1] === '';
  if (open) parts.pop();
  if (!parts[0] || parts.slice(1).some((p) => !p)) return null; // needs a literal start and no adjacent holes
  return { parts, open };
}

const REGEX_SYNTAX = new Set(['\\', '^', '$', '.', '|', '?', '*', '+', '(', ')', '[', ']', '{', '}']);

/** A legacy regex source read as a template: literals joined by `[^c]*` where c starts the next literal. */
function templateFromPattern(src: string): Template | null {
  const parts: string[] = []; let cur = '';
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '[' && src[i + 1] === '^' && src[i + 3] === ']' && src[i + 4] === '*') {
      const stop = src[i + 2]; const rest = src.slice(i + 5);
      if (!rest.startsWith(stop) && rest !== '') return null;
      parts.push(cur); cur = ''; i += 4;
    } else if (src[i] === '\\' && i + 1 < src.length && REGEX_SYNTAX.has(src[i + 1])) { cur += src[++i]; }
    else if (REGEX_SYNTAX.has(src[i])) return null;
    else cur += src[i];
  }
  parts.push(cur);
  const open = parts.length > 1 && parts[parts.length - 1] === '';
  if (open) parts.pop();
  return parts[0] && !parts.slice(1).some((p) => !p) ? { parts, open } : null;
}

function blankTemplate(text: string, { parts, open }: Template): string {
  let out = ''; let from = 0;
  for (let at = text.indexOf(parts[0], from); at >= 0; at = text.indexOf(parts[0], from)) {
    let cur = at + parts[0].length; let ok = true;
    for (let k = 1; k < parts.length && ok; k++) {
      const stop = parts[k][0]; let end = cur;
      while (end < text.length && text[end] !== stop) end++;
      if (text.startsWith(parts[k], end)) cur = end + parts[k].length; else ok = false;
    }
    if (ok && open) { while (cur < text.length && text[cur] !== '\n') cur++; }
    if (!ok) { out += text.slice(from, at + 1); from = at + 1; continue; }
    out += text.slice(from, at) + '∅'; from = cur;
  }
  return out + text.slice(from);
}

const compiledTemplates = new WeakMap<CompareRules, { templates: Template[]; unsupported: string[] }>();
function templatesOf(r: CompareRules) {
  let c = compiledTemplates.get(r);
  if (!c) {
    c = { templates: [], unsupported: [] };
    for (const t of r.ignoreTemplates ?? []) { const p = parseTemplate(t); if (p) c.templates.push(p); else c.unsupported.push(t); }
    for (const t of r.ignorePatterns ?? []) { const p = templateFromPattern(t); if (p) c.templates.push(p); else c.unsupported.push(t); }
    compiledTemplates.set(r, c);
  }
  return c;
}

/** Where two responses differ under the rules ([] = equivalent). */
export function compareResponses(legacy: CapturedResponse, port: CapturedResponse, rules: CompareRules = {}): string[] {
  const where: string[] = [];
  if (legacy.status !== port.status) where.push(`status ${legacy.status}≠${port.status}`);
  if (rules.statusOnly) return where;
  for (const h of rules.headers ?? ['content-type', 'location']) {
    const a = h === 'content-type' ? mediaType(legacy.headers.get(h)) : legacy.headers.get(h) ?? '';
    const b = h === 'content-type' ? mediaType(port.headers.get(h)) : port.headers.get(h) ?? '';
    if (a !== b) where.push(`header ${h}`);
  }
  const type = mediaType(legacy.headers.get('content-type'));
  if (bytesEqual(legacy.body, port.body)) return where;
  if (/json/.test(type)) {
    let a: unknown; let b: unknown;
    try { a = JSON.parse(td.decode(legacy.body)); } catch { a = undefined; }
    try { b = JSON.parse(td.decode(port.body)); } catch { b = undefined; }
    if (a === undefined || b === undefined) { if (a !== b || !bytesEqual(legacy.body, port.body)) where.push(`body ${a === undefined ? 'legacy' : 'port'} is not JSON`); }
    else jsonDiff(a, b, [], ignoresOf(rules), rules.emptyArrayEqualsObject !== false, where);
  } else if (/^text\/|xml|javascript/.test(type) || type === '') {
    const html = rules.normalizeHtml ?? /html/.test(type);
    const { templates, unsupported } = templatesOf(rules);
    for (const u of unsupported) where.push(`ignore rule unsupported: ${u}`);
    if (normalText(td.decode(legacy.body), html, templates) !== normalText(td.decode(port.body), html, templates)) where.push('body text');
  } else if (!bytesEqual(legacy.body, port.body)) where.push('body bytes');
  return where;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface RouteShadowState {
  startedAt: number;
  lastAt: number;
  counts: Record<Outcome, number>;
  /** Up to 20 mismatch locations per route — never the bodies. */
  samples: Array<{ at: number; method: string; path: string; where: string[] }>;
  statuses: { legacy: Record<string, number>; port: Record<string, number> };
  /** Effects the port would have written (dry-run in shadow), by event type. */
  effects: Record<string, number>;
  legacyMs: Histogram;
  portMs: Histogram;
}

export interface CutoverPolicy { minRequests: number; minDays: number; maxMismatches: number; maxPortErrors: number }
export const DEFAULT_CUTOVER_POLICY: CutoverPolicy = { minRequests: 1000, minDays: 7, maxMismatches: 0, maxPortErrors: 0 };

export interface RouteReport {
  route: string;
  requests: number;
  days: number;
  counts: Record<Outcome, number>;
  matchPct: number;
  samples: RouteShadowState['samples'];
  statuses: RouteShadowState['statuses'];
  effects: Record<string, number>;
  latencyMs: { legacy: { p50: number; p95: number; p99: number; mean: number }; port: { p50: number; p95: number; p99: number; mean: number } };
  usdPerMillion: { legacy: number; port: number; assumption: CostAssumptions };
  cutover: { ready: boolean; because: string[]; notes: string[] };
  reportHash: string;
}

/** Merge evidence from several processes (reuse-port shadows): counts and histograms add, the window spans all. */
export function mergeRouteStates(states: RouteShadowState[]): RouteShadowState | undefined {
  if (!states.length) return undefined;
  const m = emptyState(Math.min(...states.map((s) => s.startedAt)));
  m.lastAt = Math.max(...states.map((s) => s.lastAt));
  const add = (into: Record<string, number>, from: Record<string, number>) => { for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v; };
  for (const s of states) {
    add(m.counts, s.counts); add(m.statuses.legacy, s.statuses.legacy); add(m.statuses.port, s.statuses.port); add(m.effects, s.effects);
    for (const x of s.samples) if (m.samples.length < 20) m.samples.push(x);
    for (const [h, from] of [[m.legacyMs, s.legacyMs], [m.portMs, s.portMs]] as const) { for (let i = 0; i < from.counts.length; i++) h.counts[i] += from.counts[i]; h.n += from.n; h.sumMs += from.sumMs; }
  }
  return m;
}

const emptyState = (t: number): RouteShadowState => ({ startedAt: t, lastAt: t, counts: { match: 0, mismatch: 0, 'port-error': 0, 'legacy-error': 0, skipped: 0 }, samples: [], statuses: { legacy: {}, port: {} }, effects: {}, legacyMs: newHist(), portMs: newHist() });

/** Per-route evidence for many routes; state is plain JSON (persist it as it is). */
export function createRouteShadow(o: { policy?: CutoverPolicy; state?: Record<string, RouteShadowState>; now?: () => number } = {}) {
  const now = o.now ?? Date.now;
  const policy = o.policy ?? DEFAULT_CUTOVER_POLICY;
  const routes: Record<string, RouteShadowState> = o.state ?? {};
  const of = (route: string) => (routes[route] ??= emptyState(now()));

  function record(route: string, r: { outcome: Outcome; method: string; path: string; where?: string[]; legacyStatus?: number; portStatus?: number; legacyMs?: number; portMs?: number; effects?: string[] }): void {
    const s = of(route);
    s.lastAt = now();
    s.counts[r.outcome]++;
    if (r.legacyStatus !== undefined) s.statuses.legacy[r.legacyStatus] = (s.statuses.legacy[r.legacyStatus] ?? 0) + 1;
    if (r.portStatus !== undefined) s.statuses.port[r.portStatus] = (s.statuses.port[r.portStatus] ?? 0) + 1;
    if (r.legacyMs !== undefined) addHist(s.legacyMs, r.legacyMs);
    if (r.portMs !== undefined) addHist(s.portMs, r.portMs);
    for (const e of r.effects ?? []) s.effects[e] = (s.effects[e] ?? 0) + 1;
    if ((r.outcome === 'mismatch' || r.outcome === 'port-error') && s.samples.length < 20) s.samples.push({ at: s.lastAt, method: r.method, path: r.path, where: r.where ?? [] });
  }

  /** `others`: the same route's evidence from sibling processes, merged into this report. */
  async function report(route: string, cost: CostAssumptions, others: RouteShadowState[] = []): Promise<RouteReport> {
    const s = others.length ? mergeRouteStates([of(route), ...others])! : of(route);
    const requests = s.counts.match + s.counts.mismatch + s.counts['port-error'];
    const days = (s.lastAt - s.startedAt) / 86400_000;
    const q = (h: Histogram) => ({ p50: quantile(h, 0.5), p95: quantile(h, 0.95), p99: quantile(h, 0.99), mean: h.n ? h.sumMs / h.n : 0 });
    const perMillion = (h: Histogram) => (h.n ? ((h.sumMs / h.n) * 1e6) / 1000 / 3600 / Math.max(1, cost.vcpus) * cost.instanceUsdPerHour : 0);
    const because: string[] = []; const notes: string[] = [];
    if (requests < policy.minRequests) because.push(`${requests} of ${policy.minRequests} compared requests`);
    if (days < policy.minDays) because.push(`${days.toFixed(2)} of ${policy.minDays} days observed`);
    if (s.counts.mismatch > policy.maxMismatches) because.push(`${s.counts.mismatch} responses differ — fix the port or add a rule for a harmless difference (see samples)`);
    if (s.counts['port-error'] > policy.maxPortErrors) because.push(`${s.counts['port-error']} port errors`);
    if (!Object.keys(s.statuses.legacy).some((c) => !c.startsWith('2'))) notes.push('no non-2xx legacy response seen: error paths are unproven — include bad requests');
    if (s.counts.skipped) notes.push(`${s.counts.skipped} requests not compared (sampling or shadow capacity)`);
    if (s.counts['legacy-error']) notes.push(`${s.counts['legacy-error']} legacy failures (5xx / unreachable), not counted against the port`);
    const body = {
      route, requests, days, counts: { ...s.counts }, matchPct: requests ? (100 * s.counts.match) / requests : 0, samples: [...s.samples], statuses: { legacy: { ...s.statuses.legacy }, port: { ...s.statuses.port } }, effects: { ...s.effects },
      latencyMs: { legacy: q(s.legacyMs), port: q(s.portMs) }, usdPerMillion: { legacy: perMillion(s.legacyMs), port: perMillion(s.portMs), assumption: cost },
      cutover: { ready: because.length === 0, because: because.length ? because : ['every gate passed: the route can be served by the port (edge.route.cutover)'], notes },
    };
    return { ...body, reportHash: await sha256HexOf(canonicalJson(body)) };
  }

  /** Forget a route's evidence (after a rollback and a fix, the comparison starts again). */
  const reset = (route: string) => { routes[route] = emptyState(now()); };
  /** When this route's evidence started (a rollback after that point means it must start again). */
  const startedAt = (route: string) => routes[route]?.startedAt;

  return { record, report, reset, startedAt, routes: () => Object.keys(routes), state: () => routes };
}
