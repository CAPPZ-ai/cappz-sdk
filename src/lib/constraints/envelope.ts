/**
 * COPE node crystallized.
 * Node ID: v15-40-00-constraint-envelope
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * A constraint envelope is the owner's signed statement of what a physical
 * system may do: the limits on each measured value and setpoint, how fast they
 * may change, which redundant sources must agree, what a command must cause,
 * and who may change what, when. One model serves a supermarket freezer, a
 * chlorine dosing pump, a substation breaker and a vehicle's air data — the
 * use cases are envelopes, not code paths.
 *
 * Governance carried with the data:
 *   - Each version is signed by a trusted operator key and names the version it
 *     supersedes (by hash): history is amended, never overwritten.
 *   - A version that tightens (or only adds) constraints is active as soon as
 *     one trusted operator signs it: making the system safer is never delayed.
 *   - A version that loosens anything (wider range, faster rate, a new key, a
 *     longer window, a removed constraint, a weaker fail mode, a shorter cooling
 *     period, a revocation) needs endorsements from `minRelaxSigners` distinct
 *     trusted keys and then waits its cooling period. Every loosening is listed
 *     by reason, so an endorser sees exactly what they approve.
 *   - Tightening only affects what the guard refuses and what reconciliation
 *     reports; it never causes equipment to act.
 *
 * The constraint kinds are registry entries (MDM accounts at
 * cappz/config/constraint-kinds/<id>); adding one adds data and an evaluator,
 * not a new verb. Addresses never name a vendor.
 */

import { canonicalJson, sha256HexOf } from '../identity/canonical.ts';
import { signCanonical, verifyCanonical, type SigningKey } from '../sync/helloSignature.ts';
import { convert, convertDelta, unitDef } from './units.ts';

export type ConstraintKindId = 'range' | 'rate' | 'dwell' | 'agreement' | 'response' | 'authority' | 'schedule';

export interface ConstraintKindAccount { id: ConstraintKindId; address: string; title: string; checks: string; example: string }

/** The registry of constraint kinds (MDM accounts). */
export const CONSTRAINT_KINDS: readonly ConstraintKindAccount[] = Object.freeze(([
  ['range', 'Range', 'a value or setpoint stays within limits, unit-checked', 'freezer air −25…−18 Cel; chlorine dose ≤ 4 mg/L'],
  ['rate', 'Rate of change', 'how fast a value may move, and the largest single setpoint step', 'a setpoint may not jump 40 Cel at once'],
  ['dwell', 'Dwell', 'how long a value may stay outside its band', '15 min above −18 Cel raises an alarm'],
  ['agreement', 'Agreement', 'redundant sources agree within a tolerance; the outlier is named when a majority agrees', 'three airspeed sources; GNSS vs inertial position; two thermometers'],
  ['response', 'Response', 'a command produces the expected physical effect in time', 'setpoint lowered → air temperature falls within 20 min'],
  ['authority', 'Authority', 'which keys may command which points, and when', 'only the refrigeration contractor’s key, 07:00–19:00'],
  ['schedule', 'Schedule', 'when points may be written at all', 'no breaker operations outside switching windows'],
] as const).map(([id, title, checks, example]) => ({ id, address: `cappz/config/constraint-kinds/${id}`, title, checks, example })));

export type PointKind = 'measurement' | 'setpoint' | 'command' | 'state';
export type FailMode = 'hold-last-good' | 'pass-and-alarm';

export interface ConstraintPoint {
  /** Stable id (an HD child label or the owner's tag); never parsed for meaning. */
  id: string;
  kind: PointKind;
  /** UCUM code (units.ts). */
  unit: string;
  label?: string;
  /** Longest expected gap between samples; a longer silence is `stale`. */
  maxGapMs?: number;
  /** What the guard does when it cannot decide (its evidence is unreadable): refuse (the controller keeps its last good value) or forward and alarm. */
  failMode?: FailMode;
}

export interface TimeWindow { days: number[]; from: string; to: string; utcOffsetMin?: number }

interface Base { id: string; points: string[]; modes?: string[]; note?: string }
export interface RangeConstraint extends Base { kind: 'range'; min?: number; max?: number; unit: string }
export interface RateConstraint extends Base { kind: 'rate'; unit: string; maxDelta?: number; perMs?: number; maxStep?: number }
export interface DwellConstraint extends Base { kind: 'dwell'; unit: string; min?: number; max?: number; maxMs: number }
export interface AgreementConstraint extends Base { kind: 'agreement'; unit: string; tolerance: number; maxSkewMs?: number; persistMs?: number }
export interface ResponseConstraint extends Base { kind: 'response'; /** points[0] is the setpoint or command; points[1] the observed value. */ unit: string; withinMs: number; deadband: number; minChange?: number }
export interface AuthorityGrant { publicKey: string; wallet?: string; points: string[]; windows?: TimeWindow[]; label?: string }
export interface AuthorityConstraint extends Base { kind: 'authority'; grants: AuthorityGrant[] }
export interface ScheduleConstraint extends Base { kind: 'schedule'; windows: TimeWindow[] }
export type Constraint = RangeConstraint | RateConstraint | DwellConstraint | AgreementConstraint | ResponseConstraint | AuthorityConstraint | ScheduleConstraint;

export interface EnvelopeBody {
  v: 1;
  kind: 'cappz.constraints.envelope';
  /** One envelope line per asset (or asset group); versions of it supersede each other. */
  envelopeId: string;
  /** The asset's address (HD position or the owner's id). */
  asset: string;
  version: number;
  supersedes: string | null;
  points: ConstraintPoint[];
  constraints: Constraint[];
  /** A state point whose value is the operating mode (defrost, maintenance, taxi, cruise …). */
  modePoint?: string;
  /** How long a loosening waits after its last required endorsement (default 72 h). */
  coolingMs: number;
  /** Advisory envelopes (e.g. on a vehicle) never feed an inline guard. */
  advisory?: boolean;
  declaredAt: string;
  signerKey: string;
}
export interface SignedEnvelope extends EnvelopeBody { envelopeHash: string; signature: string }

export interface EnvelopeEndorsement { v: 1; kind: 'cappz.constraints.endorsement'; envelopeHash: string; at: string; signerKey: string; signature: string }
export interface EnvelopeRevocation { v: 1; kind: 'cappz.constraints.revocation'; envelopeId: string; envelopeHash: string; reason: string; at: string; signerKey: string; signature: string }
export type EnvelopeRecord = SignedEnvelope | EnvelopeEndorsement | EnvelopeRevocation;

export const DEFAULT_COOLING_MS = 72 * 3600_000;

const without = <T extends object, K extends keyof T>(o: T, ...k: K[]): Omit<T, K> => { const c = { ...o }; for (const x of k) delete c[x]; return c; };

/** Structural problems that make an envelope unusable (unknown units, dangling point ids, empty grants). */
export function lintEnvelope(e: Pick<EnvelopeBody, 'points' | 'constraints' | 'modePoint'>): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const p of e.points) {
    if (!p.id) out.push('a point has no id');
    if (ids.has(p.id)) out.push(`point ${p.id}: declared twice`);
    ids.add(p.id);
    if (!unitDef(p.unit)) out.push(`point ${p.id}: unknown unit ${p.unit}`);
  }
  if (e.modePoint && !ids.has(e.modePoint)) out.push(`modePoint ${e.modePoint}: not a declared point`);
  const cids = new Set<string>();
  for (const c of e.constraints) {
    if (cids.has(c.id)) out.push(`constraint ${c.id}: declared twice`);
    cids.add(c.id);
    if (c.kind !== 'authority' && c.kind !== 'schedule' && !unitDef(c.unit)) out.push(`constraint ${c.id}: unknown unit ${c.unit}`);
    for (const p of c.points) if (!ids.has(p)) out.push(`constraint ${c.id}: point ${p} is not declared`);
    if (c.kind !== 'authority' && c.kind !== 'schedule' && 'unit' in c) {
      for (const p of c.points) { const pt = e.points.find((x) => x.id === p); if (pt && convert(0, pt.unit, c.unit) === null && pt.unit !== c.unit) out.push(`constraint ${c.id}: point ${p} is in ${pt.unit}, which does not convert to ${c.unit}`); }
    }
    if (c.kind === 'range' && c.min === undefined && c.max === undefined) out.push(`constraint ${c.id}: a range needs min or max`);
    if (c.kind === 'range' && c.min !== undefined && c.max !== undefined && c.min > c.max) out.push(`constraint ${c.id}: min is above max`);
    if (c.kind === 'dwell' && c.min === undefined && c.max === undefined) out.push(`constraint ${c.id}: a dwell needs min or max`);
    if (c.kind === 'rate' && c.maxStep === undefined && (c.maxDelta === undefined || !c.perMs)) out.push(`constraint ${c.id}: a rate needs maxStep, or maxDelta with perMs`);
    if (c.kind === 'agreement' && c.points.length < 2) out.push(`constraint ${c.id}: agreement needs at least two sources`);
    if (c.kind === 'response' && c.points.length !== 2) out.push(`constraint ${c.id}: response names exactly [command point, observed point]`);
    if (c.kind === 'authority' && !c.grants.length) out.push(`constraint ${c.id}: authority with no grants refuses everything — say so with an empty points list instead`);
    if (c.kind === 'authority') for (const g of c.grants) if (!/^[0-9a-fA-F]{64}$/.test(g.publicKey)) out.push(`constraint ${c.id}: grant ${g.label ?? ''} key is not a 64-hex Ed25519 public key (${String(g.publicKey).slice(0, 24)}…) — replace the placeholder with the key constraint-wizard keygen printed`);
    if (c.kind === 'authority') for (const g of c.grants) for (const p of g.points) if (p !== '*' && !ids.has(p)) out.push(`constraint ${c.id}: grant ${g.label ?? g.publicKey.slice(0, 12)} names undeclared point ${p}`);
    for (const w of (c.kind === 'schedule' ? c.windows : c.kind === 'authority' ? c.grants.flatMap((g) => g.windows ?? []) : [])) {
      if (!/^\d\d:\d\d$/.test(w.from) || !/^\d\d:\d\d$/.test(w.to)) out.push(`constraint ${c.id}: window times are HH:MM`);
      if (w.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) out.push(`constraint ${c.id}: window days are 0 (Sunday) … 6`);
    }
  }
  return out;
}

const envelopeText = (b: EnvelopeBody) => canonicalJson(b);

export async function declareEnvelope(b: Omit<EnvelopeBody, 'v' | 'kind' | 'signerKey' | 'declaredAt' | 'coolingMs'> & { declaredAt?: string; coolingMs?: number }, key: SigningKey): Promise<SignedEnvelope> {
  const problems = lintEnvelope(b);
  if (problems.length) throw new Error(`envelope not declared: ${problems.join('; ')}`);
  // Only the declared fields: a stray envelopeHash, signature or signerKey from a copied envelope never enters the signed body.
  const body: EnvelopeBody = {
    v: 1, kind: 'cappz.constraints.envelope', envelopeId: b.envelopeId, asset: b.asset, version: b.version, supersedes: b.supersedes,
    points: b.points, constraints: b.constraints, ...(b.modePoint !== undefined ? { modePoint: b.modePoint } : {}), ...(b.advisory !== undefined ? { advisory: b.advisory } : {}),
    coolingMs: b.coolingMs ?? DEFAULT_COOLING_MS, declaredAt: b.declaredAt ?? new Date().toISOString(), signerKey: key.publicKeyHex,
  };
  if (!Number.isInteger(body.version) || body.version < 1) throw new Error('envelope not declared: version must be a positive integer');
  if (!(body.coolingMs >= 0)) throw new Error('envelope not declared: coolingMs must be ≥ 0');
  const envelopeHash = await sha256HexOf(envelopeText(body));
  return { ...body, envelopeHash, signature: await signCanonical(envelopeHash, key) };
}

export async function endorseEnvelope(e: Pick<SignedEnvelope, 'envelopeHash'>, key: SigningKey, at = new Date().toISOString()): Promise<EnvelopeEndorsement> {
  const unsigned = { v: 1 as const, kind: 'cappz.constraints.endorsement' as const, envelopeHash: e.envelopeHash, at, signerKey: key.publicKeyHex };
  return { ...unsigned, signature: await signCanonical(canonicalJson(unsigned), key) };
}

export async function revokeEnvelope(e: Pick<SignedEnvelope, 'envelopeId' | 'envelopeHash'>, reason: string, key: SigningKey, at = new Date().toISOString()): Promise<EnvelopeRevocation> {
  if (!reason.trim()) throw new Error('a revocation needs a reason');
  const unsigned = { v: 1 as const, kind: 'cappz.constraints.revocation' as const, envelopeId: e.envelopeId, envelopeHash: e.envelopeHash, reason, at, signerKey: key.publicKeyHex };
  return { ...unsigned, signature: await signCanonical(canonicalJson(unsigned), key) };
}

export async function verifyEnvelope(e: SignedEnvelope): Promise<'valid' | 'changed' | 'bad-signature' | 'malformed'> {
  if (e?.kind !== 'cappz.constraints.envelope' || e.v !== 1) return 'malformed';
  const body = without(e, 'envelopeHash', 'signature') as EnvelopeBody;
  if ((await sha256HexOf(envelopeText(body))) !== e.envelopeHash) return 'changed';
  if (lintEnvelope(body).length) return 'malformed';
  return (await verifyCanonical(e.envelopeHash, e.signature, e.signerKey).catch(() => false)) ? 'valid' : 'bad-signature';
}

async function verifySmall(r: EnvelopeEndorsement | EnvelopeRevocation): Promise<boolean> {
  return verifyCanonical(canonicalJson(without(r, 'signature')), r.signature, r.signerKey).catch(() => false);
}

// ─── What loosens ─────────────────────────────────────────────────

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
/** Minute-of-week intervals [start, end) a window covers, in UTC. */
function windowIntervals(w: TimeWindow): Array<[number, number]> {
  const off = w.utcOffsetMin ?? 0; const out: Array<[number, number]> = [];
  const f = minutes(w.from); let t = minutes(w.to); if (t <= f) t += 1440;
  for (const d of w.days) {
    const s = ((d * 1440 + f - off) % 10080 + 10080) % 10080; const e = s + (t - f);
    if (e <= 10080) out.push([s, e]); else { out.push([s, 10080]); out.push([0, e - 10080]); }
  }
  return out;
}
/** Does `inner` fall entirely within `outer` (both lists of windows)? */
function windowsWithin(inner: readonly TimeWindow[] | undefined, outer: readonly TimeWindow[] | undefined): boolean {
  if (!outer) return true; // outer unrestricted
  if (!inner) return false; // inner unrestricted, outer restricted
  const o = outer.flatMap(windowIntervals);
  return inner.flatMap(windowIntervals).every(([s, e]) => {
    // covered if the union of outer intervals covers [s, e)
    let at = s;
    for (const [os, oe] of [...o].sort((a, b) => a[0] - b[0])) { if (os <= at && oe > at) at = oe; if (at >= e) return true; }
    return at >= e;
  });
}

const pointsWithin = (inner: readonly string[], outer: readonly string[]) => outer.includes('*') || (!inner.includes('*') && inner.every((p) => outer.includes(p)));
const modesWithin = (inner?: readonly string[], outer?: readonly string[]) => {
  // a constraint that applies in fewer modes is looser
  if (!inner) return true; // applies always: at least as strict
  if (!outer) return false;
  return outer.every((m) => inner.includes(m));
};

/** Every way `next` is looser than `prev` (empty: tighter or equal). */
export function looserThan(prev: EnvelopeBody, next: EnvelopeBody): string[] {
  const out: string[] = [];
  if (next.coolingMs < prev.coolingMs) out.push(`cooling period shortened from ${prev.coolingMs} ms to ${next.coolingMs} ms`);
  if (prev.advisory === false && next.advisory) out.push('changed from guard-enforceable to advisory');
  for (const p of prev.points) {
    const n = next.points.find((x) => x.id === p.id);
    if (!n) continue; // a removed point only matters through its constraints (checked below)
    if ((p.failMode ?? 'hold-last-good') === 'hold-last-good' && n.failMode === 'pass-and-alarm') out.push(`point ${p.id}: fail mode weakened to pass-and-alarm`);
    if (p.maxGapMs !== undefined && (n.maxGapMs === undefined || n.maxGapMs > p.maxGapMs)) out.push(`point ${p.id}: allowed silence lengthened`);
  }
  for (const c of prev.constraints) {
    const n = next.constraints.find((x) => x.id === c.id);
    if (!n) { out.push(`constraint ${c.id} (${c.kind}) removed`); continue; }
    if (n.kind !== c.kind) { out.push(`constraint ${c.id}: kind changed from ${c.kind} to ${n.kind}`); continue; }
    if (!pointsWithin(c.points, n.points) && c.kind !== 'agreement' && c.kind !== 'response') {
      // covering fewer points is looser
      if (!c.points.every((p) => n.points.includes(p))) out.push(`constraint ${c.id}: no longer covers ${c.points.filter((p) => !n.points.includes(p)).join(', ')}`);
    }
    if (!modesWithin(n.modes, c.modes)) out.push(`constraint ${c.id}: applies in fewer modes`);
    const d = (v: number | undefined, from: string, to: string) => (v === undefined ? undefined : convertDelta(v, from, to) ?? NaN);
    const a = (v: number | undefined, from: string, to: string) => (v === undefined ? undefined : convert(v, from, to) ?? NaN);
    switch (c.kind) {
      case 'range': case 'dwell': {
        const nn = n as RangeConstraint | DwellConstraint;
        const nmin = a(nn.min, nn.unit, c.unit); const nmax = a(nn.max, nn.unit, c.unit);
        if (c.min !== undefined && (nmin === undefined || !(nmin >= c.min - 1e-9))) out.push(`constraint ${c.id}: lower limit relaxed (${c.min} → ${nn.min ?? 'none'} ${nn.unit})`);
        if (c.max !== undefined && (nmax === undefined || !(nmax <= c.max + 1e-9))) out.push(`constraint ${c.id}: upper limit relaxed (${c.max} → ${nn.max ?? 'none'} ${nn.unit})`);
        if (c.kind === 'dwell' && (n as DwellConstraint).maxMs > c.maxMs) out.push(`constraint ${c.id}: allowed time outside the band lengthened`);
        break;
      }
      case 'rate': {
        const nn = n as RateConstraint;
        const step = d(nn.maxStep, nn.unit, c.unit);
        if (c.maxStep !== undefined && (step === undefined || !(step <= c.maxStep + 1e-9))) out.push(`constraint ${c.id}: largest setpoint step increased`);
        if (c.maxDelta !== undefined && c.perMs) {
          const per = nn.maxDelta !== undefined && nn.perMs ? (d(nn.maxDelta, nn.unit, c.unit)! / nn.perMs) : undefined;
          if (per === undefined || !(per <= c.maxDelta / c.perMs + 1e-12)) out.push(`constraint ${c.id}: allowed rate of change increased`);
        }
        break;
      }
      case 'agreement': {
        const nn = n as AgreementConstraint;
        if (!c.points.every((p) => nn.points.includes(p))) out.push(`constraint ${c.id}: a source was removed from the comparison`);
        const tol = d(nn.tolerance, nn.unit, c.unit);
        if (!(tol! <= c.tolerance + 1e-9)) out.push(`constraint ${c.id}: tolerance widened`);
        if ((nn.persistMs ?? 0) > (c.persistMs ?? 0)) out.push(`constraint ${c.id}: disagreement must persist longer before it counts`);
        if ((nn.maxSkewMs ?? 0) < (c.maxSkewMs ?? 0)) out.push(`constraint ${c.id}: comparison window narrowed (fewer samples compared)`);
        break;
      }
      case 'response': {
        const nn = n as ResponseConstraint;
        if (nn.points[0] !== c.points[0] || nn.points[1] !== c.points[1]) out.push(`constraint ${c.id}: compares different points`);
        if (nn.withinMs > c.withinMs) out.push(`constraint ${c.id}: allowed response time lengthened`);
        if (!(d(nn.deadband, nn.unit, c.unit)! <= c.deadband + 1e-9)) out.push(`constraint ${c.id}: deadband widened`);
        break;
      }
      case 'authority': {
        const nn = n as AuthorityConstraint;
        for (const g of nn.grants) {
          const old = c.grants.find((x) => x.publicKey.toLowerCase() === g.publicKey.toLowerCase());
          if (!old) { out.push(`constraint ${c.id}: new key ${g.label ? `${g.label} ` : ''}${g.publicKey.slice(0, 16)}… granted`); continue; }
          if (!pointsWithin(g.points, old.points)) out.push(`constraint ${c.id}: key ${g.publicKey.slice(0, 16)}… may command more points`);
          if (!windowsWithin(g.windows, old.windows)) out.push(`constraint ${c.id}: key ${g.publicKey.slice(0, 16)}… may command at more times`);
          if (old.wallet && g.wallet !== old.wallet) out.push(`constraint ${c.id}: key ${g.publicKey.slice(0, 16)}… no longer checked against its wallet's declarations`);
        }
        break;
      }
      case 'schedule': {
        if (!windowsWithin((n as ScheduleConstraint).windows, c.windows)) out.push(`constraint ${c.id}: writes allowed at more times`);
        break;
      }
    }
  }
  return out;
}

// ─── Lifecycle: declared → cooling → active → superseded / revoked ─

export type EnvelopeState = 'active' | 'cooling' | 'awaiting-endorsement' | 'superseded' | 'revoked' | 'revocation-cooling' | 'refused';

export interface EnvelopeLine {
  envelopeId: string;
  /** The version in force now (null: none yet, or revoked). */
  active: SignedEnvelope | null;
  /** A pending looser version or revocation, with what it waits for. */
  pending?: { envelopeHash: string; state: 'cooling' | 'awaiting-endorsement' | 'revocation-cooling'; loosens: string[]; endorsedBy: string[]; needs: number; activeFrom?: string };
  history: Array<{ envelopeHash: string; version?: number; state: EnvelopeState; at: string; because: string }>;
}

export interface ReplayOptions { trustedKeys: readonly string[]; now?: number; minRelaxSigners?: number }

/**
 * Replay envelope records (any order) from trusted operator keys: each line's
 * active version, any pending loosening and its full history. Records from
 * untrusted keys, with bad signatures or forking the line are refused with a
 * reason, never applied.
 */
export async function replayEnvelopes(records: readonly EnvelopeRecord[], o: ReplayOptions): Promise<{ lines: Record<string, EnvelopeLine>; refused: Array<{ record: string; because: string }> }> {
  const now = o.now ?? Date.now(); const need = Math.max(1, o.minRelaxSigners ?? 2);
  const trusted = new Set(o.trustedKeys.map((k) => k.toLowerCase()));
  const refused: Array<{ record: string; because: string }> = [];
  const envs: SignedEnvelope[] = []; const endorsements = new Map<string, Array<{ key: string; at: number }>>(); const revocations: EnvelopeRevocation[] = [];
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    if (!trusted.has(String(r.signerKey).toLowerCase())) { refused.push({ record: r.kind, because: `signer ${String(r.signerKey).slice(0, 16)}… is not a trusted operator` }); continue; }
    if (r.kind === 'cappz.constraints.envelope') {
      const v = await verifyEnvelope(r);
      if (v !== 'valid') { refused.push({ record: `${r.envelopeId}@${r.version}`, because: `envelope ${v}` }); continue; }
      envs.push(r);
      (endorsements.get(r.envelopeHash) ?? endorsements.set(r.envelopeHash, []).get(r.envelopeHash)!).push({ key: r.signerKey.toLowerCase(), at: Date.parse(r.declaredAt) });
    } else if (r.kind === 'cappz.constraints.endorsement' || r.kind === 'cappz.constraints.revocation') {
      if (!(await verifySmall(r))) { refused.push({ record: r.kind, because: 'bad signature' }); continue; }
      if (r.kind === 'cappz.constraints.endorsement') (endorsements.get(r.envelopeHash) ?? endorsements.set(r.envelopeHash, []).get(r.envelopeHash)!).push({ key: r.signerKey.toLowerCase(), at: Date.parse(r.at) });
      else revocations.push(r);
    }
  }
  const lines: Record<string, EnvelopeLine> = {};
  const ids = [...new Set(envs.map((e) => e.envelopeId))].sort();
  for (const id of ids) {
    const versions = envs.filter((e) => e.envelopeId === id).sort((a, b) => a.version - b.version || Date.parse(a.declaredAt) - Date.parse(b.declaredAt));
    const line: EnvelopeLine = { envelopeId: id, active: null, history: [] };
    // Signers per hash, distinct, with the time the n-th distinct signer arrived.
    const signedAt = (hash: string, n: number): { keys: string[]; at?: number } => {
      const seen = new Map<string, number>();
      for (const e of (endorsements.get(hash) ?? []).filter((x) => x.at <= now).sort((a, b) => a.at - b.at)) if (!seen.has(e.key)) seen.set(e.key, e.at);
      const keys = [...seen.keys()]; return { keys, at: keys.length >= n ? [...seen.values()][n - 1] : undefined };
    };
    let head: SignedEnvelope | null = null; // last accepted version (active or pending)
    for (const v of versions) {
      const at = v.declaredAt;
      if (Date.parse(at) > now) { line.history.push({ envelopeHash: v.envelopeHash, version: v.version, state: 'refused', at, because: 'declared in the future' }); continue; }
      if (head && v.supersedes !== head.envelopeHash) { line.history.push({ envelopeHash: v.envelopeHash, version: v.version, state: 'refused', at, because: `supersedes ${String(v.supersedes).slice(0, 12)}…, not the line's head ${head.envelopeHash.slice(0, 12)}… — a fork is refused` }); refused.push({ record: `${id}@${v.version}`, because: 'forks the envelope line' }); continue; }
      if (!head && v.supersedes !== null) { line.history.push({ envelopeHash: v.envelopeHash, version: v.version, state: 'refused', at, because: 'supersedes a version this replay does not hold' }); continue; }
      // Loosening is judged against the version in force, not a pending head: rewriting a pending loosening never skips its endorsements.
      const base = line.active ?? head;
      const loosens = base ? looserThan(base, v) : [];
      if (!loosens.length) {
        if (line.active) line.history.push({ envelopeHash: line.active.envelopeHash, version: line.active.version, state: 'superseded', at, because: `superseded by version ${v.version} (tighter or equal: active at once)` });
        line.active = v; head = v; line.pending = undefined;
        line.history.push({ envelopeHash: v.envelopeHash, version: v.version, state: 'active', at, because: versions[0] === v ? 'first version: nothing looser existed before it' : 'tighter or equal to the version in force' });
        continue;
      }
      const s = signedAt(v.envelopeHash, need);
      if (s.at === undefined) {
        line.pending = { envelopeHash: v.envelopeHash, state: 'awaiting-endorsement', loosens, endorsedBy: s.keys, needs: need };
        line.history.push({ envelopeHash: v.envelopeHash, version: v.version, state: 'awaiting-endorsement', at, because: `loosens (${loosens.length}): needs ${need} distinct operator signatures, has ${s.keys.length}` });
        head = v; // later versions must build on it (or a tighter rewrite of it)
        continue;
      }
      const from = s.at + Math.max(v.coolingMs, base!.coolingMs);
      if (from > now) {
        line.pending = { envelopeHash: v.envelopeHash, state: 'cooling', loosens, endorsedBy: s.keys, needs: need, activeFrom: new Date(from).toISOString() };
        line.history.push({ envelopeHash: v.envelopeHash, version: v.version, state: 'cooling', at: new Date(s.at).toISOString(), because: `endorsed by ${s.keys.length}; active from ${new Date(from).toISOString()}` });
        head = v; continue;
      }
      if (line.active) line.history.push({ envelopeHash: line.active.envelopeHash, version: line.active.version, state: 'superseded', at: new Date(from).toISOString(), because: `superseded by version ${v.version} after its cooling period` });
      line.active = v; head = v; line.pending = undefined;
      line.history.push({ envelopeHash: v.envelopeHash, version: v.version, state: 'active', at: new Date(from).toISOString(), because: `loosening endorsed by ${s.keys.length} and cooled` });
    }
    // A head that is pending replaces nothing until it activates; a tighter version built on a pending head activates at once (handled above, since looserThan compares with the head).
    // Revocation: removing all constraints is the loosest change — same rule.
    const rev = revocations.filter((r) => r.envelopeId === id && line.active && r.envelopeHash === line.active.envelopeHash && Date.parse(r.at) <= now).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    if (rev.length && line.active) {
      const seen = new Map<string, number>(); for (const r of rev) if (!seen.has(r.signerKey.toLowerCase())) seen.set(r.signerKey.toLowerCase(), Date.parse(r.at));
      const keys = [...seen.keys()];
      if (keys.length < need) { line.pending = { envelopeHash: line.active.envelopeHash, state: 'awaiting-endorsement', loosens: [`revocation: ${rev[0].reason}`], endorsedBy: keys, needs: need }; }
      else {
        const from = [...seen.values()][need - 1] + line.active.coolingMs;
        if (from > now) line.pending = { envelopeHash: line.active.envelopeHash, state: 'revocation-cooling', loosens: [`revocation: ${rev[0].reason}`], endorsedBy: keys, needs: need, activeFrom: new Date(from).toISOString() };
        else { line.history.push({ envelopeHash: line.active.envelopeHash, version: line.active.version, state: 'revoked', at: new Date(from).toISOString(), because: rev[0].reason }); line.active = null; line.pending = undefined; }
      }
    }
    lines[id] = line;
  }
  return { lines, refused };
}

/** Time-window membership (UTC ms). */
export function inWindows(at: number, windows: readonly TimeWindow[] | undefined): boolean {
  if (!windows) return true;
  const d = new Date(at); const mow = d.getUTCDay() * 1440 + d.getUTCHours() * 60 + d.getUTCMinutes();
  return windows.flatMap(windowIntervals).some(([s, e]) => mow >= s && mow < e);
}
