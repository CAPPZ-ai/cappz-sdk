/**
 * COPE node crystallized.
 * Node ID: v15-16-00-webauthn-attestation
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * Registration (attestation) verification, WebAuthn Level 3 §8: did a vendor's
 * secure hardware make this passkey? Formats: none, packed (full and self),
 * apple (anonymous), android-key (Keystore / StrongBox) and tpm (Windows
 * Hello). Two answers, kept apart:
 *
 *   check  the statement itself — signatures, nonces, key bindings, TPM
 *          structures — is valid ('valid') or what failed
 *   trust  how far it anchors: 'chain' (to a pinned root: Apple, Google, or
 *          roots the caller passes), 'unanchored' (consistent, no known root),
 *          'self' (signed by the credential key only), 'none' (no attestation)
 *
 * Callers that need hardware proof require trust === 'chain'. Synced passkeys
 * (iCloud Keychain, Google Password Manager) usually send 'none' — they are
 * still hardware-backed on each device, but nothing proves it to a verifier.
 */
import { cborGet, decodeCbor, type CborValue } from './cbor';
import { buf, fromBase64Url, sha256, toHex, utf8 } from './canonical';
import { APPLE_WEBAUTHN_ROOTS, GOOGLE_HARDWARE_ATTESTATION_ROOTS } from './attestationRoots';
import { verifyEs256, parseAuthenticatorData, type AuthenticatorData } from './webauthn';
import { certificatesFromPem, derChildren, derRead, emptyName, inspectCertificate, oidText, verifyChain, verifyWithSpki, OIDS, type CertDetail } from './x509Chain';

export type AttestationCheck =
  | 'valid' | 'malformed' | 'unsupported-format' | 'unsupported-key'
  | 'wrong-type' | 'wrong-challenge' | 'wrong-origin' | 'wrong-rp' | 'user-not-present' | 'user-not-verified'
  | 'bad-signature' | 'bad-certificate' | 'key-mismatch' | 'nonce-mismatch' | 'aaguid-mismatch';

export type AttestationTrust = 'chain' | 'unanchored' | 'self' | 'none';

export interface AttestationResult {
  check: AttestationCheck;
  format: string;
  trust: AttestationTrust;
  because: string;
  credentialId?: string;
  /** SEC1 P-256 key (hex) for ES256 credentials; usable for KeyZ 'signing' declarations. */
  publicKey?: string;
  /** COSE algorithm of the credential key. */
  credentialAlgorithm?: number;
  aaguid?: string;
  /** SHA-256 of the root the chain ended at. */
  anchor?: string;
  /** android-key: where the key lives. */
  securityLevel?: 'software' | 'tee' | 'strongbox';
  userVerified?: boolean;
}

export interface RegistrationExpectations {
  challenge: Uint8Array;
  rpId: string;
  origins: readonly string[];
  requireUserVerification?: boolean;
  /** Extra anchors (PEM). Apple and Google roots are built in; TPM and FIDO roots are not. */
  roots?: { apple?: string[]; androidKey?: string[]; tpm?: string[]; packed?: string[] };
  now?: Date;
}

const OID_EXT = {
  fidoAaguid: '1.3.6.1.4.1.45724.1.1.4',
  appleNonce: '1.2.840.113635.100.8.2',
  androidKeyDescription: '1.3.6.1.4.1.11129.2.1.17',
  tcgKpAikCertificate: '2.23.133.8.3',
};
const HASH_FOR_ALG: Record<number, string> = { [-7]: 'SHA-256', [-35]: 'SHA-384', [-36]: 'SHA-512', [-257]: 'SHA-256', [-258]: 'SHA-384', [-259]: 'SHA-512', [-65535]: 'SHA-1' };
const TPM_HASH: Record<number, string> = { 0x0004: 'SHA-1', 0x000b: 'SHA-256', 0x000c: 'SHA-384', 0x000d: 'SHA-512' };
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const digest = async (name: string, data: Uint8Array) => new Uint8Array(await crypto.subtle.digest(name, buf(data)));

type CredentialKey =
  | { kind: 'ec2'; alg: number; crv: number; x: Uint8Array; y: Uint8Array }
  | { kind: 'rsa'; alg: number; n: Uint8Array; e: Uint8Array };

function credentialKey(cose: Map<CborValue, CborValue>): CredentialKey | null {
  const kty = cborGet(cose, 1), alg = cborGet(cose, 3);
  if (typeof alg !== 'number') return null;
  if (kty === 2) {
    const crv = cborGet(cose, -1), x = cborGet(cose, -2), y = cborGet(cose, -3);
    if (typeof crv !== 'number' || !(x instanceof Uint8Array) || !(y instanceof Uint8Array)) return null;
    return { kind: 'ec2', alg, crv, x, y };
  }
  if (kty === 3) {
    const n = cborGet(cose, -1), e = cborGet(cose, -2);
    if (!(n instanceof Uint8Array) || !(e instanceof Uint8Array)) return null;
    return { kind: 'rsa', alg, n, e };
  }
  return null;
}
const ecPoint = (k: CredentialKey) => (k.kind === 'ec2' ? Uint8Array.from([0x04, ...k.x, ...k.y]) : null);

/** The fido-gen-ce-aaguid extension, when present, must name the authenticator's AAGUID. */
function aaguidMatches(cert: CertDetail, aaguid: string): boolean {
  const ext = cert.extensions.get(OID_EXT.fidoAaguid);
  if (!ext) return true;
  const inner = derRead(ext.value, 0);
  return inner.tag === 0x04 && toHex(ext.value.subarray(inner.start, inner.end)) === aaguid;
}

async function anchorChain(certs: CertDetail[], rootPems: readonly string[], now: Date): Promise<{ trust: AttestationTrust; anchor?: string; because: string } | { fail: string }> {
  const anchors = await certificatesFromPem(rootPems);
  const r = await verifyChain(certs, anchors, now);
  if (r.ok) return { trust: 'chain', anchor: r.anchor, because: r.because };
  if (r.because === 'no roots to anchor to' || r.because === 'chain does not end at a pinned root') return { trust: 'unanchored', because: r.because };
  return { fail: r.because };
}

/** Verify a registration response. Never throws on attacker-supplied input. */
export async function verifyRegistration(
  response: { attestationObject: string; clientDataJSON: string },
  e: RegistrationExpectations,
): Promise<AttestationResult> {
  const now = e.now ?? new Date();
  let fmt = 'unknown';
  const fail = (check: AttestationCheck, because: string, extra: Partial<AttestationResult> = {}): AttestationResult => ({ check, format: fmt, trust: 'none', because, ...extra });
  let att: CborValue, clientDataBytes: Uint8Array, clientData: Record<string, unknown>, authDataBytes: Uint8Array, ad: AuthenticatorData;
  try {
    att = decodeCbor(fromBase64Url(response.attestationObject));
    clientDataBytes = fromBase64Url(response.clientDataJSON);
    clientData = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(clientDataBytes));
    const f = cborGet(att, 'fmt'), a = cborGet(att, 'authData');
    if (typeof f !== 'string' || !(a instanceof Uint8Array) || !(cborGet(att, 'attStmt') instanceof Map)) return fail('malformed', 'attestation object is not {fmt, attStmt, authData}');
    fmt = f;
    authDataBytes = a;
    ad = parseAuthenticatorData(authDataBytes);
  } catch (err) {
    return fail('malformed', err instanceof Error ? err.message : 'unreadable registration');
  }
  if (clientData.type !== 'webauthn.create') return fail('wrong-type', 'client data is not webauthn.create');
  if (typeof clientData.challenge !== 'string' || !same(fromBase64Url(clientData.challenge), e.challenge)) return fail('wrong-challenge', 'challenge differs');
  if (typeof clientData.origin !== 'string' || !e.origins.includes(clientData.origin) || clientData.crossOrigin === true) return fail('wrong-origin', `origin ${String(clientData.origin)} not allowed`);
  if (!same(ad.rpIdHash, await sha256(utf8(e.rpId)))) return fail('wrong-rp', 'RP ID hash differs');
  if (!ad.flags.userPresent) return fail('user-not-present', 'UP flag not set');
  if ((e.requireUserVerification ?? true) && !ad.flags.userVerified) return fail('user-not-verified', 'UV flag not set');
  if (!ad.credential) return fail('malformed', 'no attested credential data');
  const key = credentialKey(ad.credential.publicKey);
  if (!key) return fail('unsupported-key', 'credential key is not EC2 or RSA');
  const aaguid = ad.credential.aaguid;
  const base: Partial<AttestationResult> = {
    credentialId: toHexBase64Url(ad.credential.credentialId), credentialAlgorithm: key.alg, aaguid, userVerified: ad.flags.userVerified,
    publicKey: key.kind === 'ec2' && key.alg === -7 && key.crv === 1 && key.x.length === 32 && key.y.length === 32 ? toHex(ecPoint(key)!) : undefined,
  };
  const ok = (trust: AttestationTrust, because: string, extra: Partial<AttestationResult> = {}): AttestationResult => ({ check: 'valid', format: fmt, trust, because, ...base, ...extra });
  const clientDataHash = await sha256(clientDataBytes);
  const signed = Uint8Array.from([...authDataBytes, ...clientDataHash]);
  const stmt = cborGet(att, 'attStmt') as Map<CborValue, CborValue>;

  try {
    const x5c = cborGet(stmt, 'x5c');
    const certs = Array.isArray(x5c) ? await Promise.all(x5c.map((c) => { if (!(c instanceof Uint8Array)) throw new Error('x5c entry is not bytes'); return inspectCertificate(c); })) : null;
    const alg = cborGet(stmt, 'alg');
    const sig = cborGet(stmt, 'sig');

    switch (fmt) {
      case 'none':
        return stmt.size === 0 ? ok('none', 'no attestation') : fail('malformed', 'none format with a statement');

      case 'packed': {
        if (typeof alg !== 'number' || !(sig instanceof Uint8Array)) return fail('malformed', 'packed statement needs alg and sig', base);
        if (!certs) {
          // Self attestation: the credential key signs its own registration.
          if (alg !== key.alg || !base.publicKey) return fail('unsupported-key', 'self attestation is checked for ES256 credentials', base);
          return (await verifyEs256(base.publicKey, signed, sig)) ? ok('self', 'self attestation: signed by the credential key') : fail('bad-signature', 'self attestation signature invalid', base);
        }
        const leaf = certs[0];
        const hash = HASH_FOR_ALG[alg];
        if (!hash || !(await verifyWithSpki(leaf.spki, leaf.keyAlgorithmOid, leaf.keyParameterOid, hash, sig, signed))) return fail('bad-signature', 'attestation signature invalid', base);
        if (leaf.version !== 3 || leaf.isCA === true) return fail('bad-certificate', 'attestation certificate must be v3 and not a CA', base);
        if (!aaguidMatches(leaf, aaguid)) return fail('aaguid-mismatch', 'certificate AAGUID differs from the authenticator', base);
        const a = await anchorChain(certs, e.roots?.packed ?? [], now);
        return 'fail' in a ? fail('bad-certificate', a.fail, base) : ok(a.trust, a.because, { anchor: a.anchor });
      }

      case 'apple': {
        if (!certs?.length) return fail('malformed', 'apple statement needs x5c', base);
        const leaf = certs[0];
        const ext = leaf.extensions.get(OID_EXT.appleNonce);
        if (!ext) return fail('bad-certificate', 'no Apple nonce extension', base);
        // SEQUENCE { [1] EXPLICIT OCTET STRING nonce }
        const seq = derRead(ext.value, 0);
        const tagged = derChildren(ext.value, seq).find((n) => n.cls === 2 && n.tag === 1);
        const oct = tagged ? derRead(ext.value, tagged.start, tagged.end) : null;
        const nonce = await sha256(signed);
        if (!oct || oct.tag !== 0x04 || !same(ext.value.subarray(oct.start, oct.end), nonce)) return fail('nonce-mismatch', 'certificate nonce does not match this registration', base);
        const point = ecPoint(key);
        if (!point || !same(leaf.publicKey, point)) return fail('key-mismatch', 'certificate key is not the credential key', base);
        const a = await anchorChain(certs, [...APPLE_WEBAUTHN_ROOTS.map((r) => r.pem), ...(e.roots?.apple ?? [])], now);
        return 'fail' in a ? fail('bad-certificate', a.fail, base) : ok(a.trust, a.because, { anchor: a.anchor });
      }

      case 'android-key': {
        if (typeof alg !== 'number' || !(sig instanceof Uint8Array) || !certs?.length) return fail('malformed', 'android-key statement needs alg, sig and x5c', base);
        const leaf = certs[0];
        const hash = HASH_FOR_ALG[alg];
        if (!hash || !(await verifyWithSpki(leaf.spki, leaf.keyAlgorithmOid, leaf.keyParameterOid, hash, sig, signed))) return fail('bad-signature', 'attestation signature invalid', base);
        const point = ecPoint(key);
        if (!point || !same(leaf.publicKey, point)) return fail('key-mismatch', 'certificate key is not the credential key', base);
        const kd = androidKeyDescription(leaf);
        if (!kd) return fail('bad-certificate', 'no Android key description', base);
        if (!same(kd.challenge, clientDataHash)) return fail('nonce-mismatch', 'attestation challenge is not this registration', base);
        if (kd.allApplications) return fail('bad-certificate', 'key is usable by all applications', base);
        const a = await anchorChain(certs, [...GOOGLE_HARDWARE_ATTESTATION_ROOTS.map((r) => r.pem), ...(e.roots?.androidKey ?? [])], now);
        return 'fail' in a ? fail('bad-certificate', a.fail, base) : ok(a.trust, a.because, { anchor: a.anchor, securityLevel: kd.securityLevel });
      }

      case 'tpm': {
        const ver = cborGet(stmt, 'ver'), certInfo = cborGet(stmt, 'certInfo'), pubArea = cborGet(stmt, 'pubArea');
        if (ver !== '2.0' || typeof alg !== 'number' || !(sig instanceof Uint8Array) || !(certInfo instanceof Uint8Array) || !(pubArea instanceof Uint8Array) || !certs?.length) {
          return fail('malformed', 'tpm statement needs ver 2.0, alg, sig, certInfo, pubArea and x5c', base);
        }
        const pa = parsePubArea(pubArea);
        if (!pubAreaMatches(pa, key)) return fail('key-mismatch', 'TPM public area is not the credential key', base);
        const ci = parseCertInfo(certInfo);
        if (ci.magic !== 0xff544347 || ci.type !== 0x8017) return fail('malformed', 'certInfo is not a TPM_ST_ATTEST_CERTIFY', base);
        const hash = HASH_FOR_ALG[alg];
        if (!hash || !same(ci.extraData, await digest(hash, signed))) return fail('nonce-mismatch', 'certInfo extraData is not this registration', base);
        const nameHash = TPM_HASH[ci.nameAlg];
        if (!nameHash || ci.nameAlg !== pa.nameAlg || !same(ci.nameDigest, await digest(nameHash, pubArea))) return fail('key-mismatch', 'certInfo does not name this public area', base);
        const aik = certs[0];
        if (!(await verifyWithSpki(aik.spki, aik.keyAlgorithmOid, aik.keyParameterOid, hash, sig, certInfo))) return fail('bad-signature', 'AIK signature over certInfo invalid', base);
        if (aik.version !== 3 || !emptyName(aik.subject) || aik.isCA === true || !aik.extensions.has(OIDS.subjectAltName)) return fail('bad-certificate', 'AIK certificate must be v3, empty subject, not a CA, with a SAN', base);
        if (!extendedKeyUsages(aik).includes(OID_EXT.tcgKpAikCertificate)) return fail('bad-certificate', 'AIK certificate lacks tcg-kp-AIKCertificate', base);
        if (!aaguidMatches(aik, aaguid)) return fail('aaguid-mismatch', 'certificate AAGUID differs from the authenticator', base);
        const a = await anchorChain(certs, e.roots?.tpm ?? [], now);
        return 'fail' in a ? fail('bad-certificate', a.fail, base) : ok(a.trust, a.because, { anchor: a.anchor });
      }

      default:
        return fail('unsupported-format', `format ${fmt} is not verified`, base);
    }
  } catch (err) {
    return fail('malformed', err instanceof Error ? err.message : 'unreadable attestation statement', base);
  }
}

function toHexBase64Url(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function extendedKeyUsages(c: CertDetail): string[] {
  const ext = c.extensions.get(OIDS.extKeyUsage);
  if (!ext) return [];
  return derChildren(ext.value, derRead(ext.value, 0)).map((n) => oidText(ext.value.subarray(n.start, n.end)));
}

/** KeyDescription (Android key attestation): challenge, security level, allApplications. */
function androidKeyDescription(c: CertDetail): { challenge: Uint8Array; securityLevel: 'software' | 'tee' | 'strongbox'; allApplications: boolean } | null {
  const ext = c.extensions.get(OID_EXT.androidKeyDescription);
  if (!ext) return null;
  const v = ext.value;
  const f = derChildren(v, derRead(v, 0));
  if (f.length < 8 || f[1].tag !== 0x0a || f[4].tag !== 0x04) return null;
  const level = v[f[1].end - 1];
  const hasAllApps = (list: (typeof f)[number]) => derChildren(v, list).some((n) => n.cls === 2 && n.tag === 600);
  return {
    challenge: v.slice(f[4].start, f[4].end),
    securityLevel: level === 2 ? 'strongbox' : level === 1 ? 'tee' : 'software',
    allApplications: hasAllApps(f[6]) || hasAllApps(f[7]),
  };
}

interface PubArea { type: number; nameAlg: number; curveId?: number; exponent?: number; unique: Uint8Array; uniqueY?: Uint8Array }

function reader(b: Uint8Array) {
  let at = 0;
  const need = (n: number) => { if (at + n > b.length) throw new Error('tpm: truncated structure'); };
  return {
    u16: () => { need(2); const v = (b[at] << 8) | b[at + 1]; at += 2; return v; },
    u32: () => { need(4); const v = ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3]; at += 4; return v; },
    bytes: (n: number) => { need(n); const v = b.slice(at, at + n); at += n; return v; },
    sized: () => { need(2); const n = (b[at] << 8) | b[at + 1]; at += 2; need(n); const v = b.slice(at, at + n); at += n; return v; },
    done: () => at === b.length,
  };
}

function parsePubArea(b: Uint8Array): PubArea {
  const r = reader(b);
  const type = r.u16(), nameAlg = r.u16();
  r.u32(); // objectAttributes
  r.sized(); // authPolicy
  if (type === 0x0001) {
    r.u16(); r.u16(); // symmetric, scheme
    r.u16(); // keyBits
    const exponent = r.u32();
    const unique = r.sized();
    if (!r.done()) throw new Error('tpm: trailing bytes in pubArea');
    return { type, nameAlg, exponent, unique };
  }
  if (type === 0x0023) {
    r.u16(); r.u16(); // symmetric, scheme
    const curveId = r.u16();
    r.u16(); // kdf
    const unique = r.sized(), uniqueY = r.sized();
    if (!r.done()) throw new Error('tpm: trailing bytes in pubArea');
    return { type, nameAlg, curveId, unique, uniqueY };
  }
  throw new Error('tpm: unsupported public area type');
}

function pubAreaMatches(pa: PubArea, key: CredentialKey): boolean {
  if (pa.type === 0x0001 && key.kind === 'rsa') {
    const e = key.e.reduce((n, x) => n * 256 + x, 0);
    return same(pa.unique, key.n) && (pa.exponent === 0 ? 65537 : pa.exponent) === e;
  }
  if (pa.type === 0x0023 && key.kind === 'ec2') {
    const crv = { 3: 1, 4: 2, 5: 3 }[pa.curveId as 3 | 4 | 5];
    return crv === key.crv && same(pa.unique, key.x) && !!pa.uniqueY && same(pa.uniqueY, key.y);
  }
  return false;
}

function parseCertInfo(b: Uint8Array): { magic: number; type: number; extraData: Uint8Array; nameAlg: number; nameDigest: Uint8Array } {
  const r = reader(b);
  const magic = r.u32(), type = r.u16();
  r.sized(); // qualifiedSigner
  const extraData = r.sized();
  r.bytes(17); // clockInfo
  r.bytes(8); // firmwareVersion
  const name = r.sized();
  r.sized(); // qualifiedName
  if (!r.done() || name.length < 2) throw new Error('tpm: malformed certInfo');
  return { magic, type, extraData, nameAlg: (name[0] << 8) | name[1], nameDigest: name.slice(2) };
}

export { APPLE_WEBAUTHN_ROOTS, GOOGLE_HARDWARE_ATTESTATION_ROOTS };
export type { CertDetail };
