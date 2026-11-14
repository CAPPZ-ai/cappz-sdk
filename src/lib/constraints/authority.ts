/**
 * COPE node crystallized.
 * Node ID: v15-40-00-constraint-authority
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Signed commands and the one authorisation rule both the guard (before a
 * write) and reconciliation (after the fact) apply. A command names one
 * point, one value with its unit, a short validity window and a nonce, and is
 * signed by an operator key. It is authorised only when:
 *
 *   - the signature verifies and the command is inside its validity window;
 *   - the nonce was not used before (one command, one write);
 *   - an `authority` constraint grants that key that point at that time — and,
 *     when the grant names a wallet and key evidence is supplied, the wallet's
 *     KeyZ declaration for `signing` is valid and unrevoked (revocations are
 *     replayed offline, so a fired contractor's key stops working everywhere);
 *   - every `schedule` window for the point is open;
 *   - the value is within every `range` for the point (in the active mode) and
 *     the step from the current value is within every `rate.maxStep`.
 *
 * Each refusal is its own state with a reason. A key the envelope lists but no
 * wallet declared is reported `envelope-listed`, distinct from `declared`.
 */

import { canonicalJson } from '../identity/canonical.ts';
import { evaluateKey, type KeyEvidence } from '../identity/keyDeclaration.ts';
import { signCanonical, verifyCanonical, type SigningKey } from '../sync/helloSignature.ts';
import { inWindows, type AuthorityConstraint, type EnvelopeBody, type RangeConstraint, type RateConstraint, type ScheduleConstraint } from './envelope.ts';
import { convert, convertDelta } from './units.ts';

export type PointValue = number | boolean | string;

export interface SignedCommand {
  v: 1; kind: 'cappz.constraints.command';
  envelopeId: string;
  point: string;
  value: PointValue;
  unit?: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  /** Free text for the audit trail (work order, ticket). */
  reason?: string;
  signerKey: string;
  signature: string;
}

export const COMMAND_MAX_TTL_MS = 15 * 60_000;

export async function signCommand(c: { envelopeId: string; point: string; value: PointValue; unit?: string; reason?: string; ttlMs?: number; at?: number; nonce?: string }, key: SigningKey): Promise<SignedCommand> {
  const at = c.at ?? Date.now(); const ttl = Math.min(c.ttlMs ?? 5 * 60_000, COMMAND_MAX_TTL_MS);
  const nonce = c.nonce ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  const unsigned = { v: 1 as const, kind: 'cappz.constraints.command' as const, envelopeId: c.envelopeId, point: c.point, value: c.value, ...(c.unit ? { unit: c.unit } : {}), issuedAt: new Date(at).toISOString(), expiresAt: new Date(at + ttl).toISOString(), nonce, ...(c.reason ? { reason: c.reason } : {}), signerKey: key.publicKeyHex };
  return { ...unsigned, signature: await signCanonical(canonicalJson(unsigned), key) };
}

/** Every authorisation outcome (the guide's refusal table documents each; a test keeps them in step). */
export const AUTHORIZATION_STATES = ['authorized', 'unsigned', 'bad-signature', 'malformed', 'expired', 'not-yet-valid', 'replayed', 'wrong-envelope', 'value-mismatch', 'not-granted', 'key-revoked', 'key-undeclared', 'outside-window', 'outside-schedule', 'out-of-range', 'step-too-large', 'unit-mismatch', 'mode-unknown'] as const;
export type AuthorizationState = typeof AUTHORIZATION_STATES[number];

export interface Authorization {
  state: AuthorizationState;
  because: string;
  /** How far the signing key is trusted: declared/delegated by its wallet, or only listed in the envelope. */
  keyTrust?: 'declared' | 'delegated' | 'envelope-listed';
  constraintId?: string;
  signerKey?: string;
}

export interface AuthorizeContext {
  /** When the write happens (ms). */
  at: number;
  /** The value about to be written / observed being written, in the point's unit unless `unit` is given. */
  write: { point: string; value: PointValue; unit?: string };
  command?: SignedCommand | null;
  /** The point's current value (for step limits), in the point's unit. */
  current?: number;
  /** Operating mode now (null: the envelope has a mode point but its value is unknown). */
  mode?: string | null;
  /** Nonces already used (the guard keeps them; reconciliation passes the ones seen so far). */
  usedNonces?: Set<string>;
  /** KeyZ evidence for grants that name a wallet. */
  keyEvidence?: KeyEvidence;
  /** Commands issued slightly before the clock that checks them (default 30 s). */
  skewMs?: number;
}

const applies = (c: { modes?: string[] }, mode: string | null | undefined) => !c.modes || (mode != null && c.modes.includes(mode));

/** Value of a write in the point's unit; null when units do not convert. */
export function inPointUnit(env: Pick<EnvelopeBody, 'points'>, point: string, value: PointValue, unit?: string): PointValue | null {
  const p = env.points.find((x) => x.id === point);
  if (!p || typeof value !== 'number' || !unit || unit === p.unit) return value;
  return convert(value, unit, p.unit);
}

function sameValue(a: PointValue | null, b: PointValue | null, unitTol = 1e-6): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= unitTol * Math.max(1, Math.abs(a));
  return a === b;
}

/** Limits a value must satisfy before it is written: range and step, mode-aware. */
export function checkValue(env: EnvelopeBody, point: string, value: PointValue, current: number | undefined, mode: string | null | undefined): Authorization | null {
  if (typeof value !== 'number') return null;
  for (const c of env.constraints) {
    if (!c.points.includes(point)) continue;
    if (c.modes && mode === null) return { state: 'mode-unknown', because: `constraint ${c.id} applies only in modes ${c.modes.join(', ')} and the current mode is unknown`, constraintId: c.id };
    if (!applies(c, mode)) continue;
    const p = env.points.find((x) => x.id === point)!;
    if (c.kind === 'range') {
      const r = c as RangeConstraint;
      const v = convert(value, p.unit, r.unit);
      if (v === null) return { state: 'unit-mismatch', because: `${p.unit} does not convert to ${r.unit}`, constraintId: c.id };
      if ((r.min !== undefined && v < r.min) || (r.max !== undefined && v > r.max)) return { state: 'out-of-range', because: `${v} ${r.unit} is outside ${r.min ?? '−∞'}…${r.max ?? '∞'} ${r.unit} (${c.id})`, constraintId: c.id };
    }
    if (c.kind === 'rate' && (c as RateConstraint).maxStep !== undefined && current !== undefined) {
      const r = c as RateConstraint;
      const step = convertDelta(Math.abs(value - current), p.unit, r.unit);
      if (step === null) return { state: 'unit-mismatch', because: `${p.unit} does not convert to ${r.unit}`, constraintId: c.id };
      if (step > r.maxStep! + 1e-9) return { state: 'step-too-large', because: `a step of ${step} ${r.unit} exceeds ${r.maxStep} ${r.unit} (${c.id})`, constraintId: c.id };
    }
  }
  return null;
}

export async function authorize(env: EnvelopeBody, ctx: AuthorizeContext): Promise<Authorization> {
  const { write, command: cmd, at } = ctx; const skew = ctx.skewMs ?? 30_000;
  const authorities = env.constraints.filter((c): c is AuthorityConstraint => c.kind === 'authority' && c.points.includes(write.point) || (c.kind === 'authority' && c.points.includes('*')));
  const value = inPointUnit(env, write.point, write.value, write.unit);
  if (value === null) return { state: 'unit-mismatch', because: `a write in ${write.unit} does not convert to the point's unit` };

  let keyTrust: Authorization['keyTrust'];
  if (authorities.length) {
    if (!cmd) return { state: 'unsigned', because: 'this point needs a signed command and the write carried none' };
    if (cmd.kind !== 'cappz.constraints.command' || cmd.v !== 1 || typeof cmd.signature !== 'string') return { state: 'malformed', because: 'not a CAPPZ signed command' };
    const { signature, ...unsigned } = cmd;
    if (!(await verifyCanonical(canonicalJson(unsigned), signature, cmd.signerKey).catch(() => false))) return { state: 'bad-signature', because: 'the command signature does not verify', signerKey: cmd.signerKey };
    if (cmd.envelopeId !== env.envelopeId) return { state: 'wrong-envelope', because: `the command is for envelope ${cmd.envelopeId}`, signerKey: cmd.signerKey };
    const issued = Date.parse(cmd.issuedAt); const expires = Date.parse(cmd.expiresAt);
    if (!(expires - issued <= COMMAND_MAX_TTL_MS)) return { state: 'malformed', because: `a command may be valid for at most ${COMMAND_MAX_TTL_MS / 60_000} min`, signerKey: cmd.signerKey };
    if (at < issued - skew) return { state: 'not-yet-valid', because: `issued ${cmd.issuedAt}`, signerKey: cmd.signerKey };
    if (at > expires) return { state: 'expired', because: `expired ${cmd.expiresAt}`, signerKey: cmd.signerKey };
    if (cmd.point !== write.point || !sameValue(inPointUnit(env, cmd.point, cmd.value, cmd.unit), value)) return { state: 'value-mismatch', because: `the command says ${cmd.point} = ${String(cmd.value)}${cmd.unit ? ` ${cmd.unit}` : ''}; the write is ${write.point} = ${String(write.value)}`, signerKey: cmd.signerKey };
    const nonceKey = `${cmd.signerKey}|${cmd.nonce}`;
    if (ctx.usedNonces?.has(nonceKey)) return { state: 'replayed', because: 'this command was already used for a write', signerKey: cmd.signerKey };
    // Every authority constraint that covers the point must grant it.
    for (const a of authorities) {
      const grants = a.grants.filter((g) => g.publicKey.toLowerCase() === cmd.signerKey.toLowerCase() && (g.points.includes('*') || g.points.includes(write.point)));
      if (!grants.length) return { state: 'not-granted', because: `${a.id} grants this key nothing for ${write.point}`, constraintId: a.id, signerKey: cmd.signerKey };
      const open = grants.filter((g) => inWindows(at, g.windows));
      if (!open.length) return { state: 'outside-window', because: `${a.id}: the key may command ${write.point} only in its windows`, constraintId: a.id, signerKey: cmd.signerKey };
      const g = open[0];
      if (g.wallet && ctx.keyEvidence) {
        const t = await evaluateKey(g.wallet, cmd.signerKey, 'signing', ctx.keyEvidence, at);
        if (t.state === 'revoked') return { state: 'key-revoked', because: `${g.wallet} revoked this key: ${t.because}`, constraintId: a.id, signerKey: cmd.signerKey };
        if (t.state !== 'declared' && t.state !== 'delegated') return { state: 'key-undeclared', because: `${g.wallet}: ${t.because}`, constraintId: a.id, signerKey: cmd.signerKey };
        keyTrust = t.state;
      } else keyTrust ??= 'envelope-listed';
    }
  }
  for (const s of env.constraints.filter((c): c is ScheduleConstraint => c.kind === 'schedule' && (c.points.includes(write.point) || c.points.includes('*')))) {
    if (!applies(s, ctx.mode)) continue;
    if (!inWindows(at, s.windows)) return { state: 'outside-schedule', because: `${s.id}: ${write.point} may not be written now`, constraintId: s.id, signerKey: cmd?.signerKey };
  }
  const bad = checkValue(env, write.point, value, ctx.current, ctx.mode);
  if (bad) return { ...bad, signerKey: cmd?.signerKey };
  if (cmd && authorities.length) ctx.usedNonces?.add(`${cmd.signerKey}|${cmd.nonce}`);
  return { state: 'authorized', because: authorities.length ? `signed by a granted key (${keyTrust})` : 'no authority constraint covers this point; schedule and limits pass', keyTrust, signerKey: cmd?.signerKey };
}
