/** Runtime runner for version retention: moves bytes between the local store and the archive replica, writes TXs. */
import { chainletStorage } from '../sync/chainletStorage';
import { appendArtifactVersions, refreshRepoZTxs } from './federatedRepoz';
import { listVersions, planVersionArchived, planVersionPurged, planVersionRestored, selectOlderVersions, archiveKeyFor, type RetentionTx, type VersionEntry } from './versionRetention';

const toBytes = (v: unknown) => (v == null ? null : v instanceof Uint8Array ? v : new Uint8Array(v as number[]));
const rootOf = (address: string) => address.split('/').slice(0, 5).join('/');

export async function readVersions(address: string): Promise<{ versions: VersionEntry[]; txs: RetentionTx[] }> {
  const txs = (await refreshRepoZTxs()) as unknown as RetentionTx[];
  return { versions: listVersions(txs, address), txs };
}

export interface ItemProgress { phase: string; done: number; total: number; item?: string; extra?: Record<string, number> }

export async function archiveVersions(opts: { address: string; keep?: number; purge?: boolean; actor: string; onProgress?: (p: ItemProgress) => void }) {
  const { versions, txs } = await readVersions(opts.address);
  const root = rootOf(opts.address);
  const out: RetentionTx[] = [];
  const refused: string[] = [];
  let freed = 0;
  const older = selectOlderVersions(versions, opts.keep ?? 1);
  const phase = opts.purge ? 'Archiving and purging' : 'Archiving';
  let done = 0;
  const tick = (item?: string) => opts.onProgress?.({ phase, done, total: older.length, item, extra: { freedBytes: freed, refused: refused.length } });
  tick();
  for (const v of older) {
    tick(v.contentRef?.storeKey ?? v.txId);
    done++;
    let archived = txs.filter((t) => t.eventType === 'ContentArchived' && t.payload?.versionTxId === v.txId).at(-1);
    let state = v.state;
    if (state === 'live' || state === 'restored') {
      const a = planVersionArchived(v, root);
      if ('refused' in a) { refused.push(`${v.txId}:${a.refused}`); continue; }
      const bytes = toBytes(await chainletStorage.getItem(v.contentRef!.storeKey));
      if (!bytes) { refused.push(`${v.txId}:bytes-missing`); continue; }
      await chainletStorage.setItem(a.targetAddress, Array.from(bytes), { walletAddress: root });
      out.push(a); archived = a; state = 'archived';
    }
    if (opts.purge && state === 'archived') {
      const p = planVersionPurged({ ...v, state }, archived, opts.actor);
      if ('refused' in p) { refused.push(`${v.txId}:${p.refused}`); continue; }
      await chainletStorage.removeItem(v.contentRef!.storeKey);
      freed += v.contentRef!.compressedSize;
      out.push(p);
    }
  }
  tick();
  if (out.length) await appendArtifactVersions(out.map((t) => ({ ...t, eventType: t.eventType as never })), opts.actor);
  return { written: out.length, refused, freedBytes: freed };
}

export async function restoreVersion(opts: { address: string; versionTxId: string; actor: string; onProgress?: (p: ItemProgress) => void }) {
  opts.onProgress?.({ phase: 'Restoring', done: 0, total: 1, item: opts.versionTxId });
  const { versions } = await readVersions(opts.address);
  const v = versions.find((x) => x.txId === opts.versionTxId);
  if (!v?.contentRef) return { ok: false as const, reason: 'version-not-found' };
  const key = archiveKeyFor(rootOf(opts.address), v.contentRef.storeKey);
  const bytes = toBytes(await chainletStorage.getItem(key));
  const r = await planVersionRestored(v, bytes, opts.actor);
  if (r.tx) {
    if (r.ok) await chainletStorage.setItem(v.contentRef.storeKey, bytes!, { walletAddress: rootOf(opts.address) });
    await appendArtifactVersions([{ ...r.tx, eventType: r.tx.eventType as never }], opts.actor);
  }
  opts.onProgress?.({ phase: 'Restoring', done: 1, total: 1, item: opts.versionTxId });
  return r.ok ? { ok: true as const } : { ok: false as const, reason: (r as { reason: string }).reason };
}
