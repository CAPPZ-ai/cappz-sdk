/**
 * 15.39.0 — admin-governed event logs have a public copy: a second device (or a
 * private window, or another administrator) sees what the first one bound.
 * Device-local stores are separated by cache prefix; the shared partition comes
 * from the event-log address, as in production.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, unknown>();
vi.mock('../lib/sync/chainletStorage', () => ({
  chainletStorage: {
    getItem: async (k: string) => (store.has(k) ? structuredClone(store.get(k)) : null),
    getItems: async (ks: string[]) => ks.map((k) => (store.has(k) ? structuredClone(store.get(k)) : null)),
    setItem: async (k: string, v: unknown) => { store.set(k, structuredClone(v)); },
    setItems: async (rows: Array<[string, unknown]>) => { for (const [k, v] of rows) store.set(k, structuredClone(v)); },
    keys: async () => [...store.keys()],
    removeItem: async (k: string) => { store.delete(k); },
  },
}));
vi.mock('../lib/sync/storageEngines/engineSelection', () => ({ flushActiveKvEngine: async () => undefined }));
vi.mock('../lib/sync/chainletSyncAdapter', () => ({
  chainletSync: {
    set: async () => 'h',
    prepareBatch: async () => ({ block: {}, kvRows: [], commit: async () => undefined }),
  },
}));

const { CappzEventCache } = await import('../lib/sync/CappzEventCache');
const { registerSharedEventLog, mirrorSharedEventLog, sharedPartitionFor } = await import('../lib/sync/sharedEventLog');

type Tx = { txId: string; timestamp: string; eventType: string; sourceAddress: string; targetAddress: string };
const bind = (txId: string, at: string, eventType = 'SkillConstituentIncluded'): Tx =>
  ({ txId, timestamp: at, eventType, sourceAddress: "m/44'/144'/43'", targetAddress: 'm/skills/wallet-agent' });
const LOG = "m/44'/144'/0'/cappz/skill-config/events/";

/** An in-memory mirror with the app's insert rule: only an admin author may append. */
function fakeMirror() {
  const rows: Array<{ query_hash: string; metadata: unknown; created_at: string }> = [];
  let clock = 0;
  let refuse: string | null = null;
  let down = false;
  const mirror = {
    insert: async (batch: Array<Record<string, unknown>>) => {
      if (refuse) return { error: { message: refuse } };
      for (const r of batch) rows.push({ query_hash: String(r.query_hash), metadata: r.metadata, created_at: new Date(Date.UTC(2026, 10, 12, 0, 0, clock++)).toISOString() });
      return { error: null };
    },
    select: async (partition: string) => {
      if (down) return { data: null, error: { message: 'unreachable' } };
      return { data: rows.filter((r) => r.query_hash === partition), error: null };
    },
  };
  return { mirror, rows, refuseWith: (m: string | null) => { refuse = m; }, setDown: (d: boolean) => { down = d; } };
}

describe('shared event log', () => {
  let m: ReturnType<typeof fakeMirror>;
  beforeEach(() => {
    store.clear();
    m = fakeMirror();
    registerSharedEventLog(mirrorSharedEventLog(m.mirror, async () => 'author-admin'));
  });

  it('a binding made on one device is bound on a fresh device', async () => {
    const laptop = new CappzEventCache<Tx>(LOG, 'laptop:', { shared: true, sharedTtlMs: 0 });
    await laptop.refresh();
    await laptop.appendMany([bind('b1', '2026-11-12T00:00:00.000Z')], { requireDurable: true, share: true });
    expect(m.rows).toHaveLength(1);
    expect(m.rows[0].query_hash).toBe(sharedPartitionFor(LOG));
    expect(m.rows[0].query_hash).toBe("pub:m/44'/144'/0'/cappz/skill-config/events");

    const privateWindow = new CappzEventCache<Tx>(LOG, 'private:', { shared: true, sharedTtlMs: 0 });
    const seen = await privateWindow.refresh();
    expect(seen.map((e) => e.txId)).toEqual(['b1']);
    expect(privateWindow.sharedState).toBe('synced');
    // Kept on the device: a later offline read still has it.
    expect(store.has('private:b1')).toBe(true);
  });

  it('publishes first: a refused publish leaves no local binding', async () => {
    const cache = new CappzEventCache<Tx>(LOG, 'dev:', { shared: true, sharedTtlMs: 0 });
    await cache.refresh();
    m.refuseWith('new row violates row-level security policy');
    await expect(cache.appendMany([bind('b2', '2026-11-12T00:01:00.000Z')], { requireDurable: true, share: true })).rejects.toThrow(/refused the write/);
    expect(cache.getCached()).toEqual([]);
    expect(store.has('dev:b2')).toBe(false);
  });

  it('refuses a shared write when no shared log is registered instead of keeping it local', async () => {
    registerSharedEventLog(null);
    const cache = new CappzEventCache<Tx>(LOG, 'nolog:', { shared: true });
    await expect(cache.appendMany([bind('b3', '2026-11-12T00:02:00.000Z')], { share: true })).rejects.toThrow(/not a shared log/);
    expect(cache.getCached()).toEqual([]);
  });

  it('shows the device copy when the shared log is unreachable and says so', async () => {
    const cache = new CappzEventCache<Tx>(LOG, 'offline:', { shared: true, sharedTtlMs: 0 });
    await cache.appendMany([bind('local', '2026-11-12T00:03:00.000Z')], { requireDurable: true });
    m.setDown(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await cache.refresh()).map((e) => e.txId)).toEqual(['local']);
    expect(cache.sharedState).toBe('unreachable');
    expect(cache.unshared(() => true)).toEqual([]); // nothing is backfilled against an unknown shared copy
    warn.mockRestore();
  });

  it('backfills governed entries written before the log was shared, once', async () => {
    const admin = new CappzEventCache<Tx>(LOG, 'old:', { shared: true, sharedTtlMs: 0 });
    await admin.appendMany([bind('old-1', '2026-10-01T00:00:00.000Z'), { ...bind('note', '2026-10-02T00:00:00.000Z'), eventType: 'CanonNote' }], { requireDurable: true });
    await admin.refresh();
    const governed = (e: Tx) => e.eventType === 'SkillConstituentIncluded';
    expect(await admin.shareExisting(governed)).toBe(1);
    expect(await admin.shareExisting(governed)).toBe(0);
    const other = new CappzEventCache<Tx>(LOG, 'other:', { shared: true, sharedTtlMs: 0 });
    expect((await other.refresh()).map((e) => e.txId)).toEqual(['old-1']);
  });

  it('keeps revocations: a later removal from another device wins on replay order', async () => {
    const a = new CappzEventCache<Tx>(LOG, 'a:', { shared: true, sharedTtlMs: 0 });
    await a.refresh();
    await a.appendMany([bind('inc', '2026-11-12T01:00:00.000Z')], { requireDurable: true, share: true });
    const b = new CappzEventCache<Tx>(LOG, 'b:', { shared: true, sharedTtlMs: 0 });
    await b.refresh();
    await b.appendMany([bind('rem', '2026-11-12T02:00:00.000Z', 'SkillConstituentRemoved')], { requireDurable: true, share: true });
    const last = (await a.refresh()).at(-1);
    expect(last?.eventType).toBe('SkillConstituentRemoved');
  });

  it('a cache that is not shared never reads or writes the shared log', async () => {
    const local = new CappzEventCache<Tx>(LOG, 'plain:');
    await local.appendMany([bind('p1', '2026-11-12T03:00:00.000Z')], { requireDurable: true });
    await local.refresh();
    expect(m.rows).toHaveLength(0);
    expect(local.sharedState).toBe('local-only');
  });
});
