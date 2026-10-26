/**
 * CAPPZ Chainlet Error Hierarchy
 * 
 * Structured error propagation across the call stack.
 * Every layer throws typed errors that preserve the causal chain.
 */

/** Base error for all chainlet operations */
export class ChainletError extends Error {
  readonly code: string;
  readonly layer: 'engine' | 'wallet' | 'registry' | 'refdata' | 'validation' | 'operational';
  readonly cause?: Error;
  readonly timestamp: string;

  constructor(
    message: string,
    code: string,
    layer: ChainletError['layer'],
    cause?: Error
  ) {
    super(cause ? `${message} — caused by: ${cause.message}` : message);
    this.name = 'ChainletError';
    this.code = code;
    this.layer = layer;
    this.cause = cause;
    this.timestamp = new Date().toISOString();
  }
}

/** RefData domain/value/version resolution failures */
export class RefDataResolutionError extends ChainletError {
  readonly entityType: 'domain' | 'value' | 'version' | 'mapping' | 'role';
  readonly entityId: string;

  constructor(entityType: RefDataResolutionError['entityType'], entityId: string, cause?: Error) {
    super(
      `RefData ${entityType} not found: ${entityId}`,
      `REFDATA_${entityType.toUpperCase()}_NOT_FOUND`,
      'refdata',
      cause
    );
    this.name = 'RefDataResolutionError';
    this.entityType = entityType;
    this.entityId = entityId;
  }
}

/** Role lifecycle transaction failures */
export class RoleTransactionError extends ChainletError {
  readonly roleCode: string;
  readonly walletAddress: string;

  constructor(message: string, roleCode: string, walletAddress: string, cause?: Error) {
    super(message, 'ROLE_TX_FAILED', 'wallet', cause);
    this.name = 'RoleTransactionError';
    this.roleCode = roleCode;
    this.walletAddress = walletAddress;
  }
}

/** HD derivation path errors */
export class HDDerivationError extends ChainletError {
  readonly path: string;

  constructor(message: string, path: string, cause?: Error) {
    super(message, 'HD_DERIVATION_FAILED', 'engine', cause);
    this.name = 'HDDerivationError';
    this.path = path;
  }
}

/** Wallet group management errors */
export class WalletGroupError extends ChainletError {
  readonly groupId: string;

  constructor(message: string, groupId: string, cause?: Error) {
    super(message, 'WALLET_GROUP_ERROR', 'wallet', cause);
    this.name = 'WalletGroupError';
    this.groupId = groupId;
  }
}
