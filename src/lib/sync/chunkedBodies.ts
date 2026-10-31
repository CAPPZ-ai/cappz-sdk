/**
 * COPE node crystallized.
 * Node ID: v15-10-00-chunked-bodies
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Bodies above MAX_BODY_BYTES (6 MB, edgeBodyPull.ts) move as chunks. A large
 * file is stored as content-addressed chunks (each ≤ CHUNK_BYTES) plus a
 * small manifest body naming them in order and the sha256 of the whole file.
 * Every piece is an ordinary body, so the existing inv/getdata/frame exchange
 * replicates large files without a protocol change — nodes from before
 * v15-10-00 relay the pieces too, they just do not reassemble them.
 *
 * Reassembly checks each chunk (its id is its hash) and the whole-file hash
 * before anything is returned; a missing chunk is reported as missing,
 * never padded.
 *
 * v15-14-00: when native kernels are loaded (src/lib/native/cappzNative.ts),
 * the whole-file hash and every chunk id come from one call on all cores
 * with the ARMv8 SHA-256 instructions; the ids are the same either way.
 */

import { MAX_BODY_BYTES, sha256Hex, type BodyStore } from './edgeBodyPull.ts';
import { activeKernels } from '../native/cappzNative';

const toHex = (d: Uint8Array) => Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');

export const CHUNK_BYTES = 4 * 1024 * 1024;
export const MANIFEST_KIND = 'cpz1-chunked';

export interface ChunkManifest { kind: typeof MANIFEST_KIND; v: 1; sha256: string; size: number; chunkBytes: number; chunks: string[]; name?: string }

/** Store bytes; small bodies as one body, large ones as chunks + manifest. Returns the id to reference and the whole-file hash. */
export async function putBody(store: BodyStore, bytes: Uint8Array, o: { name?: string; chunkBytes?: number } = {}): Promise<{ id: string; sha256: string; chunked: boolean; manifest?: ChunkManifest }> {
  const kernels = activeKernels();
  const native = kernels.backend === 'native';
  const sha256 = native ? toHex(kernels.sha256(bytes)) : await sha256Hex(bytes);
  if (bytes.length <= MAX_BODY_BYTES) { await store.put(sha256, bytes); return { id: sha256, sha256, chunked: false }; }
  const chunkBytes = Math.min(o.chunkBytes ?? CHUNK_BYTES, MAX_BODY_BYTES);
  const ids = native ? kernels.sha256Chunks(bytes, chunkBytes).map(toHex) : null;
  const chunks: string[] = [];
  for (let at = 0; at < bytes.length; at += chunkBytes) {
    const piece = bytes.slice(at, at + chunkBytes);
    const id = ids ? ids[at / chunkBytes] : await sha256Hex(piece);
    if (!(await store.has(id))) await store.put(id, piece);
    chunks.push(id);
  }
  const manifest: ChunkManifest = { kind: MANIFEST_KIND, v: 1, sha256, size: bytes.length, chunkBytes, chunks, ...(o.name ? { name: o.name } : {}) };
  const mBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const id = await sha256Hex(mBytes);
  await store.put(id, mBytes);
  return { id, sha256, chunked: true, manifest };
}

export function parseManifest(bytes: Uint8Array | null): ChunkManifest | null {
  if (!bytes || bytes.length > 512 * 1024 || bytes[0] !== 0x7b) return null;
  try {
    const m = JSON.parse(new TextDecoder().decode(bytes)) as ChunkManifest;
    return m?.kind === MANIFEST_KIND && m.v === 1 && Array.isArray(m.chunks) && /^[0-9a-f]{64}$/.test(m.sha256) ? m : null;
  } catch { return null; }
}

export type ReadResult =
  | { state: 'complete'; bytes: Uint8Array; sha256: string; chunked: boolean }
  | { state: 'missing-chunks'; missing: string[]; have: number; of: number }
  | { state: 'hash-mismatch'; because: string }
  | { state: 'not-found' };

/** Read a body by id; a manifest id reassembles and verifies the whole file. */
export async function readBody(store: BodyStore, id: string): Promise<ReadResult> {
  const first = await store.get(id);
  if (!first) return { state: 'not-found' };
  const m = parseManifest(first);
  if (!m) return { state: 'complete', bytes: first, sha256: id, chunked: false };
  const missing: string[] = [];
  for (const c of m.chunks) if (!(await store.has(c))) missing.push(c);
  if (missing.length) return { state: 'missing-chunks', missing, have: m.chunks.length - missing.length, of: m.chunks.length };
  const out = new Uint8Array(m.size);
  let at = 0;
  for (const c of m.chunks) {
    const piece = (await store.get(c))!;
    if ((await sha256Hex(piece)) !== c) return { state: 'hash-mismatch', because: `chunk ${c.slice(0, 12)}… does not match its id` };
    if (at + piece.length > m.size) return { state: 'hash-mismatch', because: 'chunks exceed the declared size' };
    out.set(piece, at); at += piece.length;
  }
  if (at !== m.size) return { state: 'hash-mismatch', because: `chunks hold ${at} of ${m.size} bytes` };
  const whole = await sha256Hex(out);
  return whole === m.sha256 ? { state: 'complete', bytes: out, sha256: whole, chunked: true } : { state: 'hash-mismatch', because: 'reassembled file does not match the manifest hash' };
}
