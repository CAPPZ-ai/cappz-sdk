/**
 * COPE node crystallized.
 * Node ID: v15-09-00-did-key
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * did:key (W3C CCG did:key method) for wallet and device keys: the DID IS the
 * public key (multicodec + base58btc), so it resolves offline with no
 * registry — the same property CAPPZ wallet addresses have. Used as issuer
 * and subject of exported credentials and in X.509 SAN URIs. Supported:
 * secp256k1 (wallet keys, 0xe7), P-256 (TLS keys, 0x1200), Ed25519 (device
 * keys, 0xed).
 */

import { fromHex, toHex } from './canonical.ts';
import type { KeyAlgorithm } from './keyDeclaration.ts';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58btc(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
  return out;
}

export function fromBase58btc(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error('not base58'); n = n * 58n + BigInt(i); }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c !== '1') break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}

const CODEC: Partial<Record<KeyAlgorithm, number[]>> = { secp256k1: [0xe7, 0x01], p256: [0x80, 0x24], ed25519: [0xed, 0x01] };

/** SEC1 point → compressed 33 bytes (an already-compressed point passes through). */
export function compressPoint(point: Uint8Array): Uint8Array {
  if (point.length === 33) return point;
  if (point.length !== 65 || point[0] !== 4) throw new Error('not an uncompressed SEC1 point');
  const out = new Uint8Array(33);
  out[0] = (point[64] & 1) ? 3 : 2;
  out.set(point.subarray(1, 33), 1);
  return out;
}

export function didKeyFor(algorithm: KeyAlgorithm, publicKeyHex: string): string {
  const codec = CODEC[algorithm];
  if (!codec) throw new Error(`did:key does not cover ${algorithm} here`);
  const raw = fromHex(publicKeyHex);
  const key = algorithm === 'ed25519' ? raw : compressPoint(raw);
  return `did:key:z${base58btc(Uint8Array.from([...codec, ...key]))}`;
}

export function parseDidKey(did: string): { algorithm: KeyAlgorithm; publicKeyHex: string } | null {
  const m = /^did:key:z([1-9A-HJ-NP-Za-km-z]+)$/.exec(did);
  if (!m) return null;
  let bytes: Uint8Array;
  try { bytes = fromBase58btc(m[1]); } catch { return null; }
  for (const [algorithm, codec] of Object.entries(CODEC) as Array<[KeyAlgorithm, number[]]>) {
    if (codec.every((c, i) => bytes[i] === c)) {
      const key = bytes.subarray(codec.length);
      if ((algorithm === 'ed25519' && key.length === 32) || (algorithm !== 'ed25519' && key.length === 33)) return { algorithm, publicKeyHex: toHex(key) };
    }
  }
  return null;
}
