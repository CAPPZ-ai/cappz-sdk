/**
 * Key-value persistence backends for the cappz-store engines — v12-23-07.
 *
 *  - memory: hot tier, process lifetime only.
 *  - opfs:   durable tier under /cappz-store/ in the Origin Private File System.
 *
 * v15-01-04 — write only what changed. A store used to be one JSON file
 * rewritten whole on every flush, so each durable batch re-serialized every
 * row on the device (a release save on a phone with ~40 MB of history wrote
 * ~0.8 GB and held the whole store in memory several times per batch, until
 * Safari failed with UnknownError). Now each flush appends one segment file
 * holding only the changed rows (one file = the batch stays all-or-nothing);
 * segments are compacted into hash shards, so no single write holds the
 * whole store. Files per store `s` (encodeURIComponent-safe, so `+` and `@`
 * never occur inside the name):
 *   s.json          legacy single file (read, then removed by compaction)
 *   s+NN.json       shard NN of the compacted base
 *   s@NNNNNN.json   segment NNNNNN — changed rows, applied in order
 * Load = legacy, then shards, then segments. Compaction writes every shard,
 * then removes the legacy file and the segments it absorbed; a crash part-way
 * leaves files whose replay still yields the latest state.
 */

import { opfsWriteFile } from './opfsWrite';

export type Row = { key: string; [k: string]: unknown };

export interface KvBackend {
  readonly kind: 'memory' | 'opfs';
  listStores(): Promise<string[]>;
  load(store: string): Promise<Map<string, unknown>>;
  /** Queue `rows` for the next flush; `changed` names the keys written or deleted ('all' or omitted = whole store). */
  persist(store: string, rows: Map<string, unknown>, changed?: Iterable<string> | 'all'): void;
  flush(): Promise<void>;
}

// ─── JSON codec that survives Uint8Array / Date ───────────────────────────
function replacer(_k: string, v: unknown): unknown {
  if (v instanceof Uint8Array) {
    let s = '';
    for (const b of v) s += String.fromCharCode(b);
    return { __u8: btoa(s) };
  }
  return v;
}
function reviver(_k: string, v: unknown): unknown {
  if (v && typeof v === 'object' && '__u8' in (v as Record<string, unknown>)) {
    const bin = atob((v as { __u8: string }).__u8);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return v;
}
export const encodeRows = (entries: [string, unknown][]) => JSON.stringify(entries, replacer);
export const decodeRows = (text: string): [string, unknown][] => JSON.parse(text, reviver);

export function createMemoryBackend(): KvBackend {
  return {
    kind: 'memory',
    async listStores() { return []; },
    async load() { return new Map(); },
    persist() { /* hot tier only */ },
    async flush() { /* nothing */ },
  };
}

const OPFS_DIR = 'cappz-store';
const safeName = (store: string) => encodeURIComponent(store) + '.json';

export function opfsAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
}

async function opfsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_DIR, { create: true });
}

// ─── v14-16-02 transparent gzip (storage encoding only; no content hash changes) ───
export const gzipAvailable = () => typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
export const isGzip = (b: Uint8Array) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;

async function pipeBytes(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const src = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
  const reader = src.pipeThrough(stream as unknown as TransformStream<Uint8Array, Uint8Array>).getReader();
  const parts: Uint8Array[] = [];
  for (let r = await reader.read(); !r.done; r = await reader.read()) parts.push(r.value);
  const outBytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { outBytes.set(p, o); o += p.length; }
  return outBytes;
}
// Safari before 16.4 has no CompressionStream: fall back to fflate (same gzip format).
export const gzipBytes = async (b: Uint8Array) => typeof CompressionStream !== 'undefined'
  ? pipeBytes(b, new CompressionStream('gzip'))
  : (await import('fflate')).gzipSync(b);
export const gunzipBytes = async (b: Uint8Array) => typeof DecompressionStream !== 'undefined'
  ? pipeBytes(b, new DecompressionStream('gzip'))
  : (await import('fflate')).gunzipSync(b);

/** Decode stored file bytes: gzip (sniffed by magic) or legacy plain UTF-8 JSON. */
export async function decodeStoredText(bytes: Uint8Array): Promise<string> {
  return new TextDecoder().decode(isGzip(bytes) ? await gunzipBytes(bytes) : bytes);
}
/** Encode text for storage: gzip when available, plain otherwise. */
export async function encodeStoredText(text: string): Promise<Uint8Array> {
  const raw = new TextEncoder().encode(text);
  return gzipAvailable() ? gzipBytes(raw) : raw;
}

export async function opfsReadText(name: string): Promise<string | null> {
  try {
    const dir = await opfsDir();
    const file = await (await dir.getFileHandle(name)).getFile();
    return await decodeStoredText(new Uint8Array(await file.arrayBuffer()));
  } catch { return null; }
}

export async function opfsWriteText(name: string, text: string): Promise<void> {
  // v15-01-02 — shared writer: worker sync-access fallback where Safari lacks createWritable.
  await opfsWriteFile([OPFS_DIR, name], await encodeStoredText(text));
}

/** Deleted-row marker inside a segment. */
const DELETED = { __kvDeleted: 1 } as const;
const isDeleted = (v: unknown) => !!v && typeof v === 'object' && (v as { __kvDeleted?: unknown }).__kvDeleted === 1;
export const KV_SHARDS = 32;
/**
 * Compact once segments outweigh the base (at least COMPACT_SEGMENT_BYTES), so
 * rewriting the base costs at most about as much as the changes already
 * written — or once there are this many segment files (load time).
 */
export const COMPACT_SEGMENTS = 256;
export const COMPACT_SEGMENT_BYTES = 16 * 1024 * 1024;

/** FNV-1a: stable shard for a key. */
export function shardOf(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0) % KV_SHARDS;
}

type StoreFile = { name: string; kind: 'legacy' | 'shard' | 'segment'; n: number };
/** Which store file a directory entry is, if any. */
export function parseStoreFile(file: string): { store: string; file: StoreFile } | null {
  if (!file.endsWith('.json') || file.startsWith('_')) return null;
  const m = /^(.*?)(?:\+(\d+)|@(\d+))?\.json$/.exec(file);
  if (!m) return null;
  let store: string;
  try { store = decodeURIComponent(m[1]); } catch { return null; }
  const kind = m[2] !== undefined ? 'shard' : m[3] !== undefined ? 'segment' : 'legacy';
  return { store, file: { name: file, kind, n: Number(m[2] ?? m[3] ?? 0) } };
}

async function listDir(): Promise<string[]> {
  const names: string[] = [];
  try {
    const dir = (await opfsDir()) as unknown as { entries(): AsyncIterable<[string, unknown]> };
    for await (const [n] of dir.entries()) names.push(String(n));
  } catch { /* ignore */ }
  return names;
}

async function removeFile(name: string): Promise<void> {
  try { await (await opfsDir()).removeEntry(name); } catch { /* already gone */ }
}

export function createOpfsBackend(): KvBackend {
  const dirty = new Map<string, { rows: Map<string, unknown>; keys: Set<string> | 'all' }>();
  /** Per store: next segment number, segments not yet compacted, and their raw size. */
  const segState = new Map<string, { next: number; files: string[]; bytes: number; base: number }>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();

  const stateOf = (store: string) => { let st = segState.get(store); if (!st) { st = { next: 1, files: [], bytes: 0, base: 0 }; segState.set(store, st); } return st; };
  /** Stores whose files this backend has read: only those may be compacted (a partial map would drop rows). */
  const loaded = new Set<string>();
  /** Segment numbers always come from the directory, so a write before load never reuses one. */
  const scanned = new Map<string, Promise<void>>();
  const scan = (store: string) => {
    let p = scanned.get(store);
    if (!p) {
      p = listDir().then((names) => {
        const st = stateOf(store);
        for (const n of names) {
          const f = parseStoreFile(n);
          if (f?.store !== store || f.file.kind !== 'segment') continue;
          if (!st.files.includes(f.file.name)) st.files.push(f.file.name);
          st.next = Math.max(st.next, f.file.n + 1);
        }
      });
      scanned.set(store, p);
    }
    return p;
  };

  /** Rewrite the base as shards, then drop the legacy file and the absorbed segments. */
  async function compact(store: string, rows: Map<string, unknown>): Promise<void> {
    const safe = encodeURIComponent(store);
    const st = stateOf(store);
    const absorbed = [...st.files];
    const buckets: Array<[string, unknown][]> = Array.from({ length: KV_SHARDS }, () => []);
    for (const entry of rows.entries()) buckets[shardOf(entry[0])].push(entry);
    let base = 0;
    for (let i = 0; i < KV_SHARDS; i++) { const text = encodeRows(buckets[i]); base += text.length; await opfsWriteText(`${safe}+${String(i).padStart(2, '0')}.json`, text); }
    st.base = base;
    await removeFile(`${safe}.json`);
    for (const f of absorbed) await removeFile(f);
    st.files = st.files.filter((f) => !absorbed.includes(f));
    st.bytes = 0;
  }

  async function writeStore(store: string, rows: Map<string, unknown>, keys: Set<string> | 'all'): Promise<void> {
    await scan(store);
    if (keys === 'all' && loaded.has(store)) return compact(store, rows);
    // Not loaded yet: record every current row as a segment (it can only add, never drop, persisted rows).
    const changed = keys === 'all' ? [...rows.keys()] : [...keys];
    if (!changed.length) return;
    const st = stateOf(store);
    const text = encodeRows(changed.map((k) => [k, rows.has(k) ? rows.get(k) : DELETED]));
    const name = `${encodeURIComponent(store)}@${String(st.next).padStart(6, '0')}.json`;
    await opfsWriteText(name, text);
    st.next += 1; st.files.push(name); st.bytes += text.length;
    if (loaded.has(store) && (st.files.length >= COMPACT_SEGMENTS || st.bytes >= Math.max(COMPACT_SEGMENT_BYTES, st.base))) await compact(store, rows);
  }

  const doFlush = () => {
    const batch = [...dirty.entries()];
    dirty.clear();
    timer = null;
    chain = chain.catch(() => {}).then(async () => {
      for (const [store, d] of batch) {
        try { await writeStore(store, d.rows, d.keys); }
        catch (err) {
          // Keep the unwritten changes for the next flush, merged with anything newer.
          const later = dirty.get(store);
          const keys = d.keys === 'all' || later?.keys === 'all' ? 'all' : new Set([...d.keys, ...(later?.keys as Set<string> ?? [])]);
          dirty.set(store, { rows: later?.rows ?? d.rows, keys });
          console.warn(`[cappz-store/opfs] write failed for ${store}`, err);
          throw err;
        }
      }
    });
    return chain;
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => { void doFlush(); });
    // v15-03-00: phones often background a tab without pagehide; flush when it hides.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && dirty.size) void doFlush(); });
    }
  }

  return {
    kind: 'opfs',
    async listStores() {
      const stores = new Set<string>();
      for (const n of await listDir()) { const p = parseStoreFile(n); if (p) stores.add(p.store); }
      return [...stores];
    },
    async load(store) {
      const files = (await listDir()).map(parseStoreFile).filter((p): p is NonNullable<typeof p> => !!p && p.store === store).map((p) => p.file);
      const order = (k: StoreFile['kind']) => (k === 'legacy' ? 0 : k === 'shard' ? 1 : 2);
      files.sort((a, b) => order(a.kind) - order(b.kind) || a.n - b.n);
      const rows = new Map<string, unknown>();
      await scan(store);
      const st = stateOf(store);
      for (const f of files) {
        const text = await opfsReadText(f.name);
        if (!text) continue;
        let entries: [string, unknown][];
        try { entries = decodeRows(text); } catch { continue; }
        for (const [k, v] of entries) { if (isDeleted(v)) rows.delete(k); else rows.set(k, v); }
        if (f.kind === 'segment') { if (!st.files.includes(f.name)) st.files.push(f.name); st.bytes += text.length; st.next = Math.max(st.next, f.n + 1); }
        else st.base += text.length;
      }
      // The caller merges these rows into its live map in a later microtask; allow compaction only after that.
      setTimeout(() => loaded.add(store), 0);
      return rows;
    },
    persist(store, rows, changed = 'all') {
      const prev = dirty.get(store);
      const keys = changed === 'all' || prev?.keys === 'all' ? 'all' : new Set([...(prev?.keys as Set<string> ?? []), ...changed]);
      dirty.set(store, { rows, keys });
      if (!timer) timer = setTimeout(() => { void doFlush(); }, 150);
    },
    async flush() {
      if (timer) { clearTimeout(timer); }
      await doFlush();
    },
  };
}
