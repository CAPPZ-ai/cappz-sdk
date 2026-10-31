/**
 * COPE node crystallized.
 * Node ID: v15-14-00-native-kernels
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * The SDK's compute kernels (packages/cappz-native, Rust) behind one
 * interface, from the fastest backend the runtime can load:
 *
 *   native     — the C ABI library through node:ffi, Deno.dlopen or bun:ffi
 *                (NEON GF kernel, ARMv8 SHA-256 instructions, all cores)
 *   wasm       — the same crate as WebAssembly with SIMD128, verified against
 *                its provenance manifest (sha256) before it is instantiated
 *   typescript — portable code, always available
 *
 * Every backend produces byte-identical results (src/test/native-kernels.test.ts);
 * only speed differs. Nothing requires a native build: without one the SDK
 * runs the TypeScript kernels.
 */
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import * as secp from '@noble/secp256k1';
import { ed25519 } from '@noble/curves/ed25519';
import { CAPPZ_NATIVE_WASM_MANIFEST_DATA } from './wasm/cappz-native.manifest';
import { GF_EXP, GF_LOG } from './gf256';

export type NativeBackend = 'native' | 'wasm' | 'typescript';

export interface NativeManifest { artifact: string; crate: string; version: string; target: string; sha256: string; build: string }
export const CAPPZ_NATIVE_WASM_MANIFEST: NativeManifest = CAPPZ_NATIVE_WASM_MANIFEST_DATA;

export interface NativeKernels {
  backend: NativeBackend;
  /** simd: NEON / SIMD128 GF kernel; shaInstructions: ARMv8 SHA-256; threads: multicore kernels. */
  features: { simd: boolean; shaInstructions: boolean; threads: boolean };
  /**
   * Reed-Solomon kernel: `out[r] = XOR_j coeffs[r*k + j] * in[j]` in GF(2^8).
   * `inputs` holds `k` shards of `len` bytes back to back; returns `rows` shards
   * back to back, written into `out` when given (it must hold `rows * len`
   * bytes and not overlap `inputs`). `threads` 0 (default) uses every core
   * where threads exist.
   */
  gfMatmul(coeffs: Uint8Array, rows: number, k: number, inputs: Uint8Array, len: number, threads?: number, out?: Uint8Array): Uint8Array;
  sha256(bytes: Uint8Array): Uint8Array;
  /** SHA-256 of each `chunk`-byte piece (the last may be shorter). */
  sha256Chunks(bytes: Uint8Array, chunk: number, threads?: number): Uint8Array[];
  /** Incremental SHA-256 for input that arrives in pieces (a file read slice by slice). */
  sha256Stream(): Sha256Stream;
  /**
   * Feed the same piece to two streams of these kernels at once (native: on
   * two cores). Absent where it would not be faster; call `update` on each then.
   */
  sha256UpdatePair?(a: Sha256Stream, b: Sha256Stream, bytes: Uint8Array): void;
  /** secp256k1 ECDSA over 32-byte digests, compact r||s, low-S only. One result per item, in order. */
  secp256k1VerifyMany(items: readonly Secp256k1Item[], threads?: number): boolean[];
  /** Ed25519, strict (RFC 8032; non-canonical encodings and small-order keys refused). */
  ed25519VerifyMany(items: readonly Ed25519Item[], threads?: number): boolean[];
}

export interface Secp256k1Item { digest: Uint8Array; signature: Uint8Array; publicKey: Uint8Array }
export interface Ed25519Item { message: Uint8Array; signature: Uint8Array; publicKey: Uint8Array }

/** Items whose sizes are wrong can never verify; they are answered false without reaching the kernel. */
const secpShapeOk = (i: Secp256k1Item) => i.digest.length === 32 && i.signature.length === 64 && (i.publicKey.length === 33 || i.publicKey.length === 65);
const edShapeOk = (i: Ed25519Item) => i.signature.length === 64 && i.publicKey.length === 32;

/** Run `verify` on the well-formed items (grouped by `group`), false for the rest, results in input order. */
function verifyGrouped<T>(items: readonly T[], ok: (i: T) => boolean, group: (i: T) => number, verify: (batch: T[]) => boolean[]): boolean[] {
  const out = new Array<boolean>(items.length).fill(false);
  const groups = new Map<number, number[]>();
  items.forEach((it, i) => { if (ok(it)) { const g = group(it); (groups.get(g) ?? groups.set(g, []).get(g)!).push(i); } });
  for (const idx of groups.values()) verify(idx.map((i) => items[i])).forEach((r, j) => { out[idx[j]] = r; });
  return out;
}
function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
/** Keys, signatures and messages back to back; offsets as little-endian u32 bytes (n + 1 of them). */
function edPack(batch: readonly Ed25519Item[]): { keys: Uint8Array; sigs: Uint8Array; msgs: Uint8Array; offsets: Uint8Array } {
  const offsets = new Uint8Array(4 * (batch.length + 1));
  const view = new DataView(offsets.buffer);
  let at = 0;
  batch.forEach((b, i) => { at += b.message.length; view.setUint32(4 * (i + 1), at, true); });
  return { keys: concat(batch.map((b) => b.publicKey)), sigs: concat(batch.map((b) => b.signature)), msgs: concat(batch.map((b) => b.message)), offsets };
}

/** Feed pieces in order with `update`, then call `digest` once. */
export interface Sha256Stream {
  update(bytes: Uint8Array): void;
  digest(): Uint8Array;
}

const ABI = 3;
const ERRORS: Record<number, string> = { [-1]: 'null pointer', [-2]: 'bad shape', [-3]: 'not a live sha256 state' };
function check(status: number, op: string): void {
  if (status !== 0) throw new Error(`cappz-native ${op}: ${ERRORS[status] ?? `status ${status}`}`);
}
function decodeFeatures(f: number): NativeKernels['features'] {
  return { simd: (f & 1) !== 0, shaInstructions: (f & 2) !== 0, threads: (f & 4) !== 0 };
}
function outputFor(coeffs: Uint8Array, rows: number, k: number, inputs: Uint8Array, len: number, out?: Uint8Array): Uint8Array {
  if (!(rows > 0 && rows < 256 && k > 0 && k < 256) || coeffs.length !== rows * k || inputs.length !== k * len) {
    throw new Error(`cappz-native gfMatmul: expected ${rows}x${k} coeffs and ${k} shards of ${len} bytes`);
  }
  if (!out) return new Uint8Array(rows * len);
  const overlaps = out.buffer === inputs.buffer && out.byteOffset < inputs.byteOffset + inputs.byteLength && inputs.byteOffset < out.byteOffset + out.byteLength;
  if (out.length !== rows * len || overlaps) throw new Error(`cappz-native gfMatmul: expected a separate ${rows * len}-byte output`);
  return out;
}
function splitDigests(out: Uint8Array): Uint8Array[] {
  const list: Uint8Array[] = [];
  for (let at = 0; at < out.length; at += 32) list.push(out.subarray(at, at + 32));
  return list;
}

// ─── TypeScript ─────────────────────────────────────────────────────────

/** Products of one coefficient with every byte: the portable kernel's lookup row. */
function productRow(c: number): Uint8Array {
  const row = new Uint8Array(256);
  if (c === 0) return row;
  const lc = GF_LOG[c];
  for (let x = 1; x < 256; x++) row[x] = GF_EXP[lc + GF_LOG[x]];
  return row;
}

export const typescriptKernels: NativeKernels = {
  backend: 'typescript',
  features: { simd: false, shaInstructions: false, threads: false },
  gfMatmul(coeffs, rows, k, inputs, len, _threads, into) {
    const out = outputFor(coeffs, rows, k, inputs, len, into);
    out.fill(0);
    for (let r = 0; r < rows; r++) {
      const o = out.subarray(r * len, (r + 1) * len);
      for (let j = 0; j < k; j++) {
        const c = coeffs[r * k + j];
        if (c === 0) continue;
        const row = productRow(c);
        const src = inputs.subarray(j * len, (j + 1) * len);
        for (let i = 0; i < len; i++) o[i] ^= row[src[i]];
      }
    }
    return out;
  },
  sha256: (bytes) => nobleSha256(bytes),
  sha256Chunks(bytes, chunk) {
    if (!(chunk > 0)) throw new Error('cappz-native sha256Chunks: chunk must be positive');
    const list: Uint8Array[] = [];
    for (let at = 0; at < bytes.length; at += chunk) list.push(nobleSha256(bytes.subarray(at, at + chunk)));
    return list;
  },
  sha256Stream() {
    const h = nobleSha256.create();
    return { update: (b) => { h.update(b); }, digest: () => h.digest() };
  },
  secp256k1VerifyMany: (items) => items.map((i) => {
    if (!secpShapeOk(i)) return false;
    try { return secp.verify(i.signature, i.digest, i.publicKey, { prehash: false, lowS: true }); } catch { return false; }
  }),
  ed25519VerifyMany: (items) => items.map((i) => {
    if (!edShapeOk(i)) return false;
    try { return ed25519.verify(i.signature, i.message, i.publicKey, { zip215: false }); } catch { return false; }
  }),
};

// ─── Native library (C ABI) ─────────────────────────────────────────────

/** The library file name for this platform: cappz_native.dll, libcappz_native.so / .dylib. */
export function nativeLibraryName(platform = (globalThis as { process?: { platform?: string } }).process?.platform ?? (globalThis as { Deno?: { build?: { os?: string } } }).Deno?.build?.os): string {
  if (platform === 'win32' || platform === 'windows') return 'cappz_native.dll';
  if (platform === 'darwin') return 'libcappz_native.dylib';
  return 'libcappz_native.so';
}

interface CFunctions {
  abi(): number;
  features(): number;
  gfMatmul(coeffs: Uint8Array, rows: number, k: number, inputs: Uint8Array, outputs: Uint8Array, len: number, threads: number): number;
  sha256(data: Uint8Array, len: number, out: Uint8Array): number;
  sha256Chunks(data: Uint8Array, len: number, chunk: number, out: Uint8Array, threads: number): number;
  sha256StateBytes(): number;
  sha256Begin(state: Uint8Array): number;
  sha256Update(state: Uint8Array, data: Uint8Array, len: number): number;
  sha256Finish(state: Uint8Array, out: Uint8Array): number;
  sha256UpdatePair(a: Uint8Array, b: Uint8Array, data: Uint8Array, len: number): number;
  secp256k1VerifyBatch(n: number, keys: Uint8Array, keyLen: number, sigs: Uint8Array, digests: Uint8Array, out: Uint8Array, threads: number): number;
  ed25519VerifyBatch(n: number, keys: Uint8Array, sigs: Uint8Array, msgs: Uint8Array, msgsLen: number, offsets: Uint8Array, out: Uint8Array, threads: number): number;
}

function kernelsFromC(c: CFunctions): NativeKernels {
  if (c.abi() !== ABI) throw new Error(`cappz-native ABI ${c.abi()} does not match ${ABI}; rebuild packages/cappz-native`);
  const stateBytes = c.sha256StateBytes();
  const states = new WeakMap<Sha256Stream, Uint8Array>();
  return {
    backend: 'native',
    features: decodeFeatures(c.features()),
    gfMatmul(coeffs, rows, k, inputs, len, threads = 0, into) {
      const out = outputFor(coeffs, rows, k, inputs, len, into);
      if (len > 0) check(c.gfMatmul(coeffs, rows, k, inputs, out, len, threads), 'gfMatmul');
      return out;
    },
    sha256(bytes) {
      const out = new Uint8Array(32);
      // A zero-length typed array may not have a backing pointer.
      check(c.sha256(bytes.length ? bytes : new Uint8Array(1), bytes.length, out), 'sha256');
      return out;
    },
    sha256Chunks(bytes, chunk, threads = 0) {
      if (!(chunk > 0)) throw new Error('cappz-native sha256Chunks: chunk must be positive');
      const out = new Uint8Array(Math.ceil(bytes.length / chunk) * 32);
      if (bytes.length) check(c.sha256Chunks(bytes, bytes.length, chunk, out, threads), 'sha256Chunks');
      return splitDigests(out);
    },
    sha256Stream() {
      // The state lives in JS memory; the library reads and rewrites it on each call.
      const state = new Uint8Array(stateBytes);
      check(c.sha256Begin(state), 'sha256Stream');
      const stream: Sha256Stream = {
        update(bytes) { if (bytes.length) check(c.sha256Update(state, bytes, bytes.length), 'sha256Stream.update'); },
        digest() { const out = new Uint8Array(32); check(c.sha256Finish(state, out), 'sha256Stream.digest'); return out; },
      };
      states.set(stream, state);
      return stream;
    },
    sha256UpdatePair(a, b, bytes) {
      const sa = states.get(a), sb = states.get(b);
      if (!sa || !sb || sa === sb) throw new Error('cappz-native sha256UpdatePair: needs two different streams from these kernels');
      if (bytes.length) check(c.sha256UpdatePair(sa, sb, bytes, bytes.length), 'sha256UpdatePair');
    },
    secp256k1VerifyMany(items, threads = 0) {
      return verifyGrouped(items, secpShapeOk, (i) => i.publicKey.length, (batch) => {
        const out = new Uint8Array(batch.length);
        check(c.secp256k1VerifyBatch(batch.length, concat(batch.map((b) => b.publicKey)), batch[0].publicKey.length, concat(batch.map((b) => b.signature)), concat(batch.map((b) => b.digest)), out, threads), 'secp256k1VerifyMany');
        return Array.from(out, (v) => v === 1);
      });
    },
    ed25519VerifyMany(items, threads = 0) {
      return verifyGrouped(items, edShapeOk, () => 0, (batch) => {
        const p = edPack(batch);
        const out = new Uint8Array(batch.length);
        // A zero-length typed array may not have a backing pointer.
        check(c.ed25519VerifyBatch(batch.length, p.keys, p.sigs, p.msgs.length ? p.msgs : new Uint8Array(1), p.msgs.length, p.offsets, out, threads), 'ed25519VerifyMany');
        return Array.from(out, (v) => v === 1);
      });
    },
  };
}

type NodeFfi = { dlopen(path: string, defs: Record<string, { arguments: string[]; return: string }>): { functions: Record<string, (...a: unknown[]) => number> } };
type DenoFfi = { dlopen(path: string, defs: Record<string, { parameters: string[]; result: string }>): { symbols: Record<string, (...a: unknown[]) => number | bigint> } };

/** node:ffi (Node ≥ 26, experimental), reached without a module specifier so bundlers and test runners never try to resolve it. */
export function nodeFfi(): NodeFfi | null {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  try { return (proc?.getBuiltinModule?.('node:ffi') as NodeFfi | undefined) ?? null; } catch { return null; }
}

function openNode(path: string): CFunctions {
  const ffi = nodeFfi();
  if (!ffi) throw new Error('this runtime has no FFI (node:ffi needs Node 26+)');
  const P = 'buffer', U32 = 'uint32', U64 = 'uint64', I32 = 'int32';
  const { functions: f } = ffi.dlopen(path, {
    cappz_native_abi: { arguments: [], return: U32 },
    cappz_native_features: { arguments: [], return: U32 },
    cappz_gf_matmul: { arguments: [P, U32, U32, P, P, U64, U32], return: I32 },
    cappz_sha256: { arguments: [P, U64, P], return: I32 },
    cappz_sha256_chunks: { arguments: [P, U64, U64, P, U32], return: I32 },
    cappz_sha256_state_bytes: { arguments: [], return: U32 },
    cappz_sha256_begin: { arguments: [P], return: I32 },
    cappz_sha256_update: { arguments: [P, P, U64], return: I32 },
    cappz_sha256_finish: { arguments: [P, P], return: I32 },
    cappz_sha256_update_pair: { arguments: [P, P, P, U64], return: I32 },
    cappz_secp256k1_verify_batch: { arguments: [U32, P, U32, P, P, P, U32], return: I32 },
    cappz_ed25519_verify_batch: { arguments: [U32, P, P, P, U64, P, P, U32], return: I32 },
  });
  const n = (v: number) => BigInt(v);
  return {
    abi: () => Number(f.cappz_native_abi()),
    features: () => Number(f.cappz_native_features()),
    gfMatmul: (c, rows, k, i, o, len, t) => Number(f.cappz_gf_matmul(c, rows, k, i, o, n(len), t)),
    sha256: (d, len, o) => Number(f.cappz_sha256(d, n(len), o)),
    sha256Chunks: (d, len, chunk, o, t) => Number(f.cappz_sha256_chunks(d, n(len), n(chunk), o, t)),
    sha256StateBytes: () => Number(f.cappz_sha256_state_bytes()),
    sha256Begin: (st) => Number(f.cappz_sha256_begin(st)),
    sha256Update: (st, d, len) => Number(f.cappz_sha256_update(st, d, n(len))),
    sha256Finish: (st, o) => Number(f.cappz_sha256_finish(st, o)),
    sha256UpdatePair: (a, b, d, len) => Number(f.cappz_sha256_update_pair(a, b, d, n(len))),
    secp256k1VerifyBatch: (cnt, k, kl, sg, dg, o, t) => Number(f.cappz_secp256k1_verify_batch(cnt, k, kl, sg, dg, o, t)),
    ed25519VerifyBatch: (cnt, k, sg, m, ml, off, o, t) => Number(f.cappz_ed25519_verify_batch(cnt, k, sg, m, n(ml), off, o, t)),
  };
}

function openDeno(deno: DenoFfi, path: string): CFunctions {
  const { symbols: s } = deno.dlopen(path, {
    cappz_native_abi: { parameters: [], result: 'u32' },
    cappz_native_features: { parameters: [], result: 'u32' },
    cappz_gf_matmul: { parameters: ['buffer', 'u32', 'u32', 'buffer', 'buffer', 'usize', 'u32'], result: 'i32' },
    cappz_sha256: { parameters: ['buffer', 'usize', 'buffer'], result: 'i32' },
    cappz_sha256_chunks: { parameters: ['buffer', 'usize', 'usize', 'buffer', 'u32'], result: 'i32' },
    cappz_sha256_state_bytes: { parameters: [], result: 'u32' },
    cappz_sha256_begin: { parameters: ['buffer'], result: 'i32' },
    cappz_sha256_update: { parameters: ['buffer', 'buffer', 'usize'], result: 'i32' },
    cappz_sha256_finish: { parameters: ['buffer', 'buffer'], result: 'i32' },
    cappz_sha256_update_pair: { parameters: ['buffer', 'buffer', 'buffer', 'usize'], result: 'i32' },
    cappz_secp256k1_verify_batch: { parameters: ['u32', 'buffer', 'u32', 'buffer', 'buffer', 'buffer', 'u32'], result: 'i32' },
    cappz_ed25519_verify_batch: { parameters: ['u32', 'buffer', 'buffer', 'buffer', 'usize', 'buffer', 'buffer', 'u32'], result: 'i32' },
  });
  const n = (v: number) => BigInt(v);
  return {
    abi: () => Number(s.cappz_native_abi()),
    features: () => Number(s.cappz_native_features()),
    gfMatmul: (c, rows, k, i, o, len, t) => Number(s.cappz_gf_matmul(c, rows, k, i, o, n(len), t)),
    sha256: (d, len, o) => Number(s.cappz_sha256(d, n(len), o)),
    sha256Chunks: (d, len, chunk, o, t) => Number(s.cappz_sha256_chunks(d, n(len), n(chunk), o, t)),
    sha256StateBytes: () => Number(s.cappz_sha256_state_bytes()),
    sha256Begin: (st) => Number(s.cappz_sha256_begin(st)),
    sha256Update: (st, d, len) => Number(s.cappz_sha256_update(st, d, n(len))),
    sha256Finish: (st, o) => Number(s.cappz_sha256_finish(st, o)),
    sha256UpdatePair: (a, b, d, len) => Number(s.cappz_sha256_update_pair(a, b, d, n(len))),
    secp256k1VerifyBatch: (cnt, k, kl, sg, dg, o, t) => Number(s.cappz_secp256k1_verify_batch(cnt, k, kl, sg, dg, o, t)),
    ed25519VerifyBatch: (cnt, k, sg, m, ml, off, o, t) => Number(s.cappz_ed25519_verify_batch(cnt, k, sg, m, n(ml), off, o, t)),
  };
}

async function openBun(path: string): Promise<CFunctions> {
  type BunFfi = { dlopen(p: string, d: Record<string, { args: string[]; returns: string }>): { symbols: Record<string, (...a: unknown[]) => number> }; ptr(a: Uint8Array): number };
  const ffi = (await import(/* @vite-ignore */ ['bun', 'ffi'].join(':'))) as BunFfi;
  const { symbols: s } = ffi.dlopen(path, {
    cappz_native_abi: { args: [], returns: 'u32' },
    cappz_native_features: { args: [], returns: 'u32' },
    cappz_gf_matmul: { args: ['ptr', 'u32', 'u32', 'ptr', 'ptr', 'usize', 'u32'], returns: 'i32' },
    cappz_sha256: { args: ['ptr', 'usize', 'ptr'], returns: 'i32' },
    cappz_sha256_chunks: { args: ['ptr', 'usize', 'usize', 'ptr', 'u32'], returns: 'i32' },
    cappz_sha256_state_bytes: { args: [], returns: 'u32' },
    cappz_sha256_begin: { args: ['ptr'], returns: 'i32' },
    cappz_sha256_update: { args: ['ptr', 'ptr', 'usize'], returns: 'i32' },
    cappz_sha256_finish: { args: ['ptr', 'ptr'], returns: 'i32' },
    cappz_sha256_update_pair: { args: ['ptr', 'ptr', 'ptr', 'usize'], returns: 'i32' },
    cappz_secp256k1_verify_batch: { args: ['u32', 'ptr', 'u32', 'ptr', 'ptr', 'ptr', 'u32'], returns: 'i32' },
    cappz_ed25519_verify_batch: { args: ['u32', 'ptr', 'ptr', 'ptr', 'usize', 'ptr', 'ptr', 'u32'], returns: 'i32' },
  });
  const p = ffi.ptr;
  return {
    abi: () => s.cappz_native_abi(),
    features: () => s.cappz_native_features(),
    gfMatmul: (c, rows, k, i, o, len, t) => s.cappz_gf_matmul(p(c), rows, k, p(i), p(o), len, t),
    sha256: (d, len, o) => s.cappz_sha256(p(d), len, p(o)),
    sha256Chunks: (d, len, chunk, o, t) => s.cappz_sha256_chunks(p(d), len, chunk, p(o), t),
    sha256StateBytes: () => s.cappz_sha256_state_bytes(),
    sha256Begin: (st) => s.cappz_sha256_begin(p(st)),
    sha256Update: (st, d, len) => s.cappz_sha256_update(p(st), p(d), len),
    sha256Finish: (st, o) => s.cappz_sha256_finish(p(st), p(o)),
    sha256UpdatePair: (a, b, d, len) => s.cappz_sha256_update_pair(p(a), p(b), p(d), len),
    secp256k1VerifyBatch: (cnt, k, kl, sg, dg, o, t) => s.cappz_secp256k1_verify_batch(cnt, p(k), kl, p(sg), p(dg), p(o), t),
    ed25519VerifyBatch: (cnt, k, sg, m, ml, off, o, t) => s.cappz_ed25519_verify_batch(cnt, p(k), p(sg), p(m), ml, p(off), p(o), t),
  };
}

/** Load the native library at `path` with whichever FFI this runtime has. */
export async function loadNativeLibrary(path: string): Promise<NativeKernels> {
  const g = globalThis as { Deno?: DenoFfi; Bun?: unknown };
  if (g.Deno?.dlopen) return kernelsFromC(openDeno(g.Deno, path));
  if (g.Bun) return kernelsFromC(await openBun(path));
  return kernelsFromC(openNode(path));
}

// ─── WebAssembly ────────────────────────────────────────────────────────

interface WasmExports {
  memory: WebAssembly.Memory;
  cappz_native_abi(): number;
  cappz_native_features(): number;
  cappz_alloc(len: number): number;
  cappz_free(ptr: number, len: number): void;
  cappz_gf_matmul(coeffs: number, rows: number, k: number, inputs: number, outputs: number, len: number, threads: number): number;
  cappz_sha256(data: number, len: number, out: number): number;
  cappz_sha256_chunks(data: number, len: number, chunk: number, out: number, threads: number): number;
  cappz_sha256_state_bytes(): number;
  cappz_sha256_begin(state: number): number;
  cappz_sha256_update(state: number, data: number, len: number): number;
  cappz_sha256_finish(state: number, out: number): number;
  cappz_secp256k1_verify_batch(n: number, keys: number, keyLen: number, sigs: number, digests: number, out: number, threads: number): number;
  cappz_ed25519_verify_batch(n: number, keys: number, sigs: number, msgs: number, msgsLen: number, offsets: number, out: number, threads: number): number;
}

async function sha256HexOf(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength); copy.set(bytes);
  const d = await crypto.subtle.digest('SHA-256', copy.buffer);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Instantiate the WASM build after verifying its bytes against the manifest. */
export async function loadWasmKernels(bytes: Uint8Array, expected = CAPPZ_NATIVE_WASM_MANIFEST.sha256): Promise<NativeKernels> {
  const actual = await sha256HexOf(bytes);
  if (actual !== expected) throw new Error(`cappz-native wasm integrity check failed: expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…`);
  const { instance } = (await WebAssembly.instantiate(bytes as BufferSource, {})) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
  const x = instance.exports as unknown as WasmExports;
  if (x.cappz_native_abi() !== ABI) throw new Error('cappz-native wasm ABI mismatch');

  /** Copy `inputs` in, run `fn` with their pointers plus `outLen` bytes of output, copy the output out, free all. */
  const call = (inputs: Uint8Array[], outLen: number, fn: (ptrs: number[], out: number) => number, op: string): Uint8Array => {
    const ptrs = inputs.map((b) => x.cappz_alloc(b.length));
    const out = x.cappz_alloc(outLen);
    try {
      // Allocation can grow memory, so take the view afterwards.
      const mem = new Uint8Array(x.memory.buffer);
      inputs.forEach((b, i) => mem.set(b, ptrs[i]));
      check(fn(ptrs, out), op);
      return new Uint8Array(x.memory.buffer, out, outLen).slice();
    } finally {
      inputs.forEach((b, i) => x.cappz_free(ptrs[i], b.length));
      x.cappz_free(out, outLen);
    }
  };

  return {
    backend: 'wasm',
    features: decodeFeatures(x.cappz_native_features()),
    gfMatmul(coeffs, rows, k, inputs, len, _threads, into) {
      const out = outputFor(coeffs, rows, k, inputs, len, into);
      if (len === 0) return out;
      out.set(call([coeffs, inputs], rows * len, ([c, i], o) => x.cappz_gf_matmul(c, rows, k, i, o, len, 1), 'gfMatmul'));
      return out;
    },
    sha256(bytes) {
      return call([bytes], 32, ([d], o) => x.cappz_sha256(d, bytes.length, o), 'sha256');
    },
    sha256Chunks(bytes, chunk) {
      if (!(chunk > 0)) throw new Error('cappz-native sha256Chunks: chunk must be positive');
      if (!bytes.length) return [];
      const n = Math.ceil(bytes.length / chunk);
      return splitDigests(call([bytes], n * 32, ([d], o) => x.cappz_sha256_chunks(d, bytes.length, chunk, o, 1), 'sha256Chunks'));
    },
    sha256Stream() {
      // The state lives in module memory until digest() frees it.
      const size = x.cappz_sha256_state_bytes();
      let state = x.cappz_alloc(size);
      check(x.cappz_sha256_begin(state), 'sha256Stream');
      const live = () => { if (!state) throw new Error('cappz-native sha256Stream: digest() was already called'); return state; };
      return {
        update(bytes) {
          if (!bytes.length) return;
          const st = live();
          const ptr = x.cappz_alloc(bytes.length);
          try {
            new Uint8Array(x.memory.buffer).set(bytes, ptr);
            check(x.cappz_sha256_update(st, ptr, bytes.length), 'sha256Stream.update');
          } finally { x.cappz_free(ptr, bytes.length); }
        },
        digest() {
          const st = live();
          try { return call([], 32, (_, o) => x.cappz_sha256_finish(st, o), 'sha256Stream.digest'); }
          finally { x.cappz_free(st, size); state = 0; }
        },
      };
    },
    secp256k1VerifyMany(items) {
      return verifyGrouped(items, secpShapeOk, (i) => i.publicKey.length, (batch) => {
        const kl = batch[0].publicKey.length;
        const out = call([concat(batch.map((b) => b.publicKey)), concat(batch.map((b) => b.signature)), concat(batch.map((b) => b.digest))], batch.length,
          ([k, sg, dg], o) => x.cappz_secp256k1_verify_batch(batch.length, k, kl, sg, dg, o, 1), 'secp256k1VerifyMany');
        return Array.from(out, (v) => v === 1);
      });
    },
    ed25519VerifyMany(items) {
      return verifyGrouped(items, edShapeOk, () => 0, (batch) => {
        const pk = edPack(batch);
        const out = call([pk.keys, pk.sigs, pk.msgs, pk.offsets], batch.length,
          ([k, sg, m, off], o) => x.cappz_ed25519_verify_batch(batch.length, k, sg, m, pk.msgs.length, off, o, 1), 'ed25519VerifyMany');
        return Array.from(out, (v) => v === 1);
      });
    },
  };
}

// ─── Selection ──────────────────────────────────────────────────────────

let active: NativeKernels = typescriptKernels;

/** The kernels the SDK uses right now (TypeScript until something faster is loaded). */
export function activeKernels(): NativeKernels {
  return active;
}

/** Make `kernels` the SDK-wide default (e.g. after loading the native library at startup). */
export function useKernels(kernels: NativeKernels): NativeKernels {
  active = kernels;
  return kernels;
}

export interface LoadKernelsOptions {
  /** Path to the native library; tried first where an FFI exists. */
  libraryPath?: string;
  /** The WASM build's bytes (e.g. fetched from a bundled URL); tried next. */
  wasmBytes?: Uint8Array;
}

/**
 * Load the fastest backend available, make it the SDK default and return it.
 * Failures fall through to the next backend; the TypeScript kernels always load.
 */
export async function loadKernels(o: LoadKernelsOptions = {}): Promise<NativeKernels & { skipped: string[] }> {
  const skipped: string[] = [];
  if (o.libraryPath) {
    try { return { ...useKernels(await loadNativeLibrary(o.libraryPath)), skipped }; }
    catch (err) { skipped.push(`native: ${err instanceof Error ? err.message : String(err)}`); }
  }
  if (o.wasmBytes) {
    try { return { ...useKernels(await loadWasmKernels(o.wasmBytes)), skipped }; }
    catch (err) { skipped.push(`wasm: ${err instanceof Error ? err.message : String(err)}`); }
  }
  return { ...useKernels(typescriptKernels), skipped };
}
