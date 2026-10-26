/**
 * ChainletSyncAdapter — Canonical data store backed by cappz-middleware.
 * 
 * Data is stored as append-only chainlet blocks with HD addressing per device.
 * cappz-middleware serves as an optional read-through hot cache only.
 * 
 * Architecture:
 *   Online:  Tx → chainlet block → blockchain anchor (immediate)
 *   Offline: Tx → chainlet block → outbox queue → blockchain anchor (deferred)
 *   Read:    check cappz-middleware cache → fallback to chainlet query
 *   Sync:    A2A block exchange between devices (append-only, no conflicts)
 * 
 * Connectivity Detection (layered):
 *   1. navigator.onLine — browser-native, instant detection
 *   2. XRPL heartbeat — blockchain-specific health polling
 */

// @ts-ignore - Vite alias resolves to the generated backend client, bypassing the cappzData proxy.
import { hostedClient } from './hostedBackend';
import { offlineCache } from '../offlineCache';
import { resolvePhysicalLocation } from './physicalStore';
import { 
  ChainletStoreParamType, 
  getChainletParam,
  isContentAmendedEquivalent,
  isContentCreatedEquivalent,
  getEquivalentEventTypes,
} from './chainletStoreParams';
import { chainletOutbox } from './chainletOutbox';
import CryptoJS from 'crypto-js';

// ─── Device Identity ──────────────────────────────────────────

const DEVICE_ID_KEY = 'cappz_device_id';

// Device ID cached in memory after first async load
let _cachedDeviceId: string | null = null;

async function getDeviceIdAsync(): Promise<string> {
  if (_cachedDeviceId) return _cachedDeviceId;
  const { chainletStorage } = await import('./chainletStorage');
  let id = await chainletStorage.getItem<string>(DEVICE_ID_KEY);
  if (!id) {
    id = `dev_${crypto.randomUUID()}`;
    await chainletStorage.setItem(DEVICE_ID_KEY, id);
  }
  _cachedDeviceId = id;
  return id;
}

function getDeviceId(): string {
  // Sync fallback — returns cached or generates temporary
  if (_cachedDeviceId) return _cachedDeviceId;
  _cachedDeviceId = `dev_${crypto.randomUUID()}`;
  // Persist async in background
  getDeviceIdAsync().catch(() => {});
  return _cachedDeviceId;
}

// ─── Types ────────────────────────────────────────────────────

export interface VersionPointer {
  address: string;
  hash: string;
}

export class OptimisticConcurrencyError extends Error {
  override name = 'OptimisticConcurrencyError';
  constructor(
    message: string,
    public readonly details: {
      store: string;
      key: string;
      expected: VersionPointer | null;
      actual: VersionPointer | null;
    }
  ) {
    super(message);
  }
}

export interface SyncBlock<T = unknown> {
  store: string;
  key: string;
  value: T;
  deviceId: string;
  timestamp: number;
  /** HD address for this version (deterministic) */
  hdAddress: string;
  blockHash: string;
  previousHash: string;
  previousHdAddress: string;
  /**
   * Durable partition scope. Device partitions use `sync_<deviceId>`;
   * TEMPLATE partitions use `tpl_<rootHash>` so the address — not the
   * writing device — is the identity and any device resolves the same block.
   */
  partitionKey?: string;
  /**
   * v14-12-12 — batch block: `value` is `{ entries: [{ key, value }] }` and the
   * block anchors every entry together (all or nothing). Readers unpack it
   * with blockEntries(); single-entry blocks are unchanged.
   */
  batch?: true;
  meta?: {
    /** When saved as a branch due to concurrency conflict */
    branchId?: string;
    expectedBase?: VersionPointer;
    actualHead?: VersionPointer;
  };
}

interface ChainletSyncOptions {
  /** Wallet address for scoping data */
  walletAddress?: string;
}

// ─── Hash Helpers ─────────────────────────────────────────────

function computeBlockHash(block: Omit<SyncBlock, 'blockHash'>): string {
  const payload = JSON.stringify({
    store: block.store,
    key: block.key,
    value: block.value,
    deviceId: block.deviceId,
    timestamp: block.timestamp,
    hdAddress: block.hdAddress,
    previousHash: block.previousHash,
    previousHdAddress: block.previousHdAddress,
    meta: block.meta ?? null,
  });
  return CryptoJS.SHA256(payload).toString();
}

function computeHdAddress(hdRoot: string, deviceId: string, timestamp: number): string {
  // Deterministic address so optimistic concurrency can reference "previousVersion.address"
  return `${hdRoot}/${deviceId}/${timestamp}`;
}

/**
 * Template addressing — NO device id anywhere in the address. The content
 * hash is the version, so re-publishing the same template from any machine
 * lands on the same address instead of forking a per-device copy.
 */
function computeTemplateHdAddress(templateRoot: string, key: string, value: unknown): string {
  const contentHash = CryptoJS.SHA256(JSON.stringify({ key, value })).toString();
  return `${templateRoot}/tpl/${contentHash.slice(0, 32)}`;
}

function templatePartitionKey(templateRoot: string): string {
  return `tpl_${CryptoJS.SHA256(templateRoot).toString().slice(0, 24)}`;
}

/** Every (store, key, value) a block carries — one for a plain block, many for a batch. */
export function blockEntries(block: SyncBlock): Array<{ store: string; key: string; value: unknown }> {
  if (block.batch) {
    const entries = (block.value as { entries?: Array<{ key: string; value: unknown }> } | null)?.entries ?? [];
    return entries.map((e) => ({ store: block.store, key: e.key, value: e.value }));
  }
  return [{ store: block.store, key: block.key, value: block.value }];
}

// ─── Sync Chainlet Manager ───────────────────────────────────

const SYNC_CHAINLET_PREFIX = 'sync';

class ChainletSyncManager {
  private deviceId = getDeviceId();
  private headHash: string = getChainletParam(ChainletStoreParamType.GenesisHash);
  private headAddress: string = '';
  private blockCount = 0;
  private walletAddress?: string;
  private initialized = false;

  /**
   * Initialize sync manager. Call once on app startup.
   */
  async init(opts: ChainletSyncOptions = {}): Promise<void> {
    if (this.initialized) return;
    this.walletAddress = opts.walletAddress;

    // Initialize outbox manager
    await chainletOutbox.init();

    // Restore head from last known state
    const cached = await offlineCache.get<{ headHash: string; headAddress?: string; blockCount: number }>(
      'kv', `sync_head_${this.deviceId}`
    );
    if (cached) {
      this.headHash = cached.headHash;
      this.headAddress = cached.headAddress ?? '';
      this.blockCount = cached.blockCount;
    }

    this.initialized = true;
    const queueLength = await chainletOutbox.getQueueLength();
    console.log(`[ChainletSync] Initialized device=${this.deviceId.slice(0, 12)}… blocks=${this.blockCount} queued=${queueLength}`);
  }

  /**
   * Write data — appends a new sync block, then updates cappz-middleware cache.
   * 
   * Online:  block anchored immediately to blockchain
   * Offline: block queued to outbox, anchored when connectivity restored
   * 
   * @returns blockHash (TxID) for use as correlationId in sync-on-async patterns
   */
  async set<T>(
    store: string,
    key: string,
    value: T,
    opts?: {
      /** The caller’s last-seen version pointer (optimistic concurrency) */
      previousVersion?: VersionPointer;
      /** Default: 'warn' (throw). Use 'branch' to force-save as a branch off previousVersion. */
      onConflict?: 'warn' | 'branch';
      branchId?: string;
      /**
       * Publish as an IMMUTABLE TEMPLATE at this canonical HD root. The block
       * is content-hash addressed under `<root>/tpl/<hash>` with no device id,
       * so every device resolves the same address. Templates are never part of
       * the device sync partition.
       */
      templateRoot?: string;
    }
  ): Promise<string> {
    await this.ensureInit();

    const hdRoot = getChainletParam(ChainletStoreParamType.HdAddressRoot);
    const useCloud = getChainletParam(ChainletStoreParamType.UseCloudPersistence);
    const isTemplate = Boolean(opts?.templateRoot);

    const expected: VersionPointer = opts?.previousVersion ?? {
      address: this.headAddress,
      hash: this.headHash,
    };

    let actualHead: VersionPointer | null = null;
    if (useCloud && !isTemplate) {
      actualHead = await this.getLatestRemotePointer(store, key);
    }

    let meta: SyncBlock<T>['meta'] | undefined;

    if (actualHead && actualHead.hash !== expected.hash) {
      if (opts?.onConflict === 'branch') {
        meta = {
          branchId: opts.branchId ?? `br_${Date.now().toString(36)}`,
          expectedBase: expected,
          actualHead,
        };
      } else {
        throw new OptimisticConcurrencyError(
          `Concurrent update detected for ${store}:${key}`,
          { store, key, expected, actual: actualHead }
        );
      }
    }

    const timestamp = Date.now();
    const hdAddress = isTemplate
      ? computeTemplateHdAddress(opts!.templateRoot!, key, value)
      : computeHdAddress(hdRoot, this.deviceId, timestamp);

    const partial: Omit<SyncBlock<T>, 'blockHash'> = {
      store,
      key,
      value,
      deviceId: isTemplate ? 'template' : this.deviceId,
      timestamp: isTemplate ? 0 : timestamp,
      hdAddress,
      previousHash: isTemplate ? '' : expected.hash,
      previousHdAddress: isTemplate ? '' : expected.address,
      partitionKey: isTemplate
        ? templatePartitionKey(opts!.templateRoot!)
        : `${SYNC_CHAINLET_PREFIX}_${this.deviceId}`,
      meta,
    };

    const blockHash = computeBlockHash(partial);
    const block: SyncBlock<T> = { ...partial, blockHash };

    // 1. Persist to chainlet (immediate or queued based on connectivity)
    await this.persistBlock(block);

    // 2. Update device-local head — template publishes never touch the
    //    device chain; their address is their identity.
    if (!isTemplate) {
      this.headHash = blockHash;
      this.headAddress = hdAddress;
      this.blockCount++;
      await offlineCache.set('kv', `sync_head_${this.deviceId}`, {
        headHash: this.headHash,
        headAddress: this.headAddress,
        blockCount: this.blockCount,
      });
    }

    // 3. Update cappz-middleware hot cache
    const hot = resolvePhysicalLocation(store, key);
    await offlineCache.set(hot.store, hot.key, value, {
      walletAddress: this.walletAddress,
    });

    if (!isTemplate) {
      // 4. Persist latest pointer for optimistic concurrency callers
      await offlineCache.set('kv', `sync_ptr_${store}:${key}`, {
        address: hdAddress,
        hash: blockHash,
      } satisfies VersionPointer);

      // 5. Lazy refresh (FetchContent(address)) to hydrate cache from canonical chainlet storage.
      this.fetchContent(hdAddress).catch(() => {});
    }

    return blockHash;
  }

  /**
   * v14-12-12 — prepare ONE chainlet block for a whole batch. Returns the kv
   * rows (the block and the advanced device head) for the caller to commit in
   * the same local transaction as the batch itself, and `commit()` to run
   * after that transaction succeeds: it advances the in-memory head and
   * anchors the block (queued whole to the outbox when the cloud is
   * unavailable). A batch is therefore on chain entirely or not at all.
   */
  async prepareBatch<T>(store: string, entries: Array<{ key: string; value: T }>): Promise<{
    block: SyncBlock<{ entries: Array<{ key: string; value: T }> }>;
    kvRows: Array<[key: string, value: unknown]>;
    commit: () => Promise<void>;
  }> {
    await this.ensureInit();
    const hdRoot = getChainletParam(ChainletStoreParamType.HdAddressRoot);
    const timestamp = Date.now();
    const hdAddress = computeHdAddress(hdRoot, this.deviceId, timestamp);
    const partial: Omit<SyncBlock<{ entries: Array<{ key: string; value: T }> }>, 'blockHash'> = {
      store,
      key: `batch:${timestamp}:${entries.length}`,
      value: { entries },
      deviceId: this.deviceId,
      timestamp,
      hdAddress,
      previousHash: this.headHash,
      previousHdAddress: this.headAddress,
      partitionKey: `${SYNC_CHAINLET_PREFIX}_${this.deviceId}`,
      batch: true,
    };
    const blockHash = computeBlockHash(partial);
    const block = { ...partial, blockHash };
    const nextCount = this.blockCount + 1;
    const kvRows: Array<[string, unknown]> = [
      [`syncblock_${blockHash}`, block],
      [`sync_head_${this.deviceId}`, { headHash: blockHash, headAddress: hdAddress, blockCount: nextCount }],
    ];
    const commit = async () => {
      this.headHash = blockHash;
      this.headAddress = hdAddress;
      this.blockCount = nextCount;
      await this.anchorRemote(block);
    };
    return { block, kvRows, commit };
  }

  /** Get the latest locally-known version pointer for a key (for optimistic concurrency). */
  async getVersionPointer(store: string, key: string): Promise<VersionPointer | null> {
    return offlineCache.get<VersionPointer>('kv', `sync_ptr_${store}:${key}`);
  }

  /**
   * Check if blockchain connectivity is available.
   */
  isOnline(): boolean {
    return chainletOutbox.isOnline();
  }

  /**
   * Get current connectivity state.
   */
  getConnectivityState() {
    return chainletOutbox.getConnectivityState();
  }

  /**
   * Register connectivity change listener.
   */
  onConnectivityChange(listener: (state: ReturnType<typeof chainletOutbox.getConnectivityState>) => void) {
    return chainletOutbox.onConnectivityChange(listener);
  }

  /**
   * Get number of blocks pending in outbox.
   */
  async getOutboxLength(): Promise<number> {
    return chainletOutbox.getQueueLength();
  }

  /**
   * Force drain outbox (manual sync trigger).
   */
  async flushOutbox(): Promise<number> {
    return chainletOutbox.drainOutbox();
  }

  /**
   * Read data — check cappz-middleware cache first, then chainlet blocks.
   */
  async get<T>(store: string, key: string): Promise<T | null> {
    await this.ensureInit();

    // Hot cache first
    const hot = resolvePhysicalLocation(store, key);
    const cached = await offlineCache.get<T>(hot.store, hot.key);
    if (cached !== null) return cached;

    // Fallback: query chainlet blocks for latest value
    const useCloud = getChainletParam(ChainletStoreParamType.UseCloudPersistence);
    if (useCloud) {
      return this.queryCloudBlock<T>(store, key);
    }

    // In pure client mode, cappz-middleware IS the only local store
    // A2A sync will populate it from peers
    return null;
  }

  /**
   * Delete data — append a tombstone block with null value.
   */
  async delete(store: string, key: string): Promise<void> {
    await this.set(store, key, null);
    const hot = resolvePhysicalLocation(store, key);
    await offlineCache.delete(hot.store, hot.key);
  }

  /**
   * Get all blocks for a device since a given hash (for A2A sync).
   */
  async getBlocksSince(sinceHash: string): Promise<SyncBlock[]> {
    const useCloud = getChainletParam(ChainletStoreParamType.UseCloudPersistence);
    if (!useCloud) return [];

    const { data, error } = await hostedClient('direct')
      .from('chainlet_blocks')
      .select('metadata, block_hash, previous_hash, timestamp, block_number')
      .eq('query_hash', `${SYNC_CHAINLET_PREFIX}_${this.deviceId}`)
      .order('block_number', { ascending: true });

    if (error || !data) return [];

    const blocks: SyncBlock[] = [];
    let foundStart = sinceHash === '0'.repeat(64);

    for (const row of data) {
      if (!foundStart) {
        if (row.previous_hash === sinceHash || row.block_hash === sinceHash) {
          foundStart = true;
        }
        continue;
      }
      const meta = row.metadata as any;
      if (meta?.syncBlock) {
        blocks.push(meta.syncBlock as SyncBlock);
      }
    }

    return blocks;
  }

  /**
   * Apply blocks from a remote device (A2A inbound sync).
   * Append-only: just update cache with latest values per key.
   */
  async applyRemoteBlocks(blocks: SyncBlock[]): Promise<number> {
    let applied = 0;
    // Sort by timestamp — latest wins for same key
    const sorted = [...blocks].sort((a, b) => a.timestamp - b.timestamp);

    for (const block of sorted) {
      for (const entry of blockEntries(block)) {
        const hot = resolvePhysicalLocation(entry.store, entry.key);
        if (entry.value === null) {
          await offlineCache.delete(hot.store, hot.key);
        } else {
          await offlineCache.set(hot.store, hot.key, entry.value, {
            walletAddress: this.walletAddress,
          });
        }
      }
      applied++;
    }

    console.log(`[ChainletSync] Applied ${applied} remote blocks`);
    return applied;
  }

  // ─── Internal ───────────────────────────────────────────

  private async ensureInit(): Promise<void> {
    if (!this.initialized) {
      await this.init({ walletAddress: this.walletAddress });
    }
  }

  private async persistBlock(block: SyncBlock): Promise<void> {
    // Always persist block reference locally for offline capability
    await offlineCache.set('kv', `syncblock_${block.blockHash}`, block);
    await this.anchorRemote(block);
  }

  /** Anchor a locally persisted block in the cloud chainlet, or queue it whole. */
  private async anchorRemote(block: SyncBlock): Promise<void> {
    const useCloud = getChainletParam(ChainletStoreParamType.UseCloudPersistence);
    const autoSync = getChainletParam(ChainletStoreParamType.AutoSyncWithBlockchain);
    if (!useCloud) return;

    // If offline or auto-sync disabled, queue to outbox
    if (!chainletOutbox.isOnline() || !autoSync) {
      await chainletOutbox.enqueue(block);
      return;
    }

    // Online + auto-sync: anchor immediately
    const merkleRoot = CryptoJS.SHA256(JSON.stringify(block.value)).toString();

    const { error } = await hostedClient('direct').from('chainlet_blocks').insert([{
      block_number: this.blockCount,
      block_hash: block.blockHash,
      previous_hash: block.previousHash,
      merkle_root: merkleRoot,
      timestamp: new Date(block.timestamp).toISOString(),
      transaction_count: blockEntries(block).length,
      transactions: block.batch
        ? { type: 'sync_batch', store: block.store, keys: blockEntries(block).map((e) => e.key) }
        : { type: 'sync_write', store: block.store, key: block.key },
      anchor_block: { deviceId: block.deviceId, synced: true },
      query_hash: block.partitionKey ?? `${SYNC_CHAINLET_PREFIX}_${this.deviceId}`,
      metadata: { syncBlock: JSON.parse(JSON.stringify(block)) },
      hd_address: block.hdAddress,
      hd_block_index: this.blockCount,
    }]);

    if (error) {
      console.warn('[ChainletSync] Cloud persist failed, queuing to outbox:', error.message);
      await chainletOutbox.enqueue(block);
    }
  }

  /**
   * Check for newer version by looking for ContentAmended events to prevVersionAddress.
   * If no amendment found, compare prevVersionHash with ContentHash from ContentCreated.
   * Uses MDM-derived event type equivalents (e.g., TradeCreated → ContentCreated).
   */
  private async getLatestRemotePointer(store: string, key: string): Promise<VersionPointer | null> {
    // Get the current local pointer to use as prevVersionAddress
    const localPointer = await offlineCache.get<VersionPointer>('kv', `sync_ptr_${store}:${key}`);
    
    if (localPointer?.address) {
      // Step 1: Check for ContentAmended (or equivalent) events sent to prevVersionAddress
      const amendmentCheck = await this.checkForAmendmentEvent(localPointer.address);
      if (amendmentCheck) {
        return amendmentCheck;
      }
      
      // Step 2: No amendment found — verify hash against ContentCreated event
      const creationCheck = await this.verifyCreationEventHash(localPointer);
      if (creationCheck && creationCheck.hash !== localPointer.hash) {
        // Hash mismatch indicates concurrent modification
        return creationCheck;
      }
    }
    
    // Fallback: scan recent blocks for store/key match
    return this.scanRecentBlocksForPointer(store, key);
  }

  /**
   * Check if a ContentAmended (or derived equivalent) event was sent to the given address.
   * Returns the new version pointer if found, null otherwise.
   */
  private async checkForAmendmentEvent(prevVersionAddress: string): Promise<VersionPointer | null> {
    // Get all event types equivalent to ContentAmended
    const amendedTypes = getEquivalentEventTypes('ContentAmended');
    
    // Query lifecycle_events for amendments targeting this address
    const { data: events, error } = await hostedClient('direct')
      .from('lifecycle_events')
      .select('entity_id, event_type, event_data, created_at')
      .in('event_type', amendedTypes)
      .order('created_at', { ascending: false })
      .limit(100);
    
    if (error || !events) return null;
    
    // Find events where the parent/target address matches prevVersionAddress
    for (const event of events) {
      const eventData = event.event_data as Record<string, unknown> | null;
      const parentAddress = eventData?.parent_hd_address ?? eventData?.target_address ?? eventData?.prevVersionAddress;
      
      if (parentAddress === prevVersionAddress) {
        // Found an amendment — get the new version pointer
        const newVersionAddress = eventData?.hd_address ?? eventData?.new_version_address;
        const newVersionHash = eventData?.content_hash ?? eventData?.version_hash ?? eventData?.blockHash;
        
        if (newVersionAddress && newVersionHash) {
          return {
            address: String(newVersionAddress),
            hash: String(newVersionHash),
          };
        }
        
        // Try to resolve from chainlet_blocks if event_data incomplete
        const { data: block } = await hostedClient('direct')
          .from('chainlet_blocks')
          .select('block_hash, hd_address')
          .eq('metadata->>entityId', event.entity_id)
          .maybeSingle();
        
        if (block?.hd_address) {
          return {
            address: block.hd_address,
            hash: block.block_hash,
          };
        }
      }
    }
    
    return null;
  }

  /**
   * Verify the prevVersionHash matches the ContentHash from the ContentCreated event.
   * Uses MDM-derived event type equivalents (TradeCreated, OrderCreated, etc.).
   */
  private async verifyCreationEventHash(localPointer: VersionPointer): Promise<VersionPointer | null> {
    // Get all event types equivalent to ContentCreated
    const createdTypes = getEquivalentEventTypes('ContentCreated');
    
    // Query lifecycle_events for creation events at this address
    const { data: events, error } = await hostedClient('direct')
      .from('lifecycle_events')
      .select('entity_id, event_type, event_data, created_at')
      .in('event_type', createdTypes)
      .order('created_at', { ascending: false })
      .limit(100);
    
    if (error || !events) return null;
    
    // Find the creation event matching the address
    for (const event of events) {
      const eventData = event.event_data as Record<string, unknown> | null;
      const eventAddress = eventData?.hd_address ?? eventData?.hdAddress ?? eventData?.address;
      
      if (eventAddress === localPointer.address) {
        // Found the creation event — extract ContentHash
        const contentHash = eventData?.content_hash ?? eventData?.version_hash ?? eventData?.blockHash;
        
        if (contentHash) {
          return {
            address: localPointer.address,
            hash: String(contentHash),
          };
        }
      }
    }
    
    // Fallback: check chainlet_blocks directly
    const { data: block } = await hostedClient('direct')
      .from('chainlet_blocks')
      .select('block_hash, merkle_root')
      .eq('hd_address', localPointer.address)
      .maybeSingle();
    
    if (block) {
      return {
        address: localPointer.address,
        hash: block.block_hash,
      };
    }
    
    return null;
  }

  /**
   * Fallback: scan recent blocks for store/key match (original behavior).
   */
  private async scanRecentBlocksForPointer(store: string, key: string): Promise<VersionPointer | null> {
    const { data, error } = await hostedClient('direct')
      .from('chainlet_blocks')
      .select('block_hash, hd_address, timestamp, metadata')
      .like('query_hash', `${SYNC_CHAINLET_PREFIX}_%`)
      .order('timestamp', { ascending: false })
      .limit(500);

    if (error || !data) return null;

    for (const row of data) {
      const meta = row.metadata as any;
      const candidate = meta?.syncBlock as SyncBlock | undefined;
      if (candidate?.store === store && blockEntries(candidate).some((e) => e.key === key)) {
        return {
          address: (row.hd_address as string | null) ?? meta.syncBlock.hdAddress ?? '',
          hash: meta.syncBlock.blockHash ?? (row.block_hash as string),
        };
      }
    }

    return null;
  }

  private async fetchContent(hdAddress: string): Promise<void> {
    const useCloud = getChainletParam(ChainletStoreParamType.UseCloudPersistence);
    if (!useCloud) return;

    const { data, error } = await hostedClient('direct')
      .from('chainlet_blocks')
      .select('metadata')
      .eq('hd_address', hdAddress)
      .maybeSingle();

    if (error || !data) return;

    const meta = (data.metadata as any) ?? {};
    const block = meta.syncBlock as SyncBlock | undefined;
    if (!block?.store || !block?.key) return;

    for (const entry of blockEntries(block)) {
      const hot = resolvePhysicalLocation(entry.store, entry.key);
      if (entry.value === null) {
        await offlineCache.delete(hot.store, hot.key);
      } else {
        await offlineCache.set(hot.store, hot.key, entry.value, {
          walletAddress: this.walletAddress,
        });
      }
      await offlineCache.set('kv', `sync_ptr_${entry.store}:${entry.key}`, {
        address: block.hdAddress ?? hdAddress,
        hash: block.blockHash,
      } satisfies VersionPointer);
    }
  }

  private async queryCloudBlock<T>(store: string, key: string): Promise<T | null> {
    // Find latest block for this store/key across all devices
    const { data, error } = await hostedClient('direct')
      .from('chainlet_blocks')
      .select('metadata, block_hash, hd_address, timestamp')
      .like('query_hash', `${SYNC_CHAINLET_PREFIX}_%`)
      .order('timestamp', { ascending: false })
      .limit(500);

    if (error || !data) return null;

    // Find most recent block matching store+key
    for (const row of data) {
      const meta = row.metadata as any;
      const candidate = meta?.syncBlock as SyncBlock | undefined;
      const hit = candidate && candidate.store === store ? blockEntries(candidate).find((e) => e.key === key) : undefined;
      if (candidate && hit) {
        const syncBlock = candidate;
        const value = hit.value;

        // Re-cache locally
        if (value !== null) {
          const hot = resolvePhysicalLocation(store, key);
          await offlineCache.set(hot.store, hot.key, value, {
            walletAddress: this.walletAddress,
          });
        }

        // Update pointer cache for optimistic concurrency
        await offlineCache.set('kv', `sync_ptr_${store}:${key}`, {
          address: syncBlock.hdAddress ?? (row as any).hd_address ?? '',
          hash: syncBlock.blockHash ?? (row as any).block_hash,
        } satisfies VersionPointer);

        return value as T;
      }
    }

    return null;
  }
}

// ─── Singleton Export ─────────────────────────────────────────

export const chainletSync = new ChainletSyncManager();
