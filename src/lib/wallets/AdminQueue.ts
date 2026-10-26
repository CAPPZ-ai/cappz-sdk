/**
 * AdminQueue — Universal admin queue infrastructure.
 *
 * Every CappzWallet, WalletAgent, and AgentSkill has an admin queue.
 * The admin queue is a deterministic HD address ([entity].admin) serving
 * as an immutable event log for lifecycle management.
 *
 * On construction, an "AdminQueueCreated" event TX is auto-emitted to
 * establish the queue's existence. Current status is resolved by reading
 * the latest TX from this address.
 *
 * Intercommunication: All three levels (Wallet → Agent → Skill) can
 * post events to each other's admin queues, enabling full-stack
 * lifecycle coordination processed by WalletOps.
 */

import { offlineCache } from '../offlineCache';

// ─── Admin Queue Event Types ─────────────────────────────────

export type AdminQueueEventType =
  // Queue lifecycle
  | 'AdminQueueCreated'
  // Wallet lifecycle (processed by WalletOps)
  | 'WalletCreated'
  | 'WalletCloned'
  | 'WalletActivated'
  | 'WalletSuspended'
  | 'WalletDeactivated'
  | 'WalletDeprecated'
  // Agent lifecycle
  | 'AgentBound'
  | 'AgentUnbound'
  | 'AgentHibernated'
  | 'AgentResumed'
  // Skill lifecycle
  | 'SkillAttached'
  | 'SkillDetached'
  | 'SkillPaused'
  | 'SkillResumed'
  // Group membership lifecycle (bundleable, future-datable)
  | 'GroupMemberAdded'
  | 'GroupMemberActivated'
  | 'GroupMemberSuspended'
  | 'GroupMemberReActivated'
  | 'GroupMemberRemoved'
  // CID lifecycle
  | 'ReleasePlanCreationRequested'
  | 'ReleasePlanExecutionRequested'
  | 'ReleasePlanCreated'
  | 'ReleasePlanExecutionStarted'
  | 'ReleasePlanExecutionCompleted'
  | 'ReleasePlanStepExecuted'
  | 'ConstituentCreated'
  | 'ConstituentRemoved'
  | 'CloneStateSynced'
  | 'CloneLearningPromoted'
  // TX Linked List ordering (AX-41)
  | 'PredecessorAssigned'
  | 'PredecessorDeprecated'
  // Duplicate TX Remediation (AX-43)
  | 'DuplicateTxDeprecated'
  | 'DuplicateTxRemediationCompleted'
  // Copy/Clone provenance (AX-44, AX-45)
  | 'CopyGranted'
  | 'CopyRevoked'
  | 'BranchMerged'
  // Intercommunication
  | 'AdminCommand'
  | 'AdminAck'
  | 'AdminNack'
  // Custom domain events
  | string;

// ─── Admin Queue TX ──────────────────────────────────────────

export interface AdminQueueTx {
  /** Unique TX identifier */
  msgId: string;
  /** Event type */
  eventType: AdminQueueEventType;
  /** ISO timestamp */
  timestamp: string;
  /** Source admin queue address (for intercommunication) */
  sourceAddress: string;
  /** Target admin queue address */
  targetAddress: string;
  /** Correlation ID to prior TX */
  orgnlMsgId?: string;
  /** Supersedes a previous TX */
  supersedesTx?: string;
  /** Arbitrary payload */
  payload?: Record<string, unknown>;
  /** Same object as `payload`, under the event-TX field name. */
  metadata?: Record<string, unknown>;

  /** On-chain TX hash if anchored */
  txHash?: string;
}

// ─── Admin Queue Owner Types ─────────────────────────────────

export type AdminQueueOwnerType = 'wallet' | 'agent' | 'skill';

// ─── Admin Queue Instance ────────────────────────────────────

export interface AdminQueueConfig {
  /** HD address for this admin queue */
  adminAddress: string;
  /** Owner type */
  ownerType: AdminQueueOwnerType;
  /** Owner identifier (wallet address, agent name, skill ID) */
  ownerId: string;
  /** Parent admin queue address (for hierarchy) */
  parentAdminAddress?: string;
}

export class AdminQueue {
  readonly adminAddress: string;
  readonly ownerType: AdminQueueOwnerType;
  readonly ownerId: string;
  readonly parentAdminAddress?: string;

  private _txHistory: AdminQueueTx[] = [];
  private _initialized = false;

  constructor(config: AdminQueueConfig) {
    this.adminAddress = config.adminAddress;
    this.ownerType = config.ownerType;
    this.ownerId = config.ownerId;
    this.parentAdminAddress = config.parentAdminAddress;
  }

  /**
   * Initialize the admin queue by emitting AdminQueueCreated.
   * Called once during construction of the owning entity.
   */
  async initialize(): Promise<AdminQueueTx> {
    if (this._initialized) {
      return this._txHistory[0]; // Return the genesis TX
    }

    const genesisTx = await this.emit('AdminQueueCreated', {
      ownerType: this.ownerType,
      ownerId: this.ownerId,
      parentAdminAddress: this.parentAdminAddress ?? null,
      createdAt: new Date().toISOString(),
    });

    this._initialized = true;
    return genesisTx;
  }

  /**
   * Emit a TX to this admin queue.
   */
  async emit(
    eventType: AdminQueueEventType,
    payload?: Record<string, unknown>,
    options?: {
      orgnlMsgId?: string;
      supersedesTx?: string;
      sourceAddress?: string;
    }
  ): Promise<AdminQueueTx> {
    const tx: AdminQueueTx = {
      msgId: crypto.randomUUID(),
      eventType,
      timestamp: new Date().toISOString(),
      sourceAddress: options?.sourceAddress ?? this.adminAddress,
      targetAddress: this.adminAddress,
      orgnlMsgId: options?.orgnlMsgId,
      supersedesTx: options?.supersedesTx,
      payload,
    };

    this._txHistory.push(tx);
    await this.persist();
    return tx;
  }

  /**
   * Post a command to another admin queue (intercommunication).
   * The source is this queue; the target is the other queue.
   */
  async postTo(
    targetQueue: AdminQueue,
    eventType: AdminQueueEventType,
    payload?: Record<string, unknown>,
  ): Promise<AdminQueueTx> {
    return targetQueue.emit(eventType, payload, {
      sourceAddress: this.adminAddress,
    });
  }

  /**
   * Acknowledge a received command.
   */
  async ack(originalTx: AdminQueueTx, payload?: Record<string, unknown>): Promise<AdminQueueTx> {
    return this.emit('AdminAck', {
      ...payload,
      acknowledgedEvent: originalTx.eventType,
    }, {
      orgnlMsgId: originalTx.msgId,
      sourceAddress: this.adminAddress,
    });
  }

  /**
   * Reject a received command.
   */
  async nack(originalTx: AdminQueueTx, reason: string): Promise<AdminQueueTx> {
    return this.emit('AdminNack', {
      reason,
      rejectedEvent: originalTx.eventType,
    }, {
      orgnlMsgId: originalTx.msgId,
      sourceAddress: this.adminAddress,
    });
  }

  /**
   * Get the latest TX (resolves current status).
   */
  getLatestTx(): AdminQueueTx | null {
    return this._txHistory.length > 0
      ? this._txHistory[this._txHistory.length - 1]
      : null;
  }

  /**
   * Get current status by reading the latest lifecycle TX.
   */
  getCurrentStatus(): AdminQueueEventType | null {
    const latest = this.getLatestTx();
    return latest?.eventType ?? null;
  }

  /**
   * Get all TXs (full audit trail).
   */
  get txHistory(): ReadonlyArray<AdminQueueTx> {
    return this._txHistory;
  }

  /**
   * Get TXs filtered by event type.
   */
  getTxsByType(eventType: AdminQueueEventType): AdminQueueTx[] {
    return this._txHistory.filter(tx => tx.eventType === eventType);
  }

  /**
   * Get TXs received from a specific source address.
   */
  getTxsFromSource(sourceAddress: string): AdminQueueTx[] {
    return this._txHistory.filter(tx => tx.sourceAddress === sourceAddress);
  }

  /**
   * Load persisted TX history from cappz-middleware.
   */
  async load(): Promise<void> {
    const key = `adminqueue:${this.adminAddress}`;
    const stored = await offlineCache.get<{ txHistory: AdminQueueTx[] }>('kv', key);
    if (stored?.txHistory?.length) {
      this._txHistory = stored.txHistory;
      this._initialized = this._txHistory.some(tx => tx.eventType === 'AdminQueueCreated');
    }
  }

  /**
   * Persist TX history to cappz-middleware.
   */
  private async persist(): Promise<void> {
    const key = `adminqueue:${this.adminAddress}`;
    await offlineCache.set('kv', key, {
      adminAddress: this.adminAddress,
      ownerType: this.ownerType,
      ownerId: this.ownerId,
      txHistory: this._txHistory,
      updatedAt: new Date().toISOString(),
    }, {
      walletAddress: this.ownerId,
      ttl: 365 * 24 * 60 * 60 * 1000,
    });
  }

  get isInitialized(): boolean {
    return this._initialized;
  }

  /**
   * Derive the canonical admin queue address for a given HD path.
   * Convention: {hdPath}/admin
   */
  static deriveAddress(hdPath: string): string {
    return `${hdPath}/admin`;
  }
}
