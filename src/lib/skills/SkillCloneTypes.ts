/**
 * SkillCloneTypes — Types for clone/template linking, build-log,
 * and upgrade session clone architecture.
 *
 * TD-003+005: Clone → Parent Template Link (upgrade path)
 * TD-006: Clone-scoped Build-Log
 * TD-001: Upgrade Session Clone pattern
 */

// ─── Clone Provenance (TD-003+005) ─────────────────────────────

export interface SkillCloneProvenance {
  /** MDM address of the parent skill template */
  parentTemplateMdmAddress: string;
  /** Version hash of the parent at clone time */
  parentTemplateVersion: string;
  /** Template ID (e.g., 'template:iso20022') */
  parentTemplateId: string;
  /** When this clone was created */
  clonedAt: string;
  /** Wallet that initiated the clone */
  clonedByWallet: string;
  /** Whether this clone is read-only (template copy) */
  isReadOnly: boolean;
  /** Current upgrade status */
  upgradeStatus: 'current' | 'upgrade-available' | 'upgrading' | 'upgrade-failed';
  /** Last checked for upgrades */
  lastUpgradeCheck?: string;
  /** Version of the latest available parent template */
  latestParentVersion?: string;
}

// ─── Build Log (TD-006) ────────────────────────────────────────

export type BuildLogCategory =
  | 'bpmn-version'
  | 'pipeline-transform'
  | 'schema-amendment'
  | 'transport-config'
  | 'field-mapping'
  | 'skill-config'
  | 'upgrade'
  | 'tech-debt'
  | 'distribution-config'
  | 'reply-threading'
  | 'custom';

export interface BuildLogEntry {
  /** Unique entry ID */
  entryId: string;
  /** Category of structural change */
  category: BuildLogCategory;
  /** Skill ID that produced this entry */
  skillId: string;
  /** Wallet address of the clone */
  walletAddress: string;
  /** Human-readable description */
  description: string;
  /** What changed (before/after snapshots) */
  changeSummary: {
    before?: Record<string, unknown>;
    after: Record<string, unknown>;
  };
  /** Version label (e.g., '1.0.1-clone.3') */
  versionLabel: string;
  /** Timestamp */
  timestamp: string;
  /** Whether this entry has been synced upchain to parent template */
  syncedToParent: boolean;
  /** TX hash if anchored */
  txHash?: string;
  /** Related operations log entry ID */
  relatedOperationId?: string;
}

export interface BuildLogSummary {
  totalEntries: number;
  byCategory: Record<string, number>;
  unsyncedCount: number;
  latestVersion: string;
  lastEntryAt?: string;
}

// ─── Upgrade Session Clone (TD-001) ────────────────────────────

export type CloneTier = 'user-clone' | 'embedded-skill-clone' | 'template-copy';

export interface UpgradeSessionCloneConfig {
  /** The tier of this clone instance */
  tier: CloneTier;
  /** Parent template ID for upgrade checks */
  parentTemplateId: string;
  /** Skills embedded as clones in this session */
  embeddedSkillClones: string[];
  /** Read-only template copy (private keys removed) */
  templateCopyMdmAddress?: string;
  /** Whether this clone accepts DomainModelAmended broadcasts */
  acceptsUpgradeBroadcast: boolean;
  /** Routing rules for template → clone broadcasts */
  routingRules: UpgradeRoutingRule[];
}

export interface UpgradeRoutingRule {
  /** Event type to listen for */
  eventType: 'DomainModelAmended' | 'SkillVersionPublished' | 'TemplateConfigUpdated';
  /** Source template admin address */
  sourceTemplateAddress: string;
  /** Delivery mode */
  delivery: 'broadcast' | 'multicast' | 'direct';
  /** Whether to auto-apply or require user confirmation */
  autoApply: boolean;
  /** Created timestamp */
  createdAt: string;
}

// ─── TX Event Types ────────────────────────────────────────────

export interface SkillCloneCreatedTx {
  eventType: 'SkillCloneCreated';
  parentTemplateMdmAddress: string;
  parentTemplateVersion: string;
  parentTemplateId: string;
  cloneTier: CloneTier;
  clonedAt: string;
  clonedByWallet: string;
  isReadOnly: boolean;
}

export interface SkillUpgradeRequestedTx {
  eventType: 'SkillUpgradeRequested';
  fromVersion: string;
  toVersion: string;
  parentTemplateId: string;
  requestedAt: string;
  requestedByWallet: string;
  /** 'prompt' | 'tx-event' — how the upgrade was triggered */
  triggerMethod: 'prompt' | 'tx-event';
}

export interface SkillUpgradeAppliedTx {
  eventType: 'SkillUpgradeApplied';
  fromVersion: string;
  toVersion: string;
  parentTemplateId: string;
  appliedAt: string;
  buildLogEntryId: string;
}

export interface BuildLogSyncedTx {
  eventType: 'BuildLogSynced';
  entryIds: string[];
  syncedToTemplateAddress: string;
  syncedAt: string;
  totalEntries: number;
}

// ─── Clone CID Admin Group (Local, Autonomous) ────────────────

export type GroupMemberStatus = 'added' | 'activated' | 'suspended' | 'reactivated' | 'removed';

export interface CloneCIDAdminGroupTx {
  eventType: 'GroupMemberAdded' | 'GroupMemberActivated' | 'GroupMemberSuspended' | 'GroupMemberReActivated' | 'GroupMemberRemoved';
  memberAddress: string;
  memberType: 'cid-agent' | 'domain-agent' | 'user';
  groupScope: string; // clone HD address
  effectiveAt: string; // supports future-dating
  bundleId?: string; // TX bundle correlation
}

export interface CloneStateSyncedTx {
  eventType: 'CloneStateSynced';
  cloneAddress: string;
  mirrorAddress: string; // cappz.ai mirror
  syncType: 'init' | 'on-demand' | 'scheduled';
  stateHash: string;
  syncedAt: string;
}

export interface CloneLearningPromotedTx {
  eventType: 'CloneLearningPromoted';
  cloneAddress: string;
  learningCategory: 'field-mapping' | 'bpmn-refinement' | 'pipeline-transform' | 'schema-amendment';
  learnedOverridesCount: number;
  promotedAt: string;
  /** Local promotion — no root admin approval needed */
  promotionScope: 'local-clone';
}
