/**
 * COPE node crystallized. Node ID: v15-00-01-sealed-box.
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Sealed box: encrypt to a recipient's P-256 public key (ephemeral ECDH →
 * AES-GCM 256). Only the holder of the private key can open it. Used for
 * HARVEST survey contributions and marketplace access-key delivery.
 */
export interface SealedBox { scheme: 'ECDH-P256-AES-GCM'; ephemeralPublicKey: JsonWebKey; iv: number[]; cipher: number[] }

export async function generateBoxKeyPair(): Promise<{ publicKey: JsonWebKey; privateKey: JsonWebKey }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
  return { publicKey: await crypto.subtle.exportKey('jwk', pair.publicKey), privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey) };
}

async function sharedKey(privateKey: CryptoKey, publicJwk: JsonWebKey): Promise<CryptoKey> {
  const pub = await crypto.subtle.importKey('jwk', publicJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  return crypto.subtle.deriveKey({ name: 'ECDH', public: pub }, privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function sealTo(publicKey: JsonWebKey, data: unknown): Promise<SealedBox> {
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
  const key = await sharedKey(eph.privateKey, publicKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(data))));
  return { scheme: 'ECDH-P256-AES-GCM', ephemeralPublicKey: await crypto.subtle.exportKey('jwk', eph.publicKey), iv: Array.from(iv), cipher: Array.from(cipher) };
}

export async function openWith<T>(privateKey: JsonWebKey, sealed: SealedBox): Promise<T> {
  const priv = await crypto.subtle.importKey('jwk', privateKey, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
  const key = await sharedKey(priv, sealed.ephemeralPublicKey);
  const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(sealed.iv) }, key, new Uint8Array(sealed.cipher));
  return JSON.parse(new TextDecoder().decode(raw)) as T;
}

/** Symmetric content encryption (AES-GCM 256) for content sold under a key; the key travels in a SealedBox. */
export interface ContentCipher { scheme: 'AES-GCM-256'; iv: number[]; cipher: string }
const b64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

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
 * v15-13-00: the same sealed box (ephemeral ECDH P-256 → AES-GCM 256) over bytes, in a compact
 * base64url form for links measured in bytes (mesh bundles over BLE or LoRa fragments): the
 * number-array form above costs about four bytes per ciphertext byte. The recipient key is a
 * declared encryption key (KeyDeclaration purpose 'encryption', algorithm 'p256'): a SEC1
 * uncompressed point as hex.
 */
export interface CompactSealedBox { scheme: 'ECDH-P256-AES-GCM'; epk: string; iv: string; ct: string }

const b64u = (u: Uint8Array) => b64(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) => unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
const bytesOfHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const hexOfBytes = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** SEC1 uncompressed P-256 point (hex, 04‖x‖y) → public JWK. */
export function p256JwkFromHex(pointHex: string): JsonWebKey {
  const p = bytesOfHex(pointHex);
  if (p.length !== 65 || p[0] !== 4) throw new Error('not an uncompressed P-256 point');
  return { kty: 'EC', crv: 'P-256', x: b64u(p.slice(1, 33)), y: b64u(p.slice(33)), ext: true };
}

/** Public JWK → SEC1 uncompressed point hex (what a KeyDeclaration carries). */
export function p256HexFromJwk(jwk: JsonWebKey): string {
  if (jwk.crv !== 'P-256' || !jwk.x || !jwk.y) throw new Error('not a P-256 JWK');
  return '04' + hexOfBytes(unb64u(jwk.x)) + hexOfBytes(unb64u(jwk.y));
}

export async function sealBytesTo(recipientPointHex: string, data: Uint8Array): Promise<CompactSealedBox> {
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
  const key = await sharedKey(eph.privateKey, p256JwkFromHex(recipientPointHex));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new Uint8Array(data.byteLength); plain.set(data);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  const epk = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  return { scheme: 'ECDH-P256-AES-GCM', epk: b64u(epk), iv: b64u(iv), ct: b64u(ct) };
}

export async function openBytesWith(privateKey: JsonWebKey, sealed: CompactSealedBox): Promise<Uint8Array> {
  if (sealed.scheme !== 'ECDH-P256-AES-GCM') throw new Error('unknown sealed box scheme');
  const priv = await crypto.subtle.importKey('jwk', privateKey, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
  const key = await sharedKey(priv, p256JwkFromHex(hexOfBytes(unb64u(sealed.epk))));
  const ct = unb64u(sealed.ct);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(sealed.iv) }, key, ct));
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
