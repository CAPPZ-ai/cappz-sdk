/**
 * COPE node crystallized. Node ID: v14-19-00-marketplace-replay.
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Market state replayed from the event log (AP-12). Lifecycle state is derived
 * from the ordered events plus the rules in rules.ts — the same sequence as
 * the BPMN processes — never from a stored status field. Every derived state
 * carries `because`: the event that put it there.
 */
import type { MarketTxLike } from './ledger';
import { committedKey, milestoneAmounts, subcontractGate } from './rules';
import { partyAddress, subcontractAddress } from './MarketplacePaths';
import type { AccessDelivery, GraphPublication } from './knowledge/access';
import { applySecurityEvent, type EligibilityAttestation, type OfferingView } from './securities';
import { contractFeePlan, feeScheduleFrom, type FeeDistribution, type FeeScheduleView } from './fees';
import type { PaymentFunding } from './stageMath';
import { contractRail } from './settlement';
import { formatMoney } from './paymentAssets';
import type {
  ChannelView, ContractTerms, ContractView, FeeCharge, FeeEscrow, ListingContent, MandateContent, MilestoneState, PartyProfile, SupplyOfferContent, SupplyRequestContent, TokenContent,
} from './types';

export interface ListingView extends ListingContent { open: boolean; remaining: number; publishedAt: string }
export interface OfferView extends SupplyOfferContent { at: string; withdrawn: boolean; awardedQuantity: number }
export interface RequestView extends SupplyRequestContent { postedAt: string; open: boolean; offers: OfferView[]; awardedQuantity: number; contractIds: string[] }
export interface TokenView { content: TokenContent; issuedAt: string; balances: Record<string, number>; redeemed: number }
export interface Reputation { completed: number; disputes: number; ratings: number[]; average: number | null }

export interface MarketState {
  parties: Map<string, PartyProfile>;
  listings: ListingView[];
  requests: RequestView[];
  contracts: ContractView[];
  tokens: TokenView[];
  mandates: MandateContent[];
  reputation: Map<string, Reputation>;
  /** Value an agent committed per UTC day (contracts formed by it), for mandate limits. */
  committedByDay: Map<string, number>;
  /** Knowledge graphs for sale: public manifest and ciphertext, by listing. */
  graphs: Map<string, GraphPublication>;
  /** Each party's box private key, sealed under their own session-wallet key (only they can open it). */
  boxKeys: Map<string, Record<string, unknown>>;
  /** Access keys sealed to buyers, by contract. */
  accessDeliveries: Map<string, AccessDelivery[]>;
  /** Security offerings under an exemption, and compliance-attested investor eligibility. */
  offerings: OfferingView[];
  eligibility: Map<string, EligibilityAttestation>;
  /** The fee schedule in force (latest PriceSheetPublished for the marketplace), and every one published. */
  fees: FeeScheduleView | null;
  feeHistory: FeeScheduleView[];
  /** Payments from collection accounts to DARC recipients (ARC → DARC). */
  feeDistributions: FeeDistribution[];
}

const order = (txs: readonly MarketTxLike[]) => [...txs].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.txId.localeCompare(b.txId));
const p = <T,>(t: MarketTxLike) => t.payload as unknown as T;

export function resolveMarket(txs: readonly MarketTxLike[]): MarketState {
  const parties = new Map<string, PartyProfile>();
  const listings = new Map<string, ListingView>();
  const requests = new Map<string, RequestView>();
  const terms = new Map<string, ContractTerms>();
  const events = new Map<string, MarketTxLike[]>();
  const tokens = new Map<string, TokenView>();
  const mandates = new Map<string, MandateContent>();
  const committedByDay = new Map<string, number>();
  const graphs = new Map<string, GraphPublication>(); const manifests = new Map<string, GraphPublication['manifest']>(); const ciphers = new Map<string, Omit<GraphPublication, 'manifest'>>();
  const offerings = new Map<string, OfferingView>(); const eligibility = new Map<string, EligibilityAttestation>();
  const boxKeys = new Map<string, Record<string, unknown>>(); const accessDeliveries = new Map<string, AccessDelivery[]>();
  let fees: FeeScheduleView | null = null; const feeHistory: FeeScheduleView[] = []; const feeDistributions: FeeDistribution[] = [];
  // Parent → child contract edges (ConstituentIncluded, contentClass 'subcontract'), joined to the terms after the pass.
  const subcontractLinks: Array<{ parentContractId: string; contractId: string; sourceAddress: string }> = [];
  const contractEvent = (id: string, t: MarketTxLike) => { const list = events.get(id) ?? []; list.push(t); events.set(id, list); };

  for (const t of order(txs)) {
    applySecurityEvent(t, offerings, eligibility);
    const cls = (t.payload as { contentClass?: string }).contentClass;
    switch (t.eventType) {
      case 'ContentCreated': case 'ContentAmended':
        if (cls === 'party') { const v = p<{ profile: PartyProfile }>(t).profile; parties.set(v.partyId, v); }
        if (cls === 'listing') {
          const v = p<{ listing: ListingContent }>(t).listing; const prior = listings.get(v.listingId);
          listings.set(v.listingId, { ...v, open: prior?.open ?? true, remaining: prior ? prior.remaining + (v.quantity - prior.quantity) : v.quantity, publishedAt: prior?.publishedAt ?? t.timestamp });
        }
        if (cls === 'graph-manifest') { const v = p<{ listingId: string; manifest: GraphPublication['manifest'] }>(t); manifests.set(v.listingId, v.manifest); }
        if (cls === 'graph-ciphertext') { const v = p<Omit<GraphPublication, 'manifest' | 'publishedAt'>>(t); ciphers.set(v.listingId, { ...v, publishedAt: t.timestamp }); }
        if (cls === 'party-box-key') { const v = p<{ partyId: string; sealedPrivate: Record<string, unknown> }>(t); boxKeys.set(v.partyId, v.sealedPrivate); }
        break;
      case 'ListingWithdrawn': { const l = listings.get(p<{ listingId: string }>(t).listingId); if (l) l.open = false; break; }
      case 'InventoryAdjusted': { const v = p<{ listingId: string; delta: number }>(t); const l = listings.get(v.listingId); if (l) l.remaining += v.delta; break; }
      case 'SupplyRequested': { const v = p<{ request: SupplyRequestContent }>(t).request; requests.set(v.requestId, { ...v, postedAt: t.timestamp, open: true, offers: [], awardedQuantity: 0, contractIds: [] }); break; }
      case 'SupplyRequestClosed': { const r = requests.get(p<{ requestId: string }>(t).requestId); if (r) r.open = false; break; }
      case 'SupplyOffered': { const v = p<{ offer: SupplyOfferContent }>(t).offer; requests.get(v.requestId)?.offers.push({ ...v, at: t.timestamp, withdrawn: false, awardedQuantity: 0 }); break; }
      case 'SupplyOfferWithdrawn': { const v = p<{ requestId: string; offerId: string }>(t); const o = requests.get(v.requestId)?.offers.find((x) => x.offerId === v.offerId); if (o) o.withdrawn = true; break; }
      case 'SupplyAwarded': case 'OrderPlaced': {
        const v = p<{ terms: ContractTerms; agentPartyId?: string }>(t).terms; terms.set(v.contractId, v);
        if (v.source.kind === 'request') { const src = v.source; const r = requests.get(src.requestId); if (r) { r.awardedQuantity += v.quantity; r.contractIds.push(v.contractId); const o = r.offers.find((x) => x.offerId === src.offerId); if (o) o.awardedQuantity += v.quantity; if (r.awardedQuantity >= r.quantity) r.open = false; } }
        else if (v.source.kind === 'listing') { const src = v.source; const l = listings.get(src.listingId); if (l) l.remaining -= v.quantity; }
        const agent = p<{ agentPartyId?: string }>(t).agentPartyId;
        if (agent) { const k = committedKey(agent, t.timestamp, v.total.currency); committedByDay.set(k, (committedByDay.get(k) ?? 0) + v.total.amount); }
        break;
      }
      case 'PaymentConfirmed':
        if (cls === 'fee-distribution') { const v = p<Omit<FeeDistribution, 'at' | 'by'>>(t); feeDistributions.push({ ...v, at: t.timestamp, by: t.sourceAddress }); break; }
        contractEvent(p<{ contractId: string }>(t).contractId, t); break;
      case 'EscrowFunded': case 'EscrowReleased': case 'EscrowRefunded': case 'MilestoneEvidenced': case 'MilestoneAffirmed':
      case 'DeliveryApproved': case 'DeliveryRejected': case 'DisputeRaised': case 'DisputeResolved': case 'ReviewPosted':
        contractEvent(p<{ contractId: string }>(t).contractId, t); break;
      case 'FeeCharged': { const id = p<{ contractId?: string }>(t).contractId; if (id) contractEvent(id, t); break; }
      // Latest declaration wins (events are replayed in order); earlier schedules stay on the ledger and in contracts formed under them.
      case 'PriceSheetPublished': { const f = feeScheduleFrom(t.payload as Record<string, unknown>, t.timestamp); if (f) { fees = f; feeHistory.push(f); } break; }
      case 'AccessKeyDelivered': { const v = p<Omit<AccessDelivery, 'at'>>(t); const list = accessDeliveries.get(v.contractId) ?? []; list.push({ ...v, at: t.timestamp }); accessDeliveries.set(v.contractId, list); break; }
      case 'AssetTokenized': { const v = p<{ token: TokenContent }>(t).token; tokens.set(v.tokenId, { content: v, issuedAt: t.timestamp, balances: { [v.issuerId]: v.supply }, redeemed: 0 }); break; }
      case 'TokenTransferred': { const v = p<{ tokenId: string; from: string; to: string; amount: number }>(t); const k = tokens.get(v.tokenId); if (k) { k.balances[v.from] = (k.balances[v.from] ?? 0) - v.amount; k.balances[v.to] = (k.balances[v.to] ?? 0) + v.amount; } break; }
      case 'TokenRedeemed': { const v = p<{ tokenId: string; holder: string; amount: number }>(t); const k = tokens.get(v.tokenId); if (k) { k.balances[v.holder] = (k.balances[v.holder] ?? 0) - v.amount; k.redeemed += v.amount; } break; }
      case 'ConstituentIncluded': if (cls === 'subcontract') {
        // Only an edge into the parent's own HD slot for this child counts (the address is built from the fields, not parsed).
        const v = p<{ parentContractId?: string; contractId?: string }>(t);
        if (typeof v.parentContractId === 'string' && typeof v.contractId === 'string' && t.targetAddress === subcontractAddress(v.parentContractId, v.contractId)) subcontractLinks.push({ parentContractId: v.parentContractId, contractId: v.contractId, sourceAddress: t.sourceAddress });
      } break;
      case 'PermissionGranted': if (cls === 'mandate') { const v = p<{ mandate: MandateContent }>(t).mandate; mandates.set(v.mandateId, v); } break;
      case 'PermissionRevoked': if (cls === 'mandate') mandates.delete(p<{ mandateId: string }>(t).mandateId); break;
    }
  }

  // Manifest and ciphertext are written in one batch; join after replay so their order within it does not matter.
  for (const [id, c] of ciphers) { const m = manifests.get(id); if (m) graphs.set(id, { ...c, manifest: m }); }
  // A link holds when the child was formed as a subcontract, its buyer is the parent's seller, and that seller wrote
  // the edge; the first valid link for a child wins (a child has one parent).
  const parentOf = new Map<string, string>(); const childrenOf = new Map<string, string[]>();
  for (const k of subcontractLinks) {
    const parent = terms.get(k.parentContractId); const child = terms.get(k.contractId);
    if (!parent || !child || child.source.kind !== 'subcontract' || parentOf.has(k.contractId) || k.contractId === k.parentContractId) continue;
    if (child.buyerId !== parent.sellerId || k.sourceAddress !== partyAddress(parent.sellerId)) continue;
    parentOf.set(k.contractId, k.parentContractId); childrenOf.set(k.parentContractId, [...(childrenOf.get(k.parentContractId) ?? []), k.contractId]);
  }
  const contracts = [...terms.values()].map((c) => contractView(c, events.get(c.contractId) ?? [], { parentContractId: parentOf.get(c.contractId), subcontracts: childrenOf.get(c.contractId) }));
  annotateSubcontracts(contracts);
  const reputation = new Map<string, Reputation>();
  const rep = (id: string) => { let r = reputation.get(id); if (!r) { r = { completed: 0, disputes: 0, ratings: [], average: null }; reputation.set(id, r); } return r; };
  for (const c of contracts) {
    if (c.state === 'completed') { rep(c.buyerId).completed++; rep(c.sellerId).completed++; }
    for (const d of c.disputes) rep(d.by === c.buyerId ? c.sellerId : c.buyerId).disputes++;
    for (const r of c.reviews) rep(r.by === c.buyerId ? c.sellerId : c.buyerId).ratings.push(r.rating);
  }
  for (const r of reputation.values()) r.average = r.ratings.length ? Math.round((r.ratings.reduce((a, b) => a + b, 0) / r.ratings.length) * 10) / 10 : null;

  return { parties, listings: [...listings.values()], requests: [...requests.values()], contracts, tokens: [...tokens.values()], mandates: [...mandates.values()], reputation, committedByDay, graphs, boxKeys, accessDeliveries, offerings: [...offerings.values()], eligibility, fees, feeHistory, feeDistributions };
}

/**
 * Subcontract context on `because` / `nextAction`: a parent names its open child work; a child whose current stage
 * waits for the parent milestone it serves says so instead of asking its buyer to fund (subcontractGate).
 */
function annotateSubcontracts(contracts: ContractView[]): void {
  const byId = new Map(contracts.map((c) => [c.contractId, c]));
  for (const c of contracts) {
    if (c.source.kind !== 'subcontract' || c.state === 'completed' || c.state === 'cancelled' || c.state === 'disputed') continue;
    const cur = c.milestoneStates.find((m) => m.state !== 'released');
    if (!cur) continue;
    const staged = contractRail(c) === 'ledger-staged';
    const needsMoney = staged ? cur.state === 'affirmed' : c.escrow.balance + 1e-9 < milestoneAmounts(c.total.amount, c.milestones)[cur.index];
    const why = needsMoney ? subcontractGate(contracts, c, cur.index) : null;
    if (why) c.nextAction = { by: null, action: `${why}${cur.state === 'pending' ? ' The subcontractor can show evidence meanwhile.' : ''}` };
  }
  for (const c of contracts) {
    const open = c.subcontracts.map((id) => byId.get(id)).filter((k): k is ContractView => !!k && k.state !== 'completed' && k.state !== 'cancelled');
    if (!open.length) continue;
    c.because = `${c.because}; open subcontract work: ${open.map((k) => `${k.contractId} (${k.nextAction.action})`).join('; ')}`;
    const next = c.milestoneStates.find((m) => m.state !== 'released');
    const serving = next ? open.filter((k) => k.milestones.some((m, i) => m.servesMilestone === next.index && k.milestoneStates[i]?.state !== 'released')) : [];
    if (c.nextAction.by === 'seller' && serving.length) c.nextAction = { ...c.nextAction, action: `${c.nextAction.action} (subcontracted: ${serving.map((k) => k.contractId).join(', ')})` };
  }
}

/** One contract's lifecycle, in event order, mirroring marketplace-supply-request / marketplace-order BPMN. */
export function contractView(c: ContractTerms, evs: readonly MarketTxLike[], links: { parentContractId?: string; subcontracts?: string[] } = {}): ContractView {
  const amounts = milestoneAmounts(c.total.amount, c.milestones);
  const ms: ContractView['milestoneStates'] = c.milestones.map((m) => ({ index: m.index, state: 'pending' as MilestoneState, evidence: [], releasedAmount: 0, stage: null, processor: null }));
  const fees = contractFeePlan(c);
  const escrow = { funded: 0, released: 0, refunded: 0, balance: 0 };
  const disputes: ContractView['disputes'] = []; const reviews: ContractView['reviews'] = []; const payments: ContractView['payments'] = [];
  const ledgerEscrows: ContractView['ledgerEscrows'] = []; const ledgerSettlements: ContractView['ledgerSettlements'] = []; const feeCharges: FeeCharge[] = [];
  let because = 'Contract formed'; let rejected = false;
  // Refunds of an expired 30-day hold reopen that stage for funding; they do not cancel the contract.
  let expiredRefunds = 0;
  // Metered deals (rail ledger-channel): one payment channel. Redemptions release part of it without completing the
  // stage; the stage completes only when the ledger showed the channel closed (released + returned = the cap).
  const channelRail = contractRail(c) === 'ledger-channel';
  let channel: ChannelView | null = null;
  const capUnits = c.quantity;
  for (const t of order(evs)) {
    const v = t.payload as Record<string, unknown>;
    const n = typeof v.milestone === 'number' ? v.milestone : -1;
    if (channelRail && v.rail === 'ledger-channel' && (t.eventType === 'EscrowFunded' || t.eventType === 'EscrowReleased' || t.eventType === 'EscrowRefunded')) {
      const amount = Number(v.amount);
      if (t.eventType === 'EscrowFunded' && !channel) {
        channel = { channelId: String(v.channelId), publicKey: String(v.publicKey ?? ''), network: String(v.network), txHash: String(v.txHash), capDrops: String(v.capDrops ?? Math.round(amount * 1_000_000)), releasedDrops: '0', refundedDrops: '0', unitsUsed: 0, unitsCap: capUnits, settleDelay: typeof v.settleDelay === 'number' ? v.settleDelay : null, cancelAfter: String(v.holdUntil), closed: false, closeTxHash: null };
        if (ms[0]) ms[0].stage = { fundedAt: String(v.fundedAt ?? t.timestamp), dueBy: String(v.stageDueBy), holdUntil: String(v.holdUntil) };
        escrow.funded += amount;
        because = `Payment channel opened on the ledger: up to ${capUnits} ${c.unit} (${formatMoney(amount, 'XRP')}), expires ${String(v.holdUntil).slice(0, 10)}`;
      }
      if (t.eventType === 'EscrowReleased' && channel && !channel.closed && BigInt(String(v.balanceDrops ?? '0')) > BigInt(channel.releasedDrops)) {
        channel.releasedDrops = String(v.balanceDrops); channel.unitsUsed = Number(v.totalUnitsUsed ?? 0);
        escrow.released += amount; if (ms[0]) ms[0].releasedAmount += amount;
        ledgerSettlements.push({ milestone: 0, kind: 'release', txHash: String(v.txHash), network: String(v.network) });
        because = `Seller redeemed ${formatMoney(amount, 'XRP')} on the channel (${channel.unitsUsed} of ${capUnits} ${c.unit} used)`;
      }
      if (t.eventType === 'EscrowRefunded' && channel && !channel.closed && v.closed === true) {
        channel.closed = true; channel.refundedDrops = String(v.refundedDrops ?? '0'); channel.closeTxHash = String(v.txHash);
        escrow.refunded += amount;
        ledgerSettlements.push({ milestone: 0, kind: 'refund', txHash: String(v.txHash), network: String(v.network) });
        // Something was used and paid: the stage is done. Nothing used: the refund cancels the deal (rule below).
        if (ms[0] && BigInt(channel.releasedDrops) > 0n) ms[0].state = 'released';
        because = `Channel closed on the ledger: ${formatMoney(Number(channel.releasedDrops) / 1_000_000, 'XRP')} paid for ${channel.unitsUsed} ${c.unit}, ${formatMoney(amount, 'XRP')} returned to the buyer`;
      }
      continue;
    }
    switch (t.eventType) {
      case 'EscrowFunded': if (ms[n] && !ms[n].stage && typeof v.holdUntil === 'string') ms[n].stage = { fundedAt: String(v.fundedAt ?? t.timestamp), dueBy: String(v.stageDueBy), holdUntil: v.holdUntil };
        escrow.funded += Number(v.amount); because = `Escrow funded ${v.amount} ${c.total.currency}${v.txHash ? ' on the ledger' : ''}`; if (v.txHash) ledgerEscrows.push({ milestone: Number(v.milestone), txHash: String(v.txHash), sequence: Number(v.sequence), condition: String(v.condition), network: String(v.network), ledgerIndex: typeof v.ledgerIndex === 'number' ? v.ledgerIndex : null, ...(v.sealedSecret ? { sealedSecret: v.sealedSecret as Record<string, unknown> } : {}), feeEscrows: (v.feeEscrows as FeeEscrow[] | undefined) ?? [] }); break;
      case 'PaymentConfirmed': {
        const proc = String(v.contentClass ?? '');
        if (proc.startsWith('processor-') && ms[n]) {
          // Stripe events, confirmed by the processor (written by the payments function; attributed to it, not a party).
          const gross = Number(v.grossCents ?? 0) / 100; const p0 = ms[n].processor;
          if (proc === 'processor-payment') {
            const status = v.status as 'processing' | 'succeeded' | 'failed';
            if (status === 'succeeded' && p0?.status !== 'succeeded') {
              escrow.funded += gross; because = `Stage “${c.milestones[n].label}” paid through Stripe (${v.rail})`;
              ms[n].stage = { fundedAt: String(v.fundedAt ?? t.timestamp), dueBy: String(v.stageDueBy ?? c.milestones[n].dueBy), holdUntil: String(v.holdUntil) };
              payments.push({ reference: String(v.paymentIntentId), amount: gross, rail: `stripe-${v.rail}`, validated: false, confirmedBy: 'processor' });
            } else if (status === 'processing') because = `Bank payment for “${c.milestones[n].label}” is clearing (ACH takes a few business days)`;
            ms[n].processor = { status, rail: (v.rail as 'card' | 'ach' | 'pending') ?? 'pending', grossCents: Number(v.grossCents), paymentFeeCents: Number(v.paymentFeeCents ?? 0), paymentIntentId: String(v.paymentIntentId),
              ...(typeof v.treasuryCents === 'number' ? { funding: v.funding as PaymentFunding, cardCostCents: Number(v.cardCostCents ?? 0), treasuryCents: v.treasuryCents } : {}) };
          }
          if (proc === 'processor-transfer' && p0?.status === 'succeeded') {
            ms[n].state = 'released'; ms[n].releasedAmount += gross; escrow.released += gross;
            ms[n].processor = { ...p0, status: 'transferred', transferId: String(v.transferId), netCents: Number(v.netCents), feeCents: Number(v.feeCents) };
            const q = fees.milestones[n];
            if (q && q.feeUnits > 0) feeCharges.push({ milestone: n, currency: 'USD', feeUnits: Number(v.feeCents), sheetId: c.fees?.sheetId ?? '', settlement: 'processor', legs: [], owed: q.legs, collector: null, reference: String(v.transferId) });
            because = `Released ${gross} USD for “${c.milestones[n].label}” (Stripe transfer to the seller)`;
          }
          if (proc === 'processor-refund' && p0?.status === 'succeeded') { escrow.refunded += gross; if (v.expiredHold === true) expiredRefunds += gross; ms[n].stage = null; ms[n].processor = { ...p0, status: 'refunded' }; because = `Stage “${c.milestones[n].label}” refunded to the buyer through Stripe`; }
          if (proc === 'processor-clawback' && p0?.status === 'transferred') {
            ms[n].state = 'pending'; ms[n].releasedAmount -= gross; escrow.released -= gross; escrow.refunded += gross; ms[n].stage = null;
            ms[n].processor = { ...p0, status: 'clawed-back' };
            because = `Clawed back “${c.milestones[n].label}”: the transfer was reversed and the buyer refunded (${String(v.reason ?? 'operator ruling')})`;
          }
          if (proc === 'processor-dispute') { disputes.push({ n: disputes.length, by: c.buyerId, reason: `Chargeback opened with the buyer's bank: ${String(v.reason ?? 'unspecified')}`, resolved: null }); because = 'Chargeback opened'; }
          break;
        }
        payments.push({ reference: String(v.reference ?? ''), amount: Number(v.amount ?? 0), rail: String(v.rail ?? ''), validated: v.validated === true, ...(v.validated === true ? { confirmedBy: 'ledger' as const } : {}), ...(v.network ? { network: String(v.network) } : {}) }); break;
      }
      case 'MilestoneEvidenced': if (ms[n]) { ms[n].evidence.push({ kind: String(v.kind), hash: String(v.hash), note: String(v.note ?? ''), at: t.timestamp }); if (ms[n].state === 'pending') ms[n].state = 'evidenced'; because = `Evidence for “${c.milestones[n].label}”`; } break;
      case 'MilestoneAffirmed': case 'DeliveryApproved': if (ms[n] && ms[n].state === 'evidenced') {
        // An evaluator's acceptance counts only from the evaluator named in the terms, written from their own address.
        const byEvaluator = v.role === 'evaluator';
        if (byEvaluator && (!c.evaluatorId || v.by !== c.evaluatorId || t.sourceAddress !== partyAddress(c.evaluatorId))) break;
        ms[n].state = 'affirmed'; because = byEvaluator ? `Evaluator ${c.evaluatorId} accepted “${c.milestones[n].label}”` : `Buyer accepted “${c.milestones[n].label}”`; } break;
      case 'DeliveryRejected': if (ms[n]) { ms[n].state = 'pending'; rejected = true; because = `Buyer rejected delivery: ${v.reason ?? ''}`; } break;
      case 'EscrowReleased': if (v.txHash) ledgerSettlements.push({ milestone: n, kind: 'release', txHash: String(v.txHash), network: String(v.network) }); if (ms[n]) { ms[n].state = 'released'; ms[n].releasedAmount += Number(v.amount); escrow.released += Number(v.amount);
        // A stage paid directly on the ledger (rail ledger-staged) was never held: it is funded and released in one step.
        if (v.direct === true) { escrow.funded += Number(v.amount); because = `Paid ${formatMoney(Number(v.amount), c.total.currency)} on the ledger for “${c.milestones[n].label}”`; }
        else because = `Released ${v.amount} for “${c.milestones[n].label}”`; } break;
      case 'EscrowRefunded': if (ms[n] && ms[n].state !== 'released') ms[n].stage = null;
        if (v.expiredHold === true) expiredRefunds += Number(v.amount);
        escrow.refunded += Number(v.amount); if (v.txHash) ledgerSettlements.push({ milestone: n, kind: 'refund', txHash: String(v.txHash), network: String(v.network) }); because = `Refunded ${v.amount} to buyer${v.txHash ? ' (escrow cancelled on the ledger)' : ''}`; break;
      case 'DisputeRaised': disputes.push({ n: disputes.length, by: String(v.by), reason: String(v.reason), resolved: null }); if (ms[n]) ms[n].state = 'disputed'; because = `Dispute raised: ${v.reason}`; break;
      case 'DisputeResolved': { const d = disputes[Number(v.dispute)]; if (d) d.resolved = { resolution: v.resolution as 'release' | 'refund' | 'split', note: String(v.note ?? '') }; if (ms[n] && ms[n].state === 'disputed') ms[n].state = v.resolution === 'refund' ? 'pending' : 'affirmed'; because = `Dispute resolved (${v.resolution})`; break; }
      case 'FeeCharged': feeCharges.push({ milestone: n, currency: v.currency as FeeCharge['currency'], feeUnits: Number(v.feeUnits), sheetId: String(v.sheetId), settlement: v.settlement as FeeCharge['settlement'], legs: (v.legs as FeeCharge['legs']) ?? [], owed: (v.owed as FeeCharge['owed']) ?? [], collector: (v.collector as FeeCharge['collector']) ?? null, ...(v.reference ? { reference: String(v.reference) } : {}) }); break;
      case 'ReviewPosted': reviews.push({ by: String(v.by), rating: Number(v.rating), text: String(v.text ?? '') }); break;
    }
  }
  escrow.balance = Math.round((escrow.funded - escrow.released - escrow.refunded) * 100) / 100;
  const allReleased = ms.every((m) => m.state === 'released');
  const open = disputes.some((d) => !d.resolved);
  const staged = contractRail(c) === 'ledger-staged';
  const state = allReleased ? 'completed' : open ? 'disputed' : (channelRail ? channel?.closed === true : escrow.refunded - expiredRefunds > 1e-9 && escrow.balance <= 0 && escrow.released < c.total.amount) ? 'cancelled' : escrow.funded === 0 && !staged ? 'awaiting-funding' : 'in-progress';
  const next = ms.find((m) => m.state !== 'released');
  const nextAction: ContractView['nextAction'] = state === 'completed' ? { by: null, action: reviews.length < 2 ? 'Leave a review' : 'Done' }
    : state === 'cancelled' ? { by: null, action: 'Cancelled' }
    : open ? { by: 'operator', action: 'Resolve the dispute' }
    : !next ? { by: null, action: 'Done' }
    : channelRail ? (!channel ? { by: 'buyer', action: `Open the payment channel: up to ${capUnits} ${c.unit} at ${formatMoney(c.pricePerUnit.amount, 'XRP')} each (cap ${formatMoney(c.total.amount, 'XRP')}, returned unused within 30 days)` }
      : channel.releasedDrops === '0' ? { by: 'buyer', action: `Use the service and sign claims as you use it (each for the total used so far, up to ${capUnits} ${c.unit}); the seller redeems them` }
      : { by: 'seller', action: `Redeem the buyer's latest claim, or close the channel to return the unused ${formatMoney(Number(BigInt(channel.capDrops) - BigInt(channel.releasedDrops)) / 1_000_000, 'XRP')} (it expires ${channel.cancelAfter.slice(0, 10)})` })
    : !staged && escrow.balance + 1e-9 < amounts[next.index] ? { by: 'buyer', action: `Fund the next stage: ${Math.round((amounts[next.index] - Math.max(0, escrow.balance)) * 100) / 100} ${c.total.currency} for “${c.milestones[next.index].label}” (held up to 30 days)` }
    : next.state === 'pending' ? { by: 'seller', action: `${rejected ? 'Redeliver' : 'Show evidence'}: ${c.milestones[next.index].evidence}` }
    : next.state === 'evidenced' ? { by: 'buyer', action: `Review evidence and accept “${c.milestones[next.index].label}”${c.evaluatorId ? ` (or the evaluator ${c.evaluatorId} accepts)` : ''}` }
    : staged ? { by: 'buyer', action: `Pay ${formatMoney(amounts[next.index], c.total.currency)} on the ledger for “${c.milestones[next.index].label}” (seller net and fee legs)` }
    : { by: 'buyer', action: `Release ${amounts[next.index]} ${c.total.currency} for “${c.milestones[next.index].label}”` };
  return { ...c, ledgerEscrows, ledgerSettlements, channel, state, because: state === 'awaiting-funding' && because === 'Contract formed' ? (channelRail ? 'Contract formed; the buyer opens a payment channel for the cap' : 'Contract formed; nothing funded yet') : staged && because === 'Contract formed' ? 'Contract formed; each stage is paid on the ledger when accepted' : because, escrow, milestoneStates: ms, disputes, reviews, payments, nextAction, feeCharges,
    ...(links.parentContractId ? { parentContractId: links.parentContractId } : {}), subcontracts: links.subcontracts ?? [] };
}
