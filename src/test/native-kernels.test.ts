import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { typescriptKernels, loadWasmKernels, loadNativeLibrary, nativeLibraryName, nodeFfi, useKernels, CAPPZ_NATIVE_WASM_MANIFEST, CAPPZ_NATIVE_SIG_WASM_MANIFEST, type NativeKernels } from '../lib/native/cappzNative';
import { putBody, readBody } from '../lib/sync/chunkedBodies';
import { MAX_BODY_BYTES, type BodyStore } from '../lib/sync/edgeBodyPull';
import { rsEncode, rsDecode, rsEncodeAsync, rsDecodeAsync, encodingMatrix } from '../lib/erasure/reedSolomon';
import { gfInvert } from '../lib/native/gf256';

const wasmPath = path.resolve(__dirname, '../lib/native/wasm/cappz_native.wasm');
// The native library is built locally (packages/cappz-native); its tests run when it exists.
const libPath = process.env.CAPPZ_NATIVE_LIB ?? path.resolve(__dirname, '../../packages/cappz-native/target/release', nativeLibraryName());

function bytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed * 2654435761 >>> 0 || 1;
  for (let i = 0; i < n; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; out[i] = x & 0xff; }
  return out;
}
const nodeSha = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());

async function backends(): Promise<NativeKernels[]> {
  const list = [typescriptKernels, await loadWasmKernels(new Uint8Array(readFileSync(wasmPath)))];
  if (existsSync(libPath)) {
    try { list.push(await loadNativeLibrary(libPath)); } catch { /* no FFI in this runtime */ }
  }
  return list;
}

const hasNodeFfi = nodeFfi() !== null;

describe('v15-14-00 cappz-native kernels', () => {
  it.skipIf(!existsSync(libPath) || !hasNodeFfi)('the native library loads where it has been built', async () => {
    const k = await loadNativeLibrary(libPath);
    expect(k.backend).toBe('native');
    expect(k.features.threads).toBe(true);
    expect((await backends()).map((b) => b.backend)).toEqual(['typescript', 'wasm', 'native']);
  }, 30_000); // the first load of a freshly built DLL can wait on an antivirus scan

  it('both wasm modules match their provenance manifests and refuse tampered bytes', async () => {
    const wasm = new Uint8Array(readFileSync(wasmPath));
    const sig = new Uint8Array(readFileSync(path.resolve(__dirname, '../lib/native/wasm/cappz_native_sig.wasm')));
    expect(createHash('sha256').update(wasm).digest('hex')).toBe(CAPPZ_NATIVE_WASM_MANIFEST.sha256);
    expect(createHash('sha256').update(sig).digest('hex')).toBe(CAPPZ_NATIVE_SIG_WASM_MANIFEST.sha256);
    const tampered = wasm.slice(); tampered[tampered.length - 1] ^= 1;
    await expect(loadWasmKernels(tampered)).rejects.toThrow(/integrity/);
    const tamperedSig = sig.slice(); tamperedSig[tamperedSig.length - 1] ^= 1;
    await expect(loadWasmKernels(wasm, { signatures: tamperedSig })).rejects.toThrow(/signature wasm integrity/);
    // The core module alone has no signature code; the modules cannot stand in for each other.
    expect((await loadWasmKernels(wasm)).features).toMatchObject({ signatures: false, simd: true });
    await expect(loadWasmKernels(sig, { expected: CAPPZ_NATIVE_SIG_WASM_MANIFEST.sha256 })).rejects.toThrow(/lacks/);
  });

  it('sha256 agrees with node:crypto on every backend, around every block boundary', async () => {
    for (const k of await backends()) {
      for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000, 65_537]) {
        const b = bytes(n, n + 3);
        expect(k.sha256(b), `${k.backend} len ${n}`).toEqual(nodeSha(b));
      }
    }
  });

  it('chunk hashing matches per-chunk sha256, including a short tail', async () => {
    const b = bytes(1_000_003, 9);
    const want = [];
    for (let at = 0; at < b.length; at += 65_536) want.push(nodeSha(b.subarray(at, at + 65_536)));
    for (const k of await backends()) expect(k.sha256Chunks(b, 65_536), k.backend).toEqual(want);
  });

  it('GF matrix multiply is byte-identical across backends', async () => {
    const [ts, ...others] = await backends();
    const k = 7, rows = 3, len = 50_001;
    const coeffs = bytes(rows * k, 5);
    coeffs[4] = 0; // a zero coefficient is skipped, not multiplied
    const inputs = bytes(k * len, 6);
    const want = ts.gfMatmul(coeffs, rows, k, inputs, len);
    for (const b of others) expect(b.gfMatmul(coeffs, rows, k, inputs, len), b.backend).toEqual(want);
  });

  it('rejects mis-shaped kernel calls instead of reading out of bounds', async () => {
    for (const k of await backends()) {
      expect(() => k.gfMatmul(new Uint8Array(6), 2, 3, new Uint8Array(10), 4), k.backend).toThrow(/expected/);
      expect(() => k.sha256Chunks(new Uint8Array(4), 0), k.backend).toThrow(/positive/);
    }
  });
});

describe('v15-14-00 chunked bodies on native kernels', () => {
  const memStore = (): BodyStore & { map: Map<string, Uint8Array> } => {
    const map = new Map<string, Uint8Array>();
    return { map, list: async () => [...map.keys()], has: async (id) => map.has(id), get: async (id) => map.get(id) ?? null, put: async (id, b) => { map.set(id, b); } };
  };

  it.skipIf(!existsSync(libPath) || !hasNodeFfi)('putBody gives the same ids and manifest with native kernels as with WebCrypto', async () => {
    const data = bytes(MAX_BODY_BYTES + 3 * 65_536 + 17, 12);
    useKernels(typescriptKernels);
    const plain = memStore();
    const a = await putBody(plain, data, { chunkBytes: 65_536 });
    useKernels(await loadNativeLibrary(libPath));
    try {
      const fast = memStore();
      const b = await putBody(fast, data, { chunkBytes: 65_536 });
      expect(b).toEqual(a);
      expect([...fast.map.keys()].sort()).toEqual([...plain.map.keys()].sort());
      const back = await readBody(fast, b.id);
      // Buffer.equals: vitest's deep equality walks a 6 MB array element by element.
      expect(back.state === 'complete' && Buffer.from(back.bytes).equals(data)).toBe(true);
    } finally {
      useKernels(typescriptKernels);
    }
  });
});

describe('v15-14-00 Reed-Solomon erasure coding', () => {
  it('encoding matrix is systematic and every k-row subset is invertible', () => {
    const k = 4, m = 3;
    const mat = encodingMatrix(k, m);
    for (let r = 0; r < k; r++) expect(Array.from(mat[r])).toEqual(Array.from({ length: k }, (_, c) => (c === r ? 1 : 0)));
    const rows = [...Array(k + m).keys()];
    const subsets = (from: number[], n: number): number[][] => n === 0 ? [[]] : from.flatMap((x, i) => subsets(from.slice(i + 1), n - 1).map((s) => [x, ...s]));
    for (const s of subsets(rows, k)) expect(() => gfInvert(s.map((i) => mat[i]))).not.toThrow();
  });

  it('rebuilds from ANY k of k + m shards (every erasure pattern up to m)', async () => {
    for (const kern of await backends()) {
      const k = 4, m = 2;
      const data = bytes(10_007, 11);
      const { descriptor, shards } = rsEncode(data, k, m, kern);
      for (let a = 0; a < k + m; a++) {
        for (let b = a; b < k + m; b++) {
          const got = shards.map((s, i) => (i === a || i === b ? null : s));
          const { data: back, lost } = rsDecode(got, descriptor, kern);
          expect(back, `${kern.backend} lose ${a},${b}`).toEqual(data);
          expect(lost).toEqual(a === b ? [a] : [a, b]);
        }
      }
    }
  });

  it('parity shards differ from each other (the XOR scheme this replaces made them identical)', () => {
    const { shards } = rsEncode(bytes(4096, 2), 4, 3);
    expect(shards[4]).not.toEqual(shards[5]);
    expect(shards[5]).not.toEqual(shards[6]);
  });

  it('every backend produces the same shards and descriptor', async () => {
    const [ts, ...others] = await backends();
    const data = bytes(300_000, 4);
    const want = rsEncode(data, 10, 4, ts);
    for (const b of others) {
      const got = rsEncode(data, 10, 4, b);
      expect(got.descriptor, b.backend).toEqual(want.descriptor);
      expect(got.shards, b.backend).toEqual(want.shards);
    }
  });

  it('rsEncodeAsync / rsDecodeAsync (WebCrypto shard hashes) match the sync codec on every backend', async () => {
    const data = bytes(1_000_003, 21);
    for (const k of await backends()) {
      const sync = rsEncode(data, 6, 3, k);
      const asyncEnc = await rsEncodeAsync(data, 6, 3, k);
      expect(asyncEnc.descriptor, k.backend).toEqual(sync.descriptor);
      expect(asyncEnc.shards.every((x, i) => Buffer.from(x).equals(Buffer.from(sync.shards[i]))), k.backend).toBe(true);
      const damaged = asyncEnc.shards.map((x, i) => (i === 1 || i === 4 ? null : x));
      const bad = damaged.map((x) => x?.slice() ?? null); bad[0]![9] ^= 1;
      const back = await rsDecodeAsync(bad, asyncEnc.descriptor, k);
      expect(Buffer.from(back.data).equals(Buffer.from(data)), k.backend).toBe(true);
      expect(back.lost, k.backend).toEqual([0, 1, 4]);
    }
  }, 30_000);

  it('a corrupted shard is detected by its hash and treated as lost', () => {
    const data = bytes(5000, 8);
    const { descriptor, shards } = rsEncode(data, 3, 2);
    const bad = shards.map((s) => s.slice());
    bad[1][17] ^= 0x40;
    const { data: back, lost } = rsDecode(bad, descriptor);
    expect(back).toEqual(data);
    expect(lost).toEqual([1]);
  });

  it('fails loudly with fewer than k intact shards', () => {
    const { descriptor, shards } = rsEncode(bytes(1000, 3), 3, 1);
    expect(() => rsDecode([shards[0], null, null, shards[3]], descriptor)).toThrow(/2 intact shards, need 3/);
  });

  it('handles empty input, m = 0 and k = 1', () => {
    for (const [k, m] of [[1, 2], [3, 0], [5, 3]]) {
      for (const data of [new Uint8Array(0), bytes(1, 1), bytes(999, 2)]) {
        const enc = rsEncode(data, k, m);
        expect(rsDecode(enc.shards, enc.descriptor).data).toEqual(data);
      }
    }
    expect(() => rsEncode(bytes(10), 0, 1)).toThrow(/k=0/);
    expect(() => rsEncode(bytes(10), 200, 57)).toThrow(/<= 256/);
  });
});
