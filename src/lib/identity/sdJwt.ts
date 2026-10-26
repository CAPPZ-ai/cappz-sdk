/**
 * COPE node crystallized.
 * Node ID: v15-09-00-sd-jwt
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Standards before reinvention: identity claims travel as IETF SD-JWT
 * (selective disclosure) in the SD-JWT VC shape, signed ES256K (RFC 8812)
 * with wallet secp256k1 keys, issuer and subject as did:key. Each claim is a
 * disclosure [salt, name, value]; the issuer signs only their digests, so the
 * holder reveals the claims a verifier asks for and nothing else. A key-binding
 * JWT signed by the holder ties a presentation to the verifier's nonce and
 * audience, so a captured presentation cannot be replayed elsewhere.
 *
 * Wallet login signatures (signMessage, lib/auth/wallet/session.ts) hash
 * twice and are not JOSE ES256K; this module signs JOSE-conformant bytes with
 * the same key so any SD-JWT library can verify the result.
 */

import * as secp from '@noble/secp256k1';
import { fromBase64Url, sha256, toBase64Url, utf8, fromHex } from './canonical.ts';
import { didKeyFor, parseDidKey } from './didKey.ts';

export const SD_JWT_VC_TYP = 'dc+sd-jwt';
export const CAPPZ_IDENTITY_VCT = 'https://cappz.ai/vct/identity/v1';

export type EvidenceLevel = 'self-asserted' | 'IAL1' | 'IAL2' | 'IAL3';

export interface Disclosure { encoded: string; salt: string; name: string; value: unknown; digest: string }

const b64json = (v: unknown) => toBase64Url(utf8(JSON.stringify(v)));
const unjson = <T>(s: string): T => JSON.parse(new TextDecoder().decode(fromBase64Url(s))) as T;

export async function digestOf(encodedDisclosure: string): Promise<string> {
  return toBase64Url(await sha256(utf8(encodedDisclosure)));
}

export async function makeDisclosure(name: string, value: unknown, salt = toBase64Url(crypto.getRandomValues(new Uint8Array(16)))): Promise<Disclosure> {
  const encoded = b64json([salt, name, value]);
  return { encoded, salt, name, value, digest: await digestOf(encoded) };
}

export async function decodeDisclosure(encoded: string): Promise<Disclosure | null> {
  try {
    const arr = unjson<unknown[]>(encoded);
    if (!Array.isArray(arr) || arr.length !== 3 || typeof arr[0] !== 'string' || typeof arr[1] !== 'string') return null;
    return { encoded, salt: arr[0], name: arr[1], value: arr[2], digest: await digestOf(encoded) };
  } catch { return null; }
}

/** Compact JWS, alg ES256K, signed with a wallet secp256k1 private key. */
export async function signJwt(header: Record<string, unknown>, payload: Record<string, unknown>, privateKey: Uint8Array): Promise<string> {
  const input = `${b64json({ ...header, alg: 'ES256K' })}.${b64json(payload)}`;
  const sig = await secp.signAsync(utf8(input), privateKey);
  return `${input}.${toBase64Url(sig)}`;
}

export async function verifyJwt(jwt: string, publicKeyHex: string): Promise<{ header: Record<string, unknown>; payload: Record<string, unknown> } | null> {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = unjson<Record<string, unknown>>(parts[0]);
    if (header.alg !== 'ES256K') return null;
    const ok = await secp.verifyAsync(fromBase64Url(parts[2]), utf8(`${parts[0]}.${parts[1]}`), fromHex(publicKeyHex));
    return ok ? { header, payload: unjson<Record<string, unknown>>(parts[1]) } : null;
  } catch { return null; }
}

export interface IssueOptions {
  issuerPrivateKey: Uint8Array;
  issuerAddress: string;
  subjectAddress: string;
  digests: string[];
  evidence: { level: EvidenceLevel; method: string; bindingTxId?: string };
  issuedAt?: number;
  expiresAt?: number;
  vct?: string;
}

/** The issuer-signed part: a JWT over claim digests, bound to the subject's wallet key (cnf.kid). */
export async function issueSdJwt(o: IssueOptions): Promise<string> {
  const iss = didKeyFor('secp256k1', o.issuerAddress);
  const sub = didKeyFor('secp256k1', o.subjectAddress);
  const iat = Math.floor((o.issuedAt ?? Date.now()) / 1000);
  return signJwt({ typ: SD_JWT_VC_TYP, kid: `${iss}#${iss.slice(8)}` }, {
    iss, sub, iat, ...(o.expiresAt ? { exp: Math.floor(o.expiresAt / 1000) } : {}),
    vct: o.vct ?? CAPPZ_IDENTITY_VCT, _sd: [...o.digests].sort(), _sd_alg: 'sha-256',
    cnf: { kid: sub }, evidence: o.evidence,
  }, o.issuerPrivateKey);
}

/** Holder presentation: issuer JWT, the chosen disclosures, and a key-binding JWT over nonce + audience. */
export async function presentSdJwt(issuerJwt: string, disclosures: readonly string[], holderPrivateKey: Uint8Array, aud: string, nonce: string, now = Date.now()): Promise<string> {
  const sd = `${issuerJwt}~${disclosures.map((d) => `${d}~`).join('')}`;
  const sdHash = toBase64Url(await sha256(utf8(sd)));
  const kb = await signJwt({ typ: 'kb+jwt' }, { iat: Math.floor(now / 1000), aud, nonce, sd_hash: sdHash }, holderPrivateKey);
  return `${sd}${kb}`;
}

export type PresentationState =
  | 'verified'             // issuer signature, digests, key binding, nonce and validity all hold
  | 'self-asserted'        // all of the above, but the issuer is the holder
  | 'bad-issuer-signature'
  | 'unknown-issuer-key'   // issuer is not a did:key this module can resolve
  | 'digest-mismatch'      // a disclosure the issuer did not sign
  | 'bad-key-binding'      // missing, wrong key, or sd_hash mismatch
  | 'nonce-mismatch'       // answers another request or audience
  | 'expired'
  | 'revoked'
  | 'malformed';

export interface PresentationResult {
  state: PresentationState;
  issuer?: string;
  subject?: string;
  evidence?: { level: EvidenceLevel; method: string; bindingTxId?: string };
  claims: Record<string, unknown>;
  /** sha256 of the issuer JWT: what an attestation revocation names. */
  attestationId?: string;
  because: string;
}

export async function attestationIdOf(issuerJwt: string): Promise<string> {
  return toBase64Url(await sha256(utf8(issuerJwt)));
}

export async function verifyPresentation(presentation: string, expect: { aud: string; nonce: string; now?: number; maxAgeSec?: number; revokedAttestations?: ReadonlySet<string> }): Promise<PresentationResult> {
  const fail = (state: PresentationState, because: string, extra: Partial<PresentationResult> = {}): PresentationResult => ({ state, claims: {}, because, ...extra });
  const parts = presentation.split('~');
  if (parts.length < 2) return fail('malformed', 'not an SD-JWT presentation');
  const issuerJwt = parts[0]; const kbJwt = parts[parts.length - 1]; const encoded = parts.slice(1, -1).filter(Boolean);
  let unverified: Record<string, unknown>;
  try { unverified = unjson<Record<string, unknown>>(issuerJwt.split('.')[1]); } catch { return fail('malformed', 'issuer JWT unreadable'); }
  const issuer = typeof unverified.iss === 'string' ? unverified.iss : '';
  const issuerKey = parseDidKey(issuer);
  if (!issuerKey || issuerKey.algorithm !== 'secp256k1') return fail('unknown-issuer-key', `issuer ${issuer || '(none)'} is not a secp256k1 did:key`);
  const signed = await verifyJwt(issuerJwt, issuerKey.publicKeyHex);
  if (!signed) return fail('bad-issuer-signature', 'issuer signature does not verify');
  const p = signed.payload;
  const subject = String(p.sub ?? '');
  const attestationId = await attestationIdOf(issuerJwt);
  const base = { issuer, subject, evidence: p.evidence as PresentationResult['evidence'], attestationId };
  const now = Math.floor((expect.now ?? Date.now()) / 1000);
  if (typeof p.exp === 'number' && p.exp <= now) return fail('expired', 'attestation expired', base);
  if (expect.revokedAttestations?.has(attestationId)) return fail('revoked', 'the issuer revoked this attestation', base);
  const sd = new Set(Array.isArray(p._sd) ? (p._sd as string[]) : []);
  const claims: Record<string, unknown> = {};
  for (const e of encoded) {
    const d = await decodeDisclosure(e);
    if (!d || !sd.has(d.digest)) return fail('digest-mismatch', `disclosure ${d?.name ?? '(unreadable)'} is not signed by the issuer`, base);
    claims[d.name] = d.value;
  }
  const holderDid = (p.cnf as { kid?: string } | undefined)?.kid ?? subject;
  const holderKey = parseDidKey(holderDid);
  if (!holderKey) return fail('bad-key-binding', 'no holder key to bind the presentation', base);
  const kb = await verifyJwt(kbJwt, holderKey.publicKeyHex);
  if (!kb || kb.header.typ !== 'kb+jwt') return fail('bad-key-binding', 'key-binding JWT missing or not signed by the holder', base);
  const sdHash = toBase64Url(await sha256(utf8(presentation.slice(0, presentation.length - kbJwt.length))));
  if (kb.payload.sd_hash !== sdHash) return fail('bad-key-binding', 'key-binding JWT covers a different presentation', base);
  if (kb.payload.nonce !== expect.nonce || kb.payload.aud !== expect.aud) return fail('nonce-mismatch', 'presentation answers another request or audience', base);
  const iat = Number(kb.payload.iat);
  if (!Number.isFinite(iat) || Math.abs(now - iat) > (expect.maxAgeSec ?? 600)) return fail('nonce-mismatch', 'key-binding JWT is stale', base);
  const self = issuer === holderDid;
  return { state: self ? 'self-asserted' : 'verified', ...base, claims, because: self ? 'holder-signed claims: integrity and binding hold, no third party vouches for the values' : `issuer ${issuer.slice(0, 24)}… vouches at ${base.evidence?.level ?? 'unstated'} level` };
}
