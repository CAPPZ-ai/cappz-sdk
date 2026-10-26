/**
 * v15-03-00 — cappz-middleware / session store ported onto cappz-store.
 *
 *   1. offlineCache talks to the cappz-store engine (KvDatabase native API).
 *   2. Session and profile writes, and every setMany batch, are on disk
 *      before the call returns; plain kv writes queue unless durable.
 *   3. The never-imported legacy cappz-chainlet-cache database is archived
 *      and imported with the primary database, older rows never overwrite
 *      newer ones, and each import is recorded once per database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KvBackend } from '../storageEngines/kvBackends';

const flushes: number[] = [];
const persisted: Array<{ store: string; keys: string[] | 'all' }> = [];
const disk = new Map<string, Map<string, unknown>>();

function recordingBackend(): KvBackend {
  let dirty = new Map<string, Map<string, unknown>>();
  return {
    kind: 'opfs',
    async listStores() { return [...disk.keys()]; },
    async load(store) { return new Map(disk.get(store) ?? []); },
    persist(store, rows, changed = 'all') {
      persisted.push({ store, keys: changed === 'all' ? 'all' : [...changed] });
      dirty.set(store, rows);
    },
    async flush() {
      flushes.push(Date.now());
      for (const [store, rows] of dirty) disk.set(store, new Map(rows));
      dirty = new Map();
    },
  };
}

const legacy: Record<string, Record<string, unknown[]>> = {};
const textFiles = new Map<string, string>();
const blobs = new Map<string, Uint8Array>();

vi.mock('../storageEngines/legacyIdb', () => ({
  legacyIdbAvailable: () => true,
  legacyIdbFactory: null,
  dumpLegacyDatabase: async (name: string) => legacy[name] ?? {},
}));
vi.mock('../storageEngines/storageEvidence', () => ({ signStorageEvidence: async () => undefined }));
vi.mock('../../wallet-blob/WalletBlobStore', () => ({
  writeWalletBlob: async (ref: { slug: string; version: number }, bytes: Uint8Array) => { blobs.set(`${ref.slug}-v${ref.version}`, bytes); return true; },
  readWalletBlob: async (ref: { slug: string; version: number }) => blobs.get(`${ref.slug}-v${ref.version}`) ?? null,
  listWalletBlobs: async () => [...blobs.keys()],
}));
vi.mock('../storageEngines/kvBackends', async (orig) => ({
  ...(await orig<typeof import('../storageEngines/kvBackends')>()),
  opfsAvailable: () => true,
  opfsReadText: async (n: string) => textFiles.get(n) ?? null,
  opfsWriteText: async (n: string, t: string) => { textFiles.set(n, t); },
  createOpfsBackend: () => recordingBackend(),
}));

const engine = await import('../storageEngines/engineSelection');
const { offlineCache, __resetOfflineCacheForTests } = await import('../../offlineCache');
const { chainletStorage } = await import('../chainletStorage');

beforeEach(() => {
  flushes.length = 0; persisted.length = 0; disk.clear(); textFiles.clear(); blobs.clear();
  for (const k of Object.keys(legacy)) delete legacy[k];
  engine.__resetEngineForTests();
  __resetOfflineCacheForTests();
});

describe('offlineCache on the cappz-store engine', () => {
  it('session writes are on disk before set() returns; plain kv writes queue unless durable', async () => {
    await offlineCache.set('session', 'wallet-native-session', { address: 'r1' });
    expect(disk.get('session')?.get('wallet-native-session')).toMatchObject({ value: { address: 'r1' } });

    const before = flushes.length;
    await offlineCache.set('kv', 'cache:a', 1);
    expect(flushes.length).toBe(before);
    expect(disk.get('kv')?.has('cache:a')).toBeFalsy();
    await chainletStorage.setItem('cache:b', 2, { durable: true });
    expect(disk.get('kv')?.get('cache:b')).toMatchObject({ value: 2 });

    await offlineCache.delete('session', 'wallet-native-session');
    expect(disk.get('session')?.has('wallet-native-session')).toBe(false);
  });

  it('setMany is one batch on disk: every key marked in a single persist, then flushed', async () => {
    persisted.length = 0;
    await chainletStorage.setItems([['rec:1', { amount: 5 }], ['journal:1', { debit: 5 }]]);
    const kvPersists = persisted.filter((p) => p.store === 'kv');
    expect(kvPersists).toHaveLength(1);
    expect(kvPersists[0].keys).toEqual(['rec:1', 'journal:1']);
    expect([...(disk.get('kv')?.keys() ?? [])]).toEqual(expect.arrayContaining(['rec:1', 'journal:1']));
  });

  it('reads honour TTL, wallet scoping and key listing', async () => {
    await offlineCache.set('kv', 'k1', 'v1', { walletAddress: 'w1' });
    await offlineCache.set('kv', 'k2', 'v2', { walletAddress: 'w2' });
    await offlineCache.set('kv', 'k3', 'gone', { ttl: -1 });
    expect(await offlineCache.getMany('kv', ['k1', 'k3', 'nope'])).toEqual(['v1', null, null]);
    expect(await offlineCache.getByWallet('kv', 'w2')).toEqual(['v2']);
    expect(await chainletStorage.keys()).toEqual(expect.arrayContaining(['k1', 'k2']));
    const v = await offlineCache.get<{ n: number }>('kv', 'k1');
    expect(v).toBe('v1');
  });
});

describe('legacy IndexedDB import', () => {
  it('imports cappz-chainlet-cache (never imported before) after cappz-middleware, newer rows win', async () => {
    legacy['cappz-middleware'] = { kv: [{ key: 'shared', value: 'newer', cachedAt: 2, ttl: null }] };
    legacy['cappz-chainlet-cache'] = { kv: [{ key: 'shared', value: 'older', cachedAt: 1, ttl: null }, { key: 'only-old', value: 'kept', cachedAt: 1, ttl: null }] };
    const db = await engine.openCappzStore();
    expect(db).not.toBeNull();
    expect(await offlineCache.get('kv', 'shared')).toBe('newer');
    expect(await offlineCache.get('kv', 'only-old')).toBe('kept');
    const imports = (await engine.readEngineEvents()).filter((e) => e.eventType === 'IdbArchiveImported');
    expect(imports.map((e) => (e as { dbName?: string }).dbName)).toEqual(['cappz-middleware', 'cappz-chainlet-cache']);
  });

  it('a device that imported the primary database before v15-03-00 still gets the chainlet cache, once', async () => {
    textFiles.set('_engine-events.json', JSON.stringify([{ eventType: 'IdbArchiveImported', version: 1, rows: 3, timestamp: '2026-01-01T00:00:00Z' }]));
    legacy['cappz-middleware'] = { kv: [{ key: 'should-not-reimport', value: 1, cachedAt: 1, ttl: null }] };
    legacy['cappz-chainlet-cache'] = { profile: [{ key: 'p', value: 'from-chainlet-cache', cachedAt: Date.now(), ttl: null }] };
    await engine.openCappzStore();
    expect(await offlineCache.get('profile', 'p')).toBe('from-chainlet-cache');
    expect(await offlineCache.get('kv', 'should-not-reimport')).toBeNull();
    engine.__resetEngineForTests();
    __resetOfflineCacheForTests();
    await engine.openCappzStore();
    const imports = (await engine.readEngineEvents()).filter((e) => e.eventType === 'IdbArchiveImported');
    expect(imports).toHaveLength(2);
  });
});
