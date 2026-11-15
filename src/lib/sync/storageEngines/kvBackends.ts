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
  /**
   * Write queued changes. With `scope`, only the batches holding those keys
   * (one segment, all-or-nothing) are written and awaited; everything else
   * stays queued for the background flush, so an unrelated large write that
   * fails cannot fail a small durable save.
   */
  flush(scope?: FlushScope): Promise<void>;
}

/** The keys a durable caller just wrote and must see on disk. */
export type FlushScope = { store: string; keys: Iterable<string> };

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
    async flush(_scope?: FlushScope) { /* nothing */ },
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
/**
 * v15-46-00 — background flushes split queued changes into segments of about
 * this much JSON, never splitting one write batch, so a large cache fill (a
 * whole canon) is never one multi-megabyte write held in memory at once.
 */
export const SEGMENT_TARGET_CHARS = 2 * 1024 * 1024;

/** Queued changes for one store: write batches in order, or the whole store. */
type Dirty = { rows: Map<string, unknown>; all: boolean; groups: Set<string>[] };
/** One write: a whole store (compaction) or a set of keys (one segment). */
type Unit = { store: string; rows: Map<string, unknown>; all: boolean; groups: Set<string>[] };

const unitKeys = (u: Unit): Set<string> | 'all' => {
  if (u.all) return 'all';
  const out = new Set<string>();
  for (const g of u.groups) for (const k of g) out.add(k);
  return out;
};

const rowChars = (rows: Map<string, unknown>, keys: Iterable<string>): number => {
  let n = 0;
  for (const k of keys) {
    try { n += k.length + (rows.has(k) ? (JSON.stringify(rows.get(k), replacer)?.length ?? 4) : 16); } catch { n += 64; }
  }
  return n;
};

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
  const dirty = new Map<string, Dirty>();
  /** Per store: next segment number, segments not yet compacted, and their raw size. */
  const segState = new Map<string, { next: number; files: string[]; bytes: number; base: number }>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();
  /** Consecutive failed flushes (sets the retry back-off). */
  let failures = 0;
  /** Run `step` after every earlier write; one earlier failure never blocks a later write. */
  const enqueue = (step: () => Promise<void>): Promise<void> => {
    const run = chain.catch(() => {}).then(step);
    chain = run.catch(() => {});
    return run;
  };

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

  /**
   * Housekeeping compaction after a segment write. It runs as its own queued
   * step: the segment that triggered it is already on disk, so its caller is
   * done, and a failed compaction only leaves more segments to replay.
   */
  const compactLater = (store: string, rows: Map<string, unknown>) => {
    void enqueue(async () => {
      const st = stateOf(store);
      if (!loaded.has(store) || !(st.files.length >= COMPACT_SEGMENTS || st.bytes >= Math.max(COMPACT_SEGMENT_BYTES, st.base))) return;
      try { await compact(store, rows); } catch (err) { console.warn(`[cappz-store/opfs] compaction deferred for ${store}`, err); }
    });
  };

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
    compactLater(store, rows);
  }

  /** Put a failed write back in front of anything queued since, so the next flush retries it. */
  const requeue = (u: Unit) => {
    const later = dirty.get(u.store);
    dirty.set(u.store, {
      rows: later?.rows ?? u.rows,
      all: u.all || !!later?.all,
      groups: [...u.groups, ...(later?.groups ?? [])],
    });
    // Back off while writes keep failing (a phone under memory pressure): 1 s, 2 s, 4 s … 1 min.
    if (!timer) timer = setTimeout(flushInBackground, Math.min(60_000, 1000 * 2 ** Math.min(failures, 6)));
  };

  async function writeUnits(units: Unit[]): Promise<void> {
    let first: unknown = null;
    for (const u of units) {
      try { await writeStore(u.store, u.rows, unitKeys(u)); }
      catch (err) {
        requeue(u);
        console.warn(`[cappz-store/opfs] write failed for ${u.store}`, err);
        first ??= err;
      }
    }
    if (first) { failures += 1; throw first; }
    failures = 0;
  }

  /** Every queued change, as segment-sized units that never split a write batch. */
  const takeAll = (): Unit[] => {
    const units: Unit[] = [];
    for (const [store, d] of dirty) {
      if (d.all) { units.push({ store, rows: d.rows, all: true, groups: d.groups }); continue; }
      let cur: Set<string>[] = []; let chars = 0;
      for (const g of d.groups) {
        const c = rowChars(d.rows, g);
        if (cur.length && chars + c > SEGMENT_TARGET_CHARS) { units.push({ store, rows: d.rows, all: false, groups: cur }); cur = []; chars = 0; }
        cur.push(g); chars += c;
      }
      if (cur.length) units.push({ store, rows: d.rows, all: false, groups: cur });
    }
    dirty.clear();
    return units;
  };

  /** The queued batches holding `keys` (and any batch sharing a key with them), as one unit. */
  const takeScoped = (scope: FlushScope): Unit | null => {
    const d = dirty.get(scope.store);
    if (!d) return null;
    if (d.all) { dirty.delete(scope.store); return { store: scope.store, rows: d.rows, all: true, groups: d.groups }; }
    const want = new Set(scope.keys);
    const taken: Set<string>[] = [];
    let rest = d.groups;
    for (let grew = true; grew;) {
      grew = false;
      const keep: Set<string>[] = [];
      for (const g of rest) {
        if ([...g].some((k) => want.has(k))) { taken.push(g); for (const k of g) want.add(k); grew = true; }
        else keep.push(g);
      }
      rest = keep;
    }
    if (!taken.length) return null;
    if (rest.length) d.groups = rest; else dirty.delete(scope.store);
    return { store: scope.store, rows: d.rows, all: false, groups: taken };
  };

  // Background flushes (timer, pagehide, hidden tab) have no caller to report to: the failure is
  // logged and the changes stay queued for the next flush, so their rejection is handled here.
  const flushInBackground = () => { doFlush().catch(() => {}); };
  const doFlush = () => {
    timer = null;
    // Take the queue when this step runs, so a write still in flight that fails is retried too.
    return enqueue(() => writeUnits(takeAll()));
  };
  const doScopedFlush = (scope: FlushScope) => enqueue(async () => {
    const unit = takeScoped(scope);
    if (unit) await writeUnits([unit]);
  });

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flushInBackground);
    // v15-03-00: phones often background a tab without pagehide; flush when it hides.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && dirty.size) flushInBackground(); });
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
      const d = dirty.get(store) ?? { rows, all: false, groups: [] };
      d.rows = rows;
      if (changed === 'all') d.all = true;
      else { const g = new Set(changed); if (g.size) d.groups.push(g); }
      dirty.set(store, d);
      if (!timer) timer = setTimeout(flushInBackground, 150);
    },
    async flush(scope) {
      if (scope) return doScopedFlush(scope);
      if (timer) { clearTimeout(timer); }
      await doFlush();
      await chain; // a full flush also waits for the compaction it queued
    },
  };
}
