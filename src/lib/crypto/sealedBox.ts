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
