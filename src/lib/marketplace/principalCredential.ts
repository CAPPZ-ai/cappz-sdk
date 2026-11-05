/**
 * COPE node crystallized. Node ID: v15-31-00-principal-credential.
 * Provenance: m/44'/144'/100'/principles/cope/v1#marketplace
 *
 * Principal credentials for agent parties, selectively disclosed. An agent's
 * profile may name the SD-JWT VC its principal holds ("a verified
 * organization", "an accredited investor") by reference only: the issuer's
 * did:key, the credential type and the hash of the issuer-signed JWT
 * (sdJwt.attestationIdOf). No claim value, salt or disclosure is ever on
 * the public log.
 *
 * A counterparty that needs a fact asks for it: requestPrincipalDisclosure
 * names the claims, a fresh nonce, an audience and the requester's box key.
 * The holder answers with an SD-JWT presentation of only those claims,
 * key-bound to that nonce and audience (sdJwt.presentSdJwt), sealed to the
 * requester (crypto/sealedBox.ts) — so only the requester reads it, and a
 * captured answer is useless for any other request. verifyPrincipalDisclosure
 * opens it and returns a lifecycle state, never a boolean; a verified
 * disclosure can be cited as evidence by hash (disclosureEvidence), e.g. next
 * to a Rule 506(c) compliance attestation — it does not replace one
 * (securities.ts keeps eligibility an operator's attestation).
 *
 * No hosted service: request and answer travel however the parties like
 * (a message, the agent tool, a paid-agent job input).
 */
import { attestationIdOf, verifyPresentation, presentSdJwt, decodeDisclosure, type PresentationState, type EvidenceLevel } from '../identity/sdJwt';
import { canonicalJson, fromBase64Url, sha256HexOf, toHex } from '../identity/canonical';
import { openWith, sealTo, type SealedBox } from '../crypto/sealedBox';

/** What a profile carries: a reference to the credential, never its values. */
export interface PrincipalCredentialRef {
  /** base64url SHA-256 of the issuer-signed JWT (what an issuer's revocation names). */
  attestationId: string;
  /** The issuer's did:key. */
  issuer: string;
  /** SD-JWT VC type (vct). */
  vct: string;
  expiresAt?: string;
}

export interface DisclosureRequest {
  v: 1;
  kind: 'cappz-principal-disclosure-request';
  requestId: string;
  /** Who asks (a party id) and about whom. */
  from: string;
  subject: string;
  /** Claim names asked for; the holder discloses these and nothing else. */
  claims: string[];
  purpose: string;
  /** The key-binding JWT's audience and nonce: the answer is valid for this request only. */
  aud: string;
  nonce: string;
  /** The requester's P-256 box public key: the answer is sealed to it. */
  replyTo: JsonWebKey;
  issuedAt: string;
  expiresAt: string;
}

export interface DisclosureAnswer {
  v: 1;
  kind: 'cappz-principal-disclosure-answer';
  requestId: string;
  /** Claim names the holder chose not to (or could not) disclose: an honest gap, not a "no". */
  withheld: string[];
  sealed: SealedBox;
}

export type DisclosureState =
  | PresentationState          // verified, self-asserted, bad-issuer-signature, digest-mismatch, bad-key-binding, nonce-mismatch, expired, revoked, malformed…
  | 'request-expired'
  | 'wrong-request'            // the answer names another request
  | 'cannot-open'              // not sealed to this requester's key
  | 'not-on-profile'           // a valid credential, but not the one the subject's profile references
  | 'untrusted-issuer'         // signed by an issuer the verifier does not accept for this purpose
  | 'incomplete';              // valid, but some requested claims were withheld

export interface DisclosureResult {
  state: DisclosureState;
  requestId: string;
  issuer?: string;
  attestationId?: string;
  evidence?: { level: EvidenceLevel; method: string; bindingTxId?: string };
  /** Disclosed values: for the requester only, never to be published. */
  claims: Record<string, unknown>;
  withheld: string[];
  because: string;
}

export const DISCLOSURE_REQUEST_TTL_MS = 15 * 60_000;
const MAX_CLAIMS = 16;

/** A reference for a profile from the issuer-signed JWT the principal holds. */
export async function principalCredentialRef(issuerJwt: string): Promise<PrincipalCredentialRef> {
  let payload: { iss?: string; vct?: string; exp?: number };
  try { payload = JSON.parse(new TextDecoder().decode(fromBase64Url(issuerJwt.split('.')[1] ?? ''))); } catch { throw new Error('Not a JWT.'); }
  if (!payload.iss || !payload.vct) throw new Error('Not an SD-JWT VC issuer JWT (iss and vct required).');
  return { attestationId: await attestationIdOf(issuerJwt), issuer: payload.iss, vct: payload.vct, ...(typeof payload.exp === 'number' ? { expiresAt: new Date(payload.exp * 1000).toISOString() } : {}) };
}

/** Problems with a profile's credential reference (empty = fine): a reference, never values. */
export function principalCredentialProblems(ref: unknown): string[] {
  if (ref === undefined) return [];
  const r = ref as Record<string, unknown>;
  const p: string[] = [];
  if (!r || typeof r !== 'object' || Array.isArray(r)) return ['principalCredential must be { attestationId, issuer, vct }.'];
  if (typeof r.attestationId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(r.attestationId)) p.push('principalCredential.attestationId is the base64url SHA-256 of the issuer JWT.');
  if (typeof r.issuer !== 'string' || !r.issuer.startsWith('did:key:')) p.push('principalCredential.issuer is the issuer did:key.');
  if (typeof r.vct !== 'string' || !r.vct) p.push('principalCredential.vct is the credential type.');
  const allowed = new Set(['attestationId', 'issuer', 'vct', 'expiresAt']);
  const extra = Object.keys(r).filter((k) => !allowed.has(k));
  if (extra.length) p.push(`principalCredential carries only a reference; remove ${extra.join(', ')} (values are disclosed on request, sealed).`);
  return p;
}

export function requestPrincipalDisclosure(o: { from: string; subject: string; claims: string[]; purpose: string; aud: string; replyTo: JsonWebKey; now?: string; ttlMs?: number }): DisclosureRequest {
  const claims = [...new Set(o.claims.map(String))];
  if (!claims.length || claims.length > MAX_CLAIMS) throw new Error(`Ask for 1 to ${MAX_CLAIMS} claims.`);
  if (!o.replyTo?.x || o.replyTo.crv !== 'P-256') throw new Error('replyTo must be your P-256 box public key.');
  const now = o.now ?? new Date().toISOString();
  return {
    v: 1, kind: 'cappz-principal-disclosure-request', requestId: `pdr-${toHex(crypto.getRandomValues(new Uint8Array(8)))}`,
    from: o.from, subject: o.subject, claims, purpose: o.purpose, aud: o.aud, nonce: toHex(crypto.getRandomValues(new Uint8Array(16))),
    replyTo: { kty: o.replyTo.kty, crv: o.replyTo.crv, x: o.replyTo.x, y: o.replyTo.y }, issuedAt: now, expiresAt: new Date(Date.parse(now) + (o.ttlMs ?? DISCLOSURE_REQUEST_TTL_MS)).toISOString(),
  };
}

/**
 * The holder's answer: only the requested claims' disclosures, key-bound to the request's nonce and audience, sealed
 * to the requester. `disclosures` are the holder's encoded disclosures (all of them; the unrequested are dropped here).
 */
export async function answerPrincipalDisclosure(req: DisclosureRequest, held: { issuerJwt: string; disclosures: readonly string[]; holderPrivateKey: Uint8Array }, now = new Date().toISOString()): Promise<DisclosureAnswer> {
  if (req?.kind !== 'cappz-principal-disclosure-request' || req.v !== 1) throw new Error('Not a principal disclosure request.');
  if (Date.parse(req.expiresAt) <= Date.parse(now)) throw new Error('The disclosure request has expired; ask for a new one.');
  const wanted = new Set(req.claims);
  const chosen: string[] = []; const have = new Set<string>();
  for (const e of held.disclosures) {
    const d = await decodeDisclosure(e);
    if (d && wanted.has(d.name) && !have.has(d.name)) { chosen.push(e); have.add(d.name); }
  }
  const presentation = await presentSdJwt(held.issuerJwt, chosen, held.holderPrivateKey, req.aud, req.nonce, Date.parse(now));
  return { v: 1, kind: 'cappz-principal-disclosure-answer', requestId: req.requestId, withheld: req.claims.filter((c) => !have.has(c)), sealed: await sealTo(req.replyTo, { requestId: req.requestId, presentation }) };
}

/**
 * The requester opens and checks an answer. `profileRef` is the subject's profile reference (from the replayed market):
 * a credential other than the one the profile names is `not-on-profile`. `trustedIssuers` (did:key) narrows who may vouch.
 */
export async function verifyPrincipalDisclosure(req: DisclosureRequest, answer: DisclosureAnswer, o: { boxPrivateKey: JsonWebKey; profileRef?: PrincipalCredentialRef | null; trustedIssuers?: readonly string[]; revokedAttestations?: ReadonlySet<string>; now?: string }): Promise<DisclosureResult> {
  const now = o.now ?? new Date().toISOString();
  const out = (state: DisclosureState, because: string, extra: Partial<DisclosureResult> = {}): DisclosureResult => ({ state, requestId: req.requestId, claims: {}, withheld: answer?.withheld ?? [], because, ...extra });
  if (answer?.kind !== 'cappz-principal-disclosure-answer' || answer.v !== 1 || !answer.sealed) return out('malformed', 'not a principal disclosure answer');
  if (answer.requestId !== req.requestId) return out('wrong-request', 'the answer names another request');
  // The presentation's key-binding JWT also carries an iat; the request window bounds when an answer is accepted.
  if (Date.parse(req.expiresAt) <= Date.parse(now)) return out('request-expired', 'the request expired before the answer was checked');
  let inner: { requestId?: string; presentation?: string };
  try { inner = await openWith(o.boxPrivateKey, answer.sealed); } catch { return out('cannot-open', 'the answer is not sealed to this requester'); }
  if (inner.requestId !== req.requestId || typeof inner.presentation !== 'string') return out('wrong-request', 'the sealed answer names another request');
  const p = await verifyPresentation(inner.presentation, { aud: req.aud, nonce: req.nonce, now: Date.parse(now), maxAgeSec: Math.ceil((Date.parse(req.expiresAt) - Date.parse(req.issuedAt)) / 1000), revokedAttestations: o.revokedAttestations });
  const base = { issuer: p.issuer, attestationId: p.attestationId, evidence: p.evidence };
  if (p.state !== 'verified' && p.state !== 'self-asserted') return out(p.state, p.because, base);
  // Only what was asked counts: a disclosure beyond the request is not accepted as an answer to it.
  const claims = Object.fromEntries(Object.entries(p.claims).filter(([k]) => req.claims.includes(k)));
  if (o.profileRef && o.profileRef.attestationId !== p.attestationId) return out('not-on-profile', 'a valid credential, but not the one the subject’s profile references', base);
  if (o.trustedIssuers && !o.trustedIssuers.includes(p.issuer!)) return out('untrusted-issuer', `issuer ${p.issuer} is not accepted for ${req.purpose}`, { ...base, claims });
  if (p.state === 'self-asserted') return out('self-asserted', p.because, { ...base, claims });
  const missing = req.claims.filter((c) => !(c in claims));
  if (missing.length) return out('incomplete', `withheld: ${missing.join(', ')}`, { ...base, claims, withheld: missing });
  return out('verified', p.because, { ...base, claims, withheld: [] });
}

/**
 * What can be cited on a log or in a compliance file for a verified disclosure: hashes and names, no values. The
 * hash commits to the request, the credential and the disclosed values, so the requester can later show the exact
 * answer (which it keeps privately) matches what was cited.
 */
export async function disclosureEvidence(req: DisclosureRequest, r: DisclosureResult, verifiedAt: string): Promise<{ kind: 'principal-disclosure'; state: DisclosureState; requestId: string; subject: string; issuer: string | null; attestationId: string | null; claimNames: string[]; evidenceHash: string; verifiedAt: string }> {
  const evidenceHash = await sha256HexOf(canonicalJson({ requestId: req.requestId, nonce: req.nonce, aud: req.aud, subject: req.subject, attestationId: r.attestationId ?? null, claims: r.claims, state: r.state }));
  return { kind: 'principal-disclosure', state: r.state, requestId: req.requestId, subject: req.subject, issuer: r.issuer ?? null, attestationId: r.attestationId ?? null, claimNames: Object.keys(r.claims).sort(), evidenceHash, verifiedAt };
}
