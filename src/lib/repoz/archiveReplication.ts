/**
 * COPE node crystallized. Node ID: v14-16-03-archive-replication
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * archive-content.bpmn runner. Archive = Replication + purge: the archive wallet
 * is a Replicator peer; the existing A2ASyncEngine one-way session does the
 * transfer and its checksum receipts become ContentArchived TXs. No new engine.
 */
import type { A2ASyncEngine, SyncCopy } from '../sync/a2aSyncEngine';
import { planContentArchived, type StorageTx } from './contentCompression';

export interface ArchiveItem { txId: string; contentAddress: string; rawHash: string }

/**
 * Pull-shaped like every a2a session: the archive copy is the requester, the
 * live wallet is the source. Returns one ContentArchived per verified receipt.
 */
export async function archiveViaReplicator(
  engine: Pick<A2ASyncEngine, 'runSyncSession'>,
  archiveCopy: SyncCopy,
  sourceCopy: SyncCopy,
  items: ArchiveItem[],
): Promise<{ archived: StorageTx[]; refused: { contentAddress: string; reason: string }[]; sessionId: string | null }> {
  const r = await engine.runSyncSession(archiveCopy, sourceCopy);
  const archived: StorageTx[] = [];
  const refused: { contentAddress: string; reason: string }[] = [];
  if (r.refused) return { archived, refused: items.map((i) => ({ contentAddress: i.contentAddress, reason: r.refused! })), sessionId: r.sessionId };
  const receipts = new Map((r.receipts ?? []).map((x) => [x.txId, x]));
  for (const item of items) {
    const rc = receipts.get(item.txId);
    const delivered = r.delivered.includes(item.txId);
    if (!rc || !delivered) { refused.push({ contentAddress: item.contentAddress, reason: 'not-delivered' }); continue; }
    const tx = planContentArchived({
      contentAddress: item.contentAddress,
      archiveAddress: `${archiveCopy.walletAddress}/archive/${encodeURIComponent(item.contentAddress)}`,
      txId: `archived-${item.txId}`,
      receipt: { sessionId: r.sessionId ?? '', contentHash: rc.contentHash, verified: true },
      rawHash: item.rawHash,
    });
    if ('refused' in tx) refused.push({ contentAddress: item.contentAddress, reason: tx.refused }); else archived.push(tx);
  }
  return { archived, refused, sessionId: r.sessionId };
}

// ─── v14-16-04 — archive replicas + deltas (composition, AP-12) ────────────────

export interface WalletTxLike { txId: string; eventType: string; sourceAddress: string; targetAddress: string; correlationId?: string; walletRoot?: string; payload?: Record<string, unknown> }

/** Archive replica address for a wallet root (one per wallet, under the platform archive branch). */
export const ARCHIVE_ROOT = "m/44'/144'/100'/archive";
export const archiveReplicaAddress = (walletRoot: string) => `${ARCHIVE_ROOT}/${encodeURIComponent(walletRoot)}`;

/** Wallet roots seen in replay (explicit walletRoot, else first 5 path segments). */
export function listWalletRoots(txs: WalletTxLike[]): string[] {
  const roots = new Set<string>();
  for (const t of txs) {
    const r = t.walletRoot || t.targetAddress?.split('/').slice(0, 5).join('/');
    if (r && !r.startsWith(ARCHIVE_ROOT)) roots.add(r);
  }
  return [...roots].sort();
}

/** Existence of an ArchiveCreated TX from the wallet root is the only test. */
export function hasArchiveReplica(txs: WalletTxLike[], walletRoot: string): boolean {
  return txs.some((t) => t.eventType === 'ArchiveCreated' && t.sourceAddress === walletRoot);
}

/**
 * For each wallet lacking an archive replica: ReplicantCreated (generic) +
 * ArchiveCreated (derived) sharing one correlationId. Idempotent.
 */
export function planArchiveReplicas(txs: WalletTxLike[], newId: () => string = () => crypto.randomUUID()): WalletTxLike[] {
  const out: WalletTxLike[] = [];
  for (const root of listWalletRoots(txs)) {
    if (hasArchiveReplica(txs, root)) continue;
    const corr = `replica-${newId()}`;
    const target = archiveReplicaAddress(root);
    const payload = { mode: 'one-way', governingPrinciple: "m/44'/144'/100'/principles/cope/v1" };
    out.push({ txId: `${corr}-r`, eventType: 'ReplicantCreated', sourceAddress: root, targetAddress: target, correlationId: corr, payload });
    out.push({ txId: `${corr}-a`, eventType: 'ArchiveCreated', sourceAddress: root, targetAddress: target, correlationId: corr, payload: { ...payload, parentEventType: 'ReplicantCreated' } });
  }
  return out;
}

/** Deltas: content addresses with no ContentArchived TX sourced from them. */
export function selectArchiveDeltas(txs: WalletTxLike[], contentAddresses: string[]): string[] {
  const archived = new Set(txs.filter((t) => t.eventType === 'ContentArchived').map((t) => t.sourceAddress));
  return contentAddresses.filter((a) => !archived.has(a));
}
