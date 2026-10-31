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
import manifest from './wasm/cappz-native.manifest.json';
import { GF_EXP, GF_LOG } from './gf256';

export type NativeBackend = 'native' | 'wasm' | 'typescript';

export interface NativeManifest { artifact: string; crate: string; version: string; target: string; sha256: string; build: string }
export const CAPPZ_NATIVE_WASM_MANIFEST = manifest as NativeManifest;

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
}

const ABI = 1;
const ERRORS: Record<number, string> = { [-1]: 'null pointer', [-2]: 'bad shape' };
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
}

function kernelsFromC(c: CFunctions): NativeKernels {
  if (c.abi() !== ABI) throw new Error(`cappz-native ABI ${c.abi()} does not match ${ABI}; rebuild packages/cappz-native`);
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
  });
  const n = (v: number) => BigInt(v);
  return {
    abi: () => Number(f.cappz_native_abi()),
    features: () => Number(f.cappz_native_features()),
    gfMatmul: (c, rows, k, i, o, len, t) => Number(f.cappz_gf_matmul(c, rows, k, i, o, n(len), t)),
    sha256: (d, len, o) => Number(f.cappz_sha256(d, n(len), o)),
    sha256Chunks: (d, len, chunk, o, t) => Number(f.cappz_sha256_chunks(d, n(len), n(chunk), o, t)),
  };
}

function openDeno(deno: DenoFfi, path: string): CFunctions {
  const { symbols: s } = deno.dlopen(path, {
    cappz_native_abi: { parameters: [], result: 'u32' },
    cappz_native_features: { parameters: [], result: 'u32' },
    cappz_gf_matmul: { parameters: ['buffer', 'u32', 'u32', 'buffer', 'buffer', 'usize', 'u32'], result: 'i32' },
    cappz_sha256: { parameters: ['buffer', 'usize', 'buffer'], result: 'i32' },
    cappz_sha256_chunks: { parameters: ['buffer', 'usize', 'usize', 'buffer', 'u32'], result: 'i32' },
  });
  const n = (v: number) => BigInt(v);
  return {
    abi: () => Number(s.cappz_native_abi()),
    features: () => Number(s.cappz_native_features()),
    gfMatmul: (c, rows, k, i, o, len, t) => Number(s.cappz_gf_matmul(c, rows, k, i, o, n(len), t)),
    sha256: (d, len, o) => Number(s.cappz_sha256(d, n(len), o)),
    sha256Chunks: (d, len, chunk, o, t) => Number(s.cappz_sha256_chunks(d, n(len), n(chunk), o, t)),
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
  });
  const p = ffi.ptr;
  return {
    abi: () => s.cappz_native_abi(),
    features: () => s.cappz_native_features(),
    gfMatmul: (c, rows, k, i, o, len, t) => s.cappz_gf_matmul(p(c), rows, k, p(i), p(o), len, t),
    sha256: (d, len, o) => s.cappz_sha256(p(d), len, p(o)),
    sha256Chunks: (d, len, chunk, o, t) => s.cappz_sha256_chunks(p(d), len, chunk, p(o), t),
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
