/**
 * COPE node crystallized.
 * Node ID: v15-17-00-aes-compat
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * Bulk encryption on WebCrypto — the browser's and the OS's hardware AES
 * (ARMv8 AES instructions on Snapdragon, AES-NI on x86) — that still opens
 * everything crypto-js wrote.
 *
 *   new     'cz1.' + base64(salt[16] || iv[12] || AES-256-GCM ciphertext+tag)
 *           key = PBKDF2-HMAC-SHA-256(secret, salt, 100 000) → AES-256-GCM
 *   legacy  crypto-js passphrase mode: base64('Salted__' || salt[8] || CBC
 *           ciphertext), key and IV from OpenSSL EVP_BytesToKey (MD5, one
 *           round) → AES-256-CBC, decrypted here through WebCrypto too
 *
 * GCM authenticates: a wrong secret or a changed byte yields null, where
 * legacy CBC can only check its padding (crypto-js's own behaviour).
 * Measured in Edge and Chrome on a Snapdragon 8cx Gen 3, 16 MiB: crypto-js as
 * cappz used it took 3.2 s to encrypt (hex-encoding the file first) and stored
 * 43 MB; WebCrypto GCM took 23 ms and stores 21 MB of base64.
 *
 * The secret is used as given. This module makes encryption fast and
 * authenticated; it cannot make a key derived from public values private.
 */
import { md5 } from '@noble/hashes/legacy.js';

export const AES_COMPAT_PREFIX = 'cz1.';
const PBKDF2_ITERATIONS = 100_000;
const enc = new TextEncoder();
const buf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/** Base64 in 32 KiB pieces (spreading a large array into fromCharCode overflows the stack). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function gcmKey(secret: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', buf(enc.encode(secret)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: buf(salt), iterations: PBKDF2_ITERATIONS }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Encrypt bytes under `secret` (new format). */
export async function aesEncrypt(plain: Uint8Array, secret: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv) }, await gcmKey(secret, salt), buf(plain)));
  const out = new Uint8Array(28 + ct.length);
  out.set(salt); out.set(iv, 16); out.set(ct, 28);
  return AES_COMPAT_PREFIX + bytesToBase64(out);
}

/** OpenSSL EVP_BytesToKey with MD5 and one round, as crypto-js uses it: 32-byte key, 16-byte IV. */
function evpBytesToKey(passphrase: Uint8Array, salt: Uint8Array): { key: Uint8Array; iv: Uint8Array } {
  const out = new Uint8Array(48);
  let prev = new Uint8Array(0);
  for (let at = 0; at < 48;) {
    const block = new Uint8Array(prev.length + passphrase.length + salt.length);
    block.set(prev); block.set(passphrase, prev.length); block.set(salt, prev.length + passphrase.length);
    prev = md5(block);
    out.set(prev.subarray(0, Math.min(16, 48 - at)), at);
    at += 16;
  }
  return { key: out.subarray(0, 32), iv: out.subarray(32, 48) };
}

/** Is this crypto-js passphrase-mode ciphertext ('U2FsdGVkX1' = base64 of 'Salted__')? */
export const isLegacyCryptoJs = (stored: string) => stored.startsWith('U2FsdGVkX1');

export interface AesDecrypted {
  bytes: Uint8Array;
  /** Written by crypto-js (callers that stored text, e.g. hex, decode it as before). */
  legacy: boolean;
}

/**
 * Decrypt either format with `secret`. Null when the secret is wrong or the
 * data was changed (GCM), or when legacy padding does not check out.
 */
export async function aesDecrypt(stored: string, secret: string): Promise<AesDecrypted | null> {
  try {
    if (stored.startsWith(AES_COMPAT_PREFIX)) {
      const raw = base64ToBytes(stored.slice(AES_COMPAT_PREFIX.length));
      if (raw.length < 28 + 16) return null;
      const key = await gcmKey(secret, raw.subarray(0, 16));
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(raw.subarray(16, 28)) }, key, buf(raw.subarray(28)));
      return { bytes: new Uint8Array(plain), legacy: false };
    }
    if (isLegacyCryptoJs(stored)) {
      const raw = base64ToBytes(stored);
      if (raw.length < 32 || (raw.length - 16) % 16 !== 0) return null;
      const { key, iv } = evpBytesToKey(enc.encode(secret), raw.subarray(8, 16));
      const k = await crypto.subtle.importKey('raw', buf(key), 'AES-CBC', false, ['decrypt']);
      const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: buf(iv) }, k, buf(raw.subarray(16)));
      return { bytes: new Uint8Array(plain), legacy: true };
    }
  } catch {
    // wrong secret, tampered data or bad padding
  }
  return null;
}
