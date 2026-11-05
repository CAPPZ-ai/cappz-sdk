/**
 * COPE node crystallized. Node ID: v14-19-00-marketplace-types.
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Marketplace domain types. Everything here is either a TX payload or a
 * projection replayed from TXs (replay.ts); nothing is stored as a status
 * flag. Identity (who), governance (what an agent may do: mandates) and
 * settlement (how value resolves: escrow legs) are separate types.
 */
import type { DealKind } from './catalog';
import type { FeeTerms } from './fees';
import type { PaymentFunding } from './stageMath';
import type { RoyaltyLeg } from '../skills/royaltyRouting';
import type { Currency, RailId } from './paymentAssets';
import type { KeyDeclaration, KeyRevocation } from '../identity/keyDeclaration';
import type { PrincipalCredentialRef } from './principalCredential';

export type PartyKind = 'person' | 'organization' | 'agent';
export type PartyRole = 'buyer' | 'seller' | 'farmer' | 'supplier' | 'service-provider' | 'equipment-dealer' | 'processor';

export interface PartyProfile {
  partyId: string;
  kind: PartyKind;
  name: string;
  roles: PartyRole[];
  /** Two-letter state code; coarse on purpose — no addresses on the public ledger. */
  region: string;
  /** Optional 5-digit county FIPS for closer matching (still no address). */
  county?: string;
  about: string;
  capabilities: {
    categories: string[];
    /** Farmer can plant a crop they do not grow today. */
    canPlantNew: boolean;
    acres?: number;
    equipment?: string[];
  };
  /** For agents: the accountable party (person or organization) — or, for a non-human company, its governance address. */
  principal?: { partyId?: string; governanceAddress?: string };
  /** Public XRPL classic address used for on-ledger escrow and token receipts. */
  xrplAccount?: string;
  /** Stripe connected account that receives USD stage payments (created by marketplace-payments for this party). */
  payoutAccount?: string;
  /** P-256 box public key: sellers of digital goods seal access keys to it. The private half stays sealed in the party's wallet. */
  encryptionKey?: JsonWebKey;
  /** For agents: the model / runtime it runs on, for transparency. */
  runtime?: string;
  /**
   * v15-31-00 KeyZ: the agent's request-signing key (Ed25519, purpose `signing`), declared by its identity wallet
   * (keyDeclaration.ts). Public: a key and a wallet signature, never a secret. Absent = `undeclared` (still allowed,
   * reported) unless a mandate binds the agent to a key (MandateContent.boundKey).
   */
  keyDeclaration?: KeyDeclaration;
  /** Wallet-signed revocations of earlier declarations, replayed by every verifier (no CRL to ask). */
  keyRevocations?: KeyRevocation[];
  /** v15-31-00: the principal's SD-JWT credential by reference only (issuer + hash of the issuer-signed part); values are disclosed on request, sealed, never here. */
  principalCredential?: PrincipalCredentialRef;
}

export type { Currency, RailId } from './paymentAssets';
/** An amount in one payment asset; `currency` is the asset's code (paymentAssets.ts), the value written on the public log. */
export interface Money { amount: number; currency: Currency }

export interface ListingContent {
  listingId: string;
  sellerId: string;
  categoryId: string;
  kind: DealKind;
  title: string;
  description: string;
  unit: string;
  pricePerUnit: Money;
  quantity: number;
  region: string;
  county?: string;
  delivery: 'pickup' | 'ship' | 'on-site' | 'online';
  /** Days from order to delivery (or availability). */
  leadDays: number;
  /** The seller's own payment schedule for orders (deposit, milestones, completion); absent = the category default. */
  milestones?: MilestonePlan[];
  attributes: Record<string, string>;
  /** When the listing is backed by a receipt token (e.g. stored grain). */
  tokenId?: string;
  /** A knowledge graph sold under a sealed key: what the buyer can verify before accepting. */
  knowledge?: { graphId: string; graphVersion: string; merkleRoot: string; nodeCount: number; edgeCount: number };
  /**
   * Metered use (15.31.0, rail ledger-channel; XRP only): `unit` is the metered unit (query, MB, call), `pricePerUnit`
   * the price of one, and an order's quantity is its cap. The buyer opens a payment channel for the cap and signs
   * claims as the service is used; the seller redeems them.
   */
  metered?: boolean;
}

export interface SupplyRequestContent {
  requestId: string;
  buyerId: string;
  categoryId: string;
  title: string;
  description: string;
  quantity: number;
  unit: string;
  /** Highest acceptable price per unit; null = open to offers. */
  maxPricePerUnit: Money | null;
  neededBy: string;
  region: string;
  county?: string;
  /** Sellers further than this from the buyer's region are not invited (null = anywhere). */
  deliveryRadiusMiles: number | null;
  /** Farmers may bid to plant a crop they do not grow today. */
  allowNewPlanting: boolean;
  contractType: 'spot' | 'production-contract';
  recurring?: { every: 'week' | 'month'; count: number };
  attributes: Record<string, string>;
}

export interface MilestoneTerm {
  index: number;
  label: string;
  /** Share of the contract value released at this milestone (shares sum to 1). */
  share: number;
  dueBy: string;
  /** What the seller must show (photo, inspection, delivery receipt…). */
  evidence: string;
  /** The final delivery milestone carries the commodity leg. */
  delivery: boolean;
  /** Subcontracts only: the parent contract's milestone index this stage serves (explicit, never inferred from labels or dates). It is funded only after that parent milestone is released. */
  servesMilestone?: number;
}

/** A milestone in a listing's payment schedule; due dates are counted from the day the order is placed. */
export interface MilestonePlan {
  label: string;
  share: number;
  dueInDays: number;
  evidence: string;
  delivery: boolean;
}

export interface SupplyOfferContent {
  offerId: string;
  requestId: string;
  sellerId: string;
  pricePerUnit: Money;
  quantity: number;
  deliveryDate: string;
  plan: { newPlanting: boolean; plantingDate?: string; acres?: number; expectedYieldPerUnitArea?: number; notes: string };
  milestones: MilestoneTerm[];
  message: string;
}

export interface ContractTerms {
  contractId: string;
  buyerId: string;
  sellerId: string;
  /** `subcontract`: a child contract the parent's seller formed (buildSubcontract); which parent comes only from the ConstituentIncluded TX written in the same batch. */
  source: { kind: 'request'; requestId: string; offerId: string } | { kind: 'listing'; listingId: string } | { kind: 'subcontract' };
  categoryId: string;
  title: string;
  quantity: number;
  unit: string;
  pricePerUnit: Money;
  total: Money;
  milestones: MilestoneTerm[];
  formedAt: string;
  /** Fee terms copied from the schedule in force when the contract formed (absent/null = no fees). The seller pays them at release. */
  fees?: FeeTerms | null;
  /** The rail frozen when the contract formed (paymentAssets.defaultRail); absent on deals formed before 15.31.0 = the asset's default. */
  rail?: RailId;
  /** A third party named at formation who may affirm milestones besides the buyer (never the seller). The buyer still pays; disputes and operator rulings remain the fallback. */
  evaluatorId?: string;
}

export type MilestoneState = 'pending' | 'evidenced' | 'affirmed' | 'released' | 'disputed';
export type ContractState = 'awaiting-funding' | 'in-progress' | 'disputed' | 'completed' | 'cancelled';

export interface ContractView extends ContractTerms {
  state: ContractState;
  /** Why the contract is in this state — the event that put it there. */
  because: string;
  escrow: { funded: number; released: number; refunded: number; balance: number };
  milestoneStates: Array<{ index: number; state: MilestoneState; evidence: Array<{ kind: string; hash: string; note: string; at: string }>; releasedAmount: number;
    /** Set when the stage is funded: its configured due date and the end of its 30-day hold. */
    stage: { fundedAt: string; dueBy: string; holdUntil: string } | null;
    /** Stripe (processor-confirmed) state for this stage, when paid through the payment processor. */
    processor: null | { status: 'processing' | 'succeeded' | 'failed' | 'transferred' | 'refunded' | 'clawed-back'; rail: 'card' | 'ach' | 'pending'; grossCents: number;
      /** The buyer's payment fee (same for every method) and, once paid, how they paid and where the fee went. */
      paymentFeeCents: number; funding?: PaymentFunding; cardCostCents?: number; treasuryCents?: number;
      paymentIntentId: string; transferId?: string; netCents?: number; feeCents?: number } }>;
  disputes: Array<{ n: number; by: string; reason: string; resolved: null | { resolution: 'release' | 'refund' | 'split'; note: string } }>;
  reviews: Array<{ by: string; rating: number; text: string }>;
  payments: Array<{ reference: string; amount: number; rail: string; validated: boolean; network?: string; /** Who confirmed it: the ledger (validated), the payment processor, or nobody (a recorded reference). */ confirmedBy?: 'ledger' | 'processor' }>;
  /** On-ledger escrows (XRP contracts): one per funded milestone, identified by the creating transaction. */
  ledgerEscrows: Array<{ milestone: number; txHash: string; sequence: number; condition: string; network: string; ledgerIndex: number | null; sealedSecret?: Record<string, unknown>; /** Fee legs escrowed to DARC recipients under the same condition. */ feeEscrows: FeeEscrow[] }>;
  /** Ledger transactions that released or refunded milestone escrows. */
  ledgerSettlements: Array<{ milestone: number; kind: 'release' | 'refund'; txHash: string; network: string }>;
  nextAction: { by: 'buyer' | 'seller' | 'operator' | null; action: string };
  /** Fees charged at release (FeeCharged), with how each was settled. */
  feeCharges: FeeCharge[];
  /** Set when this is a subcontract: the parent replayed from the ConstituentIncluded TX that links it (never from ids or labels). */
  parentContractId?: string;
  /** Child contracts linked to this one by ConstituentIncluded TXs, in link order. */
  subcontracts: string[];
  /** Metered contracts (rail ledger-channel): the payment channel as the validated ledger showed it; null before it opens. */
  channel?: ChannelView | null;
}

/**
 * A payment channel replayed from EscrowFunded / EscrowReleased / EscrowRefunded (rail ledger-channel). Amounts in
 * drops. `releasedDrops` is the cumulative Balance the seller redeemed on the ledger; `closed` only once the ledger
 * showed the channel deleted.
 */
export interface ChannelView {
  channelId: string; publicKey: string; network: string; txHash: string;
  capDrops: string; releasedDrops: string; refundedDrops: string;
  /** Units used so far (released ÷ price per unit) and the cap in units. */
  unitsUsed: number; unitsCap: number;
  settleDelay: number | null; cancelAfter: string;
  closed: boolean; closeTxHash: string | null;
}

export interface FeeEscrow { account: string; label: string; drops: string; txHash: string; sequence: number }

/** A charged fee: `validated` legs were read on the ledger; `by-reference` were recorded, not checked; `demo` moved nothing. */
export interface FeeCharge { milestone: number; currency: Currency; feeUnits: number; sheetId: string; settlement: 'validated' | 'by-reference' | 'demo' | 'processor'; legs: Array<RoyaltyLeg & { txHash?: string }>; /** Each DARC recipient's share (paid from the collector later when `collector` is set). */ owed: RoyaltyLeg[]; collector: { account: string; label: string } | null; reference?: string }

export type AssetKind = 'warehouse-receipt' | 'production-right' | 'equipment-title' | 'storage-right' | 'service-voucher';

export interface TokenClassification {
  redeemableForSpecificAsset: boolean;
  profitFromOthersEfforts: boolean;
  fractionalEnterpriseOwnership: boolean;
  /** receipt = allowed (non-security receipt); blocked = looks like a security, needs a compliance path this release does not have. */
  result: 'receipt' | 'blocked';
  reasons: string[];
}

export interface TokenContent {
  tokenId: string;
  issuerId: string;
  assetKind: AssetKind;
  categoryId: string;
  name: string;
  description: string;
  /** What one whole token redeems for. */
  redeemsFor: { quantity: number; unit: string };
  /** Total tokens issued (integer units). */
  supply: number;
  backing: { custodian: string; region: string; evidence: Array<{ kind: string; hash: string; note: string }> };
  classification: TokenClassification;
  xrpl: { network: 'testnet'; preparedIssuance: Record<string, unknown> };
}

export interface MandateLimits {
  /** Verbs the agent may run on the principal's behalf. */
  verbs: string[];
  categories: string[];
  maxPerContract: Money;
  maxPerDay: Money;
  /** Above this value the agent must get a human/governance co-signature. */
  approvalAbove: Money | null;
  expiresAt: string;
}

export interface MandateContent { mandateId: string; agentPartyId: string; grantedBy: string; limits: MandateLimits;
  /** v15-31-00: the agent's declared signing key (Ed25519 hex) this mandate is bound to; requests acting under it must be signed by that key (agentRequestAuth.ts). Absent = unbound (older mandates). */
  boundKey?: string }
