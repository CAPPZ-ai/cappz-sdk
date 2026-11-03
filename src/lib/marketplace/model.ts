/**
 * COPE node crystallized. Node ID: v14-19-00-marketplace-model.
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Transaction builders for every marketplace verb. Each builder checks the
 * replayed state and the rules, then returns the TXs it would write; callers
 * commit them through the governed command bus (people, the embedded agent)
 * or agentApi.ts (autonomous agents) as one batch. Builders never mutate state.
 * An agent party acts only within an active mandate (rules.checkMandate);
 * above its approval threshold a co-signature from the grantor is required.
 */
import { categoryOf } from './catalog';
import { marketLedger, type MarketTx } from './ledger';
import {
  contractAgreement, contractDelivery, contractDispute, contractEscrow, contractMilestone, contractReview, listingAddress, mandateAddress,
  offerAddress, partyAddress, requestAddress, tokenAddress,
} from './MarketplacePaths';
import type { MarketState } from './replay';
import { MarketRuleError, checkMandate, classifyToken, contractTotal, defaultMilestones, milestoneAmounts, milestonesFromPlan, splitIntoStages, validateMilestones, validateOffer, validateRequest, validateStageWindows } from './rules';
import { HOLD_LIMIT_DAYS, MAX_STAGE_DAYS, holdUntil } from './stageMath';
import type { ContractTerms, ContractView, ListingContent, MandateLimits, Money, PartyProfile, SupplyOfferContent, SupplyRequestContent, TokenClassification, TokenContent } from './types';
import { prepareTokenIssuance } from './xrpl';
import { DROPS_PER_XRP, MAINNET_ACKNOWLEDGEMENT, cancelAfterOf, checkEscrowCreate, checkEscrowFinish, escrowSequenceOf, milestoneEscrowLegs, type SettlementPolicy } from './settlement';
import type { LedgerTx, XrplNetwork } from '../xrpl/ledgerCheck';
import { MARKETPLACE_POW_ROOT } from './MarketplacePaths';
import type { MarketplaceVerb } from './marketplaceVerbs';
import { assertFeesFit, contractFeePlan, feeTermsFor, fromUnits, type FeeQuote } from './fees';

export interface Actor { partyId: string; at: string; /** Grantor co-signature for agent actions above the mandate's approval threshold. */ coSignedBy?: string }

const fail = (msg: string): never => { throw new MarketRuleError(msg); };
export const newId = (prefix: string) => `${prefix}-${Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
const tx = (eventType: MarketTx['eventType'], sourceAddress: string, targetAddress: string, payload: Record<string, unknown>) => marketLedger.create({ eventType, sourceAddress, targetAddress, payload });

/**
 * Form contract terms: split steps longer than the 30-day hold into stages, copy the fee schedule in force, and
 * refuse terms whose fees exceed a stage.
 */
function withFees(state: MarketState, terms: ContractTerms): ContractTerms {
  const milestones = splitIntoStages(terms.milestones, terms.formedAt);
  validateMilestones(milestones);
  validateStageWindows(milestones, terms.formedAt);
  const t = { ...terms, milestones, fees: feeTermsFor(state.fees, 'marketplace') };
  assertFeesFit(contractFeePlan(t));
  return t;
}

/** FeeCharged for one milestone: the seller's fee, routed to the DARC recipients, with how it was settled. */
function feeChargedTx(source: string, c: ContractTerms, q: FeeQuote, milestone: number, settlement: 'validated' | 'by-reference' | 'demo', legs: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  // `legs` is what moved now; `owed` is each DARC recipient's share, paid from the collection account later when there is one.
  return tx('FeeCharged', source, `${contractEscrow(c.contractId)}/fees/${milestone}`, { contractId: c.contractId, milestone, sheetId: c.fees?.sheetId ?? '', currency: q.currency, grossUnits: q.grossUnits, feeUnits: q.feeUnits, netUnits: q.netUnits, lines: q.lines, legs, owed: q.legs, collector: c.fees?.collector ?? null, payer: c.sellerId, settlement, ...extra });
}

function party(state: MarketState, id: string): PartyProfile {
  return state.parties.get(id) ?? fail('Set up your marketplace profile first.');
}

/** Agent parties must hold a mandate for value-bearing actions. Returns the mandate note recorded on the TX. */
function guard(state: MarketState, actor: Actor, verb: MarketplaceVerb, value: Money | null, categoryId: string | null): Record<string, unknown> {
  const p = party(state, actor.partyId);
  if (p.kind !== 'agent') return {};
  const today = state.committedByDay.get(`${p.partyId}|${actor.at.slice(0, 10)}`) ?? 0;
  const check = checkMandate(state.mandates, p.partyId, verb, value, categoryId, actor.at, today);
  if (!check.ok) fail(`Agent ${p.name}: ${check.reason}`);
  if (check.needsApproval) {
    const grantors = new Set(state.mandates.filter((m) => m.agentPartyId === p.partyId).map((m) => m.grantedBy));
    if (!actor.coSignedBy || !grantors.has(actor.coSignedBy)) fail(`Agent ${p.name}: ${check.reason} — co-signature missing.`);
  }
  return { agentPartyId: p.partyId, mandateCheck: check.reason, ...(actor.coSignedBy ? { coSignedBy: actor.coSignedBy } : {}) };
}

// ─── Parties ──────────────────────────────────────────────────────

export async function buildProfile(state: MarketState, actor: Actor, profile: PartyProfile): Promise<MarketTx[]> {
  if (profile.partyId !== actor.partyId) fail('You can only edit your own profile.');
  if (!profile.name.trim()) fail('Give your profile a name.');
  if (profile.kind === 'agent' && !profile.principal?.partyId && !profile.principal?.governanceAddress) fail('An agent needs an accountable principal: a person or organization, or a governance address for a non-human company.');
  const exists = state.parties.has(profile.partyId);
  return [await tx(exists ? 'ContentAmended' : 'ContentCreated', partyAddress(profile.partyId), partyAddress(profile.partyId), { contentClass: 'party', profile })];
}

// ─── Listings and orders ──────────────────────────────────────────

export async function buildListing(state: MarketState, actor: Actor, listing: ListingContent): Promise<MarketTx[]> {
  party(state, actor.partyId);
  if (listing.sellerId !== actor.partyId) fail('You can only list as yourself.');
  const cat = categoryOf(listing.categoryId) ?? fail('Choose a category.');
  if (!cat.kinds.includes(listing.kind)) fail(`${cat.label} does not support “${listing.kind}”.`);
  if (!listing.title.trim()) fail('Give the listing a title.');
  if (!(listing.quantity > 0)) fail('Quantity must be more than zero.');
  if (!(listing.pricePerUnit.amount > 0)) fail('Price must be more than zero.');
  if (listing.milestones) milestonesFromPlan(listing.milestones, actor.at.slice(0, 10));
  if (listing.tokenId) { const t = state.tokens.find((k) => k.content.tokenId === listing.tokenId) ?? fail('Unknown token.'); if ((t.balances[actor.partyId] ?? 0) <= 0) fail('You do not hold that token.'); }
  const note = guard(state, actor, 'marketplace.listing.publish', null, listing.categoryId);
  const exists = state.listings.some((l) => l.listingId === listing.listingId);
  return [await tx(exists ? 'ContentAmended' : 'ContentCreated', partyAddress(actor.partyId), listingAddress(listing.listingId), { contentClass: 'listing', listing, ...note })];
}

export async function buildWithdrawListing(state: MarketState, actor: Actor, listingId: string): Promise<MarketTx[]> {
  const l = state.listings.find((x) => x.listingId === listingId) ?? fail('Unknown listing.');
  if (l.sellerId !== actor.partyId) fail('Only the seller can withdraw a listing.');
  return [await tx('ListingWithdrawn', partyAddress(actor.partyId), listingAddress(listingId), { listingId })];
}

export async function buildInventoryAdjust(state: MarketState, actor: Actor, listingId: string, delta: number, reason: string): Promise<MarketTx[]> {
  const l = state.listings.find((x) => x.listingId === listingId) ?? fail('Unknown listing.');
  if (l.sellerId !== actor.partyId) fail('Only the seller can adjust inventory.');
  if (l.remaining + delta < 0) fail('Inventory cannot go below zero.');
  return [await tx('InventoryAdjusted', partyAddress(actor.partyId), listingAddress(listingId), { listingId, delta, reason })];
}

export async function buildOrder(state: MarketState, actor: Actor, listingId: string, quantity: number, deliveryDate?: string): Promise<{ contractId: string; txs: MarketTx[] }> {
  const l = state.listings.find((x) => x.listingId === listingId) ?? fail('Unknown listing.');
  party(state, actor.partyId);
  if (!l.open) fail('This listing is no longer available.');
  if (l.sellerId === actor.partyId) fail('You cannot buy your own listing.');
  if (!(quantity > 0)) fail('Quantity must be more than zero.');
  if (quantity > l.remaining) fail(`Only ${l.remaining} ${l.unit} left.`);
  const total = contractTotal(l.pricePerUnit, quantity);
  const note = guard(state, actor, 'marketplace.order.place', total, l.categoryId);
  const due = deliveryDate ?? new Date(Date.parse(actor.at) + l.leadDays * 86_400_000).toISOString().slice(0, 10);
  const contractId = newId('ct');
  const terms: ContractTerms = {
    contractId, buyerId: actor.partyId, sellerId: l.sellerId, source: { kind: 'listing', listingId }, categoryId: l.categoryId, title: l.title, quantity, unit: l.unit,
    pricePerUnit: l.pricePerUnit, total, milestones: l.milestones ? milestonesFromPlan(l.milestones, actor.at.slice(0, 10)) : defaultMilestones(l.kind === 'production-contract' ? 'production-contract' : 'spot', actor.at.slice(0, 10), due), formedAt: actor.at,
  };
  const formed = withFees(state, terms);
  return { contractId, txs: [await tx('OrderPlaced', partyAddress(actor.partyId), contractAgreement(contractId), { contractId, terms: formed, ...note })] };
}

// ─── Requests for supply, offers and awards ───────────────────────

export async function buildRequest(state: MarketState, actor: Actor, request: SupplyRequestContent): Promise<MarketTx[]> {
  party(state, actor.partyId);
  if (request.buyerId !== actor.partyId) fail('You can only request as yourself.');
  validateRequest(request, actor.at);
  const note = guard(state, actor, 'marketplace.request.post', request.maxPricePerUnit ? contractTotal(request.maxPricePerUnit, request.quantity) : null, request.categoryId);
  return [await tx('SupplyRequested', partyAddress(actor.partyId), requestAddress(request.requestId), { request, ...note })];
}

export async function buildCloseRequest(state: MarketState, actor: Actor, requestId: string, reason: string): Promise<MarketTx[]> {
  const r = state.requests.find((x) => x.requestId === requestId) ?? fail('Unknown request.');
  if (r.buyerId !== actor.partyId) fail('Only the buyer can close a request.');
  return [await tx('SupplyRequestClosed', partyAddress(actor.partyId), requestAddress(requestId), { requestId, reason })];
}

export async function buildOffer(state: MarketState, actor: Actor, offer: SupplyOfferContent): Promise<{ warnings: string[]; txs: MarketTx[] }> {
  const r = state.requests.find((x) => x.requestId === offer.requestId) ?? fail('Unknown request.');
  party(state, actor.partyId);
  if (!r.open) fail('This request is closed.');
  if (offer.sellerId !== actor.partyId) fail('You can only bid as yourself.');
  if (r.buyerId === actor.partyId) fail('You cannot bid on your own request.');
  // Steps longer than the 30-day hold become stages before the bid is recorded, so the buyer sees the real schedule.
  const staged = { ...offer, milestones: splitIntoStages(offer.milestones, actor.at) };
  const warnings = validateOffer(staged, r, actor.at);
  if (staged.milestones.length > offer.milestones.length) warnings.push(`Steps longer than 30 days were split into ${staged.milestones.length} stages: holds are limited to a 30-day billing cycle, and each stage is funded when the previous one completes.`);
  const note = guard(state, actor, 'marketplace.offer.submit', contractTotal(offer.pricePerUnit, offer.quantity), r.categoryId);
  return { warnings, txs: [await tx('SupplyOffered', partyAddress(actor.partyId), offerAddress(r.requestId, offer.offerId), { offer: staged, warnings, ...note })] };
}

export async function buildWithdrawOffer(state: MarketState, actor: Actor, requestId: string, offerId: string): Promise<MarketTx[]> {
  const o = state.requests.find((x) => x.requestId === requestId)?.offers.find((x) => x.offerId === offerId) ?? fail('Unknown offer.');
  if (o.sellerId !== actor.partyId) fail('Only the bidder can withdraw an offer.');
  if (o.awardedQuantity > 0) fail('An awarded offer cannot be withdrawn; it is a contract now.');
  return [await tx('SupplyOfferWithdrawn', partyAddress(actor.partyId), offerAddress(requestId, offerId), { requestId, offerId })];
}

export async function buildAward(state: MarketState, actor: Actor, requestId: string, offerId: string, quantity?: number): Promise<{ contractId: string; txs: MarketTx[] }> {
  const r = state.requests.find((x) => x.requestId === requestId) ?? fail('Unknown request.');
  if (r.buyerId !== actor.partyId) fail('Only the buyer can award.');
  const o = r.offers.find((x) => x.offerId === offerId) ?? fail('Unknown offer.');
  if (o.withdrawn) fail('That offer was withdrawn.');
  const qty = quantity ?? Math.min(o.quantity - o.awardedQuantity, r.quantity - r.awardedQuantity);
  if (!(qty > 0)) fail('Nothing left to award on this offer or request.');
  if (qty > o.quantity - o.awardedQuantity) fail('More than the offer covers.');
  if (qty > r.quantity - r.awardedQuantity) fail('More than the request still needs.');
  validateMilestones(o.milestones);
  const total = contractTotal(o.pricePerUnit, qty);
  const note = guard(state, actor, 'marketplace.offer.award', total, r.categoryId);
  const contractId = newId('ct');
  const terms = withFees(state, { contractId, buyerId: r.buyerId, sellerId: o.sellerId, source: { kind: 'request', requestId, offerId }, categoryId: r.categoryId, title: r.title, quantity: qty, unit: r.unit, pricePerUnit: o.pricePerUnit, total, milestones: o.milestones, formedAt: actor.at });
  return { contractId, txs: [await tx('SupplyAwarded', partyAddress(actor.partyId), contractAgreement(contractId), { contractId, requestId, offerId, terms, ...note })] };
}

// ─── Escrow, milestones, delivery, disputes, reviews ──────────────

function contract(state: MarketState, contractId: string) {
  return state.contracts.find((c) => c.contractId === contractId) ?? fail('Unknown contract.');
}

/** The stage now open for funding: the first unreleased one. Later stages are configured and funded as each completes. */
export function currentStage(c: ContractView): { index: number; amount: number; need: number } | null {
  const next = c.milestoneStates.find((m) => m.state !== 'released');
  if (!next) return null;
  const amount = milestoneAmounts(c.total.amount, c.milestones)[next.index];
  return { index: next.index, amount, need: Math.round((amount - c.escrow.balance) * 100) / 100 };
}

/**
 * Configure a stage as it is funded: its due date is the planned one when that falls inside the hold window,
 * otherwise the window's end; a requested date must be inside it. The hold ends 30 days after funding.
 */
export function configureStage(c: ContractView, index: number, at: string, requestedDueBy?: string): { stageDueBy: string; holdUntil: string; fundedAt: string } {
  const existing = c.milestoneStates[index]?.stage;
  if (existing) return { stageDueBy: existing.dueBy, holdUntil: existing.holdUntil, fundedAt: existing.fundedAt };
  const min = at.slice(0, 10);
  const max = new Date(Date.parse(at) + MAX_STAGE_DAYS * 86_400_000).toISOString().slice(0, 10);
  const planned = c.milestones[index].dueBy;
  if (requestedDueBy && (requestedDueBy < min || requestedDueBy > max)) fail(`A stage is due within ${MAX_STAGE_DAYS} days of funding (${min} to ${max}): holds are limited to a ${HOLD_LIMIT_DAYS}-day billing cycle.`);
  const stageDueBy = requestedDueBy ?? (planned < min ? min : planned > max ? max : planned);
  return { stageDueBy, holdUntil: holdUntil(at), fundedAt: at };
}

/** Fund the current stage (USD by reference, or demo). One stage at a time: later stages wait for this one to complete. */
export async function buildFund(state: MarketState, actor: Actor, contractId: string, amount: number, payment: { rail: 'xrpl-testnet' | 'usd-reference' | 'demo'; reference?: string }, stageDueBy?: string): Promise<MarketTx[]> {
  const c = contract(state, contractId);
  if (c.buyerId !== actor.partyId) fail('Only the buyer funds escrow.');
  if (!(amount > 0)) fail('Amount must be more than zero.');
  if (c.total.currency === 'XRP' && payment.rail !== 'demo') fail('XRP contracts are funded with on-ledger escrow (one EscrowCreate per stage leg), not by reference.');
  const stage = currentStage(c) ?? fail('Every stage is paid.');
  if (stage.need <= 0) fail(`“${c.milestones[stage.index].label}” is funded. The next stage is configured and funded when it completes.`);
  if (amount > stage.need + 1e-9) fail(`Fund one stage at a time: “${c.milestones[stage.index].label}” needs ${stage.need} ${c.total.currency}. Later stages are funded as each completes — holds are limited to a ${HOLD_LIMIT_DAYS}-day billing cycle.`);
  const cfg = configureStage(c, stage.index, actor.at, stageDueBy);
  const note = guard(state, actor, 'marketplace.escrow.fund', { amount, currency: c.total.currency }, c.categoryId);
  const out = [await tx('EscrowFunded', partyAddress(actor.partyId), contractEscrow(contractId), { contractId, amount, currency: c.total.currency, rail: payment.rail, milestone: stage.index, ...cfg, ...note })];
  if (payment.reference) out.push(await tx('PaymentConfirmed', partyAddress(actor.partyId), contractEscrow(contractId), { contractId, amount, rail: payment.rail, reference: payment.reference, validated: false, milestone: stage.index }));
  return out;
}

/** After a stage's 30-day hold ends unreleased, the buyer takes the escrow back (the stage can be funded again). */
export async function buildExpiredRefund(state: MarketState, actor: Actor, contractId: string): Promise<MarketTx[]> {
  const c = contract(state, contractId);
  if (c.buyerId !== actor.partyId) fail('Only the buyer takes back an expired hold.');
  const stage = currentStage(c) ?? fail('Every stage is paid.');
  const st = c.milestoneStates[stage.index].stage ?? fail('This stage is not funded.');
  if (Date.parse(actor.at) <= Date.parse(st.holdUntil)) fail(`The hold runs until ${st.holdUntil.slice(0, 10)}; release or dispute it before then.`);
  if (c.ledgerEscrows.some((e) => e.milestone === stage.index)) fail('This stage is escrowed on the ledger: submit EscrowCancel (allowed after CancelAfter) and record it.');
  return [await tx('EscrowRefunded', partyAddress(actor.partyId), contractEscrow(contractId), { contractId, milestone: stage.index, amount: c.escrow.balance, to: c.buyerId, expiredHold: true })];
}

export async function buildEvidence(state: MarketState, actor: Actor, contractId: string, milestone: number, evidence: { kind: 'photo' | 'document' | 'inspection' | 'sensor' | 'delivery-receipt'; hash: string; note: string }): Promise<MarketTx[]> {
  const c = contract(state, contractId);
  if (c.sellerId !== actor.partyId) fail('Only the seller submits evidence.');
  const m = c.milestoneStates[milestone] ?? fail('Unknown milestone.');
  if (m.state === 'released') fail('That milestone is already paid.');
  if (!/^[0-9a-f]{64}$/.test(evidence.hash)) fail('Evidence must be referenced by its sha256 hash (the file itself stays with you).');
  const target = c.milestones[milestone].delivery ? contractDelivery(contractId, milestone) : contractMilestone(contractId, milestone);
  return [await tx('MilestoneEvidenced', partyAddress(actor.partyId), target, { contractId, milestone, ...evidence })];
}

export async function buildAffirm(state: MarketState, actor: Actor, contractId: string, milestone: number): Promise<MarketTx[]> {
  const c = contract(state, contractId);
  if (c.buyerId !== actor.partyId) fail('Only the buyer accepts a milestone.');
  if (c.milestoneStates[milestone]?.state !== 'evidenced') fail('There is no new evidence to accept for that milestone.');
  const delivery = c.milestones[milestone].delivery;
  return [await tx(delivery ? 'DeliveryApproved' : 'MilestoneAffirmed', partyAddress(actor.partyId), delivery ? contractDelivery(contractId, milestone) : contractMilestone(contractId, milestone), { contractId, milestone })];
}

export async function buildRejectDelivery(state: MarketState, actor: Actor, contractId: string, milestone: number, reason: string): Promise<MarketTx[]> {
  const c = contract(state, contractId);
  if (c.buyerId !== actor.partyId) fail('Only the buyer rejects a delivery.');
  if (!c.milestones[milestone]?.delivery || c.milestoneStates[milestone].state !== 'evidenced') fail('Only a delivered, not yet accepted delivery can be rejected.');
  if (!reason.trim()) fail('Say why the delivery is rejected.');
  return [await tx('DeliveryRejected', partyAddress(actor.partyId), contractDelivery(contractId, milestone), { contractId, milestone, reason })];
}

export async function buildRelease(state: MarketState, actor: Actor, contractId: string, milestone: number): Promise<MarketTx[]> {
  const c = contract(state, contractId);
  if (c.buyerId !== actor.partyId) fail('Only the buyer releases escrow (an operator can, by resolving a dispute).');
  if (c.milestoneStates[milestone]?.state !== 'affirmed') fail('Accept the milestone before releasing payment.');
  if (c.ledgerEscrows.some((e) => e.milestone === milestone)) fail('This milestone is escrowed on the ledger: reveal its secret, submit EscrowFinish, and record the ledger transaction.');
  const amount = milestoneAmounts(c.total.amount, c.milestones)[milestone];
  if (c.escrow.balance + 1e-9 < amount) fail(`Escrow holds ${c.escrow.balance} ${c.total.currency}; ${amount} is needed.`);
  const st = c.milestoneStates[milestone].stage;
  if (st && Date.parse(actor.at) > Date.parse(st.holdUntil)) fail(`The 30-day hold for this stage ended ${st.holdUntil.slice(0, 10)}: take it back and fund the stage again, or ask an operator.`);
  return releaseOffLedger(partyAddress(actor.partyId), c, milestone, amount, {});
}

/** An off-ledger release (USD by reference, or demo): the seller is owed the net; the fee is charged in the same batch. */
async function releaseOffLedger(source: string, c: ContractView, milestone: number, amount: number, extra: Record<string, unknown>): Promise<MarketTx[]> {
  const q = contractFeePlan(c).milestones[milestone];
  const out = [await tx('EscrowReleased', source, contractEscrow(c.contractId), { contractId: c.contractId, milestone, amount, to: c.sellerId, netToSeller: fromUnits(q.netUnits, q.currency), fee: fromUnits(q.feeUnits, q.currency), ...extra })];
  if (q.feeUnits > 0) out.push(await feeChargedTx(source, c, q, milestone, c.payments.length ? 'by-reference' : 'demo', q.legs.map((l) => ({ ...l }))));
  return out;
}

export async function buildDispute(state: MarketState, actor: Actor, contractId: string, milestone: number | null, reason: string): Promise<MarketTx[]> {
  const c = contract(state, contractId);
  if (actor.partyId !== c.buyerId && actor.partyId !== c.sellerId) fail('Only the buyer or seller can raise a dispute.');
  if (c.state === 'completed') fail('This contract is complete.');
  if (!reason.trim()) fail('Describe the problem.');
  return [await tx('DisputeRaised', partyAddress(actor.partyId), contractDispute(contractId, c.disputes.length), { contractId, milestone: milestone ?? -1, by: actor.partyId, reason })];
}

/** Operator resolution (moderator/admin verb): release the milestone, refund the buyer, or split. */
export async function buildResolve(state: MarketState, operatorAddress: string, contractId: string, dispute: number, resolution: 'release' | 'refund' | 'split', note: string, refundAmount?: number): Promise<MarketTx[]> {
  const c = contract(state, contractId);
  const d = c.disputes[dispute] ?? fail('Unknown dispute.');
  if (d.resolved) fail('Already resolved.');
  const out = [await tx('DisputeResolved', operatorAddress, contractDispute(contractId, dispute), { contractId, dispute, resolution, note, milestone: -1 })];
  const next = c.milestoneStates.find((m) => m.state !== 'released');
  // On-ledger escrow: the ledger, not the operator, moves XRP. The resolution is recorded; the seller is paid when the
  // buyer reveals the secret (EscrowFinish), or the buyer is refunded by EscrowCancel after CancelAfter.
  if (next && c.ledgerEscrows.some((e) => e.milestone === next.index)) return out;
  if (resolution === 'release' && next) {
    const amount = milestoneAmounts(c.total.amount, c.milestones)[next.index];
    if (c.escrow.balance + 1e-9 < amount) fail('Escrow does not hold enough to release.');
    out.push(...await releaseOffLedger(operatorAddress, c, next.index, amount, { byResolution: dispute }));
  }
  if (resolution === 'refund' || resolution === 'split') {
    const amount = resolution === 'refund' ? c.escrow.balance : Math.min(refundAmount ?? c.escrow.balance / 2, c.escrow.balance);
    if (amount > 0) out.push(await tx('EscrowRefunded', operatorAddress, contractEscrow(contractId), { contractId, amount, to: c.buyerId, byResolution: dispute }));
  }
  return out;
}

export async function buildReview(state: MarketState, actor: Actor, contractId: string, rating: number, text: string): Promise<MarketTx[]> {
  const c = contract(state, contractId);
  if (actor.partyId !== c.buyerId && actor.partyId !== c.sellerId) fail('Only the parties can review.');
  if (c.state !== 'completed' && c.state !== 'cancelled') fail('Reviews open when the contract is finished.');
  if (c.reviews.some((r) => r.by === actor.partyId)) fail('You already reviewed this contract.');
  if (!(rating >= 1 && rating <= 5 && Number.isInteger(rating))) fail('Rating is 1 to 5.');
  return [await tx('ReviewPosted', partyAddress(actor.partyId), contractReview(contractId, actor.partyId), { contractId, by: actor.partyId, rating, text })];
}

// ─── Receipt tokens ───────────────────────────────────────────────

export async function buildTokenize(state: MarketState, actor: Actor, input: Omit<TokenContent, 'classification' | 'xrpl' | 'issuerId'> & { answers: Omit<TokenClassification, 'result' | 'reasons'>; issuerAccount: string }): Promise<{ classification: TokenClassification; txs: MarketTx[] }> {
  party(state, actor.partyId);
  const cat = categoryOf(input.categoryId) ?? fail('Choose a category.');
  if (!cat.tokenizable) fail(`${cat.label} cannot be tokenized in this release.`);
  const classification = classifyToken(input.answers);
  if (classification.result === 'blocked') fail(classification.reasons.join(' '));
  if (!(Number.isInteger(input.supply) && input.supply > 0)) fail('Supply must be a whole number of tokens.');
  if (!(input.redeemsFor.quantity > 0)) fail('Say what one token redeems for.');
  if (!input.backing.evidence.length) fail('Attach at least one piece of backing evidence (by hash).');
  const note = guard(state, actor, 'marketplace.asset.tokenize', null, input.categoryId);
  const { answers: _answers, issuerAccount, ...rest } = input;
  const token: TokenContent = { ...rest, issuerId: actor.partyId, classification, xrpl: { network: 'testnet', preparedIssuance: prepareTokenIssuance(rest, issuerAccount) } };
  return { classification, txs: [await tx('AssetTokenized', partyAddress(actor.partyId), tokenAddress(token.tokenId), { token, ...note })] };
}

export async function buildTokenTransfer(state: MarketState, actor: Actor, tokenId: string, to: string, amount: number, contractId?: string): Promise<MarketTx[]> {
  const t = state.tokens.find((k) => k.content.tokenId === tokenId) ?? fail('Unknown token.');
  if (!state.parties.has(to)) fail('Unknown recipient.');
  if (!(Number.isInteger(amount) && amount > 0)) fail('Transfer a whole number of tokens.');
  if ((t.balances[actor.partyId] ?? 0) < amount) fail('Not enough tokens.');
  const note = guard(state, actor, 'marketplace.token.transfer', null, t.content.categoryId);
  return [await tx('TokenTransferred', partyAddress(actor.partyId), tokenAddress(tokenId), { tokenId, from: actor.partyId, to, amount, ...(contractId ? { contractId } : {}), ...note })];
}

export async function buildTokenRedeem(state: MarketState, actor: Actor, tokenId: string, amount: number): Promise<MarketTx[]> {
  const t = state.tokens.find((k) => k.content.tokenId === tokenId) ?? fail('Unknown token.');
  if (!(Number.isInteger(amount) && amount > 0)) fail('Redeem a whole number of tokens.');
  if ((t.balances[actor.partyId] ?? 0) < amount) fail('Not enough tokens.');
  return [await tx('TokenRedeemed', partyAddress(actor.partyId), tokenAddress(tokenId), { tokenId, holder: actor.partyId, amount, redeems: { quantity: amount * t.content.redeemsFor.quantity, unit: t.content.redeemsFor.unit }, custodian: t.content.backing.custodian })];
}

// ─── Agent mandates (governance, separate from identity and settlement) ──

export async function buildMandate(state: MarketState, actor: Actor, agentPartyId: string, limits: MandateLimits): Promise<{ mandateId: string; txs: MarketTx[] }> {
  const agent = state.parties.get(agentPartyId) ?? fail('Unknown agent.');
  if (agent.kind !== 'agent') fail('Mandates are for agent parties.');
  const accountable = agent.principal?.partyId ?? agentPartyId; // a non-human company governs itself through its governance address
  if (actor.partyId !== accountable) fail('Only the agent’s principal can grant its mandate.');
  if (!limits.verbs.length) fail('Choose what the agent may do.');
  if (!(limits.maxPerContract.amount > 0 && limits.maxPerDay.amount >= limits.maxPerContract.amount)) fail('Set a per-contract limit and a daily limit at least as large.');
  if (Date.parse(limits.expiresAt) <= Date.parse(actor.at)) fail('The mandate must expire in the future.');
  const mandateId = newId('mandate');
  return { mandateId, txs: [await tx('PermissionGranted', partyAddress(actor.partyId), mandateAddress(agentPartyId, mandateId), { contentClass: 'mandate', mandate: { mandateId, agentPartyId, grantedBy: actor.partyId, limits }, ...(agent.principal?.governanceAddress ? { governanceAddress: agent.principal.governanceAddress } : {}) })] };
}

export async function buildRevokeMandate(state: MarketState, actor: Actor, mandateId: string): Promise<MarketTx[]> {
  const m = state.mandates.find((x) => x.mandateId === mandateId) ?? fail('Unknown or already revoked mandate.');
  if (m.grantedBy !== actor.partyId) fail('Only the grantor can revoke a mandate.');
  return [await tx('PermissionRevoked', partyAddress(actor.partyId), mandateAddress(m.agentPartyId, mandateId), { contentClass: 'mandate', mandateId })];
}

// ─── On-ledger settlement (XRP contracts) ─────────────────────────

/** Admin policy: which XRPL network settles contracts. Mainnet requires the recorded compliance acknowledgement. */
export async function buildSettlementNetwork(operatorAddress: string, network: XrplNetwork, acknowledgement: string): Promise<MarketTx[]> {
  if (network === 'mainnet' && acknowledgement.trim() !== MAINNET_ACKNOWLEDGEMENT) fail('Mainnet settlement needs the exact compliance acknowledgement.');
  return [await tx('SettlementRailDeclared', operatorAddress, `${MARKETPLACE_POW_ROOT}/settlement`, { network, by: operatorAddress, ...(network === 'mainnet' ? { acknowledgement: acknowledgement.trim() } : {}), rail: 'xrpl' })];
}

function ledgerAccounts(state: MarketState, c: { buyerId: string; sellerId: string }) {
  const buyer = state.parties.get(c.buyerId)?.xrplAccount ?? fail('The buyer has no XRPL account on their profile.');
  const seller = state.parties.get(c.sellerId)?.xrplAccount ?? fail('The seller has no XRPL account on their profile.');
  return { buyer, seller };
}

/** Fund milestones from validated EscrowCreate transactions — every leg (seller net + fee recipients) under one condition; refuses anything the ledger does not show. */
export async function buildFundOnLedger(state: MarketState, actor: Actor, contractId: string, policy: SettlementPolicy, checks: Array<{ milestone: number; lt: LedgerTx; condition: string; /** The escrow secret, sealed under the buyer's own session-wallet key: only the buyer can reveal it. */ sealedSecret?: Record<string, unknown> }>): Promise<MarketTx[]> {
  const c = contract(state, contractId);
  if (c.buyerId !== actor.partyId) fail('Only the buyer funds escrow.');
  if (c.total.currency !== 'XRP') fail('On-ledger escrow is for XRP-priced contracts.');
  const { buyer, seller } = ledgerAccounts(state, c);
  const amounts = milestoneAmounts(c.total.amount, c.milestones);
  const out: MarketTx[] = [];
  for (const milestone of [...new Set(checks.map((k) => k.milestone))]) {
    if (c.ledgerEscrows.some((e) => e.milestone === milestone)) fail(`Milestone ${milestone + 1} is already escrowed on the ledger.`);
    if (milestone !== currentStage(c)?.index) fail(`Fund one stage at a time: stage ${milestone + 1} is funded after the stages before it complete (holds are limited to a ${HOLD_LIMIT_DAYS}-day billing cycle).`);
    const group = checks.filter((k) => k.milestone === milestone);
    const condition = group[0].condition;
    if (group.some((k) => k.condition.toUpperCase() !== condition.toUpperCase())) fail(`Milestone ${milestone + 1}: every leg must use the milestone's one condition.`);
    const legs = milestoneEscrowLegs(c, milestone, seller);
    const used = new Set<LedgerTx>();
    const funded = legs.map((leg) => {
      const k = group.find((g) => !used.has(g.lt) && g.lt.destination === leg.account && String(g.lt.fields.Amount) === leg.drops)
        ?? fail(`Milestone ${milestone + 1}: no EscrowCreate for the ${leg.label} leg (${leg.drops} drops to ${leg.account}).`);
      used.add(k.lt);
      const problems = checkEscrowCreate(k.lt, { network: policy.network, contractId, milestone, buyerAccount: buyer, sellerAccount: leg.account, drops: leg.drops, condition });
      if (problems.length) fail(`Milestone ${milestone + 1}${leg.role === 'fee' ? ` (${leg.label} fee leg)` : ''}: ${problems.join(' ')}`);
      return { leg, lt: k.lt, sealedSecret: k.sealedSecret };
    });
    if (used.size !== group.length) fail(`Milestone ${milestone + 1}: an EscrowCreate matches no leg of this contract.`);
    const main = funded.find((f) => f.leg.role === 'seller') ?? fail(`Milestone ${milestone + 1}: the seller's leg is missing.`);
    // The ledger enforces the 30-day hold: every leg must cancel back to the buyer within 30 days of funding.
    const fundedAt = main.lt.closeTime ?? main.lt.checkedAt;
    const cancelAt = cancelAfterOf(main.lt) ?? fail(`Milestone ${milestone + 1}: no CancelAfter, so the escrow could be held indefinitely.`);
    for (const f of funded) { const ca = cancelAfterOf(f.lt); if (!ca || Date.parse(ca) > Date.parse(holdUntil(fundedAt)) + 86_400_000) fail(`Milestone ${milestone + 1}${f.leg.role === 'fee' ? ` (${f.leg.label} fee leg)` : ''}: CancelAfter is more than ${HOLD_LIMIT_DAYS} days after funding; holds are limited to a ${HOLD_LIMIT_DAYS}-day billing cycle.`); }
    const planned = c.milestones[milestone].dueBy; const lastDay = new Date(Date.parse(cancelAt) - 86_400_000).toISOString().slice(0, 10);
    const stageCfg = { fundedAt, stageDueBy: planned > lastDay ? lastDay : planned < fundedAt.slice(0, 10) ? fundedAt.slice(0, 10) : planned, holdUntil: cancelAt };
    const sealedSecret = funded.find((f) => f.sealedSecret)?.sealedSecret;
    const feeEscrows = funded.filter((f) => f.leg.role === 'fee').map((f) => ({ account: f.leg.account, label: f.leg.label, drops: f.leg.drops, txHash: f.lt.hash, sequence: escrowSequenceOf(f.lt) }));
    const note = guard(state, actor, 'marketplace.escrow.fund', { amount: amounts[milestone], currency: 'XRP' }, c.categoryId);
    out.push(await tx('EscrowFunded', partyAddress(actor.partyId), contractEscrow(contractId), { contractId, amount: amounts[milestone], currency: 'XRP', rail: 'xrpl-escrow', milestone, network: main.lt.network, txHash: main.lt.hash, sequence: escrowSequenceOf(main.lt), condition, ledgerIndex: main.lt.ledgerIndex, checkedAt: main.lt.checkedAt, feeEscrows, ...stageCfg, ...(sealedSecret ? { sealedSecret } : {}), ...note }));
    for (const f of funded) out.push(await tx('PaymentConfirmed', partyAddress(actor.partyId), contractEscrow(contractId), { contractId, amount: Number(f.leg.drops) / DROPS_PER_XRP, rail: 'xrpl-escrow', leg: f.leg.role, to: f.leg.account, reference: f.lt.hash, validated: true, network: f.lt.network, ledgerIndex: f.lt.ledgerIndex, checkedAt: f.lt.checkedAt }));
  }
  return out;
}

/**
 * Record a release (EscrowFinish) or a refund (EscrowCancel) the ledger shows for a milestone's escrow. Every fee
 * leg must be finished (or cancelled) too — once the secret is revealed anyone can submit them — so a release is
 * recorded only with the fee routed on the ledger.
 */
export async function buildSettleOnLedger(state: MarketState, actor: Actor, contractId: string, milestone: number, lt: LedgerTx, policy: SettlementPolicy, feeLts: LedgerTx[] = []): Promise<MarketTx[]> {
  const c = contract(state, contractId);
  if (actor.partyId !== c.buyerId && actor.partyId !== c.sellerId) fail('Only the parties record ledger settlement.');
  const e = c.ledgerEscrows.find((x) => x.milestone === milestone) ?? fail('That milestone has no on-ledger escrow.');
  const { buyer } = ledgerAccounts(state, c);
  const type = lt.type === 'EscrowCancel' ? 'EscrowCancel' : 'EscrowFinish';
  const problems = checkEscrowFinish(lt, { network: policy.network, owner: buyer, offerSequence: e.sequence, type });
  if (problems.length) fail(problems.join(' '));
  const legs = e.feeEscrows.map((f) => {
    const flt = feeLts.find((x) => Number(x.fields.OfferSequence) === f.sequence) ?? fail(`${type === 'EscrowFinish' ? 'Finish' : 'Cancel'} the ${f.label} fee escrow too (sequence ${f.sequence}); anyone can submit it once the secret is revealed.`);
    const p = checkEscrowFinish(flt, { network: policy.network, owner: buyer, offerSequence: f.sequence, type });
    if (p.length) fail(`${f.label} fee leg: ${p.join(' ')}`);
    return { f, flt };
  });
  const amount = milestoneAmounts(c.total.amount, c.milestones)[milestone];
  const onLedger = { onLedger: true, network: lt.network, txHash: lt.hash, ledgerIndex: lt.ledgerIndex, checkedAt: lt.checkedAt };
  if (type === 'EscrowFinish') {
    const st = c.milestoneStates[milestone].state;
    if (st === 'released') fail('This milestone is already recorded as released.');
    if (st !== 'affirmed') fail('The buyer has not accepted this milestone; a finished escrow without acceptance should be disputed.');
    const q = contractFeePlan(c).milestones[milestone];
    const out = [await tx('EscrowReleased', partyAddress(actor.partyId), contractEscrow(contractId), { contractId, milestone, amount, to: c.sellerId, netToSeller: fromUnits(q.netUnits, 'XRP'), fee: fromUnits(q.feeUnits, 'XRP'), ...onLedger })];
    if (legs.length) out.push(await feeChargedTx(partyAddress(actor.partyId), c, q, milestone, 'validated', legs.map(({ f, flt }) => ({ account: f.account, label: f.label, units: Number(f.drops), bps: q.payLegs.find((l) => l.account === f.account)?.bps ?? 0, escrowTxHash: f.txHash, txHash: flt.hash, ledgerIndex: flt.ledgerIndex, checkedAt: flt.checkedAt })), { network: lt.network }));
    return out;
  }
  const st = c.milestoneStates[milestone].stage;
  const expiredHold = !!st && Date.parse(actor.at) > Date.parse(st.holdUntil) && !c.disputes.some((d) => !d.resolved);
  return [await tx('EscrowRefunded', partyAddress(actor.partyId), contractEscrow(contractId), { contractId, milestone, amount, to: c.buyerId, ...onLedger, feeCancels: legs.map(({ f, flt }) => ({ account: f.account, txHash: flt.hash })), ...(expiredHold ? { expiredHold: true } : {}) })];
}
