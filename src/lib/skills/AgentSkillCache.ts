/**
 * AgentSkillCache — Thread-safe singleton event cache for all skill config TXs.
 *
 * AP-12 compliant: All state derived from event TX existence, not boolean flags.
 * Thread-safe: Only `persistAndRefresh()` mutates cache. All clients read via getCached().
 *
 * HD: m/44'/144'/0'/cappz/skill-config/events/
 *
 * Query helpers:
 *   getByAddress(hdAddress) — filter by source/target HD address
 *   getByEventType(type) — filter by event type
 *   getByEventTypes(types) — filter by multiple event types
 *   isActive(addedType, removedType, filterFn) — net-active entries (Added without subsequent Removed)
 */

import { CappzEventCache, type CappzEventCacheEntry } from '../sync/CappzEventCache';

// ─── Types ────────────────────────────────────────────────────

export interface SkillConfigCacheEntry extends CappzEventCacheEntry {
  eventType: string;
  sourceAddress: string;
  targetAddress?: string;
  payload: Record<string, unknown>;
}

// ─── Singleton ────────────────────────────────────────────────

const SKILL_CONFIG_HD = "m/44'/144'/0'/cappz/skill-config/events/";
const SKILL_CONFIG_PREFIX = 'cappz:skill-config/events/';

const _cache = new CappzEventCache<SkillConfigCacheEntry>(
  SKILL_CONFIG_HD,
  SKILL_CONFIG_PREFIX,
);

let _refreshLock = false;

// ─── Public API ───────────────────────────────────────────────

export const agentSkillCache = {
  /** Authorized composition amendments commit as one flushed wallet batch. */
  async persistBatch(entries: readonly SkillConfigCacheEntry[]): Promise<void> {
    while (_refreshLock) await new Promise(resolve => setTimeout(resolve, 10));
    _refreshLock = true;
    try { await _cache.appendMany(entries, { requireDurable: true }); }
    finally { _refreshLock = false; }
  },
  /**
   * Persist a new entry and refresh the cache. The ONLY write path.
   * Thread-safe via refresh lock — concurrent calls queue behind the lock.
   */
  async persistAndRefresh(entry: SkillConfigCacheEntry): Promise<void> {
    // Wait for any in-flight refresh
    while (_refreshLock) {
      await new Promise(r => setTimeout(r, 10));
    }
    _refreshLock = true;
    try {
      await _cache.append(entry);
    } finally {
      _refreshLock = false;
    }
  },

  /**
   * Hydrate cache from storage. Called on boot.
   */
  async refresh(): Promise<SkillConfigCacheEntry[]> {
    while (_refreshLock) {
      await new Promise(r => setTimeout(r, 10));
    }
    _refreshLock = true;
    try {
      return await _cache.refresh();
    } finally {
      _refreshLock = false;
    }
  },

  /**
   * AX-74 Wallet-First Hydration. Pulls event TXs touching any of the supplied
   * HD address prefixes (source or target) directly from durable
   * chainlet_blocks. Single-writer safe via the refresh lock.
   */
  async hydrateFromWalletPartitions(hdAddressPrefixes: string[]): Promise<number> {
    while (_refreshLock) {
      await new Promise(r => setTimeout(r, 10));
    }
    _refreshLock = true;
    try {
      return await _cache.hydrateFromWalletPartition(hdAddressPrefixes);
    } finally {
      _refreshLock = false;
    }
  },

  /**
   * v11-2-014: In-memory staging fallback. Appends entry to the in-memory cache
   * and dispatches the event-type window event, without touching durable
   * storage. Used by emitLifecycle when persistAndRefresh throws so the current
   * session still resolves skills to Live during migration.
   */
  stageInMemory(entry: SkillConfigCacheEntry): void {
    _cache.stageInMemory(entry);
  },

  /**
   * Read-only access to cached entries. No I/O.
   */
  getCached(): SkillConfigCacheEntry[] {
    return _cache.getCached();
  },

  /**
   * Subscribe to cache changes.
   */
  subscribe(callback: (entries: SkillConfigCacheEntry[]) => void): () => void {
    return _cache.subscribe(callback);
  },


  // ─── Query Helpers ────────────────────────────────────────

  /** Filter by source or target HD address. */
  getByAddress(hdAddress: string): SkillConfigCacheEntry[] {
    return _cache.getCached().filter(
      e => e.sourceAddress === hdAddress || e.targetAddress === hdAddress
    );
  },

  /** Filter by event type. */
  getByEventType(eventType: string): SkillConfigCacheEntry[] {
    return _cache.getCached().filter(e => e.eventType === eventType);
  },

  /** Filter by multiple event types. */
  getByEventTypes(eventTypes: string[]): SkillConfigCacheEntry[] {
    const set = new Set(eventTypes);
    return _cache.getCached().filter(e => set.has(e.eventType));
  },

  /**
   * Highest timestamp among the supplied event types. Used by skillGraphBroker
   * to detect when a cached serialized graph is stale.
   */
  getMaxEventTimestamp(eventTypes: readonly string[]): number {
    const set = new Set(eventTypes);
    let max = 0;
    for (const entry of _cache.getCached()) {
      if (!set.has(entry.eventType)) continue;
      const ts = Date.parse(String(entry.timestamp ?? '')) || 0;
      if (ts > max) max = ts;
    }
    return max;
  },

  /**
   * Get net-active entries: entries with `addedType` event that have no subsequent
   * `removedType` event for the same target address.
   *
   * Optionally provide a filterFn to narrow scope before the active check.
   */
  isActive(
    addedType: string,
    removedType: string,
    filterFn?: (e: SkillConfigCacheEntry) => boolean,
  ): SkillConfigCacheEntry[] {
    const all = _cache.getCached();
    let added = all.filter(e => e.eventType === addedType);
    if (filterFn) added = added.filter(filterFn);

    const latestRemovedAt = new Map<string, number>();
    for (const entry of all) {
      if (entry.eventType !== removedType) continue;
      const key = entry.targetAddress ?? entry.sourceAddress;
      const ts = new Date(entry.timestamp).getTime();
      const current = latestRemovedAt.get(key) ?? Number.NEGATIVE_INFINITY;
      if (ts > current) latestRemovedAt.set(key, ts);
    }

    return added.filter(e => {
      const key = e.targetAddress ?? e.sourceAddress;
      const addedAt = new Date(e.timestamp).getTime();
      const removedAt = latestRemovedAt.get(key) ?? Number.NEGATIVE_INFINITY;
      return addedAt > removedAt;
    });
  },

  /** Cache size. */
  get size(): number {
    return _cache.size;
  },

  /** Whether cache has been hydrated. */
  get isHydrated(): boolean {
    return _cache.isHydrated;
  },
};
