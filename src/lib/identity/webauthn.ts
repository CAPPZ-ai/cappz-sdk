/**
 * COPE node crystallized.
 * Node ID: v15-16-00-webauthn
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * WebAuthn without a server: what CAPPZ needs to use platform authenticators
 * (Secure Enclave, Android TEE/StrongBox, Windows TPM) as hardware key holders
 * and to check what they sign, offline.
 *
 *   - a port to navigator.credentials, replaceable in tests and native shells
 *   - authenticator data and COSE key parsing (strict)
 *   - assertion verification: type, challenge, origin allowlist, RP ID hash,
 *     user presence / verification flags, then the ES256 signature
 *
 * Every check reports what failed rather than a bare boolean.
 */
import { p256 } from '@noble/curves/p256';
import { cborGet, decodeCbor, decodeCborPrefix, type CborValue } from './cbor';
import { buf, fromBase64Url, fromHex, sha256, toBase64Url, toHex, utf8 } from './canonical';

// ─── Port ───────────────────────────────────────────────────────────────

export interface WebAuthnPort {
  create(options: PublicKeyCredentialCreationOptions): Promise<PublicKeyCredential | null>;
  get(options: PublicKeyCredentialRequestOptions): Promise<PublicKeyCredential | null>;
}

/** The browser's authenticators, or null where WebAuthn is unavailable. */
export function browserWebAuthn(): WebAuthnPort | null {
  const c = (globalThis as { navigator?: { credentials?: CredentialsContainer } }).navigator?.credentials;
  if (!c || typeof (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential === 'undefined') return null;
  return {
    create: async (publicKey) => (await c.create({ publicKey })) as PublicKeyCredential | null,
    get: async (publicKey) => (await c.get({ publicKey })) as PublicKeyCredential | null,
  };
}

// ─── Authenticator data ─────────────────────────────────────────────────

export interface AuthenticatorData {
  rpIdHash: Uint8Array;
  flags: { userPresent: boolean; userVerified: boolean; backupEligible: boolean; backedUp: boolean; attestedCredentialData: boolean; extensionData: boolean };
  signCount: number;
  /** Present when a credential was just created. */
  credential?: { aaguid: string; credentialId: Uint8Array; publicKey: Map<CborValue, CborValue> };
  extensions?: CborValue;
}

export function parseAuthenticatorData(b: Uint8Array): AuthenticatorData {
  if (b.length < 37) throw new Error('webauthn: authenticator data too short');
  const f = b[32];
  const flags = {
    userPresent: (f & 0x01) !== 0, userVerified: (f & 0x04) !== 0, backupEligible: (f & 0x08) !== 0,
    backedUp: (f & 0x10) !== 0, attestedCredentialData: (f & 0x40) !== 0, extensionData: (f & 0x80) !== 0,
  };
  const out: AuthenticatorData = { rpIdHash: b.slice(0, 32), flags, signCount: ((b[33] << 24) >>> 0) + (b[34] << 16) + (b[35] << 8) + b[36] };
  let at = 37;
  if (flags.attestedCredentialData) {
    if (b.length < at + 18) throw new Error('webauthn: attested credential data truncated');
    const aaguid = toHex(b.subarray(at, at + 16)); at += 16;
    const idLen = (b[at] << 8) | b[at + 1]; at += 2;
    if (idLen > 1023 || b.length < at + idLen) throw new Error('webauthn: credential id truncated or too long');
    const credentialId = b.slice(at, at + idLen); at += idLen;
    const { value, used } = decodeCborPrefix(b.subarray(at));
    if (!(value instanceof Map)) throw new Error('webauthn: credential public key is not a COSE map');
    at += used;
    out.credential = { aaguid, credentialId, publicKey: value };
  }
  if (flags.extensionData) {
    out.extensions = decodeCbor(b.subarray(at));
    at = b.length;
  }
  if (at !== b.length) throw new Error('webauthn: trailing bytes in authenticator data');
  return out;
}

/** COSE EC2 / ES256 / P-256 key → SEC1 uncompressed point (hex). Other key types are refused. */
export function coseKeyToP256(cose: Map<CborValue, CborValue>): string {
  const kty = cborGet(cose, 1), alg = cborGet(cose, 3), crv = cborGet(cose, -1), x = cborGet(cose, -2), y = cborGet(cose, -3);
  if (kty !== 2 || alg !== -7 || crv !== 1 || !(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) {
    throw new Error('webauthn: only ES256 (P-256) credential keys are accepted');
  }
  const point = new Uint8Array(65); point[0] = 0x04; point.set(x, 1); point.set(y, 33);
  p256.ProjectivePoint.fromHex(point).assertValidity();
  return toHex(point);
}

/** Strict DER ECDSA signature → r||s. Minimal positive INTEGERs, no trailing bytes. */
export function ecdsaDerToRaw(der: Uint8Array, size = 32): Uint8Array {
  const fail = () => { throw new Error('webauthn: malformed DER signature'); };
  if (der.length < 8 || der[0] !== 0x30 || der[1] !== der.length - 2 || der[1] > 0x7f) fail();
  let at = 2;
  const int = (): Uint8Array => {
    if (der[at] !== 0x02) fail();
    const len = der[at + 1];
    if (len < 1 || len > size + 1 || at + 2 + len > der.length) fail();
    const v = der.subarray(at + 2, at + 2 + len);
    if (v[0] & 0x80) fail();                                   // negative
    if (len > 1 && v[0] === 0 && !(v[1] & 0x80)) fail();       // non-minimal
    at += 2 + len;
    const t = v[0] === 0 ? v.subarray(1) : v;
    if (t.length > size) fail();
    const out = new Uint8Array(size); out.set(t, size - t.length);
    return out;
  };
  const r = int(), s = int();
  if (at !== der.length) fail();
  const raw = new Uint8Array(2 * size); raw.set(r); raw.set(s, size);
  return raw;
}

/** Any SEC1 P-256 point (compressed or not) → uncompressed bytes; throws if it is not on the curve. */
export function p256Uncompressed(publicKeyHex: string): Uint8Array {
  return p256.ProjectivePoint.fromHex(publicKeyHex.toLowerCase()).toRawBytes(false);
}

/** ES256 over `message`: raw r||s (64 bytes) or DER. */
export async function verifyEs256(publicKeyHex: string, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  try {
    const raw = signature.length === 64 ? signature : ecdsaDerToRaw(signature);
    const key = await crypto.subtle.importKey('raw', buf(p256Uncompressed(publicKeyHex)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, buf(raw), buf(message));
  } catch {
    return false;
  }
}

// ─── Assertions ─────────────────────────────────────────────────────────

export type AssertionCheck =
  | 'valid' | 'bad-signature' | 'malformed'
  | 'wrong-type' | 'wrong-challenge' | 'wrong-origin' | 'wrong-rp'
  | 'user-not-present' | 'user-not-verified';

export interface WebAuthnAssertion {
  authenticatorData: string;   // base64url
  clientDataJSON: string;      // base64url
  signature: string;           // base64url, DER
}

export interface AssertionExpectations {
  /** SEC1 P-256 public key of the credential (hex). */
  publicKey: string;
  challenge: Uint8Array;
  rpId: string;
  /** Exact origins the assertion may come from, e.g. ['https://cappz.ai']. */
  origins: readonly string[];
  /** Require the UV flag (biometric / PIN). Default true. */
  requireUserVerification?: boolean;
}

export async function verifyWebAuthnAssertion(a: WebAuthnAssertion, e: AssertionExpectations): Promise<{ check: AssertionCheck; userVerified: boolean; signCount: number }> {
  let authData: Uint8Array, clientDataBytes: Uint8Array, sig: Uint8Array, parsed: AuthenticatorData;
  let clientData: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    authData = fromBase64Url(a.authenticatorData);
    clientDataBytes = fromBase64Url(a.clientDataJSON);
    sig = fromBase64Url(a.signature);
    parsed = parseAuthenticatorData(authData);
    clientData = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(clientDataBytes));
  } catch {
    return { check: 'malformed', userVerified: false, signCount: 0 };
  }
  const result = (check: AssertionCheck) => ({ check, userVerified: parsed.flags.userVerified, signCount: parsed.signCount });
  if (clientData.type !== 'webauthn.get') return result('wrong-type');
  if (clientData.challenge !== toBase64Url(e.challenge)) return result('wrong-challenge');
  if (typeof clientData.origin !== 'string' || !e.origins.includes(clientData.origin) || clientData.crossOrigin === true) return result('wrong-origin');
  if (toHex(parsed.rpIdHash) !== toHex(await sha256(utf8(e.rpId)))) return result('wrong-rp');
  if (!parsed.flags.userPresent) return result('user-not-present');
  if ((e.requireUserVerification ?? true) && !parsed.flags.userVerified) return result('user-not-verified');
  const signed = new Uint8Array(authData.length + 32);
  signed.set(authData);
  signed.set(await sha256(clientDataBytes), authData.length);
  return result((await verifyEs256(e.publicKey, signed, sig)) ? 'valid' : 'bad-signature');
}

export { fromBase64Url, toBase64Url, fromHex, toHex };
