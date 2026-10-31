import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createKernelPool, rsDecodeParallel, rsEncodeParallel, type PoolWorker } from '../lib/native/kernelPool';
import { createKernelWorkerState, handleKernelJob, type KernelJob, type KernelReply } from '../lib/native/kernelWorker';
import { rsEncode, rsDecode } from '../lib/erasure/reedSolomon';
import { typescriptKernels } from '../lib/native/cappzNative';

const wasm = new Uint8Array(readFileSync(path.resolve(__dirname, '../lib/native/wasm/cappz_native.wasm')));

/** A Worker stand-in: the real job handler, with messages delivered asynchronously like a thread. */
function inProcessWorker(): PoolWorker {
  const state = createKernelWorkerState();
  const w: PoolWorker = {
    onmessage: null,
    postMessage(message) {
      // Structured clone, as postMessage does.
      const job = structuredClone(message) as KernelJob;
      setTimeout(async () => {
        const { reply } = await handleKernelJob(state, job);
        w.onmessage?.({ data: structuredClone(reply) as KernelReply } as MessageEvent<KernelReply>);
      }, 0);
    },
    terminate() { w.onmessage = null; },
  };
  return w;
}

function bytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < n; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; out[i] = x & 0xff; }
  return out;
}
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

describe('v15-17-00 multi-threaded WASM kernel pool', () => {
  it('each worker loads the verified core module; a tampered module is refused', async () => {
    const pool = await createKernelPool({ createWorker: inProcessWorker, wasm, size: 3 });
    expect(pool.backends).toEqual(['wasm', 'wasm', 'wasm']);
    pool.close();
    const bad = wasm.slice(); bad[bad.length - 1] ^= 1;
    await expect(createKernelPool({ createWorker: inProcessWorker, wasm: bad, size: 2 })).rejects.toThrow(/integrity/);
  });

  it('rsEncodeParallel / rsDecodeParallel are byte-identical to the single-threaded codec', async () => {
    for (const size of [1, 3, 4]) {
      const pool = await createKernelPool({ createWorker: inProcessWorker, wasm, size });
      for (const n of [0, 1, 1000, 3 * 1024 * 1024 + 17]) {
        const data = bytes(n, n + size);
        const want = rsEncode(data, 10, 4, typescriptKernels);
        const got = await rsEncodeParallel(data, 10, 4, pool);
        expect(got.descriptor, `pool ${size}, ${n} bytes`).toEqual(want.descriptor);
        expect(got.shards.every((s, i) => same(s, want.shards[i])), `pool ${size}, ${n} bytes`).toBe(true);
        const damaged = got.shards.map((s, i) => (i === 0 || i === 7 || i === 11 ? null : s));
        const back = await rsDecodeParallel(damaged, got.descriptor, pool);
        expect(same(back.data, data)).toBe(true);
        expect(back.lost).toEqual(rsDecode(damaged, want.descriptor, typescriptKernels).lost);
      }
      pool.close();
    }
  }, 60_000);

  it('chunk hashing across workers returns digests in order', async () => {
    const pool = await createKernelPool({ createWorker: inProcessWorker, wasm, size: 4 });
    const data = bytes(5 * 1024 * 1024 + 3, 8);
    const got = await pool.sha256Chunks(data, 256 * 1024);
    expect(got.map((d) => Buffer.from(d).toString('hex'))).toEqual(typescriptKernels.sha256Chunks(data, 256 * 1024).map((d) => Buffer.from(d).toString('hex')));
    expect(await pool.sha256Chunks(new Uint8Array(0), 1024)).toEqual([]);
    pool.close();
  });
});
