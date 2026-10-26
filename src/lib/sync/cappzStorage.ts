/**
 * cappzStorage — Unified storage facade for the cappz platform.
 *
 * Exposes:
 *   - submit(): BPMN-gated write through cappzMiddleware with pipeline selector
 *   - EventCache: TX event graph (cappz-chainlet-storage)
 *   - ContentCache: Content at TX endpoints (cappz-content-storage)
 *   - EphemeralStorage: Volatile session data with purge directives
 *
 * Write contract:
 *   cappzStorage.submit({
 *     parentHdAddress, content,
 *     pipeline: 'cappzStorageBPMN' | 'ingestContentPipeline' | 'custom',
 *     mode: 'create' | 'amend' | 'replace' | 'fork',
 *     sourceHashPrint?: { txId, contentHash },  // REQUIRED for amend/replace/fork
 *     onDurableConfirm?: (receipt) => void,
 *   })
 *
 * All writes are immutable appends. Mutations require sourceHashPrint
 * for optimistic concurrency.
 *
 * AX-63: Single Storage Stack.
 * HD: m/44'/144'/0'/cappz/storage
 */

import { cappzContentCache, StaleContentError, type ContentHashPrint, type ContentCacheEntry } from './CappzContentCache';
import { CappzEventCache, type CappzEventCacheEntry } from './CappzEventCache';
import { cappzCache, type CacheFilter, type CacheSnapshot, type CacheDelta } from './cappzCache';
import { cappzEphemeralStorage } from './cappzEphemeralStorage';
import { cappzStorageBPMN, type CappzStoragePipeline } from './CappzStorageBPMN';
import { hostedClient } from './hostedBackend';

// ─── Read-Path Types (Phase 3) ────────────────────────────────

/**
 * ChainletBlockRow — Raw chainlet_blocks row shape exposed by the read facade.
 * Mirrors the durable storage schema. Callers are expected to map this to
 * their domain types. The facade is the single read seam: components and
 * services MUST NOT call supabase.from('chainlet_blocks') directly.
 */
export interface ChainletBlockRow {
  id: string;
  chainlet_id: string;
  block_number: number;
  block_hash: string;
  previous_hash: string | null;
  merkle_root: string;
  timestamp: string;
  anchor_block: unknown;
  query_hash: string | null;
  transactions: unknown;
  transaction_count: number;
  hd_address: string | null;
  hd_block_index: number | null;
  metadata: unknown;
  escrow_deal_id: string | null;
  reblock_source: string | null;
  source_chainlet_id: string | null;
  dependency_chain: unknown;
}

export interface FetchBlocksFilter {
  /** Block row primary key (UUID). */
  id?: string;
  chainletId?: string;
  hdAddress?: string;
  hdAddressPrefix?: string;
  escrowDealId?: string;
  blockNumberGte?: number;
  blockNumberLte?: number;
  timestampGte?: string;
  timestampLte?: string;
  /** Column subset; defaults to '*'. Pass an array for narrow projections. */
  select?: string;
  orderBy?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
  /** When true, returns total count alongside rows (range mode). */
  withCount?: boolean;
}

export interface FetchBlocksResult<T = ChainletBlockRow> {
  blocks: T[];
  totalCount: number | null;
}

// ─── Types ────────────────────────────────────────────────────

export type SubmitMode = 'create' | 'amend' | 'replace' | 'fork';

export interface SkillBinding {
  txId: string;
  timestamp: string;
  sourceAddress: string;
  targetAddress: string;
  canonHdPath: string;
  canonName: string;
  skillNumber: number;
  payload: Record<string, unknown>;
}

export interface SubmitParams<T = unknown> {
  parentHdAddress: string;
  content: T;
  pipeline: CappzStoragePipeline | string;
  mode: SubmitMode;
  sourceHashPrint?: ContentHashPrint;
  forkFrom?: string;
  onDurableConfirm?: (receipt: SubmitReceipt) => void;
  metadata?: Record<string, unknown>;
}

export interface SubmitReceipt {
  childHdAddress: string;
  txId: string;
  contentHash: string;
  correlationId: string;
  timestamp: string;
  mode: SubmitMode;
}

// ─── SHA-256 Helper ───────────────────────────────────────────

async function sha256(content: unknown): Promise<string> {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  const buffer = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── Unified Facade ───────────────────────────────────────────

export const cappzStorage = {
  // ─── References to sub-systems ────────────────────────────

  EventCache: CappzEventCache,
  ContentCache: cappzContentCache,
  EphemeralStorage: cappzEphemeralStorage,
  Cache: cappzCache,

  // ─── FetchSkillBindings (Generic) ──────────────────────────

  /**
   * FetchSkillBindings — Generic event-sourced query for skill bindings.
   * Maps status filter strings to paired event types and queries AgentSkillCache.
   * Results are merged (union) across all requested statuses.
   *
   * AX-73: EventCache IS the registry. No static arrays.
   */
  async FetchSkillBindings(
    hdAddress: string,
    statusFilter: ('Included' | 'Removed' | 'Created' | 'Deprecated' | 'Activated' | 'Deactivated')[],
  ): Promise<SkillBinding[]> {
    const STATUS_EVENT_MAP: Record<string, [string, string]> = {
      Included:    ['SkillConstituentIncluded', 'SkillConstituentRemoved'],
      Removed:     ['SkillConstituentRemoved', 'SkillConstituentIncluded'],
      Created:     ['SkillBindingCreated', 'SkillBindingDeprecated'],
      Deprecated:  ['SkillBindingDeprecated', 'SkillBindingCreated'],
      Activated:   ['SkillBindingActivated', 'SkillBindingDeactivated'],
      Deactivated: ['SkillBindingDeactivated', 'SkillBindingActivated'],
    };

    const { agentSkillCache } = await import('../skills/AgentSkillCache');

    if (!agentSkillCache.isHydrated) {
      await agentSkillCache.refresh();
    }

    const addressFilter = (e: { sourceAddress?: string; targetAddress?: string }) => {
      const source = e.sourceAddress ?? '';
      const target = e.targetAddress ?? '';
      return source.startsWith(hdAddress) || target.startsWith(hdAddress);
    };

    const seen = new Set<string>();
    const results: SkillBinding[] = [];

    for (const status of statusFilter) {
      const pair = STATUS_EVENT_MAP[status];
      if (!pair) continue;

      const [addedType, removedType] = pair;
      const active = agentSkillCache.isActive(addedType, removedType, addressFilter);

      for (const binding of active) {
        if (seen.has(binding.txId)) continue;
        seen.add(binding.txId);

        results.push({
          txId: binding.txId,
          timestamp: binding.timestamp,
          sourceAddress: binding.sourceAddress,
          targetAddress: binding.targetAddress ?? '',
          canonHdPath: (binding.payload?.canonHdPath as string) ?? binding.targetAddress ?? '',
          canonName: (binding.payload?.canonName as string) ?? (binding.payload?.label as string) ?? 'Unknown',
          skillNumber: (binding.payload?.skillNumber as number) ?? 0,
          payload: binding.payload,
        });
      }
    }

    return results;
  },


  // ─── FetchBlocks (Read-Path Facade — Phase 3) ─────────────

  /**
   * FetchBlocks — Single read seam for chainlet_blocks.
   *
   * Components and services MUST route through this method instead of
   * touching supabase.from('chainlet_blocks') directly. This keeps the
   * read path swappable (chain-resident hydration, A2A peer fetch,
   * event-cache projection) without changing every call site.
   *
   * AX-74 / AX-82: read facade is the public contract; storage internals
   * remain free to evolve.
   */
  async FetchBlocks<T = ChainletBlockRow>(
    filter: FetchBlocksFilter = {},
  ): Promise<FetchBlocksResult<T>> {
    const select = filter.select ?? '*';
    const ascending = (filter.orderBy ?? 'desc') === 'asc';

    let query = filter.withCount
      ? hostedClient().from('chainlet_blocks').select(select, { count: 'exact' })
      : hostedClient().from('chainlet_blocks').select(select);

    if (filter.id) query = query.eq('id', filter.id);
    if (filter.chainletId) query = query.eq('chainlet_id', filter.chainletId);
    if (filter.hdAddress) query = query.eq('hd_address', filter.hdAddress);
    if (filter.hdAddressPrefix) query = query.like('hd_address', `${filter.hdAddressPrefix}%`);
    if (filter.escrowDealId) query = query.eq('escrow_deal_id', filter.escrowDealId);
    if (filter.blockNumberGte !== undefined) query = query.gte('block_number', filter.blockNumberGte);
    if (filter.blockNumberLte !== undefined) query = query.lte('block_number', filter.blockNumberLte);
    if (filter.timestampGte) query = query.gte('timestamp', filter.timestampGte);
    if (filter.timestampLte) query = query.lte('timestamp', filter.timestampLte);

    query = query.order('block_number', { ascending });

    if (filter.limit !== undefined && filter.offset !== undefined) {
      query = query.range(filter.offset, filter.offset + filter.limit - 1);
    } else if (filter.limit !== undefined) {
      query = query.limit(filter.limit);
    }

    const { data, error, count } = await query;
    if (error) throw error;

    return {
      blocks: (data ?? []) as unknown as T[],
      totalCount: count ?? null,
    };
  },

  /**
   * FetchBlockByAddress — Convenience for single-address lookup.
   * Returns null when no row exists (does NOT throw on not-found).
   */
  async FetchBlockByAddress<T = ChainletBlockRow>(
    chainletId: string,
    hdAddress: string,
  ): Promise<T | null> {
    const { blocks } = await cappzStorage.FetchBlocks<T>({
      chainletId,
      hdAddress,
      limit: 1,
    });
    return blocks[0] ?? null;
  },

  /**
   * FetchLatestBlock — Convenience for single-row "tip" lookup.
   * Returns the most recent block by block_number for a chainlet.
   */
  async FetchLatestBlock<T = ChainletBlockRow>(
    chainletId: string,
  ): Promise<T | null> {
    const { blocks } = await cappzStorage.FetchBlocks<T>({
      chainletId,
      orderBy: 'desc',
      limit: 1,
    });
    return blocks[0] ?? null;
  },


  // ─── Submit (Write-Through) ───────────────────────────────

  /**
   * Submit content through cappzMiddleware pipeline.
   * Routes to the specified BPMN or pipeline process.
   *
   * For amend/replace/fork: sourceHashPrint is REQUIRED.
   * Optimistic concurrency check is performed before persistence.
   */
  async submit<T = unknown>(params: SubmitParams<T>): Promise<SubmitReceipt> {
    const {
      parentHdAddress, content, pipeline, mode,
      sourceHashPrint, forkFrom, onDurableConfirm, metadata,
    } = params;

    // 1. Concurrency check for mutations
    if ((mode === 'amend' || mode === 'replace') && !sourceHashPrint) {
      throw new Error(`sourceHashPrint is required for ${mode} operations`);
    }
    if (sourceHashPrint) {
      const targetAddr = mode === 'fork' ? (forkFrom ?? parentHdAddress) : parentHdAddress;
      cappzContentCache.checkConcurrency(targetAddr, sourceHashPrint);
    }

    // 2. Generate child HD address and TX metadata
    const childHdAddress = mode === 'fork'
      ? `${parentHdAddress}/fork/${crypto.randomUUID().slice(0, 8)}`
      : `${parentHdAddress}/${crypto.randomUUID().slice(0, 8)}`;
    const txId = crypto.randomUUID();
    const contentHash = await sha256(content);
    const correlationId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    // 3. Write-through: insert into content cache as PENDING
    const { confirm, fail } = cappzContentCache.insertPending(
      childHdAddress, content, contentHash, txId,
    );

    // 4. Route to pipeline via BPMN
    try {
      await cappzStorageBPMN.execute(pipeline, {
        parentHdAddress,
        childHdAddress,
        content,
        contentHash,
        txId,
        correlationId,
        mode,
        sourceHashPrint,
        forkFrom,
        metadata,
        timestamp,
      });

      // 5. On success: confirm cache entry
      confirm();

      const receipt: SubmitReceipt = {
        childHdAddress, txId, contentHash, correlationId, timestamp, mode,
      };

      onDurableConfirm?.(receipt);
      return receipt;

    } catch (err) {
      // On failure: mark cache entry as FAILED
      fail(err instanceof Error ? err.message : 'Unknown error');
      throw err;
    }
  },

  // ─── Cache Orchestration ──────────────────────────────────

  async InitializeCache(
    filter: CacheFilter,
    eventCache: CappzEventCache<CappzEventCacheEntry>,
  ): Promise<CacheSnapshot> {
    return cappzCache.InitializeCache(filter, eventCache);
  },

  async RefreshCacheDelta(
    hdAddresses: string[],
    eventCache: CappzEventCache<CappzEventCacheEntry>,
  ): Promise<CacheDelta> {
    return cappzCache.RefreshCacheDelta(hdAddresses, eventCache);
  },

  async EnsureCache(
    filter: CacheFilter,
    eventCache: CappzEventCache<CappzEventCacheEntry>,
  ): Promise<CacheSnapshot | CacheDelta> {
    return cappzCache.EnsureCache(filter, eventCache);
  },
};

// ─── Re-exports ───────────────────────────────────────────────

export { StaleContentError } from './CappzContentCache';
export type { ContentHashPrint, ContentCacheEntry } from './CappzContentCache';
export type { CacheFilter, CacheSnapshot, CacheDelta } from './cappzCache';
