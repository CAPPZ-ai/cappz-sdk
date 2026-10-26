/**
 * MDMEventTxRegistry — Canonical registry of all Event TX types
 * with their MDM HD addresses and verification metadata.
 *
 * Every Event TX type emitted anywhere in the platform MUST be
 * registered here with its governing MDM address. The MDMVerificationSkill
 * uses this registry to verify that all TXs an agent emits are
 * MDM-anchored (no orphan event types).
 *
 * HD Root: m/44'/144'/0'/cappz/event-tx-registry
 *
 * Categories:
 *   /admin-queue    — Wallet/Agent/Skill lifecycle
 *   /config         — WalletAgent configuration
 *   /clone          — Clone/upgrade/group membership
 *   /content        — Ingest/pipeline/knowledge
 *   /mdm-graph      — Graph structure (code values, bindings)
 *   /migration      — DB/store migration
 *   /bridge         — Protocol adapter events
 *   /cid            — Release plan lifecycle
 *   /serialization-local   — LocalContentSerializationMode lifecycle
 *   /serialization-onchain — OnchainContentSerializationMode lifecycle
 *   /publish-tier          — ContentPublishTierMode lifecycle
 *   /content-access        — Targeted content release grants (AX-81)
 *   /publish-execution     — Publish execution, integrity, Hanoi safe-swap, recovery
 */

import {
  DEPRECATED_EVENT_ALIASES,
  RETIRED_TX_EVENT_TYPES,
  canonicalEventType,
} from '../../mdm/eventTypeAliases';

// ─── Registry Root ──────────────────────────────────────────────

export const EVENT_TX_REGISTRY_ROOT = "m/44'/144'/0'/cappz/event-tx-registry";

// ─── Registry Entry ─────────────────────────────────────────────

export interface EventTxRegistryEntry {
  /** The event type string as emitted in TXs */
  eventType: string;
  /** MDM HD address governing this event type */
  mdmAddress: string;
  /** Category for grouping */
  category: EventTxCategory;
  /** Canonical lifecycle event this maps to (if applicable) */
  canonicalType?: string;
  /** Human description */
  description: string;
  /** Which entities can emit this TX */
  emitters: EventTxEmitter[];
  /** Whether a paired Created/Deprecated lifecycle exists */
  hasPairedLifecycle: boolean;
  /** The paired event type (e.g., Created ↔ Deprecated) */
  pairedEventType?: string;
  /** Retired: the event type that replaces this one (still replayed, never written). */
  deprecatedBy?: string;
}

export type EventTxCategory =
  | 'admin-queue'
  | 'config'
  | 'clone'
  | 'content'
  | 'mdm-graph'
  | 'migration'
  | 'bridge'
  | 'cid'
  | 'group-membership'
  | 'pipeline'
  | 'ordered-list'
  | 'acp'
  | 'scope'
  | 'skill-binding'
  | 'serialization-local'
  | 'serialization-onchain'
  | 'publish-tier'
  | 'content-access'
  | 'publish-execution'
  | 'linkage-auth'
  | 'build-manifest'
  | 'ebb'
  | 'wallet-tier'
  | 'security-access'
  | 'inference'
  | 'model'
  | 'type-cast'
  | 'runtime-preference'
  | 'admin'
  | 'function-registry'
  | 'feedback'
  | 'fees'
  | 'a2a-sync'
  | 'media'
  | 'harvest'
  | 'marketplace'
  | 'repoz'
  | 'identity'
  | 'dmz';

export type EventTxEmitter = 'wallet' | 'agent' | 'skill' | 'cid-agent' | 'domain-agent';

// ─── Full Registry ──────────────────────────────────────────────

const R = EVENT_TX_REGISTRY_ROOT;

/**
 * EBB's complete event vocabulary is owned here, at the MDM root. EBB imports
 * this tuple for its type, so adding an emitter without first giving the event
 * an MDM identity is impossible at compile time (AX-73).
 */
export const EBB_EVENT_TYPES = [
  'PortfolioProvisioned', 'SkillConstituentIncluded', 'SkillConstituentRemoved',
  'DealDrafted', 'DealLegAdded', 'DealLegAmended', 'DealSerialized', 'DealExecuted',
  'PartyRegistered', 'PersonRegistered', 'PartyRoleBound', 'PartyRoleUnbound',
  'PartyDealLinked', 'EmployeeHired', 'EmployeeFired', 'EmployeeResigned',
  'MilestoneAffirmed', 'LegPaymentPosted', 'ProcessBound', 'TemplateRegistered',
  'OntologyNodeDeclared', 'OntologyNodeAmended', 'OntologyNodeRetired',
  'ConstituentIncluded', 'AgentBound', 'RuleBound', 'FunctionDeclared',
  'EventTypeRegistered', 'SchemaRegistered', 'DealClonedFromTemplate',
  'ProjectRegistered', 'ProjectAmended', 'ProjectGreenlit', 'ProjectDelivered',
  'ProjectRetired', 'EventProjectionDeclared', 'EventProjectionSatisfied',
  'EventProjectionLapsed', 'EventSubscriptionBound', 'EventSubscriptionUnbound',
  'RevenuePosted', 'RecoupmentCredited', 'CommissionAccrued',
  'CommissionTransferred', 'PayoutCycleSettled', 'CrmIdentityExported',
  'CrmRecordCorrelated', 'PersonAssociationCreated', 'PersonAssociationDeprecated',
  'PersonAssociationTerminated', 'PersonAssociationCancelled', 'PersonAssociationRemoved',
  'CommissionRulesetDeclared', 'CommissionRuleDeclared', 'CommissionRuleDeprecated',
  'AgentCommissionCalculated', 'AccountDeclared', 'JournalPosted',
  'Iso20022MessageAttached', 'SettlementRailDeclared', 'SettlementInstructed',
  'SettlementConfirmed', 'SettlementFailed', 'DealTerminated',
  'DealPartiallyTerminated', 'RevenueStreamDeclared', 'ActivityRecorded',
  'DelegationGranted', 'DelegationRevoked', 'ContractDocumentIngested',
  'ContractDraftExtracted', 'ClarificationRaised', 'ClarificationAnswered',
  'ExternalSystemRegistered', 'ExternalMappingDeclared', 'ExternalRecordCorrelated',
  'ExternalSyncRequested', 'ExternalSyncCompleted', 'ExternalSyncFailed',
  'ClientBillingTermsDeclared', 'InvoiceIssued', 'InvoiceVoided', 'CashReceived',
  'CashApplied', 'TalentPayableRaised', 'TalentPaid',
  // v12-10-c — cash-basis commission eligibility
  'CommissionEligibilityPolicyDeclared', 'CommissionAttributionDeclared',
  'CommissionEligibilityResolved',
  // v12-13-a — signed human gates on the deal administration process
  'ContractValidated', 'ContractRejected', 'ContractApproved',
  'ProductDelivered', 'DeliveryValidated', 'DeliveryRejected',
  'DeliveryApproved', 'InvoiceApproved', 'TalentPaymentApproved',
  // v12-15 — person ↔ party association (Employee | Contractor) lifecycle
  'AssociationCreated', 'AssociationRemoved',
  // v12-16-b — RepoZ-backed documents and media kits on any EBB entity
  'DocumentUploaded', 'DocumentVersioned', 'DocumentArchived',
  // v12-17 — FpML lifecycle for complete deals and their constituents
  'DealCreated', 'DealDeprecated', 'DealTruncated', 'DealCompressed',
  // v12-20-06: deal constituents are `DealConstituent*` — the plain
  // `ConstituentCreated` is the codex hierarchy link (cid).
  'DealConstituentCreated', 'DealConstituentDeprecated', 'DealConstituentTerminated',
  'DealConstituentPartiallyTerminated', 'DealConstituentTruncated', 'DealConstituentCompressed',
  // v12-19-e — ISO 20022 party/person records and their association lifecycle
  'PartyDataAmended', 'PersonDataAmended', 'PartyRecordSuperseded',
  'PersonRecordSuperseded', 'PartyPersonAssociationAmended',
  'PartyPersonAssociationCancelled', 'PartyPersonAssociationTerminated',
  'PartyPersonAssociationDeprecated',
  // v12-19-f — wallets provisioned for entities discovered in an ingest run
  'PartyWalletDeclared', 'PersonWalletDeclared', 'DealWalletDeclared',
  'DealPayableAccountDeclared',
  // v12-19-g — upload library, executed ingest runs and versioned format configs
  'IngestFileUploaded', 'IngestRunExecuted',
  'FormatConfigCreated', 'FormatConfigAmended',
  'FormatConfigDeprecated', 'FormatConfigTerminated',
  // v12-22-confirmation — recorded document checks (schema + business rules)
  'DocumentValidated', 'DocumentValidationFailed',
  // v12-22-confirmation — LEI resolution on the Party (latest wins)
  'PartyLegalEntityResolved',
  // v12-22-confirmation — counterparty matching/affirmation, lifecycle, twin-TX notarization
  'ConfirmationSent', 'ConfirmationMatched', 'ConfirmationMismatched',
  'ConfirmationAffirmed', 'ConfirmationDisputed',
  'ConfirmationNotarized', 'ConfirmationConstituentsAggregated',
  'NovationConsentGiven', 'DealNovated', 'DealAmended',
  // v14-12-12 — BPMN-driven deal lifecycle: business cancellation (FpML CANCEL,
  // distinct from technical deprecation), activation of signed terms, and
  // correlated compliance holds (KYC, AML, sanctions, …)
  'DealCancelled', 'DealActivated', 'ComplianceHoldPlaced', 'ComplianceHoldReleased',
  // v14-12-12 — middle-office flow remediation: a plugged flow asks for
  // intervention, a fix is requested (agent-assisted or manual), and the
  // remediated message is resubmitted with posDup under one correlated chain.
  'InterventionRequested', 'RemediationRequested', 'TradeRemediated',
] as const;

const EBB_LIFECYCLE_PAIRS: Readonly<Record<string, string>> = {
  DealCreated: 'DealDeprecated', DealDeprecated: 'DealCreated',
  DealConstituentCreated: 'DealConstituentDeprecated', DealConstituentDeprecated: 'DealConstituentCreated',
  ComplianceHoldPlaced: 'ComplianceHoldReleased', ComplianceHoldReleased: 'ComplianceHoldPlaced',
};

const EBB_EVENT_TX_REGISTRY: EventTxRegistryEntry[] = EBB_EVENT_TYPES.map((eventType) => {
  const pairedEventType = EBB_LIFECYCLE_PAIRS[eventType];
  return {
    eventType,
    mdmAddress: `${R}/ebb/${eventType.replace(/Tx$/, '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}`,
    category: 'ebb',
    description: `EBB Contract Flow Administration event: ${eventType}`,
    emitters: ['domain-agent'],
    hasPairedLifecycle: Boolean(pairedEventType),
    pairedEventType,
  };
});

/**
 * v12-11 — substrate vocabularies that previously emitted without a canonical
 * declaration. Declared here so `createNotarizedEvent` binds real custody
 * metadata into every hash instead of an `undeclared/*` placeholder.
 */
const SUBSTRATE_DOMAIN_EVENTS: Array<{
  category: EventTxCategory;
  segment: string;
  emitters: EventTxEmitter[];
  types: string[];
}> = [
  {
    category: 'repoz',
    segment: 'repoz',
    emitters: ['wallet', 'agent', 'skill'],
    types: [
      'ContentCreated', 'ContentAmended', 'AmendGranted', 'AmendRevoked', 'ReadGranted', 'ReadRevoked',
      'ConflictDetected', 'BranchMerged', 'DependencyCreated',
      'BuildConstituentIncluded', 'BuildManifestCreated', 'RepoZSynchronizationRequested', 'RepoZSynchronizationCompleted',
    ],
  },
  {
    category: 'wallet-tier',
    segment: 'wallet-tier',
    emitters: ['wallet'],
    types: [
      'WalletCopied', 'WalletCloned', 'WalletTemplateRegistered', 'WalletTierTyped',
      'WalletTierRetyped', 'UserPowAnchored', 'VersionPinned', 'VersionUnpinned',
      'DomainModelAmended', 'ContextTurnAppended', 'UserAliasCreated', 'UserAliasAmended',
      'NextSequenced', 'PreviousSequenced', 'ContextTagAssigned', 'ContextTagRemoved', 'ContentMigrated',
      'ConstituentRemoved',
    ],
  },
  {
    category: 'security-access',
    segment: 'security-access',
    emitters: ['agent', 'wallet'],
    types: [
      'SecurityPrincipalCreated', 'SecurityPrincipalRevoked', 'ConstituencyInvited',
      'ConstituencyInviteAccepted', 'ConstituencyInviteDeclined', 'ConstituencyRequested',
      'ConstituencyRequestRejected', 'AllAccessGranted', 'AllAccessRevoked',
      'PermissionGranted', 'PermissionRevoked', 'BpmnGovernanceBound',
    ],
  },
  {
    category: 'inference',
    segment: 'inference',
    emitters: ['agent', 'skill'],
    types: [
      'WalletHostDeclared', 'InferenceResidencyChanged', 'InferenceFallbackEngaged',
      'InferenceModelChanged',
    ],
  },
  {
    category: 'model',
    segment: 'model',
    emitters: ['wallet', 'skill'],
    types: [
      'ModelArtifactIngested', 'ConstituentsAggregated', 'ModelVersionPublished',
      'ModelVersionRetired', 'ModelVersioned', 'ModelCacheWarmed',
    ],
  },
  {
    category: 'type-cast',
    segment: 'type-cast',
    emitters: ['agent', 'skill'],
    types: ['TypeCastAssociated', 'TypeCastDisassociated'],
  },
  {
    category: 'runtime-preference',
    segment: 'runtime-preference',
    emitters: ['agent'],
    types: ['RuntimeLocationSelected', 'ModelSelected'],
  },
  {
    // v12-20-04-admin / v12-20-05-groups — admin console vocabulary: command
    // registry + dispatch, login account lifecycle, usage (page visits,
    // sign-ins, agent requests), site controls, and account address
    // derivation/retirement. Suffix-free Noun-Verb (past), AP-22.
    // Mirrored by supabase/functions/_shared/adminSubstrate.ts.
    category: 'admin',
    segment: 'admin',
    emitters: ['agent', 'wallet'],
    types: [
      'CommandPermissionGranted', 'CommandPermissionRevoked', 'CommandMetadataAnchored', 'CommandMetadataAmended',
      'AdminVerbRegistered', 'AdminVerbRevoked', 'AdminVerbDispatched', 'AdminVerbRejected',
      'LoginRevoked', 'LoginRestored', 'SessionsRevoked', 'MemberInvited',
      'PageVisited', 'LoginRecorded', 'AgentRequestRecorded',
      'SiteNoticePublished', 'SiteNoticeWithdrawn', 'SignupClosed', 'SignupOpened',
      'AccountAddressDerived', 'AccountAddressDeprecated',
      // v12-20-06 — hewn-network-switch.bpmn: durable record of an admin
      // XRPL network switch (from, to, surface, by) at the site POW /network.
      'NetworkSwitched',
      // v12-20-12 — admin agent account (AgentCreated) anchored from the admin PTW.
      'AgentCreated',
    ],
  },
  {
    // v12-20-09 — function registry: every function is an account with an
    // identity key; versions are RepoZ addresses linked prev/next; batches
    // of chainlet blocks and registry records are stamped on the XRP Ledger.
    // Mirrored by supabase/functions/_shared/functionRegistry.ts.
    category: 'function-registry',
    segment: 'function-registry',
    emitters: ['agent', 'wallet'],
    types: [
      'FunctionCreated', 'FunctionAmended', 'FunctionRetired',
      'FunctionBindingAdded', 'FunctionBindingRemoved',
      'FunctionAddressDerived', 'FunctionAddressDeprecated',
      'ChainletBatchAnchored',
      // v15-01-00 — a function moved off hosted infrastructure (payload: from,
      // to, release, sourceHash), correlated with FunctionRetired for its
      // hosted copy (payload.copy = 'hosted', correlationId). Written to the
      // function-port ledger by function.port; replayed, never inferred.
      'FunctionPorted',
    ],
  },
  {
    // v12-23-12 — Inquiry & Feedback form (IFF): TXs from a UPW/UAW to the
    // Inquiry Feedback Wallet (IFW); feedback-processing.bpmn.
    // Mirrored by supabase/functions/feedback/index.ts.
    // v14-08-00 — the door opens to signed-out visitors: VerifyHumanity
    // (Turnstile) and EnforceRateLimit (TX replay) run inside the existing
    // feedback function; rejections emit FeedbackSubmissionRejected.
    category: 'feedback',
    segment: 'feedback',
    emitters: ['agent', 'wallet'],
    types: ['FeedbackCreated', 'FeedbackReplied', 'FeedbackBroadcast', 'FeedbackClosed', 'FeedbackEscalated', 'FeedbackSubmissionRejected', 'FeedbackIssueApproved'],
  },
  {
    // v14-11-00 — Media Codex (media-registration.bpmn, playlist-carousel.bpmn).
    // Items, albums, catalogs and libraries are wallets; inclusion is by-ref
    // ConstituentIncluded (already catalogued with the constituency family).
    category: 'media',
    segment: 'media',
    emitters: ['agent', 'wallet'],
    types: ['MediaItemRegistered', 'MediaItemAmended', 'AlbumComposed', 'CatalogComposed', 'CatalogCorrelationDeclared', 'PlaylistStarted', 'PlaylistStopped', 'PlaylistAdvanced', 'PlaybackLoopModeSet', 'PlaybackPreempted', 'LyricsTranscribed', 'MediaIntegrityVerified', 'MediaTranscodeRejected', 'MediaItemPublished', 'MediaWalletEscrowed', 'MediaRawContentPurged', 'HomeDefaultMediaSet', 'PageDefaultMediaSet', 'PlaylistShuffled'],
  },
  {
    // v14-12-08 — notary/sync-notarization-receipts.bpmn: source-gated recovery.
    // v14-12-09: superseded by renotarize-content.bpmn; kept for replay only.
    category: 'migration',
    segment: 'notarization-recovery',
    emitters: ['agent', 'wallet'],
    types: ['NotarizationSynchronized'],
  },
  {
    // v14-12-09 — notary/renotarize-content.bpmn. One record for all content:
    // latest non-cancelled ContentNotarized per content hash wins.
    category: 'migration',
    segment: 'notarization',
    emitters: ['agent', 'wallet'],
    types: ['ContentNotarized', 'NotarizationCancelled'],
  },
  {
    // v14-02-00 — fee-based pricing (fees/fee-charging.bpmn, fees/treasury-topup.bpmn,
    // auth/mcp-oauth-consent.bpmn). Balances are replayed from these TXs (AP-12);
    // ServiceInitiated/Paused/Resumed/Halted govern a replica's billable lifetime
    // (distinct from per-session SyncSessionPaused/Resumed/Restarted).
    category: 'fees',
    segment: 'fees',
    emitters: ['agent', 'wallet'],
    types: [
      'FundsDeposited', 'FeesReserved', 'AppFunded', 'FeeCharged', 'SubscriptionCharged',
      'PriceSheetPublished',
      'ConsentRequested', 'ConsentGranted', 'ConsentDenied', 'ConsentRevoked',
      'ServiceInitiated', 'ServicePaused', 'ServiceResumed', 'ServiceHalted',
      'SubscriptionStarted', 'SubscriptionCancelled',
      // v14-05-00: wallet alias (name stored at the wallet's own alias address)
      'AliasCreated', 'AliasAmended',
      'ChannelOpened', 'ChannelClosed', 'SessionStarted', 'SessionRenamed', 'SessionClosed', 'SessionReopened', 'SessionParticipantJoined', 'SessionParticipantLeft',
    ],
  },
  {
    // v12-21-00 — A2A wallet-copy sync (a2a-sync.bpmn). Signals only; payloads
    // move copy-to-copy over the encrypted channel, never on the ledger.
    category: 'a2a-sync',
    segment: 'a2a-sync',
    emitters: ['agent', 'wallet'],
    types: [
      'DataSyncRequested', 'SyncSessionOpened', 'SyncItemOffered', 'SyncItemDelivered',
      'SyncItemRejected', 'SyncForkDetected', 'SyncHeadersBatched', 'SyncBlobShredded',
      'SyncSessionClosed', 'AmendConflictDetected',
      // v12-21-02 — a2a-sync-standup.bpmn evidence
      'SyncCopyRegistered', 'SyncNetworkVerified',
      'SyncCapabilityAdvertised', 'SyncCapabilityWithdrawn',
      'SyncOffered', 'SyncRequested', 'SyncMatched', 'SyncOrderWithdrawn',
      'SyncRejected', 'SyncCompleted',
      'BaseSyncPriceOffered', 'BasePriceSyncRequested', 'SyncPaymentSettled',
      // v15-03-00 — SyncRefund: payer requests (RemediationRequested subclass), payee reverses or declines
      'SyncRefundRequested', 'SyncPaymentReversed', 'SyncRefundDeclined',
      // v15-04-00 — dispute: payer → arbiter, arbiter rules refund (with the back-out) or uphold
      'SyncArbitrationRequested', 'SyncArbitrationDecided',
      'AppUpgradeOffered', 'AppUpgradeRequested', 'AppUpgradeApproved',
      'AppUpgradeStaged', 'AppUpgradeActivated', 'AppUpgradeRejected',
      'AppUpgradeExpired', 'AppUpgradeWithdrawn', 'AppUpgradeRolledBack',
      // v15-03-00 — replica-connect.bpmn: copy behind a firewall asks a relay node, node decides
      'ReplicaConnectRequested', 'ReplicaConnectOffered', 'ReplicaConnectRejected',
      'TunnelOpened', 'TunnelClosed',
      // v15-05-00 — member table (NetBIOS/bindery-style): per-device endpoint records, amended on change
      'CopyEndpointRegistered', 'CopyEndpointAmended',
      // v15-09-00 — emitted since v12-21..v15-04 but never declared (test: every A2A_SYNC_EVENT_TYPES entry is declared)
      'SyncChecksumReceiptIssued', 'SyncSessionPaused', 'SyncSessionResumed', 'SyncSessionRestarted',
      'PeerHeadAnnounced', 'PeerInventoryDiffed', 'PeerSignalExchanged', 'SyncBundleExported', 'SyncBundleImported',
      'ReplicatorAgentCreated', 'ReplicatorPeerScored', 'ChannelConfigured', 'ChannelAmended', 'ChannelFailoverOccurred',
      'DurabilityLevelSet', 'EscrowTargetAttached', 'EscrowSyncCompleted', 'FarmNodeScored', 'TransportCapabilityDeclared',
    ],
  },
  {
    // v14-18-00 — HARVEST (src/bpmn/harvest/harvest-producer.bpmn, harvest-operator.bpmn). Consent reuses
    // ConsentRequested/Granted/Revoked (fees), farm state and salts reuse
    // ContentCreated/Amended (repoz), surveyStatWallets reuse WalletCloned.
    // Only stage evidence with no existing meaning is declared here.
    category: 'harvest',
    segment: 'harvest',
    emitters: ['agent', 'wallet', 'domain-agent'],
    types: [
      'HarvestRecordCaptured', 'ValidationAttested', 'SurveyOpened', 'SurveyClosed',
      'ContributionVeiled', 'ContributionWithdrawn', 'AggregatePublished', 'AggregateDelivered',
      'AggregateQueried', 'RoyaltyCredited', 'PaymentConfirmed', 'SettlementFinalized',
      'OpportunityRecommended', 'RecommendationDecided', 'OutcomeObserved',
      // v14-18-01 — programs & subsidies (src/bpmn/harvest/harvest-programs.bpmn)
      'ProgramElectionRecorded', 'ProgramPaymentRecorded',
    ],
  },
  {
    // v14-19-00 — Marketplace (src/bpmn/marketplace). Profiles and listings
    // reuse ContentCreated/Amended (contentClass), agent mandates reuse
    // PermissionGranted/Revoked, acceptance reuses MilestoneAffirmed and
    // DeliveryApproved/Rejected, payment references reuse PaymentConfirmed.
    category: 'marketplace',
    segment: 'marketplace',
    emitters: ['agent', 'wallet', 'domain-agent'],
    types: [
      'SupplyRequested', 'SupplyOffered', 'SupplyOfferWithdrawn', 'SupplyAwarded', 'SupplyRequestClosed',
      'ListingWithdrawn', 'InventoryAdjusted', 'OrderPlaced',
      'EscrowFunded', 'EscrowReleased', 'EscrowRefunded',
      'MilestoneEvidenced', 'DisputeRaised', 'DisputeResolved', 'ReviewPosted',
      'AssetTokenized', 'TokenTransferred', 'TokenRedeemed', 'AccessKeyDelivered',
      'SecurityOfferingDeclared', 'SecurityOfferingApproved', 'SecuritySubscribed', 'SecurityAllocated', 'SecurityTransferred',
    ],
  },
];

/**
 * v12-20-05-groups — v12-20-04 admin names retired in favor of the
 * suffix-free form. Since v12-20-06 every retired name lives in the shared
 * alias table; this view keeps the admin subset for existing callers.
 */
export const DEPRECATED_ADMIN_EVENT_ALIASES: Record<string, string> = Object.fromEntries(
  [
    'LoginRevokedTx', 'LoginRestoredTx', 'SessionsRevokedTx', 'UserInvitedTx', 'PageVisitedTx',
    'LoginRecordedTx', 'AgentRequestRecordedTx', 'SiteNoticePublishedTx', 'SiteNoticeWithdrawnTx',
    'SignupClosedTx', 'SignupOpenedTx',
  ].map((legacy) => [legacy, DEPRECATED_EVENT_ALIASES[legacy]]),
);

export { DEPRECATED_EVENT_ALIASES, canonicalEventType };

const kebabEvent = (eventType: string) =>
  eventType
    .replace(/Tx$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();

const SUBSTRATE_EVENT_TX_REGISTRY: EventTxRegistryEntry[] = SUBSTRATE_DOMAIN_EVENTS.flatMap(
  ({ category, segment, emitters, types }) =>
    types.map((eventType) => ({
      eventType,
      mdmAddress: `${R}/${segment}/${kebabEvent(eventType)}`,
      category,
      description: `Substrate ${segment} event: ${eventType}`,
      emitters,
      hasPairedLifecycle: false,
    })),
);

/**
 * v12-20-06 — retired names that merged into an event already declared in
 * its own right keep the category they were recorded under, so their MDM
 * address (and therefore custody) is unchanged.
 */
const RETIRED_CATEGORY: Readonly<Record<string, EventTxCategory>> = {
  AgentBoundTx: 'ebb',
  ConstituentCreatedTx: 'ebb',
  SkillConstituentIncludedTx: 'ebb',
  SkillConstituentRemovedTx: 'ebb',
  ConstituentRemovedTx: 'wallet-tier',
  WalletClonedTx: 'wallet-tier',
};

const DECLARED_EVENT_TX_ENTRIES: EventTxRegistryEntry[] = [
  // ── Admin Queue Lifecycle ──
  { eventType: 'AdminQueueCreated', mdmAddress: `${R}/admin-queue/queue-created`, category: 'admin-queue', description: 'Genesis TX for any admin queue', emitters: ['wallet', 'agent', 'skill'], hasPairedLifecycle: false },
  { eventType: 'WalletCreated', mdmAddress: `${R}/admin-queue/wallet-created`, category: 'admin-queue', canonicalType: 'ContentCreated', description: 'Wallet genesis event', emitters: ['wallet'], hasPairedLifecycle: true, pairedEventType: 'WalletDeprecated' },
  { eventType: 'WalletCloned', mdmAddress: `${R}/admin-queue/wallet-cloned`, category: 'admin-queue', canonicalType: 'ContentCloned', description: 'Wallet cloned from source', emitters: ['wallet'], hasPairedLifecycle: false },
  { eventType: 'WalletActivated', mdmAddress: `${R}/admin-queue/wallet-activated`, category: 'admin-queue', description: 'Wallet activated for operations', emitters: ['wallet'], hasPairedLifecycle: true, pairedEventType: 'WalletDeactivated' },
  { eventType: 'WalletSuspended', mdmAddress: `${R}/admin-queue/wallet-suspended`, category: 'admin-queue', description: 'Wallet suspended (reversible)', emitters: ['wallet'], hasPairedLifecycle: false },
  { eventType: 'WalletDeactivated', mdmAddress: `${R}/admin-queue/wallet-deactivated`, category: 'admin-queue', description: 'Wallet deactivated', emitters: ['wallet'], hasPairedLifecycle: true, pairedEventType: 'WalletActivated' },
  { eventType: 'WalletDeprecated', mdmAddress: `${R}/admin-queue/wallet-deprecated`, category: 'admin-queue', description: 'Wallet deprecated (terminal)', emitters: ['wallet'], hasPairedLifecycle: true, pairedEventType: 'WalletCreated' },

  { eventType: 'AgentBound', mdmAddress: `${R}/admin-queue/agent-bound`, category: 'admin-queue', description: 'Agent bound to wallet', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'AgentUnbound' },
  { eventType: 'AgentUnbound', mdmAddress: `${R}/admin-queue/agent-unbound`, category: 'admin-queue', description: 'Agent unbound from wallet', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'AgentBound' },
  { eventType: 'AgentHibernated', mdmAddress: `${R}/admin-queue/agent-hibernated`, category: 'admin-queue', description: 'Agent hibernated (COTA)', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'AgentResumed' },
  { eventType: 'AgentResumed', mdmAddress: `${R}/admin-queue/agent-resumed`, category: 'admin-queue', description: 'Agent resumed from hibernation', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'AgentHibernated' },

  { eventType: 'SkillAttached', mdmAddress: `${R}/admin-queue/skill-attached`, category: 'admin-queue', description: 'Skill attached to agent', emitters: ['skill'], hasPairedLifecycle: true, pairedEventType: 'SkillDetached' },
  { eventType: 'SkillDetached', mdmAddress: `${R}/admin-queue/skill-detached`, category: 'admin-queue', description: 'Skill detached from agent', emitters: ['skill'], hasPairedLifecycle: true, pairedEventType: 'SkillAttached' },
  { eventType: 'SkillPaused', mdmAddress: `${R}/admin-queue/skill-paused`, category: 'admin-queue', description: 'Skill paused', emitters: ['skill'], hasPairedLifecycle: true, pairedEventType: 'SkillResumed' },
  { eventType: 'SkillResumed', mdmAddress: `${R}/admin-queue/skill-resumed`, category: 'admin-queue', description: 'Skill resumed', emitters: ['skill'], hasPairedLifecycle: true, pairedEventType: 'SkillPaused' },

  { eventType: 'AdminCommand', mdmAddress: `${R}/admin-queue/admin-command`, category: 'admin-queue', description: 'Inter-queue command', emitters: ['wallet', 'agent', 'skill'], hasPairedLifecycle: false },
  { eventType: 'AdminAck', mdmAddress: `${R}/admin-queue/admin-ack`, category: 'admin-queue', description: 'Acknowledge received command', emitters: ['wallet', 'agent', 'skill'], hasPairedLifecycle: false },
  { eventType: 'AdminNack', mdmAddress: `${R}/admin-queue/admin-nack`, category: 'admin-queue', description: 'Reject received command', emitters: ['wallet', 'agent', 'skill'], hasPairedLifecycle: false },

  // ── Group Membership Lifecycle (v12-20-05-groups) ──
  // GroupMemberAdded flows from the group account to the member's group
  // account; payload { group, member, memberKind, accountKind }. A
  // GroupMemberRemoved always carries correlationId = the GroupMemberAdded it ends.
  { eventType: 'GroupMemberAdded', mdmAddress: `${R}/group-membership/group-member-added`, category: 'group-membership', description: 'Member (person, agent or group) added to a group account', emitters: ['wallet', 'agent', 'cid-agent'], hasPairedLifecycle: true, pairedEventType: 'GroupMemberRemoved' },
  { eventType: 'GroupMemberRemoved', mdmAddress: `${R}/group-membership/group-member-removed`, category: 'group-membership', description: 'Member removed from a group account (correlated to its GroupMemberAdded)', emitters: ['wallet', 'agent', 'cid-agent'], hasPairedLifecycle: true, pairedEventType: 'GroupMemberAdded' },
  { eventType: 'EdgeFunctionAmended', mdmAddress: `${R}/function-registry/edge-function-amended`, category: 'function-registry', description: 'Deprecated — replaced by FunctionAmended (v12-20-09). Replayed, never written.', emitters: ['agent'], hasPairedLifecycle: false, deprecatedBy: 'FunctionAmended' },
  { eventType: 'EdgeFunctionRetired', mdmAddress: `${R}/function-registry/edge-function-retired`, category: 'function-registry', description: 'Deprecated — replaced by FunctionRetired (v12-20-09). Replayed, never written.', emitters: ['agent'], hasPairedLifecycle: false, deprecatedBy: 'FunctionRetired' },
  { eventType: 'GroupMemberCreated', mdmAddress: `${R}/group-membership/member-created`, category: 'group-membership', description: 'Deprecated — replaced by GroupMemberAdded (v12-20-05-groups)', emitters: ['agent', 'cid-agent'], hasPairedLifecycle: true, pairedEventType: 'GroupMemberDeactivated', deprecatedBy: 'GroupMemberAdded' },
  { eventType: 'GroupMemberActivated', mdmAddress: `${R}/group-membership/member-activated`, category: 'group-membership', description: 'Group member activated', emitters: ['agent', 'cid-agent'], hasPairedLifecycle: true, pairedEventType: 'GroupMemberSuspended' },
  { eventType: 'GroupMemberSuspended', mdmAddress: `${R}/group-membership/member-suspended`, category: 'group-membership', description: 'Group member suspended', emitters: ['agent', 'cid-agent'], hasPairedLifecycle: true, pairedEventType: 'GroupMemberReActivated' },
  { eventType: 'GroupMemberReActivated', mdmAddress: `${R}/group-membership/member-reactivated`, category: 'group-membership', description: 'Group member reactivated', emitters: ['agent', 'cid-agent'], hasPairedLifecycle: true, pairedEventType: 'GroupMemberSuspended' },
  { eventType: 'GroupMemberDeactivated', mdmAddress: `${R}/group-membership/member-deactivated`, category: 'group-membership', description: 'Deprecated — replaced by GroupMemberRemoved (v12-20-05-groups)', emitters: ['agent', 'cid-agent'], hasPairedLifecycle: true, pairedEventType: 'GroupMemberCreated', deprecatedBy: 'GroupMemberRemoved' },
  // ── Identity, keys and trust (v15-09-00, src/lib/identity/, identity-disclosure.bpmn) ──
  // Claims and attestations are ContentCreated subclasses routed to the identity
  // subtree; disclosure follows requester-sends-XRequested, decider replies.
  { eventType: 'KeyDeclared', mdmAddress: `${R}/identity/key-declared`, category: 'identity', canonicalType: 'ContentCreated', description: 'Wallet-signed statement that a key (hello, tls, signing, encryption) speaks for the wallet until it expires', emitters: ['wallet'], hasPairedLifecycle: true, pairedEventType: 'KeyDeclarationRevoked' },
  { eventType: 'KeyDeclarationRevoked', mdmAddress: `${R}/identity/key-declaration-revoked`, category: 'identity', description: 'Wallet-signed revocation of one key declaration (by declaration hash); replayed by every verifier', emitters: ['wallet'], hasPairedLifecycle: true, pairedEventType: 'KeyDeclared' },
  { eventType: 'KeyDelegated', mdmAddress: `${R}/identity/key-delegated`, category: 'identity', canonicalType: 'ContentCreated', description: 'A declared key binds a short-lived key (e.g. an in-memory TLS key) for one purpose', emitters: ['wallet', 'agent'], hasPairedLifecycle: false },
  { eventType: 'IdentityClaimRecorded', mdmAddress: `${R}/identity/claim-recorded`, category: 'identity', canonicalType: 'ContentCreated', description: 'A salted claim digest in the holder identity wallet; the value stays encrypted in the wallet', emitters: ['wallet'], hasPairedLifecycle: true, pairedEventType: 'IdentityClaimRevoked' },
  { eventType: 'IdentityClaimAmended', mdmAddress: `${R}/identity/claim-amended`, category: 'identity', canonicalType: 'ContentAmended', description: 'A new version of a claim naming the claim it amends', emitters: ['wallet'], hasPairedLifecycle: false },
  { eventType: 'IdentityClaimRevoked', mdmAddress: `${R}/identity/claim-revoked`, category: 'identity', description: 'Holder withdraws a claim from future disclosures (past disclosures stay delivered)', emitters: ['wallet'], hasPairedLifecycle: true, pairedEventType: 'IdentityClaimRecorded' },
  { eventType: 'IdentityAttested', mdmAddress: `${R}/identity/attested`, category: 'identity', canonicalType: 'ContentCreated', description: 'Issuer-signed attestation over claim digests with its evidence level (NIST 800-63 IAL)', emitters: ['wallet', 'agent'], hasPairedLifecycle: true, pairedEventType: 'IdentityAttestationRevoked' },
  { eventType: 'IdentityAttestationRevoked', mdmAddress: `${R}/identity/attestation-revoked`, category: 'identity', description: 'Issuer revokes an attestation it signed', emitters: ['wallet', 'agent'], hasPairedLifecycle: true, pairedEventType: 'IdentityAttested' },
  { eventType: 'BiometricBindingRecorded', mdmAddress: `${R}/identity/biometric-binding-recorded`, category: 'identity', canonicalType: 'ContentCreated', description: 'A device authenticator (WebAuthn) bound to the identity; only a credential-id hash, never a biometric template', emitters: ['wallet'], hasPairedLifecycle: false },
  { eventType: 'IdentityDisclosureRequested', mdmAddress: `${R}/identity/disclosure-requested`, category: 'identity', description: 'Verifier asks a holder for named claims, with purpose and nonce', emitters: ['wallet', 'agent'], hasPairedLifecycle: false },
  { eventType: 'IdentityDisclosed', mdmAddress: `${R}/identity/disclosed`, category: 'identity', description: 'Holder answers a disclosure request: the chosen disclosures sealed to the verifier, bound to the nonce', emitters: ['wallet'], hasPairedLifecycle: false },
  { eventType: 'LegacyVerifierRetired', mdmAddress: `${R}/identity/legacy-verifier-retired`, category: 'identity', description: 'An admin retires a legacy verifier (e.g. a PHP route signature check) on a shadow-comparison report: names the route, the report hash, agreement and stricter reasons; TLS and regulator-required X.509 are kept', emitters: ['wallet', 'agent'], hasPairedLifecycle: false },
  // ── Legacy port (v15-12-00, src/lib/legacyPort, legacy-port.bpmn) ──
  { eventType: 'LegacyRouteCutOver', mdmAddress: `${R}/migration/legacy-route-cut-over`, category: 'migration', description: 'A route of a legacy app (e.g. a PHP endpoint) is served by its port instead of the legacy runtime, on a response-shadow report that passed the gate: names the route, the report hash, requests, days and match rate, and the operator wallet; signed by the edge node', emitters: ['agent', 'wallet'], hasPairedLifecycle: false },
  { eventType: 'LegacyRouteRolledBack', mdmAddress: `${R}/migration/legacy-route-rolled-back`, category: 'migration', description: 'A route is sent back to the legacy runtime (or to shadow) with the reason; its comparison evidence starts again', emitters: ['agent', 'wallet'], hasPairedLifecycle: false },
  { eventType: 'IdentityDisclosureDeclined', mdmAddress: `${R}/identity/disclosure-declined`, category: 'identity', description: 'Holder declines a disclosure request with a reason', emitters: ['wallet'], hasPairedLifecycle: false },

  // ── DMZ quarantine (v15-09-00, src/lib/sync/quarantine.ts, dmz-quarantine.bpmn) ──
  { eventType: 'ContentQuarantined', mdmAddress: `${R}/dmz/content-quarantined`, category: 'dmz', canonicalType: 'ContentCreated', description: 'A file from an untrusted sender (HTTP drop, FTP/SFTP pull) held by hash in the DMZ node quarantine', emitters: ['agent', 'wallet'], hasPairedLifecycle: false },
  { eventType: 'QuarantineCheckRecorded', mdmAddress: `${R}/dmz/quarantine-check-recorded`, category: 'dmz', description: 'One check on a quarantined file: pass, fail or not-evaluated, with the reason', emitters: ['agent', 'wallet'], hasPairedLifecycle: false },
  { eventType: 'ContentReleased', mdmAddress: `${R}/dmz/content-released`, category: 'dmz', description: 'A quarantined file released to internal clients (policy: every required check passed, or an operator decision)', emitters: ['agent', 'wallet'], hasPairedLifecycle: false },
  { eventType: 'ContentRejected', mdmAddress: `${R}/dmz/content-rejected`, category: 'dmz', description: 'A quarantined file refused with the failed check or the operator reason; the bytes are not released', emitters: ['agent', 'wallet'], hasPairedLifecycle: false },

  { eventType: 'EventTypeDeprecated', mdmAddress: `${R}/mdm-graph/event-type-deprecated`, category: 'mdm-graph', description: 'Records that an event type is retired; payload { eventType, replacedBy }', emitters: ['wallet', 'agent', 'skill'], hasPairedLifecycle: false },

  // ── CID Lifecycle ──
  { eventType: 'ReleasePlanCreationRequested', mdmAddress: `${R}/cid/release-plan-creation-requested`, category: 'cid', description: 'Admin-signed request to create release plan', emitters: ['cid-agent'], hasPairedLifecycle: false },
  { eventType: 'ReleasePlanExecutionRequested', mdmAddress: `${R}/cid/release-plan-execution-requested`, category: 'cid', description: 'Dual-sig request to execute release plan', emitters: ['cid-agent'], hasPairedLifecycle: false },
  { eventType: 'ReleasePlanCreated', mdmAddress: `${R}/cid/release-plan-created`, category: 'cid', description: 'Release plan created with step provenance', emitters: ['cid-agent'], hasPairedLifecycle: false },
  { eventType: 'ReleasePlanExecutionStarted', mdmAddress: `${R}/cid/release-plan-execution-started`, category: 'cid', description: 'Release plan execution pipeline started', emitters: ['cid-agent'], hasPairedLifecycle: false },
  { eventType: 'ReleasePlanExecutionCompleted', mdmAddress: `${R}/cid/release-plan-execution-completed`, category: 'cid', description: 'Release plan execution completed (success or failed)', emitters: ['cid-agent'], hasPairedLifecycle: false },
  { eventType: 'ReleasePlanStepExecuted', mdmAddress: `${R}/cid/release-plan-step-executed`, category: 'cid', description: 'Individual release plan step executed with receipt', emitters: ['cid-agent'], hasPairedLifecycle: false },
  { eventType: 'ConstituentCreated', mdmAddress: `${R}/cid/constituent-created`, category: 'cid', description: 'Links parent constituent to child in HD hierarchy (canon→book, book→chapter, chapter→verse)', emitters: ['cid-agent', 'skill'], hasPairedLifecycle: true, pairedEventType: 'ConstituentRemoved' },
  { eventType: 'ConstituentRemoved', mdmAddress: `${R}/cid/constituent-removed`, category: 'cid', description: 'Removes constituent link from release plan', emitters: ['cid-agent'], hasPairedLifecycle: true, pairedEventType: 'ConstituentCreated' },
  { eventType: 'ConstituentIngestFailed', mdmAddress: `${R}/cid/constituent-ingest-failed`, category: 'cid', description: 'Constituent ingestion failed — error captured', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'ConstituentIngestSuspended', mdmAddress: `${R}/cid/constituent-ingest-suspended`, category: 'cid', description: 'Constituent ingestion suspended (recoverable)', emitters: ['skill'], hasPairedLifecycle: true, pairedEventType: 'ConstituentIngestResumed' },
  { eventType: 'ConstituentIngestResumed', mdmAddress: `${R}/cid/constituent-ingest-resumed`, category: 'cid', description: 'Constituent ingestion resumed from suspension', emitters: ['skill'], hasPairedLifecycle: true, pairedEventType: 'ConstituentIngestSuspended' },
  { eventType: 'CloneStateSynced', mdmAddress: `${R}/cid/clone-state-synced`, category: 'cid', description: 'Clone state synced to cappz.ai mirror', emitters: ['cid-agent', 'domain-agent'], hasPairedLifecycle: false },
  { eventType: 'CloneLearningPromoted', mdmAddress: `${R}/cid/clone-learning-promoted`, category: 'cid', description: 'Local clone learning promoted autonomously', emitters: ['cid-agent'], hasPairedLifecycle: false },

  // ── Clone/Upgrade Lifecycle ──
  { eventType: 'SkillCloneCreated', mdmAddress: `${R}/clone/skill-clone-created`, category: 'clone', canonicalType: 'ContentCloned', description: 'Skill cloned from parent template', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'SkillUpgradeRequested', mdmAddress: `${R}/clone/skill-upgrade-requested`, category: 'clone', description: 'Upgrade requested from parent version', emitters: ['skill', 'cid-agent'], hasPairedLifecycle: false },
  { eventType: 'SkillUpgradeApplied', mdmAddress: `${R}/clone/skill-upgrade-applied`, category: 'clone', description: 'Upgrade applied from parent version', emitters: ['skill', 'cid-agent'], hasPairedLifecycle: false },
  { eventType: 'BuildLogSynced', mdmAddress: `${R}/clone/build-log-synced`, category: 'clone', description: 'Build log entries synced to parent template', emitters: ['cid-agent'], hasPairedLifecycle: false },
  { eventType: 'AgentSkillScopeCreated', mdmAddress: `${R}/clone/agent-skill-scope-created`, category: 'clone', description: 'Agent skill scope created for user clone', emitters: ['agent'], hasPairedLifecycle: false },

  // ── WalletAgent Configuration ──
  { eventType: 'NotarizeEachOnSaveCreated', mdmAddress: `${R}/config/notarize-each-created`, category: 'config', description: 'Enable per-save notarization', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'NotarizeEachOnSaveDeprecated' },
  { eventType: 'NotarizeEachOnSaveDeprecated', mdmAddress: `${R}/config/notarize-each-deprecated`, category: 'config', description: 'Disable per-save notarization', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'NotarizeEachOnSaveCreated' },
  { eventType: 'NotarizeAllOnSaveCreated', mdmAddress: `${R}/config/notarize-all-created`, category: 'config', description: 'Enable batch notarization', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'NotarizeAllOnSaveDeprecated' },
  { eventType: 'NotarizeAllOnSaveDeprecated', mdmAddress: `${R}/config/notarize-all-deprecated`, category: 'config', description: 'Disable batch notarization', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'NotarizeAllOnSaveCreated' },
  { eventType: 'A2ATransceiverCreated', mdmAddress: `${R}/config/a2a-transceiver-created`, category: 'config', description: 'Enable A2A transceiver mode', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'A2ATransceiverDeprecated' },
  { eventType: 'A2ATransceiverDeprecated', mdmAddress: `${R}/config/a2a-transceiver-deprecated`, category: 'config', description: 'Disable A2A transceiver', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'A2ATransceiverCreated' },
  { eventType: 'A2AReceiverCreated', mdmAddress: `${R}/config/a2a-receiver-created`, category: 'config', description: 'Enable A2A receive-only', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'A2AReceiverDeprecated' },
  { eventType: 'A2AReceiverDeprecated', mdmAddress: `${R}/config/a2a-receiver-deprecated`, category: 'config', description: 'Disable A2A receive-only', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'A2AReceiverCreated' },
  { eventType: 'A2ATransmitterCreated', mdmAddress: `${R}/config/a2a-transmitter-created`, category: 'config', description: 'Enable A2A transmit-only', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'A2ATransmitterDeprecated' },
  { eventType: 'A2ATransmitterDeprecated', mdmAddress: `${R}/config/a2a-transmitter-deprecated`, category: 'config', description: 'Disable A2A transmit-only', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'A2ATransmitterCreated' },
  { eventType: 'SynchronizeEachOnSaveCreated', mdmAddress: `${R}/config/sync-each-created`, category: 'config', description: 'Enable per-save sync', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'SynchronizeEachOnSaveDeprecated' },
  { eventType: 'SynchronizeEachOnSaveDeprecated', mdmAddress: `${R}/config/sync-each-deprecated`, category: 'config', description: 'Disable per-save sync', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'SynchronizeEachOnSaveCreated' },
  { eventType: 'SynchronizeAllOnSaveCreated', mdmAddress: `${R}/config/sync-all-created`, category: 'config', description: 'Enable batch sync', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'SynchronizeAllOnSaveDeprecated' },
  { eventType: 'SynchronizeAllOnSaveDeprecated', mdmAddress: `${R}/config/sync-all-deprecated`, category: 'config', description: 'Disable batch sync', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'SynchronizeAllOnSaveCreated' },
  { eventType: 'EncryptAtRestCreated', mdmAddress: `${R}/config/encrypt-rest-created`, category: 'config', description: 'Enable encryption at rest', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'EncryptAtRestDeprecated' },
  { eventType: 'EncryptAtRestDeprecated', mdmAddress: `${R}/config/encrypt-rest-deprecated`, category: 'config', description: 'Disable encryption at rest', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'EncryptAtRestCreated' },
  { eventType: 'EncryptInTransitCreated', mdmAddress: `${R}/config/encrypt-transit-created`, category: 'config', description: 'Enable encryption in transit', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'EncryptInTransitDeprecated' },
  { eventType: 'EncryptInTransitDeprecated', mdmAddress: `${R}/config/encrypt-transit-deprecated`, category: 'config', description: 'Disable encryption in transit', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'EncryptInTransitCreated' },
  { eventType: 'RetentionPruneOnWindowCreated', mdmAddress: `${R}/config/retention-prune-created`, category: 'config', description: 'Enable retention pruning', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'RetentionPruneOnWindowDeprecated' },
  { eventType: 'RetentionPruneOnWindowDeprecated', mdmAddress: `${R}/config/retention-prune-deprecated`, category: 'config', description: 'Disable retention pruning', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'RetentionPruneOnWindowCreated' },
  { eventType: 'RetentionArchiveOnSaveCreated', mdmAddress: `${R}/config/retention-archive-created`, category: 'config', description: 'Enable save-time archival', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'RetentionArchiveOnSaveDeprecated' },
  { eventType: 'RetentionArchiveOnSaveDeprecated', mdmAddress: `${R}/config/retention-archive-deprecated`, category: 'config', description: 'Disable save-time archival', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'RetentionArchiveOnSaveCreated' },
  { eventType: 'CompressionOnSaveCreated', mdmAddress: `${R}/config/compression-created`, category: 'config', description: 'Enable save-time compression', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'CompressionOnSaveDeprecated' },
  { eventType: 'CompressionOnSaveDeprecated', mdmAddress: `${R}/config/compression-deprecated`, category: 'config', description: 'Disable save-time compression', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'CompressionOnSaveCreated' },
  { eventType: 'HibernationAutoCreated', mdmAddress: `${R}/config/hibernation-auto-created`, category: 'config', description: 'Enable auto-hibernation', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'HibernationAutoDeprecated' },
  { eventType: 'HibernationAutoDeprecated', mdmAddress: `${R}/config/hibernation-auto-deprecated`, category: 'config', description: 'Disable auto-hibernation', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'HibernationAutoCreated' },
  { eventType: 'FeeTierOverrideCreated', mdmAddress: `${R}/config/fee-tier-override-created`, category: 'config', description: 'Set fee tier override', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'FeeTierOverrideDeprecated' },
  { eventType: 'FeeTierOverrideDeprecated', mdmAddress: `${R}/config/fee-tier-override-deprecated`, category: 'config', description: 'Remove fee tier override', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'FeeTierOverrideCreated' },
  { eventType: 'ProvenanceTrackingCreated', mdmAddress: `${R}/config/provenance-tracking-created`, category: 'config', description: 'Enable provenance tracking', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'ProvenanceTrackingDeprecated' },
  { eventType: 'ProvenanceTrackingDeprecated', mdmAddress: `${R}/config/provenance-tracking-deprecated`, category: 'config', description: 'Disable provenance tracking', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'ProvenanceTrackingCreated' },
  { eventType: 'MDMBindingCreated', mdmAddress: `${R}/config/mdm-binding-created`, category: 'config', description: 'Create MDM binding for agent', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'MDMBindingDeprecated' },
  { eventType: 'MDMBindingDeprecated', mdmAddress: `${R}/config/mdm-binding-deprecated`, category: 'config', description: 'Deprecate MDM binding', emitters: ['agent'], hasPairedLifecycle: true, pairedEventType: 'MDMBindingCreated' },

  // ── Content / Ingest ──
  { eventType: 'ContentIngested', mdmAddress: `${R}/content/content-ingested`, category: 'content', canonicalType: 'ContentCreated', description: 'Content ingested into agent scope', emitters: ['agent', 'skill'], hasPairedLifecycle: false },
  { eventType: 'ContentFragmented', mdmAddress: `${R}/content/content-fragmented`, category: 'content', description: 'Content fragmented into shreds', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'ContentTranslated', mdmAddress: `${R}/content/content-translated`, category: 'content', description: 'Content translated between formats', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'WalletBlobSerialized', mdmAddress: `${R}/content/wallet-blob-serialized`, category: 'content', description: 'Wallet content reduced to immutable {slug}-v{n}.cappz blob on OPFS; sha256 + origins published', emitters: ['skill'], hasPairedLifecycle: false },

  // ── Pipeline ──
  { eventType: 'PipelineStageCompleted', mdmAddress: `${R}/pipeline/stage-completed`, category: 'pipeline', description: 'Pipeline stage completed successfully', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'PipelineStageFailed', mdmAddress: `${R}/pipeline/stage-failed`, category: 'pipeline', description: 'Pipeline stage failed', emitters: ['skill'], hasPairedLifecycle: false },

  // ── MDM Graph Structure ──
  { eventType: 'CodeValueCreated', mdmAddress: `${R}/mdm-graph/code-value-created`, category: 'mdm-graph', canonicalType: 'ContentCreated', description: 'Code value registered in MDM', emitters: ['skill'], hasPairedLifecycle: true, pairedEventType: 'CodeValueDeprecated' },
  { eventType: 'CodeValueDeprecated', mdmAddress: `${R}/mdm-graph/code-value-deprecated`, category: 'mdm-graph', canonicalType: 'ContentDeprecated', description: 'Code value deprecated in MDM', emitters: ['skill'], hasPairedLifecycle: true, pairedEventType: 'CodeValueCreated' },
  { eventType: 'VersionCreated', mdmAddress: `${R}/mdm-graph/version-created`, category: 'mdm-graph', description: 'Version entry created', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'VersionAssociated', mdmAddress: `${R}/mdm-graph/version-associated`, category: 'mdm-graph', description: 'Version associated to artifact', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'SkillBindingCreated', mdmAddress: `${R}/mdm-graph/skill-binding-created`, category: 'mdm-graph', description: 'Skill binding created in graph', emitters: ['skill'], hasPairedLifecycle: true, pairedEventType: 'SkillBindingDeprecated' },
  { eventType: 'SkillBindingDeprecated', mdmAddress: `${R}/mdm-graph/skill-binding-deprecated`, category: 'mdm-graph', description: 'Skill binding deprecated', emitters: ['skill'], hasPairedLifecycle: true, pairedEventType: 'SkillBindingCreated' },
  { eventType: 'SkillBindingActivated', mdmAddress: `${R}/mdm-graph/skill-binding-activated`, category: 'mdm-graph', description: 'Skill binding activated — canon is live for user', emitters: ['skill'], hasPairedLifecycle: true, pairedEventType: 'SkillBindingDeactivated' },
  { eventType: 'SkillBindingDeactivated', mdmAddress: `${R}/mdm-graph/skill-binding-deactivated`, category: 'mdm-graph', description: 'Skill binding deactivated — canon inactive', emitters: ['skill'], hasPairedLifecycle: true, pairedEventType: 'SkillBindingActivated' },
  { eventType: 'SkillConstituentIncluded', mdmAddress: `${R}/mdm-graph/skill-constituent-included`, category: 'mdm-graph', description: 'Skill constituent included', emitters: ['skill'], hasPairedLifecycle: true, pairedEventType: 'SkillConstituentRemoved' },
  { eventType: 'SkillConstituentRemoved', mdmAddress: `${R}/mdm-graph/skill-constituent-removed`, category: 'mdm-graph', description: 'Skill constituent removed', emitters: ['skill'], hasPairedLifecycle: true, pairedEventType: 'SkillConstituentIncluded' },
  { eventType: 'DomainRegistered', mdmAddress: `${R}/mdm-graph/domain-registered`, category: 'mdm-graph', description: 'Domain registered in MDM', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'StandardRegistered', mdmAddress: `${R}/mdm-graph/standard-registered`, category: 'mdm-graph', description: 'Standard registered in MDM', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'ArtifactGroupCreated', mdmAddress: `${R}/mdm-graph/artifact-group-created`, category: 'mdm-graph', description: 'Artifact group created', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'ListDomainCreated', mdmAddress: `${R}/mdm-graph/list-domain-created`, category: 'mdm-graph', canonicalType: 'ContentCreated', description: 'List domain created', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'ListValueCreated', mdmAddress: `${R}/mdm-graph/list-value-created`, category: 'mdm-graph', canonicalType: 'ContentCreated', description: 'List value created', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'ValueMappingCreated', mdmAddress: `${R}/mdm-graph/value-mapping-created`, category: 'mdm-graph', description: 'Value mapping created', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'RoyaltyFeeAmended', mdmAddress: `${R}/mdm-graph/royalty-fee-amended`, category: 'mdm-graph', description: 'Royalty fee structure amended', emitters: ['skill'], hasPairedLifecycle: false },

  // ── Migration ──
  { eventType: 'MigrationInitiated', mdmAddress: `${R}/migration/initiated`, category: 'migration', description: 'DB migration initiated', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'MigrationResumed', mdmAddress: `${R}/migration/resumed`, category: 'migration', description: 'DB migration resumed from checkpoint', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'MigrationCheckpointCompleted', mdmAddress: `${R}/migration/checkpoint-completed`, category: 'migration', description: 'Migration checkpoint saved', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'MigrationSuspended', mdmAddress: `${R}/migration/suspended`, category: 'migration', description: 'Migration suspended on error', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'MigrationCompleted', mdmAddress: `${R}/migration/completed`, category: 'migration', description: 'Migration completed successfully', emitters: ['skill'], hasPairedLifecycle: false },

  // ── Bridge ──
  { eventType: 'BridgeSessionCreated', mdmAddress: `${R}/bridge/session-created`, category: 'bridge', description: 'Bridge session wallet created', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'BridgeFiatReceived', mdmAddress: `${R}/bridge/fiat-received`, category: 'bridge', description: 'Fiat payment received via bridge', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'BridgeXRPConverted', mdmAddress: `${R}/bridge/xrp-converted`, category: 'bridge', description: 'Fiat converted to XRP', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'BridgeCAPPZMinted', mdmAddress: `${R}/bridge/cappz-minted`, category: 'bridge', description: 'CAPPZ minted from XRP', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'BridgeCompleted', mdmAddress: `${R}/bridge/completed`, category: 'bridge', description: 'Bridge transaction completed', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'BridgeFailed', mdmAddress: `${R}/bridge/failed`, category: 'bridge', description: 'Bridge transaction failed', emitters: ['skill'], hasPairedLifecycle: false },

  // ── Async Response (sync-on-async protocol) ──
  { eventType: 'AsyncResponseFetched', mdmAddress: `${R}/content/async-response-fetched`, category: 'content', description: 'Async response fetched — gates callback notification', emitters: ['agent', 'skill'], hasPairedLifecycle: false },

  // ── Ordered List (TX Linked List — AX-41) ──
  { eventType: 'PredecessorAssigned', mdmAddress: `${R}/ordered-list/predecessor-assigned`, category: 'ordered-list', description: 'Assigns predecessor in TX-linked ordered list (source=next, target=previous)', emitters: ['agent', 'skill', 'cid-agent'], hasPairedLifecycle: true, pairedEventType: 'PredecessorDeprecated' },
  { eventType: 'PredecessorDeprecated', mdmAddress: `${R}/ordered-list/predecessor-deprecated`, category: 'ordered-list', description: 'Deprecates predecessor assignment (correlated to replacement PredecessorAssigned)', emitters: ['agent', 'skill', 'cid-agent'], hasPairedLifecycle: true, pairedEventType: 'PredecessorAssigned' },

  // ── BPMN/Blockchain Integration (AX-42) ──
  { eventType: 'BPMNFlowAnchored', mdmAddress: `${R}/bpmn/flow-anchored`, category: 'pipeline', description: 'Sequence flow registered as TX link between BPMN elements', emitters: ['skill'], hasPairedLifecycle: true, pairedEventType: 'BPMNFlowDeprecated' },
  { eventType: 'BPMNFlowDeprecated', mdmAddress: `${R}/bpmn/flow-deprecated`, category: 'pipeline', description: 'Sequence flow deprecated (re-routing)', emitters: ['skill'], hasPairedLifecycle: true, pairedEventType: 'BPMNFlowAnchored' },
  { eventType: 'BPMNSkillCallBound', mdmAddress: `${R}/bpmn/skill-call-bound`, category: 'pipeline', description: 'CallActivity bound to sub-skill MDM address + process', emitters: ['skill'], hasPairedLifecycle: true, pairedEventType: 'BPMNSkillCallUnbound' },
  { eventType: 'BPMNSkillCallUnbound', mdmAddress: `${R}/bpmn/skill-call-unbound`, category: 'pipeline', description: 'CallActivity unbound from sub-skill', emitters: ['skill'], hasPairedLifecycle: true, pairedEventType: 'BPMNSkillCallBound' },
  { eventType: 'BPMNProcessCloneMirrored', mdmAddress: `${R}/bpmn/process-clone-mirrored`, category: 'clone', description: 'Template BPMN config mirrored to clone via TXs', emitters: ['skill', 'cid-agent'], hasPairedLifecycle: false },
  { eventType: 'BPMNProcessVersionCreated', mdmAddress: `${R}/bpmn/process-version-created`, category: 'pipeline', description: 'New BPMN process version created', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'BPMNProcessVersionAmended', mdmAddress: `${R}/bpmn/process-version-amended`, category: 'pipeline', description: 'BPMN process version amended (re-sequenced/modified)', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'BPMNGatewayRouteAnchored', mdmAddress: `${R}/bpmn/gateway-route-anchored`, category: 'pipeline', description: 'Gateway branch routes registered on-chain', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'BPMNPipelineSequenced', mdmAddress: `${R}/bpmn/pipeline-sequenced`, category: 'pipeline', description: 'Pipeline config sequenced via BPMN inheritance', emitters: ['skill'], hasPairedLifecycle: false },

  // ── Duplicate TX Remediation (AX-43) ──
  { eventType: 'DuplicateTxDeprecated', mdmAddress: `${R}/cid/duplicate-tx-deprecated`, category: 'cid', description: 'Deprecates a duplicate TX — retains oldest, supersedes newer duplicates via correlation', emitters: ['skill', 'cid-agent'], hasPairedLifecycle: false },
  { eventType: 'DuplicateTxRemediationCompleted', mdmAddress: `${R}/cid/duplicate-tx-remediation-completed`, category: 'cid', description: 'Audit report of completed duplicate TX remediation run', emitters: ['skill', 'cid-agent'], hasPairedLifecycle: false },

  // ── Resource Access Protocol (RAP Adapter — Skill #78) ──
  { eventType: 'AccessRequestCreated', mdmAddress: `${R}/rap/access-request-created`, category: 'admin-queue', description: 'Resource access request submitted', emitters: ['agent', 'skill'], hasPairedLifecycle: false },
  { eventType: 'AccessGranted', mdmAddress: `${R}/rap/access-granted`, category: 'admin-queue', description: 'Resource access granted — linked to request via PredecessorAssigned', emitters: ['agent', 'skill'], hasPairedLifecycle: true, pairedEventType: 'AccessRevoked' },
  { eventType: 'AccessRevoked', mdmAddress: `${R}/rap/access-revoked`, category: 'admin-queue', description: 'Resource access revoked — supersedes grant TX', emitters: ['agent', 'skill'], hasPairedLifecycle: true, pairedEventType: 'AccessGranted' },
  { eventType: 'AccessExpired', mdmAddress: `${R}/rap/access-expired`, category: 'admin-queue', description: 'Resource access expired (TTL)', emitters: ['agent', 'skill'], hasPairedLifecycle: false },
  { eventType: 'AccessConsumed', mdmAddress: `${R}/rap/access-consumed`, category: 'admin-queue', description: 'Access consumption event (MAC counter)', emitters: ['agent', 'skill'], hasPairedLifecycle: false },
  { eventType: 'AdminGrantPropagated', mdmAddress: `${R}/rap/admin-grant-propagated`, category: 'admin-queue', description: 'Grant cascaded from parent clone to child clones', emitters: ['agent', 'skill'], hasPairedLifecycle: false },

  // ── Access Control Protocol (ACP) ──
  { eventType: 'ClonePermissionRequested', mdmAddress: `${R}/acp/clone-permission-requested`, category: 'clone', description: 'Request to clone a skill/wallet', emitters: ['agent', 'skill'], hasPairedLifecycle: false },
  { eventType: 'ClonePermissionGranted', mdmAddress: `${R}/acp/clone-permission-granted`, category: 'clone', description: 'Clone permission granted — admin to parent agent', emitters: ['agent', 'skill'], hasPairedLifecycle: true, pairedEventType: 'ClonePermissionRevoked' },
  { eventType: 'ClonePermissionRevoked', mdmAddress: `${R}/acp/clone-permission-revoked`, category: 'clone', description: 'Clone permission revoked — correlates to Grant TxID', emitters: ['agent', 'skill'], hasPairedLifecycle: true, pairedEventType: 'ClonePermissionGranted' },
  { eventType: 'CopyPermissionRequested', mdmAddress: `${R}/acp/copy-permission-requested`, category: 'clone', description: 'Request to copy a skill/wallet', emitters: ['agent', 'skill'], hasPairedLifecycle: false },
  { eventType: 'CopyPermissionGranted', mdmAddress: `${R}/acp/copy-permission-granted`, category: 'clone', description: 'Copy permission granted — to admin group address', emitters: ['agent', 'skill'], hasPairedLifecycle: true, pairedEventType: 'CopyPermissionRevoked' },
  { eventType: 'CopyPermissionRevoked', mdmAddress: `${R}/acp/copy-permission-revoked`, category: 'clone', description: 'Copy permission revoked — correlates to Grant TxID', emitters: ['agent', 'skill'], hasPairedLifecycle: true, pairedEventType: 'CopyPermissionGranted' },
  { eventType: 'OperatePermissionRequested', mdmAddress: `${R}/acp/operate-permission-requested`, category: 'clone', description: 'Request to operate cloned asset — with payment', emitters: ['agent', 'skill'], hasPairedLifecycle: false },
  { eventType: 'OperatePermissionGranted', mdmAddress: `${R}/acp/operate-permission-granted`, category: 'clone', description: 'Operate permission granted — from cloned UCL to user admin queue', emitters: ['agent', 'skill'], hasPairedLifecycle: true, pairedEventType: 'OperatePermissionRevoked' },
  { eventType: 'OperatePermissionRevoked', mdmAddress: `${R}/acp/operate-permission-revoked`, category: 'clone', description: 'Operate permission revoked — correlates to Grant TxID', emitters: ['agent', 'skill'], hasPairedLifecycle: true, pairedEventType: 'OperatePermissionGranted' },

  // ── User Codex Library (UCL — Skill #82) ──
  { eventType: 'LibraryCreated', mdmAddress: `${R}/codex/library-created`, category: 'content', description: 'User Codex Library provisioned on demand under user-wallet agent', emitters: ['agent', 'skill'], hasPairedLifecycle: false },
  { eventType: 'CanonSkillAdded', mdmAddress: `${R}/codex/canon-skill-added`, category: 'content', description: '[DEPRECATED — use SkillBindingCreated] Canon skill added to user library', emitters: ['agent', 'skill'], hasPairedLifecycle: true, pairedEventType: 'CanonSkillRemoved' },
  { eventType: 'CanonSkillRemoved', mdmAddress: `${R}/codex/canon-skill-removed`, category: 'content', description: '[DEPRECATED — use SkillBindingDeprecated] Canon skill removed from user library', emitters: ['agent', 'skill'], hasPairedLifecycle: true, pairedEventType: 'CanonSkillAdded' },
  { eventType: 'VolumeCreated', mdmAddress: `${R}/codex/volume-created`, category: 'content', description: 'Volume organizational grouping created within a canon skill (default or user-created)', emitters: ['agent', 'skill'], hasPairedLifecycle: true, pairedEventType: 'VolumeDeprecated' },
  { eventType: 'VolumeDeprecated', mdmAddress: `${R}/codex/volume-deprecated`, category: 'content', description: 'Volume deprecated (user-created only)', emitters: ['agent', 'skill'], hasPairedLifecycle: true, pairedEventType: 'VolumeCreated' },
  { eventType: 'VolumeConstituentAdded', mdmAddress: `${R}/codex/volume-constituent-added`, category: 'content', description: 'Book/text assigned to volume at HD address with correlation TX', emitters: ['agent', 'skill'], hasPairedLifecycle: true, pairedEventType: 'VolumeConstituentRemoved' },
  { eventType: 'VolumeConstituentRemoved', mdmAddress: `${R}/codex/volume-constituent-removed`, category: 'content', description: 'Book/text removed from volume', emitters: ['agent', 'skill'], hasPairedLifecycle: true, pairedEventType: 'VolumeConstituentAdded' },

  // ── Codex Cross-Canon Correlation (AX-63) ──
  { eventType: 'EquivalencyDetected', mdmAddress: `${R}/codex/equivalency-detected`, category: 'content', description: 'Cross-canon equivalency detected between HD addresses (parallel-verse, parallel-chapter, parallel-book, thematic, textual-variant)', emitters: ['skill'], hasPairedLifecycle: true, pairedEventType: 'EquivalencyRevoked' },
  { eventType: 'EquivalencyRevoked', mdmAddress: `${R}/codex/equivalency-revoked`, category: 'content', description: 'Cross-canon equivalency revoked — supersedes detection TX', emitters: ['skill'], hasPairedLifecycle: true, pairedEventType: 'EquivalencyDetected' },

  // ── Codex Translation Attribution (AX-64) ──
  { eventType: 'CodexTranslationSourceAssigned', mdmAddress: `${R}/codex/translation-source-assigned`, category: 'content', description: 'Translation source attributed to a language sibling address tree (e.g., R.H. Charles 1896 → ethiopian/english)', emitters: ['skill'], hasPairedLifecycle: false },

  // ── Scope Management (AX-65: Multi-Scope Union) ──
  { eventType: 'ScopeAssigned', mdmAddress: `${R}/scope/scope-assigned`, category: 'scope', description: 'Scope owner authorizes agent to operate in HD subtree', emitters: ['agent', 'skill'], hasPairedLifecycle: true, pairedEventType: 'ScopeDeprecated' },
  { eventType: 'ScopeDeprecated', mdmAddress: `${R}/scope/scope-deprecated`, category: 'scope', description: 'Scope authorization revoked', emitters: ['agent', 'skill'], hasPairedLifecycle: true, pairedEventType: 'ScopeAssigned' },

  // ── Skill Binding (AX-67: Fee-Bearing Skill Binding) ──
  { eventType: 'SkillBindingRequested', mdmAddress: `${R}/skill-binding/binding-requested`, category: 'skill-binding', description: 'User requests skill binding with fee (TX.Amount)', emitters: ['agent', 'skill'], hasPairedLifecycle: false },
  { eventType: 'SkillBindingGranted', mdmAddress: `${R}/skill-binding/binding-granted`, category: 'skill-binding', description: 'Skill template confirms binding, returns skillBinderAdminAddress', emitters: ['agent', 'skill'], hasPairedLifecycle: true, pairedEventType: 'SkillBindingRevoked' },
  { eventType: 'SkillBindingRevoked', mdmAddress: `${R}/skill-binding/binding-revoked`, category: 'skill-binding', description: 'User or template revokes skill binding', emitters: ['agent', 'skill'], hasPairedLifecycle: true, pairedEventType: 'SkillBindingGranted' },
  { eventType: 'SkillBindingRejected', mdmAddress: `${R}/skill-binding/binding-rejected`, category: 'skill-binding', description: 'Template rejects binding (insufficient fee, policy violation)', emitters: ['agent', 'skill'], hasPairedLifecycle: false },

  // ── Local Content Serialization Mode (Domain 11) ──
  { eventType: 'LocalContentSerializationModeAssigned', mdmAddress: `${R}/serialization-local/mode-assigned`, category: 'serialization-local', description: 'Assigns local serialization mode (RAW/ENCRYPTED) to target skill. payload.codeValueHDAddress carries refdata identity.', emitters: ['agent', 'skill'], hasPairedLifecycle: true, pairedEventType: 'LocalContentSerializationModeDeprecated' },
  { eventType: 'LocalContentSerializationModeDeprecated', mdmAddress: `${R}/serialization-local/mode-deprecated`, category: 'serialization-local', description: 'Deprecates local serialization mode assignment. Correlated via orgnlMsgId.', emitters: ['agent', 'skill'], hasPairedLifecycle: true, pairedEventType: 'LocalContentSerializationModeAssigned' },

  // ── On-Chain Content Serialization Mode (Domain 12) ──
  { eventType: 'OnchainContentSerializationModeAssigned', mdmAddress: `${R}/serialization-onchain/mode-assigned`, category: 'serialization-onchain', description: 'Assigns on-chain serialization mode (RAW/ENCRYPTED) to target skill. payload.codeValueHDAddress carries refdata identity.', emitters: ['agent', 'skill'], hasPairedLifecycle: true, pairedEventType: 'OnchainContentSerializationModeDeprecated' },
  { eventType: 'OnchainContentSerializationModeDeprecated', mdmAddress: `${R}/serialization-onchain/mode-deprecated`, category: 'serialization-onchain', description: 'Deprecates on-chain serialization mode assignment. Correlated via orgnlMsgId.', emitters: ['agent', 'skill'], hasPairedLifecycle: true, pairedEventType: 'OnchainContentSerializationModeAssigned' },

  // ── Content Publish Tier Mode (Domain 13) ──
  { eventType: 'ContentPublishTierModeAssigned', mdmAddress: `${R}/publish-tier/mode-assigned`, category: 'publish-tier', description: 'Assigns publish tier (TIER_1_LCP/TIER_2_OCP) to target skill. Multi-select via independent TXs. payload.codeValueHDAddress carries refdata identity.', emitters: ['agent', 'skill'], hasPairedLifecycle: true, pairedEventType: 'ContentPublishTierModeDeprecated' },
  { eventType: 'ContentPublishTierModeDeprecated', mdmAddress: `${R}/publish-tier/mode-deprecated`, category: 'publish-tier', description: 'Deprecates publish tier assignment. Correlated via orgnlMsgId.', emitters: ['agent', 'skill'], hasPairedLifecycle: true, pairedEventType: 'ContentPublishTierModeAssigned' },
  { eventType: 'ContentChunkCreated', mdmAddress: `${R}/publish-tier/content-chunk-created`, category: 'publish-tier', description: 'Chunked memo fragment for content >900 bytes (Tier-2 batching)', emitters: ['agent', 'skill'], hasPairedLifecycle: false },

  // ── Content Access (AX-81: Targeted Content Release grants) ──
  { eventType: 'DecryptionGranted', mdmAddress: `${R}/content-access/decryption-granted`, category: 'content-access', description: 'Target can decrypt Tier 2 on-chain content (passport-gated)', emitters: ['agent', 'skill'], hasPairedLifecycle: true, pairedEventType: 'DecryptionRevoked' },
  { eventType: 'DecryptionRevoked', mdmAddress: `${R}/content-access/decryption-revoked`, category: 'content-access', description: 'Revokes decryption access for target wallet', emitters: ['agent', 'skill'], hasPairedLifecycle: true, pairedEventType: 'DecryptionGranted' },
  { eventType: 'ContentHydrateGranted', mdmAddress: `${R}/content-access/hydrate-granted`, category: 'content-access', description: 'Target can hydrate on-chain content into wallet', emitters: ['agent', 'skill'], hasPairedLifecycle: true, pairedEventType: 'ContentHydrateRevoked' },
  { eventType: 'ContentHydrateRevoked', mdmAddress: `${R}/content-access/hydrate-revoked`, category: 'content-access', description: 'Revokes hydration access for target wallet', emitters: ['agent', 'skill'], hasPairedLifecycle: true, pairedEventType: 'ContentHydrateGranted' },

  // ── Publish Execution & Serialization Swap ──
  { eventType: 'RawContentPublished', mdmAddress: `${R}/publish-execution/raw-content-published`, category: 'publish-execution', description: 'Cleartext content anchored on-chain at target address', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'EncryptedContentPublished', mdmAddress: `${R}/publish-execution/encrypted-content-published`, category: 'publish-execution', description: 'Encrypted content anchored on-chain — carries encryptionTypeHDAddress and encryptionTypeCode', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'ContentPublishSkipped', mdmAddress: `${R}/publish-execution/content-publish-skipped`, category: 'publish-execution', description: 'Idempotent skip — content already at target serialization state', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'ContentIntegrityVerified', mdmAddress: `${R}/publish-execution/content-integrity-verified`, category: 'publish-execution', description: 'Pre-publish SHA-256 hash check passed against last ContentCreated/Amended TX', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'ContentIntegrityFailed', mdmAddress: `${R}/publish-execution/content-integrity-failed`, category: 'publish-execution', description: 'Pre-publish hash mismatch — publish aborted, content may have been tampered', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'SerializationSwapStarted', mdmAddress: `${R}/publish-execution/serialization-swap-started`, category: 'publish-execution', description: 'Hanoi safe-swap initiated at primaryAddress — original backed up to tmpAddress', emitters: ['skill'], hasPairedLifecycle: true, pairedEventType: 'SerializationSwapCompleted' },
  { eventType: 'SerializationSwapCompleted', mdmAddress: `${R}/publish-execution/serialization-swap-completed`, category: 'publish-execution', description: 'Hanoi safe-swap committed — tmpAddress cleaned, primaryAddress has transformed content', emitters: ['skill'], hasPairedLifecycle: true, pairedEventType: 'SerializationSwapStarted' },
  { eventType: 'SerializationSwapFailed', mdmAddress: `${R}/publish-execution/serialization-swap-failed`, category: 'publish-execution', description: 'Hanoi safe-swap failed at step N — recovery needed from last known good TX', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'SerializationRecoveryStarted', mdmAddress: `${R}/publish-execution/serialization-recovery-started`, category: 'publish-execution', description: 'Recovery process walking from last known good publish TX forward', emitters: ['skill'], hasPairedLifecycle: true, pairedEventType: 'SerializationRecoveryCompleted' },
  { eventType: 'SerializationRecoveryCompleted', mdmAddress: `${R}/publish-execution/serialization-recovery-completed`, category: 'publish-execution', description: 'Recovery finished — all addresses verified and restored', emitters: ['skill'], hasPairedLifecycle: true, pairedEventType: 'SerializationRecoveryStarted' },
  { eventType: 'ContentPublishDenied', mdmAddress: `${R}/publish-execution/content-publish-denied`, category: 'publish-execution', description: 'Publish blocked by asymmetric direction rule — e.g. RAW→ENCRYPTED on-chain after cleartext already published is pointless', emitters: ['skill'], hasPairedLifecycle: false },

  // ── Linkage Authorization (AX-87, AX-92, AP-12) — request-response TX pairs ──
  { eventType: 'LinkageAuthRequested', mdmAddress: `${R}/linkage-auth/auth-requested`, category: 'linkage-auth', description: 'Caller requests authorization to add a parent→child constituent linkage in a partition. Awaits Granted or Rejected response correlated by requestId.', emitters: ['agent', 'skill', 'cid-agent'], hasPairedLifecycle: false },
  { eventType: 'LinkageAuthRequestGranted', mdmAddress: `${R}/linkage-auth/auth-request-granted`, category: 'linkage-auth', description: 'Resolver response: linkage authorization granted. Correlated to a LinkageAuthRequested by requestId. Latest-wins vs LinkageAuthRequestRevoked.', emitters: ['agent', 'skill', 'cid-agent'], hasPairedLifecycle: true, pairedEventType: 'LinkageAuthRequestRevoked' },
  { eventType: 'LinkageAuthRequestRejected', mdmAddress: `${R}/linkage-auth/auth-request-rejected`, category: 'linkage-auth', description: 'Resolver response: linkage authorization rejected (LOOPBACK | POLICY_DENIED | PARTITION_MISMATCH | UNKNOWN_PARENT | UNKNOWN_CHILD). Terminal for that requestId.', emitters: ['agent', 'skill', 'cid-agent'], hasPairedLifecycle: false },
  { eventType: 'LinkageAuthRequestRevoked', mdmAddress: `${R}/linkage-auth/auth-request-revoked`, category: 'linkage-auth', description: 'Post-grant retraction. Correlated to the original LinkageAuthRequestGranted by requestId. Latest-wins resolver flips effective state to revoked.', emitters: ['agent', 'cid-agent'], hasPairedLifecycle: true, pairedEventType: 'LinkageAuthRequestGranted' },

  // ── Build Manifest (AX-88, AX-89, AX-90, AX-91) — generated artifact provenance ──
  { eventType: 'ArtifactGenerated', mdmAddress: `${R}/build-manifest/artifact-generated`, category: 'build-manifest', description: 'Dev-time generator emitted a file artifact (e.g. cappzMDMConstants_*.ts). Carries generatedFileHash, generatorVersion, scope, runId. Source TX for the build manifest chain.', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'BuildConstituentIncluded', mdmAddress: `${R}/build-manifest/build-constituent-included`, category: 'build-manifest', description: 'AX-91: Records that a generated PascalName constant resolves to an MDM HD address inside a generated artifact. CPM consumes these at the scope HD address to materialize the constant set in the next bundle.', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'ContentCompressed', mdmAddress: `${R}/build-manifest/content-compressed`, category: 'build-manifest', description: 'v14-16-02: Same content version stored gzip-compressed at the same address. Carries rawHash (notarized identity), compressedHash (check before unzip), codec, sizes. Not a new version.', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'ContentPurged', mdmAddress: `${R}/build-manifest/content-purged`, category: 'build-manifest', description: 'v14-16-03: Intra-wallet accounting from the AgentAdmin address to the original address after a verified ContentArchived + ContentCompressed; the original becomes a <contentPurged> placeholder that never replicates.', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'ReplicantCreated', mdmAddress: `${R}/build-manifest/replicant-created`, category: 'build-manifest', description: 'v14-16-04: Generic Replicator event. A wallet gains a replica copy; from the source wallet to the replica address.', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'ArchiveCreated', mdmAddress: `${R}/build-manifest/archive-created`, category: 'build-manifest', description: 'v14-16-04: Subclass of ReplicantCreated (parent: ReplicantCreated). The replica is a one-way offline archive mirror; same correlationId as its ReplicantCreated.', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'ContentArchived', mdmAddress: `${R}/build-manifest/content-archived`, category: 'build-manifest', description: 'v14-16-03: Archive = replication. From the source address to the archive (replicated) address, issued from the verified one-way a2a-sync delivery receipt.', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'GrantRequested', mdmAddress: `${R}/build-manifest/grant-requested`, category: 'build-manifest', description: 'v14-16-03: An app administrator requests AmendGranted/ReadGranted; the trusted admin-group signer replies correlated.', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'GrantRejected', mdmAddress: `${R}/build-manifest/grant-rejected`, category: 'build-manifest', description: 'v14-16-03: Signer decision refusing a GrantRequested, with reason.', emitters: ['skill'], hasPairedLifecycle: false },
  { eventType: 'ContentExported', mdmAddress: `${R}/build-manifest/content-exported`, category: 'build-manifest', description: 'v14-16-03: Fact — exporter downloaded a cascading wallet export; carries the manifest hash.', emitters: ['skill'], hasPairedLifecycle: false },
];

/**
 * One entry per current name. Hand-declared entries win over the generated
 * vocabularies (EBB, substrate) when a name appears in both — v12-20-06
 * merged six retired `...Tx` names into events that already existed.
 */
const CURRENT_EVENT_TX_ENTRIES: EventTxRegistryEntry[] = (() => {
  const declared = new Set(DECLARED_EVENT_TX_ENTRIES.map((e) => e.eventType));
  const seen = new Set<string>();
  const generated = [...EBB_EVENT_TX_REGISTRY, ...SUBSTRATE_EVENT_TX_REGISTRY].filter((e) => {
    if (declared.has(e.eventType) || seen.has(e.eventType)) return false;
    seen.add(e.eventType);
    return true;
  });
  return [...generated, ...DECLARED_EVENT_TX_ENTRIES];
})();

/**
 * v12-20-06 — every retired `...Tx` name stays declared as a deprecated
 * alias at the address it was recorded under. Replayed, never written.
 */
const RETIRED_EVENT_TX_ENTRIES: EventTxRegistryEntry[] = (() => {
  const current = new Map(CURRENT_EVENT_TX_ENTRIES.map((e) => [e.eventType, e]));
  return RETIRED_TX_EVENT_TYPES.filter((legacy) => !current.has(legacy)).flatMap((legacy) => {
    const successor = DEPRECATED_EVENT_ALIASES[legacy];
    const successorEntry = current.get(successor);
    if (!successorEntry) return [];
    const category = RETIRED_CATEGORY[legacy] ?? successorEntry.category;
    return [{
      eventType: legacy,
      mdmAddress: `${R}/${category}/${kebabEvent(legacy)}`,
      category,
      description: `Deprecated — replaced by ${successor} (v12-20-06). Replayed, never written.`,
      emitters: successorEntry.emitters,
      hasPairedLifecycle: false,
      deprecatedBy: successor,
    }];
  });
})();

export const MDM_EVENT_TX_REGISTRY: EventTxRegistryEntry[] = [
  ...CURRENT_EVENT_TX_ENTRIES,
  ...RETIRED_EVENT_TX_ENTRIES,
];

// ─── Lookup Utilities ───────────────────────────────────────────

const _registryMap = new Map<string, EventTxRegistryEntry>();
for (const entry of MDM_EVENT_TX_REGISTRY) {
  _registryMap.set(entry.eventType, entry);
}

/** Current (non-deprecated) registry entry for any recorded name. */
export function getCurrentEventTxRegistryEntry(eventType: string): EventTxRegistryEntry | undefined {
  return _registryMap.get(canonicalEventType(eventType));
}

export function isEventTypeDeprecated(eventType: string): boolean {
  return Boolean(_registryMap.get(eventType)?.deprecatedBy);
}

/**
 * Look up registry entry by event type.
 */
export function getEventTxRegistryEntry(eventType: string): EventTxRegistryEntry | undefined {
  return _registryMap.get(eventType);
}

/**
 * Check if an event type is MDM-registered.
 */
export function isEventTxRegistered(eventType: string): boolean {
  return _registryMap.has(eventType);
}

/**
 * Get all entries for a category.
 */
export function getEventTxByCategory(category: EventTxCategory): EventTxRegistryEntry[] {
  return MDM_EVENT_TX_REGISTRY.filter(e => e.category === category);
}

/**
 * Get MDM address for an event type.
 */
export function getEventTxMdmAddress(eventType: string): string | undefined {
  return _registryMap.get(eventType)?.mdmAddress;
}

/**
 * Verify a list of event types are all MDM-registered.
 * Returns unregistered event types (empty = all verified).
 */
export function verifyEventTxRegistration(eventTypes: string[]): string[] {
  return eventTypes.filter(et => !_registryMap.has(et));
}

/**
 * Get registry summary statistics.
 */
export function getRegistrySummary(): {
  totalRegistered: number;
  byCategory: Record<string, number>;
  pairedLifecycleCount: number;
  orphanCount: number;
} {
  const byCategory: Record<string, number> = {};
  let pairedCount = 0;
  for (const entry of MDM_EVENT_TX_REGISTRY) {
    byCategory[entry.category] = (byCategory[entry.category] || 0) + 1;
    if (entry.hasPairedLifecycle) pairedCount++;
  }
  return {
    totalRegistered: MDM_EVENT_TX_REGISTRY.length,
    byCategory,
    pairedLifecycleCount: pairedCount,
    orphanCount: 0, // Updated by verification runs
  };
}
