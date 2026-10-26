/**
 * COPE node crystallized.
 * Node ID: v14-16-03-content-compression
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * The original content ADDRESS is the identity. Compression never overwrites:
 * it writes an alias-equivalent HD child `<contentAddress>/compressed/gzip`.
 * Archive = Replication + purge (archive-content.bpmn layers over a2a-sync):
 *   1. ContentArchived   source address → archive (replicated) address
 *   2. ContentCompressed source address → compressed HD child (both hashprints)
 *   3. ContentPurged     AgentAdmin address → original address (accounting; last)
 * Purged originals become a <contentPurged> placeholder that never replicates.
 */
import { gzipBytes, gunzipBytes } from '../sync/storageEngines/kvBackends';

export const PURGED_PLACEHOLDER = '<contentPurged>' as const;
const PRINCIPLE = "m/44'/144'/100'/principles/cope/v1";

export interface CompressedCopy { rawHash: string; compressedHash: string; codec: 'gzip'; rawSize: number; compressedSize: number; bytes: Uint8Array }
export interface CompressionMetadata { rawHash: string; compressedHash: string; codec: 'gzip'; rawSize: number; compressedSize: number }

export type StorageEventType = 'ContentCompressed' | 'ContentArchived' | 'ContentPurged';
export interface StorageTx {
  eventType: StorageEventType;
  txId: string;
  sourceAddress: string;
  targetAddress: string;
  correlationId: string;
  timestamp?: string;
  payload: Record<string, unknown> & { governingPrinciple: string };
}
/** @deprecated alias kept for callers of v14-16-02 */
export type CompressionTx = StorageTx;

export interface PurgedPlaceholder { marker: typeof PURGED_PLACEHOLDER; compressedAddress: string; archiveAddress: string; compressedTxId: string; archivedTxId: string }

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** HD child that holds the compressed alias of an address. */
export const compressedAddress = (contentAddress: string, codec: 'gzip' = 'gzip') => `${contentAddress}/compressed/${codec}`;

export async function compressContent(raw: Uint8Array): Promise<CompressedCopy> {
  const bytes = await gzipBytes(raw);
  return { rawHash: await sha256Hex(raw), compressedHash: await sha256Hex(bytes), codec: 'gzip', rawSize: raw.length, compressedSize: bytes.length, bytes };
}

export const compressionMetadata = (c: CompressedCopy): CompressionMetadata =>
  ({ rawHash: c.rawHash, compressedHash: c.compressedHash, codec: c.codec, rawSize: c.rawSize, compressedSize: c.compressedSize });

/** Verified read: compressed hashprint → unzip → raw hashprint. Rejects a bad copy without unzipping. */
export async function readCompressed(bytes: Uint8Array, meta: Pick<CompressionMetadata, 'rawHash' | 'compressedHash'>): Promise<Uint8Array> {
  if ((await sha256Hex(bytes)) !== meta.compressedHash) throw new Error('compressed-hash-mismatch');
  const raw = await gunzipBytes(bytes);
  if ((await sha256Hex(raw)) !== meta.rawHash) throw new Error('raw-hash-mismatch');
  return raw;
}

/** TX 2: source address → compressed HD child. Same version, never ContentAmended. */
export function planContentCompressed(input: { contentAddress: string; versionTxId: string; meta: CompressionMetadata; txId: string }): StorageTx {
  return {
    eventType: 'ContentCompressed', txId: input.txId,
    sourceAddress: input.contentAddress, targetAddress: compressedAddress(input.contentAddress, input.meta.codec),
    correlationId: input.versionTxId,
    payload: { ...input.meta, versionTxId: input.versionTxId, governingPrinciple: PRINCIPLE },
  };
}

/**
 * TX 1: source address → archive address. Issued only from a verified a2a-sync
 * delivery receipt of the one-way archive session (archive = replication).
 */
export function planContentArchived(input: {
  contentAddress: string; archiveAddress: string; txId: string;
  receipt: { sessionId: string; contentHash: string; verified: boolean };
  rawHash: string;
}): StorageTx | { refused: string } {
  if (!input.receipt.verified) return { refused: 'receipt-unverified' };
  if (input.receipt.contentHash !== input.rawHash) return { refused: 'receipt-hash-mismatch' };
  return {
    eventType: 'ContentArchived', txId: input.txId,
    sourceAddress: input.contentAddress, targetAddress: input.archiveAddress, correlationId: input.receipt.sessionId,
    payload: { rawHash: input.rawHash, sessionId: input.receipt.sessionId, governingPrinciple: PRINCIPLE },
  };
}

export interface PurgeCandidate {
  contentAddress: string;
  compressedBytes: Uint8Array;
  compressedTx?: StorageTx;
  archivedTx?: StorageTx;
  conflictPending?: boolean;
}

/**
 * TX 3: AgentAdmin → original address. Last step; requires typed root confirmation,
 * a ContentArchived and a ContentCompressed for this address, no conflict, verified read.
 */
export async function planContentPurge(
  c: PurgeCandidate,
  opts: { confirmedRoot?: string; agentAdminAddress: string; txId: string },
): Promise<{ ok: true; placeholder: PurgedPlaceholder; tx: StorageTx } | { ok: false; reason: string }> {
  if (!opts.confirmedRoot || !c.contentAddress.startsWith(opts.confirmedRoot)) return { ok: false, reason: 'root-not-confirmed' };
  const ctx = c.compressedTx;
  if (!ctx || ctx.eventType !== 'ContentCompressed' || ctx.sourceAddress !== c.contentAddress) return { ok: false, reason: 'no-content-compressed' };
  const atx = c.archivedTx;
  if (!atx || atx.eventType !== 'ContentArchived' || atx.sourceAddress !== c.contentAddress) return { ok: false, reason: 'no-content-archived' };
  if (c.conflictPending) return { ok: false, reason: 'conflict-pending' };
  const meta = ctx.payload as unknown as CompressionMetadata;
  if (atx.payload.rawHash !== meta.rawHash) return { ok: false, reason: 'archive-hash-mismatch' };
  try { await readCompressed(c.compressedBytes, meta); } catch (e) { return { ok: false, reason: (e as Error).message }; }
  return {
    ok: true,
    placeholder: { marker: PURGED_PLACEHOLDER, compressedAddress: ctx.targetAddress, archiveAddress: atx.targetAddress, compressedTxId: ctx.txId, archivedTxId: atx.txId },
    tx: {
      eventType: 'ContentPurged', txId: opts.txId, sourceAddress: opts.agentAdminAddress, targetAddress: c.contentAddress,
      correlationId: atx.txId, payload: { reason: 'archived-and-compressed', compressedTxId: ctx.txId, archivedTxId: atx.txId, governingPrinciple: PRINCIPLE },
    },
  };
}

/** Replication filter: a purged original is never offered to peers (they get the compressed child). */
export function isReplicable(address: string, txs: StorageTx[]): boolean {
  return !txs.some((t) => t.eventType === 'ContentPurged' && t.targetAddress === address);
}

/** Lazy unzip: hold compressed bytes; unzip (verified) only on first open. */
export function lazyContent(bytes: Uint8Array, meta: Pick<CompressionMetadata, 'rawHash' | 'compressedHash'>) {
  let cached: Promise<Uint8Array> | null = null;
  return { open: () => (cached ??= readCompressed(bytes, meta)), get opened() { return cached !== null; } };
}
