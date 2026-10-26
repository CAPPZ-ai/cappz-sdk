/**
 * COPE node crystallized. Node ID: v14-16-11-wallet-content
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Content-bearing version TXs: ArtifactGenerated/ContentAmended gain a
 * contentRef pointing at gzipped bytes in the artifact's own wallet
 * partition. The fingerprint (SHA-256 of raw bytes) stays on the TX as
 * identity; bytes are fetched lazily (ZUI lazy-decompress pattern).
 * Pure planning — storage writes happen in the caller (chainletStorage).
 */
import { gzipBytes } from '../sync/storageEngines/kvBackends';
import { sha256Hex } from './contentCompression';

export const WALLET_CONTENT_PRINCIPLE = "m/44'/144'/100'/principles/cope/v1#wallet-content";

export interface ContentRef {
  /** Wallet partition key holding the gzipped bytes. */
  storeKey: string;
  codec: 'gzip';
  rawHash: string;
  compressedHash: string;
  rawSize: number;
  compressedSize: number;
}

export interface ContentBearingPlan {
  storeKey: string;
  bytes: Uint8Array; // gzipped — caller persists
  contentRef: ContentRef;
}

/** Partition key for an artifact version's bytes: <versionAddress>/bytes/<rawHash>. */
export const contentStoreKey = (versionAddress: string, rawHash: string) => `${versionAddress}/bytes/${rawHash}`;

/** Gzip bytes and plan the contentRef for a version TX payload. */
export async function planContentRef(versionAddress: string, raw: Uint8Array): Promise<ContentBearingPlan> {
  const bytes = await gzipBytes(raw);
  const rawHash = await sha256Hex(raw);
  const compressedHash = await sha256Hex(bytes);
  return {
    storeKey: contentStoreKey(versionAddress, rawHash),
    bytes,
    contentRef: { storeKey: contentStoreKey(versionAddress, rawHash), codec: 'gzip', rawHash, compressedHash, rawSize: raw.length, compressedSize: bytes.length },
  };
}

/** Payload extension for a version TX: fingerprint is identity, contentRef locates bytes. */
export function withContentRef<T extends Record<string, unknown>>(payload: T, ref: ContentRef): T & { contentRef: ContentRef } {
  return { ...payload, contentRef: ref };
}

/**
 * v14-17-05 — read raw bytes behind a contentRef and verify the raw fingerprint.
 * Returns null when no bytes are stored or the fingerprint does not match.
 */
export async function readContentBytes(
  ref: Pick<ContentRef, 'storeKey' | 'rawHash'>,
  load: (key: string) => Promise<unknown>,
  gunzip: (b: Uint8Array) => Promise<Uint8Array>,
): Promise<{ bytes: Uint8Array } | { error: 'missing' | 'hash-mismatch' }> {
  const stored = await load(ref.storeKey);
  if (!stored) return { error: 'missing' };
  const gz = stored instanceof Uint8Array ? stored : new Uint8Array(stored as number[]);
  const raw = await gunzip(gz);
  if ((await sha256Hex(raw)) !== ref.rawHash) return { error: 'hash-mismatch' };
  return { bytes: raw };
}
