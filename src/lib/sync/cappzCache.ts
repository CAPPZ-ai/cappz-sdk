/**
 * cappzCache — Graph-based cache orchestrator with dual-mode hydration.
 *
 * InitializeCache: Cold start — full hydration from EventCache + ContentCache.
 * RefreshCacheDelta: Hot path — incremental delta for known HD addresses.
 * EnsureCache: Convenience — init if cold, delta if warm.
 *
 * Graph engine: graphology (MIT, 8KB gzip, zero deps).
 * Nodes = HD addresses, Edges = TXs (source→target with event metadata + state).
 *
 * AX-63: All state via cappz-middleware.
 * AX-77: Hosted in a session wallet with admin queue (InfraSessionWallet).
 * AX-78: Cache writes accompanied by high-QoS Event TX for federated sync.
 * HD: m/44'/144'/0'/cappz/sync/cache
 */

import Graph from 'graphology';
import { CappzEventCache, type CappzEventCacheEntry } from './CappzEventCache';
import { cappzContentCache, type ContentCacheEntry } from './CappzContentCache';
import { InfraSessionWallet } from './InfraSessionWallet';
import { middlewareNotify } from './cappz-middleware';

// ─── Types ────────────────────────────────────────────────────

export interface CacheFilter {
  rootHdAddress: string;
  eventTypes?: string[];
  since?: string;
}

export interface CacheSnapshot {
  eventTxs: CappzEventCacheEntry[];
  contentMap: Map<string, ContentCacheEntry>;
  hydratedAt: string;
}

export interface CacheDelta {
  newTxs: CappzEventCacheEntry[];
  newContent: Map<string, ContentCacheEntry>;
  deltaAt: string;
}

export interface CappzCacheNodeAttributes {
  type: string;
  hdAddress: string;
  firstSeen: string;
  [key: string]: unknown;
}

export interface CappzCacheEdgeAttributes {
  txId: string;
  eventType: string;
  contentHash?: string;
  state: 'PENDING' | 'CONFIRMED' | 'FAILED';
  timestamp: string;
  /** Immutable source transaction retained so domain resolvers can replay from the graph. */
  event?: CappzEventCacheEntry;
  [key: string]: unknown;
}

// ─── Cache Orchestrator ───────────────────────────────────────

export class CappzCache {
  readonly graph: Graph<CappzCacheNodeAttributes, CappzCacheEdgeAttributes>;
  private _lastSyncTimestamps = new Map<string, string>();
  private _initialized = false;

  /** AX-77: Session wallet with admin queue */
  readonly wallet: InfraSessionWallet;

  constructor(domain?: string) {
    this.graph = new Graph<CappzCacheNodeAttributes, CappzCacheEdgeAttributes>({
      multi: true, // Multiple edges between same nodes (multiple TXs)
      type: 'directed',
    });
    this.wallet = new InfraSessionWallet({
      serviceType: 'Cache',
      domain: domain ?? 'global',
    });
  }

  // ─── InitializeCache (Cold Start) ─────────────────────────

  /**
   * Full hydration from EventCache + ContentCache.
   * Builds the graph from scratch. Used on boot or after cache clear.
   */
  async InitializeCache(
    filter: CacheFilter,
    eventCache: CappzEventCache<CappzEventCacheEntry>,
  ): Promise<CacheSnapshot> {
    // AX-77: Emit lifecycle TX
    await this.wallet.emitLifecycleTx('CacheInitialized', {
      rootHdAddress: filter.rootHdAddress,
      eventTypes: filter.eventTypes,
    });

    // 1. Fetch events
    const eventTxs = await eventCache.FetchEvents(filter);

    // 2. Collect all unique addresses
    const allAddresses = new Set<string>();
    for (const tx of eventTxs) {
      const source = (tx as any).sourceAddress as string | undefined;
      const target = (tx as any).targetAddress as string | undefined;
      if (source) allAddresses.add(source);
      if (target) allAddresses.add(target);
    }

    // 3. Fetch content for all addresses
    const contentMap = await cappzContentCache.FetchContent(Array.from(allAddresses));

    // 4. Build graph
    this._buildGraphFromEvents(eventTxs);

    // 5. Mark all addresses as clean and record sync timestamps
    const now = new Date().toISOString();
    cappzContentCache.clearDirtyFlags(Array.from(allAddresses));
    for (const addr of allAddresses) {
      this._lastSyncTimestamps.set(addr, now);
    }

    this._initialized = true;

    return { eventTxs, contentMap, hydratedAt: now };
  }

  // ─── RefreshCacheDelta (Hot Path) ─────────────────────────

  /**
   * Incremental delta — fetches only new TXs and content for specified addresses.
   * Used for live updates after initial hydration.
   */
  async RefreshCacheDelta(
    hdAddresses: string[],
    eventCache: CappzEventCache<CappzEventCacheEntry>,
  ): Promise<CacheDelta> {
    const sinceTimestamps = new Map<string, string>();
    for (const addr of hdAddresses) {
      sinceTimestamps.set(addr, this._lastSyncTimestamps.get(addr) ?? '1970-01-01T00:00:00.000Z');
    }

    // 1. Fetch new events since last sync
    const newTxs = await eventCache.FetchNewEvents(hdAddresses, sinceTimestamps);

    // 2. Collect dirty/new addresses from new TXs
    const dirtyAddresses = new Set<string>();
    for (const tx of newTxs) {
      const source = (tx as any).sourceAddress as string | undefined;
      const target = (tx as any).targetAddress as string | undefined;
      if (source) dirtyAddresses.add(source);
      if (target) dirtyAddresses.add(target);
    }

    // 3. Fetch content for dirty addresses only
    const newContent = await cappzContentCache.FetchContent(Array.from(dirtyAddresses));

    // 4. Add new edges to graph
    this._buildGraphFromEvents(newTxs);

    // 5. Update sync timestamps
    const now = new Date().toISOString();
    for (const addr of hdAddresses) {
      this._lastSyncTimestamps.set(addr, now);
    }
    cappzContentCache.clearDirtyFlags(Array.from(dirtyAddresses));

    // AX-77: Emit lifecycle TX
    if (newTxs.length > 0) {
      await this.wallet.emitLifecycleTx('CacheDeltaRefreshed', {
        addressCount: hdAddresses.length,
        newTxCount: newTxs.length,
      });
    }

    return { newTxs, newContent, deltaAt: now };
  }

  // ─── EnsureCache (Auto-Select) ────────────────────────────

  /**
   * Convenience: InitializeCache if cold, RefreshCacheDelta if warm.
   */
  async EnsureCache(
    filter: CacheFilter,
    eventCache: CappzEventCache<CappzEventCacheEntry>,
  ): Promise<CacheSnapshot | CacheDelta> {
    if (!this._initialized) {
      return this.InitializeCache(filter, eventCache);
    }
    return this.RefreshCacheDelta([filter.rootHdAddress], eventCache);
  }

  // ─── Graph Queries ────────────────────────────────────────

  /**
   * Get all TX edges originating from or targeting an HD address.
   */
  getTransactionsForAddress(hdAddress: string): CappzCacheEdgeAttributes[] {
    if (!this.graph.hasNode(hdAddress)) return [];
    const edges: CappzCacheEdgeAttributes[] = [];
    this.graph.forEachEdge(hdAddress, (_edge, attrs) => {
      edges.push(attrs);
    });
    return edges;
  }

  /**
   * Get all neighbor addresses (directly connected via TXs).
   */
  getNeighbors(hdAddress: string): string[] {
    if (!this.graph.hasNode(hdAddress)) return [];
    return this.graph.neighbors(hdAddress);
  }

  /**
   * Get inbound TXs targeting an address.
   */
  getInboundTxs(hdAddress: string): CappzCacheEdgeAttributes[] {
    if (!this.graph.hasNode(hdAddress)) return [];
    const edges: CappzCacheEdgeAttributes[] = [];
    this.graph.forEachInEdge(hdAddress, (_edge, attrs) => {
      edges.push(attrs);
    });
    return edges;
  }

  /**
   * Get outbound TXs from an address.
   */
  getOutboundTxs(hdAddress: string): CappzCacheEdgeAttributes[] {
    if (!this.graph.hasNode(hdAddress)) return [];
    const edges: CappzCacheEdgeAttributes[] = [];
    this.graph.forEachOutEdge(hdAddress, (_edge, attrs) => {
      edges.push(attrs);
    });
    return edges;
  }

  /** Project immutable event TXs into this domain graph. Safe to call repeatedly. */
  projectEvents(events: readonly CappzEventCacheEntry[]): void {
    this._buildGraphFromEvents([...events]);
    this._initialized = true;
  }

  /** Replay every source TX held by this domain graph. */
  getAllEvents<T extends CappzEventCacheEntry>(): T[] {
    const events = new Map<string, T>();
    this.graph.forEachEdge((_edge, attrs) => {
      const event = attrs.event as T | undefined;
      if (event) events.set(event.txId, event);
    });
    return [...events.values()];
  }

  /** Replay source TXs held by graph edges under an address prefix. */
  getEventsForRoot<T extends CappzEventCacheEntry>(rootHdAddress: string): T[] {
    const events = new Map<string, T>();
    this.graph.forEachEdge((_edge, attrs, source, target) => {
      if (!source.startsWith(rootHdAddress) && !target.startsWith(rootHdAddress)) return;
      const event = attrs.event as T | undefined;
      if (event) events.set(event.txId, event);
    });
    return [...events.values()];
  }

  // ─── Introspection ───────────────────────────────────────

  get nodeCount(): number {
    return this.graph.order;
  }

  get edgeCount(): number {
    return this.graph.size;
  }

  get isInitialized(): boolean {
    return this._initialized;
  }

  /**
   * Clear the graph and reset state. Emits CacheEvicted lifecycle TX.
   */
  async clear(): Promise<void> {
    this.graph.clear();
    this._lastSyncTimestamps.clear();
    this._initialized = false;
    await this.wallet.emitLifecycleTx('CacheEvicted');
  }

  // ─── Internal ─────────────────────────────────────────────

  private _buildGraphFromEvents(events: CappzEventCacheEntry[]): void {
    for (const tx of events) {
      const source = (tx as any).sourceAddress as string | undefined;
      const target = (tx as any).targetAddress as string | undefined;

      // Ensure nodes exist
      if (source && !this.graph.hasNode(source)) {
        this.graph.addNode(source, {
          type: 'address',
          hdAddress: source,
          firstSeen: tx.timestamp,
        });
      }
      if (target && !this.graph.hasNode(target)) {
        this.graph.addNode(target, {
          type: 'address',
          hdAddress: target,
          firstSeen: tx.timestamp,
        });
      }

      // Add edge (TX)
      if (source && target) {
        const edgeKey = `tx:${tx.txId}`;
        if (!this.graph.hasEdge(edgeKey)) {
          this.graph.addEdgeWithKey(edgeKey, source, target, {
            txId: tx.txId,
            eventType: (tx as any).eventType ?? 'unknown',
            contentHash: (tx as any).contentHash,
            state: 'CONFIRMED',
            timestamp: tx.timestamp,
            event: { ...tx },
          });

          // AX-78: High-QoS Event TX for federated sync
          middlewareNotify('cappz-cache', edgeKey, 'write', `${this.wallet.hdRoot}/graph/${edgeKey}`);
        }
      }
    }
  }
}

// ─── Domain-Scoped Cache Factory (AX-77) ──────────────────────

const _domainCaches = new Map<string, CappzCache>();

/**
 * Get or create a domain-scoped cache wallet.
 * Replaces the global singleton pattern (AP-23 remediation).
 */
export function getCappzCache(domain: string = 'global'): CappzCache {
  let cache = _domainCaches.get(domain);
  if (!cache) {
    cache = new CappzCache(domain);
    _domainCaches.set(domain, cache);
    // AX-77: Emit session creation
    cache.wallet.sessionCreated().catch(() => {});
  }
  return cache;
}

/**
 * List all active domain caches.
 */
export function listCacheDomains(): string[] {
  return Array.from(_domainCaches.keys());
}

// ─── Default Singleton (backward compat) ──────────────────────

export const cappzCache = getCappzCache('global');
