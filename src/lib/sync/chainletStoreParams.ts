/**
 * ChainletStoreParamType — MDM address mapping for chainlet store configuration.
 * 
 * All chainlet storage parameters resolve via MDM addresses rather than hardcoded constants.
 * This enables runtime configuration and audit-trail tracking of parameter changes.
 * 
 * MDM Root: m/44'/144'/0'/cappz/config/chainlet-store
 */

// ─── MDM Address Root ─────────────────────────────────────────
// Centralized in src/lib/wallets/paths.ts (AP-17).

import {
  CHAINLET_STORE_CONFIG_ROOT,
  EVENT_TYPE_MDM_ROOT as _EVENT_TYPE_MDM_ROOT,
  WALLET_ROOTS,
  MIGRATION_STATUS_MDM,
  bip44Address,
} from '../wallets/paths';

const MDM_ROOT = CHAINLET_STORE_CONFIG_ROOT;

// ─── Parameter Type Definition ────────────────────────────────

export interface ChainletStoreParam<T> {
  /** MDM address for this parameter */
  address: string;
  /** Human-readable parameter name */
  name: string;
  /** Default value (used when MDM lookup fails) */
  defaultValue: T;
  /** Parameter description */
  description: string;
}

// ─── ChainletStoreParamType Mapping ───────────────────────────

export const ChainletStoreParamType = {
  /**
   * Auto-sync blocks to blockchain when online.
   * When true, blocks anchor immediately; when false, queue to outbox.
   */
  AutoSyncWithBlockchain: {
    address: `${MDM_ROOT}/auto-sync-blockchain`,
    name: 'AutoSyncWithBlockchain',
    defaultValue: true,
    description: 'Enable automatic blockchain anchoring when online',
  } as ChainletStoreParam<boolean>,

  /**
   * HD address root path for chainlet blocks.
   */
  HdAddressRoot: {
    address: `${MDM_ROOT}/hd-address-root`,
    name: 'HdAddressRoot',
    defaultValue: `${WALLET_ROOTS.HEAVEN}/0/sync`,
    description: 'HD derivation root path for sync blocks',
  } as ChainletStoreParam<string>,

  /**
   * Interval (ms) for flushing outbox queue when online.
   */
  OutboxFlushInterval: {
    address: `${MDM_ROOT}/outbox-flush-interval`,
    name: 'OutboxFlushInterval',
    defaultValue: 5000,
    description: 'Milliseconds between outbox flush attempts',
  } as ChainletStoreParam<number>,

  /**
   * A2A sync cycle interval (ms) for peer block exchange.
   */
  A2ASyncCycleMs: {
    address: `${MDM_ROOT}/a2a-sync-cycle`,
    name: 'A2ASyncCycleMs',
    defaultValue: 30000,
    description: 'Milliseconds between A2A peer sync cycles',
  } as ChainletStoreParam<number>,

  /**
   * Genesis hash for new chainlet chains.
   */
  GenesisHash: {
    address: `${MDM_ROOT}/genesis-hash`,
    name: 'GenesisHash',
    defaultValue: '0'.repeat(64),
    description: 'Initial previous_hash for genesis blocks',
  } as ChainletStoreParam<string>,

  /**
   * Maximum blocks to retain in local cache.
   */
  MaxLocalBlocks: {
    address: `${MDM_ROOT}/max-local-blocks`,
    name: 'MaxLocalBlocks',
    defaultValue: 10000,
    description: 'Maximum blocks retained in local chainlet cache',
  } as ChainletStoreParam<number>,

  /**
   * Block TTL (seconds) before local cache purge.
   */
  BlockTtlSeconds: {
    address: `${MDM_ROOT}/block-ttl`,
    name: 'BlockTtlSeconds',
    defaultValue: 604800, // 7 days
    description: 'Time-to-live for cached blocks (seconds)',
  } as ChainletStoreParam<number>,

  /**
   * Anchor strategy for outbox drain.
   * 'off' = do not anchor to XRPL (local cappz-store only — default).
   * 'individual' = one Tx per block.
   * 'batch' = Merkle root batching.
   * v11-2-014: Default 'off' — local-first cappz-store; XRPL anchor is opt-in.
   */
  AnchorStrategy: {
    address: `${MDM_ROOT}/anchor-strategy`,
    name: 'AnchorStrategy',
    defaultValue: 'off' as 'off' | 'individual' | 'batch',
    description: 'Strategy for anchoring queued blocks: off (local-only), individual, or batch',
  } as ChainletStoreParam<'off' | 'individual' | 'batch'>,

  /**
   * Maximum blocks per batch anchor (when AnchorStrategy = 'batch').
   */
  MaxBatchSize: {
    address: `${MDM_ROOT}/max-batch-size`,
    name: 'MaxBatchSize',
    defaultValue: 32,
    description: 'Maximum blocks per batch anchor transaction (XRPL memo cap)',
  } as ChainletStoreParam<number>,

  /**
   * XRPL heartbeat interval (ms) for connectivity detection.
   */
  HeartbeatIntervalMs: {
    address: `${MDM_ROOT}/heartbeat-interval`,
    name: 'HeartbeatIntervalMs',
    defaultValue: 15000,
    description: 'Milliseconds between XRPL connectivity heartbeats',
  } as ChainletStoreParam<number>,

  /**
   * Heartbeat timeout (ms) before marking offline.
   */
  HeartbeatTimeoutMs: {
    address: `${MDM_ROOT}/heartbeat-timeout`,
    name: 'HeartbeatTimeoutMs',
    defaultValue: 5000,
    description: 'Milliseconds before heartbeat considered failed',
  } as ChainletStoreParam<number>,

  /**
   * Opt into server-side escrowed cappz-store copy execution + a2a fan-out.
   * v11-2-014: Default false — local-first execution. When true, edge subscribes
   * to a2a-pushed SyncBlocks from the escrowed cappz-store wallet, and pushes
   * local proposals up. Never anchors XRPL from the edge (server does it).
   */
  UseCloudPersistence: {
    address: `${MDM_ROOT}/use-cloud`,
    name: 'UseCloudPersistence',
    defaultValue: false,
    description: 'Opt into server-escrow copy execution + a2a fan-out',
  } as ChainletStoreParam<boolean>,

  /**
   * Escrowed cappz-store wallet address — canonical server-side source for
   * a2a-pushed SyncBlocks when UseCloudPersistence=true.
   */
  EscrowedCappzStoreWalletAddress: {
    address: `${MDM_ROOT}/escrowed-cappz-store-wallet`,
    name: 'EscrowedCappzStoreWalletAddress',
    defaultValue: '',
    description: 'HD address of the server-side escrowed cappz-store wallet',
  } as ChainletStoreParam<string>,


  // ─── Middleware Base Layer (cappz-middleware.ts) ──────────────

  /**
   * Database name for the cappz-middleware persistence engine.
   */
  MiddlewareDbName: {
    address: `${MDM_ROOT}/middleware/db-name`,
    name: 'MiddlewareDbName',
    defaultValue: 'cappz-middleware',
    description: 'Database name for the cappz-middleware persistence engine',
  } as ChainletStoreParam<string>,

  /**
   * Database schema version for the cappz-middleware persistence engine.
   */
  MiddlewareDbVersion: {
    address: `${MDM_ROOT}/middleware/db-version`,
    name: 'MiddlewareDbVersion',
    // v11-2-015: bump to 4 as belt-and-suspenders for origins that reached v3
    // without a clean `chainlet_blocks` store creation (half-migrated state).
    defaultValue: 4,
    description: 'Schema version for the cappz-middleware database',
  } as ChainletStoreParam<number>,

  /**
   * Legacy database name (pre-migration source).
   */
  LegacyDbName: {
    address: `${MDM_ROOT}/middleware/legacy-db-name`,
    name: 'LegacyDbName',
    defaultValue: 'cappz-chainlet-cache',
    description: 'Legacy database name for migration source',
  } as ChainletStoreParam<string>,

  /**
   * MDM address for migration status event log.
   */
  MigrationStatusMdm: {
    address: `${MDM_ROOT}/middleware/migration-status-mdm`,
    name: 'MigrationStatusMdm',
    defaultValue: MIGRATION_STATUS_MDM,
    description: 'MDM address for migration lifecycle event log',
  } as ChainletStoreParam<string>,

  /**
   * Internal store name for migration status tracking.
   */
  MigrationStoreName: {
    address: `${MDM_ROOT}/middleware/migration-store`,
    name: 'MigrationStoreName',
    defaultValue: '__migration_status',
    description: 'Object store name for migration status entries',
  } as ChainletStoreParam<string>,

  /**
   * Required stores created on first database open.
   * v11-2-014: added `chainlet_blocks` — was pervasively missing, causing
   * NotFoundError in CappzEventCache.append across skills + codex + ingest.
   */
  RequiredStores: {
    address: `${MDM_ROOT}/middleware/required-stores`,
    name: 'RequiredStores',
    defaultValue: ['session', 'profile', 'transactions', 'appointments', 'dashboard', 'kv', 'chainlet_blocks'] as string[],
    description: 'Object stores guaranteed to exist in the middleware database',
  } as ChainletStoreParam<string[]>,


  // ─── Sub-skill Store Params ──────────────────────────────────

  /**
   * Default KV store name used by chainletStorage and sync-on-async.
   */
  KvStoreName: {
    address: `${MDM_ROOT}/store/kv-store-name`,
    name: 'KvStoreName',
    defaultValue: 'kv',
    description: 'Default key-value store name for chainletStorage facade',
  } as ChainletStoreParam<string>,

  /**
   * Key prefix for MDM TX cache entries.
   */
  MdmTxCachePrefix: {
    address: `${MDM_ROOT}/mdm-cache/prefix`,
    name: 'MdmTxCachePrefix',
    defaultValue: 'mdm-tx:',
    description: 'Key prefix for MDM transaction cache entries',
  } as ChainletStoreParam<string>,

  /**
   * Key for MDM TX cache index.
   */
  MdmTxCacheIndexKey: {
    address: `${MDM_ROOT}/mdm-cache/index-key`,
    name: 'MdmTxCacheIndexKey',
    defaultValue: 'mdm-tx:__index__',
    description: 'Cache key for MDM TX address index',
  } as ChainletStoreParam<string>,

  /**
   * Key for MDM TX cache last-sync timestamp.
   */
  MdmTxCacheSyncTsKey: {
    address: `${MDM_ROOT}/mdm-cache/sync-ts-key`,
    name: 'MdmTxCacheSyncTsKey',
    defaultValue: 'mdm-tx:__last-sync__',
    description: 'Cache key for last MDM sync timestamp',
  } as ChainletStoreParam<string>,

  /**
   * Storage key for A2A device identity.
   */
  A2ADeviceIdKey: {
    address: `${MDM_ROOT}/a2a/device-id-key`,
    name: 'A2ADeviceIdKey',
    defaultValue: 'cappz_device_id',
    description: 'Storage key for A2A sync device identifier',
  } as ChainletStoreParam<string>,

  /**
   * Pipeline name for skill manifest persistence.
   */
  ManifestPipelineName: {
    address: `${MDM_ROOT}/manifest/pipeline-name`,
    name: 'ManifestPipelineName',
    defaultValue: 'skill-manifest',
    description: 'Pipeline identifier for skill manifest sync-on-async processing',
  } as ChainletStoreParam<string>,

  /**
   * Key prefix for persisted skill manifests.
   */
  ManifestKeyPrefix: {
    address: `${MDM_ROOT}/manifest/key-prefix`,
    name: 'ManifestKeyPrefix',
    defaultValue: 'skill:manifest:',
    description: 'Key prefix for wallet-resident skill manifests',
  } as ChainletStoreParam<string>,
} as const;

// ─── Type Exports ─────────────────────────────────────────────

export type ChainletStoreParamKey = keyof typeof ChainletStoreParamType;

export type AnchorStrategy = 'off' | 'individual' | 'batch';

// ─── Event Type Derivation MDM Mapping ────────────────────────

const EVENT_TYPE_MDM_ROOT = _EVENT_TYPE_MDM_ROOT;

/**
 * Canonical lifecycle event types that serve as base derivation roots.
 * Domain-specific events (TradeCreated, OrderCreated, etc.) derive from these.
 */
export type CanonicalLifecycleEvent = 
  | 'ContentCreated'
  | 'ContentAmended'
  | 'ContentDeprecated'
  | 'ContentReverted'
  | 'ContentCloned';

/**
 * Event type derivation mapping — resolves domain-specific events to canonical types.
 * MDM addresses are used to associate derived events with their canonical roots.
 */
export interface EventTypeDerivation {
  /** MDM address for this derivation mapping */
  address: string;
  /** Derived event type (domain-specific) */
  derivedType: string;
  /** Canonical parent event type */
  canonicalType: CanonicalLifecycleEvent;
  /** MDM Tx hash that created this derivation */
  createdTx?: string;
}

/**
 * Built-in derivation mappings (extensible via MDM).
 * Domain events map to canonical lifecycle events for concurrency checking.
 */
const BUILTIN_DERIVATIONS: EventTypeDerivation[] = [
  // Trade lifecycle events
  { address: `${EVENT_TYPE_MDM_ROOT}/trade/created`, derivedType: 'TradeCreated', canonicalType: 'ContentCreated' },
  { address: `${EVENT_TYPE_MDM_ROOT}/trade/amended`, derivedType: 'TradeAmended', canonicalType: 'ContentAmended' },
  { address: `${EVENT_TYPE_MDM_ROOT}/trade/cancelled`, derivedType: 'TradeCancelled', canonicalType: 'ContentReverted' },
  { address: `${EVENT_TYPE_MDM_ROOT}/trade/novated`, derivedType: 'TradeNovated', canonicalType: 'ContentCloned' },
  
  // Order lifecycle events
  { address: `${EVENT_TYPE_MDM_ROOT}/order/created`, derivedType: 'OrderCreated', canonicalType: 'ContentCreated' },
  { address: `${EVENT_TYPE_MDM_ROOT}/order/amended`, derivedType: 'OrderAmended', canonicalType: 'ContentAmended' },
  { address: `${EVENT_TYPE_MDM_ROOT}/order/cancelled`, derivedType: 'OrderCancelled', canonicalType: 'ContentReverted' },
  
  // Document lifecycle events
  { address: `${EVENT_TYPE_MDM_ROOT}/document/created`, derivedType: 'DocumentCreated', canonicalType: 'ContentCreated' },
  { address: `${EVENT_TYPE_MDM_ROOT}/document/revised`, derivedType: 'DocumentRevised', canonicalType: 'ContentAmended' },
  { address: `${EVENT_TYPE_MDM_ROOT}/document/superseded`, derivedType: 'DocumentSuperseded', canonicalType: 'ContentDeprecated' },
  
  // RefData lifecycle events
  { address: `${EVENT_TYPE_MDM_ROOT}/refdata/list-created`, derivedType: 'ListDomainCreated', canonicalType: 'ContentCreated' },
  { address: `${EVENT_TYPE_MDM_ROOT}/refdata/list-versioned`, derivedType: 'ListVersioned', canonicalType: 'ContentAmended' },
  { address: `${EVENT_TYPE_MDM_ROOT}/refdata/value-created`, derivedType: 'ListValueCreated', canonicalType: 'ContentCreated' },
];

// Runtime derivation cache (populated from MDM + builtins)
let derivationCache: EventTypeDerivation[] | null = null;

/**
 * Get all event type derivations (builtins + MDM-registered).
 * TODO: Wire to MDM lookup for dynamic derivation registration.
 */
export function getEventTypeDerivations(): EventTypeDerivation[] {
  if (derivationCache) return derivationCache;
  derivationCache = [...BUILTIN_DERIVATIONS];
  // Future: Merge with MDM-registered derivations
  return derivationCache;
}

/**
 * Resolve a domain-specific event type to its canonical lifecycle equivalent.
 * Returns the input if already canonical or no mapping exists.
 */
export function resolveCanonicalEventType(eventType: string): CanonicalLifecycleEvent | string {
  // Already canonical?
  const canonicals: CanonicalLifecycleEvent[] = [
    'ContentCreated', 'ContentAmended', 'ContentDeprecated', 'ContentReverted', 'ContentCloned'
  ];
  if (canonicals.includes(eventType as CanonicalLifecycleEvent)) {
    return eventType as CanonicalLifecycleEvent;
  }
  
  // Look up derivation
  const derivations = getEventTypeDerivations();
  const match = derivations.find(d => d.derivedType === eventType);
  return match?.canonicalType ?? eventType;
}

/**
 * Check if an event type is semantically equivalent to "ContentCreated" (including derived types).
 */
export function isContentCreatedEquivalent(eventType: string): boolean {
  return resolveCanonicalEventType(eventType) === 'ContentCreated';
}

/**
 * Check if an event type is semantically equivalent to "ContentAmended" (including derived types).
 */
export function isContentAmendedEquivalent(eventType: string): boolean {
  return resolveCanonicalEventType(eventType) === 'ContentAmended';
}

/**
 * Get all event types that are semantically equivalent to a canonical type.
 */
export function getEquivalentEventTypes(canonicalType: CanonicalLifecycleEvent): string[] {
  const derivations = getEventTypeDerivations();
  const equivalents = derivations
    .filter(d => d.canonicalType === canonicalType)
    .map(d => d.derivedType);
  return [canonicalType, ...equivalents];
}

// ─── Helper: Get param value (with MDM lookup placeholder) ────

/**
 * Resolve parameter value from MDM or return default.
 * TODO: Wire to actual MDM lookup when available.
 */
export function getChainletParam<T>(param: ChainletStoreParam<T>): T {
  // Future: MDM lookup via param.address
  // For now, return default
  return param.defaultValue;
}

/**
 * Get all param addresses for audit/discovery.
 */
export function getAllParamAddresses(): Record<string, string> {
  const addresses: Record<string, string> = {};
  for (const [key, param] of Object.entries(ChainletStoreParamType)) {
    addresses[key] = param.address;
  }
  return addresses;
}
