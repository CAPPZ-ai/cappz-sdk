/**
 * COPE node crystallized.
 * Node ID: v15-11-00-shadow-compare
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Retire a legacy verifier (a PHP route's own signature check) on evidence,
 * not on faith. The edge gateway runs in front of the route in shadow mode:
 * the legacy verdict stays authoritative — every request still reaches the
 * route — and the gateway records, per request, its own verdict, the legacy
 * one (X-Legacy-Verdict), and both latencies (its own timing; the route's
 * Server-Timing `verify;dur=`).
 *
 * Disagreements are never averaged away. Each is classified:
 *   cappz-stricter  CAPPZ denies, legacy allows (e.g. a key the wallet revoked,
 *                   which a key list on the PHP box cannot know)
 *   cappz-looser    CAPPZ allows, legacy denies — blocks retirement until explained
 *   legacy-missing  the route gave no verdict header
 * Retirement is ready only when enough traffic has been seen over enough days,
 * there are no looser verdicts, every stricter verdict has an accepted reason,
 * and denials were actually observed (a sample of only good traffic proves
 * little). The report is hashed so the retirement record (edge.legacy.retire →
 * LegacyVerifierRetired) cites exactly the evidence it was decided on.
 *
 * Latency is kept in log-scale histograms (mergeable, persistable), so a
 * week-long run costs a few kilobytes.
 */

import type { EdgeVerdict } from './edgeVerify.ts';
import { canonicalJson, sha256HexOf } from './canonical.ts';

export type LegacyVerdict = 'allow' | 'deny' | 'missing';
export type Agreement = 'agree' | 'cappz-stricter' | 'cappz-looser' | 'legacy-missing';

const BUCKETS = 64; // log2-ish buckets over microseconds: bucket i holds [2^(i/4), 2^((i+1)/4)) µs
const bucketOf = (ms: number) => Math.max(0, Math.min(BUCKETS * 4 - 1, Math.floor(4 * Math.log2(Math.max(1, ms * 1000)))));
const bucketMs = (b: number) => 2 ** ((b + 0.5) / 4) / 1000;

export interface Histogram { counts: number[]; n: number; sumMs: number }
export const newHist = (): Histogram => ({ counts: new Array(BUCKETS * 4).fill(0), n: 0, sumMs: 0 });
export function addHist(h: Histogram, ms: number) { h.counts[bucketOf(ms)]++; h.n++; h.sumMs += ms; }
export function quantile(h: Histogram, q: number): number {
  if (!h.n) return 0;
  let seen = 0; const target = q * h.n;
  for (let b = 0; b < h.counts.length; b++) { seen += h.counts[b]; if (seen >= target) return bucketMs(b); }
  return bucketMs(h.counts.length - 1);
}

export interface ShadowState {
  startedAt: number;
  lastAt: number;
  counts: Record<Agreement, number>;
  /** cappz verdict trust/signature reason → count, for stricter verdicts. */
  stricterReasons: Record<string, number>;
  looserSamples: Array<{ at: number; cappz: string; path: string }>;
  denials: { cappz: number; legacy: number };
  cappzMs: Histogram;
  legacyMs: Histogram;
}

export interface RetirePolicy {
  minRequests: number;
  minDays: number;
  /** Reasons a stricter CAPPZ verdict is accepted for (CAPPZ knows something the legacy check cannot). */
  acceptedStricterReasons: readonly string[];
  /** Both sides must have denied at least this many requests in the window. */
  minDenials: number;
}

export const DEFAULT_RETIRE_POLICY: RetirePolicy = { minRequests: 10_000, minDays: 7, acceptedStricterReasons: ['revoked', 'replayed', 'stale', 'expired'], minDenials: 10 };

export interface CostAssumptions { instanceUsdPerHour: number; vcpus: number; label: string }

export interface ShadowReport {
  requests: number;
  days: number;
  counts: Record<Agreement, number>;
  agreementPct: number;
  stricterReasons: Record<string, number>;
  looserSamples: ShadowState['looserSamples'];
  denials: ShadowState['denials'];
  latencyMs: { cappz: { p50: number; p95: number; p99: number; mean: number }; legacy: { p50: number; p95: number; p99: number; mean: number } };
  usdPerMillion: { cappz: number; legacy: number; assumption: CostAssumptions };
  retire: { ready: boolean; because: string[] };
  reportHash: string;
}

/** The reason a CAPPZ denial carries: the signature state if that failed, else the key trust. */
export function denialReason(v: Pick<EdgeVerdict, 'signature' | 'trust' | 'content'>): string {
  if (v.signature !== 'verified' && v.signature !== 'mtls') return v.signature;
  if (v.content === 'digest-mismatch') return 'digest-mismatch';
  return v.trust;
}

export function createShadowComparison(o: { policy?: RetirePolicy; state?: ShadowState; now?: () => number } = {}) {
  const now = o.now ?? Date.now;
  const policy = o.policy ?? DEFAULT_RETIRE_POLICY;
  const s: ShadowState = o.state ?? { startedAt: now(), lastAt: now(), counts: { agree: 0, 'cappz-stricter': 0, 'cappz-looser': 0, 'legacy-missing': 0 }, stricterReasons: {}, looserSamples: [], denials: { cappz: 0, legacy: 0 }, cappzMs: newHist(), legacyMs: newHist() };

  function record(r: { cappz: Pick<EdgeVerdict, 'allowed' | 'signature' | 'trust' | 'content'>; cappzMs: number; legacy: LegacyVerdict; legacyMs?: number; path: string }): Agreement {
    s.lastAt = now();
    addHist(s.cappzMs, r.cappzMs);
    if (r.legacyMs !== undefined && Number.isFinite(r.legacyMs)) addHist(s.legacyMs, r.legacyMs);
    if (!r.cappz.allowed) s.denials.cappz++;
    if (r.legacy === 'deny') s.denials.legacy++;
    let a: Agreement;
    if (r.legacy === 'missing') a = 'legacy-missing';
    else if (r.cappz.allowed === (r.legacy === 'allow')) a = 'agree';
    else if (!r.cappz.allowed) { a = 'cappz-stricter'; const why = denialReason(r.cappz); s.stricterReasons[why] = (s.stricterReasons[why] ?? 0) + 1; }
    else { a = 'cappz-looser'; if (s.looserSamples.length < 50) s.looserSamples.push({ at: s.lastAt, cappz: `${r.cappz.signature} ${r.cappz.trust}`, path: r.path }); }
    s.counts[a]++;
    return a;
  }

  async function report(cost: CostAssumptions): Promise<ShadowReport> {
    const requests = Object.values(s.counts).reduce((x, y) => x + y, 0);
    const days = (s.lastAt - s.startedAt) / 86400_000;
    const q = (h: Histogram) => ({ p50: quantile(h, 0.5), p95: quantile(h, 0.95), p99: quantile(h, 0.99), mean: h.n ? h.sumMs / h.n : 0 });
    const perMillion = (h: Histogram) => (h.n ? ((h.sumMs / h.n) * 1e6) / 1000 / 3600 / Math.max(1, cost.vcpus) * cost.instanceUsdPerHour : 0);
    const because: string[] = [];
    if (requests < policy.minRequests) because.push(`${requests} of ${policy.minRequests} requests seen`);
    if (days < policy.minDays) because.push(`${days.toFixed(2)} of ${policy.minDays} days observed`);
    if (s.counts['cappz-looser']) because.push(`${s.counts['cappz-looser']} requests CAPPZ would allow that the legacy check denied — explain each before retiring`);
    if (s.counts['legacy-missing']) because.push(`${s.counts['legacy-missing']} responses without X-Legacy-Verdict`);
    const unaccepted = Object.entries(s.stricterReasons).filter(([r]) => !policy.acceptedStricterReasons.includes(r));
    if (unaccepted.length) because.push(`stricter CAPPZ verdicts without an accepted reason: ${unaccepted.map(([r, c]) => `${r} ×${c}`).join(', ')}`);
    if (s.denials.cappz < policy.minDenials || s.denials.legacy < policy.minDenials) because.push(`too few denials observed (CAPPZ ${s.denials.cappz}, legacy ${s.denials.legacy}; need ${policy.minDenials} each) — include bad traffic`);
    const body = {
      requests, days, counts: { ...s.counts }, agreementPct: requests ? (100 * s.counts.agree) / requests : 0, stricterReasons: { ...s.stricterReasons }, looserSamples: [...s.looserSamples], denials: { ...s.denials },
      latencyMs: { cappz: q(s.cappzMs), legacy: q(s.legacyMs) }, usdPerMillion: { cappz: perMillion(s.cappzMs), legacy: perMillion(s.legacyMs), assumption: cost },
      retire: { ready: because.length === 0, because: because.length ? because : ['every gate passed: the legacy verifier can be retired (edge.legacy.retire)'] },
    };
    return { ...body, reportHash: await sha256HexOf(canonicalJson(body)) };
  }

  return { record, report, state: () => s };
}

/** Read the legacy route's verdict and its own verify time from its response headers. */
export function readLegacyVerdict(res: Response, header = 'x-legacy-verdict'): { verdict: LegacyVerdict; ms?: number } {
  const v = res.headers.get(header)?.trim().toLowerCase();
  const verdict: LegacyVerdict = v === 'allow' || v === 'ok' || v === 'pass' ? 'allow' : v === 'deny' || v === 'fail' || v === 'reject' ? 'deny' : 'missing';
  const m = /(?:^|,)\s*verify;(?:[^,]*;)?\s*dur=([\d.]+)/.exec(res.headers.get('server-timing') ?? '');
  return { verdict, ms: m ? Number(m[1]) : undefined };
}
