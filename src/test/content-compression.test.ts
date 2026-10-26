import { describe, it, expect } from 'vitest';
import { decodeStoredText, encodeStoredText, isGzip, encodeRows, decodeRows } from '../lib/sync/storageEngines/kvBackends';
import { compressContent, compressionMetadata, readCompressed, planContentCompressed, planContentPurge, planContentArchived, compressedAddress, isReplicable, PURGED_PLACEHOLDER, lazyContent, sha256Hex } from '../lib/repoz/contentCompression';
import { archiveViaReplicator } from '../lib/repoz/archiveReplication';
import { REPOZ_EVENT_PARENT } from '../lib/repoz/federatedRepoz';

const enc = (s: string) => new TextEncoder().encode(s);
const doc = enc('Writers contract v3 — '.repeat(200));

describe('v14-16-02 gzip storage + compressed content', () => {
  it('store files round-trip gzip incl. binary and non-expiring values', async () => {
    const text = encodeRows([['k', { bytes: new Uint8Array([1, 255]), ttl: Infinity }]]);
    const stored = await encodeStoredText(text);
    expect(isGzip(stored)).toBe(true);
    const back = decodeRows(await decodeStoredText(stored));
    expect((back[0][1] as any).bytes).toEqual(new Uint8Array([1, 255]));
    expect((back[0][1] as any).ttl).toBeNull();
  });

  it('legacy plain store file still loads', async () => {
    expect(await decodeStoredText(enc('[["a",1]]'))).toBe('[["a",1]]');
  });

  it('raw hashprint unchanged by compression; compressed is smaller', async () => {
    const c = await compressContent(doc);
    expect(c.rawHash).toBe(await sha256Hex(doc));
    expect(c.compressedSize).toBeLessThan(c.rawSize);
    expect(Array.from(await readCompressed(c.bytes, c))).toEqual(Array.from(doc));
  });

  it('damaged compressed copy rejected before unzip', async () => {
    const c = await compressContent(doc);
    const bad = c.bytes.slice(); bad[bad.length - 5] ^= 0xff;
    await expect(readCompressed(bad, c)).rejects.toThrow('compressed-hash-mismatch');
  });

  it('compression is not a new version: TX goes source → HD child alias', async () => {
    const c = await compressContent(doc);
    const tx = planContentCompressed({ contentAddress: 'app/repoz/code/a.ts', versionTxId: 'v1', meta: compressionMetadata(c), txId: 't1' } as never);
    expect(tx.eventType).toBe('ContentCompressed');
    expect(tx.sourceAddress).toBe('app/repoz/code/a.ts');
    expect(tx.targetAddress).toBe(compressedAddress('app/repoz/code/a.ts'));
    expect(tx.payload.rawHash).toBe(c.rawHash);
    expect(tx.payload.compressedHash).toBe(c.compressedHash);
    expect(REPOZ_EVENT_PARENT.ContentCompressed).toBeUndefined();
  });

  it('three TXs: archive from verified receipt, purge by AgentAdmin only when compressed + archived', async () => {
    const c = await compressContent(doc);
    const addr = 'app/repoz/code/a.ts';
    const ctx = planContentCompressed({ contentAddress: addr, versionTxId: 'v1', meta: compressionMetadata(c), txId: 't1' } as never);
    expect(planContentArchived({ contentAddress: addr, archiveAddress: 'dr/a', txId: 'a1', receipt: { sessionId: 's', contentHash: c.rawHash, verified: false }, rawHash: c.rawHash })).toEqual({ refused: 'receipt-unverified' });
    const atx = planContentArchived({ contentAddress: addr, archiveAddress: 'dr/a', txId: 'a1', receipt: { sessionId: 's', contentHash: c.rawHash, verified: true }, rawHash: c.rawHash }) as never;
    const opts = { agentAdminAddress: 'app/agents/admin', txId: 'p1', confirmedRoot: 'app/' };
    expect(await planContentPurge({ contentAddress: addr, compressedBytes: c.bytes, compressedTx: ctx, archivedTx: atx }, { ...opts, confirmedRoot: undefined })).toMatchObject({ ok: false, reason: 'root-not-confirmed' });
    expect(await planContentPurge({ contentAddress: addr, compressedBytes: c.bytes, archivedTx: atx }, opts)).toMatchObject({ ok: false, reason: 'no-content-compressed' });
    expect(await planContentPurge({ contentAddress: addr, compressedBytes: c.bytes, compressedTx: ctx }, opts)).toMatchObject({ ok: false, reason: 'no-content-archived' });
    expect(await planContentPurge({ contentAddress: addr, compressedBytes: c.bytes, compressedTx: ctx, archivedTx: atx, conflictPending: true }, opts)).toMatchObject({ ok: false, reason: 'conflict-pending' });
    const r = await planContentPurge({ contentAddress: addr, compressedBytes: c.bytes, compressedTx: ctx, archivedTx: atx }, opts);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.placeholder.marker).toBe(PURGED_PLACEHOLDER);
      expect(r.tx.sourceAddress).toBe('app/agents/admin');
      expect(r.tx.targetAddress).toBe(addr);
      expect(isReplicable(addr, [r.tx])).toBe(false);
    }
  });

  it('archive runs through the existing Replicator session', async () => {
    const c = await compressContent(doc);
    const fakeEngine = { runSyncSession: async () => ({ sessionId: 's1', transport: 'direct', delivered: ['x1'], rejected: [], forks: [], receipts: [{ txId: 'x1', contentHash: c.rawHash }] }) } as never;
    const r = await archiveViaReplicator(fakeEngine, { walletAddress: 'dr' } as never, {} as never, [{ txId: 'x1', contentAddress: 'app/a', rawHash: c.rawHash }, { txId: 'x2', contentAddress: 'app/b', rawHash: 'h' }]);
    expect(r.archived).toHaveLength(1);
    expect(r.archived[0].eventType).toBe('ContentArchived');
    expect(r.refused).toEqual([{ contentAddress: 'app/b', reason: 'not-delivered' }]);
  });

  it('lazy content unzips only on open', async () => {
    const c = await compressContent(doc);
    const l = lazyContent(c.bytes, c);
    expect(l.opened).toBe(false);
    expect(Array.from(await l.open())).toEqual(Array.from(doc));
    expect(l.opened).toBe(true);
  });
});

import { planArchiveReplicas, selectArchiveDeltas, listWalletRoots } from '../lib/repoz/archiveReplication';
describe('v14-16-04 archive activation', () => {
  const base = [
    { txId: '1', eventType: 'ContentCreated', sourceAddress: 'x', targetAddress: 'm/a/b/c/w1/doc1' },
    { txId: '2', eventType: 'ContentCreated', sourceAddress: 'x', targetAddress: 'm/a/b/c/w2/doc2' },
  ];
  it('creates ReplicantCreated + ArchiveCreated once per wallet (idempotent)', () => {
    let n = 0;
    const first = planArchiveReplicas(base, () => String(++n));
    expect(first.map((t) => t.eventType)).toEqual(['ReplicantCreated', 'ArchiveCreated', 'ReplicantCreated', 'ArchiveCreated']);
    expect(first[0].correlationId).toBe(first[1].correlationId);
    expect(planArchiveReplicas([...base, ...first])).toEqual([]);
    expect(listWalletRoots([...base, ...first])).toEqual(['m/a/b/c/w1', 'm/a/b/c/w2']);
  });
  it('archives only deltas without ContentArchived', () => {
    const txs = [...base, { txId: '3', eventType: 'ContentArchived', sourceAddress: 'm/a/b/c/w1/doc1', targetAddress: 'arch' }];
    expect(selectArchiveDeltas(txs, ['m/a/b/c/w1/doc1', 'm/a/b/c/w2/doc2'])).toEqual(['m/a/b/c/w2/doc2']);
  });
});
