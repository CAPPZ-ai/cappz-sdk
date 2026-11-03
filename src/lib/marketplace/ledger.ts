/**
 * COPE node crystallized. Node ID: v14-19-00-marketplace-ledger.
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * The marketplace event log on the shared app-ledger substrate. Reused
 * vocabulary where the meaning exists (Content* for profiles and listings,
 * PermissionGranted/Revoked for agent mandates, MilestoneAffirmed,
 * DeliveryApproved/Rejected, PaymentConfirmed, SettlementRailDeclared for the
 * settlement-network policy, PriceSheetPublished and FeeCharged from the fees
 * category for the fee schedule and charged fees); the rest is declared under
 * the `marketplace` MDM category. Requester sends XRequested, decider replies.
 */
import { createAppLedger, type AppTx, type AppTxLike } from '../apps/appLedger';
import { MARKETPLACE_EVENT_LOG, MARKETPLACE_GOVERNING_PRINCIPLE } from './MarketplacePaths';

export const MARKETPLACE_DECLARED_EVENTS = [
  'SupplyRequested', 'SupplyOffered', 'SupplyOfferWithdrawn', 'SupplyAwarded', 'SupplyRequestClosed',
  'ListingWithdrawn', 'InventoryAdjusted', 'OrderPlaced',
  'EscrowFunded', 'EscrowReleased', 'EscrowRefunded',
  'MilestoneEvidenced', 'DisputeRaised', 'DisputeResolved', 'ReviewPosted',
  'AssetTokenized', 'TokenTransferred', 'TokenRedeemed',
  'AccessKeyDelivered',
  'SecurityOfferingDeclared', 'SecurityOfferingApproved', 'SecuritySubscribed', 'SecurityAllocated', 'SecurityTransferred',
] as const;

export type MarketplaceEventType =
  | 'ContentCreated' | 'ContentAmended'
  | 'PermissionGranted' | 'PermissionRevoked'
  | 'MilestoneAffirmed' | 'DeliveryApproved' | 'DeliveryRejected' | 'PaymentConfirmed' | 'SettlementRailDeclared'
  | 'PriceSheetPublished' | 'FeeCharged'
  | typeof MARKETPLACE_DECLARED_EVENTS[number];

export type MarketTx = AppTx<MarketplaceEventType>;
export type MarketTxLike = AppTxLike<MarketplaceEventType>;

export const marketLedger = createAppLedger<MarketplaceEventType>({ eventLog: MARKETPLACE_EVENT_LOG, cachePrefix: 'cappz:marketplace:events/', emitterDomain: 'marketplace', governingPrinciple: MARKETPLACE_GOVERNING_PRINCIPLE });
