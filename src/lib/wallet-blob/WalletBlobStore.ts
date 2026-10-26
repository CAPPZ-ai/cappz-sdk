/**
 * WalletBlobStore — OPFS-resident wallet blob primitive.
 *
 * COPE node crystallized.
 * governingPrinciple: AX-74 Wallet-First Hydration + Wallet-First Sovereignty.
 *
 * Each wallet (HD root) is serialized to a single immutable file on the
 * user's device under the Origin Private File System (OPFS):
 *
 *   /wallets/{slug}-v{n}.cappz
 *
 * OPFS gives us real files on disk, per-origin sandbox, large quota, and
 * no normal eviction — the closest browser primitive to "a wallet file
 * on disk". This module is the only place that touches OPFS.
 *
 * sha256 verification is enforced on every read so a corrupted, truncated,
 * or tampered file cannot poison the IndexedDB working set.
 */
import { opfsWriteFile } from '../sync/storageEngines/opfsWrite';

const DIR_NAME = 'wallets';

export interface WalletBlobRef {
  slug: string;
  version: number;
  sha256: string;
}

function fileName(slug: string, version: number): string {
  return `${slug}-v${version}.cappz`;
}

async function getDir(): Promise<FileSystemDirectoryHandle | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(DIR_NAME, { create: true });
  } catch {
    return null;
  }
}

async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  let buf: ArrayBuffer;
  if (bytes instanceof Uint8Array) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    buf = copy.buffer;
  } else {
    buf = bytes;
  }
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Returns true if OPFS is available in this environment. */
export function walletBlobStoreAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
}

/**
 * Read a wallet blob from OPFS. Verifies sha256; returns null on miss or
 * mismatch. Caller is expected to decompress/decode the returned bytes.
 */
export async function readWalletBlob(ref: WalletBlobRef): Promise<Uint8Array | null> {
  const dir = await getDir();
  if (!dir) return null;
  try {
    const handle = await dir.getFileHandle(fileName(ref.slug, ref.version));
    const file = await handle.getFile();
    const buf = await file.arrayBuffer();
    const hash = await sha256Hex(buf);
    if (hash !== ref.sha256) {
      console.warn(`[WalletBlobStore] sha256 mismatch for ${ref.slug}-v${ref.version}; discarding`);
      await dir.removeEntry(fileName(ref.slug, ref.version)).catch(() => {});
      return null;
    }
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

/**
 * Persist a wallet blob to OPFS at /wallets/{slug}-v{n}.cappz. Verifies
 * sha256 before writing so we never write a blob that fails its own hash.
 * Returns true on success.
 */
export async function writeWalletBlob(ref: WalletBlobRef, bytes: Uint8Array): Promise<boolean> {
  const dir = await getDir();
  if (!dir) return false;
  const actual = await sha256Hex(bytes);
  if (actual !== ref.sha256) {
    console.warn(`[WalletBlobStore] refusing to write ${ref.slug}-v${ref.version}: sha256 mismatch (got ${actual}, expected ${ref.sha256})`);
    return false;
  }
  try {
    await opfsWriteFile([DIR_NAME, fileName(ref.slug, ref.version)], bytes);
    return true;
  } catch (err) {
    console.warn(`[WalletBlobStore] write failed for ${ref.slug}-v${ref.version}:`, err);
    return false;
  }
}

/** List all wallet blob filenames currently on disk. */
export async function listWalletBlobs(): Promise<string[]> {
  const dir = await getDir();
  if (!dir) return [];
  const out: string[] = [];
  try {
    // @ts-ignore — FileSystemDirectoryHandle.entries() is widely shipped
    for await (const [name] of dir.entries()) out.push(name as string);
  } catch { /* ignore */ }
  return out;
}

/**
 * Prune old versions of a slug, keeping only the most recent `keep`. Versions
 * are extracted from the {slug}-v{n}.cappz filename pattern.
 */
export async function pruneWalletBlobs(slug: string, keep = 2): Promise<number> {
  const dir = await getDir();
  if (!dir) return 0;
  const names = await listWalletBlobs();
  const re = new RegExp(`^${slug}-v(\\d+)\\.cappz$`);
  const versions = names
    .map(n => ({ name: n, v: Number(n.match(re)?.[1] ?? NaN) }))
    .filter(x => Number.isFinite(x.v))
    .sort((a, b) => b.v - a.v);
  let removed = 0;
  for (const { name } of versions.slice(keep)) {
    try { await dir.removeEntry(name); removed += 1; } catch { /* ignore */ }
  }
  return removed;
}
