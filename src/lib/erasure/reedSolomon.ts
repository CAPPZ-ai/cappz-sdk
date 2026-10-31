/**
 * COPE node crystallized.
 * Node ID: v15-14-00-reed-solomon
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * Systematic Reed-Solomon erasure coding over GF(2^8): `k` data shards plus
 * `m` parity shards; ANY `k` of the `k + m` rebuild the bytes. The matrix is
 * a Vandermonde matrix made systematic (top `k` rows = identity), so data
 * shards are plain slices of the input and every k-row subset is invertible.
 *
 * Reed-Solomon repairs erasures, not errors: a corrupted shard used as if it
 * were good corrupts the output silently. Every shard's sha256 is therefore
 * recorded in the descriptor and checked before use, turning corruption into
 * a detectable erasure.
 *
 * Bulk math runs on the active kernels (src/lib/native/cappzNative.ts):
 * NEON + all cores natively, SIMD128 in browsers, TypeScript otherwise.
 */
import { activeKernels, type NativeKernels } from '../native/cappzNative';
import { gfInvert, gfMatMul, gfPow, type GfMatrix } from '../native/gf256';

export const RS_SCHEME = 'rs-vandermonde-systematic-gf256-0x11d' as const;

export interface RsDescriptor {
  scheme: typeof RS_SCHEME;
  v: 1;
  k: number;
  m: number;
  /** Original byte length (the last data shard is zero-padded). */
  size: number;
  shardSize: number;
  /** sha256 hex of each of the k + m shards, data shards first. */
  shardHashes: string[];
}

export interface RsEncoded { descriptor: RsDescriptor; shards: Uint8Array[] }

const hex = (d: Uint8Array) => Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');

const matrices = new Map<string, GfMatrix>();
/** The (k + m) x k encoding matrix; rows 0..k-1 are the identity. */
export function encodingMatrix(k: number, m: number): GfMatrix {
  const key = `${k}/${m}`;
  let mat = matrices.get(key);
  if (!mat) {
    const v: GfMatrix = Array.from({ length: k + m }, (_, r) => Uint8Array.from({ length: k }, (_, c) => gfPow(r, c)));
    mat = gfMatMul(v, gfInvert(v.slice(0, k)));
    matrices.set(key, mat);
  }
  return mat;
}

function checkParams(k: number, m: number): void {
  if (!Number.isInteger(k) || !Number.isInteger(m) || k < 1 || m < 0 || k + m > 256) {
    throw new Error(`reed-solomon: need 1 <= k, 0 <= m, k + m <= 256 (got k=${k}, m=${m})`);
  }
}

/** Split `data` into `k` data shards and compute `m` parity shards. */
export function rsEncode(data: Uint8Array, k: number, m: number, kernels: NativeKernels = activeKernels()): RsEncoded {
  checkParams(k, m);
  const shardSize = Math.max(1, Math.ceil(data.length / k));
  // One contiguous stripe: k data shards then m parity shards.
  const stripe = new Uint8Array((k + m) * shardSize);
  stripe.set(data);
  if (m > 0) {
    const coeffs = new Uint8Array(m * k);
    encodingMatrix(k, m).slice(k).forEach((row, r) => coeffs.set(row, r * k));
    kernels.gfMatmul(coeffs, m, k, stripe.subarray(0, k * shardSize), shardSize, 0, stripe.subarray(k * shardSize));
  }
  const shards = Array.from({ length: k + m }, (_, i) => stripe.subarray(i * shardSize, (i + 1) * shardSize));
  const shardHashes = kernels.sha256Chunks(stripe, shardSize).map(hex);
  return { descriptor: { scheme: RS_SCHEME, v: 1, k, m, size: data.length, shardSize, shardHashes }, shards };
}

export interface RsDecodeResult {
  data: Uint8Array;
  /** Indices treated as lost: absent, wrong length, or failing their hash. */
  lost: number[];
}

/**
 * Rebuild the original bytes from any `k` intact shards (`null` = lost).
 * Throws when fewer than `k` shards survive verification.
 */
export function rsDecode(shards: (Uint8Array | null | undefined)[], d: RsDescriptor, kernels: NativeKernels = activeKernels()): RsDecodeResult {
  if (d.scheme !== RS_SCHEME || d.v !== 1) throw new Error(`reed-solomon: unknown scheme ${d.scheme} v${d.v}`);
  checkParams(d.k, d.m);
  const { k, m, shardSize } = d;
  // Gather the right-sized shards into one buffer so a single (parallel)
  // chunk-hash call verifies them all; the buffer then feeds the kernel.
  const present: number[] = [];
  for (let i = 0; i < k + m; i++) if (shards[i]?.length === shardSize) present.push(i);
  const pool = new Uint8Array(present.length * shardSize);
  present.forEach((i, j) => pool.set(shards[i] as Uint8Array, j * shardSize));
  const digests = kernels.sha256Chunks(pool, shardSize);
  const slot = new Map<number, number>(); // shard index → position in pool
  present.forEach((i, j) => { if (hex(digests[j]) === d.shardHashes[i]) slot.set(i, j); });
  const lost = [...Array(k + m).keys()].filter((i) => !slot.has(i));
  if (slot.size < k) throw new Error(`reed-solomon: ${slot.size} intact shards, need ${k}`);
  const shard = (i: number) => pool.subarray(slot.get(i)! * shardSize, (slot.get(i)! + 1) * shardSize);

  const out = new Uint8Array(k * shardSize);
  const missingData = lost.filter((i) => i < k);
  for (let i = 0; i < k; i++) if (slot.has(i)) out.set(shard(i), i * shardSize);
  if (missingData.length) {
    // Solve with the first k intact rows: data = inv(M[use]) · shards[use].
    const use = [...slot.keys()].sort((a, b) => a - b).slice(0, k);
    const mat = encodingMatrix(k, m);
    const inv = gfInvert(use.map((i) => mat[i]));
    const coeffs = new Uint8Array(missingData.length * k);
    missingData.forEach((i, r) => coeffs.set(inv[i], r * k));
    // Intact data shards sit in index order in the pool, so when `use` is a
    // prefix of it the pool already is the kernel's input.
    const contiguous = use.every((i, j) => slot.get(i) === j);
    const inputs = contiguous ? pool.subarray(0, k * shardSize) : new Uint8Array(k * shardSize);
    if (!contiguous) use.forEach((i, j) => inputs.set(shard(i), j * shardSize));
    const rebuilt = kernels.gfMatmul(coeffs, missingData.length, k, inputs, shardSize);
    missingData.forEach((i, r) => out.set(rebuilt.subarray(r * shardSize, (r + 1) * shardSize), i * shardSize));
  }
  return { data: out.subarray(0, d.size), lost };
}
