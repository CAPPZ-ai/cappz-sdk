/**
 * COPE node crystallized. Node ID: v15-31-00-agent-keys.
 * Provenance: m/44'/144'/100'/principles/cope/v1#marketplace
 *
 * Agent party keys (KeyZ binding). An agent party's profile may carry the
 * KeyZ declaration of its request-signing key: an Ed25519 key that its
 * identity wallet declared, with its own secp256k1 key, for purpose
 * `signing` until an expiry (identity/keyDeclaration.ts). The key is trusted
 * exactly as far as that wallet-signed declaration and its replayed
 * revocations say — never by a certificate or a registry.
 *
 * A mandate may bind the agent to that key (MandateContent.boundKey): then
 * requests acting under it must be signed by that key (agentRequestAuth.ts).
 * Without a binding a key is reported, never required: an agent with no key
 * is `undeclared` and still acts within its mandate, as before.
 *
 * Identity (this key), governance (the mandate that binds it) and
 * settlement (escrow legs) stay separate; this module only answers "how far
 * does this key speak for this party now", as a lifecycle state.
 */
import { evaluateKey, verifyKeyDeclaration, type KeyDeclaration, type KeyRevocation, type KeyTrustState } from '../identity/keyDeclaration';
import type { MarketState } from './replay';
import type { PartyProfile } from './types';

export type AgentKeyStateName = KeyTrustState | 'unknown-party';
/** bound: an active mandate binds this key; bound-to-other-key: active mandates bind a different key; unbound: no active mandate binds any key. */
export type KeyBinding = 'bound' | 'bound-to-other-key' | 'unbound';

export interface AgentKeyStatus {
  state: AgentKeyStateName;
  partyId: string;
  keyId: string;
  walletAddress?: string;
  declarationHash?: string;
  expiresAt?: string;
  binding: KeyBinding;
  /** Keys the party's active mandates are bound to (empty = none binds a key). */
  boundKeys: string[];
  because: string;
}

const lc = (s: string) => s.toLowerCase();
const str = (x: Record<string, unknown>, k: string, re: RegExp) => typeof x[k] === 'string' && re.test(x[k] as string);

/** Structural check of an untrusted v2 declaration before any field is read (the signature is checked after). */
export function isKeyDeclarationV2(d: unknown): d is KeyDeclaration {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
  const x = d as Record<string, unknown>;
  return x.v === 2 && str(x, 'walletAddress', /^0[23][0-9a-f]{64}$/i) && str(x, 'publicKey', /^[0-9a-f]{64,130}$/i) && str(x, 'signature', /^[0-9a-f]{120,160}$/i)
    && str(x, 'issuedAt', /^\d{4}-/) && str(x, 'expiresAt', /^\d{4}-/) && typeof x.purpose === 'string' && typeof x.algorithm === 'string';
}

/** Keys the agent's mandates in force at `now` are bound to. */
export function boundKeysOf(state: MarketState, partyId: string, now: string): string[] {
  const t = Date.parse(now);
  return [...new Set(state.mandates.filter((m) => m.agentPartyId === partyId && Date.parse(m.limits.expiresAt) > t && typeof m.boundKey === 'string' && m.boundKey).map((m) => lc(m.boundKey!)))];
}

/**
 * How far does `keyId` (Ed25519 hex) speak for `partyId` at `now`? Pure over the replayed state: the profile's
 * declaration, its revocations plus any the caller replayed from elsewhere, and the mandates that bind keys.
 */
export async function agentKeyState(state: MarketState, partyId: string, keyId: string, now: string, revocations: readonly KeyRevocation[] = []): Promise<AgentKeyStatus> {
  const key = lc(keyId);
  const boundKeys = boundKeysOf(state, partyId, now);
  const binding: KeyBinding = !boundKeys.length ? 'unbound' : boundKeys.includes(key) ? 'bound' : 'bound-to-other-key';
  const base = { partyId, keyId: key, binding, boundKeys };
  const p = state.parties.get(partyId);
  if (!p) return { ...base, state: 'unknown-party', because: `no party ${partyId} on this market` };
  const d = p.keyDeclaration;
  if (!isKeyDeclarationV2(d)) return { ...base, state: 'undeclared', because: 'the profile declares no signing key' };
  if (lc(d.publicKey) !== key) return { ...base, state: 'undeclared', walletAddress: d.walletAddress, because: `the profile declares key ${d.publicKey.slice(0, 16)}…, not this one` };
  const t = await evaluateKey(d.walletAddress, key, 'signing', { declarations: [d], revocations: [...(p.keyRevocations ?? []), ...revocations] }, Date.parse(now));
  return { ...base, state: t.state, walletAddress: d.walletAddress, ...(t.declarationHash ? { declarationHash: t.declarationHash } : {}), ...(t.expiresAt ? { expiresAt: t.expiresAt } : {}), because: t.because };
}

/**
 * Problems with a profile's key material (empty = fine). buildProfile refuses a profile with any: a declaration
 * must verify, be for `signing` with Ed25519 (the RFC 9421 request signatures use it) and be in force.
 */
export async function profileKeyProblems(profile: PartyProfile, now: string): Promise<string[]> {
  const p: string[] = [];
  const d = profile.keyDeclaration;
  if (d !== undefined) {
    if (!isKeyDeclarationV2(d)) p.push('keyDeclaration must be a KeyZ declaration (v 2) signed by your identity wallet.');
    else {
      if (d.purpose !== 'signing') p.push(`keyDeclaration is for ${d.purpose}; an agent's request key is declared for signing.`);
      if (d.algorithm !== 'ed25519') p.push(`keyDeclaration is ${d.algorithm}; request signatures use ed25519.`);
      const check = await verifyKeyDeclaration(d, Date.parse(now));
      if (check !== 'valid') p.push(`keyDeclaration is ${check}${check === 'bad-signature' ? ' (not signed by the wallet it names)' : ''}.`);
    }
  }
  if (profile.keyRevocations !== undefined && (!Array.isArray(profile.keyRevocations) || profile.keyRevocations.length > 32)) p.push('keyRevocations is a list of at most 32 wallet-signed revocations.');
  return p;
}
