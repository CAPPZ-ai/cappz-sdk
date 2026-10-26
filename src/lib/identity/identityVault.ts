/**
 * COPE node crystallized.
 * Node ID: v15-09-00-identity-vault
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Identity information lives in the holder's identity wallet, under
 * <root>/identity/ (paths.ts). Each claim is an SD-JWT disclosure: the TX
 * carries its salted digest and the disclosure encrypted with the holder's
 * content key, so the ledger never sees a value. Separate identity wallet
 * from participation and settlement wallets (design guide §8).
 *
 * Trust is layered and never collapsed:
 *   self-asserted  → the holder signed it (sdJwt 'self-asserted')
 *   attested       → an issuer wallet signed the digests at an evidence level
 *                    (NIST 800-63 IAL), optionally citing a biometric binding
 *   anchored       → the attestation hash was found on the ledger (checked
 *                    elsewhere; 'unchecked' until then)
 *   revoked        → holder withdrew the claim, or the issuer revoked
 *
 * Biometrics never leave the device: a binding records only a hash of the
 * WebAuthn credential id the authenticator matched against; templates stay
 * in the authenticator. The attestation says "this person, enrolled on that
 * authenticator, matched that document" — the combined proof — without
 * sending biometric data again.
 *
 * Sending identity to another wallet reuses requester-sends-XRequested,
 * decider-replies: IdentityDisclosureRequested (claims, purpose, nonce, the
 * verifier's sealing key) → IdentityDisclosed (an SD-JWT presentation sealed
 * to the verifier, key-bound to the nonce) or IdentityDisclosureDeclined.
 * Revoking a claim stops future disclosures; one already delivered stays
 * delivered (permanence).
 */

import { identityAttestationAddress, identityClaimAddress, identityDisclosureAddress } from '../wallets/paths.ts';
import { decryptContent, encryptContent, openWith, sealTo, type ContentCipher, type SealedBox } from '../crypto/sealedBox.ts';
import { attestationIdOf, decodeDisclosure, issueSdJwt, makeDisclosure, presentSdJwt, verifyPresentation, type EvidenceLevel, type PresentationResult } from './sdJwt.ts';
import { sha256HexOf } from './canonical.ts';
import { didKeyFor } from './didKey.ts';
import { signMessage, verifySignature } from '../auth/wallet/session.ts';

export const IDENTITY_PRINCIPLE = "m/44'/144'/100'/principles/cope/v1";
export const IDENTITY_DISCLOSURE_BPMN = "m/44'/144'/100'/bpmn/substrate/identity-disclosure";

export const IDENTITY_EVENT_TYPES = [
  'IdentityClaimRecorded', 'IdentityClaimAmended', 'IdentityClaimRevoked',
  'IdentityAttested', 'IdentityAttestationRevoked', 'BiometricBindingRecorded',
  'IdentityDisclosureRequested', 'IdentityDisclosed', 'IdentityDisclosureDeclined',
] as const;
export type IdentityEventType = (typeof IDENTITY_EVENT_TYPES)[number];

export interface IdentityTx<T = object> {
  eventType: IdentityEventType;
  address: string;
  txId: string;
  timestamp: string;
  correlationId: string;
  governingPrinciple: string;
  data: T;
}

let lastMs = 0;
/** Strictly increasing timestamps: TXs written together replay in written order. */
function stamp(now?: number): string { lastMs = Math.max(now ?? Date.now(), lastMs + 1); return new Date(lastMs).toISOString(); }
const newId = (p: string) => `${p}-${crypto.randomUUID()}`;
function tx<T>(eventType: IdentityEventType, address: string, data: T, correlationId: string, now?: number): IdentityTx<T> {
  return { eventType, address, txId: newId(eventType.replace(/[a-z]/g, '').toLowerCase()), timestamp: stamp(now), correlationId, governingPrinciple: IDENTITY_PRINCIPLE, data };
}

// ─── Claims ───────────────────────────────────────────────────────

export interface ClaimData { claimId: string; claimType: string; digest: string; cipher: ContentCipher; amends?: string }

/** Record a claim: digest public to the wallet's replicas, value encrypted with the holder's content key. */
export async function recordClaim(holderRoot: string, claimType: string, value: unknown, contentKey: string, amends?: { claimId: string; txId: string }): Promise<IdentityTx<ClaimData>> {
  const d = await makeDisclosure(claimType, value);
  const claimId = amends?.claimId ?? crypto.randomUUID();
  const data: ClaimData = { claimId, claimType, digest: d.digest, cipher: await encryptContent(contentKey, d.encoded), ...(amends ? { amends: amends.txId } : {}) };
  return tx(amends ? 'IdentityClaimAmended' : 'IdentityClaimRecorded', identityClaimAddress(holderRoot, claimType, claimId), data, claimId);
}

export function revokeClaim(holderRoot: string, claim: { claimId: string; claimType: string; digest: string }, reason: string): IdentityTx<{ claimId: string; digest: string; reason: string }> {
  return tx('IdentityClaimRevoked', identityClaimAddress(holderRoot, claim.claimType, claim.claimId), { claimId: claim.claimId, digest: claim.digest, reason }, claim.claimId);
}

/** The holder's own disclosure string for a claim (decrypted with the holder's content key). */
export async function openClaim(c: ClaimData, contentKey: string): Promise<string> {
  const encoded = await decryptContent(contentKey, c.cipher);
  const d = await decodeDisclosure(encoded);
  if (!d || d.digest !== c.digest) throw new Error('claim does not match its recorded digest');
  return encoded;
}

// ─── Biometric binding ────────────────────────────────────────────

export interface BiometricBindingData { bindingId: string; method: 'webauthn'; credentialIdHash: string; userVerification: 'required' | 'preferred'; aaguid?: string }

/** Record that a device authenticator (WebAuthn, user verification) is bound to this identity. Only a hash of its credential id. */
export async function recordBiometricBinding(holderRoot: string, credentialId: Uint8Array | string, opts: { aaguid?: string; userVerification?: 'required' | 'preferred' } = {}): Promise<IdentityTx<BiometricBindingData>> {
  const raw = typeof credentialId === 'string' ? credentialId : Array.from(credentialId, (b) => b.toString(16).padStart(2, '0')).join('');
  const bindingId = crypto.randomUUID();
  return tx('BiometricBindingRecorded', `${holderRoot}/identity/bindings/${bindingId}`, {
    bindingId, method: 'webauthn', credentialIdHash: await sha256HexOf(`webauthn:${raw}`), userVerification: opts.userVerification ?? 'required', ...(opts.aaguid ? { aaguid: opts.aaguid } : {}),
  }, bindingId);
}

// ─── Attestation (issuer side) ────────────────────────────────────

export interface AttestationData { attestationId: string; issuerAddress: string; subjectAddress: string; claimTypes: string[]; level: EvidenceLevel; method: string; bindingTxId?: string; jwt: string; expiresAt?: string }

/**
 * Issuer attests claims it checked. It receives the holder's disclosures out
 * of band (or in a disclosure exchange), checks the values against evidence,
 * and signs only their digests. The TX is filed in the subject's identity
 * subtree, sent like any wallet-to-wallet TX.
 */
export async function attestClaims(o: {
  issuerPrivateKey: Uint8Array; issuerAddress: string; subjectRoot: string; subjectAddress: string;
  disclosures: readonly string[]; level: Exclude<EvidenceLevel, 'self-asserted'> | 'self-asserted'; method: string; bindingTxId?: string; ttlMs?: number; now?: number;
}): Promise<IdentityTx<AttestationData>> {
  const decoded = await Promise.all(o.disclosures.map(decodeDisclosure));
  if (decoded.some((d) => !d)) throw new Error('unreadable disclosure');
  const now = o.now ?? Date.now();
  const expiresAt = o.ttlMs ? now + o.ttlMs : undefined;
  const jwt = await issueSdJwt({
    issuerPrivateKey: o.issuerPrivateKey, issuerAddress: o.issuerAddress, subjectAddress: o.subjectAddress,
    digests: decoded.map((d) => d!.digest), evidence: { level: o.level, method: o.method, ...(o.bindingTxId ? { bindingTxId: o.bindingTxId } : {}) }, issuedAt: now, expiresAt,
  });
  const attestationId = await attestationIdOf(jwt);
  return tx('IdentityAttested', identityAttestationAddress(o.subjectRoot, attestationId), {
    attestationId, issuerAddress: o.issuerAddress, subjectAddress: o.subjectAddress, claimTypes: decoded.map((d) => d!.name),
    level: o.level, method: o.method, ...(o.bindingTxId ? { bindingTxId: o.bindingTxId } : {}), jwt, ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
  }, attestationId, now);
}

/** Self-attestation: the holder signs its own digests (state 'self-asserted' on verification). */
export function selfAttest(o: { holderPrivateKey: Uint8Array; holderAddress: string; holderRoot: string; disclosures: readonly string[] }) {
  return attestClaims({ issuerPrivateKey: o.holderPrivateKey, issuerAddress: o.holderAddress, subjectRoot: o.holderRoot, subjectAddress: o.holderAddress, disclosures: o.disclosures, level: 'self-asserted', method: 'holder-signed' });
}

export interface AttestationRevocationData { attestationId: string; issuerAddress: string; reason: string; signature: string }

/** Issuer-signed revocation; verifiers replay it (no status server). */
export async function revokeAttestation(issuerPrivateKey: Uint8Array, issuerAddress: string, subjectRoot: string, attestationId: string, reason: string): Promise<IdentityTx<AttestationRevocationData>> {
  const signature = await signMessage(issuerPrivateKey, `IdentityAttestationRevoked|${attestationId}|${reason}`);
  return tx('IdentityAttestationRevoked', identityAttestationAddress(subjectRoot, attestationId), { attestationId, issuerAddress, reason, signature }, attestationId);
}

/** Revoked attestation ids, counting only revocations signed by the attestation's own issuer. */
export async function revokedAttestationIds(txs: readonly IdentityTx[]): Promise<Set<string>> {
  const data = (t: IdentityTx) => t.data as Record<string, unknown>;
  const issuers = new Map<string, string>();
  for (const t of txs) if (t.eventType === 'IdentityAttested') issuers.set(String(data(t).attestationId), String(data(t).issuerAddress));
  const out = new Set<string>();
  for (const t of txs) {
    if (t.eventType !== 'IdentityAttestationRevoked') continue;
    const r = t.data as unknown as AttestationRevocationData;
    const issuer = issuers.get(r.attestationId) ?? r.issuerAddress;
    if (r.issuerAddress === issuer && (await verifySignature(`IdentityAttestationRevoked|${r.attestationId}|${r.reason}`, r.signature, issuer))) out.add(r.attestationId);
  }
  return out;
}

// ─── Disclosure exchange ──────────────────────────────────────────

export interface DisclosureRequestData { requestId: string; verifierAddress: string; holderAddress: string; claimTypes: string[]; purpose: string; nonce: string; audience: string; verifierBoxKey: JsonWebKey }
export interface DisclosedData { requestId: string; sealed: SealedBox; presentationHash: string; claimTypes: string[] }
export interface DeclinedData { requestId: string; reason: string }

/** Verifier → holder. The nonce and audience bind the answer to this request. */
export function requestDisclosure(o: { holderRoot: string; verifierAddress: string; holderAddress: string; claimTypes: string[]; purpose: string; verifierBoxKey: JsonWebKey }): IdentityTx<DisclosureRequestData> {
  const requestId = crypto.randomUUID();
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  return tx('IdentityDisclosureRequested', identityDisclosureAddress(o.holderRoot, requestId), {
    requestId, verifierAddress: o.verifierAddress, holderAddress: o.holderAddress, claimTypes: [...o.claimTypes], purpose: o.purpose, nonce, audience: didKeyFor('secp256k1', o.verifierAddress), verifierBoxKey: o.verifierBoxKey,
  }, requestId);
}

/**
 * Holder answers: chooses which of the requested claims to reveal (never more
 * than asked), presents them under one attestation, seals the presentation to
 * the verifier's key. Only the hash of the presentation is in clear.
 */
export async function answerDisclosure(o: {
  holderRoot: string; holderPrivateKey: Uint8Array; request: IdentityTx<DisclosureRequestData>;
  attestationJwt: string; disclosures: readonly string[];
}): Promise<IdentityTx<DisclosedData>> {
  const asked = new Set(o.request.data.claimTypes);
  const chosen: string[] = []; const types: string[] = [];
  for (const e of o.disclosures) {
    const d = await decodeDisclosure(e);
    if (!d) throw new Error('unreadable disclosure');
    if (!asked.has(d.name)) throw new Error(`${d.name} was not requested; disclose only what was asked`);
    chosen.push(e); types.push(d.name);
  }
  const presentation = await presentSdJwt(o.attestationJwt, chosen, o.holderPrivateKey, o.request.data.audience, o.request.data.nonce);
  return tx('IdentityDisclosed', identityDisclosureAddress(o.holderRoot, o.request.data.requestId), {
    requestId: o.request.data.requestId, sealed: await sealTo(o.request.data.verifierBoxKey, presentation), presentationHash: await sha256HexOf(presentation), claimTypes: types,
  }, o.request.correlationId);
}

export function declineDisclosure(holderRoot: string, request: IdentityTx<DisclosureRequestData>, reason: string): IdentityTx<DeclinedData> {
  return tx('IdentityDisclosureDeclined', identityDisclosureAddress(holderRoot, request.data.requestId), { requestId: request.data.requestId, reason }, request.correlationId);
}

export interface DisclosureVerdict extends PresentationResult {
  /** Did the answer come from the wallet that was asked? */
  holderMatches: boolean;
  /** Ledger anchoring is a separate check (lib/xrpl/ledgerCheck.ts); never implied. */
  anchor: 'unchecked';
}

/** Verifier opens the sealed answer and checks it against its own request. */
export async function verifyDisclosure(answer: IdentityTx<DisclosedData>, request: IdentityTx<DisclosureRequestData>, verifierBoxPrivateKey: JsonWebKey, ledgerTxs: readonly IdentityTx[] = []): Promise<DisclosureVerdict> {
  const presentation = await openWith<string>(verifierBoxPrivateKey, answer.data.sealed);
  if ((await sha256HexOf(presentation)) !== answer.data.presentationHash) return { state: 'malformed', claims: {}, because: 'sealed presentation does not match its recorded hash', holderMatches: false, anchor: 'unchecked' };
  const r = await verifyPresentation(presentation, { aud: request.data.audience, nonce: request.data.nonce, revokedAttestations: await revokedAttestationIds(ledgerTxs) });
  const holderMatches = r.subject === didKeyFor('secp256k1', request.data.holderAddress);
  const asked = new Set(request.data.claimTypes);
  if (Object.keys(r.claims).some((k) => !asked.has(k))) return { ...r, state: 'malformed', because: 'answer discloses claims that were not requested', holderMatches, anchor: 'unchecked' };
  return { ...r, holderMatches, anchor: 'unchecked' };
}

// ─── Replay ───────────────────────────────────────────────────────

export type ClaimState = 'recorded' | 'amended' | 'revoked';
export type DisclosureState = 'requested' | 'disclosed' | 'declined';

export interface IdentityView {
  claims: Array<ClaimData & { state: ClaimState; because: string; txId: string }>;
  attestations: Array<AttestationData & { state: 'attested' | 'revoked' | 'expired'; txId: string }>;
  bindings: BiometricBindingData[];
  disclosures: Array<{ requestId: string; state: DisclosureState; because: string; request?: DisclosureRequestData }>;
}

/** Replay an identity subtree's TXs (oldest first). States carry the TX that put them there. */
export async function replayIdentity(txs: readonly IdentityTx[], now = Date.now()): Promise<IdentityView> {
  const sorted = [...txs].sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.txId < b.txId ? -1 : 1));
  const claims = new Map<string, IdentityView['claims'][number]>();
  const atts = new Map<string, IdentityView['attestations'][number]>();
  const bindings: BiometricBindingData[] = [];
  const disc = new Map<string, IdentityView['disclosures'][number]>();
  const revokedAtt = await revokedAttestationIds(sorted);
  for (const t of sorted) {
    const d = t.data as Record<string, unknown>;
    switch (t.eventType) {
      case 'IdentityClaimRecorded': claims.set(String(d.claimId), { ...(d as unknown as ClaimData), state: 'recorded', because: t.txId, txId: t.txId }); break;
      case 'IdentityClaimAmended': {
        const prior = claims.get(String(d.claimId));
        // Amend only the version it names; a stray amendment is not applied.
        if (prior && prior.state !== 'revoked' && prior.txId === d.amends) claims.set(String(d.claimId), { ...(d as unknown as ClaimData), state: 'amended', because: t.txId, txId: t.txId });
        break;
      }
      case 'IdentityClaimRevoked': { const c = claims.get(String(d.claimId)); if (c) claims.set(c.claimId, { ...c, state: 'revoked', because: t.txId }); break; }
      case 'IdentityAttested': {
        const a = d as unknown as AttestationData;
        const expired = a.expiresAt ? Date.parse(a.expiresAt) <= now : false;
        atts.set(a.attestationId, { ...a, state: revokedAtt.has(a.attestationId) ? 'revoked' : expired ? 'expired' : 'attested', txId: t.txId });
        break;
      }
      case 'BiometricBindingRecorded': bindings.push(d as unknown as BiometricBindingData); break;
      case 'IdentityDisclosureRequested': disc.set(String(d.requestId), { requestId: String(d.requestId), state: 'requested', because: t.txId, request: d as unknown as DisclosureRequestData }); break;
      case 'IdentityDisclosed': case 'IdentityDisclosureDeclined': {
        const r = disc.get(String(d.requestId));
        // A reply counts only if it answers a request we hold, and only once.
        if (r && r.state === 'requested') disc.set(r.requestId, { ...r, state: t.eventType === 'IdentityDisclosed' ? 'disclosed' : 'declined', because: t.txId });
        break;
      }
      default: break;
    }
  }
  return { claims: [...claims.values()], attestations: [...atts.values()], bindings, disclosures: [...disc.values()] };
}
