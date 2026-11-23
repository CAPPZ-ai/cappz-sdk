/**
 * COPE node crystallized. Node ID: v15-00-01-sealed-box.
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Sealed box: encrypt to a recipient's public key so only the holder of the private key can open it.
 * Used for HARVEST survey contributions, marketplace access-key delivery, identity disclosures,
 * mesh bundles and wallet envelopes.
 *
 * v16-02-00 (post-quantum): a box key may carry an ML-KEM-768 half (FIPS 203) beside its P-256 half.
 * Sealing to such a key is hybrid: an ephemeral P-256 ECDH secret AND an ML-KEM-768 encapsulated
 * secret both feed HKDF-SHA-256, bound to the ephemeral key, the KEM ciphertext and the recipient's
 * keys, then AES-GCM 256. Recorded ciphertext stays closed unless BOTH are broken, so a future quantum
 * computer (which breaks P-256) does not open what is recorded today. A key without the ML-KEM half
 * still gets the classical box, and every box records its scheme, so old keys and old boxes keep
 * working: `generateBoxKeyPair` makes hybrid keys, `upgradeBoxKeyPair` adds the ML-KEM half to an
 * existing P-256 pair without changing it (boxes already sealed to it still open).
 */
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';

export const CLASSIC_BOX_SCHEME = 'ECDH-P256-AES-GCM' as const;
export const HYBRID_BOX_SCHEME = 'ECDH-P256+ML-KEM-768-AES-GCM' as const;
export type BoxScheme = typeof CLASSIC_BOX_SCHEME | typeof HYBRID_BOX_SCHEME;

/** A box key JWK: the P-256 EC members, plus the ML-KEM-768 public key (and, private side, its 64-byte seed) as base64url. */
export type BoxJwk = JsonWebKey & { cappz_mlkem768?: string; cappz_mlkem768_seed?: string };

export type SealedBox =
  | { scheme: typeof CLASSIC_BOX_SCHEME; ephemeralPublicKey: JsonWebKey; iv: number[]; cipher: number[] }
  | { scheme: typeof HYBRID_BOX_SCHEME; ephemeralPublicKey: JsonWebKey; kemCipherText: string; iv: number[]; cipher: number[] };

const b64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64u = (u: Uint8Array) => b64(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) => unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
const bytesOfHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const hexOfBytes = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const enc = new TextEncoder();

const P256_POINT_BYTES = 65;
/** ML-KEM-768 public key length (FIPS 203). */
export const MLKEM768_PUBLIC_KEY_BYTES = 1184;

/** The EC members only: what WebCrypto imports. */
function ecOnly(jwk: JsonWebKey): JsonWebKey {
  const { kty, crv, x, y, d } = jwk;
  return d ? { kty, crv, x, y, d, ext: true } : { kty, crv, x, y, ext: true };
}

export function isHybridBoxKey(jwk: JsonWebKey | null | undefined): boolean {
  return !!jwk && typeof (jwk as BoxJwk).cappz_mlkem768 === 'string';
}

function kemHalf(): { pub: string; seed: string } {
  const seed = crypto.getRandomValues(new Uint8Array(64));
  return { pub: b64u(ml_kem768.keygen(seed).publicKey), seed: b64u(seed) };
}

/** A new box key pair. Hybrid (P-256 + ML-KEM-768) unless `classic` is asked for. */
export async function generateBoxKeyPair(opts: { classic?: boolean } = {}): Promise<{ publicKey: BoxJwk; privateKey: BoxJwk }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
  const publicKey: BoxJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const privateKey: BoxJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  if (opts.classic) return { publicKey, privateKey };
  const k = kemHalf();
  return { publicKey: { ...publicKey, cappz_mlkem768: k.pub }, privateKey: { ...privateKey, cappz_mlkem768: k.pub, cappz_mlkem768_seed: k.seed } };
}

/** Add the ML-KEM-768 half to an existing P-256 pair (unchanged otherwise, so boxes already sealed to it still open). */
export function upgradeBoxKeyPair<P extends { publicKey: JsonWebKey; privateKey: JsonWebKey }>(pair: P): P & { publicKey: BoxJwk; privateKey: BoxJwk; upgraded: boolean } {
  if (isHybridBoxKey(pair.publicKey) && (pair.privateKey as BoxJwk).cappz_mlkem768_seed) return { ...pair, upgraded: false };
  const k = kemHalf();
  return { ...pair, publicKey: { ...pair.publicKey, cappz_mlkem768: k.pub }, privateKey: { ...pair.privateKey, cappz_mlkem768: k.pub, cappz_mlkem768_seed: k.seed }, upgraded: true };
}

async function ecdhBits(privateKey: CryptoKey, publicJwk: JsonWebKey): Promise<Uint8Array> {
  const pub = await crypto.subtle.importKey('jwk', ecOnly(publicJwk), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, privateKey, 256));
}

async function importEcdhPrivate(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', ecOnly(jwk), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey', 'deriveBits']);
}

async function classicKey(privateKey: CryptoKey, publicJwk: JsonWebKey): Promise<CryptoKey> {
  const pub = await crypto.subtle.importKey('jwk', ecOnly(publicJwk), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  return crypto.subtle.deriveKey({ name: 'ECDH', public: pub }, privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * The hybrid combiner: HKDF-SHA-256 over ecdh ‖ kem, salted by the scheme, with an info string that
 * binds the transcript (ephemeral point, KEM ciphertext, recipient P-256 point and ML-KEM key), so a
 * ciphertext or key swapped in transit derives a different key and fails to open.
 */
async function hybridKey(ecdh: Uint8Array, kem: Uint8Array, transcript: Uint8Array[]): Promise<CryptoKey> {
  const th = new Uint8Array(await crypto.subtle.digest('SHA-256', concat(...transcript) as BufferSource));
  const base = await crypto.subtle.importKey('raw', concat(ecdh, kem) as BufferSource, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(HYBRID_BOX_SCHEME), info: concat(enc.encode('cappz-sealed-box-v2:'), th) as BufferSource },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

function rawPoint(jwk: JsonWebKey): Uint8Array { return bytesOfHex(p256HexFromJwk(jwk)); }

/** Seal for a recipient key: hybrid when the key carries ML-KEM-768, classical otherwise. */
async function sealRaw(recipient: BoxJwk, plain: Uint8Array): Promise<{ scheme: BoxScheme; epkJwk: JsonWebKey; epkRaw: Uint8Array; kemCt?: Uint8Array; iv: Uint8Array; ct: Uint8Array }> {
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
  const epkJwk = await crypto.subtle.exportKey('jwk', eph.publicKey);
  const epkRaw = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(plain.byteLength); data.set(plain);
  if (!isHybridBoxKey(recipient)) {
    const key = await classicKey(eph.privateKey, recipient);
    return { scheme: CLASSIC_BOX_SCHEME, epkJwk, epkRaw, iv, ct: new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data)) };
  }
  const kemPub = unb64u(recipient.cappz_mlkem768!);
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(kemPub);
  const key = await hybridKey(await ecdhBits(eph.privateKey, recipient), sharedSecret, [epkRaw, cipherText, rawPoint(recipient), kemPub]);
  return { scheme: HYBRID_BOX_SCHEME, epkJwk, epkRaw, kemCt: cipherText, iv, ct: new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data)) };
}

async function openRaw(privateKey: BoxJwk, scheme: string, epkJwk: JsonWebKey, epkRaw: Uint8Array, kemCt: Uint8Array | undefined, iv: Uint8Array, ct: Uint8Array): Promise<Uint8Array> {
  const priv = await importEcdhPrivate(privateKey);
  if (scheme === CLASSIC_BOX_SCHEME) {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, await classicKey(priv, epkJwk), ct as BufferSource));
  }
  if (scheme !== HYBRID_BOX_SCHEME) throw new Error('unknown sealed box scheme');
  if (!privateKey.cappz_mlkem768_seed || !kemCt) throw new Error('this box is sealed post-quantum: the key has no ML-KEM-768 half');
  const kem = ml_kem768.keygen(unb64u(privateKey.cappz_mlkem768_seed));
  const shared = ml_kem768.decapsulate(kemCt, kem.secretKey);
  const key = await hybridKey(await ecdhBits(priv, epkJwk), shared, [epkRaw, kemCt, rawPoint(privateKey), kem.publicKey]);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, ct as BufferSource));
}

export async function sealTo(publicKey: JsonWebKey, data: unknown): Promise<SealedBox> {
  const r = await sealRaw(publicKey, enc.encode(JSON.stringify(data)));
  const base = { ephemeralPublicKey: r.epkJwk, iv: Array.from(r.iv), cipher: Array.from(r.ct) };
  return r.scheme === HYBRID_BOX_SCHEME ? { scheme: HYBRID_BOX_SCHEME, ...base, kemCipherText: b64u(r.kemCt!) } : { scheme: CLASSIC_BOX_SCHEME, ...base };
}

export async function openWith<T>(privateKey: JsonWebKey, sealed: SealedBox): Promise<T> {
  const epkRaw = rawPoint(sealed.ephemeralPublicKey);
  const kemCt = sealed.scheme === HYBRID_BOX_SCHEME ? unb64u(sealed.kemCipherText) : undefined;
  const raw = await openRaw(privateKey, sealed.scheme, sealed.ephemeralPublicKey, epkRaw, kemCt, new Uint8Array(sealed.iv), new Uint8Array(sealed.cipher));
  return JSON.parse(new TextDecoder().decode(raw)) as T;
}

/** Symmetric content encryption (AES-GCM 256) for content sold under a key; the key travels in a SealedBox. */
export interface ContentCipher { scheme: 'AES-GCM-256'; iv: number[]; cipher: string }

export async function newContentKey(): Promise<string> {
  const k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  return b64(new Uint8Array(await crypto.subtle.exportKey('raw', k)));
}
export async function encryptContent(keyB64: string, text: string): Promise<ContentCipher> {
  const key = await crypto.subtle.importKey('raw', unb64(keyB64), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { scheme: 'AES-GCM-256', iv: Array.from(iv), cipher: b64(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)))) };
}
export async function decryptContent(keyB64: string, c: ContentCipher): Promise<string> {
  const key = await crypto.subtle.importKey('raw', unb64(keyB64), 'AES-GCM', false, ['decrypt']);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(c.iv) }, key, unb64(c.cipher)));
}

/**
 * v15-13-00: the same sealed box over bytes, in a compact base64url form for links measured in bytes
 * (mesh bundles over BLE or LoRa fragments): the number-array form above costs about four bytes per
 * ciphertext byte. The recipient key is a declared encryption key (KeyDeclaration purpose
 * 'encryption'): algorithm 'p256' is a SEC1 uncompressed point as hex; algorithm 'p256+ml-kem-768'
 * (v16-02-00) is that point followed by the 1184-byte ML-KEM-768 public key, and seals hybrid (the
 * box grows by the 1088-byte KEM ciphertext).
 */
export type CompactSealedBox =
  | { scheme: typeof CLASSIC_BOX_SCHEME; epk: string; iv: string; ct: string }
  | { scheme: typeof HYBRID_BOX_SCHEME; epk: string; kct: string; iv: string; ct: string };

/** SEC1 uncompressed P-256 point (hex, 04‖x‖y) → public JWK; a hybrid key hex (point ‖ ML-KEM-768 key) gives a hybrid JWK. */
export function p256JwkFromHex(pointHex: string): BoxJwk {
  const all = bytesOfHex(pointHex);
  const p = all.slice(0, P256_POINT_BYTES);
  if (p.length !== P256_POINT_BYTES || p[0] !== 4) throw new Error('not an uncompressed P-256 point');
  const jwk: BoxJwk = { kty: 'EC', crv: 'P-256', x: b64u(p.slice(1, 33)), y: b64u(p.slice(33)), ext: true };
  if (all.length === P256_POINT_BYTES) return jwk;
  if (all.length !== P256_POINT_BYTES + MLKEM768_PUBLIC_KEY_BYTES) throw new Error('not a P-256 or P-256+ML-KEM-768 key');
  return { ...jwk, cappz_mlkem768: b64u(all.slice(P256_POINT_BYTES)) };
}

/** Public JWK → SEC1 uncompressed point hex (the P-256 half only). */
export function p256HexFromJwk(jwk: JsonWebKey): string {
  if (jwk.crv !== 'P-256' || !jwk.x || !jwk.y) throw new Error('not a P-256 JWK');
  return '04' + hexOfBytes(unb64u(jwk.x)) + hexOfBytes(unb64u(jwk.y));
}

/** Public JWK → the key a KeyDeclaration carries: the point, or point ‖ ML-KEM-768 key for a hybrid key. */
export function boxPublicKeyHex(jwk: JsonWebKey): { publicKey: string; algorithm: 'p256' | 'p256+ml-kem-768' } {
  const point = p256HexFromJwk(jwk);
  return isHybridBoxKey(jwk)
    ? { publicKey: point + hexOfBytes(unb64u((jwk as BoxJwk).cappz_mlkem768!)), algorithm: 'p256+ml-kem-768' }
    : { publicKey: point, algorithm: 'p256' };
}

export async function sealBytesTo(recipientKeyHex: string, data: Uint8Array): Promise<CompactSealedBox> {
  const r = await sealRaw(p256JwkFromHex(recipientKeyHex.toLowerCase()), data);
  const base = { epk: b64u(r.epkRaw), iv: b64u(r.iv), ct: b64u(r.ct) };
  return r.scheme === HYBRID_BOX_SCHEME ? { scheme: HYBRID_BOX_SCHEME, ...base, kct: b64u(r.kemCt!) } : { scheme: CLASSIC_BOX_SCHEME, ...base };
}

export async function openBytesWith(privateKey: JsonWebKey, sealed: CompactSealedBox): Promise<Uint8Array> {
  if (sealed.scheme !== CLASSIC_BOX_SCHEME && sealed.scheme !== HYBRID_BOX_SCHEME) throw new Error('unknown sealed box scheme');
  const epkRaw = unb64u(sealed.epk);
  const epkJwk = p256JwkFromHex(hexOfBytes(epkRaw));
  return openRaw(privateKey, sealed.scheme, epkJwk, epkRaw, sealed.scheme === HYBRID_BOX_SCHEME ? unb64u(sealed.kct) : undefined, unb64u(sealed.iv), unb64u(sealed.ct));
}

/** Channel (group) content under a shared AES-GCM key, as bytes; the key reaches members in sealed boxes. */
export async function encryptBytes(keyB64: string, data: Uint8Array): Promise<{ scheme: 'AES-GCM-256'; iv: string; ct: string }> {
  const key = await crypto.subtle.importKey('raw', unb64(keyB64), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new Uint8Array(data.byteLength); plain.set(data);
  return { scheme: 'AES-GCM-256', iv: b64u(iv), ct: b64u(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain))) };
}

export async function decryptBytes(keyB64: string, c: { scheme: 'AES-GCM-256'; iv: string; ct: string }): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', unb64(keyB64), 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(c.iv) }, key, unb64u(c.ct)));
}
