/**
 * SkillTypes — Shared types for the AgentSkill composition model.
 *
 * Skills compose agents — they do NOT derive from WalletAgent.
 * Factory-initialized from MDM addresses:
 *   retval = AgentSkill(MDM.FetchAddress(MDM_ID)).Configure(walletAgent)
 */

// ─── Lifecycle Context ─────────────────────────────────────────

export interface SkillSaveContext {
  /** The wallet domain root (e.g., m/44'/144'/21') */
  domainRoot: string;
  /** Serialized content to notarize/process */
  content: string;
  /** Optional human-readable title for the save event */
  title?: string;
  /** Wallet address performing the save */
  walletAddress: string;
  /** Whether NotarizeEach is enabled */
  notarizeEach: boolean;
  /** Whether NotarizeAll is enabled */
  notarizeAll: boolean;
  /** Timestamp of the save */
  timestamp: string;
}

// ─── Receipts ──────────────────────────────────────────────────

export interface SkillReceipt {
  skillId: string;
  success: boolean;
  /** On-chain TX hash if applicable */
  txHash?: string;
  /** Additional receipt data */
  data?: Record<string, unknown>;
  /** Error message if !success */
  error?: string;
  timestamp: string;
}

// ─── Configuration Transactions ────────────────────────────────

export interface ConfigTx {
  /** Event type (e.g., 'MDMBindingCreated', 'RoyaltyFeeAmended') */
  eventType: string;
  /** HD address this config TX is emitted from */
  sourceAddress: string;
  /** Payload */
  payload: Record<string, unknown>;
  /** ISO timestamp */
  timestamp: string;
  /** Optional TX hash if anchored */
  txHash?: string;
}

// ─── Royalty Model ─────────────────────────────────────────────

export interface RoyaltyConfig {
  /** User fee charged per notarization (default: '10.10' CAPPZ) */
  userFee: string;
  /** Treasury portion of fee (default: '10.00' CAPPZ) */
  treasuryFee: string;
  /** Operator retain portion (default: '0.10' CAPPZ) */
  operatorFee: string;
  /** DARC split rules (6-decimal precision) */
  splits: DARCSplit[];
  /** Treasury wallet address (MDM-resolved) */
  treasuryAddress: string;
}

export interface DARCSplit {
  /** Destination wallet address */
  destination: string;
  /** Percentage with 6-decimal precision */
  percentage: string;
  /** Optional label */
  label?: string;
}

// ─── Provenance ────────────────────────────────────────────────

export interface ProvenanceHop {
  /** Source wallet address */
  source: string;
  /** Target wallet address */
  target: string;
  /** Attestation type */
  attestationType: 'origin' | 'relay' | 'terminal';
  /** Hop depth (0-based) */
  depth: number;
  /** TX hash for this attestation */
  txHash?: string;
}

// ─── Skill Manifest (for registry listing) ─────────────────────

export interface SkillManifest {
  /** Unique skill identifier (e.g., 'cappz:notarization') */
  skillId: string;
  /** Human-readable name */
  name: string;
  /** Description */
  description: string;
  /** MDM address that defines this skill */
  mdmAddress: string;
  /** Semantic version */
  version: string;
  /** Whether this is a default skill for new agents */
  isDefault: boolean;
  /** Category for grouping */
  category: 'core' | 'voice' | 'factory' | 'domain' | 'custom' | 'protocol';
}

// ─── Royalty Fee Amendment (DualSig required) ──────────────────

export interface RoyaltyFeeAmendedTx extends ConfigTx {
  eventType: 'RoyaltyFeeAmended';
  payload: {
    previousUserFee: string;
    newUserFee: string;
    previousTreasuryFee: string;
    newTreasuryFee: string;
    previousOperatorFee: string;
    newOperatorFee: string;
    effectiveAt: string;
    /** Wallet that initiated the amendment */
    amendedBy: string;
    /** Admin wallet signature */
    adminSignature: string;
    /** Treasury wallet signature */
    treasurySignature: string;
    /** DualSig verification status */
    dualSigVerified: boolean;
  };
}

// ─── Skill Binding (Parent → Child dependency graph) ───────────

export interface SkillBindingCreatedTx extends ConfigTx {
  eventType: 'SkillBindingCreated';
  payload: {
    parentSkillId: string;
    childSkillId: string;
    parentMdmAddress: string;
    childMdmAddress: string;
    bindingType: 'requires' | 'composes' | 'enhances';
    boundAt: string;
  };
}

export interface SkillBindingDeprecatedTx extends ConfigTx {
  eventType: 'SkillBindingDeprecated';
  payload: {
    parentSkillId: string;
    childSkillId: string;
    deprecatedAt: string;
    supersededBy?: string;
    reason: string;
  };
}

// ─── Skill Constituent Graph (element → RefData mapping) ───────
// Mirrors the deal-level ConstituentIncluded pattern:
// each skill maps its internal components to canonical MDM addresses,
// enabling graph-walk analytics, cross-skill aggregation, and
// deterministic reconstruction of the skill's "bill of materials."

export interface SkillConstituentIncluded extends ConfigTx {
  eventType: 'SkillConstituentIncluded';
  payload: {
    /** Skill emitting the constituent mapping */
    skillId: string;
    /** Canonical RefData MDM address the constituent resolves to */
    constituentMdmAddress: string;
    /** Human-readable label (e.g., 'Day Count Convention', 'Book: 1 Enoch') */
    constituentLabel: string;
    /** Category for grouping (e.g., 'refdata', 'canon', 'protocol-field') */
    constituentCategory: 'refdata' | 'canon' | 'protocol-field' | 'ontology' | 'config' | 'custom';
    /** Optional parent constituent (for nested bill-of-materials) */
    parentConstituentAddress?: string;
    /** Whether this constituent is required or optional for the skill */
    cardinality: 'required' | 'optional' | 'repeating';
    /** Timestamp of inclusion */
    includedAt: string;
    /** Optional TX hash if anchored on-chain */
    anchorTxHash?: string;
  };
}

export interface SkillConstituentRemoved extends ConfigTx {
  eventType: 'SkillConstituentRemoved';
  payload: {
    skillId: string;
    constituentMdmAddress: string;
    removedAt: string;
    reason: string;
    /** Replacement address if superseded */
    supersededBy?: string;
  };
}

export interface SkillConstituent {
  /** Canonical MDM address */
  mdmAddress: string;
  /** Human label */
  label: string;
  /** Category */
  category: 'refdata' | 'canon' | 'protocol-field' | 'ontology' | 'config' | 'custom';
  /** Cardinality */
  cardinality: 'required' | 'optional' | 'repeating';
}

export interface SkillDependency {
  /** MDM address of the required skill */
  mdmAddress: string;
  /** Binding type */
  bindingType: 'requires' | 'composes' | 'enhances';
  /** Human label */
  label: string;
}

// ─── Offline TX Queue ──────────────────────────────────────────

export interface QueuedTransaction {
  id: string;
  /** Skill that generated this TX */
  skillId: string;
  /** TX type (e.g., 'notarize', 'royalty', 'provenance') */
  txType: string;
  /** Serialized TX payload */
  payload: Record<string, unknown>;
  /** When the TX was queued */
  queuedAt: string;
  /** Number of retry attempts */
  retryCount: number;
  /** Status */
  status: 'queued' | 'submitting' | 'confirmed' | 'failed';
  /** Chain of custody — for offline peer verification */
  chainletBlockHash?: string;
}
