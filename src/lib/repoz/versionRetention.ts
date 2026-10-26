/**
 * COPE node crystallized. Node ID: v14-16-15-version-retention
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Archive older versions of anything (optionally purge), then restore to the
 * SAME placeholder address. Composes existing primitives: archive replica
 * (ContentArchived), purge (ContentPurged), and a correlated ContentRestored.
 * The current head is never archived. State is read from TX existence only.
 */
import { readCompressed, sha256Hex } from './contentCompression';
import { archiveReplicaAddress } from './archiveReplication';
import type { ContentRef } from './walletContent';

const PRINCIPLE = "m/44'/144'/100'/principles/cope/v1";

export interface RetentionTx { txId: string; eventType: string; sourceAddress: string; targetAddress: string; timestamp?: string; payload: Record<string, unknown> }
export type VersionState = 'live' | 'archived' | 'purged' | 'restored';
export interface VersionEntry { txId: string; address: string; timestamp: string; contentRef?: ContentRef; isHead: boolean; state: VersionState }

const ts = (t: RetentionTx) => t.timestamp ?? '';

/** Latest retention TX targeting the version's bytes decides its state (archive → purge → restore cycle). */
export function versionState(txs: readonly RetentionTx[], versionTxId: string): VersionState {
  const mine = txs.filter((t) => t.payload?.versionTxId === versionTxId && ['ContentArchived', 'ContentPurged', 'ContentRestored'].includes(t.eventType))
    .sort((a, b) => ts(a).localeCompare(ts(b)));
  const last = mine.at(-1)?.eventType;
  return last === 'ContentArchived' ? 'archived' : last === 'ContentPurged' ? 'purged' : last === 'ContentRestored' ? 'restored' : 'live';
}

/** Every version of an address, oldest first; the newest is the head. */
export function listVersions(txs: readonly RetentionTx[], address: string): VersionEntry[] {
  const vs = txs.filter((t) => t.targetAddress === address && (t.payload?.contentRef || t.payload?.snapshotVersionTxId === t.txId || ['ContentCreated', 'ContentAmended', 'ArtifactGenerated'].includes(t.eventType)))
    .sort((a, b) => ts(a).localeCompare(ts(b)));
  return vs.map((t, i) => ({ txId: t.txId, address, timestamp: ts(t), contentRef: t.payload.contentRef as ContentRef | undefined, isHead: i === vs.length - 1, state: versionState(txs, t.txId) }));
}

/** Older = not the head and not within the newest `keep`. Heads are always kept. */
export function selectOlderVersions(versions: readonly VersionEntry[], keep = 1): VersionEntry[] {
  const k = Math.max(1, keep);
  return versions.slice(0, Math.max(0, versions.length - k)).filter((v) => !v.isHead);
}

export const archiveKeyFor = (walletRoot: string, storeKey: string) => `${archiveReplicaAddress(walletRoot)}/${storeKey}`;

export function planVersionArchived(v: VersionEntry, walletRoot: string, now = new Date().toISOString()): RetentionTx | { refused: string } {
  if (v.isHead) return { refused: 'head-version' };
  if (!v.contentRef) return { refused: 'fingerprint-only' };
  if (v.state === 'archived' || v.state === 'purged') return { refused: 'already-archived' };
  return { txId: `archived:${v.txId}:${now}`, eventType: 'ContentArchived', sourceAddress: v.contentRef.storeKey, targetAddress: archiveKeyFor(walletRoot, v.contentRef.storeKey), timestamp: now,
    payload: { versionTxId: v.txId, rawHash: v.contentRef.rawHash, compressedHash: v.contentRef.compressedHash, rawSize: v.contentRef.rawSize, governingPrinciple: PRINCIPLE } };
}

export function planVersionPurged(v: VersionEntry, archivedTx: RetentionTx | undefined, actor: string, now = new Date().toISOString()): RetentionTx | { refused: string } {
  if (v.isHead) return { refused: 'head-version' };
  if (!v.contentRef) return { refused: 'fingerprint-only' };
  if (v.state !== 'archived' || !archivedTx) return { refused: 'not-archived' };
  return { txId: `purged:${v.txId}:${now}`, eventType: 'ContentPurged', sourceAddress: actor, targetAddress: v.contentRef.storeKey, timestamp: now,
    payload: { versionTxId: v.txId, archivedTxId: archivedTx.txId, reason: 'older-version-pruned', governingPrinciple: PRINCIPLE } };
}

/** Restore: archived bytes must match the original fingerprint; mismatch → RemediationRequested, nothing restored. */
export async function planVersionRestored(v: VersionEntry, archivedBytes: Uint8Array | null, actor: string, now = new Date().toISOString()): Promise<{ ok: true; tx: RetentionTx } | { ok: false; tx?: RetentionTx; reason: string }> {
  if (!v.contentRef) return { ok: false, reason: 'fingerprint-only' };
  if (v.state === 'live' || v.state === 'restored') return { ok: false, reason: 'already-present' };
  if (!archivedBytes) return { ok: false, reason: 'archive-copy-missing' };
  try { await readCompressed(archivedBytes, v.contentRef); } catch (e) {
    return { ok: false, reason: (e as Error).message, tx: { txId: `restore-remediation:${v.txId}:${await sha256Hex(archivedBytes)}`, eventType: 'RemediationRequested', sourceAddress: actor, targetAddress: v.contentRef.storeKey, timestamp: now, payload: { versionTxId: v.txId, reason: 'restore-fingerprint-mismatch', governingPrinciple: PRINCIPLE } } };
  }
  return { ok: true, tx: { txId: `restored:${v.txId}:${now}`, eventType: 'ContentRestored', sourceAddress: actor, targetAddress: v.contentRef.storeKey, timestamp: now, payload: { versionTxId: v.txId, rawHash: v.contentRef.rawHash, governingPrinciple: PRINCIPLE } } };
}
