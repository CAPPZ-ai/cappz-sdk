/**
 * CappzEventCache<T> — Generic address-partitioned event cache (Skill #38.6)
 *
 * Replaces volatile KV-based caching with chainlet TX persistence.
 * Entries are sovereign chainlet transactions — browser storage eviction
 * cannot destroy them. Only an explicit purge() call removes data.
 *
 * AX-71: Ops-log entries are chainlet TXs, not KV entries.
 * AX-63: Single Storage Stack — all state flows through cappz-middleware.
 * AX-70: Event-driven cache invalidation via CreateEventSubscription.
 *
 * Write path:
 *   append(tx) → chainletSync.set(store, key, tx) → persistent block
 *   → cappzMiddleware.notify() → subscribers refresh
 *
 * Read path:
 *   refresh() → chainletSync.get() to hydrate in-memory cache
 *              → fallback: query chainlet_blocks by HD address prefix
 *              → rebuild local index if recovered from durable store
 *   getCached() → pure in-memory read (O(1))
 *
 * Reactivity:
 *   subscribe() → CreateEventSubscription(hdAddress, refresh)
 *
 * HD: m/44'/144'/0'/cappz/sync/event-cache
 */

import { CreateEventSubscription } from './CreateEventSubscription';
import { chainletStorage } from './chainletStorage';
import { ChainletStoreParamType, getChainletParam } from './chainletStoreParams';
import { canonicalizeEventEntry, recordedFormOf } from '../mdm/eventTypeAliases';



// ─── Types ────────────────────────────────────────────────────

export interface CappzEventCacheEntry {
  txId: string;
  timestamp: string;
}

const MEMORY_PARTITIONS = new Map<string, CappzEventCacheEntry[]>();

function getMemoryPartition<T extends CappzEventCacheEntry>(cachePrefix: string): T[] {
  return ((MEMORY_PARTITIONS.get(cachePrefix) ?? []) as T[]).map(e => ({ ...e }));
}

function writeMemoryPartition<T extends CappzEventCacheEntry>(cachePrefix: string, entries: T[]): void {
  const deduped = new Map<string, T>();
  for (const entry of entries) deduped.set(entry.txId, entry);
  MEMORY_PARTITIONS.set(
    cachePrefix,
    Array.from(deduped.values()).sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    ),
  );
}

// ─── Generic Event Cache ──────────────────────────────────────

export class CappzEventCache<T extends CappzEventCacheEntry> {
  private _cache: T[] = [];
  private _hydrated = false;
  private _inflight: Promise<T[]> | null = null;
  private readonly _indexKey: string;

  /**
   * @param hdAddress - HD address prefix for this cache partition
   * @param cachePrefix - KV key prefix for individual entries under this partition
   */
  constructor(
    private readonly hdAddress: string,
    private readonly cachePrefix: string,
  ) {
    this._indexKey = `${cachePrefix}__index__`;
  }

  // ─── Read ────────────────────────────────────────────────────

  /**
   * Hydrate in-memory cache from chainlet storage TXs at this address.
   * This is the RefreshEventCache(hdAddress) operation.
   *
   * v12-14-a: once hydrated, this is a pure in-memory merge — repeated page
   * mounts no longer re-read the store. Concurrent first calls share one
   * in-flight hydration instead of racing.
   *
   * Recovery strategy:
   *   1. Read local __index__ from chainletStorage (hot cache), batched
   *   2. If empty → fallback to durable chainlet blocks via chainletSync
   *   3. If recovered from durable → rebuild local index for next read
   */
  async refresh(): Promise<T[]> {
    if (this._hydrated) return this._mergeMemorySnapshot();
    if (this._inflight) return this._inflight;
    this._inflight = this._refreshFromStore().finally(() => { this._inflight = null; });
    return this._inflight;
  }

  /** Merge sibling-instance writes from the shared memory partition. */
  private _mergeMemorySnapshot(): T[] {
    const partitionEntries = getMemoryPartition<T>(this.cachePrefix);
    if (partitionEntries.length > 0) {
      const known = new Set(this._cache.map((e) => e.txId));
      const additions = partitionEntries.filter((e) => !known.has(e.txId));
      if (additions.length > 0) {
        this._cache = [...this._cache, ...additions].sort(
          (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        );
      }
    }
    return [...this._cache];
  }

  private async _refreshFromStore(): Promise<T[]> {

    try {
      const storedIndex = await chainletStorage.getItem<Array<{ txId: string; key: string }>>(this._indexKey);
      // Older append() calls updated this shared index concurrently. The last
      // writer could win with only one of a large ingest batch, leaving the
      // transactions in the wallet store but invisible after refresh. Rebuild
      // the index from the partition keys before hydration; this is recovery,
      // not a state mutation, and is idempotent.
      const partitionKeys = (await chainletStorage.keys())
        .filter((key) => key.startsWith(this.cachePrefix) && key !== this._indexKey);
      const indexedByKey = new Map((storedIndex ?? []).map((ref) => [ref.key, ref]));
      const index = partitionKeys.map((key) => {
        const held = indexedByKey.get(key);
        return held ?? { txId: key.slice(this.cachePrefix.length), key };
      });

      if (index.length !== (storedIndex?.length ?? 0)) {
        await chainletStorage.setItem(this._indexKey, index);
      }

      if (index?.length) {
        // Hot-cache path — index exists locally
        return this._hydrateFromIndex(index);
      }

      // ── Durable Recovery (with timeout) ───────────────────────
      // Local index is empty/missing. Attempt recovery from chainlet blocks.
      // Guard with 8s timeout to prevent UI hanging on slow/failed Supabase queries.
      const recovered = await Promise.race([
        this._recoverFromChainlet(),
        new Promise<T[]>(resolve => setTimeout(() => {
          console.warn(`[CappzEventCache] Durable recovery timed out for ${this.cachePrefix}`);
          resolve([]);
        }, 8000)),
      ]);
      if (recovered.length > 0) {
        console.log(`[CappzEventCache] Recovered ${recovered.length} entries from durable chainlet for ${this.cachePrefix}`);
        // Rebuild local index so future reads are fast
        await this._rebuildLocalIndex(recovered);
        this._cache = recovered.map((entry) => canonicalizeEventEntry(entry)).sort(
          (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        );
        this._hydrated = true;
        return [...this._cache];
      }

      // Merge with any in-memory entries (race safety)
      const partitionEntries = getMemoryPartition<T>(this.cachePrefix);
      if (partitionEntries.length > 0) {
        this._cache = partitionEntries;
        this._hydrated = true;
        return [...this._cache];
      }

      if (this._cache.length > 0) {
        // AX-79 drift signal: local cache is populated but the cloud
        // partition came back empty. Either RLS is blocking, the partition
        // hasn't been synced upward yet, or the writer used the wrong key
        // shape. Surface loudly so a fresh-browser regression is caught
        // immediately instead of being masked by stale IndexedDB.
        console.warn(
          `[CappzEventCache] DRIFT: local cache has ${this._cache.length} entries for ${this.cachePrefix} but durable chainlet returned 0. ` +
          `Fresh browsers will see an empty cache. Check RLS / sync writer key shape.`,
        );
        this._hydrated = true;
        return [...this._cache];
      }

      this._hydrated = true;
      return [];
    } catch {
      this._hydrated = true;
      if (this._cache.length > 0) return [...this._cache];
      return [];
    }
  }

  /**
   * FetchEvents — Filter cached events by a CacheFilter.
   * Supports rootHdAddress prefix matching, eventType filtering, and since-timestamp.
   */
  async FetchEvents(filter: {
    rootHdAddress: string;
    eventTypes?: string[];
    since?: string;
  }): Promise<T[]> {
    // Ensure hydrated
    if (!this._hydrated) await this.refresh();

    let results = [...this._cache];

    // Filter by root address prefix (source or target)
    results = results.filter(tx => {
      const source = (tx as any).sourceAddress as string | undefined;
      const target = (tx as any).targetAddress as string | undefined;
      return (
        (source && source.startsWith(filter.rootHdAddress)) ||
        (target && target.startsWith(filter.rootHdAddress))
      );
    });

    // Filter by event types
    if (filter.eventTypes?.length) {
      const typeSet = new Set(filter.eventTypes);
      results = results.filter(tx => typeSet.has((tx as any).eventType ?? ''));
    }

    // Filter by since timestamp
    if (filter.since) {
      const sinceMs = new Date(filter.since).getTime();
      results = results.filter(tx => new Date(tx.timestamp).getTime() > sinceMs);
    }

    return results;
  }

  /**
   * FetchNewEvents — Incremental fetch for specified HD addresses since their last sync.
   * Returns only TXs newer than the per-address timestamps.
   */
  async FetchNewEvents(
    hdAddresses: string[],
    sinceTimestamps: Map<string, string>,
  ): Promise<T[]> {
    if (!this._hydrated) await this.refresh();

    const addressSet = new Set(hdAddresses);

    return this._cache.filter(tx => {
      const source = (tx as any).sourceAddress as string | undefined;
      const target = (tx as any).targetAddress as string | undefined;

      // TX must involve at least one of the requested addresses
      const matchesSource = source && addressSet.has(source);
      const matchesTarget = target && addressSet.has(target);
      if (!matchesSource && !matchesTarget) return false;

      // Check timestamp against the relevant address's last sync
      const txTime = new Date(tx.timestamp).getTime();
      const relevantAddr = matchesSource ? source! : target!;
      const sinceStr = sinceTimestamps.get(relevantAddr);
      if (sinceStr) {
        return txTime > new Date(sinceStr).getTime();
      }
      return true;
    });
  }

  /**
   * Get cached entries (pure in-memory, no I/O).
   */
  getCached(): T[] {
    return [...this._cache];
  }

  /**
   * AX-74 Wallet-First Hydration:
   * Pull every chainlet_blocks row whose syncBlock value is an event TX
   * touching one of the supplied HD address prefixes (source or target),
   * dedupe by txId, merge into the in-memory cache, and rebuild the local
   * index so subsequent reads are fast.
   *
   * This is how a fresh browser/origin recovers chain-resident state for the
   * current user without the static-array fallback.
   *
   * Returns the number of distinct TXs added.
   */
  async hydrateFromWalletPartition(hdAddressPrefixes: string[]): Promise<number> {
    if (hdAddressPrefixes.length === 0) return 0;
    // v11-2-014: local-first — no direct browser Supabase reads.
    // When UseCloudPersistence=true, canonical state arrives via a2a-push
    // from the escrowed cappz-store wallet; edges never query the DB directly.
    if (!getChainletParam(ChainletStoreParamType.UseCloudPersistence)) {
      this._hydrated = true;
      return 0;
    }
    // Cloud-tier hydration is delegated to a2a subscription — no-op here.
    this._hydrated = true;
    return 0;
  }


  // ─── Write ───────────────────────────────────────────────────

  /**
   * Append a new TX entry. Persists to chainletStorage and updates index.
   * The entry becomes a sovereign TX that survives browser storage pressure.
   *
   * v11-12-15: `{ requireDurable: true }` awaits the durable chainlet write
   * and THROWS on failure instead of swallowing it. Genesis and notarization
   * callers use this so a blocked block store surfaces as "staged in memory"
   * rather than silently leaving the replay empty on every other device.
   */
  async append(tx: T, options?: { requireDurable?: boolean }): Promise<void> {
    const entryKey = `${this.cachePrefix}${tx.txId}`;

    // 1. Local-first visibility. UI state resolves from the in-memory event TX
    // set immediately; chainlet block creation is secondary and must never make
    // the current render wait or fall back to Classified.
    if (!this._cache.some(e => e.txId === tx.txId)) {
      this._cache.push(tx);
    }
    writeMemoryPartition(this.cachePrefix, this._cache);
    if (!options?.requireDurable) {
      void chainletStorage.setItem(entryKey, tx)
        .then(() => this._updateIndex(tx.txId, entryKey))
        .catch(() => {});
    } else {
      await chainletStorage.setItem(entryKey, tx);
      await this._updateIndex(tx.txId, entryKey);
    }

    // 2. Chainlet block append. Without requireDurable this stays a background
    // durability warning; with it, a missing/blocked store is the caller's
    // error to report.
    const anchor = import('./chainletSyncAdapter')
      .then(({ chainletSync }) => chainletSync.set(this.hdAddress, entryKey, tx));
    if (options?.requireDurable) {
      await anchor.catch((err) => {
        throw new Error(
          `[CappzEventCache] Durable chainlet anchor failed for ${tx.txId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    } else {
      anchor.catch((err) => {
        console.warn(`[CappzEventCache] Chainlet anchor failed for ${tx.txId}`, err);
      });
    }
  }

  /**
   * Persist an immutable event batch with one index update. This avoids the
   * lost-update race created when hundreds of append() calls each rewrite the
   * same index independently.
   */
  async appendMany(entries: readonly T[], options?: { requireDurable?: boolean }): Promise<void> {
    const existing = new Set(this._cache.map((entry) => entry.txId));
    const additions: T[] = [];
    for (const entry of entries) {
      if (existing.has(entry.txId)) continue;
      existing.add(entry.txId);
      additions.push(entry);
    }
    if (!additions.length) return;

    const refs = additions.map((entry) => ({
      txId: entry.txId,
      key: `${this.cachePrefix}${entry.txId}`,
    }));
    const expose = () => {
      for (const entry of additions) this._cache.push(entry);
      this._cache.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      writeMemoryPartition(this.cachePrefix, this._cache);
    };

    if (options?.requireDurable) {
      // v14-12-12 — all or nothing. The batch, its index and ONE chainlet block
      // carrying every entry commit in a single local transaction; only then
      // does the batch become visible in memory and anchor (queued whole to the
      // outbox when the cloud is unavailable). A failure leaves no trace of the
      // batch anywhere — never a business record without its journal entry.
      const { chainletSync } = await import('./chainletSyncAdapter');
      const held = (await chainletStorage.getItem<Array<{ txId: string; key: string }>>(this._indexKey)) ?? [];
      const merged = new Map(held.map((ref) => [ref.txId, ref]));
      for (const ref of refs) merged.set(ref.txId, ref);
      const prepared = await chainletSync.prepareBatch(
        this.hdAddress,
        refs.map((ref, index) => ({ key: ref.key, value: additions[index] })),
      );
      await chainletStorage.setItems([
        ...refs.map((ref, index) => [ref.key, additions[index]] as [string, unknown]),
        [this._indexKey, [...merged.values()]],
        ...prepared.kvRows,
      ]);
      // Durable means on disk: OPFS writes are debounced, so await the flush
      // before the batch is exposed, anchored or reported done (AGENTS.md).
      const { flushActiveKvEngine } = await import('./storageEngines/engineSelection');
      await flushActiveKvEngine();
      expose();
      await prepared.commit();
      return;
    }

    expose();
    const persist = async () => {
      await Promise.all(refs.map((ref, index) => chainletStorage.setItem(ref.key, additions[index])));
      const held = (await chainletStorage.getItem<Array<{ txId: string; key: string }>>(this._indexKey)) ?? [];
      const merged = new Map(held.map((ref) => [ref.txId, ref]));
      for (const ref of refs) merged.set(ref.txId, ref);
      await chainletStorage.setItem(this._indexKey, [...merged.values()]);
    };
    const anchor = async () => {
      const { chainletSync } = await import('./chainletSyncAdapter');
      await Promise.all(refs.map((ref, index) => chainletSync.set(this.hdAddress, ref.key, additions[index])));
    };
    void persist().catch(() => {});
    void anchor().catch((error) => console.warn('[CappzEventCache] Batch anchor failed', error));
  }

  /**
   * Update an existing entry in-place. Write-through to storage.
   */
  async update(txId: string, updater: (entry: T) => T): Promise<T | null> {
    const idx = this._cache.findIndex(e => e.txId === txId);
    if (idx === -1) return null;

    const updated = updater(this._cache[idx]);
    this._cache[idx] = updated;

    const entryKey = `${this.cachePrefix}${txId}`;
    await chainletStorage.setItem(entryKey, recordedFormOf(updated)).catch(() => {});

    return updated;
  }

  // ─── Subscribe ───────────────────────────────────────────────

  /**
   * Subscribe to changes at this HD address via CreateEventSubscription.
   * Callback receives refreshed entries on every mutation.
   */
  subscribe(callback: (entries: T[]) => void): () => void {
    return CreateEventSubscription(this.cachePrefix, async () => {
      const entries = await this.refresh();
      callback(entries);
    });
  }

  // ─── Purge ───────────────────────────────────────────────────

  /**
   * Purge ALL entries at this address. This is the ONLY way to delete data.
   * Must be called explicitly (e.g., agentSkill.purgeOpsLog()).
   */
  async purge(): Promise<number> {
    const allKeys = await chainletStorage.keys();
    const matchingKeys = allKeys.filter(k => k.startsWith(this.cachePrefix));

    if (matchingKeys.length > 0) {
      await Promise.all(matchingKeys.map(k => chainletStorage.removeItem(k)));
    }

    const count = this._cache.length;
    this._cache = [];
    this._hydrated = false;

    console.log(`[CappzEventCache] Purged ${matchingKeys.length} keys at ${this.cachePrefix}`);
    return count;
  }

  // ─── Introspection ──────────────────────────────────────────

  get size(): number {
    return this._cache.length;
  }

  get isHydrated(): boolean {
    return this._hydrated;
  }

  /**
   * v11-2-014: In-memory-only staging. Bypasses durable append entirely so
   * a UI can reflect state during a migration or when the store is being
   * rebuilt. Used as a fallback in emitLifecycle when persistAndRefresh throws.
   */
  stageInMemory(entry: T): void {
    if (!this._cache.some(e => e.txId === entry.txId)) {
      this._cache.push(entry);
      this._cache.sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );
    }
    writeMemoryPartition(this.cachePrefix, this._cache);
    this._hydrated = true;
    if (typeof window !== 'undefined') {
      const eventType = (entry as any).eventType;
      if (typeof eventType === 'string') {
        try { window.dispatchEvent(new CustomEvent(eventType)); } catch { /* noop */ }
      }
    }
  }

  // ─── Internal ────────────────────────────────────────────────

  private async _updateIndex(txId: string, entryKey: string): Promise<void> {
    const index = (await chainletStorage.getItem<Array<{ txId: string; key: string }>>(this._indexKey)) ?? [];
    if (!index.some(i => i.txId === txId)) {
      index.push({ txId, key: entryKey });
      await chainletStorage.setItem(this._indexKey, index);
    }
  }

  /**
   * Hydrate cache from a local index (hot-cache path).
   */
  private async _hydrateFromIndex(index: Array<{ txId: string; key: string }>): Promise<T[]> {
    // v12-14-a: one batched store read for the whole partition instead of a
    // serial round trip per transaction.
    const loaded = await chainletStorage.getItems<T>(index.map((ref) => ref.key));
    // v12-20-06: retired event names read under their current name, in
    // memory only — the stored transaction is never rewritten.
    const entries: T[] = loaded
      .filter((entry): entry is T => Boolean(entry))
      .map((entry) => canonicalizeEventEntry(entry));


    // Merge with any in-memory entries not yet in storage (race safety)
    const existingIds = new Set(entries.map(e => e.txId));
    for (const memEntry of this._cache) {
      if (!existingIds.has(memEntry.txId)) {
        entries.push(memEntry);
      }
    }

    this._cache = entries.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    this._hydrated = true;
    return [...this._cache];
  }

  /**
   * v11-2-014: Local-first — durable recovery from cloud is a no-op on edges.
   * When UseCloudPersistence=true, canonical state arrives via a2a-push, not
   * browser Supabase reads.
   */
  private async _recoverFromChainlet(): Promise<T[]> {
    return [];
  }

  /** Deprecated / kept for API stability. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async _scanChainletBlocksForPrefix(): Promise<string[]> {
    return [];
  }


  /**
   * Rebuild the local __index__ from recovered entries so future reads
   * can use the fast hot-cache path.
   */
  private async _rebuildLocalIndex(entries: T[]): Promise<void> {
    const index: Array<{ txId: string; key: string }> = [];
    for (const entry of entries) {
      const entryKey = `${this.cachePrefix}${entry.txId}`;
      // Re-persist each entry to local storage, exactly as it was recorded.
      await chainletStorage.setItem(entryKey, recordedFormOf(entry)).catch(() => {});
      index.push({ txId: entry.txId, key: entryKey });
    }
    await chainletStorage.setItem(this._indexKey, index).catch(() => {});
  }
}
