/**
 * COPE node crystallized.
 * Node ID: v15-17-00-kernel-pool
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * Multi-threaded WASM in browsers without nightly Rust or cross-origin
 * isolation: a pool of Web Workers, each running the core WASM module
 * (verified against its pinned hash). Reed-Solomon's GF math is split by
 * byte range and chunk hashing by chunk; every worker hashes with its own
 * WebCrypto. Slices are copied to the workers and results transferred back.
 *
 *   const pool = await createKernelPool({ createWorker: () => new Worker(url, { type: 'module' }), wasm });
 *   const { descriptor, shards } = await rsEncodeParallel(bytes, 10, 4, pool);
 *
 * Output is byte-identical to rsEncode / rsDecode.
 */
import { encodingMatrix, RS_SCHEME, type RsDecodeResult, type RsDescriptor, type RsEncoded } from '../erasure/reedSolomon';
import { gfInvert } from './gf256';
import type { KernelJob, KernelReply } from './kernelWorker';

/** A job without its id (Omit applied to each member of the union). */
type JobBody = KernelJob extends infer J ? (J extends KernelJob ? Omit<J, 'id'> : never) : never;

/** What the pool needs from a Worker (a real Web Worker, or an in-process stand-in in tests). */
export interface PoolWorker {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<KernelReply>) => void) | null;
  onerror?: ((e: ErrorEvent) => void) | null;
  terminate(): void;
}

export interface KernelPool {
  size: number;
  /** Backend each worker loaded ('wasm', or 'typescript' when given no module). */
  backends: string[];
  gfMatmul(coeffs: Uint8Array, rows: number, k: number, inputs: Uint8Array, len: number): Promise<Uint8Array>;
  sha256Chunks(bytes: Uint8Array, chunk: number): Promise<Uint8Array[]>;
  close(): void;
}

export interface KernelPoolOptions {
  createWorker: () => PoolWorker;
  /** Bytes of cappz_native.wasm; each worker verifies them against the manifest. */
  wasm?: Uint8Array;
  /** Workers to start (default: hardwareConcurrency, at most 8). */
  size?: number;
}

/** Below this many bytes per worker, splitting costs more than it saves. */
const MIN_SLICE = 256 * 1024;

export async function createKernelPool(o: KernelPoolOptions): Promise<KernelPool> {
  const cores = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency ?? 4;
  const size = Math.max(1, Math.min(o.size ?? Math.min(cores, 8), 16));
  let nextId = 1;
  const pending = new Map<number, { resolve: (r: KernelReply) => void; reject: (e: Error) => void }>();
  const workers = Array.from({ length: size }, () => {
    const w = o.createWorker();
    w.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      p.resolve(e.data);
    };
    w.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(e.message || 'kernel worker failed')); pending.clear(); };
    return w;
  });
  const run = (w: PoolWorker, job: JobBody, transfer: Transferable[] = []) => new Promise<Uint8Array | undefined>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve: (r) => (r.ok ? resolve(r.out) : reject(new Error('error' in r ? r.error : 'kernel worker failed'))), reject });
    w.postMessage({ ...job, id }, transfer);
  });
  const backends = await Promise.all(workers.map((w) => new Promise<string>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve: (r) => (r.ok ? resolve(r.backend ?? 'typescript') : reject(new Error('error' in r ? r.error : 'kernel worker failed'))), reject });
    const wasm = o.wasm ? o.wasm.slice().buffer : undefined;
    w.postMessage({ type: 'init', id, wasm }, wasm ? [wasm] : []);
  })));

  /** Split [0, total) into at most `size` 64-byte-aligned ranges of at least `min` bytes. */
  const ranges = (total: number, min: number) => {
    const parts = Math.max(1, Math.min(size, Math.floor(total / min)));
    const per = Math.ceil(total / parts / 64) * 64;
    const out: Array<[number, number]> = [];
    for (let at = 0; at < total; at += per) out.push([at, Math.min(at + per, total)]);
    return out.length ? out : [[0, 0] as [number, number]];
  };

  return {
    size,
    backends,
    async gfMatmul(coeffs, rows, k, inputs, len) {
      if (inputs.length !== k * len || coeffs.length !== rows * k) throw new Error('kernel pool gfMatmul: shape mismatch');
      const out = new Uint8Array(rows * len);
      if (!len) return out;
      await Promise.all(ranges(len, MIN_SLICE).map(async ([a, b], i) => {
        const part = b - a;
        const slice = new Uint8Array(k * part);
        for (let j = 0; j < k; j++) slice.set(inputs.subarray(j * len + a, j * len + b), j * part);
        const r = (await run(workers[i], { type: 'gf', coeffs: coeffs.slice(), rows, k, inputs: slice, len: part }, [slice.buffer]))!;
        for (let row = 0; row < rows; row++) out.set(r.subarray(row * part, (row + 1) * part), row * len + a);
      }));
      return out;
    },
    async sha256Chunks(bytes, chunk) {
      if (!(chunk > 0)) throw new Error('kernel pool sha256Chunks: chunk must be positive');
      const n = Math.ceil(bytes.length / chunk);
      if (!n) return [];
      // Whole chunks per worker, contiguous, so each worker's digests land in order.
      const perWorker = Math.max(1, Math.ceil(n / size), Math.ceil(MIN_SLICE / chunk));
      const jobs: Array<Promise<Uint8Array>> = [];
      for (let c = 0, i = 0; c < n; c += perWorker, i++) {
        const slice = bytes.slice(c * chunk, Math.min((c + perWorker) * chunk, bytes.length));
        jobs.push(run(workers[i % size], { type: 'sha', data: slice, chunk }, [slice.buffer]).then((r) => r!));
      }
      const digests: Uint8Array[] = [];
      for (const r of await Promise.all(jobs)) for (let at = 0; at < r.length; at += 32) digests.push(r.subarray(at, at + 32));
      return digests;
    },
    close() { for (const w of workers) w.terminate(); },
  };
}

const hex = (d: Uint8Array) => Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');

/** rsEncode on every core: same shards and descriptor. */
export async function rsEncodeParallel(data: Uint8Array, k: number, m: number, pool: KernelPool): Promise<RsEncoded> {
  if (!Number.isInteger(k) || !Number.isInteger(m) || k < 1 || m < 0 || k + m > 256) throw new Error(`reed-solomon: need 1 <= k, 0 <= m, k + m <= 256 (got k=${k}, m=${m})`);
  const shardSize = Math.max(1, Math.ceil(data.length / k));
  const stripe = new Uint8Array((k + m) * shardSize);
  stripe.set(data);
  if (m > 0) {
    const coeffs = new Uint8Array(m * k);
    encodingMatrix(k, m).slice(k).forEach((row, r) => coeffs.set(row, r * k));
    stripe.set(await pool.gfMatmul(coeffs, m, k, stripe.subarray(0, k * shardSize), shardSize), k * shardSize);
  }
  const shards = Array.from({ length: k + m }, (_, i) => stripe.subarray(i * shardSize, (i + 1) * shardSize));
  const shardHashes = (await pool.sha256Chunks(stripe, shardSize)).map(hex);
  return { descriptor: { scheme: RS_SCHEME, v: 1, k, m, size: data.length, shardSize, shardHashes }, shards };
}

/** rsDecode on every core: same result. */
export async function rsDecodeParallel(shards: (Uint8Array | null | undefined)[], d: RsDescriptor, pool: KernelPool): Promise<RsDecodeResult> {
  if (d.scheme !== RS_SCHEME || d.v !== 1) throw new Error(`reed-solomon: unknown scheme ${d.scheme} v${d.v}`);
  const { k, m, shardSize } = d;
  const present: number[] = [];
  for (let i = 0; i < k + m; i++) if (shards[i]?.length === shardSize) present.push(i);
  const pool2 = new Uint8Array(present.length * shardSize);
  present.forEach((i, j) => pool2.set(shards[i] as Uint8Array, j * shardSize));
  const digests = await pool.sha256Chunks(pool2, shardSize);
  const slot = new Map<number, number>();
  present.forEach((i, j) => { if (hex(digests[j]) === d.shardHashes[i]) slot.set(i, j); });
  const lost = [...Array(k + m).keys()].filter((i) => !slot.has(i));
  if (slot.size < k) throw new Error(`reed-solomon: ${slot.size} intact shards, need ${k}`);
  const shard = (i: number) => pool2.subarray(slot.get(i)! * shardSize, (slot.get(i)! + 1) * shardSize);
  const out = new Uint8Array(k * shardSize);
  const missingData = lost.filter((i) => i < k);
  for (let i = 0; i < k; i++) if (slot.has(i)) out.set(shard(i), i * shardSize);
  if (missingData.length) {
    const use = [...slot.keys()].sort((a, b) => a - b).slice(0, k);
    const inv = gfInvert(use.map((i) => encodingMatrix(k, m)[i]));
    const coeffs = new Uint8Array(missingData.length * k);
    missingData.forEach((i, r) => coeffs.set(inv[i], r * k));
    const inputs = new Uint8Array(k * shardSize);
    use.forEach((i, j) => inputs.set(shard(i), j * shardSize));
    const rebuilt = await pool.gfMatmul(coeffs, missingData.length, k, inputs, shardSize);
    missingData.forEach((i, r) => out.set(rebuilt.subarray(r * shardSize, (r + 1) * shardSize), i * shardSize));
  }
  return { data: out.subarray(0, d.size), lost };
}
