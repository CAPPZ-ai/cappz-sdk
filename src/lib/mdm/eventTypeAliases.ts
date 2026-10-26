import { canonicalizeAddressFields, recordedAddressFormOf } from './canonicalAddress.ts';
/**
 * COPE node crystallized.
 * Node ID: v12-20-06-event-type-aliases
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * One source of truth for retired event names (v12-20-06). Every event that
 * used to carry a `Tx` suffix is renamed; the old name stays MDM-declared as
 * a deprecated alias so replay and custody still recognise transactions that
 * were recorded under it.
 *
 * Translation happens ONLY in memory when events are read. Stored
 * transactions are never rewritten — an entry keeps its recorded name in
 * `recordedEventType`, and `recordedFormOf()` returns the exact bytes that
 * were hashed so integrity checks stay honest.
 *
 * This file has no imports so the MDM registry, the event cache and the
 * server mirror can all share it without cycles.
 */

/** Every `...Tx` name that was MDM-declared before v12-20-06. */
export const RETIRED_TX_EVENT_TYPES: readonly string[] = [
  // v12-20-04 admin names (retired by v12-20-05-groups)
  'LoginRevokedTx', 'LoginRestoredTx', 'SessionsRevokedTx', 'UserInvitedTx', 'PageVisitedTx',
  'LoginRecordedTx', 'AgentRequestRecordedTx', 'SiteNoticePublishedTx', 'SiteNoticeWithdrawnTx',
  'SignupClosedTx', 'SignupOpenedTx',
  'AccountDeclaredTx', 'ActivityRecordedTx', 'AgentBoundTx', 'AgentCommissionCalculatedTx',
  'AllAccessGrantedTx', 'AllAccessRevokedTx', 'AssociationCreatedTx', 'AssociationRemovedTx',
  'BpmnGovernanceBoundTx', 'CashAppliedTx', 'CashReceivedTx', 'ClarificationAnsweredTx',
  'ClarificationRaisedTx', 'ClientBillingTermsDeclaredTx', 'CommissionAccruedTx', 'CommissionAttributionDeclaredTx',
  'CommissionEligibilityPolicyDeclaredTx', 'CommissionEligibilityResolvedTx', 'CommissionRuleDeclaredTx',
  'CommissionRuleDeprecatedTx', 'CommissionRulesetDeclaredTx', 'CommissionTransferredTx',
  'ConstituencyInviteAcceptedTx', 'ConstituencyInviteDeclinedTx', 'ConstituencyInvitedTx',
  'ConstituencyRequestRejectedTx', 'ConstituencyRequestedTx', 'ConstituentCompressedTx',
  'ConstituentCreatedTx', 'ConstituentDeprecatedTx', 'ConstituentIncludedTx', 'ConstituentPartiallyTerminatedTx',
  'ConstituentRemovedTx', 'ConstituentTerminatedTx', 'ConstituentTruncatedTx', 'ConstituentsAggregatedTx',
  'ContextTurnAppendedTx', 'ContractApprovedTx', 'ContractDocumentIngestedTx', 'ContractDraftExtractedTx',
  'ContractRejectedTx', 'ContractValidatedTx', 'CrmIdentityExportedTx', 'CrmRecordCorrelatedTx',
  'DealClonedFromTemplateTx', 'DealCompressedTx', 'DealCreatedTx', 'DealDeprecatedTx', 'DealDraftedTx',
  'DealExecutedTx', 'DealLegAddedTx', 'DealLegAmendedTx', 'DealPartiallyTerminatedTx', 'DealPayableAccountDeclaredTx',
  'DealSerializedTx', 'DealTerminatedTx', 'DealTruncatedTx', 'DealWalletDeclaredTx', 'DelegationGrantedTx',
  'DelegationRevokedTx', 'DeliveryApprovedTx', 'DeliveryRejectedTx', 'DeliveryValidatedTx',
  'DocumentArchivedTx', 'DocumentUploadedTx', 'DocumentVersionedTx', 'DomainModelAmendedTx',
  'EmployeeFiredTx', 'EmployeeHiredTx', 'EmployeeResignedTx', 'EventProjectionDeclaredTx',
  'EventProjectionLapsedTx', 'EventProjectionSatisfiedTx', 'EventSubscriptionBoundTx', 'EventSubscriptionUnboundTx',
  'EventTypeRegisteredTx', 'ExternalMappingDeclaredTx', 'ExternalRecordCorrelatedTx', 'ExternalSyncCompletedTx',
  'ExternalSyncFailedTx', 'ExternalSyncRequestedTx', 'ExternalSystemRegisteredTx', 'FormatConfigAmendedTx',
  'FormatConfigDeprecatedTx', 'FormatConfigTerminatedTx', 'FunctionDeclaredTx', 'InferenceModelChangedTx',
  'InferenceResidencyChangedTx', 'IngestFileUploadedTx', 'IngestRunExecutedTx', 'InvoiceApprovedTx',
  'InvoiceIssuedTx', 'InvoiceVoidedTx', 'Iso20022MessageAttachedTx', 'JournalPostedTx', 'LegPaymentPostedTx',
  'MilestoneAffirmedTx', 'OntologyNodeAmendedTx', 'OntologyNodeDeclaredTx', 'OntologyNodeRetiredTx',
  'PartyDataAmendedTx', 'PartyDealLinkedTx', 'PartyPersonAssociationAmendedTx', 'PartyPersonAssociationCancelledTx',
  'PartyPersonAssociationDeprecatedTx', 'PartyPersonAssociationTerminatedTx', 'PartyRecordSupersededTx',
  'PartyRegisteredTx', 'PartyRoleBoundTx', 'PartyRoleUnboundTx', 'PartyWalletDeclaredTx',
  'PayoutCycleSettledTx', 'PermissionGrantedTx', 'PermissionRevokedTx', 'PersonDataAmendedTx',
  'PersonRecordSupersededTx', 'PersonRegisteredTx', 'PersonWalletDeclaredTx', 'PortfolioProvisionedTx',
  'ProcessBoundTx', 'ProductDeliveredTx', 'ProjectAmendedTx', 'ProjectDeliveredTx', 'ProjectGreenlitTx',
  'ProjectRegisteredTx', 'ProjectRetiredTx', 'RecoupmentCreditedTx', 'RevenuePostedTx', 'RevenueStreamDeclaredTx',
  'RuleBoundTx', 'SchemaRegisteredTx', 'SecurityPrincipalCreatedTx', 'SecurityPrincipalRevokedTx',
  'SettlementConfirmedTx', 'SettlementFailedTx', 'SettlementInstructedTx', 'SettlementRailDeclaredTx',
  'SkillConstituentIncludedTx', 'SkillConstituentRemovedTx', 'TalentPaidTx', 'TalentPayableRaisedTx',
  'TalentPaymentApprovedTx', 'TemplateRegisteredTx', 'UserAliasAmendedTx', 'UserAliasCreatedTx',
  'UserPowAnchoredTx', 'VersionPinnedTx', 'VersionUnpinnedTx', 'WalletClonedTx', 'WalletCopiedTx',
  'WalletTemplateRegisteredTx', 'WalletTierRetypedTx', 'WalletTierTypedTx',
];

/** Retired names whose successor is not simply the name without `Tx`. */
export const RENAMED_EVENT_SUCCESSORS: Readonly<Record<string, string>> = {
  UserInvitedTx: 'MemberInvited',
  GroupMemberCreated: 'GroupMemberAdded',
  GroupMemberDeactivated: 'GroupMemberRemoved',
  // The EBB deal-constituent lifecycle (v12-17) is its own family: the plain
  // `ConstituentCreated` name belongs to the codex hierarchy link (cid).
  ConstituentCreatedTx: 'DealConstituentCreated',
  ConstituentDeprecatedTx: 'DealConstituentDeprecated',
  ConstituentTerminatedTx: 'DealConstituentTerminated',
  ConstituentPartiallyTerminatedTx: 'DealConstituentPartiallyTerminated',
  ConstituentTruncatedTx: 'DealConstituentTruncated',
  ConstituentCompressedTx: 'DealConstituentCompressed',
};

/**
 * Suffix-free names that were already registered in their own right before
 * v12-20-06. The retired `...Tx` form merges into them; their registration
 * receipts were always written under the suffix-free name.
 */
export const MERGED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'AgentBound',
  'ConstituentRemoved',
  'SkillConstituentIncluded',
  'SkillConstituentRemoved',
  'WalletCloned',
]);

/** Retired name → current name. */
export const DEPRECATED_EVENT_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(
    RETIRED_TX_EVENT_TYPES.map((name) => [name, RENAMED_EVENT_SUCCESSORS[name] ?? name.slice(0, -2)]),
  ),
  GroupMemberCreated: 'GroupMemberAdded',
  GroupMemberDeactivated: 'GroupMemberRemoved',
});

/** Current name → the retired name it replaced (first retired name wins). */
const LEGACY_NAME_OF: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = {};
  for (const [legacy, current] of Object.entries(DEPRECATED_EVENT_ALIASES)) {
    if (legacy.endsWith('Tx') && !out[current]) out[current] = legacy;
  }
  return out;
})();

const TX_SUFFIXED = /^[A-Z][A-Za-z0-9]*[a-z0-9]Tx$/;

/**
 * Current name for any event type. Declared aliases first; an undeclared
 * `...Tx` name (never registered, e.g. an older ops-log entry) drops the
 * suffix the same way.
 */
export function canonicalEventType(eventType: string): string {
  const aliased = DEPRECATED_EVENT_ALIASES[eventType];
  if (aliased) return aliased;
  return TX_SUFFIXED.test(eventType) ? eventType.slice(0, -2) : eventType;
}

export function isRetiredEventType(eventType: string): boolean {
  return eventType in DEPRECATED_EVENT_ALIASES || TX_SUFFIXED.test(eventType);
}

/**
 * The name deterministic genesis ids were seeded with. Genesis that
 * re-runs after the rename finds its earlier transaction instead of
 * writing a second copy.
 */
export function legacySeedEventType(eventType: string): string {
  return LEGACY_NAME_OF[eventType] ?? eventType;
}

/** Seed for `<category>:event-type:registered:<name>` receipt ids. */
export function registrationSeedEventType(eventType: string): string {
  return MERGED_EVENT_TYPES.has(eventType) ? eventType : legacySeedEventType(eventType);
}

interface EventLike {
  eventType?: unknown;
  recordedEventType?: string;
}

/** In-memory view with the current name; the recorded name is kept alongside. */
export function canonicalizeEventEntry<T>(input: T): T {
  const entry = canonicalizeAddressFields(input);
  const e = entry as T & EventLike;
  if (!e || typeof e.eventType !== 'string') return entry;
  const current = canonicalEventType(e.eventType);
  if (current === e.eventType) return entry;
  return { ...e, eventType: current, recordedEventType: e.recordedEventType ?? e.eventType };
}

/** The exact form that was stored and hashed. */
export function recordedFormOf<T>(input: T): T {
  const entry = recordedAddressFormOf(input);
  const e = entry as T & EventLike;
  if (!e || typeof e.recordedEventType !== 'string') return entry;
  const { recordedEventType, ...rest } = e;
  return { ...rest, eventType: recordedEventType } as T;
}
