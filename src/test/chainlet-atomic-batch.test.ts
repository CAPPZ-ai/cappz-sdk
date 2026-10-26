import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local store and chainlet mocked at the boundary: one setItems call is one transaction.
const committed: Array<Array<[string, unknown]>> = [];
let failCommit = false;
const anchored: unknown[] = [];

vi.mock('../lib/sync/chainletStorage', () => ({
  chainletStorage: {
    getItem: async () => null,
    setItem: async () => undefined,
    setItems: async (rows: Array<[string, unknown]>) => {
      if (failCommit) throw new Error('quota exceeded');
      committed.push(rows);
    },
  },
}));
const flushes: number[] = [];
vi.mock('../lib/sync/storageEngines/engineSelection', () => ({
  flushActiveKvEngine: async () => { flushes.push(committed.length); },
}));
vi.mock('../lib/sync/chainletSyncAdapter', () => ({
  chainletSync: {
    prepareBatch: async (_store: string, entries: Array<{ key: string; value: unknown }>) => ({
      block: { batch: true, value: { entries } },
      kvRows: [['syncblock_h', { batch: true, entries: entries.length }], ['sync_head_d', { headHash: 'h' }]],
      commit: async () => { anchored.push(entries.length); },
    }),
  },
}));

const { CappzEventCache } = await import('../lib/sync/CappzEventCache');
const tx = (txId: string) => ({ txId, timestamp: '2026-09-30T00:00:00.000Z', eventType: 'X' });

describe('durable batch append — all or nothing', () => {
  beforeEach(() => { committed.length = 0; anchored.length = 0; failCommit = false; });

  it('commits entries, index and one chain block in a single transaction, then anchors once', async () => {
    const cache = new CappzEventCache<ReturnType<typeof tx>>('root/test', 'test:');
    await cache.appendMany([tx('invoice'), tx('journal'), tx('iso')], { requireDurable: true });
    expect(committed).toHaveLength(1);
    expect(committed[0].map(([key]) => key)).toEqual(['test:invoice', 'test:journal', 'test:iso', 'test:__index__', 'syncblock_h', 'sync_head_d']);
    expect(anchored).toEqual([3]);
    expect(flushes.at(-1)).toBe(1); // flushed to disk after the commit, before exposure/anchor
    expect(cache.getCached().map((e) => e.txId)).toEqual(['invoice', 'journal', 'iso']);
  });

  it('leaves no trace — in memory or on chain — when the commit fails', async () => {
    const cache = new CappzEventCache<ReturnType<typeof tx>>('root/test', 'test:');
    failCommit = true;
    await expect(cache.appendMany([tx('invoice'), tx('journal')], { requireDurable: true })).rejects.toThrow(/quota/);
    expect(cache.getCached()).toEqual([]);
    expect(anchored).toEqual([]);
  });
});
