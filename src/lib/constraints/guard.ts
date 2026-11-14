/**
 * COPE node crystallized.
 * Node ID: v15-40-00-constraint-guard
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * The constraint guard: an independent check in front of a controller's write
 * path, whatever the protocol. Every adapter reduces a request to a
 * WriteDecode; the guard decides it with the same authorise() that
 * reconciliation applies after the fact, so prevention and detection never
 * disagree about what was allowed.
 *
 *   - Shadow first. In shadow the request is always forwarded and the verdict
 *     recorded; per-point enforcement starts only from an operator-signed
 *     mode record (signPointMode) that cites the shadow report hash, and a
 *     rollback record returns the point to shadow at once.
 *   - The enforce gate: enough writes over enough days, and the most recent
 *     writes all passing (operators have moved to signed commands), before a
 *     report says ready.
 *   - Fail modes, per point: when the guard cannot decide (no active envelope,
 *     evidence unreadable, an exception), `hold-last-good` refuses the write —
 *     the controller keeps its last good value — and `pass-and-alarm`
 *     forwards it and alarms. A refusal never makes equipment act; local and
 *     manual overrides never pass through the guard.
 *   - Writes are atomic: a request with one refused write is refused whole.
 *   - Protocols with no room for a signature (Modbus, BACnet, DNP3, 104) use
 *     armed commands: the operator posts the signed command to the guard
 *     first; one matching write within its validity consumes it.
 *   - Bounded state: armed commands, used nonces and per-point history have
 *     fixed caps and expire, so a flood cannot grow memory.
 */

import { canonicalJson, sha256HexOf } from '../identity/canonical.ts';
import type { KeyEvidence } from '../identity/keyDeclaration.ts';
import { signCanonical, verifyCanonical, type SigningKey } from '../sync/helloSignature.ts';
import { authorize, type Authorization, type PointValue, type SignedCommand } from './authority.ts';
import type { EnvelopeBody, FailMode } from './envelope.ts';
import type { Observation } from './reconcile.ts';
import type { WriteDecode } from './adapters/common.ts';

export type GuardMode = 'shadow' | 'enforce';

export interface PointModeRecord { v: 1; kind: 'cappz.constraints.point-mode'; envelopeId: string; point: string; mode: GuardMode; reason: string; reportHash: string | null; at: string; signerKey: string; signature: string }

export async function signPointMode(r: { envelopeId: string; point: string; mode: GuardMode; reason: string; reportHash?: string | null; at?: string }, key: SigningKey): Promise<PointModeRecord> {
  if (r.mode === 'enforce' && !r.reportHash) throw new Error('enforce needs the shadow report hash it was decided on');
  if (!r.reason.trim()) throw new Error('a mode change needs a reason');
  const unsigned = { v: 1 as const, kind: 'cappz.constraints.point-mode' as const, envelopeId: r.envelopeId, point: r.point, mode: r.mode, reason: r.reason, reportHash: r.reportHash ?? null, at: r.at ?? new Date().toISOString(), signerKey: key.publicKeyHex };
  return { ...unsigned, signature: await signCanonical(canonicalJson(unsigned), key) };
}

/** Replay signed mode records (point '*' sets the default for points without their own record). */
export async function replayPointModes(records: readonly PointModeRecord[], trustedKeys: readonly string[], envelopeId: string): Promise<{ modes: Record<string, PointModeRecord>; refused: number }> {
  const trusted = new Set(trustedKeys.map((k) => k.toLowerCase())); const modes: Record<string, PointModeRecord> = {}; let refused = 0;
  for (const r of [...records].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const { signature, ...unsigned } = r ?? ({} as PointModeRecord);
    if (r?.kind !== 'cappz.constraints.point-mode' || r.envelopeId !== envelopeId || !trusted.has(String(r.signerKey).toLowerCase()) || !(await verifyCanonical(canonicalJson(unsigned), signature, r.signerKey).catch(() => false))) { refused++; continue; }
    if (r.mode === 'enforce' && !r.reportHash) { refused++; continue; }
    modes[r.point] = r;
  }
  return { modes, refused };
}

/** Guard-level refusal reasons beyond the authorisation outcomes. */
export const GUARD_REFUSAL_REASONS = ['unmapped', 'privileged', 'malformed', 'evidence-unavailable', 'advisory-envelope'] as const;
export type RefusalReason = Authorization['state'] | typeof GUARD_REFUSAL_REASONS[number];

export interface GuardVerdict {
  at: string;
  /** Forward the request to the controller? */
  forward: boolean;
  /** Would the guard refuse it (in any mode)? */
  wouldRefuse: boolean;
  mode: GuardMode;
  kind: WriteDecode['kind'];
  /** Each write with its authorisation and the signed command used (so reconciliation can re-verify it independently). */
  writes: Array<{ point: string; value: PointValue; authorization?: Authorization; command?: SignedCommand }>;
  reasons: Array<{ point?: string; reason: RefusalReason; because: string }>;
  /** Forwarded although the guard could not decide (pass-and-alarm), or refused for that reason (hold-last-good). */
  failMode?: FailMode;
  alarm: boolean;
  source: string;
}

export interface GatePolicy { minWrites: number; minDays: number; /** The most recent N writes must all pass. */ minCleanWrites: number }
export const DEFAULT_GATE: GatePolicy = { minWrites: 20, minDays: 7, minCleanWrites: 10 };

interface PointShadow { startedAt: number; lastAt: number; writes: number; wouldRefuse: Record<string, number>; recent: boolean[] }
export interface GuardState { points: Record<string, PointShadow>; other: { malformed: number; privileged: Record<string, number>; unmapped: number } }

export interface GuardReport {
  envelopeId: string | null;
  points: Record<string, { mode: GuardMode; writes: number; days: number; wouldRefuse: Record<string, number>; enforce: { ready: boolean; because: string[] } }>;
  other: GuardState['other'];
  reportHash: string;
}

export interface ConstraintGuardOptions {
  /** The active envelope (replayEnvelopes → line.active); null or a throw means evidence unavailable. */
  envelope: () => EnvelopeBody | null | Promise<EnvelopeBody | null>;
  /** Default mode for points without a signed record (default shadow). */
  mode?: GuardMode;
  /** Current per-point modes (replayPointModes); read per request. */
  pointModes?: () => Record<string, GuardMode> | Promise<Record<string, GuardMode>>;
  keyEvidence?: () => KeyEvidence | undefined | Promise<KeyEvidence | undefined>;
  /** Forward writes to targets the map does not cover (default false: refused). */
  allowUnmapped?: boolean;
  /** Privileged operations the operator allows, by the adapter's name for them. */
  allowPrivileged?: readonly string[];
  gate?: GatePolicy;
  state?: GuardState;
  maxArmed?: number;
  onVerdict?: (v: GuardVerdict) => void | Promise<void>;
  now?: () => number;
}

export function createConstraintGuard(o: ConstraintGuardOptions) {
  const now = o.now ?? Date.now; const gate = o.gate ?? DEFAULT_GATE; const maxArmed = o.maxArmed ?? 1000;
  const state: GuardState = o.state ? structuredClone(o.state) : { points: {}, other: { malformed: 0, privileged: {}, unmapped: 0 } };
  const current = new Map<string, PointValue>(); let mode: string | null | undefined;
  /** The operating mode: undefined when the envelope has no mode point, null while its value is unknown (mode-scoped limits then refuse). */
  const modeIn = (env: EnvelopeBody): string | null | undefined => (env.modePoint ? mode ?? null : undefined);
  const armed: SignedCommand[] = [];
  const used = new Map<string, number>(); // nonce key → expiry
  const usedSet = { has: (k: string) => used.has(k), add: (k: string) => { used.set(k, now() + 16 * 60_000); if (used.size > 50_000) for (const [x, exp] of used) if (exp < now()) used.delete(x); return usedSet; } } as unknown as Set<string>;

  const prune = () => { const t = now(); for (let i = armed.length - 1; i >= 0; i--) if (Date.parse(armed[i].expiresAt) < t) armed.splice(i, 1); for (const [k, exp] of used) if (exp < t) used.delete(k); };

  /** Fail modes from the last envelope that could be read: a read failure must not forget them. */
  const lastFailModes = new Map<string, FailMode>();
  async function envelopeOrNull(): Promise<EnvelopeBody | null> {
    try { const e = await o.envelope(); if (e) for (const p of e.points) lastFailModes.set(p.id, p.failMode ?? 'hold-last-good'); return e ?? null; } catch { return null; }
  }
  async function modesNow(): Promise<Record<string, GuardMode>> { try { return (await o.pointModes?.()) ?? {}; } catch { return {}; } }
  const modeFor = (modes: Record<string, GuardMode>, point?: string): GuardMode => (point && modes[point]) || modes['*'] || o.mode || 'shadow';

  function record(points: string[], wouldRefuse: boolean, reasons: GuardVerdict['reasons']) {
    const t = now();
    for (const p of points) {
      const s = (state.points[p] ??= { startedAt: t, lastAt: t, writes: 0, wouldRefuse: {}, recent: [] });
      s.lastAt = t; s.writes++; s.recent.push(!wouldRefuse); if (s.recent.length > Math.max(gate.minCleanWrites, 1)) s.recent.shift();
      for (const r of reasons.filter((x) => !x.point || x.point === p)) s.wouldRefuse[r.reason] = (s.wouldRefuse[r.reason] ?? 0) + 1;
    }
  }

  function pickArmed(point: string, value: PointValue, tentative: Set<string>): SignedCommand | null {
    const free = armed.filter((c) => c.point === point && !usedSet.has(`${c.signerKey}|${c.nonce}`) && !tentative.has(`${c.signerKey}|${c.nonce}`));
    // the one for this value; else any for the point, so the refusal says value-mismatch rather than unsigned
    return free.find((c) => !c.unit && sameish(c.value, value)) ?? free.find((c) => sameish(c.value, value)) ?? free[0] ?? null;
  }

  async function check(decode: WriteDecode, ctx: { source: string; command?: SignedCommand | null } = { source: 'unknown' }): Promise<GuardVerdict> {
    prune();
    const at = now(); const modes = await modesNow();
    const base = { at: new Date(at).toISOString(), kind: decode.kind, source: ctx.source, writes: [] as GuardVerdict['writes'], reasons: [] as GuardVerdict['reasons'], alarm: false };
    const finish = async (v: GuardVerdict) => { try { await o.onVerdict?.(v); } catch { /* the audit sink never changes a decision */ } return v; };
    if (decode.kind === 'read') return finish({ ...base, forward: true, wouldRefuse: false, mode: modeFor(modes) });
    if (decode.kind === 'malformed') {
      state.other.malformed++; const m = modeFor(modes);
      return finish({ ...base, forward: m === 'shadow', wouldRefuse: true, mode: m, alarm: true, reasons: [{ reason: 'malformed', because: decode.because }] });
    }
    if (decode.kind === 'privileged') {
      if (o.allowPrivileged?.includes(decode.what)) return finish({ ...base, forward: true, wouldRefuse: false, mode: modeFor(modes), alarm: true, reasons: [{ reason: 'privileged', because: `${decode.what} (allowed by the operator)` }] });
      state.other.privileged[decode.what] = (state.other.privileged[decode.what] ?? 0) + 1; const m = modeFor(modes);
      return finish({ ...base, forward: m === 'shadow', wouldRefuse: true, mode: m, alarm: true, reasons: [{ reason: 'privileged', because: decode.what }] });
    }
    const points = decode.writes.map((w) => w.point);
    const m: GuardMode = points.some((p) => modeFor(modes, p) === 'enforce') || (!points.length && modeFor(modes) === 'enforce') ? 'enforce' : 'shadow';
    const reasons: GuardVerdict['reasons'] = [];
    if (decode.unmapped.length) { state.other.unmapped++; if (!o.allowUnmapped) reasons.push({ reason: 'unmapped', because: `writes to targets the map does not cover: ${decode.unmapped.slice(0, 8).join(', ')}${decode.unmapped.length > 8 ? ' …' : ''}` }); }
    const env = await envelopeOrNull();
    if (!env) {
      // Cannot decide: in enforce each point's fail mode applies (from the last envelope read; unknown points hold); shadow forwards.
      const fm = points.map((p) => lastFailModes.get(p) ?? 'hold-last-good');
      const failMode: FailMode = !points.length || fm.includes('hold-last-good') ? 'hold-last-good' : 'pass-and-alarm';
      const verdict: GuardVerdict = { ...base, forward: m === 'shadow' || failMode === 'pass-and-alarm', wouldRefuse: true, mode: m, alarm: true, failMode, writes: decode.writes.map((w) => ({ ...w })), reasons: [...reasons, { reason: 'evidence-unavailable', because: failMode === 'hold-last-good' ? 'no active envelope could be read: holding last good values' : 'no active envelope could be read: forwarded under pass-and-alarm' }] };
      record(points, true, verdict.reasons);
      return finish(verdict);
    }
    if (env.advisory) reasons.push({ reason: 'advisory-envelope', because: 'this envelope is advisory: it may inform, never authorise, an inline write' });
    let keyEvidence: KeyEvidence | undefined; let evidenceFailed = false;
    try { keyEvidence = await o.keyEvidence?.(); } catch { evidenceFailed = true; }
    const writes: GuardVerdict['writes'] = [];
    const tentative = new Set<string>(); // nonces consumed only if the whole request passes
    for (const w of decode.writes) {
      const p = env.points.find((x) => x.id === w.point);
      if (!p) { reasons.push({ point: w.point, reason: 'unmapped', because: `${w.point} is mapped but not declared in envelope ${env.envelopeId}` }); writes.push({ ...w }); continue; }
      const cmd = (ctx.command && ctx.command.point === w.point ? ctx.command : null) ?? pickArmed(w.point, w.value, tentative);
      const trial = new Set<string>([...tentative]);
      const probe = { has: (k: string) => usedSet.has(k) || trial.has(k), add: (k: string) => { trial.add(k); return probe; } } as unknown as Set<string>;
      const cur = current.get(w.point);
      const auth = evidenceFailed ? { state: 'key-undeclared' as const, because: 'key evidence could not be read' } : await authorize(env, { at, write: w, command: cmd, current: typeof cur === 'number' ? cur : undefined, mode: modeIn(env), usedNonces: probe, keyEvidence });
      for (const k of trial) tentative.add(k);
      writes.push({ ...w, authorization: auth, ...(cmd ? { command: cmd } : {}) });
      if (auth.state !== 'authorized') reasons.push({ point: w.point, reason: auth.state, because: auth.because });
    }
    const wouldRefuse = reasons.length > 0;
    let forward = !wouldRefuse || m === 'shadow'; let failMode: FailMode | undefined;
    if (evidenceFailed) {
      const fm = decode.writes.map((w) => env.points.find((x) => x.id === w.point)?.failMode ?? 'hold-last-good');
      failMode = fm.includes('hold-last-good') ? 'hold-last-good' : 'pass-and-alarm';
      if (failMode === 'pass-and-alarm') forward = true;
    }
    if (forward && !wouldRefuse) {
      for (const k of tentative) usedSet.add(k);
      for (let i = armed.length - 1; i >= 0; i--) if (tentative.has(`${armed[i].signerKey}|${armed[i].nonce}`)) armed.splice(i, 1);
      for (const w of decode.writes) current.set(w.point, w.value);
    }
    record(points, wouldRefuse, reasons);
    return finish({ ...base, forward, wouldRefuse, mode: m, writes, reasons, failMode, alarm: wouldRefuse || !!failMode });
  }

  return {
    check,
    /** Feed observed values (current values for step limits, the mode point). */
    async observe(obs: readonly Observation[]) {
      const env = await envelopeOrNull();
      for (const x of [...obs].sort((a, b) => a.at - b.at)) {
        if (x.quality === 'bad') continue;
        if (env?.modePoint && x.point === env.modePoint) mode = String(x.value);
        if (env?.points.some((p) => p.id === x.point && (p.kind === 'setpoint' || p.kind === 'command'))) current.set(x.point, x.value);
      }
    },
    /** Arm a signed command for a protocol that cannot carry it: checked now (without consuming), consumed by one matching write. */
    async arm(cmd: SignedCommand): Promise<Authorization> {
      prune();
      const env = await envelopeOrNull();
      if (!env) return { state: 'key-undeclared', because: 'no active envelope: nothing can be armed' };
      const cur = current.get(cmd.point);
      const dry = new Set<string>(); const probe = { has: (k: string) => usedSet.has(k) || armed.some((a) => `${a.signerKey}|${a.nonce}` === k), add: (k: string) => { dry.add(k); return probe; } } as unknown as Set<string>;
      let keyEvidence: KeyEvidence | undefined; try { keyEvidence = await o.keyEvidence?.(); } catch { return { state: 'key-undeclared', because: 'key evidence could not be read' }; }
      const auth = await authorize(env, { at: now(), write: { point: cmd.point, value: cmd.value, unit: cmd.unit }, command: cmd, current: typeof cur === 'number' ? cur : undefined, mode: modeIn(env), usedNonces: probe, keyEvidence });
      if (auth.state === 'authorized') { if (armed.length >= maxArmed) return { state: 'malformed', because: `too many armed commands (${maxArmed})` }; armed.push(cmd); }
      return auth;
    },
    armedCount: () => (prune(), armed.length),
    state: (): GuardState => structuredClone(state),
    async report(): Promise<GuardReport> {
      const env = await envelopeOrNull(); const modes = await modesNow(); const t = now();
      const points: GuardReport['points'] = {};
      const ids = new Set([...(env?.points.filter((p) => p.kind === 'setpoint' || p.kind === 'command').map((p) => p.id) ?? []), ...Object.keys(state.points)]);
      for (const id of [...ids].sort()) {
        const s = state.points[id]; const days = s ? (t - s.startedAt) / 86_400_000 : 0; const because: string[] = [];
        if (!s || s.writes < gate.minWrites) because.push(`${s?.writes ?? 0} of ${gate.minWrites} writes seen`);
        if (days < gate.minDays) because.push(`${days.toFixed(1)} of ${gate.minDays} days`);
        if (s && s.recent.length >= gate.minCleanWrites && s.recent.slice(-gate.minCleanWrites).some((ok) => !ok)) because.push(`the last ${gate.minCleanWrites} writes did not all pass: ${Object.entries(s.wouldRefuse).map(([k, n]) => `${k} ×${n}`).join(', ')}`);
        if (s && s.recent.length < gate.minCleanWrites) because.push(`fewer than ${gate.minCleanWrites} recent writes`);
        points[id] = { mode: modeFor(modes, id), writes: s?.writes ?? 0, days: Math.round(days * 10) / 10, wouldRefuse: s?.wouldRefuse ?? {}, enforce: { ready: because.length === 0, because } };
      }
      const body = { envelopeId: env?.envelopeId ?? null, points, other: state.other };
      return { ...body, reportHash: await sha256HexOf(canonicalJson(body)) };
    },
  };
}

function sameish(a: PointValue, b: PointValue) { return typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a)) : a === b; }

export type ConstraintGuard = ReturnType<typeof createConstraintGuard>;
