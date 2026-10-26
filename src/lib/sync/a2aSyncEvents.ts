/**
 * COPE node crystallized.
 * Node ID: v12-21-00-a2a-sync-events
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Vocabulary + shared shapes for A2A wallet-copy sync (a2a-sync.bpmn).
 * Signals ride the ledger; payloads never do. Every event here carries
 * hashes and identifiers only — the session wallet holds zero data custody.
 */

export const A2A_SYNC_EVENT_TYPES = [
  'DataSyncRequested',
  'SyncSessionOpened',
  'SyncItemOffered',
  'SyncItemDelivered',
  'SyncItemRejected',
  'SyncForkDetected',
  'SyncHeadersBatched',
  'SyncBlobShredded',
  'SyncSessionClosed',
  // v12-21-09 — High-QoS checksum receipts + pause/resume/restart
  'SyncChecksumReceiptIssued',
  'SyncSessionPaused',
  'SyncSessionResumed',
  'SyncSessionRestarted',
  'AmendConflictDetected',
  // v12-21-02 — a2a-sync-standup.bpmn
  'SyncCopyRegistered',
  'SyncNetworkVerified',
  // v12-21-06 — directional bid/ask market + auditable matching
  'SyncCapabilityAdvertised',
  'SyncCapabilityWithdrawn',
  'SyncOffered',
  'SyncRequested',
  'SyncMatched',
  'SyncOrderWithdrawn',
  'SyncRejected',
  'SyncCompleted',
  // v12-21-07 — bid/ask pricing + on-chain settlement
  'BaseSyncPriceOffered',
  'BasePriceSyncRequested',
  'SyncPaymentSettled',
  // v15-03-00 — refund remediation for a rejected sync (a2a-sync.bpmn SyncRefund):
  // payer asks (a RemediationRequested subclass), payee backs the payment out or declines
  'SyncRefundRequested',
  'SyncPaymentReversed',
  'SyncRefundDeclined',
  // v15-04-00 — dispute after a decline: payer asks the arbiter, arbiter rules
  'SyncArbitrationRequested',
  'SyncArbitrationDecided',
  // CPM app-upgrade recipient lifecycle
  'AppUpgradeOffered',
  'AppUpgradeRequested',
  'AppUpgradeApproved',
  'AppUpgradeStaged',
  'AppUpgradeActivated',
  'AppUpgradeRejected',
  'AppUpgradeExpired',
  'AppUpgradeWithdrawn',
  'AppUpgradeRolledBack',
  // v12-23-00 — cappz-replicator: gossip, tunnels, bundles, channels
  'PeerHeadAnnounced',
  'PeerInventoryDiffed',
  'PeerSignalExchanged',
  'TunnelOpened',
  'TunnelClosed',
  // v15-03-00 — TX bid/ask rendezvous for copies behind firewalls (replica-connect.bpmn)
  'ReplicaConnectRequested',
  'ReplicaConnectOffered',
  'ReplicaConnectRejected',
  // v15-05-00 — member table: each copy's device writes where it can be reached (endpointDirectory.ts)
  'CopyEndpointRegistered',
  'CopyEndpointAmended',
  'SyncBundleExported',
  'SyncBundleImported',
  'ReplicatorAgentCreated',
  'ReplicatorPeerScored',
  'ChannelConfigured',
  'ChannelAmended',
  'ChannelFailoverOccurred',
  // v12-23-02 — durability meter, removable escrow, farm
  'DurabilityLevelSet',
  'EscrowTargetAttached',
  'EscrowSyncCompleted',
  'FarmNodeScored',
] as const;

export const A2A_SYNC_STANDUP_BPMN_PATH = "m/44'/144'/100'/bpmn/substrate/a2a-sync-standup";

export type A2ASyncEventType = (typeof A2A_SYNC_EVENT_TYPES)[number];

export const A2A_SYNC_GOVERNING_PRINCIPLE = "m/44'/144'/100'/principles/cope/v1";
export const A2A_SYNC_BPMN_PATH = "m/44'/144'/100'/bpmn/substrate/a2a-sync";

/** A lifecycle header every copy can see even when it lacks the data. */
export interface LifecycleHeader {
  address: string;
  txId: string;
  /** prevEvent link — null for the genesis (…Created) event at an address. */
  prevTxId: string | null;
  eventType: string;
  objectType?: string;
  contentHash: string;
  /** Private threads / by-value clone state are never offered to other copies. */
  visibility?: 'shared' | 'private';
}

export interface MissingItem {
  address: string;
  txId: string;
  prevTxId: string | null;
  eventType: string;
  objectType?: string;
  contentHash: string;
}

export interface A2ASyncEvent {
  txId: string;
  eventType: A2ASyncEventType;
  /** Account address the event is written to (e.g. `<wallet>/admin/in-queue`). */
  address: string;
  sessionId?: string;
  correlationId: string;
  governingPrinciple: string;
  /** a2a-sync.bpmn task ids this event evidences. */
  bpmnSteps?: string[];
  timestamp: string;
  data: Record<string, unknown>;
}

/** The copy's own admin in-queue account — receives direct TX messages. */
export function adminInQueueAddress(walletAddress: string): string {
  return `${walletAddress}/admin/in-queue`;
}

export function sessionWalletAddress(sessionId: string): string {
  return `m/44'/144'/0'/cappz/sync/infra/a2a-session/${sessionId}`;
}
