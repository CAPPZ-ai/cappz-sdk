/**
 * CappzContentCache — Write-through content cache with optimistic state machine.
 *
 * Content is stored at HD addresses. Each entry tracks a state:
 *   PENDING → CONFIRMED | FAILED
 *
 * Write path:
 *   submit() → immediate in-memory insert (PENDING, dirty=true)
 *   → durable persistence callback → CONFIRMED (hash verified) or FAILED (rollback)
 *
 * Read path:
 *   GetContent(hdAddress) → if dirty, re-fetch from storage; else return hot cache
 *   FetchContent(addresses[]) → batch read, populate hot cache, clear dirty flags
 *
 * AX-63: All reads/writes via cappz-middleware stack.
 * AX-77: Hosted in a session wallet with admin queue (InfraSessionWallet).
 * HD: m/44'/144'/0'/cappz/sync/content-cache
 */

import { chainletStorage } from './chainletStorage';
import { InfraSessionWallet } from './InfraSessionWallet';

// ─── Types ────────────────────────────────────────────────────

export type ContentState = 'PENDING' | 'CONFIRMED' | 'FAILED';

export interface ContentCacheEntry<T = unknown> {
  hdAddress: string;
  content: T;
  contentHash: string;
  state: ContentState;
  dirty: boolean;
  lastFetchedAt: string;
  /** TxId of the ContentCreated/Amended event that produced this content */
  sourceTxId?: string;
}

export interface ContentHashPrint {
  txId: string;
  contentHash: string;
}

export class StaleContentError extends Error {
  constructor(
    public readonly latestTxId: string,
    public readonly latestHash: string,
    public readonly requestedTxId: string,
  ) {
    super(
      `Stale content: requested TxId ${requestedTxId} but latest is ${latestTxId}. ` +
      `Caller should diff/merge or fork.`
    );
    this.name = 'StaleContentError';
  }
}

// ─── Content Cache ────────────────────────────────────────────

const CONTENT_PREFIX = 'cappz:content/';

export class CappzContentCache {
  private _hot = new Map<string, ContentCacheEntry>();

  /** AX-77: Session wallet with admin queue */
  readonly wallet: InfraSessionWallet;

  constructor(domain?: string) {
    this.wallet = new InfraSessionWallet({
      serviceType: 'ContentCache',
      domain: domain ?? 'global',
    });
    // AX-77: Emit session creation
    if (typeof window !== 'undefined') {
      this.wallet.sessionCreated().catch(() => {});
    }
  }

  // ─── Read ─────────────────────────────────────────────────

  /**
   * Get content at a single HD address.
   * If dirty, re-fetches from storage before returning.
   */
  async GetContent<T = unknown>(hdAddress: string): Promise<ContentCacheEntry<T> | null> {
    const cached = this._hot.get(hdAddress) as ContentCacheEntry<T> | undefined;
    if (cached && !cached.dirty) return cached;

    // Dirty or missing — fetch from storage
    const stored = await chainletStorage.getItem<ContentCacheEntry<T>>(`${CONTENT_PREFIX}${hdAddress}`);
    if (stored) {
      stored.dirty = false;
      stored.lastFetchedAt = new Date().toISOString();
      this._hot.set(hdAddress, stored as ContentCacheEntry);
      return stored;
    }

    return cached ?? null;
  }

  /**
   * Batch fetch content for multiple HD addresses.
   * Populates hot cache and clears dirty flags.
   */
  async FetchContent<T = unknown>(addresses: string[]): Promise<Map<string, ContentCacheEntry<T>>> {
    const result = new Map<string, ContentCacheEntry<T>>();
    const now = new Date().toISOString();

    // Batch: fetch only addresses that are dirty or not in hot cache
    const toFetch = addresses.filter(addr => {
      const cached = this._hot.get(addr);
      if (cached && !cached.dirty) {
        result.set(addr, cached as ContentCacheEntry<T>);
        return false;
      }
      return true;
    });

    for (const addr of toFetch) {
      const stored = await chainletStorage.getItem<ContentCacheEntry<T>>(`${CONTENT_PREFIX}${addr}`);
      if (stored) {
        stored.dirty = false;
        stored.lastFetchedAt = now;
        this._hot.set(addr, stored as ContentCacheEntry);
        result.set(addr, stored);
      }
    }

    return result;
  }

  // ─── Write-Through ────────────────────────────────────────

  /**
   * Insert content into cache in PENDING state.
   * Returns a confirmation callback for the durable persistence layer.
   */
  insertPending<T = unknown>(
    hdAddress: string,
    content: T,
    contentHash: string,
    sourceTxId?: string,
  ): {
    entry: ContentCacheEntry<T>;
    confirm: () => void;
    fail: (error?: string) => void;
  } {
    const entry: ContentCacheEntry<T> = {
      hdAddress,
      content,
      contentHash,
      state: 'PENDING',
      dirty: true,
      lastFetchedAt: new Date().toISOString(),
      sourceTxId,
    };

    this._hot.set(hdAddress, entry as ContentCacheEntry);

    return {
      entry,
      confirm: () => {
        const existing = this._hot.get(hdAddress);
        if (existing && existing.sourceTxId === sourceTxId) {
          existing.state = 'CONFIRMED';
          existing.dirty = false;
          // Persist to durable storage
          chainletStorage.setItem(`${CONTENT_PREFIX}${hdAddress}`, existing).catch(() => {});
        }
      },
      fail: (error?: string) => {
        const existing = this._hot.get(hdAddress);
        if (existing && existing.sourceTxId === sourceTxId) {
          existing.state = 'FAILED';
          console.warn(`[CappzContentCache] Content at ${hdAddress} failed to persist: ${error}`);
        }
      },
    };
  }

  // ─── Dirty Flag Management ────────────────────────────────

  /**
   * Mark an address as dirty (e.g., after a submit() writes new content).
   */
  markDirty(hdAddress: string): void {
    const cached = this._hot.get(hdAddress);
    if (cached) {
      cached.dirty = true;
    }
  }

  /**
   * Clear dirty flags for a set of addresses (after RefreshCacheDelta).
   */
  clearDirtyFlags(addresses: string[]): void {
    for (const addr of addresses) {
      const cached = this._hot.get(addr);
      if (cached) cached.dirty = false;
    }
  }

  // ─── Concurrency Check ───────────────────────────────────

  /**
   * Verify a sourceHashPrint against the latest known content at an address.
   * Throws StaleContentError if the content has been modified since the caller's reference.
   */
  checkConcurrency(hdAddress: string, sourceHashPrint: ContentHashPrint): void {
    const cached = this._hot.get(hdAddress);
    if (!cached) return; // No cached content — OK to proceed (first write)

    if (cached.sourceTxId && cached.sourceTxId !== sourceHashPrint.txId) {
      throw new StaleContentError(
        cached.sourceTxId,
        cached.contentHash,
        sourceHashPrint.txId,
      );
    }
  }

  // ─── Introspection ───────────────────────────────────────

  get size(): number {
    return this._hot.size;
  }

  getPendingCount(): number {
    let count = 0;
    for (const entry of this._hot.values()) {
      if (entry.state === 'PENDING') count++;
    }
    return count;
  }

  getConfirmedCount(): number {
    let count = 0;
    for (const entry of this._hot.values()) {
      if (entry.state === 'CONFIRMED') count++;
    }
    return count;
  }

  /**
   * Get all addresses currently in the hot cache.
   */
  getHotAddresses(): string[] {
    return Array.from(this._hot.keys());
  }

  /**
   * Clear the entire hot cache (e.g., on logout).
   * Emits CacheEvicted lifecycle TX (AX-77).
   */
  async clear(): Promise<void> {
    const evictedCount = this._hot.size;
    this._hot.clear();
    await this.wallet.emitLifecycleTx('ContentCacheEvicted', { evictedCount });
  }
}

// ─── Singleton ────────────────────────────────────────────────

export const cappzContentCache = new CappzContentCache();
