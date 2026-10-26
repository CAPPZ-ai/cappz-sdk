/**
 * Chainlet shapes (v15-12-05: from chainletService.ts, which re-exports them), so code that only
 * reads blocks and chainlets (xrplChainletAnchor) does not depend on the hosted service.
 */
export interface ChainletQuery {
  type: 'address_set' | 'metadata_filter' | 'smart_cache' | 'composite';
  addressFilter?: {
    addresses: string[];
    includeInbound?: boolean;
    includeOutbound?: boolean;
  };
  metadataFilter?: {
    field: string;
    operator: 'equals' | 'contains' | 'greater_than' | 'less_than';
    value: any;
  };
  smartCache?: {
    function: 'SmartAddressCache' | string;
    params: Record<string, any>;
  };
  timeWindow?: {
    start: Date;
    end: Date;
  };
  compositeQueries?: ChainletQuery[];
}

// Filtered Transaction from mainchain
export interface FilteredTransaction {
  txHash: string;
  from: string;
  to: string;
  amount: string;
  timestamp: Date;
  metadata?: Record<string, any>;
  mainchainBlock: number;
  mainchainProof: {
    merkleProof: string[];
    blockHash: string;
  };
}

// Chainlet Block Structure
export interface ChainletBlock {
  blockNumber: number;
  previousHash: string;
  merkleRoot: string;
  timestamp: Date;
  anchorBlock: {
    mainchainNetwork: string;
    mainchainBlockNumber: number;
    mainchainBlockHash: string;
  };
  viewQuery: ChainletQuery;
  queryHash: string;
  transactions: FilteredTransaction[];
  transactionCount: number;
  signature?: string;
  encryptionKey?: string;
  hdAddress?: string;
  hdBlockIndex?: number;
  sourceChainletId?: string;
  sourceBlockId?: string;
  dependencyChain?: string[];
}

// Chainlet Dependency
export interface ChainletDependency {
  id: string;
  parentChainletId: string;
  childChainletId: string;
  dependencyType: 'stream' | 'snapshot' | 'filter';
  transformationQuery?: ChainletQuery;
  isActive: boolean;
  createdAt: Date;
}

// Chainlet Metadata
export interface Chainlet {
  id: string;
  name: string;
  description: string;
  ownerWallet: string;
  query: ChainletQuery;
  queryHash: string;
  createdAt: Date;
  lastBlockNumber: number;
  lastBlockHash: string;
  totalBlocks: number;
  totalTransactions: number;
  isActive: boolean;
  hdRootPath?: string;
  hasDependencies?: boolean;
  isRoot?: boolean;
  dependencyDepth?: number;
}
