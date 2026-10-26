/**
 * ChainletWallet Types
 * 
 * Universal cross-blockchain wallet abstraction for CAPPZ.
 * Enables resident agents to remain blockchain-agnostic while managing
 * transactions across multiple chains through a unified interface.
 */

export type BlockchainNetwork = 
  | 'xrpl'
  | 'bitcoin'
  | 'ethereum'
  | 'solana'
  | 'polygon'
  | 'avalanche'
  | 'cosmos'
  | 'stellar';

export type ChainletWalletRole = 
  | 'primary'      // Main settlement/signal chain
  | 'embedded'     // Sub-wallet managed by parent
  | 'observer';    // Read-only monitoring

export type TransactionStatus = 
  | 'pending'
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'reblocked';

export interface ChainletTransaction {
  id: string;
  network: BlockchainNetwork;
  nativeTxHash: string;
  from: string;
  to: string;
  amount: string;
  currency: string;
  timestamp: string;
  status: TransactionStatus;
  
  // CAPPZ notarization
  chainletBlockHash?: string;
  reblockIndex?: number;
  merkleProof?: string[];
  
  // Native chain metadata
  nativeMetadata: Record<string, unknown>;
}

export interface ChainletReblock {
  blockIndex: number;
  blockHash: string;
  previousHash: string;
  merkleRoot: string;
  timestamp: string;
  transactions: ChainletTransaction[];
  network: BlockchainNetwork;
  hdAddress: string;
  
  // Cross-chain anchor (optional)
  anchorChain?: BlockchainNetwork;
  anchorTxHash?: string;
}

export interface EmbeddedWalletConfig {
  network: BlockchainNetwork;
  address: string;
  role: ChainletWalletRole;
  syncEnabled: boolean;
  lastSyncAt?: string;
  permissions: WalletPermission[];
}

export interface WalletPermission {
  action: 'read' | 'sign' | 'transfer' | 'admin';
  scope: 'self' | 'all' | 'specific';
  allowedAddresses?: string[];
}

export interface ChainletWalletState {
  isConnected: boolean;
  isSyncing: boolean;
  lastError?: string;
  pendingTransactions: number;
  confirmedTransactions: number;
  totalReblocks: number;
}

export interface CrossChainTransfer {
  id: string;
  sourceNetwork: BlockchainNetwork;
  sourceAddress: string;
  sourceTxHash: string;
  
  targetNetwork: BlockchainNetwork;
  targetAddress: string;
  targetTxHash?: string;
  
  amount: string;
  currency: string;
  bridgeProtocol?: string;
  
  status: 'initiated' | 'source_confirmed' | 'bridging' | 'target_confirmed' | 'completed' | 'failed';
  initiatedAt: string;
  completedAt?: string;
}

export interface ChainletWalletMetrics {
  totalVolume: Record<string, number>;
  transactionCount: number;
  networkBreakdown: Record<BlockchainNetwork, number>;
  averageConfirmationTime: number;
  reblockCoverage: number;
}

// ─── Wallet Role Enum (Phase 3 — replaces boolean flags) ───

/** Extensible enum of wallet functional roles */
export enum CappzWalletRole {
  ARC  = 'ARC',   // Agent Revenue Capture
  DARC = 'DARC',  // Distributed Agent Revenue Capture
  ALL  = '__ALL__', // Sentinel for RemoveWalletRole — strips all roles
}

/** Role-specific configuration, keyed by CappzWalletRole */
export interface ARCRoleConfig {
  /** HD root for revenue capture */
  hdRootPath: string;
  /** Active since (ISO 8601) */
  activatedAt: string;
  /** Current WAS signal chain head TX hash */
  wasHeadTx?: string;
}

export interface DARCRoleConfig {
  /** Parent ARC address this DARC distributes for */
  parentArcAddress: string;
  /** Split rules — percentage or absolute */
  splitRules: DARCSplitRule[];
  /** Last signal TX defining current splits */
  splitSignalTx?: string;
}

export type DARCSplitType = 'percentage' | 'absolute';

export interface DARCSplitRule {
  targetAddress: string;
  splitType: DARCSplitType;
  /** 0-1 for percentage, absolute amount for 'absolute' */
  value: number;
  currency?: string;
  label?: string;
}

// ─── RefData Domain Engine Types (Phase 1A) ───

/** Top-level standard roots */
export type RefDataStandard = 'ISO20022' | 'FpML' | 'FIX' | 'Custom';

/** Registration status for a value within a standard */
export type RefDataValueStatus = 'active' | 'deprecated' | 'terminated';

/** A reference data domain (e.g., CurrencyCode, businessCenter, OrdType) */
export interface RefDataDomain {
  id: string;
  standard: RefDataStandard;
  /** Canonical identifier (e.g., 'CurrencyCode', 'businessCenter') */
  domainCode: string;
  /** Human-readable name */
  displayName: string;
  description?: string;
  /** HD root address for this domain */
  hdRootAddress: string;
  /** HD derivation path from the standard root */
  hdDerivationPath: string;
  /** Source URI for external standards (e.g., FpML scheme URI) */
  sourceUri?: string;
  /** Parent domain for derived/enterprise extensions */
  parentDomainId?: string;
  createdAt: string;
  updatedAt: string;
}

/** A permanently-addressed value within a domain */
export interface RefDataValue {
  id: string;
  domainId: string;
  /** The code (e.g., 'USD', 'USNY', '1') */
  code: string;
  /** Human display name (e.g., 'US Dollar') */
  displayName: string;
  definition?: string;
  /** HD child address — permanent, never changes across versions */
  hdAddress: string;
  /** HD derivation index within the values branch */
  hdIndex: number;
  status: RefDataValueStatus;
  /** Source-specific metadata (registrationStatus, etc.) */
  sourceMetadata?: Record<string, unknown>;
  createdAt: string;
  deprecatedAt?: string;
}

/** A version of a domain's value list */
export interface RefDataVersion {
  id: string;
  domainId: string;
  /** Version identifier (e.g., 'currency-codes-1-00') */
  versionCode: string;
  /** HD address in the versions branch */
  hdAddress: string;
  /** HD derivation index within the versions branch */
  hdIndex: number;
  /** TX hash of the ListVersioned event linking to prior version */
  supersedesTx?: string;
  /** Prior version ID */
  priorVersionId?: string;
  publishedAt: string;
  createdAt: string;
}

/** Membership: which values belong to which version */
export interface RefDataVersionMembership {
  id: string;
  versionId: string;
  valueId: string;
  /** TX hash of ListValueRefCreated */
  createdTx: string;
  /** TX hash of ListValueRefTerminated (if deprecated in this version) */
  terminatedTx?: string;
  isActive: boolean;
}

/** Cross-standard value mapping */
export interface RefDataValueMapping {
  id: string;
  sourceValueId: string;
  targetValueId: string;
  /** TX hash of ValueMappingCreated */
  createdTx: string;
  /** TX hash of ValueMappingTerminated (if invalidated) */
  terminatedTx?: string;
  isActive: boolean;
  createdAt: string;
}

// ─── RefData Event Types (Phase 1A) ───

export type RefDataEventType =
  | 'StandardRegistered'
  | 'ListDomainCreated'
  | 'ListVersionCreated'
  | 'ListVersioned'
  | 'ListValueCreated'
  | 'ListValueRefCreated'
  | 'ListValueRefTerminated'
  | 'ValueMappingCreated'
  | 'ValueMappingTerminated';

export interface RefDataEvent {
  eventType: RefDataEventType;
  txHash: string;
  timestamp: string;
  /** Source address (Subject in triple model) */
  sourceAddress: string;
  /** Target address (Object in triple model) */
  targetAddress: string;
  /** ISO 20022 mandatory metadata */
  msgId: string;
  creDtTm: string;
  orgnlMsgId?: string;
  supersedesTx?: string;
  metadata?: Record<string, unknown>;
  /** Optional refdata value code embedded for TX cache index discovery */
  refdataCode?: string;
  /** Optional SHA-256 hash of the refdata value for integrity verification */
  refdataSha256?: string;
}

// ─── WAS Signal Types (Phase 2) ───

export type WASSignalType =
  | 'ARCActivated'
  | 'ARCDeprecated'
  | 'ARCReplaced'
  | 'DARCPcnt'
  | 'DARCAmt'
  | 'DARCActivated'
  | 'DARCDeprecated';

export interface WASSignal {
  signalType: WASSignalType;
  txHash: string;
  timestamp: string;
  fromAddress: string;
  toAddress: string;
  /** For DARCPcnt: 0-1 percentage; for DARCAmt: absolute amount */
  value?: number;
  /** Linked-list: previous signal TX hash */
  previousSignalTx?: string;
  metadata?: Record<string, unknown>;
}

export interface WASResolutionResult {
  /** Current active address for the queried role */
  currentAddress: string;
  /** Full signal chain from newest to oldest */
  signalChain: WASSignal[];
  /** Whether the address is currently active */
  isActive: boolean;
  /** Timestamp of last state change */
  lastUpdated: string;
}

// ─── Dual-Signature TX Sets (Phase 3) ───

export interface DualSigTxSet {
  id: string;
  /** All transactions in this atomic set */
  transactions: ChainletTransaction[];
  /** Signature from wallet A */
  sigA: { wallet: string; signature: string; signedAt: string };
  /** Signature from wallet B */
  sigB?: { wallet: string; signature: string; signedAt: string };
  /** Both signed = ready to submit */
  status: 'pending_sig_a' | 'pending_sig_b' | 'ready' | 'submitted' | 'confirmed' | 'failed';
  createdAt: string;
}

/**
 * Base interface for all ChainletWallet implementations
 */
export interface IChainletWallet {
  readonly id: string;
  readonly network: BlockchainNetwork;
  readonly address: string;
  readonly role: ChainletWalletRole;
  
  // State
  getState(): ChainletWalletState;
  
  // Connection
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  
  // Transactions
  getTransactions(limit?: number): Promise<ChainletTransaction[]>;
  signTransaction(tx: unknown): Promise<string>;
  submitTransaction(signedTx: string): Promise<string>;
  
  // Reblocking
  getReblocks(limit?: number): Promise<ChainletReblock[]>;
  createReblock(transactions: ChainletTransaction[]): Promise<ChainletReblock>;
  
  // Embedded wallets (for cross-chain admin)
  getEmbeddedWallets(): EmbeddedWalletConfig[];
  addEmbeddedWallet(config: EmbeddedWalletConfig): Promise<void>;
  removeEmbeddedWallet(address: string, network: BlockchainNetwork): Promise<void>;
  
  // Cross-chain operations
  initiateCrossChainTransfer(transfer: Omit<CrossChainTransfer, 'id' | 'status' | 'initiatedAt'>): Promise<CrossChainTransfer>;
  getCrossChainTransfers(): Promise<CrossChainTransfer[]>;
  
  // Metrics
  getMetrics(): Promise<ChainletWalletMetrics>;
}
