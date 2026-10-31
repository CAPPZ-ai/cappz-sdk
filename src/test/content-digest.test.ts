import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import CryptoJS from 'crypto-js';
import { typescriptKernels, loadWasmKernels, loadNativeLibrary, nativeLibraryName, nodeFfi, type NativeKernels } from '../lib/native/cappzNative';
import { digestContent } from '../lib/crypto/contentDigest';
import { computeSaltedHash, verifyClient } from '../lib/crypto/clientVerify';
import { notarizeClient } from '../lib/crypto/clientNotarize';

const wasmPath = path.resolve(__dirname, '../lib/native/wasm/cappz_native.wasm');
const libPath = process.env.CAPPZ_NATIVE_LIB ?? path.resolve(__dirname, '../../packages/cappz-native/target/release', nativeLibraryName());

function bytes(n: number, seed = 1): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  let x = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < n; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; out[i] = x & 0xff; }
  return out;
}
const enc = (s: string) => new TextEncoder().encode(s);
const sha = (...parts: Uint8Array[]) => { const h = createHash('sha256'); for (const p of parts) h.update(p); return h.digest('hex'); };

async function backends(): Promise<NativeKernels[]> {
  const list = [typescriptKernels, await loadWasmKernels(new Uint8Array(readFileSync(wasmPath)))];
  if (existsSync(libPath) && nodeFfi()) list.push(await loadNativeLibrary(libPath));
  return list;
}

// Fixed vectors: if either formula ever changed, existing receipts would stop verifying.
const SALT = 'q7Lr3x_PZt0vYd8uKm2N1w';
const CONTENT = enc('CAPPZ notarization vector v1');
const LEAF_SALT_TEXT = 'BAA4DD79A07B2190EF5A83A6FE4BF2C2E6912AC04C18B66870D5D4D483C489C7';
const LEAF_SALT_BYTES = '5796A88F0865F54ECC51F65772192E67A79B51890849259C75BE17E894CBAC86';

describe('v15-15-00 notarization leaves are unchanged', () => {
  it('salt-text leaf (clientNotarize, cappz-notarize) matches the fixed vector', async () => {
    expect(await computeSaltedHash(CONTENT, SALT)).toBe(LEAF_SALT_TEXT);
  });

  it('raw-salt-byte leaf (XRPL notary service) matches crypto-js and the fixed vector', async () => {
    const raw = new Uint8Array(Buffer.from(SALT, 'base64url'));
    const viaCryptoJs = CryptoJS.SHA256(CryptoJS.lib.WordArray.create(raw).concat(CryptoJS.lib.WordArray.create(CONTENT))).toString().toUpperCase();
    expect(viaCryptoJs).toBe(LEAF_SALT_BYTES);
    expect((await digestContent(CONTENT, { leafPrefix: raw })).leaf).toBe(LEAF_SALT_BYTES);
  });

  it('every path gives the same sha256 and leaf: WebCrypto, and streamed on every backend, from bytes or a Blob', async () => {
    const prefix = enc(SALT);
    for (const n of [0, 1, 63, 64, 65, 1000, 300_001]) {
      const data = bytes(n, n + 1);
      const want = { sha256: sha(data), leaf: sha(prefix, data).toUpperCase() };
      const web = await digestContent(new Blob([data]), { leafPrefix: prefix });
      expect(web.via).toBe('webcrypto');
      expect({ sha256: web.sha256, leaf: web.leaf }, `webcrypto ${n}`).toEqual(want);
      for (const kernels of await backends()) {
        for (const source of [data, new Blob([data])]) {
          // webCryptoMaxBytes -1 forces the streamed path; odd slice sizes cross block boundaries.
          const d = await digestContent(source, { leafPrefix: prefix, kernels, webCryptoMaxBytes: -1, sliceBytes: 65_537 });
          expect(d.via).toBe(kernels.backend);
          expect({ sha256: d.sha256, leaf: d.leaf }, `${kernels.backend} ${n} ${source instanceof Blob ? 'blob' : 'bytes'}`).toEqual(want);
        }
      }
    }
  });

  it('native kernels always stream (no whole-file buffer), with progress up to the total', async () => {
    const kernels = (await backends()).find((k) => k.backend === 'native');
    if (!kernels) return;
    const data = bytes(3 * 1024 * 1024 + 5, 9);
    const seen: number[] = [];
    const d = await digestContent(new Blob([data]), { leafPrefix: enc(SALT), kernels, onProgress: (done) => seen.push(done) });
    expect(d.via).toBe('native');
    expect(d.leaf).toBe(sha(enc(SALT), data).toUpperCase());
    expect(seen.at(-1)).toBe(data.length);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    // The two-core paired update refuses one stream given twice (it would race).
    const s = kernels.sha256Stream();
    expect(() => kernels.sha256UpdatePair!(s, s, data)).toThrow(/two different streams/);
  });

  it('a stream cannot be reused after digest', async () => {
    for (const kernels of await backends()) {
      if (kernels.backend === 'typescript') continue;
      const s = kernels.sha256Stream();
      s.update(enc('x'));
      s.digest();
      expect(() => s.update(enc('y')), kernels.backend).toThrow();
    }
  });
});

describe('v15-15-00 notarizeClient / verifyClient take files and bytes', () => {
  it('notarizes a Blob without base64, returns the content sha256, and verifies from bytes or legacy base64', async () => {
    const data = bytes(2 * 1024 * 1024 + 3, 4); // past where btoa(String.fromCharCode(...bytes)) overflows the stack
    const r = await notarizeClient({ file: new Blob([data]), userWallet: 'rDemoWallet', fileName: 'big.bin' });
    expect(r.leaf).toBe(sha(enc(r.salt), data).toUpperCase());
    expect(r.contentSha256).toBe(sha(data));
    for (const source of [{ fileBytes: data }, { file: new Blob([data]) }, { fileBase64: Buffer.from(data).toString('base64') }]) {
      const v = await verifyClient({ ...source, salt: r.salt, expectedLeaf: r.leaf });
      expect(v.method).toBe('recompute');
      expect(v.verified).toBe(true);
    }
    const tampered = data.slice(); tampered[123] ^= 1;
    expect((await verifyClient({ fileBytes: tampered, salt: r.salt, expectedLeaf: r.leaf })).verified).toBe(false);
  });

  it('the legacy base64 and text requests give the same leaf as before', async () => {
    const r = await notarizeClient({ fileBase64: Buffer.from(CONTENT).toString('base64'), userWallet: 'rDemoWallet' });
    expect(r.leaf).toBe(sha(enc(r.salt), CONTENT).toUpperCase());
    const t = await notarizeClient({ content: 'hello', userWallet: 'rDemoWallet' });
    expect(t.leaf).toBe(sha(enc(t.salt), enc('hello')).toUpperCase());
    const pre = await notarizeClient({ contentHash: 'abcdef', userWallet: 'rDemoWallet' });
    expect(pre.leaf).toBe('ABCDEF');
    expect(pre.contentSha256).toBeUndefined();
  });
});
