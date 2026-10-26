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
