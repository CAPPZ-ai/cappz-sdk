/**
 * COPE node crystallized.
 * Node ID: v15-09-00-key-declaration
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Trust without a certificate authority. A wallet signs, with its own
 * secp256k1 key, a statement that another key speaks for it for one purpose
 * until it expires (KeyDeclared). It withdraws the statement early with a
 * signed revocation (KeyDeclarationRevoked) that every verifier replays — no
 * CRL or OCSP server to ask, and none to fail open. A declared key may bind a
 * short-lived key for one purpose (KeyDelegated): the edge node's declared
 * hello key vouches for the TLS key it generates in memory at boot, so the
 * chain wallet → node key → TLS key verifies offline.
 *
 * v15-04-00 HelloKeyDeclaration (v: 1) stays valid and reads as purpose
 * 'hello', algorithm 'ed25519' (asKeyDeclaration); its signature format is
 * unchanged, so older copies keep presenting it.
 *
 * Checks return lifecycle states, never a boolean: a key nobody declared,
 * a revoked key and an expired key are different answers.
 */

import { signMessage, verifySignature } from '../auth/wallet/session.ts';
import { canonicalDeclaration, verifyHelloKeyDeclaration, type HelloKeyDeclaration, type DeclarationCheck } from '../sync/helloKeyDeclaration.ts';
import { signCanonical, verifyCanonical, type SigningKey } from '../sync/helloSignature.ts';
import { canonicalJson, sha256HexOf } from './canonical.ts';

export type KeyPurpose = 'hello' | 'tls' | 'signing' | 'encryption';
export type KeyAlgorithm = 'ed25519' | 'p256' | 'secp256k1' | 'x25519';

export interface KeyDeclaration {
  v: 2;
  walletAddress: string;
  /** Hex: raw 32 bytes for ed25519/x25519, SEC1 point for p256/secp256k1. */
  publicKey: string;
  algorithm: KeyAlgorithm;
  purpose: KeyPurpose;
  issuedAt: string;
  expiresAt: string;
  /** Hash of the declaration this one replaces (rotation keeps the old one verifiable). */
  supersedes?: string;
  /** secp256k1 signature by the wallet key over canonicalKeyDeclaration(). */
  signature: string;
}

export interface KeyRevocation {
  v: 1;
  walletAddress: string;
  declarationHash: string;
  /** The revoked key, so a verifier holding only key lists can drop it. */
  publicKey: string;
  revokedAt: string;
  reason: string;
  signature: string;
}

export interface KeyDelegation {
  v: 1;
  walletAddress: string;
  /** The declared Ed25519 key that signs this delegation. */
  parentPublicKey: string;
  publicKey: string;
  algorithm: KeyAlgorithm;
  purpose: Exclude<KeyPurpose, 'hello'>;
  issuedAt: string;
  expiresAt: string;
  /** Ed25519 signature by parentPublicKey over sha256(canonicalJson(body)). */
  signature: string;
}

export const KEY_DECLARATION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** Delegated keys are short-lived; 13 days keeps a TLS projection inside the WebTransport 14-day limit. */
export const KEY_DELEGATION_MAX_TTL_MS = 13 * 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60_000;

/** Purposes a declared key may delegate from. */
const DELEGATING_PURPOSES: readonly KeyPurpose[] = ['hello', 'signing'];

const body = <T extends { signature: string }>(d: T): Omit<T, 'signature'> => { const { signature: _s, ...rest } = d; return rest; };

export function canonicalKeyDeclaration(d: Omit<KeyDeclaration, 'signature'>): string {
  return canonicalJson({ ...d, publicKey: d.publicKey.toLowerCase() });
}

/** v1 hello declarations read as purpose 'hello', algorithm 'ed25519'. */
export function asKeyDeclaration(d: HelloKeyDeclaration | KeyDeclaration): KeyDeclaration {
  if (d.v === 2) return d;
  return { v: 2, walletAddress: d.walletAddress, publicKey: d.devicePublicKey.toLowerCase(), algorithm: 'ed25519', purpose: 'hello', issuedAt: d.issuedAt, expiresAt: d.expiresAt, signature: d.signature };
}

const hashCache = new Map<string, Promise<string>>();
/**
 * Identity of a signed declaration (v1 and v2 each over their own signed text). Cached by that exact text — never
 * by object identity, so a changed object is hashed again — because replay evaluates it on every request.
 */
export function declarationHash(d: HelloKeyDeclaration | KeyDeclaration): Promise<string> {
  const text = `${d.v === 1 ? canonicalDeclaration(d) : canonicalKeyDeclaration(body(d))}|${d.signature}`;
  let h = hashCache.get(text);
  if (!h) {
    h = sha256HexOf(text);
    if (hashCache.size >= 10_000) hashCache.delete(hashCache.keys().next().value!);
    hashCache.set(text, h);
  }
  return h;
}

export async function declareKey(
  walletPrivateKey: Uint8Array,
  walletAddress: string,
  key: { publicKey: string; algorithm: KeyAlgorithm; purpose: KeyPurpose; supersedes?: string },
  ttlMs = KEY_DECLARATION_TTL_MS,
  now = Date.now(),
): Promise<KeyDeclaration> {
  const d: Omit<KeyDeclaration, 'signature'> = {
    v: 2, walletAddress, publicKey: key.publicKey.toLowerCase(), algorithm: key.algorithm, purpose: key.purpose,
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlMs).toISOString(),
    ...(key.supersedes ? { supersedes: key.supersedes } : {}),
  };
  return { ...d, signature: await signMessage(walletPrivateKey, canonicalKeyDeclaration(d)) };
}

function window(issuedAt: string, expiresAt: string, now: number): DeclarationCheck | null {
  const issued = Date.parse(issuedAt); const expires = Date.parse(expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) return 'malformed';
  if (issued - CLOCK_SKEW_MS > now) return 'not-yet-valid';
  if (expires <= now) return 'expired';
  return null;
}

export async function verifyKeyDeclaration(d: HelloKeyDeclaration | KeyDeclaration | null | undefined, now = Date.now()): Promise<DeclarationCheck> {
  if (!d) return 'malformed';
  if (d.v === 1) return verifyHelloKeyDeclaration(d, now);
  if (d.v !== 2 || !d.walletAddress || !d.publicKey || !d.signature || !d.purpose || !d.algorithm) return 'malformed';
  const w = window(d.issuedAt, d.expiresAt, now);
  if (w === 'malformed') return w;
  if (!(await walletSignatureOk(canonicalKeyDeclaration(body(d)), d.signature, d.walletAddress))) return 'bad-signature';
  return w ?? 'valid';
}

// A signed statement never changes, so its signature check is cached by the exact signed text + signature +
// signer (never by signature alone: a reused signature over other text must not hit). The time window and
// revocations are evaluated on every call. v15-11-00: this keeps a per-request edge check to one Ed25519 verify.
const sigCache = new Map<string, boolean>();
async function walletSignatureOk(text: string, signature: string, walletAddress: string): Promise<boolean> {
  const k = `${walletAddress}|${signature}|${text}`;
  const hit = sigCache.get(k);
  if (hit !== undefined) return hit;
  const ok = await verifySignature(text, signature, walletAddress);
  if (sigCache.size >= 10_000) sigCache.delete(sigCache.keys().next().value!);
  sigCache.set(k, ok);
  return ok;
}

export function canonicalRevocation(r: Omit<KeyRevocation, 'signature'>): string {
  return canonicalJson({ ...r, publicKey: r.publicKey.toLowerCase() });
}

export async function revokeKeyDeclaration(walletPrivateKey: Uint8Array, d: HelloKeyDeclaration | KeyDeclaration, reason: string, now = Date.now()): Promise<KeyRevocation> {
  const k = asKeyDeclaration(d);
  const r: Omit<KeyRevocation, 'signature'> = { v: 1, walletAddress: k.walletAddress, declarationHash: await declarationHash(d), publicKey: k.publicKey, revokedAt: new Date(now).toISOString(), reason };
  return { ...r, signature: await signMessage(walletPrivateKey, canonicalRevocation(r)) };
}

/** Only the wallet that declared a key can revoke it. */
export async function verifyKeyRevocation(r: KeyRevocation | null | undefined): Promise<'valid' | 'bad-signature' | 'malformed'> {
  if (!r || r.v !== 1 || !r.walletAddress || !r.declarationHash || !r.publicKey || !r.signature) return 'malformed';
  return (await walletSignatureOk(canonicalRevocation(body(r)), r.signature, r.walletAddress)) ? 'valid' : 'bad-signature';
}

export async function delegateKey(
  parent: SigningKey,
  walletAddress: string,
  key: { publicKey: string; algorithm: KeyAlgorithm; purpose: KeyDelegation['purpose'] },
  ttlMs = KEY_DELEGATION_MAX_TTL_MS,
  now = Date.now(),
): Promise<KeyDelegation> {
  const d: Omit<KeyDelegation, 'signature'> = {
    v: 1, walletAddress, parentPublicKey: parent.publicKeyHex.toLowerCase(), publicKey: key.publicKey.toLowerCase(),
    algorithm: key.algorithm, purpose: key.purpose,
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + Math.min(ttlMs, KEY_DELEGATION_MAX_TTL_MS)).toISOString(),
  };
  return { ...d, signature: await signCanonical(canonicalJson(d), parent) };
}

export async function verifyKeyDelegation(d: KeyDelegation | null | undefined, now = Date.now()): Promise<DeclarationCheck> {
  if (!d || d.v !== 1 || !d.parentPublicKey || !d.publicKey || !d.signature) return 'malformed';
  if (Date.parse(d.expiresAt) - Date.parse(d.issuedAt) > KEY_DELEGATION_MAX_TTL_MS + 1000) return 'malformed';
  const w = window(d.issuedAt, d.expiresAt, now);
  if (w === 'malformed') return w;
  if (!(await verifyCanonical(canonicalJson(body(d)), d.signature, d.parentPublicKey))) return 'bad-signature';
  return w ?? 'valid';
}

export type KeyTrustState =
  | 'declared'       // a valid, unrevoked declaration by the wallet names this key for this purpose
  | 'delegated'      // a declared key delegated this key for this purpose, inside its short window
  | 'revoked'        // the wallet revoked the declaration that named this key
  | 'expired'
  | 'not-yet-valid'
  | 'bad-signature'
  | 'wrong-purpose'  // declared, but for another purpose
  | 'undeclared';    // no declaration names this key (it may still sign validly: that is 'verified-unbound' upstream)

export interface KeyTrust { state: KeyTrustState; declarationHash?: string; expiresAt?: string; because: string }

export interface KeyEvidence {
  declarations: ReadonlyArray<HelloKeyDeclaration | KeyDeclaration>;
  revocations?: readonly KeyRevocation[];
  delegations?: readonly KeyDelegation[];
}

async function revokedHashes(walletAddress: string, revocations: readonly KeyRevocation[] = []): Promise<Set<string>> {
  const out = new Set<string>();
  for (const r of revocations) if (r.walletAddress === walletAddress && (await verifyKeyRevocation(r)) === 'valid') out.add(r.declarationHash);
  return out;
}

/** How far can this key be trusted to speak for this wallet for this purpose? */
export async function evaluateKey(walletAddress: string, publicKey: string, purpose: KeyPurpose, ev: KeyEvidence, now = Date.now()): Promise<KeyTrust> {
  const pk = publicKey.toLowerCase();
  const revoked = await revokedHashes(walletAddress, ev.revocations);
  const direct = await evaluateDeclared(walletAddress, pk, [purpose], ev.declarations, revoked, now);
  if (direct.state === 'declared' || !ev.delegations?.length) return direct;
  for (const dl of ev.delegations) {
    if (dl.walletAddress !== walletAddress || dl.publicKey.toLowerCase() !== pk) continue;
    if (dl.purpose !== purpose) return { state: 'wrong-purpose', because: `delegated for ${dl.purpose}, not ${purpose}` };
    const parent = await evaluateDeclared(walletAddress, dl.parentPublicKey.toLowerCase(), DELEGATING_PURPOSES, ev.declarations, revoked, now);
    if (parent.state !== 'declared') return { state: parent.state === 'undeclared' ? 'undeclared' : parent.state, because: `delegating key: ${parent.because}` };
    const check = await verifyKeyDelegation(dl, now);
    if (check !== 'valid') return { state: check === 'malformed' ? 'bad-signature' : check, because: `delegation ${check}` };
    return { state: 'delegated', declarationHash: parent.declarationHash, expiresAt: dl.expiresAt, because: `delegated by declared key ${dl.parentPublicKey.slice(0, 16)}… until ${dl.expiresAt}` };
  }
  return direct;
}

async function evaluateDeclared(walletAddress: string, pk: string, purposes: readonly KeyPurpose[], declarations: KeyEvidence['declarations'], revoked: Set<string>, now: number): Promise<KeyTrust> {
  let best: KeyTrust = { state: 'undeclared', because: 'no declaration names this key' };
  const rank: Record<KeyTrustState, number> = { declared: 9, delegated: 8, revoked: 7, 'wrong-purpose': 6, expired: 5, 'not-yet-valid': 4, 'bad-signature': 3, undeclared: 0 };
  for (const raw of declarations) {
    const d = asKeyDeclaration(raw);
    if (d.walletAddress !== walletAddress || d.publicKey.toLowerCase() !== pk) continue;
    const hash = await declarationHash(raw);
    const check = await verifyKeyDeclaration(raw, now);
    let t: KeyTrust;
    if (check === 'bad-signature' || check === 'malformed') t = { state: 'bad-signature', because: `declaration ${check}` };
    else if (revoked.has(hash)) t = { state: 'revoked', declarationHash: hash, because: 'the wallet revoked this declaration' };
    else if (check !== 'valid') t = { state: check, declarationHash: hash, expiresAt: d.expiresAt, because: `declaration ${check}` };
    else if (!purposes.includes(d.purpose)) t = { state: 'wrong-purpose', declarationHash: hash, because: `declared for ${d.purpose}` };
    else t = { state: 'declared', declarationHash: hash, expiresAt: d.expiresAt, because: `declared by the wallet for ${d.purpose} until ${d.expiresAt}` };
    if (rank[t.state] > rank[best.state]) best = t;
  }
  return best;
}

/** Keys a wallet declared for a purpose, minus revoked ones (feeds verifyHello's declaredKeys). */
export async function declaredKeysFor(walletAddress: string, purpose: KeyPurpose, ev: KeyEvidence, now = Date.now()): Promise<string[]> {
  const out: string[] = [];
  for (const raw of ev.declarations) {
    const pk = asKeyDeclaration(raw).publicKey.toLowerCase();
    if (!out.includes(pk) && (await evaluateKey(walletAddress, pk, purpose, { ...ev, delegations: [] }, now)).state === 'declared') out.push(pk);
  }
  return out;
}

/** Drop keys a valid wallet-signed revocation names (for operator key lists that hold raw keys only). */
export async function withoutRevokedKeys(walletAddress: string, keys: readonly string[], revocations: readonly KeyRevocation[]): Promise<string[]> {
  const gone = new Set<string>();
  for (const r of revocations) if (r.walletAddress === walletAddress && (await verifyKeyRevocation(r)) === 'valid') gone.add(r.publicKey.toLowerCase());
  return keys.filter((k) => !gone.has(k.toLowerCase()));
}
