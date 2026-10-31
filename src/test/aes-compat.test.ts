import { describe, it, expect } from 'vitest';
import CryptoJS from 'crypto-js';
import { aesDecrypt, aesEncrypt, base64ToBytes, bytesToBase64, isLegacyCryptoJs, AES_COMPAT_PREFIX } from '../lib/crypto/aesCompat';

function bytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < n; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; out[i] = x & 0xff; }
  return out;
}
const SECRET = 'f'.repeat(64);
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

describe('v15-17-00 AES on WebCrypto, compatible with crypto-js', () => {
  it('opens what crypto-js wrote, text and hex-encoded files, at every padding length', async () => {
    for (const n of [0, 1, 15, 16, 17, 1000]) {
      const text = Buffer.from(bytes(n, n + 1)).toString('base64');
      const legacy = CryptoJS.AES.encrypt(text, SECRET).toString();
      expect(isLegacyCryptoJs(legacy)).toBe(true);
      const r = await aesDecrypt(legacy, SECRET);
      expect(r?.legacy).toBe(true);
      expect(new TextDecoder().decode(r!.bytes), `n=${n}`).toBe(text);
    }
    // The notarizer stored hex text of the file: decoding the hex gives the file back.
    const file = bytes(70_001, 9);
    const legacyFile = CryptoJS.AES.encrypt(CryptoJS.lib.WordArray.create(file).toString(), SECRET).toString();
    const r = await aesDecrypt(legacyFile, SECRET);
    expect(same(Uint8Array.from(Buffer.from(new TextDecoder().decode(r!.bytes), 'hex')), file)).toBe(true);
  });

  it('new format round-trips bytes and is GCM-authenticated', async () => {
    const file = bytes(300_000, 4);
    const stored = await aesEncrypt(file, SECRET);
    expect(stored.startsWith(AES_COMPAT_PREFIX)).toBe(true);
    const r = await aesDecrypt(stored, SECRET);
    expect(r?.legacy).toBe(false);
    expect(same(r!.bytes, file)).toBe(true);
    expect(await aesDecrypt(stored, 'e'.repeat(64))).toBeNull();
    const raw = base64ToBytes(stored.slice(AES_COMPAT_PREFIX.length)); raw[40] ^= 1;
    expect(await aesDecrypt(AES_COMPAT_PREFIX + bytesToBase64(raw), SECRET)).toBeNull();
    expect(await aesEncrypt(file, SECRET)).not.toBe(stored); // fresh salt and IV
    expect((await aesDecrypt(await aesEncrypt(new Uint8Array(0), SECRET), SECRET))?.bytes.length).toBe(0);
  });

  it('a wrong secret on legacy data does not return the plaintext', async () => {
    const legacy = CryptoJS.AES.encrypt('patient record', SECRET).toString();
    const r = await aesDecrypt(legacy, 'e'.repeat(64));
    expect(r === null || new TextDecoder().decode(r.bytes) !== 'patient record').toBe(true);
    expect(await aesDecrypt('not ciphertext', SECRET)).toBeNull();
  });

  it('base64 helpers handle data larger than one fromCharCode spread', () => {
    const big = bytes(1_000_003, 2);
    expect(same(base64ToBytes(bytesToBase64(big)), big)).toBe(true);
    expect(bytesToBase64(big)).toBe(Buffer.from(big).toString('base64'));
  });
});
