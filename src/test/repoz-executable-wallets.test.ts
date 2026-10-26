import { describe, expect, it } from 'vitest';
import { contentStoreKey, planContentRef, withContentRef } from '../lib/repoz/walletContent';
import { assertCoreOnlyReference, resolveRuntimeSource, runtimeImageAddress, runtimeImagePayload } from '../lib/repoz/runtimeImage';
import { fromB64, planWalletSetExport, planWalletSetMerge, toB64, verifyWalletSet, type SerializedWalletSet } from '../lib/repoz/serializeWallet';
import { sha256Hex } from '../lib/repoz/contentCompression';

const enc = (s: string) => new TextEncoder().encode(s);

describe('wallet content (content-bearing version TXs)', () => {
  it('plans a gzip contentRef whose raw hash is the identity fingerprint', async () => {
    const raw = enc('export const answer = 42;');
    const plan = await planContentRef('app-a/repoz/content/code/x', raw);
    expect(plan.contentRef.codec).toBe('gzip');
    expect(plan.contentRef.rawHash).toBe(await sha256Hex(raw));
    expect(plan.contentRef.rawSize).toBe(raw.length);
    expect(plan.storeKey).toBe(contentStoreKey('app-a/repoz/content/code/x', plan.contentRef.rawHash));
    expect(plan.bytes.length).toBeGreaterThan(0);
  });

  it('attaches the contentRef to a version TX payload without replacing the fingerprint', async () => {
    const plan = await planContentRef('addr', enc('body'));
    const payload = withContentRef({ contentHash: plan.contentRef.rawHash, kind: 'source' }, plan.contentRef);
    expect(payload.contentHash).toBe(plan.contentRef.rawHash);
    expect(payload.contentRef.storeKey).toBe(plan.storeKey);
  });
});

describe('runtime images', () => {
  it('addresses runtime images under the app branch with source provenance', () => {
    const addr = runtimeImageAddress('ebb', 'v14-16-11');
    expect(addr).toBe('ebb/repoz/runtime/v14-16-11');
    const payload = runtimeImagePayload({ kind: 'runtime-image', appSlug: 'ebb', buildVersion: 'v14-16-11', imageHash: 'img', sourceSnapshotHash: 'src' });
    expect(payload.sourceSnapshotHash).toBe('src');
    expect(payload.imageHash).toBe('img');
  });

  it('Stage B resolves wallet only when enabled and an image exists; Stage C never falls back', () => {
    expect(resolveRuntimeSource({ stageBEnabled: false, walletHasImage: true })).toBe('tradcode');
    expect(resolveRuntimeSource({ stageBEnabled: true, walletHasImage: false })).toBe('tradcode');
    expect(resolveRuntimeSource({ stageBEnabled: true, walletHasImage: true })).toBe('wallet');
    expect(resolveRuntimeSource({ stageBEnabled: false, stageCFlipped: true, walletHasImage: false })).toBe('wallet');
  });
});

describe('interop guard', () => {
  it('allows own branch and shared core, refuses other app branches', () => {
    expect(assertCoreOnlyReference('ebb', 'ebb/repoz/content/code/x')).toEqual({ ok: true });
    expect(assertCoreOnlyReference('ebb', 'cappz/repoz/content/code/core')).toEqual({ ok: true });
    const refused: { ok: boolean; reason?: string } = assertCoreOnlyReference('ebb', 'media/repoz/content/code/x');
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe('cross-app-reference-outside-core');
    expect(assertCoreOnlyReference('cappz', 'media/repoz/content/code/x')).toEqual({ ok: true });
  });
});

describe('serialized wallet sets', () => {
  const entry = async (address: string, body: string) => ({
    address,
    contentB64: toB64(enc(body)),
    expectedHash: await sha256Hex(enc(body)),
  });

  it('round-trips base64 and exports a per-app set with app + core roots', async () => {
    const bytes = enc('hello wallet');
    expect([...fromB64(toB64(bytes))]).toEqual([...bytes]);
    const { set, excluded } = planWalletSetExport({
      appSlug: 'ebb', appRoot: 'ebb', coreRoot: 'cappz',
      entries: [await entry('ebb/repoz/content/code/a', 'a'), await entry('ebb/_local/keys/seed', 'never')],
      txs: [{ txId: 't1' }],
    });
    expect(set.format).toBe('cappz-wallet-set/v1');
    expect(set.roots).toEqual({ app: 'ebb', core: 'cappz' });
    expect(set.entries.map((e) => e.address)).toEqual(['ebb/repoz/content/code/a']);
    expect(excluded).toEqual([{ address: 'ebb/_local/keys/seed', reason: 'secret-never-serialized' }]);
  });

  it('verifies fingerprints and rejects tampered content', async () => {
    const good = await entry('ebb/a', 'good');
    const bad = { ...(await entry('ebb/b', 'good')), contentB64: toB64(enc('evil')) };
    const set = { format: 'cappz-wallet-set/v1', appSlug: 'ebb', exportedAt: '', roots: { app: 'ebb', core: 'cappz' }, entries: [good, bad], txs: [], governingPrinciple: 'p' } as SerializedWalletSet;
    const result = await verifyWalletSet(set);
    expect(result.ok).toBe(false);
    expect(result.verified).toBe(1);
    expect(result.failed).toEqual([{ address: 'ebb/b', reason: 'hash-mismatch' }]);
  });

  it('plans multi-writer merges: import new, skip identical, conflict on divergence', async () => {
    const a = await entry('ebb/a', 'v2');
    const b = await entry('ebb/b', 'same');
    const c = await entry('ebb/c', 'brand new');
    const set = { format: 'cappz-wallet-set/v1', appSlug: 'ebb', exportedAt: '', roots: { app: 'ebb', core: 'cappz' }, entries: [a, b, c], txs: [], governingPrinciple: 'p' } as SerializedWalletSet;
    const merge = planWalletSetMerge(set, {
      'ebb/a': await sha256Hex(enc('v1')),
      'ebb/b': await sha256Hex(enc('same')),
    });
    expect(merge.find((m) => m.address === 'ebb/a')?.action).toBe('conflict');
    expect(merge.find((m) => m.address === 'ebb/b')?.action).toBe('skip');
    expect(merge.find((m) => m.address === 'ebb/c')?.action).toBe('import');
  });
});
