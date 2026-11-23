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
 *
 * v16-02-00 (post-quantum): the wallet's secp256k1 signature is what a future
 * quantum computer forges first, so a wallet can declare a post-quantum anchor
 * now, while its classical signature is still trustworthy: an ML-DSA-65 key
 * (FIPS 204) with purpose 'pq-anchor', proven by its own signature. From then
 * on the wallet is anchored: a declaration counts only if the anchor co-signs
 * it too (`pq`, outside the classically signed text, so existing declarations
 * are co-signed in place and keep their hash). Someone who forges the wallet's
 * secp256k1 signature can no longer declare keys for it ('pq-unsigned'), revoke
 * its anchor (that revocation needs the anchor's own signature), or replace the
 * anchor (a later anchor counts only when the current one endorses it). A rival
 * root anchor that nothing endorses is reported as 'pq-conflict' and fails
 * closed, unless the verifier pinned the anchor it first saw: issue times are
 * self-asserted, so the evidence, not a timestamp, decides. Declarations also
 * name 'p256+ml-kem-768' encryption keys (hybrid sealed boxes) and 'ml-dsa-65'
 * keys. Never derive the anchor seed from the wallet's private key: a quantum
 * attacker recovers that key from its public key. Derive it from the recovery
 * seed or keep it offline (`pqKeyFromSeed`).
 */

import { signMessage, verifySignature } from '../auth/wallet/session.ts';
import { canonicalDeclaration, verifyHelloKeyDeclaration, type HelloKeyDeclaration, type DeclarationCheck } from '../sync/helloKeyDeclaration.ts';
import { signCanonical, verifyCanonical, type SigningKey } from '../sync/helloSignature.ts';
import { canonicalJson, sha256HexOf } from './canonical.ts';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';

export type KeyPurpose = 'hello' | 'tls' | 'signing' | 'encryption' | 'pq-anchor';
export type KeyAlgorithm = 'ed25519' | 'p256' | 'secp256k1' | 'x25519' | 'p256+ml-kem-768' | 'ml-dsa-65';

/**
 * A post-quantum co-signature: ML-DSA-65 by the wallet's anchor (`anchor` is the anchor declaration's hash,
 * or 'self' on the anchor itself) over pqMessage(). `endorsedBy` on a rotated anchor is the previous anchor's
 * signature over the same text.
 */
export interface PqCosign { anchor: string; signature: string; endorsedBy?: { anchor: string; signature: string } }

export interface KeyDeclaration {
  v: 2;
  walletAddress: string;
  /** Hex: raw 32 bytes for ed25519/x25519, SEC1 point for p256/secp256k1, point ‖ ML-KEM-768 key for p256+ml-kem-768, the ML-DSA-65 key for ml-dsa-65. */
  publicKey: string;
  algorithm: KeyAlgorithm;
  purpose: KeyPurpose;
  issuedAt: string;
  expiresAt: string;
  /** Hash of the declaration this one replaces (rotation keeps the old one verifiable). */
  supersedes?: string;
  /** secp256k1 signature by the wallet key over canonicalKeyDeclaration(). */
  signature: string;
  /** The wallet's post-quantum co-signature (not part of the classically signed text, nor of the hash). */
  pq?: PqCosign;
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
  /** Required to revoke a pq-anchor: the anchor's own ML-DSA-65 signature. */
  pq?: PqCosign;
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

const body = <T extends { signature: string }>(d: T): Omit<T, 'signature' | 'pq'> => { const { signature: _s, pq: _p, ...rest } = d as T & { pq?: unknown }; return rest; };

export function canonicalKeyDeclaration(d: Omit<KeyDeclaration, 'signature'>): string {
  const { pq: _p, ...rest } = d as Omit<KeyDeclaration, 'signature'>;
  return canonicalJson({ ...rest, publicKey: rest.publicKey.toLowerCase() });
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
  const { pq: _p, ...rest } = r as Omit<KeyRevocation, 'signature'>;
  return canonicalJson({ ...rest, publicKey: rest.publicKey.toLowerCase() });
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
  | 'pq-unsigned'    // the wallet has a post-quantum anchor and this declaration lacks its co-signature
  | 'pq-conflict'    // rival post-quantum anchors that do not endorse each other (and none is pinned): fails closed
  | 'undeclared';    // no declaration names this key (it may still sign validly: that is 'verified-unbound' upstream)

/** How the answer is protected against a future quantum computer: both signatures, the classical one only, or a wallet that has no anchor yet. */
export type PqPosture = 'hybrid' | 'classical-only' | 'unanchored';

export interface KeyTrust { state: KeyTrustState; declarationHash?: string; expiresAt?: string; because: string; postQuantum?: PqPosture }

export interface KeyEvidence {
  declarations: ReadonlyArray<HelloKeyDeclaration | KeyDeclaration>;
  revocations?: readonly KeyRevocation[];
  delegations?: readonly KeyDelegation[];
  /** wallet → the post-quantum anchor hash this verifier first saw (trust on first use, like an SSH host key). */
  pinnedPqAnchors?: Readonly<Record<string, string>>;
}

// ── Post-quantum anchor ─────────────────────────────────────────────────────

const PQ_CONTEXT = new TextEncoder().encode('cappz-keyz-pq-v1');
const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const bytesOf = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

export interface PqSigningKey { publicKey: string; secretKey: Uint8Array }

/** A new ML-DSA-65 key (random), or the one a 32-byte seed determines. */
export function generatePqKey(seed?: Uint8Array): PqSigningKey {
  const k = ml_dsa65.keygen(seed ?? crypto.getRandomValues(new Uint8Array(32)));
  return { publicKey: hexOf(k.publicKey), secretKey: k.secretKey };
}

/**
 * The anchor key from a recovery seed (HKDF-SHA-256, 'cappz.pq-anchor.ml-dsa-65.v1' + label), so the recovery
 * phrase recovers it. Pass the seed or mnemonic entropy — never the wallet's private key (a quantum computer
 * recovers that from the public key, and with it anything derived from it).
 */
export async function pqKeyFromSeed(recoverySeed: Uint8Array, label = 'anchor'): Promise<PqSigningKey> {
  if (recoverySeed.length < 16) throw new Error('pq key: the recovery seed must be at least 16 bytes');
  const ikm = await crypto.subtle.importKey('raw', recoverySeed as BufferSource, 'HKDF', false, ['deriveBits']);
  const te = new TextEncoder();
  const seed = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: te.encode('cappz.pq-anchor.ml-dsa-65.v1'), info: te.encode(label) }, ikm, 256));
  try { return generatePqKey(seed); } finally { seed.fill(0); }
}

/** What an anchor signs: the statement's classically signed text, bound to the anchor that signs it. */
export function pqMessage(canonicalText: string, anchor: string): Uint8Array {
  return new TextEncoder().encode(`cappz-pq-cosign|${anchor}|${canonicalText}`);
}

function pqSign(text: string, anchor: string, key: PqSigningKey): string {
  return hexOf(ml_dsa65.sign(pqMessage(text, anchor), key.secretKey, { context: PQ_CONTEXT }));
}

function pqVerify(text: string, anchor: string, signatureHex: string, publicKeyHex: string): boolean {
  try { return ml_dsa65.verify(bytesOf(signatureHex), pqMessage(text, anchor), bytesOf(publicKeyHex), { context: PQ_CONTEXT }); } catch { return false; }
}

/**
 * Declare the wallet's post-quantum anchor: signed by the wallet (secp256k1) and by the ML-DSA-65 key itself.
 * To rotate, pass the current anchor and its key: the old anchor endorses the new one, which is the only way a
 * later anchor counts.
 */
export async function declarePqAnchor(
  walletPrivateKey: Uint8Array,
  walletAddress: string,
  key: PqSigningKey,
  o: { ttlMs?: number; now?: number; rotateFrom?: { anchor: KeyDeclaration; key: PqSigningKey } } = {},
): Promise<KeyDeclaration> {
  const prevHash = o.rotateFrom ? await declarationHash(o.rotateFrom.anchor) : undefined;
  const d = await declareKey(walletPrivateKey, walletAddress, { publicKey: key.publicKey, algorithm: 'ml-dsa-65', purpose: 'pq-anchor', ...(prevHash ? { supersedes: prevHash } : {}) }, o.ttlMs ?? 5 * 365 * 24 * 60 * 60 * 1000, o.now);
  const text = canonicalKeyDeclaration(body(d));
  const pq: PqCosign = { anchor: 'self', signature: pqSign(text, 'self', key) };
  if (o.rotateFrom && prevHash) pq.endorsedBy = { anchor: prevHash, signature: pqSign(text, prevHash, o.rotateFrom.key) };
  return { ...d, pq };
}

/** Co-sign a declaration or revocation with the wallet's anchor (in place: its classical signature and hash do not change). */
export async function pqCosign<T extends KeyDeclaration | KeyRevocation>(statement: T, anchor: KeyDeclaration, key: PqSigningKey): Promise<T> {
  if (anchor.purpose !== 'pq-anchor' || anchor.publicKey.toLowerCase() !== key.publicKey.toLowerCase()) throw new Error('pq cosign: this key is not the anchor');
  const hash = await declarationHash(anchor);
  const text = 'declarationHash' in statement ? canonicalRevocation(body(statement as KeyRevocation)) : canonicalKeyDeclaration(body(statement as KeyDeclaration));
  return { ...statement, pq: { anchor: hash, signature: pqSign(text, hash, key) } };
}

export type PqAnchorState =
  | { state: 'unanchored'; because: string }
  | { state: 'anchored'; anchors: Map<string, KeyDeclaration>; current: string; because: string }
  | { state: 'conflict'; roots: string[]; because: string };

/**
 * The wallet's post-quantum anchor chain from the evidence. Anchors count once proven (wallet signature + own
 * ML-DSA signature), even after they expire: an expired anchor still anchors the wallet (no downgrade by
 * waiting), it just cannot co-sign anything new. A root anchor is one nothing endorses; a later anchor joins the
 * chain only when an anchor already in it endorses it. Two roots with no pin is a conflict.
 */
export async function pqAnchorState(walletAddress: string, ev: KeyEvidence, now = Date.now()): Promise<PqAnchorState> {
  const proven = new Map<string, KeyDeclaration>();
  for (const raw of ev.declarations) {
    if (raw.v !== 2 || raw.purpose !== 'pq-anchor' || raw.algorithm !== 'ml-dsa-65' || raw.walletAddress !== walletAddress || !raw.pq || raw.pq.anchor !== 'self') continue;
    const check = await verifyKeyDeclaration(raw, now);
    if (check === 'bad-signature' || check === 'malformed') continue;
    if (!pqVerify(canonicalKeyDeclaration(body(raw)), 'self', raw.pq.signature, raw.publicKey)) continue;
    proven.set(await declarationHash(raw), raw);
  }
  if (!proven.size) return { state: 'unanchored', because: 'the wallet has declared no post-quantum anchor' };
  // An anchor revoked by its own ML-DSA signature leaves the chain (only the anchor can remove itself).
  const selfRevoked = new Set<string>();
  for (const r of ev.revocations ?? []) {
    const a = proven.get(r.declarationHash);
    if (!a || r.walletAddress !== walletAddress || !r.pq || r.pq.anchor !== r.declarationHash) continue;
    if ((await verifyKeyRevocation(r)) === 'valid' && pqVerify(canonicalRevocation(body(r)), r.pq.anchor, r.pq.signature, a.publicKey)) selfRevoked.add(r.declarationHash);
  }
  const endorsed = (h: string, d: KeyDeclaration) => !!d.pq?.endorsedBy && d.pq.endorsedBy.anchor !== h && proven.has(d.pq.endorsedBy.anchor)
    && pqVerify(canonicalKeyDeclaration(body(d)), d.pq.endorsedBy.anchor, d.pq.endorsedBy.signature, proven.get(d.pq.endorsedBy.anchor)!.publicKey);
  const pin = ev.pinnedPqAnchors?.[walletAddress];
  const roots = pin && proven.has(pin) ? [pin] : [...proven.entries()].filter(([h, d]) => !endorsed(h, d)).map(([h]) => h);
  if (roots.length > 1) return { state: 'conflict', roots, because: `${roots.length} post-quantum anchors that do not endorse each other: the wallet's classical key may be compromised` };
  const chain = new Map<string, KeyDeclaration>([[roots[0], proven.get(roots[0])!]]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [h, d] of proven) if (!chain.has(h) && endorsed(h, d) && chain.has(d.pq!.endorsedBy!.anchor)) { chain.set(h, d); grew = true; }
  }
  const live = [...chain.entries()].filter(([h]) => !selfRevoked.has(h)).sort((a, b) => Date.parse(b[1].issuedAt) - Date.parse(a[1].issuedAt));
  // Every anchor in the chain revoked itself: the owner retired post-quantum anchoring (only the anchor could).
  if (!live.length) return { state: 'unanchored', because: 'the wallet retired its post-quantum anchor (revoked by the anchor itself)' };
  const current = live[0][0];
  return { state: 'anchored', anchors: new Map(live), current, because: `anchored by ML-DSA-65 key ${chain.get(current)!.publicKey.slice(0, 16)}…` };
}

function pqCosigned(d: KeyDeclaration, anchors: Map<string, KeyDeclaration>, now: number): boolean {
  if (!d.pq || d.pq.anchor === 'self') return false;
  const a = anchors.get(d.pq.anchor);
  if (!a || Date.parse(a.issuedAt) - CLOCK_SKEW_MS > now) return false;
  return pqVerify(canonicalKeyDeclaration(body(d)), d.pq.anchor, d.pq.signature, a.publicKey);
}

async function revokedHashes(walletAddress: string, revocations: readonly KeyRevocation[] = [], anchors?: Map<string, KeyDeclaration>): Promise<Set<string>> {
  const out = new Set<string>();
  for (const r of revocations) {
    if (r.walletAddress !== walletAddress || (await verifyKeyRevocation(r)) !== 'valid') continue;
    // Revoking an anchor takes the anchor's own signature: a forged classical revocation cannot unanchor the wallet.
    if (anchors?.has(r.declarationHash)) {
      const a = anchors.get(r.declarationHash)!;
      if (!r.pq || r.pq.anchor !== r.declarationHash || !pqVerify(canonicalRevocation(body(r)), r.pq.anchor, r.pq.signature, a.publicKey)) continue;
    }
    out.add(r.declarationHash);
  }
  return out;
}

/** How far can this key be trusted to speak for this wallet for this purpose? */
export async function evaluateKey(walletAddress: string, publicKey: string, purpose: KeyPurpose, ev: KeyEvidence, now = Date.now()): Promise<KeyTrust> {
  const pk = publicKey.toLowerCase();
  const pq = await pqAnchorState(walletAddress, ev, now);
  const revoked = await revokedHashes(walletAddress, ev.revocations, pq.state === 'anchored' ? pq.anchors : undefined);
  const direct = await evaluateDeclared(walletAddress, pk, [purpose], ev.declarations, revoked, now, pq);
  if (direct.state === 'declared' || !ev.delegations?.length) return direct;
  for (const dl of ev.delegations) {
    if (dl.walletAddress !== walletAddress || dl.publicKey.toLowerCase() !== pk) continue;
    if (dl.purpose !== purpose) return { state: 'wrong-purpose', because: `delegated for ${dl.purpose}, not ${purpose}` };
    const parent = await evaluateDeclared(walletAddress, dl.parentPublicKey.toLowerCase(), DELEGATING_PURPOSES, ev.declarations, revoked, now, pq);
    if (parent.state !== 'declared') return { state: parent.state === 'undeclared' ? 'undeclared' : parent.state, because: `delegating key: ${parent.because}` };
    const check = await verifyKeyDelegation(dl, now);
    if (check !== 'valid') return { state: check === 'malformed' ? 'bad-signature' : check, because: `delegation ${check}` };
    // The delegation itself is a short-lived classical (Ed25519) signature: its posture is never better than classical-only.
    return { state: 'delegated', declarationHash: parent.declarationHash, expiresAt: dl.expiresAt, because: `delegated by declared key ${dl.parentPublicKey.slice(0, 16)}… until ${dl.expiresAt}`, postQuantum: parent.postQuantum === 'unanchored' ? 'unanchored' : 'classical-only' };
  }
  return direct;
}

async function evaluateDeclared(walletAddress: string, pk: string, purposes: readonly KeyPurpose[], declarations: KeyEvidence['declarations'], revoked: Set<string>, now: number, pq: PqAnchorState): Promise<KeyTrust> {
  let best: KeyTrust = { state: 'undeclared', because: 'no declaration names this key' };
  const rank: Record<KeyTrustState, number> = { declared: 11, delegated: 10, revoked: 9, 'pq-unsigned': 8, 'pq-conflict': 7, 'wrong-purpose': 6, expired: 5, 'not-yet-valid': 4, 'bad-signature': 3, undeclared: 0 };
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
    else if (pq.state === 'conflict') t = { state: 'pq-conflict', declarationHash: hash, because: pq.because };
    else if (pq.state === 'anchored' && !(d.purpose === 'pq-anchor' && pq.anchors.has(hash)) && !pqCosigned(d, pq.anchors, now)) t = { state: 'pq-unsigned', declarationHash: hash, because: 'the wallet has a post-quantum anchor and this declaration lacks its co-signature' };
    else t = { state: 'declared', declarationHash: hash, expiresAt: d.expiresAt, because: `declared by the wallet for ${d.purpose} until ${d.expiresAt}${pq.state === 'anchored' ? ', co-signed post-quantum' : ''}`, postQuantum: pq.state === 'anchored' ? 'hybrid' : 'unanchored' };
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
