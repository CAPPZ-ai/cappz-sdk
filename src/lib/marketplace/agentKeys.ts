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
import { evaluateKey, pqAnchorState, verifyKeyDeclaration, type KeyDeclaration, type KeyRevocation, type KeyTrustState } from '../identity/keyDeclaration';
import { isDeclarationShape } from '../identity/edgeVerify';
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

/** Structural check of an untrusted v2 declaration before any field is read (the signature is checked after). */
export function isKeyDeclarationV2(d: unknown): d is KeyDeclaration {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
  // v16-03-00: the edge's shape check, which knows each algorithm's key length (ML-DSA-65, P-256 + ML-KEM-768) and the pq co-signature.
  return (d as Record<string, unknown>).v === 2 && isDeclarationShape(d);
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
  const t = await evaluateKey(d.walletAddress, key, 'signing', profileEvidence(p, revocations), Date.parse(now));
  return { ...base, state: t.state, walletAddress: d.walletAddress, ...(t.declarationHash ? { declarationHash: t.declarationHash } : {}), ...(t.expiresAt ? { expiresAt: t.expiresAt } : {}), because: t.because };
}

/** The KeyZ evidence a profile carries: its declarations (with the post-quantum anchor, if any) and revocations. */
export function profileEvidence(p: PartyProfile, revocations: readonly KeyRevocation[] = []) {
  const declarations = [p.keyDeclaration, p.pqAnchor, p.pqKeyDeclaration].filter(isKeyDeclarationV2);
  return { declarations, revocations: [...(p.keyRevocations ?? []), ...revocations] };
}

/**
 * The profile's ML-DSA-65 request key and how far it speaks for the party now ('declared' when the anchor co-signs a
 * valid declaration by the same wallet as the Ed25519 key). Null when the profile declares none.
 */
export async function agentPqKeyState(p: PartyProfile, now: string, revocations: readonly KeyRevocation[] = []): Promise<{ publicKey: string; state: KeyTrustState; because: string } | null> {
  const d = p.pqKeyDeclaration;
  if (!isKeyDeclarationV2(d) || d.algorithm !== 'ml-dsa-65') return null;
  if (p.keyDeclaration && d.walletAddress !== p.keyDeclaration.walletAddress) return { publicKey: lc(d.publicKey), state: 'undeclared', because: 'the ML-DSA key is declared by another wallet than the profile key' };
  const t = await evaluateKey(d.walletAddress, d.publicKey, 'signing', profileEvidence(p, revocations), Date.parse(now));
  return { publicKey: lc(d.publicKey), state: t.state, because: t.because };
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
  // v16-03-00 post-quantum: an anchor (ML-DSA-65, proven by its own signature) and an ML-DSA request key it co-signs.
  if (profile.pqAnchor !== undefined || profile.pqKeyDeclaration !== undefined) {
    const a = profile.pqAnchor; const k = profile.pqKeyDeclaration;
    if (!isKeyDeclarationV2(a) || a.purpose !== 'pq-anchor' || a.algorithm !== 'ml-dsa-65') p.push('pqAnchor must be a KeyZ pq-anchor declaration (ml-dsa-65).');
    else {
      const st = await pqAnchorState(a.walletAddress, { declarations: [a] }, Date.parse(now));
      if (st.state !== 'anchored') p.push(`pqAnchor does not prove itself (${st.because}).`);
      if (d && isKeyDeclarationV2(d) && d.walletAddress !== a.walletAddress) p.push('pqAnchor must be declared by the same wallet as keyDeclaration.');
    }
    if (k !== undefined) {
      if (!isKeyDeclarationV2(k) || k.purpose !== 'signing' || k.algorithm !== 'ml-dsa-65') p.push('pqKeyDeclaration must be a KeyZ signing declaration (ml-dsa-65).');
      else {
        const t = await evaluateKey(k.walletAddress, k.publicKey, 'signing', profileEvidence(profile), Date.parse(now));
        if (t.state !== 'declared') p.push(`pqKeyDeclaration is ${t.state} (${t.because}).`);
      }
    }
    if (d && isKeyDeclarationV2(d) && isKeyDeclarationV2(a)) {
      const t = await evaluateKey(d.walletAddress, d.publicKey, 'signing', profileEvidence(profile), Date.parse(now));
      if (t.state !== 'declared') p.push(`keyDeclaration is ${t.state} under the anchor (${t.because}): co-sign it with the anchor.`);
    }
  }
  return p;
}
