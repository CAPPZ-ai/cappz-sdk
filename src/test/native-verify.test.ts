import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import { typescriptKernels, loadWasmKernels, loadNativeLibrary, nativeLibraryName, nodeFfi, useKernels, type NativeKernels, type Secp256k1Item, type Ed25519Item } from '../lib/native/cappzNative';
import { generateRecoveryPhrase, keyPairFromPhrase, signMessage, verifySignature } from '../lib/auth/wallet/session';
import { generateSigningKey, signCanonical, verifyCanonical } from '../lib/sync/helloSignature';

const wasmPath = path.resolve(__dirname, '../lib/native/wasm/cappz_native.wasm');
const libPath = process.env.CAPPZ_NATIVE_LIB ?? path.resolve(__dirname, '../../packages/cappz-native/target/release', nativeLibraryName());
const hasNative = existsSync(libPath) && nodeFfi() !== null;

async function backends(): Promise<NativeKernels[]> {
  const list = [typescriptKernels, await loadWasmKernels(new Uint8Array(readFileSync(wasmPath)))];
  if (hasNative) list.push(await loadNativeLibrary(libPath));
  return list;
}
const enc = (s: string) => new TextEncoder().encode(s);
const hex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));

/** Wallet-style signatures: what session.signMessage produces, as verify-many items. */
async function secpItems(n: number): Promise<Secp256k1Item[]> {
  const out: Secp256k1Item[] = [];
  for (let i = 0; i < n; i++) {
    const k = keyPairFromPhrase(generateRecoveryPhrase());
    const msg = `KeyZ declaration ${i}`;
    const sig = secp.etc.hexToBytes(await signMessage(k.privateKey, msg));
    out.push({ digest: sha256(sha256(enc(msg))), signature: sig, publicKey: i % 2 ? secp.Point.fromBytes(k.publicKey).toBytes(false) : k.publicKey });
  }
  return out;
}
function highS(sig: Uint8Array): Uint8Array {
  const n = secp.Point.CURVE().n;
  const s = BigInt('0x' + Buffer.from(sig.subarray(32)).toString('hex'));
  const out = sig.slice();
  out.set(secp.etc.numberToBytesBE(n - s), 32);
  return out;
}

// RFC 8032 §7.1 TEST 1 and TEST 2.
const RFC8032: Ed25519Item[] = [
  { publicKey: hex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'), message: new Uint8Array(0), signature: hex('e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b') },
  { publicKey: hex('3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c'), message: hex('72'), signature: hex('92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00') },
];

describe('v15-16-00 batch signature verification', () => {
  it('secp256k1: every backend accepts wallet signatures and refuses tampering, high-S twins and bad shapes', async () => {
    const good = await secpItems(40);
    const bad: Secp256k1Item[] = [
      { ...good[0], digest: sha256(enc('other')) },
      { ...good[1], signature: (() => { const s = good[1].signature.slice(); s[5] ^= 1; return s; })() },
      { ...good[2], signature: highS(good[2].signature) },
      { ...good[3], publicKey: good[4].publicKey },
      { ...good[5], signature: good[5].signature.subarray(0, 63) },
      { ...good[6], publicKey: new Uint8Array(20) },
      { ...good[7], digest: new Uint8Array(31) },
    ];
    for (const k of await backends()) {
      expect(k.secp256k1VerifyMany(good).every(Boolean), k.backend).toBe(true);
      expect(k.secp256k1VerifyMany(bad), k.backend).toEqual(bad.map(() => false));
      // mixed order keeps positions
      const mixed = [good[8], bad[0], good[9], bad[2]];
      expect(k.secp256k1VerifyMany(mixed), k.backend).toEqual([true, false, true, false]);
      expect(k.secp256k1VerifyMany([])).toEqual([]);
    }
  });

  it('Ed25519: RFC 8032 vectors and WebCrypto signatures verify on every backend; tampering and small-order keys do not', async () => {
    const extra: Ed25519Item[] = [];
    for (let i = 0; i < 40; i++) {
      const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
      const message = enc(`hello ${i}`.repeat(i));
      extra.push({ publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)), message, signature: new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, keys.privateKey, message)) });
    }
    const good = [...RFC8032, ...extra];
    const identity = new Uint8Array(32); identity[0] = 1;
    const bad: Ed25519Item[] = [
      { ...RFC8032[1], message: hex('73') },
      { ...RFC8032[0], signature: (() => { const s = RFC8032[0].signature.slice(); s[1] ^= 1; return s; })() },
      { publicKey: identity, message: new Uint8Array(0), signature: new Uint8Array(64) },
      { ...RFC8032[0], publicKey: RFC8032[0].publicKey.subarray(0, 31) },
    ];
    for (const k of await backends()) {
      expect(k.ed25519VerifyMany(good).every(Boolean), k.backend).toBe(true);
      expect(k.ed25519VerifyMany(bad), k.backend).toEqual(bad.map(() => false));
    }
  });

  it('verifySignature and hello signatures give the same answers through WASM and native kernels', async () => {
    const k = keyPairFromPhrase(generateRecoveryPhrase());
    const sig = await signMessage(k.privateKey, 'session challenge');
    const twin = Buffer.from(highS(secp.etc.hexToBytes(sig))).toString('hex');
    const dev = await generateSigningKey();
    const body = '{"kind":"hello","n":1}';
    const hs = await signCanonical(body, dev);
    const answers = async () => [
      await verifySignature('session challenge', sig, k.address),
      await verifySignature('session challenge!', sig, k.address),
      await verifySignature('session challenge', twin, k.address),
      await verifySignature('session challenge', 'zz', k.address),
      await verifyCanonical(body, hs, dev.publicKeyHex),
      await verifyCanonical(body.replace('1', '2'), hs, dev.publicKeyHex),
    ];
    useKernels(typescriptKernels);
    const before = await answers();
    expect(before).toEqual([true, false, false, false, true, false]);
    try {
      for (const k of (await backends()).slice(1)) {
        useKernels(k);
        expect(await answers(), k.backend).toEqual(before);
      }
    } finally {
      useKernels(typescriptKernels);
    }
  });
});
