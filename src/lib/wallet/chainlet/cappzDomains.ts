/**
 * CAPPZ Domain Definitions
 * 
 * Canonical domain configs for the cappz: HD domains.
 * Append-only registries — hdIndex is permanent, never reused.
 * 
 * Domain 0: WalletRoles                — role lifecycle (ARC, DARC)
 * Domain 1: ValidationErrors           — reusable by clients/partner pipelines
 * Domain 2: OperationalErrors          — internal function execution errors
 * Domain 3: FunctionsEvents            — functions + event types with causal correlation
 * Domain 4: Rules                      — on-chain validation rules
 * Domain 5: EndpointInterfaces         — parsed endpoint entity types
 * Domain 6: OperationalStatus          — WalletAgent runtime state
 * Domain 7: ContentLifecycleEventType  — source content lifecycle events
 * Domain 8: SourceContentType          — codex constituent structural types
 * Domain 9: SourceContentFormat        — MIME-aligned content format codes
 * Domain 10: ContentIngestMode         — ingestion lifecycle modes
 * Domain 11: LocalContentSerializationMode  — local wallet serialization (RAW/ENCRYPTED)
 * Domain 12: OnchainContentSerializationMode — on-chain serialization (RAW/ENCRYPTED)
 * Domain 13: ContentPublishTierMode          — publish tier (TIER_1_LCP/TIER_2_OCP)
 * Domain 14: EncryptionType                  — algorithm for ENCRYPTED serialization (BTC/XRP-aligned)
 * Domain 15: WalletTier                      — PTW / POW / UAW wallet tier typing (v11-5-1)
 * Domain 16: CommissionTypes                — EBB commission basis / structure / recoup / scope (v12-06)
 * Domain 17: EbbActivityTypes               — activity, basis and source vocabulary (v12-12)
 * Domain 18: EbbStreamTypes                 — revenue stream and recognition vocabulary (v12-12)
 * Domain 19: EbbPartyTypes                  — party, person and association vocabulary (v12-12)
 */

import type { CappzDomainConfig } from './CappzDataDomain';

// ─── Domain 0: WalletRoles ───

export const WALLET_ROLES_DOMAIN: CappzDomainConfig = {
  domainCode: 'WalletRoles',
  displayName: 'Wallet Functional Roles',
  hdDomainIndex: 0,
  description: 'Permanent HD-addressed wallet roles with TX-based lifecycle',
  extensible: false,
  values: [
    { code: 'ARC',  displayName: 'Agent Revenue Capture',             hdIndex: 0, category: 'revenue' },
    { code: 'DARC', displayName: 'Distributed Agent Revenue Capture', hdIndex: 1, category: 'revenue' },
  ],
} as const;

// ─── Domain 1: ValidationErrors (reusable across pipelines) ───

export const VALIDATION_ERRORS_DOMAIN: CappzDomainConfig = {
  domainCode: 'ValidationErrors',
  displayName: 'Validation Error Codes',
  hdDomainIndex: 1,
  description: 'Schema/structure, refdata, and rules validation errors — reusable by clients and partner extensions',
  extensible: true,
  values: [
    // Schema / structure validation
    { code: 'SCHEMA_INVALID',           displayName: 'Schema Validation Failed',          hdIndex: 0, category: 'schema' },
    { code: 'SCHEMA_FIELD_MISSING',     displayName: 'Required Field Missing',            hdIndex: 1, category: 'schema' },
    { code: 'SCHEMA_FIELD_TYPE',        displayName: 'Field Type Mismatch',               hdIndex: 2, category: 'schema' },
    { code: 'SCHEMA_FIELD_FORMAT',      displayName: 'Field Format Invalid',              hdIndex: 3, category: 'schema' },
    { code: 'SCHEMA_FIELD_LENGTH',      displayName: 'Field Length Out of Range',         hdIndex: 4, category: 'schema' },
    { code: 'SCHEMA_ENUM_VALUE',        displayName: 'Enum Value Not Permitted',          hdIndex: 5, category: 'schema' },

    // RefData validation
    { code: 'REFDATA_DOMAIN_NOT_FOUND',   displayName: 'RefData Domain Not Found',        hdIndex: 6,  category: 'refdata' },
    { code: 'REFDATA_VALUE_NOT_FOUND',    displayName: 'RefData Value Not Found',          hdIndex: 7,  category: 'refdata' },
    { code: 'REFDATA_VERSION_NOT_FOUND',  displayName: 'RefData Version Not Found',        hdIndex: 8,  category: 'refdata' },
    { code: 'REFDATA_MAPPING_NOT_FOUND',  displayName: 'RefData Mapping Not Found',        hdIndex: 9,  category: 'refdata' },
    { code: 'REFDATA_VALUE_DEPRECATED',   displayName: 'RefData Value Deprecated',         hdIndex: 10, category: 'refdata' },
    { code: 'REFDATA_VALUE_TERMINATED',   displayName: 'RefData Value Terminated',          hdIndex: 11, category: 'refdata' },

    // Rules validation
    { code: 'RULE_PREDICATE_FAILED',      displayName: 'Rule Predicate Evaluation Failed', hdIndex: 12, category: 'rules' },
    { code: 'RULE_DEPENDENCY_UNMET',      displayName: 'Cross-Field Dependency Unmet',     hdIndex: 13, category: 'rules' },
    { code: 'RULE_JSONLOGIC_ERROR',       displayName: 'JSONLogic Rule Execution Error',   hdIndex: 14, category: 'rules' },
    { code: 'RULE_TRIPLE_INVALID',        displayName: 'Triple Predicate Invalid',         hdIndex: 15, category: 'rules' },

    // HD derivation validation
    { code: 'HD_PATH_INVALID',            displayName: 'HD Derivation Path Invalid',       hdIndex: 16, category: 'derivation' },
    { code: 'HD_INDEX_NEGATIVE',          displayName: 'HD Index Must Be Non-Negative',    hdIndex: 17, category: 'derivation' },
    { code: 'HD_ADDRESS_COLLISION',       displayName: 'HD Address Collision Detected',    hdIndex: 18, category: 'derivation' },
  ],
} as const;

// ─── Domain 2: OperationalErrors (internal function execution) ───

export const OPERATIONAL_ERRORS_DOMAIN: CappzDomainConfig = {
  domainCode: 'OperationalErrors',
  displayName: 'Operational Error Codes',
  hdDomainIndex: 2,
  description: 'Errors during function execution, TX processing, and wallet operations',
  extensible: false,
  values: [
    // Role TX errors
    { code: 'ROLE_TX_FAILED',            displayName: 'Role Transaction Failed',           hdIndex: 0, category: 'role' },
    { code: 'ROLE_ALREADY_ACTIVE',       displayName: 'Role Already Active',               hdIndex: 1, category: 'role' },
    { code: 'ROLE_NOT_ACTIVE',           displayName: 'Role Not Currently Active',         hdIndex: 2, category: 'role' },
    { code: 'ROLE_SENTINEL_ASSIGN',      displayName: 'Cannot Assign Sentinel Role',       hdIndex: 3, category: 'role' },

    // Wallet group errors
    { code: 'WALLET_GROUP_NOT_FOUND',    displayName: 'Wallet Group Not Found',            hdIndex: 4, category: 'wallet' },
    { code: 'WALLET_GROUP_DUPLICATE',    displayName: 'Wallet Group Already Exists',       hdIndex: 5, category: 'wallet' },
    { code: 'WALLET_NOT_CONNECTED',      displayName: 'Wallet Not Connected',              hdIndex: 6, category: 'wallet' },
    { code: 'WALLET_SYNC_FAILED',        displayName: 'Wallet Sync Failed',                hdIndex: 7, category: 'wallet' },

    // TX processing errors
    { code: 'TX_SIGN_FAILED',            displayName: 'Transaction Signing Failed',        hdIndex: 8,  category: 'tx' },
    { code: 'TX_SUBMIT_FAILED',          displayName: 'Transaction Submission Failed',     hdIndex: 9,  category: 'tx' },
    { code: 'TX_TIMEOUT',                displayName: 'Transaction Timeout',               hdIndex: 10, category: 'tx' },
    { code: 'TX_REBLOCK_FAILED',         displayName: 'Reblocking Failed',                 hdIndex: 11, category: 'tx' },

    // Domain registry errors
    { code: 'DOMAIN_ALREADY_REGISTERED', displayName: 'Domain Already Registered',         hdIndex: 12, category: 'registry' },
    { code: 'DOMAIN_REGISTRATION_FAILED',displayName: 'Domain Registration Failed',        hdIndex: 13, category: 'registry' },
    { code: 'DOMAIN_TX_CREATE_FAILED',   displayName: 'Domain TX Creation Failed',         hdIndex: 14, category: 'registry' },
    { code: 'DOMAIN_TX_DEPRECATE_FAILED',displayName: 'Domain TX Deprecation Failed',      hdIndex: 15, category: 'registry' },

    // Cross-chain errors
    { code: 'XCHAIN_BRIDGE_FAILED',      displayName: 'Cross-Chain Bridge Failed',         hdIndex: 16, category: 'xchain' },
    { code: 'XCHAIN_TIMEOUT',            displayName: 'Cross-Chain Transfer Timeout',      hdIndex: 17, category: 'xchain' },

    // Dual-sig errors
    { code: 'DUALSIG_INCOMPLETE',        displayName: 'Dual Signature Incomplete',         hdIndex: 18, category: 'dualsig' },
    { code: 'DUALSIG_MISMATCH',          displayName: 'Dual Signature Mismatch',           hdIndex: 19, category: 'dualsig' },
  ],
} as const;

// ─── Domain 3: FunctionsEvents (functions + event types with causal correlation) ───

export const FUNCTIONS_EVENTS_DOMAIN: CappzDomainConfig = {
  domainCode: 'FunctionsEvents',
  displayName: 'Functions & Event Types',
  hdDomainIndex: 3,
  description: 'HD-addressed functions and event types. Transactions correlate causal-event → function → resultant-event.',
  extensible: true,
  values: [
    // ── Functions (hdIndex 0–23) ──

    // Role management functions
    { code: 'addWalletRole',             displayName: 'Add Wallet Role',                   hdIndex: 0,  category: 'function:role-mgmt' },
    { code: 'removeWalletRole',          displayName: 'Remove Wallet Role',                hdIndex: 1,  category: 'function:role-mgmt' },
    { code: 'hasRole',                   displayName: 'Check Role Active',                 hdIndex: 2,  category: 'function:role-mgmt' },
    { code: 'getRoles',                  displayName: 'Get Active Roles',                  hdIndex: 3,  category: 'function:role-mgmt' },

    // RefData resolution functions
    { code: 'resolveRoleAddress',        displayName: 'Resolve Role HD Address',           hdIndex: 4,  category: 'function:resolution' },
    { code: 'resolveRoleCode',           displayName: 'Resolve Role Code from Address',    hdIndex: 5,  category: 'function:resolution' },
    { code: 'resolveAddress',            displayName: 'Resolve Domain Value Address',      hdIndex: 6,  category: 'function:resolution' },
    { code: 'resolveValue',              displayName: 'Resolve Domain Value',              hdIndex: 7,  category: 'function:resolution' },
    { code: 'resolveByAddress',          displayName: 'Reverse-Resolve by HD Address',     hdIndex: 8,  category: 'function:resolution' },

    // Domain engine functions
    { code: 'createDomain',              displayName: 'Create RefData Domain',             hdIndex: 9,  category: 'function:domain-engine' },
    { code: 'createValue',               displayName: 'Create RefData Value',              hdIndex: 10, category: 'function:domain-engine' },
    { code: 'createVersion',             displayName: 'Create RefData Version',            hdIndex: 11, category: 'function:domain-engine' },
    { code: 'createValueMapping',        displayName: 'Create Cross-Standard Mapping',     hdIndex: 12, category: 'function:domain-engine' },

    // TX lifecycle functions
    { code: 'createValueTx',             displayName: 'Create Domain Value TX',            hdIndex: 13, category: 'function:tx-lifecycle' },
    { code: 'createDeprecationTx',       displayName: 'Create Deprecation TX',             hdIndex: 14, category: 'function:tx-lifecycle' },
    { code: 'createReblock',             displayName: 'Create Reblock',                    hdIndex: 15, category: 'function:tx-lifecycle' },

    // Wallet management functions
    { code: 'connect',                   displayName: 'Connect Wallet',                    hdIndex: 16, category: 'function:wallet-mgmt' },
    { code: 'disconnect',               displayName: 'Disconnect Wallet',                  hdIndex: 17, category: 'function:wallet-mgmt' },
    { code: 'signTransaction',          displayName: 'Sign Transaction',                   hdIndex: 18, category: 'function:wallet-mgmt' },
    { code: 'submitTransaction',        displayName: 'Submit Transaction',                 hdIndex: 19, category: 'function:wallet-mgmt' },

    // Cache lookup functions
    { code: 'lookupTxByMsgId',          displayName: 'Lookup TX by MsgId',                 hdIndex: 20, category: 'function:cache' },
    { code: 'lookupTxByCode',           displayName: 'Lookup TX by RefData Code',           hdIndex: 21, category: 'function:cache' },
    { code: 'lookupTxByHash',           displayName: 'Lookup TX by SHA Hash',               hdIndex: 22, category: 'function:cache' },
    { code: 'lookupTxByTargetAddress',  displayName: 'Lookup TX by Target Address',         hdIndex: 23, category: 'function:cache' },

    // ── Event Types — Governance (hdIndex 24–26) ──
    { code: 'EVT_PROPOSED',             displayName: 'Proposed',                            hdIndex: 24, category: 'event:governance' },
    { code: 'EVT_REJECTED',             displayName: 'Rejected',                            hdIndex: 25, category: 'event:governance' },
    { code: 'EVT_COTARatified',         displayName: 'COTA Ratified',                       hdIndex: 26, category: 'event:governance' },

    // ── Event Types — Lifecycle / T&C (hdIndex 27–33) ──
    { code: 'EVT_CREATED',              displayName: 'Created',                             hdIndex: 27, category: 'event:lifecycle' },
    { code: 'EVT_AMENDED',              displayName: 'Amended',                             hdIndex: 28, category: 'event:lifecycle' },
    { code: 'EVT_CANCELLED',            displayName: 'Cancelled',                           hdIndex: 29, category: 'event:lifecycle' },
    { code: 'EVT_TERMINATED',           displayName: 'Terminated',                          hdIndex: 30, category: 'event:lifecycle' },
    { code: 'EVT_PARTIALLY_TERMINATED', displayName: 'Partially Terminated',                hdIndex: 31, category: 'event:lifecycle' },
    { code: 'EVT_NOVATED',              displayName: 'Novated',                             hdIndex: 32, category: 'event:lifecycle' },
    { code: 'EVT_MATURED',              displayName: 'Matured',                             hdIndex: 33, category: 'event:lifecycle' },

    // ── Event Types — Operational / Non-T&C (hdIndex 34–36) ──
    { code: 'EVT_INCREASED',            displayName: 'Increased',                           hdIndex: 34, category: 'event:operational' },
    { code: 'EVT_DECREASED',            displayName: 'Decreased',                           hdIndex: 35, category: 'event:operational' },
    { code: 'EVT_DEACTIVATED',          displayName: 'Deactivated',                         hdIndex: 36, category: 'event:operational' },

    // ── Event Types — DataDomain (hdIndex 37–42) ──
    { code: 'EVT_DataDomainCreated',            displayName: 'DataDomain Created',           hdIndex: 37, category: 'event:datadomain' },
    { code: 'EVT_DataDomainDeprecated',         displayName: 'DataDomain Deprecated',        hdIndex: 38, category: 'event:datadomain' },
    { code: 'EVT_DataDomainValueCreated',       displayName: 'DataDomain Value Created',     hdIndex: 39, category: 'event:datadomain' },
    { code: 'EVT_DataDomainValueDeprecated',    displayName: 'DataDomain Value Deprecated',  hdIndex: 40, category: 'event:datadomain' },
    { code: 'EVT_DataDomainValueRefCreated',    displayName: 'DataDomain ValueRef Created',  hdIndex: 41, category: 'event:datadomain' },
    { code: 'EVT_DataDomainValueRefDeprecated', displayName: 'DataDomain ValueRef Deprecated', hdIndex: 42, category: 'event:datadomain' },

    // ── Event Types — WalletRole (hdIndex 43–44) ──
    { code: 'EVT_WalletRoleCreated',    displayName: 'Wallet Role Created',                 hdIndex: 43, category: 'event:walletrole' },
    { code: 'EVT_WalletRoleDeprecated', displayName: 'Wallet Role Deprecated',              hdIndex: 44, category: 'event:walletrole' },

    // ── Event Types — DARC Contract (hdIndex 45–49) ──
    { code: 'EVT_DARCContractCreated',     displayName: 'DARC Contract Created',             hdIndex: 45, category: 'event:darc' },
    { code: 'EVT_DARCContractActivated',   displayName: 'DARC Contract Activated',           hdIndex: 46, category: 'event:darc' },
    { code: 'EVT_DARCContractAmended',     displayName: 'DARC Contract Amended',             hdIndex: 47, category: 'event:darc' },
    { code: 'EVT_DARCContractDeactivated', displayName: 'DARC Contract Deactivated',         hdIndex: 48, category: 'event:darc' },
    { code: 'EVT_DARCContractTerminated',  displayName: 'DARC Contract Terminated',          hdIndex: 49, category: 'event:darc' },

    // ── Event Types — WAS Signals (hdIndex 50–56) ──
    { code: 'EVT_ARCActivated',         displayName: 'ARC Activated',                        hdIndex: 50, category: 'event:was' },
    { code: 'EVT_ARCDeprecated',        displayName: 'ARC Deprecated',                       hdIndex: 51, category: 'event:was' },
    { code: 'EVT_ARCReplaced',          displayName: 'ARC Replaced',                         hdIndex: 52, category: 'event:was' },
    { code: 'EVT_DARCPcnt',             displayName: 'DARC Percentage Split',                hdIndex: 53, category: 'event:was' },
    { code: 'EVT_DARCAmt',              displayName: 'DARC Absolute Split',                  hdIndex: 54, category: 'event:was' },
    { code: 'EVT_DARCActivated',        displayName: 'DARC Activated',                       hdIndex: 55, category: 'event:was' },
    { code: 'EVT_DARCDeprecated',       displayName: 'DARC Deprecated',                      hdIndex: 56, category: 'event:was' },

    // ── Event Types — Function Invocation (hdIndex 57) ──
    { code: 'EVT_FunctionInvoked',      displayName: 'Function Invoked (causal correlation)', hdIndex: 57, category: 'event:invocation' },

    // ── Event Types — WalletAgent Configuration: Notarization (hdIndex 58–61) ──
    { code: 'EVT_NotarizeEachOnSaveCreated',     displayName: 'NotarizeEach OnSave Created',      hdIndex: 58, category: 'event:config:notarization' },
    { code: 'EVT_NotarizeEachOnSaveDeprecated',  displayName: 'NotarizeEach OnSave Deprecated',   hdIndex: 59, category: 'event:config:notarization' },
    { code: 'EVT_NotarizeAllOnSaveCreated',      displayName: 'NotarizeAll OnSave Created',       hdIndex: 60, category: 'event:config:notarization' },
    { code: 'EVT_NotarizeAllOnSaveDeprecated',   displayName: 'NotarizeAll OnSave Deprecated',    hdIndex: 61, category: 'event:config:notarization' },

    // ── Event Types — WalletAgent Configuration: A2A (hdIndex 62–67) ──
    { code: 'EVT_A2ATransceiverCreated',         displayName: 'A2A Transceiver Created',          hdIndex: 62, category: 'event:config:a2a' },
    { code: 'EVT_A2ATransceiverDeprecated',      displayName: 'A2A Transceiver Deprecated',       hdIndex: 63, category: 'event:config:a2a' },
    { code: 'EVT_A2AReceiverCreated',            displayName: 'A2A Receiver Created',             hdIndex: 64, category: 'event:config:a2a' },
    { code: 'EVT_A2AReceiverDeprecated',         displayName: 'A2A Receiver Deprecated',          hdIndex: 65, category: 'event:config:a2a' },
    { code: 'EVT_A2ATransmitterCreated',         displayName: 'A2A Transmitter Created',          hdIndex: 66, category: 'event:config:a2a' },
    { code: 'EVT_A2ATransmitterDeprecated',      displayName: 'A2A Transmitter Deprecated',       hdIndex: 67, category: 'event:config:a2a' },

    // ── Event Types — WalletAgent Configuration: Synchronize (hdIndex 68–71) ──
    { code: 'EVT_SynchronizeEachOnSaveCreated',    displayName: 'SynchronizeEach OnSave Created',   hdIndex: 68, category: 'event:config:synchronize' },
    { code: 'EVT_SynchronizeEachOnSaveDeprecated', displayName: 'SynchronizeEach OnSave Deprecated', hdIndex: 69, category: 'event:config:synchronize' },
    { code: 'EVT_SynchronizeAllOnSaveCreated',     displayName: 'SynchronizeAll OnSave Created',    hdIndex: 70, category: 'event:config:synchronize' },
    { code: 'EVT_SynchronizeAllOnSaveDeprecated',  displayName: 'SynchronizeAll OnSave Deprecated', hdIndex: 71, category: 'event:config:synchronize' },

    // ── Event Types — WalletAgent Configuration: Encryption (hdIndex 72–75) ──
    { code: 'EVT_EncryptAtRestCreated',            displayName: 'EncryptAtRest Created',            hdIndex: 72, category: 'event:config:encryption' },
    { code: 'EVT_EncryptAtRestDeprecated',         displayName: 'EncryptAtRest Deprecated',         hdIndex: 73, category: 'event:config:encryption' },
    { code: 'EVT_EncryptInTransitCreated',         displayName: 'EncryptInTransit Created',         hdIndex: 74, category: 'event:config:encryption' },
    { code: 'EVT_EncryptInTransitDeprecated',      displayName: 'EncryptInTransit Deprecated',      hdIndex: 75, category: 'event:config:encryption' },

    // ── Event Types — WalletAgent Configuration: Retention (hdIndex 76–79) ──
    { code: 'EVT_RetentionPruneOnWindowCreated',   displayName: 'Retention PruneOnWindow Created',  hdIndex: 76, category: 'event:config:retention' },
    { code: 'EVT_RetentionPruneOnWindowDeprecated',displayName: 'Retention PruneOnWindow Deprecated', hdIndex: 77, category: 'event:config:retention' },
    { code: 'EVT_RetentionArchiveOnSaveCreated',   displayName: 'Retention ArchiveOnSave Created',  hdIndex: 78, category: 'event:config:retention' },
    { code: 'EVT_RetentionArchiveOnSaveDeprecated',displayName: 'Retention ArchiveOnSave Deprecated', hdIndex: 79, category: 'event:config:retention' },

    // ── Event Types — WalletAgent Configuration: Compression (hdIndex 80–81) ──
    { code: 'EVT_CompressionOnSaveCreated',        displayName: 'Compression OnSave Created',      hdIndex: 80, category: 'event:config:compression' },
    { code: 'EVT_CompressionOnSaveDeprecated',     displayName: 'Compression OnSave Deprecated',   hdIndex: 81, category: 'event:config:compression' },

    // ── Event Types — WalletAgent Configuration: Hibernation (hdIndex 82–83) ──
    { code: 'EVT_HibernationAutoCreated',          displayName: 'Hibernation Auto Created',        hdIndex: 82, category: 'event:config:hibernation' },
    { code: 'EVT_HibernationAutoDeprecated',       displayName: 'Hibernation Auto Deprecated',     hdIndex: 83, category: 'event:config:hibernation' },

    // ── Event Types — WalletAgent Configuration: Fee Tier (hdIndex 84–85) ──
    { code: 'EVT_FeeTierOverrideCreated',          displayName: 'Fee Tier Override Created',       hdIndex: 84, category: 'event:config:feetier' },
    { code: 'EVT_FeeTierOverrideDeprecated',       displayName: 'Fee Tier Override Deprecated',    hdIndex: 85, category: 'event:config:feetier' },

    // ── Event Types — WalletAgent Configuration: Provenance (hdIndex 86–87) ──
    { code: 'EVT_ProvenanceTrackingCreated',       displayName: 'Provenance Tracking Created',     hdIndex: 86, category: 'event:config:provenance' },
    { code: 'EVT_ProvenanceTrackingDeprecated',    displayName: 'Provenance Tracking Deprecated',  hdIndex: 87, category: 'event:config:provenance' },

    // ── Event Types — MDM Binding (hdIndex 88–89) ──
    { code: 'EVT_MDMBindingCreated',               displayName: 'MDM Binding Created',             hdIndex: 88, category: 'event:config:mdm' },
    { code: 'EVT_MDMBindingDeprecated',            displayName: 'MDM Binding Deprecated',          hdIndex: 89, category: 'event:config:mdm' },

    // ── Event Types — Context Lifecycle (hdIndex 90–91) ──
    { code: 'EVT_ContextCreated',                  displayName: 'Context Created',                 hdIndex: 90, category: 'event:context' },
    { code: 'EVT_ContextAmended',                  displayName: 'Context Amended',                 hdIndex: 91, category: 'event:context' },
  ],
} as const;

/** @deprecated Use FUNCTIONS_EVENTS_DOMAIN */
export const FUNCTIONS_DOMAIN = FUNCTIONS_EVENTS_DOMAIN;

// ─── Domain 4: Rules (on-chain validation rule registry) ───

export const RULES_DOMAIN: CappzDomainConfig = {
  domainCode: 'Rules',
  displayName: 'On-Chain Validation Rules',
  hdDomainIndex: 4,
  description: 'Lifecycle-managed validation rules — triples, JSONLogic, cross-field dependencies — all HD-addressed and auditable',
  extensible: true,
  values: [
    // Schema / structure rules
    { code: 'RULE_FIELD_REQUIRED',          displayName: 'Field Required Rule',                hdIndex: 0,  category: 'schema' },
    { code: 'RULE_FIELD_TYPE_CHECK',        displayName: 'Field Type Check Rule',              hdIndex: 1,  category: 'schema' },
    { code: 'RULE_FIELD_FORMAT_REGEX',      displayName: 'Field Format Regex Rule',            hdIndex: 2,  category: 'schema' },
    { code: 'RULE_FIELD_LENGTH_RANGE',      displayName: 'Field Length Range Rule',            hdIndex: 3,  category: 'schema' },
    { code: 'RULE_FIELD_ENUM_MEMBERSHIP',   displayName: 'Field Enum Membership Rule',        hdIndex: 4,  category: 'schema' },
    { code: 'RULE_STRUCTURE_DEPTH',         displayName: 'Structure Depth Limit Rule',         hdIndex: 5,  category: 'schema' },

    // RefData validation rules
    { code: 'RULE_REFDATA_DOMAIN_EXISTS',   displayName: 'RefData Domain Exists Rule',        hdIndex: 6,  category: 'refdata' },
    { code: 'RULE_REFDATA_VALUE_ACTIVE',    displayName: 'RefData Value Active Rule',          hdIndex: 7,  category: 'refdata' },
    { code: 'RULE_REFDATA_VERSION_CURRENT', displayName: 'RefData Version Current Rule',       hdIndex: 8,  category: 'refdata' },
    { code: 'RULE_REFDATA_MAPPING_VALID',   displayName: 'RefData Mapping Valid Rule',         hdIndex: 9,  category: 'refdata' },
    { code: 'RULE_REFDATA_NOT_DEPRECATED',  displayName: 'RefData Not Deprecated Rule',       hdIndex: 10, category: 'refdata' },

    // Cross-field dependency rules
    { code: 'RULE_CROSS_FIELD_IF_THEN',     displayName: 'Cross-Field If-Then Rule',           hdIndex: 11, category: 'cross-field' },
    { code: 'RULE_CROSS_FIELD_MUTUAL_EX',   displayName: 'Cross-Field Mutual Exclusion Rule', hdIndex: 12, category: 'cross-field' },
    { code: 'RULE_CROSS_FIELD_COEXIST',     displayName: 'Cross-Field Co-Existence Rule',     hdIndex: 13, category: 'cross-field' },
    { code: 'RULE_CROSS_FIELD_SUM_CHECK',   displayName: 'Cross-Field Sum Check Rule',        hdIndex: 14, category: 'cross-field' },

    // Triple-based predicate rules
    { code: 'RULE_TRIPLE_SUBJECT_EXISTS',   displayName: 'Triple Subject Exists Rule',        hdIndex: 15, category: 'triple' },
    { code: 'RULE_TRIPLE_PREDICATE_VALID',  displayName: 'Triple Predicate Valid Rule',        hdIndex: 16, category: 'triple' },
    { code: 'RULE_TRIPLE_OBJECT_RESOLVABLE',displayName: 'Triple Object Resolvable Rule',     hdIndex: 17, category: 'triple' },
    { code: 'RULE_TRIPLE_CARDINALITY',      displayName: 'Triple Cardinality Constraint Rule', hdIndex: 18, category: 'triple' },

    // JSONLogic composite rules
    { code: 'RULE_JSONLOGIC_AND',           displayName: 'JSONLogic AND Composite Rule',       hdIndex: 19, category: 'jsonlogic' },
    { code: 'RULE_JSONLOGIC_OR',            displayName: 'JSONLogic OR Composite Rule',        hdIndex: 20, category: 'jsonlogic' },
    { code: 'RULE_JSONLOGIC_IF',            displayName: 'JSONLogic IF Conditional Rule',      hdIndex: 21, category: 'jsonlogic' },
    { code: 'RULE_JSONLOGIC_COMPARISON',    displayName: 'JSONLogic Comparison Rule',          hdIndex: 22, category: 'jsonlogic' },
    { code: 'RULE_JSONLOGIC_ARITHMETIC',    displayName: 'JSONLogic Arithmetic Rule',          hdIndex: 23, category: 'jsonlogic' },

    // Lifecycle / temporal rules
    { code: 'RULE_TEMPORAL_NOT_EXPIRED',    displayName: 'Temporal Not Expired Rule',          hdIndex: 24, category: 'temporal' },
    { code: 'RULE_TEMPORAL_EFFECTIVE_DATE', displayName: 'Temporal Effective Date Rule',       hdIndex: 25, category: 'temporal' },
    { code: 'RULE_TEMPORAL_SEQUENCE',       displayName: 'Temporal Sequence Order Rule',       hdIndex: 26, category: 'temporal' },

    // Governance / authority rules
    { code: 'RULE_AUTH_ROLE_REQUIRED',      displayName: 'Authority Role Required Rule',       hdIndex: 27, category: 'governance' },
    { code: 'RULE_AUTH_DUAL_SIG',           displayName: 'Authority Dual Signature Rule',      hdIndex: 28, category: 'governance' },
    { code: 'RULE_AUTH_QUORUM',             displayName: 'Authority Quorum Threshold Rule',    hdIndex: 29, category: 'governance' },
  ],
} as const;

// ─── Domain 5: EndpointInterfaces (ingested interface definitions) ───

export const ENDPOINT_INTERFACES_DOMAIN: CappzDomainConfig = {
  domainCode: 'EndpointInterfaces',
  displayName: 'Endpoint Interface Definitions',
  hdDomainIndex: 5,
  description: 'HD-addressed interface definition formats, parsed endpoint configs, and ingestion lifecycle events',
  extensible: true,
  values: [
    // ── Interface Format Standards (hdIndex 0–6) ──
    { code: 'FMT_OPENAPI',        displayName: 'OpenAPI / Swagger',           hdIndex: 0,  category: 'format:api' },
    { code: 'FMT_WSDL',           displayName: 'WSDL / WS-*',                hdIndex: 1,  category: 'format:api' },
    { code: 'FMT_GRAPHQL',        displayName: 'GraphQL SDL',                 hdIndex: 2,  category: 'format:api' },
    { code: 'FMT_PROTOBUF',       displayName: 'Protocol Buffers / gRPC',     hdIndex: 3,  category: 'format:api' },
    { code: 'FMT_JSONSCHEMA',     displayName: 'JSON Schema',                 hdIndex: 4,  category: 'format:schema' },
    { code: 'FMT_ASYNCAPI',       displayName: 'AsyncAPI',                    hdIndex: 5,  category: 'format:api' },
    { code: 'FMT_RAML',           displayName: 'RAML',                        hdIndex: 6,  category: 'format:api' },

    // ── Code Language Interfaces (hdIndex 7–10) ──
    { code: 'LANG_TYPESCRIPT',    displayName: 'TypeScript Interfaces',       hdIndex: 7,  category: 'format:code' },
    { code: 'LANG_JAVA',          displayName: 'Java Interfaces',             hdIndex: 8,  category: 'format:code' },
    { code: 'LANG_CSHARP',        displayName: 'C# Interfaces',               hdIndex: 9,  category: 'format:code' },
    { code: 'LANG_PYTHON',        displayName: 'Python Type Stubs',           hdIndex: 10, category: 'format:code' },

    // ── UML / Modeling (hdIndex 11–14) ──
    { code: 'MDL_PLANTUML',       displayName: 'PlantUML',                    hdIndex: 11, category: 'format:model' },
    { code: 'MDL_MERMAID',        displayName: 'Mermaid Diagram',             hdIndex: 12, category: 'format:model' },
    { code: 'MDL_XMI',            displayName: 'XMI / UML Exchange',          hdIndex: 13, category: 'format:model' },
    { code: 'MDL_ARCHIMATE',      displayName: 'ArchiMate',                   hdIndex: 14, category: 'format:model' },

    // ── Process / Ontology (hdIndex 15–18) ──
    { code: 'PROC_BPMN',          displayName: 'BPMN',                        hdIndex: 15, category: 'format:process' },
    { code: 'PROC_BPEL',          displayName: 'BPEL',                        hdIndex: 16, category: 'format:process' },
    { code: 'ONT_OWL',            displayName: 'OWL Ontology',                hdIndex: 17, category: 'format:ontology' },
    { code: 'ONT_RDF',            displayName: 'RDF Schema',                  hdIndex: 18, category: 'format:ontology' },

    // ── Ingestion Functions (hdIndex 19–24) ──
    { code: 'ingestEndpoint',     displayName: 'Ingest Endpoint Definition',  hdIndex: 19, category: 'function:ingestion' },
    { code: 'parseInterface',     displayName: 'Parse Interface Definition',  hdIndex: 20, category: 'function:ingestion' },
    { code: 'detectFormat',       displayName: 'Auto-Detect Format',          hdIndex: 21, category: 'function:ingestion' },
    { code: 'validateInterface',  displayName: 'Validate Interface Schema',   hdIndex: 22, category: 'function:ingestion' },
    { code: 'registerEndpoint',   displayName: 'Register Parsed Endpoint',    hdIndex: 23, category: 'function:ingestion' },
    { code: 'bindToAdapter',      displayName: 'Bind to Platform Adapter',    hdIndex: 24, category: 'function:ingestion' },

    // ── Generation Functions (hdIndex 25–28) ──
    { code: 'generateInterface',  displayName: 'Generate Interface Definition', hdIndex: 25, category: 'function:generation' },
    { code: 'generateClient',     displayName: 'Generate Client Stub',          hdIndex: 26, category: 'function:generation' },
    { code: 'generateServer',     displayName: 'Generate Server Skeleton',      hdIndex: 27, category: 'function:generation' },
    { code: 'generateDocs',       displayName: 'Generate Documentation',        hdIndex: 28, category: 'function:generation' },

    // ── Ingestion Events (hdIndex 29–36) ──
    { code: 'EVT_EndpointIngested',     displayName: 'Endpoint Ingested',              hdIndex: 29, category: 'event:ingestion' },
    { code: 'EVT_InterfaceParsed',      displayName: 'Interface Parsed',               hdIndex: 30, category: 'event:ingestion' },
    { code: 'EVT_FormatDetected',       displayName: 'Format Auto-Detected',           hdIndex: 31, category: 'event:ingestion' },
    { code: 'EVT_InterfaceValidated',   displayName: 'Interface Validated',            hdIndex: 32, category: 'event:ingestion' },
    { code: 'EVT_EndpointRegistered',   displayName: 'Endpoint Registered',            hdIndex: 33, category: 'event:ingestion' },
    { code: 'EVT_AdapterBound',         displayName: 'Adapter Bound',                  hdIndex: 34, category: 'event:ingestion' },
    { code: 'EVT_IngestionFailed',      displayName: 'Ingestion Failed',               hdIndex: 35, category: 'event:ingestion' },
    { code: 'EVT_InterfaceDeprecated',  displayName: 'Interface Deprecated',           hdIndex: 36, category: 'event:ingestion' },

    // ── Generation Events (hdIndex 37–40) ──
    { code: 'EVT_InterfaceGenerated',   displayName: 'Interface Generated',            hdIndex: 37, category: 'event:generation' },
    { code: 'EVT_ClientGenerated',      displayName: 'Client Stub Generated',          hdIndex: 38, category: 'event:generation' },
    { code: 'EVT_ServerGenerated',      displayName: 'Server Skeleton Generated',      hdIndex: 39, category: 'event:generation' },
    { code: 'EVT_GenerationFailed',     displayName: 'Generation Failed',              hdIndex: 40, category: 'event:generation' },

    // ── Parsed Endpoint Entity Types (hdIndex 41–46) ──
    { code: 'ENT_OPERATION',      displayName: 'Parsed Operation/Method',     hdIndex: 41, category: 'entity:endpoint' },
    { code: 'ENT_PARAMETER',      displayName: 'Parsed Parameter',            hdIndex: 42, category: 'entity:endpoint' },
    { code: 'ENT_RESPONSE',       displayName: 'Parsed Response Schema',      hdIndex: 43, category: 'entity:endpoint' },
    { code: 'ENT_REQUEST_BODY',   displayName: 'Parsed Request Body',         hdIndex: 44, category: 'entity:endpoint' },
    { code: 'ENT_DATA_TYPE',      displayName: 'Parsed Data Type/Model',      hdIndex: 45, category: 'entity:endpoint' },
    { code: 'ENT_SERVICE',        displayName: 'Parsed Service Binding',      hdIndex: 46, category: 'entity:endpoint' },
  ],
} as const;

// ─── Domain 6: OperationalStatus (WalletAgent runtime state) ───

export const OPERATIONAL_STATUS_DOMAIN: CappzDomainConfig = {
  domainCode: 'OperationalStatus',
  displayName: 'WalletAgent Operational Status',
  hdDomainIndex: 6,
  description: 'MDM-addressed operational states for WalletAgent instances. Resolved via fetchOperationalStatus() — no boolean flags.',
  extensible: false,
  values: [
    { code: 'SANDBOX',      displayName: 'Sandbox (No Active Config)',  hdIndex: 0, category: 'status' },
    { code: 'OPERATIONAL',  displayName: 'Operational (Config Active)', hdIndex: 1, category: 'status' },
    { code: 'HIBERNATED',   displayName: 'Hibernated (Suspended)',      hdIndex: 2, category: 'status' },
  ],
} as const;

// ─── Domain 7: ContentLifecycleEventType ───

export const CONTENT_LIFECYCLE_EVENTS_DOMAIN: CappzDomainConfig = {
  domainCode: 'ContentLifecycleEventType',
  displayName: 'Content Lifecycle Event Types',
  hdDomainIndex: 7,
  description: 'Canonical event types for source content lifecycle — storage, notarization, verification, ingestion, and rejection',
  extensible: true,
  values: [
    // Source lifecycle events (hdIndex 0–4)
    { code: 'SourceContentStored',              displayName: 'Source Content Stored',              hdIndex: 0, category: 'lifecycle:source' },
    { code: 'SourceContentNotarized',           displayName: 'Source Content Notarized',           hdIndex: 1, category: 'lifecycle:source' },
    { code: 'SourceContentFidelityVerified',    displayName: 'Source Content Fidelity Verified',   hdIndex: 2, category: 'lifecycle:source' },
    { code: 'SourceContentAmended',             displayName: 'Source Content Amended',             hdIndex: 3, category: 'lifecycle:source' },
    { code: 'SourceContentDeprecated',          displayName: 'Source Content Deprecated',          hdIndex: 4, category: 'lifecycle:source' },

    // Ingest lifecycle events (hdIndex 5–8)
    { code: 'SourceContentIngested',            displayName: 'Source Content Ingested',            hdIndex: 5, category: 'lifecycle:ingest' },
    { code: 'SourceContentProcessed',           displayName: 'Source Content Processed',           hdIndex: 6, category: 'lifecycle:ingest' },
    { code: 'SourceContentParsed',              displayName: 'Source Content Parsed',              hdIndex: 7, category: 'lifecycle:ingest' },
    { code: 'SourceContentIngestRejected',      displayName: 'Source Content Ingest Rejected',     hdIndex: 8, category: 'lifecycle:ingest' },
  ],
} as const;

// ─── Domain 8: SourceContentType (codex constituent structural types) ───

export const SOURCE_CONTENT_TYPE_DOMAIN: CappzDomainConfig = {
  domainCode: 'SourceContentType',
  displayName: 'Source Content Type',
  hdDomainIndex: 8,
  description: 'Codex constituent structural types — determines which ingestion BPMN to invoke',
  extensible: true,
  values: [
    { code: 'CODEX_CANON',    displayName: 'Codex Canon (Book→Chapter→Verse)',       hdIndex: 0, category: 'codex' },
    { code: 'CODEX_SCROLL',   displayName: 'Codex Scroll (Scroll→Section→Fragment)', hdIndex: 1, category: 'codex' },
    { code: 'CODEX_TRACTATE', displayName: 'Codex Tractate (Codex→Tractate→Section)', hdIndex: 2, category: 'codex' },
  ],
} as const;

// ─── Domain 9: SourceContentFormat (MIME-aligned format codes) ───

export const SOURCE_CONTENT_FORMAT_DOMAIN: CappzDomainConfig = {
  domainCode: 'SourceContentFormat',
  displayName: 'Source Content Format',
  hdDomainIndex: 9,
  description: 'MIME-aligned content format codes for ingestion pipeline routing',
  extensible: true,
  values: [
    { code: 'TEXT_PLAIN',       displayName: 'Plain Text (text/plain)',             hdIndex: 0, category: 'text' },
    { code: 'TEXT_XML',         displayName: 'XML (text/xml)',                       hdIndex: 1, category: 'text' },
    { code: 'TEXT_JSON',        displayName: 'JSON (application/json)',              hdIndex: 2, category: 'text' },
    { code: 'TEXT_CSV',         displayName: 'CSV (text/csv)',                       hdIndex: 3, category: 'text' },
    { code: 'APPLICATION_PDF',  displayName: 'PDF (application/pdf)',               hdIndex: 4, category: 'document' },
    { code: 'IMAGE_PNG',        displayName: 'PNG (image/png)',                     hdIndex: 5, category: 'image' },
    { code: 'IMAGE_JPEG',       displayName: 'JPEG (image/jpeg)',                   hdIndex: 6, category: 'image' },
    { code: 'AUDIO_MP3',        displayName: 'MP3 (audio/mpeg)',                    hdIndex: 7, category: 'audio' },
    { code: 'VIDEO_MP4',        displayName: 'MP4 (video/mp4)',                     hdIndex: 8, category: 'video' },
    { code: 'APPLICATION_XBRL', displayName: 'XBRL (application/xbrl+xml)',         hdIndex: 9, category: 'financial' },
  ],
} as const;

// ─── Domain 10: ContentIngestMode (ingestion lifecycle modes) ───

export const CONTENT_INGEST_MODE_DOMAIN: CappzDomainConfig = {
  domainCode: 'ContentIngestMode',
  displayName: 'Content Ingest Mode',
  hdDomainIndex: 10,
  description: 'Ingestion lifecycle modes — determines purge/version/replace behavior',
  extensible: false,
  values: [
    { code: 'INGEST',  displayName: 'Initial Ingestion (v1-0)',           hdIndex: 0, category: 'lifecycle' },
    { code: 'AMEND',   displayName: 'Versioned Update (preserves history)', hdIndex: 1, category: 'lifecycle' },
    { code: 'REPLACE', displayName: 'Full Replacement (purge + re-ingest)', hdIndex: 2, category: 'lifecycle' },
  ],
} as const;

// ─── Domain 11: LocalContentSerializationMode ───

export const LOCAL_CONTENT_SERIALIZATION_MODE_DOMAIN: CappzDomainConfig = {
  domainCode: 'LocalContentSerializationMode',
  displayName: 'Local Content Serialization Mode',
  hdDomainIndex: 11,
  description: 'Controls how content is serialized when persisted locally in wallets. RAW = cleartext, ENCRYPTED = wallet-encrypted.',
  extensible: false,
  values: [
    { code: 'RAW',       displayName: 'Raw (cleartext local persistence)',              hdIndex: 0, category: 'serialization' },
    { code: 'ENCRYPTED', displayName: 'Encrypted (wallet-encrypted local persistence)', hdIndex: 1, category: 'serialization' },
  ],
} as const;

// ─── Domain 12: OnchainContentSerializationMode ───

export const ONCHAIN_CONTENT_SERIALIZATION_MODE_DOMAIN: CappzDomainConfig = {
  domainCode: 'OnchainContentSerializationMode',
  displayName: 'On-Chain Content Serialization Mode',
  hdDomainIndex: 12,
  description: 'Controls how content is serialized when persisted on-chain. RAW = cleartext on-chain, ENCRYPTED = encrypted payload on-chain.',
  extensible: false,
  values: [
    { code: 'RAW',       displayName: 'Raw (cleartext on-chain persistence)',       hdIndex: 0, category: 'serialization' },
    { code: 'ENCRYPTED', displayName: 'Encrypted (encrypted on-chain persistence)', hdIndex: 1, category: 'serialization' },
  ],
} as const;

// ─── Domain 13: ContentPublishTierMode ───

export const CONTENT_PUBLISH_TIER_MODE_DOMAIN: CappzDomainConfig = {
  domainCode: 'ContentPublishTierMode',
  displayName: 'Content Publish Tier Mode',
  hdDomainIndex: 13,
  description: 'Publish tier selection — multi-select via independent TXs. Tier 1 = Local Content Publish (wallet-only), Tier 2 = On-Chain Content Publish.',
  extensible: false,
  values: [
    { code: 'TIER_1_LCP', displayName: 'Local Content Publish (wallet-resident only)', hdIndex: 0, category: 'publish' },
    { code: 'TIER_2_OCP', displayName: 'On-Chain Content Publish (ledger-persisted)',   hdIndex: 1, category: 'publish' },
  ],
} as const;

// ─── Domain 14: EncryptionType ───

export const ENCRYPTION_TYPE_DOMAIN: CappzDomainConfig = {
  domainCode: 'EncryptionType',
  displayName: 'Encryption Type',
  hdDomainIndex: 14,
  description: 'Algorithm for ENCRYPTED serialization — aligned with BTC/XRP secp256k1 standards. AES-256-GCM for symmetric (TLS 1.3), secp256k1 ECIES for asymmetric (BTC/XRPL native curve). Key derivation: HKDF-SHA256 from wallet signature + content HD address.',
  extensible: true,
  values: [
    { code: 'AES_256_GCM',      displayName: 'AES-256-GCM (symmetric, TLS 1.3)',  hdIndex: 0, category: 'symmetric' },
    { code: 'SECP256K1_ECIES',   displayName: 'secp256k1 ECIES (BTC/XRP native)', hdIndex: 1, category: 'asymmetric' },
  ],
} as const;

// ─── Domain 15: WalletTier (v11-5-1-mdm-wallet-tiers) ───

export const WALLET_TIER_DOMAIN: CappzDomainConfig = {
  domainCode: 'WalletTier',
  displayName: 'Wallet Tier',
  hdDomainIndex: 15,
  description:
    'Wallet tier typing. Every originated wallet declares its type by emitting a WalletTierTyped to the tier value address. Tier membership is an inbound-edge set — zero, one or many wallets may point at any value (multi-POW replicas for redundancy, scale-out and data residency).',
  extensible: false,
  values: [
    { code: 'PTW', displayName: 'Prime Template Wallet',    hdIndex: 0, category: 'wallet-tier' },
    { code: 'POW', displayName: 'Prime Operational Wallet', hdIndex: 1, category: 'wallet-tier' },
    { code: 'UAW', displayName: 'User Application Wallet',  hdIndex: 2, category: 'wallet-tier' },
  ],
} as const;

// ─── Domain 16: CommissionTypes (v12-06-ebb-commission-types) ───

export const COMMISSION_TYPES_DOMAIN: CappzDomainConfig = {
  domainCode: 'CommissionTypes',
  displayName: 'Commission Types',
  hdDomainIndex: 16,
  description:
    'Commission vocabulary for EBB contract flow administration: what a commission is calculated on (basis), how the pool is structured, whether an advance is recouped first, and at which scope level a rule may be declared. Rulesets reference these permanent value addresses instead of free-text strings.',
  extensible: true,
  values: [
    // Basis — what the commission is calculated on
    { code: 'GROSS_REVENUE',        displayName: 'Gross revenue',                 hdIndex: 0,  category: 'basis' },
    { code: 'NET_REVENUE',          displayName: 'Net revenue',                   hdIndex: 1,  category: 'basis' },
    { code: 'NOTIONAL',             displayName: 'Notional amount',               hdIndex: 2,  category: 'basis' },
    { code: 'SCHEDULED_PAYMENT',    displayName: 'Scheduled payment',             hdIndex: 3,  category: 'basis' },
    { code: 'TALENT_PAYOUT_BASE',   displayName: 'Talent payout base transaction', hdIndex: 4, category: 'basis' },

    // Structure — how the pool is split
    { code: 'FLAT_RATE',            displayName: 'Flat rate',                     hdIndex: 5,  category: 'structure' },
    { code: 'TIERED_RATE',          displayName: 'Tiered rate',                   hdIndex: 6,  category: 'structure' },
    { code: 'HIERARCHY_SPLIT',      displayName: 'Hierarchy split (senior/junior)', hdIndex: 7, category: 'structure' },
    { code: 'PEER_SPLIT',           displayName: 'Peer split',                    hdIndex: 8,  category: 'structure' },
    { code: 'FLYWHEEL_SHARE',       displayName: 'Flywheel share',                hdIndex: 9,  category: 'structure' },
    { code: 'OVERRIDE_RATE',        displayName: 'Override rate',                 hdIndex: 10, category: 'structure' },

    // Recoup — whether an advance is absorbed before payout
    { code: 'SALARY_ADVANCE_RECOUP', displayName: 'Salary advance recoup',        hdIndex: 11, category: 'recoup' },
    { code: 'NO_RECOUP',             displayName: 'No recoup',                    hdIndex: 12, category: 'recoup' },

    // Scope level — where a rule may be declared
    { code: 'GLOBAL',               displayName: 'Global',                        hdIndex: 13, category: 'scope-level' },
    { code: 'PORTFOLIO',            displayName: 'Portfolio',                     hdIndex: 14, category: 'scope-level' },
    { code: 'AGENT',                displayName: 'Agent',                         hdIndex: 15, category: 'scope-level' },
    { code: 'TALENT',               displayName: 'Talent',                        hdIndex: 16, category: 'scope-level' },
    { code: 'ASSOCIATION',          displayName: 'Association edge',              hdIndex: 17, category: 'scope-level' },
    { code: 'DEAL',                 displayName: 'Deal',                          hdIndex: 18, category: 'scope-level' },
    { code: 'LEG',                  displayName: 'Deal leg',                      hdIndex: 19, category: 'scope-level' },
    { code: 'REVENUE_STREAM',       displayName: 'Revenue stream',                hdIndex: 20, category: 'scope-level' },
  ],
} as const;

export const EBB_ACTIVITY_TYPES_DOMAIN: CappzDomainConfig = {
  domainCode: 'EbbActivityTypes', displayName: 'EBB Activity Types', hdDomainIndex: 17,
  description: 'Operational activities, accounting bases, and provenance sources used by EBB.', extensible: true,
  values: [
    { code: 'revenue-recognized', displayName: 'Revenue recognized', hdIndex: 0, category: 'activity' },
    { code: 'advance-issued', displayName: 'Advance issued', hdIndex: 1, category: 'activity' },
    { code: 'salary-paid', displayName: 'Salary paid', hdIndex: 2, category: 'activity' },
    { code: 'commission-accrued', displayName: 'Commission accrued', hdIndex: 3, category: 'activity' },
    { code: 'commission-recouped', displayName: 'Commission recouped', hdIndex: 4, category: 'activity' },
    { code: 'commission-paid', displayName: 'Commission paid', hdIndex: 5, category: 'activity' },
    { code: 'talent-payout', displayName: 'Talent payout', hdIndex: 6, category: 'activity' },
    { code: 'production-cost', displayName: 'Production cost', hdIndex: 7, category: 'activity' },
    { code: 'deal-terminated-settlement', displayName: 'Termination settlement', hdIndex: 8, category: 'activity' },
    { code: 'actual', displayName: 'Actual', hdIndex: 9, category: 'basis' },
    { code: 'projected', displayName: 'Projected', hdIndex: 10, category: 'basis' },
    { code: 'person', displayName: 'Person — my own entry', hdIndex: 11, category: 'source' },
    { code: 'on-behalf', displayName: 'On behalf of another person', hdIndex: 12, category: 'source' },
    { code: 'agent', displayName: 'EBB agent — deal automation', hdIndex: 13, category: 'source' },
    { code: 'import', displayName: 'Contract import', hdIndex: 14, category: 'source' },
  ],
} as const;

export const EBB_STREAM_TYPES_DOMAIN: CappzDomainConfig = {
  domainCode: 'EbbStreamTypes', displayName: 'EBB Revenue Stream Types', hdDomainIndex: 18,
  description: 'Revenue stream categories and recognition cadences.', extensible: true,
  values: [
    { code: 'ad-platform', displayName: 'Ad platform', hdIndex: 0, category: 'stream' },
    { code: 'merchandise', displayName: 'Merchandise', hdIndex: 1, category: 'stream' },
    { code: 'syndication', displayName: 'Syndication', hdIndex: 2, category: 'stream' },
    { code: 'licensing', displayName: 'Licensing', hdIndex: 3, category: 'stream' },
    { code: 'funding', displayName: 'Series funding', hdIndex: 4, category: 'stream' },
    { code: 'streaming', displayName: 'Streaming / SVOD', hdIndex: 5, category: 'stream' },
    { code: 'theatrical', displayName: 'Theatrical', hdIndex: 6, category: 'stream' },
    { code: 'sponsorship', displayName: 'Sponsorship', hdIndex: 7, category: 'stream' },
    { code: 'other', displayName: 'Other', hdIndex: 8, category: 'stream' },
    { code: 'monthly', displayName: 'Monthly', hdIndex: 9, category: 'recognition' },
    { code: 'quarterly', displayName: 'Quarterly', hdIndex: 10, category: 'recognition' },
    { code: 'on-event', displayName: 'On event', hdIndex: 11, category: 'recognition' },
  ],
} as const;

export const EBB_PARTY_TYPES_DOMAIN: CappzDomainConfig = {
  domainCode: 'EbbPartyTypes', displayName: 'EBB Party and Person Types', hdDomainIndex: 19,
  description: 'Organization roles, association roles, lifecycle events, billing terms and attribution roles.', extensible: true,
  values: [
    { code: 'leadership', displayName: 'Leadership', hdIndex: 0, category: 'employment-role' },
    { code: 'operations', displayName: 'Operations', hdIndex: 1, category: 'employment-role' },
    { code: 'finance', displayName: 'Finance', hdIndex: 2, category: 'employment-role' },
    { code: 'talent-management', displayName: 'Talent management', hdIndex: 3, category: 'employment-role' },
    { code: 'roster-talent', displayName: 'Roster talent', hdIndex: 4, category: 'employment-role' },
    { code: 'agent', displayName: 'Agent', hdIndex: 5, category: 'association-role' },
    { code: 'senior-agent', displayName: 'Senior agent', hdIndex: 6, category: 'association-role' },
    { code: 'junior-agent', displayName: 'Junior agent', hdIndex: 7, category: 'association-role' },
    { code: 'manager', displayName: 'Manager', hdIndex: 8, category: 'association-role' },
    { code: 'PersonAssociationDeprecated', displayName: 'Deprecated', hdIndex: 9, category: 'association-end' },
    { code: 'PersonAssociationTerminated', displayName: 'Terminated', hdIndex: 10, category: 'association-end' },
    { code: 'PersonAssociationCancelled', displayName: 'Cancelled', hdIndex: 11, category: 'association-end' },
    { code: 'PersonAssociationRemoved', displayName: 'Removed', hdIndex: 12, category: 'association-end' },
    { code: 'on-receipt', displayName: 'On receipt', hdIndex: 13, category: 'billing-terms' },
    { code: 'net-30', displayName: 'Net 30', hdIndex: 14, category: 'billing-terms' },
    { code: 'net-45', displayName: 'Net 45', hdIndex: 15, category: 'billing-terms' },
    { code: 'per-milestone', displayName: 'Per milestone', hdIndex: 16, category: 'billing-basis' },
    { code: 'per-period', displayName: 'Per period', hdIndex: 17, category: 'billing-basis' },
    { code: 'lead', displayName: 'Lead', hdIndex: 18, category: 'attribution-role' },
    { code: 'support', displayName: 'Support', hdIndex: 19, category: 'attribution-role' },
    { code: 'Employee', displayName: 'Employee', hdIndex: 20, category: 'association-type' },
    { code: 'Contractor', displayName: 'Contractor', hdIndex: 21, category: 'association-type' },
  ],
} as const;

/** @deprecated Use LOCAL_CONTENT_SERIALIZATION_MODE_DOMAIN, ONCHAIN_CONTENT_SERIALIZATION_MODE_DOMAIN, CONTENT_PUBLISH_TIER_MODE_DOMAIN */
export const DATA_PRIVACY_MODE_DOMAIN = LOCAL_CONTENT_SERIALIZATION_MODE_DOMAIN;

/** All canonical cappz: domains in registration order */
export const CAPPZ_DOMAINS: readonly CappzDomainConfig[] = [
  WALLET_ROLES_DOMAIN,
  VALIDATION_ERRORS_DOMAIN,
  OPERATIONAL_ERRORS_DOMAIN,
  FUNCTIONS_EVENTS_DOMAIN,
  RULES_DOMAIN,
  ENDPOINT_INTERFACES_DOMAIN,
  OPERATIONAL_STATUS_DOMAIN,
  CONTENT_LIFECYCLE_EVENTS_DOMAIN,
  SOURCE_CONTENT_TYPE_DOMAIN,
  SOURCE_CONTENT_FORMAT_DOMAIN,
  CONTENT_INGEST_MODE_DOMAIN,
  LOCAL_CONTENT_SERIALIZATION_MODE_DOMAIN,
  ONCHAIN_CONTENT_SERIALIZATION_MODE_DOMAIN,
  CONTENT_PUBLISH_TIER_MODE_DOMAIN,
  ENCRYPTION_TYPE_DOMAIN,
  WALLET_TIER_DOMAIN,
  COMMISSION_TYPES_DOMAIN,
  EBB_ACTIVITY_TYPES_DOMAIN,
  EBB_STREAM_TYPES_DOMAIN,
  EBB_PARTY_TYPES_DOMAIN,
] as const;

