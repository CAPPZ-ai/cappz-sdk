// @vitest-environment node
/**
 * cappzStorageBPMN — End-to-end create-mode persistence test.
 *
 * Exercises the full pipeline (PolicyCheck → Notify → Persist → ForkHandler)
 * for a `create` submit and verifies:
 *   • TX event row written to chainletStorage at cappz:event/<txId>
 *   • Content row written to chainletStorage at cappz:content/<childHd>
 *   • middleware notifications fired with the child HD address (AX-75)
 *   • Fork handler is a no-op for create mode
 *   • PolicyCheck rejects amend without sourceHashPrint
 *   • ingestContentPipeline persists without emitting a write notify
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock chainletStorage (in-memory KV) ──────────────────────
const kv = new Map<string, unknown>();

vi.mock('../chainletStorage', () => ({
  chainletStorage: {
    setItem: vi.fn(async (key: string, value: unknown) => {
      kv.set(key, value);
    }),
    getItem: vi.fn(async (key: string) => kv.get(key) ?? null),
  },
}));

// ─── Mock middleware notify ───────────────────────────────────
const notifyCalls: Array<{ store: string; key: string; type: string; hd?: string }> = [];

vi.mock('../cappz-middleware', () => ({
  middlewareNotify: vi.fn((store: string, key: string, type: string, hd?: string) => {
    notifyCalls.push({ store, key, type, hd });
  }),
}));

// Import AFTER mocks are registered
import { cappzStorageBPMN, type PipelineContext } from '../CappzStorageBPMN';

function ctx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    parentHdAddress: "m/44'/144'/0'/cappz/storage/parent",
    childHdAddress: "m/44'/144'/0'/cappz/storage/parent/child-001",
    content: { kind: 'note', body: 'hello world' },
    contentHash: 'a'.repeat(64),
    txId: 'tx-uuid-001',
    correlationId: 'corr-uuid-001',
    mode: 'create',
    timestamp: '2026-05-04T12:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  kv.clear();
  notifyCalls.length = 0;
});

describe('cappzStorageBPMN.execute — create mode (cappzStorageBPMN pipeline)', () => {
  it('persists TX event and content rows under stable keys', async () => {
    const c = ctx();
    await cappzStorageBPMN.execute('cappzStorageBPMN', c);

    const eventKey = `cappz:event/${c.txId}`;
    const contentKey = `cappz:content/${c.childHdAddress}`;

    const eventRow = kv.get(eventKey) as any;
    const contentRow = kv.get(contentKey) as any;

    expect(eventRow).toBeDefined();
    expect(eventRow).toMatchObject({
      txId: c.txId,
      eventType: 'ContentCreated',
      sourceAddress: c.parentHdAddress,
      targetAddress: c.childHdAddress,
      contentHash: c.contentHash,
      correlationId: c.correlationId,
      timestamp: c.timestamp,
    });

    expect(contentRow).toBeDefined();
    expect(contentRow).toMatchObject({
      hdAddress: c.childHdAddress,
      content: c.content,
      contentHash: c.contentHash,
      state: 'CONFIRMED',
      dirty: false,
      sourceTxId: c.txId,
    });
  });

  it('emits AX-75 notifications for cappz-storage and both KV keys', async () => {
    const c = ctx();
    await cappzStorageBPMN.execute('cappzStorageBPMN', c);

    // 1 notify from Notify(), 2 notifies from Persist() → 3 total
    expect(notifyCalls).toHaveLength(3);

    expect(notifyCalls[0]).toEqual({
      store: 'cappz-storage',
      key: c.childHdAddress,
      type: 'write',
      hd: c.childHdAddress,
    });
    expect(notifyCalls[1]).toMatchObject({
      store: 'kv',
      key: `cappz:event/${c.txId}`,
      type: 'write',
    });
    expect(notifyCalls[2]).toMatchObject({
      store: 'kv',
      key: `cappz:content/${c.childHdAddress}`,
      type: 'write',
    });
  });

  it('does NOT write a fork TX when mode=create', async () => {
    await cappzStorageBPMN.execute('cappzStorageBPMN', ctx());

    const forkKeys = [...kv.keys()].filter(k => k.startsWith('cappz:event/fork-'));
    expect(forkKeys).toEqual([]);
  });

  it('writes a ContentForked TX when mode=fork with forkFrom set', async () => {
    const c = ctx({
      mode: 'fork',
      forkFrom: "m/44'/144'/0'/cappz/storage/source",
      sourceHashPrint: { txId: 'orig-tx', contentHash: 'b'.repeat(64) } as any,
    });
    await cappzStorageBPMN.execute('cappzStorageBPMN', c);

    const forkRow = kv.get(`cappz:event/fork-${c.txId}`) as any;
    expect(forkRow).toBeDefined();
    expect(forkRow).toMatchObject({
      txId: `fork-${c.txId}`,
      eventType: 'ContentForked',
      sourceAddress: c.forkFrom,
      targetAddress: c.childHdAddress,
      metadata: { originalTxId: 'orig-tx' },
    });
  });

  it('PolicyCheck rejects amend without sourceHashPrint', async () => {
    await expect(
      cappzStorageBPMN.execute('cappzStorageBPMN', ctx({ mode: 'amend' })),
    ).rejects.toThrow(/sourceHashPrint required for amend/);

    expect(kv.size).toBe(0);
  });

  it('throws on unknown pipeline name', async () => {
    await expect(
      cappzStorageBPMN.execute('does-not-exist', ctx()),
    ).rejects.toThrow(/Unknown pipeline/);
  });
});

describe('cappzStorageBPMN.execute — ingestContentPipeline', () => {
  it('persists rows but skips Notify (no cappz-storage write notification)', async () => {
    const c = ctx();
    await cappzStorageBPMN.execute('ingestContentPipeline', c);

    // Persist still fires 2 KV notifications, but Notify() is omitted.
    expect(kv.get(`cappz:event/${c.txId}`)).toBeDefined();
    expect(kv.get(`cappz:content/${c.childHdAddress}`)).toBeDefined();

    const storageNotifies = notifyCalls.filter(n => n.store === 'cappz-storage');
    expect(storageNotifies).toEqual([]);
  });
});
