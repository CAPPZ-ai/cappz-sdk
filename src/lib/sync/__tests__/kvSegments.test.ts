/**
 * v15-01-04 — cappz-store writes only what changed (segments + shards).
 *
 * A store used to be one file rewritten whole on every flush; a release save
 * on a phone with a large history re-serialized the whole store ~50 times and
 * Safari failed with UnknownError. These tests pin the new format: changed
 * rows only per flush, deletes survive reload, legacy files migrate, and a
 * crash part-way through compaction still reloads the latest state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gunzipSync } from 'fflate';

type Files = Map<string, Uint8Array>;

function fakeOpfs(files: Files, opts: { failOn?: (name: string) => boolean } = {}) {
  const writes: Array<{ name: string; raw: number }> = [];
  const dirHandle = (prefix: string): unknown => ({
    async getDirectoryHandle(name: string) { return dirHandle(`${prefix}${name}/`); },
    async removeEntry(name: string) { files.delete(`${prefix}${name}`); },
    async *entries() { for (const k of [...files.keys()]) if (k.startsWith(prefix) && !k.slice(prefix.length).includes('/')) yield [k.slice(prefix.length), {}]; },
    async getFileHandle(name: string, o?: { create?: boolean }) {
      const key = `${prefix}${name}`;
      if (!files.has(key) && !o?.create) throw new DOMException('missing', 'NotFoundError');
      return {
        async getFile() { const b = files.get(key) ?? new Uint8Array(); return { arrayBuffer: async () => b.slice().buffer }; },
        async createWritable() {
          const parts: Uint8Array[] = [];
          return {
            async write(d: Uint8Array | ArrayBuffer | Blob) { parts.push(d instanceof Blob ? new Uint8Array(await d.arrayBuffer()) : d instanceof Uint8Array ? d : new Uint8Array(d)); },
            async close() {
              if (opts.failOn?.(key)) throw new DOMException('The operation failed for an unknown transient reason (e.g. out of memory).', 'UnknownError');
              const b = parts.length === 1 ? parts[0] : new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer());
              files.set(key, b);
              writes.push({ name: key, raw: b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b).length : b.length });
            },
          };
        },
      };
    },
  });
  return { storage: { getDirectory: async () => dirHandle('') }, writes };
}

const row = (k: string, extra = 'v') => ({ key: k, value: `${extra}-${k}`.repeat(4) });

describe('cappz-store segments and shards', () => {
  let files: Files;
  beforeEach(() => { vi.resetModules(); files = new Map(); });
  afterEach(() => vi.unstubAllGlobals());

  const backend = async () => (await import('../storageEngines/kvBackends')).createOpfsBackend();
  const settle = () => new Promise((r) => setTimeout(r, 5));

  it('a flush writes only the changed rows, and deletes survive reload', async () => {
    const o = fakeOpfs(files); vi.stubGlobal('navigator', { storage: o.storage });
    const b = await backend();
    const live = await b.load('kv'); await settle();
    for (let i = 0; i < 2000; i++) live.set(`k${i}`, row(`k${i}`));
    b.persist('kv', live, 'all'); await b.flush();
    const base = o.writes.reduce((n, w) => n + w.raw, 0);
    expect(o.writes.every((w) => /kv\+\d\d\.json$/.test(w.name))).toBe(true); // compacted into shards

    o.writes.length = 0;
    live.set('k5', row('k5', 'changed')); live.delete('k6');
    b.persist('kv', live, ['k5', 'k6']); await b.flush();
    expect(o.writes).toHaveLength(1);
    expect(o.writes[0].name).toMatch(/kv@000001\.json$/);
    expect(o.writes[0].raw).toBeLessThan(base / 200);

    vi.resetModules();
    const again = await (await backend()).load('kv');
    expect(again.size).toBe(1999);
    expect(again.get('k5')).toEqual(row('k5', 'changed'));
    expect(again.has('k6')).toBe(false);
  });

  it('a legacy single-file store loads, and compaction migrates it without losing rows', async () => {
    const { encodeRows, encodeStoredText } = await import('../storageEngines/kvBackends');
    files.set('cappz-store/kv.json', await encodeStoredText(encodeRows([['a', row('a')], ['b', row('b')]])));
    const o = fakeOpfs(files); vi.stubGlobal('navigator', { storage: o.storage });
    const b = await backend();
    const live = await b.load('kv'); await settle();
    expect([...live.keys()].sort()).toEqual(['a', 'b']);
    live.set('c', row('c'));
    b.persist('kv', live, 'all'); await b.flush();
    expect(files.has('cappz-store/kv.json')).toBe(false);
    vi.resetModules();
    expect([...(await (await backend()).load('kv')).keys()].sort()).toEqual(['a', 'b', 'c']);
    expect(await (await backend()).listStores()).toEqual(['kv']);
  });

  it('a crash part-way through compaction still reloads the latest state', async () => {
    let failing = true;
    const o = fakeOpfs(files, { failOn: (n) => failing && n.endsWith('kv+05.json') }); vi.stubGlobal('navigator', { storage: o.storage });
    const b = await backend();
    const live = await b.load('kv'); await settle();
    for (let i = 0; i < 300; i++) live.set(`k${i}`, row(`k${i}`));
    b.persist('kv', live, [...live.keys()]); await b.flush();         // one segment with everything
    live.set('k1', row('k1', 'newer')); live.delete('k2');
    b.persist('kv', live, 'all');
    await expect(b.flush()).rejects.toThrow(/unknown transient reason/);  // compaction dies at shard 05
    failing = false;
    vi.resetModules();
    const back = await (await backend()).load('kv');
    // Nothing is corrupted: every row is its value from before or after the interrupted whole-store write.
    for (let i = 0; i < 300; i++) {
      const v = back.get(`k${i}`);
      const allowed = [row(`k${i}`), ...(i === 1 ? [row('k1', 'newer')] : []), ...(i === 2 ? [undefined] : [])];
      expect(allowed).toContainEqual(v);
    }
    // The failed changes stay queued in the live backend and land on the next flush.
    await b.flush();
    vi.resetModules();
    const fin = await (await backend()).load('kv');
    expect(fin.size).toBe(299); expect(fin.get('k1')).toEqual(row('k1', 'newer')); expect(fin.has('k2')).toBe(false);
  });

  it('a write before the store is loaded never overwrites an existing segment or drops rows', async () => {
    const o = fakeOpfs(files); vi.stubGlobal('navigator', { storage: o.storage });
    const first = await backend();
    const live = await first.load('kv'); await settle();
    live.set('old', row('old')); first.persist('kv', live, ['old']); await first.flush();
    vi.resetModules();
    const second = await backend();
    second.persist('kv', new Map([['new', row('new')]]), 'all');            // hot write, store never loaded
    await second.flush();
    vi.resetModules();
    const back = await (await backend()).load('kv');
    expect([...back.keys()].sort()).toEqual(['new', 'old']);
  });

  it('segments are compacted after enough flushes, keeping the latest values', async () => {
    const { COMPACT_SEGMENTS } = await import('../storageEngines/kvBackends');
    const o = fakeOpfs(files); vi.stubGlobal('navigator', { storage: o.storage });
    const b = await backend();
    const live = await b.load('kv'); await settle();
    for (let i = 0; i < COMPACT_SEGMENTS; i++) { live.set(`k${i % 10}`, row(`k${i % 10}`, String(i))); b.persist('kv', live, [`k${i % 10}`]); await b.flush(); }
    const names = [...files.keys()];
    expect(names.filter((n) => n.includes('@'))).toHaveLength(0);
    expect(names.filter((n) => n.includes('+'))).toHaveLength(32);
    vi.resetModules();
    const back = await (await backend()).load('kv');
    const lastK3 = [...Array(COMPACT_SEGMENTS).keys()].filter((i) => i % 10 === 3).at(-1)!;
    expect(back.get('k3')).toEqual(row('k3', String(lastK3)));
  });
});

/**
 * v15-46-00 — a durable save awaits only its own batch. On an iPhone, the
 * Bible canon cache queued megabytes of rows; every signed-in session save then
 * flushed them too, Safari failed the large write with UnknownError and the
 * save reported "handler_threw". Scoped flushes, segment-sized background
 * writes and one retry of a transient error keep the small save independent.
 */
describe('scoped flushes and segment-sized background writes', () => {
  let files: Files;
  beforeEach(() => { vi.resetModules(); files = new Map(); });
  afterEach(() => vi.unstubAllGlobals());
  const backend = async () => (await import('../storageEngines/kvBackends')).createOpfsBackend();
  const settle = () => new Promise((r) => setTimeout(r, 5));

  it('a scoped flush writes only its batch, even while another queued write keeps failing', async () => {
    let failing = true;
    const o = fakeOpfs(files, { failOn: (n) => failing && n.includes('cache@') }); vi.stubGlobal('navigator', { storage: o.storage });
    const b = await backend();
    const cache = await b.load('cache'); const kv = await b.load('kv'); await settle();
    for (let i = 0; i < 50; i++) cache.set(`v${i}`, row(`v${i}`));
    b.persist('cache', cache, [...cache.keys()]);          // the big fill — its writes fail
    kv.set('other', row('other')); b.persist('kv', kv, ['other']);
    kv.set('turn', row('turn')); kv.set('index', row('index')); b.persist('kv', kv, ['turn', 'index']);
    await b.flush({ store: 'kv', keys: ['turn', 'index'] });
    expect(o.writes.map((w) => w.name)).toEqual(['cappz-store/kv@000001.json']);
    vi.resetModules();
    const back = await (await backend()).load('kv');
    expect([...back.keys()].sort()).toEqual(['index', 'turn']);  // 'other' is still queued, not dragged in
    await expect(b.flush()).rejects.toThrow(/unknown transient reason/);
    expect(files.has('cappz-store/kv@000002.json')).toBe(true);   // the failing store did not block 'other'
    failing = false;
    await b.flush();                                                // drained: no retry timer outlives the test
    expect([...files.keys()].some((n) => n.startsWith('cappz-store/cache@'))).toBe(true);
  });

  it('a scoped flush includes any batch that shares a key, so no batch is split', async () => {
    const o = fakeOpfs(files); vi.stubGlobal('navigator', { storage: o.storage });
    const b = await backend();
    const kv = await b.load('kv'); await settle();
    kv.set('a', row('a')); kv.set('b', row('b')); b.persist('kv', kv, ['a', 'b']);
    kv.set('b', row('b', 'newer')); kv.set('c', row('c')); b.persist('kv', kv, ['b', 'c']);
    kv.set('z', row('z')); b.persist('kv', kv, ['z']);
    await b.flush({ store: 'kv', keys: ['c'] });
    expect(o.writes).toHaveLength(1);
    vi.resetModules();
    expect([...(await (await backend()).load('kv')).keys()].sort()).toEqual(['a', 'b', 'c']);
    await b.flush(); // 'z' is still queued: drain it so its timer cannot write into the next test's files
  });

  it('a large background flush is written as several segments, never splitting a batch', async () => {
    const { SEGMENT_TARGET_CHARS } = await import('../storageEngines/kvBackends');
    const o = fakeOpfs(files); vi.stubGlobal('navigator', { storage: o.storage });
    const b = await backend();
    const kv = await b.load('kv'); await settle();
    const big = 'x'.repeat(Math.ceil(SEGMENT_TARGET_CHARS / 4));
    for (let i = 0; i < 10; i++) { kv.set(`c${i}`, { key: `c${i}`, value: big }); b.persist('kv', kv, [`c${i}`]); }
    kv.set('p1', row('p1')); kv.set('p2', row('p2')); b.persist('kv', kv, ['p1', 'p2']);
    await b.flush();
    expect(o.writes.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...o.writes.map((w) => w.raw))).toBeLessThan(SEGMENT_TARGET_CHARS * 1.3);
    const { decodeRows, decodeStoredText } = await import('../storageEngines/kvBackends');
    const holding = await Promise.all(o.writes.map(async (w) => decodeRows(await decodeStoredText(files.get(w.name)!)).map(([k]) => k)));
    expect(holding.filter((keys) => keys.includes('p1') || keys.includes('p2'))).toHaveLength(1);
    expect(holding.find((keys) => keys.includes('p1'))).toContain('p2');
    vi.resetModules();
    expect((await (await backend()).load('kv')).size).toBe(12);
  });

  it('a transient UnknownError is retried once and the write lands', async () => {
    let failures = 1;
    const o = fakeOpfs(files, { failOn: () => failures-- > 0 }); vi.stubGlobal('navigator', { storage: o.storage });
    const b = await backend();
    const kv = await b.load('kv'); await settle();
    kv.set('turn', row('turn')); b.persist('kv', kv, ['turn']);
    await b.flush({ store: 'kv', keys: ['turn'] });
    vi.resetModules();
    expect((await (await backend()).load('kv')).get('turn')).toEqual(row('turn'));
  });
});
