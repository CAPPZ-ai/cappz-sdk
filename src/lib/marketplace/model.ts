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
import { subcontractAddress } from './MarketplacePaths';
import type { MarketState } from './replay';
import { subcontractGate } from './rules';
import { MarketRuleError, checkAcceptance, checkMandate, classifyToken, committedKey, contractTotal, defaultMilestones, milestoneAmounts, milestonesFromPlan, splitIntoStages, validateMilestones, validateOffer, validateRequest, validateStageWindows } from './rules';
import { HOLD_LIMIT_DAYS, MAX_STAGE_DAYS, holdUntil } from './stageMath';
import type { ContractTerms, ContractView, ListingContent, MandateLimits, MilestoneTerm, Money, PartyProfile, SupplyOfferContent, SupplyRequestContent, TokenClassification, TokenContent } from './types';
import { prepareTokenIssuance } from './xrpl';
import { DROPS_PER_XRP, MAINNET_ACKNOWLEDGEMENT, cancelAfterOf, checkEscrowCreate, checkEscrowFinish, escrowSequenceOf, milestoneEscrowLegs, type SettlementPolicy } from './settlement';
import type { LedgerTx, XrplNetwork } from '../xrpl/ledgerCheck';
import { MARKETPLACE_POW_ROOT } from './MarketplacePaths';
import type { MarketplaceVerb } from './marketplaceVerbs';
import { assertFeesFit, contractFeePlan, feeTermsFor, fromUnits, type FeeQuote } from './fees';
import { assetAvailability, assetLabel, defaultRail, isLedgerAsset, paymentAsset, resolvePaymentAsset } from './paymentAssets';
import { checkLedgerPayment } from './ledgerPayments';
import { CHANNEL_SETTLE_DELAY, channelCapDrops, channelFeeQuote, channelIdOf, checkChannelClaim, checkChannelCreate, contractRail, payChannelNode, stagePaymentLegs, unitsForDrops } from './settlement';
import { agentKeyState, profileKeyProblems } from './agentKeys';
import { principalCredentialProblems } from './principalCredential';

export interface Actor { partyId: string; at: string; /** Grantor co-signature for agent actions above the mandate's approval threshold. */ coSignedBy?: string;
  /** The market's network (one market per network). When set, prices in an asset not offered there are refused. */ network?: XrplNetwork }

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
  // The rail is frozen with the terms: XRP escrows per stage, issued tokens are paid stage by stage, USD keeps its choice of processor or reference.
  // A metered deal asks for the channel rail; any requested rail must be one the asset settles on.
  if (terms.rail && !paymentAsset(terms.total.currency).rails.includes(terms.rail)) fail(`${assetLabel(terms.total.currency)} does not settle on ${terms.rail}.`);
  const t = { ...terms, milestones, fees: feeTermsFor(state.fees, 'marketplace'), ...(terms.rail ? { rail: terms.rail } : isLedgerAsset(terms.total.currency) ? { rail: defaultRail(terms.total.currency) } : {}) };
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

/** A price must name a known payment asset, offered on the market's network when the actor names it. */
function assertAsset(actor: Actor, m: Money | null | undefined): void {
  if (!m) return;
  if (!resolvePaymentAsset(m.currency) || paymentAsset(m.currency).code !== m.currency) fail(`Unknown payment asset ${String(m.currency)}.`);
  if (actor.network) { const av = assetAvailability(m.currency, actor.network); if (av.state !== 'available') fail(av.reason); }
}

/** Agent parties must hold a mandate for value-bearing actions. Returns the mandate note recorded on the TX. */
function guard(state: MarketState, actor: Actor, verb: MarketplaceVerb, value: Money | null, categoryId: string | null): Record<string, unknown> {
  const p = party(state, actor.partyId);
  if (p.kind !== 'agent') return {};
  const today = state.committedByDay.get(committedKey(p.partyId, actor.at, value?.currency ?? null)) ?? 0;
  const check = checkMandate(state.mandates, p.partyId, verb, value, categoryId, actor.at, today);
  if (!check.ok) fail(`Agent ${p.name}: ${check.reason}`);
  if (check.needsApproval) {
    const grantors = new Set(state.mandates.filter((m) => m.agentPartyId === p.partyId).map((m) => m.grantedBy));
    if (!actor.coSignedBy || !grantors.has(actor.coSignedBy)) fail(`Agent ${p.name}: ${check.reason} — co-signature missing.`);
  }
  return { agentPartyId: p.partyId, mandateCheck: check.reason, ...(actor.coSignedBy ? { coSignedBy: actor.coSignedBy } : {}) };
}

/** An evaluator named at formation: a known party other than the seller (and the buyer, who accepts anyway). */
function evaluatorFor(state: MarketState, evaluatorId: string | undefined, buyerId: string, sellerId: string): { evaluatorId?: string } {
  if (!evaluatorId) return {};
  if (evaluatorId === sellerId) fail('The seller cannot be the evaluator of their own work.');
  if (evaluatorId === buyerId) fail('The buyer accepts milestones already; name a third party as evaluator, or none.');
  if (!state.parties.has(evaluatorId)) fail(`Unknown evaluator ${evaluatorId}: they need a marketplace profile.`);
  return { evaluatorId };
}

// ─── Parties ──────────────────────────────────────────────────────

export async function buildProfile(state: MarketState, actor: Actor, profile: PartyProfile): Promise<MarketTx[]> {
  if (profile.partyId !== actor.partyId) fail('You can only edit your own profile.');
  if (!profile.name.trim()) fail('Give your profile a name.');
  if (profile.kind === 'agent' && !profile.principal?.partyId && !profile.principal?.governanceAddress) fail('An agent needs an accountable principal: a person or organization, or a governance address for a non-human company.');
  // v15-31-00: optional KeyZ signing key and principal credential reference; absent stays valid (undeclared).
  const keyProblems = [...(await profileKeyProblems(profile, actor.at)), ...principalCredentialProblems(profile.principalCredential)];
  if (keyProblems.length) fail(keyProblems.join(' '));
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
  assertAsset(actor, listing.pricePerUnit);
  if (listing.metered) {
    // Metered use settles through a ledger payment channel, and ledger channels carry XRP only.
    if (listing.pricePerUnit.currency !== 'XRP') fail(`Metered listings are priced in XRP: they settle through a ledger payment channel, which carries XRP only (not ${assetLabel(listing.pricePerUnit.currency)}).`);
    if (listing.milestones) fail('A metered listing has no payment schedule: the buyer pays as the service is used, through the channel.');
    if (listing.tokenId) fail('A metered listing cannot be backed by a receipt token.');
  }
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

export async function buildOrder(state: MarketState, actor: Actor, listingId: string, quantity: number, deliveryDate?: string, evaluatorId?: string): Promise<{ contractId: string; txs: MarketTx[] }> {
  const l = state.listings.find((x) => x.listingId === listingId) ?? fail('Unknown listing.');
  party(state, actor.partyId);
  if (!l.open) fail('This listing is no longer available.');
  if (l.sellerId === actor.partyId) fail('You cannot buy your own listing.');
  if (!(quantity > 0)) fail('Quantity must be more than zero.');
  if (quantity > l.remaining) fail(`Only ${l.remaining} ${l.unit} left.`);
  const total = contractTotal(l.pricePerUnit, quantity);
  assertAsset(actor, total);
  const note = guard(state, actor, 'marketplace.order.place', total, l.categoryId);
  const due = deliveryDate ?? new Date(Date.parse(actor.at) + l.leadDays * 86_400_000).toISOString().slice(0, 10);
  const contractId = newId('ct');
  const terms: ContractTerms = {
    contractId, buyerId: actor.partyId, sellerId: l.sellerId, source: { kind: 'listing', listingId }, categoryId: l.categoryId, title: l.title, quantity, unit: l.unit,
    pricePerUnit: l.pricePerUnit, total, milestones: l.metered ? meteredMilestones(quantity, l.unit, actor.at) : l.milestones ? milestonesFromPlan(l.milestones, actor.at.slice(0, 10)) : defaultMilestones(l.kind === 'production-contract' ? 'production-contract' : 'spot', actor.at.slice(0, 10), due), formedAt: actor.at,
    ...evaluatorFor(state, evaluatorId, actor.partyId, l.sellerId),
    ...(l.metered ? { rail: 'ledger-channel' as const } : {}),
  };
  if (l.metered && channelCapDrops(terms) <= 0n) fail('The cap is too small: order more units.');
  const formed = withFees(state, terms);
  return { contractId, txs: [await tx('OrderPlaced', partyAddress(actor.partyId), contractAgreement(contractId), { contractId, terms: formed, ...note })] };
}

/**
 * A metered deal's one stage: the service used up to the cap, inside one billing cycle (due within 29 days of
 * formation, so validateStageWindows holds and splitIntoStages leaves it whole). It is the contract's delivery
 * milestone because validateMilestones requires the last milestone to be the delivery; use is shown by the redeemed
 * claims, not by evidence and acceptance.
 */
function meteredMilestones(cap: number, unit: string, at: string): MilestoneTerm[] {
  return [{ index: 0, label: `Metered use (up to ${cap} ${unit})`, share: 1, dueBy: new Date(Date.parse(at) + MAX_STAGE_DAYS * 86_400_000).toISOString().slice(0, 10), evidence: 'Claims the buyer signs as the service is used, redeemed on the ledger', delivery: true }];
}

// ─── Requests for supply, offers and awards ───────────────────────

export async function buildRequest(state: MarketState, actor: Actor, request: SupplyRequestContent): Promise<MarketTx[]> {
  party(state, actor.partyId);
  if (request.buyerId !== actor.partyId) fail('You can only request as yourself.');
  validateRequest(request, actor.at);
  checkAcceptance(request.acceptance);
  assertAsset(actor, request.maxPricePerUnit);
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
  assertAsset(actor, offer.pricePerUnit);
  if (r.maxPricePerUnit && r.maxPricePerUnit.currency !== offer.pricePerUnit.currency) fail(`The request is priced in ${assetLabel(r.maxPricePerUnit.currency)}; bid in the same asset.`);
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

export async function buildAward(state: MarketState, actor: Actor, requestId: string, offerId: string, quantity?: number, evaluatorId?: string): Promise<{ contractId: string; txs: MarketTx[] }> {
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
  const terms = withFees(state, { contractId, buyerId: r.buyerId, sellerId: o.sellerId, source: { kind: 'request', requestId, offerId }, categoryId: r.categoryId, title: r.title, quantity: qty, unit: r.unit, pricePerUnit: o.pricePerUnit, total, milestones: o.milestones, formedAt: actor.at, ...evaluatorFor(state, evaluatorId, r.buyerId, o.sellerId) });
  return { contractId, txs: [await tx('SupplyAwarded', partyAddress(actor.partyId), contractAgreement(contractId), { contractId, requestId, offerId, terms, ...note })] };
}

// ─── Subcontracts ─────────────────────────────────────────────────

/** A child contract's terms as the parent's seller proposes them; each stage names the parent milestone it serves. */
export interface SubcontractInput {
  subcontractorId: string;
  title: string;
  quantity: number;
  /** Default: the parent's unit. */
  unit?: string;
  /** Must be in the parent's asset. */
  pricePerUnit: Money;
  /** One stage serving this parent milestone, due with it (used when `milestones` is absent). */
  serves?: number;
  milestones?: Array<Omit<MilestoneTerm, 'index'> & { servesMilestone: number }>;
  /** The parent seller (the child's buyer) may name an evaluator for the child too. */
  evaluatorId?: string;
  /** v15-32-00: acceptance criteria for the single default stage (used when `milestones` is absent). */
  acceptance?: MilestoneTerm['acceptance'];
}

/**
 * The parent contract's seller hands part of the work to another party as a child contract. The child is an
 * ordinary contract (its own lifecycle at contractRoot(childId), formed by OrderPlaced with source `subcontract`,
 * the parent seller as its buyer) plus one ConstituentIncluded TX into the parent's HD slot
 * subcontractAddress(parent, child) — the only signal that links them. Same asset and rail as the parent; the
 * child's value fits the parent's unreleased value less the open children; every stage serves a parent milestone
 * and is due by it. Fees are charged on each contract: the child forms with the schedule in force (withFees), no
 * fee rule of its own. A child stage is funded or paid only after the parent milestone it serves was released
 * (subcontractGate), so the main contractor is never more than one stage exposed.
 */
export async function buildSubcontract(state: MarketState, actor: Actor, parentContractId: string, input: SubcontractInput): Promise<{ contractId: string; txs: MarketTx[] }> {
  const parent = contract(state, parentContractId);
  party(state, actor.partyId);
  if (parent.sellerId !== actor.partyId) fail('Only the parent contract’s seller can subcontract its work.');
  if (parent.state === 'completed' || parent.state === 'cancelled') fail(`The parent contract is ${parent.state}; there is no work left to subcontract.`);
  const sub = state.parties.get(input.subcontractorId) ?? fail(`Unknown subcontractor ${input.subcontractorId}: they need a marketplace profile.`);
  if (sub.partyId === actor.partyId) fail('You cannot subcontract to yourself.');
  if (!input.title?.trim()) fail('Give the subcontract a title.');
  if (!(input.quantity > 0)) fail('Quantity must be more than zero.');
  if (!(input.pricePerUnit?.amount > 0)) fail('Price must be more than zero.');
  assertAsset(actor, input.pricePerUnit);
  if (input.pricePerUnit.currency !== parent.total.currency) fail(`A subcontract is paid in the parent's asset (${assetLabel(parent.total.currency)}), from what the parent releases; not in ${assetLabel(input.pricePerUnit.currency)}.`);
  const total = contractTotal(input.pricePerUnit, input.quantity);
  // Open children count with what they have not been paid yet; completed or cancelled ones are out of the budget.
  const open = state.contracts.filter((k) => parent.subcontracts.includes(k.contractId) && k.state !== 'completed' && k.state !== 'cancelled');
  const committed = open.reduce((a, k) => a + (k.total.amount - k.escrow.released), 0);
  const remaining = Math.round((parent.total.amount - parent.escrow.released - committed) * 100) / 100;
  if (total.amount > remaining + 1e-9) fail(`The subcontract (${total.amount} ${total.currency}) exceeds what is left of the parent: ${remaining} ${total.currency} unreleased after open subcontracts.`);
  if (!input.milestones && input.serves === undefined) fail('Say which parent milestone the subcontract serves.');
  const planned = input.milestones ?? [(() => { const pm = parent.milestones[input.serves!] ?? fail(`The parent has no milestone ${input.serves}.`); return { label: input.title.trim(), share: 1, dueBy: pm.dueBy, evidence: `Delivered to the main contractor for “${pm.label}”`, delivery: true, servesMilestone: pm.index, ...(input.acceptance ? { acceptance: input.acceptance } : {}) }; })()];
  const ms: MilestoneTerm[] = planned.map((m, i) => ({ ...m, index: i }));
  ms.forEach((m) => checkAcceptance(m.acceptance));
  ms.forEach((m, i) => {
    if (!Number.isInteger(m.servesMilestone)) fail(`Stage ${i + 1} must name the parent milestone it serves.`);
    const pm = parent.milestones[m.servesMilestone!] ?? fail(`The parent has no milestone ${m.servesMilestone}.`);
    if (m.dueBy > pm.dueBy) fail(`“${m.label}” is due ${m.dueBy}, after the parent milestone “${pm.label}” it serves (${pm.dueBy}).`);
    if (i > 0 && m.servesMilestone! < ms[i - 1].servesMilestone!) fail('Subcontract stages serve the parent milestones in order.');
  });
  const note = guard(state, actor, 'marketplace.contract.subcontract', total, parent.categoryId);
  const contractId = newId('ct');
  const terms: ContractTerms = {
    contractId, buyerId: actor.partyId, sellerId: sub.partyId, source: { kind: 'subcontract' }, categoryId: parent.categoryId, title: input.title.trim(), quantity: input.quantity, unit: input.unit ?? parent.unit,
    pricePerUnit: input.pricePerUnit, total, milestones: ms, formedAt: actor.at, ...(parent.rail ? { rail: parent.rail } : {}), ...evaluatorFor(state, input.evaluatorId, actor.partyId, sub.partyId),
  };
  const formed = withFees(state, terms);
  if (contractRail(formed) !== contractRail(parent)) fail(`A subcontract settles on the parent's rail (${contractRail(parent)}), not ${contractRail(formed)}.`);
  // The link is written by the parent's seller (the public log accepts a party's TXs only from its own address) into the
  // parent's HD child slot; replay joins it to the terms after the pass, so the batch's shared timestamp does not matter.
  return { contractId, txs: [
    await tx('OrderPlaced', partyAddress(actor.partyId), contractAgreement(contractId), { contractId, terms: formed, ...note }),
    await tx('ConstituentIncluded', partyAddress(actor.partyId), subcontractAddress(parentContractId, contractId), { contentClass: 'subcontract', parentContractId, contractId, servesMilestones: [...new Set(formed.milestones.map((m) => m.servesMilestone))] }),
  ] };
}

/** Refuse funding or paying a subcontract stage before the parent milestone it serves was released. */
function assertSubcontractGate(state: MarketState, c: ContractView, milestone: number): void {
  const why = subcontractGate(state.contracts, c, milestone);
  if (why) fail(why);
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
  if (payment.rail !== 'demo' && contractRail(c) === 'ledger-escrow') fail(`${assetLabel(c.total.currency)} contracts are funded with on-ledger escrow (one EscrowCreate per stage leg), not by reference.`);
  if (payment.rail !== 'demo' && contractRail(c) === 'ledger-channel') fail('Metered contracts are funded by opening a ledger payment channel for the cap (marketplace.channel.open).');
  if (payment.rail !== 'demo' && contractRail(c) === 'ledger-staged') fail(`${assetLabel(c.total.currency)} contracts hold nothing: each stage is paid on the ledger when you accept it (marketplace.stage.pay).`);
  const stage = currentStage(c) ?? fail('Every stage is paid.');
  if (stage.need <= 0) fail(`“${c.milestones[stage.index].label}” is funded. The next stage is configured and funded when it completes.`);
  if (amount > stage.need + 1e-9) fail(`Fund one stage at a time: “${c.milestones[stage.index].label}” needs ${stage.need} ${c.total.currency}. Later stages are funded as each completes — holds are limited to a ${HOLD_LIMIT_DAYS}-day billing cycle.`);
  assertSubcontractGate(state, c, stage.index);
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
  if (c.channel) fail('This contract is paid through a ledger channel: close it on the ledger (after CancelAfter anyone can) and record the close (marketplace.channel.close).');
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

/** v15-32-00 `basis`: the signed verdict an acceptance rests on, cited by hash and its HD address (stageEvaluation.ts) — an explicit link, never inferred. */
export interface AffirmBasis { verdictSha256: string; verdictAddress: string; verdict: 'pass' }

export async function buildAffirm(state: MarketState, actor: Actor, contractId: string, milestone: number, basis?: AffirmBasis): Promise<MarketTx[]> {
  const c = contract(state, contractId);
  // The buyer, or the evaluator named at formation (an agent evaluator within its mandate). The buyer still pays.
  const role = c.buyerId === actor.partyId ? 'buyer' : c.evaluatorId && c.evaluatorId === actor.partyId ? 'evaluator' : null;
  if (!role) fail(c.evaluatorId ? 'Only the buyer or the contract’s evaluator accepts a milestone.' : 'Only the buyer accepts a milestone.');
  if (c.milestoneStates[milestone]?.state !== 'evidenced') fail('There is no new evidence to accept for that milestone.');
  const note = role === 'evaluator' ? guard(state, actor, 'marketplace.milestone.affirm', null, c.categoryId) : {};
  const delivery = c.milestones[milestone].delivery;
  if (basis && (!/^[0-9a-f]{64}$/.test(basis.verdictSha256) || basis.verdict !== 'pass' || !basis.verdictAddress.startsWith(`${contractMilestone(contractId, milestone)}/verdicts/`))) fail('An acceptance can cite only a passing verdict on this milestone (its SHA-256 and address).');
  return [await tx(delivery ? 'DeliveryApproved' : 'MilestoneAffirmed', partyAddress(actor.partyId), delivery ? contractDelivery(contractId, milestone) : contractMilestone(contractId, milestone), { contractId, milestone, by: actor.partyId, role, ...note, ...(basis ? { basis } : {}) })];
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
  if (contractRail(c) === 'ledger-channel') fail('A metered contract is paid as it is used: the buyer signs claims, the seller redeems them on the ledger (marketplace.channel.settle).');
  const amount = milestoneAmounts(c.total.amount, c.milestones)[milestone];
  // Staged ledger deals hold nothing, so a release out of escrow exists only for demo funding.
  if (contractRail(c) === 'ledger-staged' && c.escrow.balance + 1e-9 < amount) fail(`Pay this stage on the ledger in ${assetLabel(c.total.currency)} (seller net and fee legs) and record the payments (marketplace.stage.pay).`);
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
  // Staged ledger payments: nothing is held, so a ruling is recorded and a release means the buyer pays the stage.
  if (contractRail(c) === 'ledger-staged') return out;
  // Payment channel: the ledger moves XRP (claims redeemed, the remainder returned at close or CancelAfter); the ruling is recorded.
  if (contractRail(c) === 'ledger-channel') return out;
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

export async function buildMandate(state: MarketState, actor: Actor, agentPartyId: string, limits: MandateLimits, opts: { boundKey?: string } = {}): Promise<{ mandateId: string; txs: MarketTx[] }> {
  const agent = state.parties.get(agentPartyId) ?? fail('Unknown agent.');
  if (agent.kind !== 'agent') fail('Mandates are for agent parties.');
  const accountable = agent.principal?.partyId ?? agentPartyId; // a non-human company governs itself through its governance address
  if (actor.partyId !== accountable) fail('Only the agent’s principal can grant its mandate.');
  if (!limits.verbs.length) fail('Choose what the agent may do.');
  if (!(limits.maxPerContract.amount > 0 && limits.maxPerDay.amount >= limits.maxPerContract.amount)) fail('Set a per-contract limit and a daily limit at least as large.');
  if (Date.parse(limits.expiresAt) <= Date.parse(actor.at)) fail('The mandate must expire in the future.');
  // v15-31-00: bind the mandate to the agent's declared signing key (requests under it must then be signed by it).
  const boundKey = opts.boundKey?.toLowerCase();
  if (boundKey) {
    const k = await agentKeyState(state, agentPartyId, boundKey, actor.at);
    if (k.state !== 'declared') fail(`Bind the mandate to the agent’s declared signing key: ${boundKey.slice(0, 16)}… is ${k.state} (${k.because}).`);
  }
  const mandateId = newId('mandate');
  return { mandateId, txs: [await tx('PermissionGranted', partyAddress(actor.partyId), mandateAddress(agentPartyId, mandateId), { contentClass: 'mandate', mandate: { mandateId, agentPartyId, grantedBy: actor.partyId, limits, ...(boundKey ? { boundKey } : {}) }, ...(agent.principal?.governanceAddress ? { governanceAddress: agent.principal.governanceAddress } : {}) })] };
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
  if (contractRail(c) !== 'ledger-escrow') fail(`On-ledger escrow is for XRP-priced contracts; this one settles on ${contractRail(c)}.`);
  const { buyer, seller } = ledgerAccounts(state, c);
  const amounts = milestoneAmounts(c.total.amount, c.milestones);
  const out: MarketTx[] = [];
  for (const milestone of [...new Set(checks.map((k) => k.milestone))]) {
    if (c.ledgerEscrows.some((e) => e.milestone === milestone)) fail(`Milestone ${milestone + 1} is already escrowed on the ledger.`);
    if (milestone !== currentStage(c)?.index) fail(`Fund one stage at a time: stage ${milestone + 1} is funded after the stages before it complete (holds are limited to a ${HOLD_LIMIT_DAYS}-day billing cycle).`);
    assertSubcontractGate(state, c, milestone);
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

// ─── Staged ledger payments (issued tokens: CAPPZ, USD-tokenZ) ────

/**
 * Record a stage the buyer paid directly on the ledger: one validated Payment per leg (the seller's net and each fee
 * leg), each checked for delivered amount, currency and issuer, destination and memo, and never used twice. The stage
 * must be accepted first; nothing was held, so the release and the payment are one step.
 */
export async function buildPayStageOnLedger(state: MarketState, actor: Actor, contractId: string, milestone: number, policy: SettlementPolicy, lts: LedgerTx[]): Promise<MarketTx[]> {
  const c = contract(state, contractId);
  if (c.buyerId !== actor.partyId) fail('Only the buyer pays a stage.');
  if (contractRail(c) !== 'ledger-staged') fail(`This contract settles on ${contractRail(c)}, not stage-by-stage ledger payments.`);
  const ms = c.milestoneStates[milestone] ?? fail('Unknown milestone.');
  if (ms.state === 'released') fail('That stage is already paid.');
  if (ms.state !== 'affirmed') fail('Accept the stage before paying it (the seller shows the work first).');
  if (c.disputes.some((d) => !d.resolved)) fail('The contract has an open dispute; an operator rules first.');
  const current = c.milestoneStates.find((m) => m.state !== 'released');
  if (current?.index !== milestone) fail(`Pay one stage at a time: stage ${(current?.index ?? 0) + 1} comes first.`);
  assertSubcontractGate(state, c, milestone);
  const { buyer, seller } = ledgerAccounts(state, c);
  const used = new Set(c.payments.map((p) => p.reference));
  const legs = stagePaymentLegs(c, milestone, seller);
  const taken = new Set<LedgerTx>();
  const paid = legs.map((leg) => {
    const lt = lts.find((x) => !taken.has(x) && x.destination === leg.account) ?? fail(`Pay the ${leg.label} leg (${fromUnits(Number(leg.units), c.total.currency)} ${assetLabel(c.total.currency)} to ${leg.account}) before recording.`);
    taken.add(lt);
    if (used.has(lt.hash)) fail(`${lt.hash} is already recorded on this contract.`);
    const problems = checkLedgerPayment(lt, { network: policy.network, from: buyer, to: leg.account, toLabel: leg.label, code: c.total.currency, units: BigInt(leg.units), reference: contractId, index: milestone });
    if (problems.length) fail(`${leg.label} leg: ${problems.join(' ')}`);
    return { leg, lt };
  });
  const amount = milestoneAmounts(c.total.amount, c.milestones)[milestone];
  const note = guard(state, actor, 'marketplace.stage.pay', { amount, currency: c.total.currency }, c.categoryId);
  const q = contractFeePlan(c).milestones[milestone];
  const main = paid.find((x) => x.leg.role === 'seller') ?? fail('The seller leg is missing.');
  const out: MarketTx[] = [];
  for (const { leg, lt } of paid) out.push(await tx('PaymentConfirmed', partyAddress(actor.partyId), contractEscrow(contractId), { contractId, milestone, amount: fromUnits(Number(leg.units), c.total.currency), currency: c.total.currency, rail: 'ledger-staged', leg: leg.role, to: leg.account, reference: lt.hash, validated: true, network: lt.network, ledgerIndex: lt.ledgerIndex, checkedAt: lt.checkedAt }));
  out.push(await tx('EscrowReleased', partyAddress(actor.partyId), contractEscrow(contractId), { contractId, milestone, amount, currency: c.total.currency, to: c.sellerId, direct: true, rail: 'ledger-staged', netToSeller: fromUnits(q.netUnits, c.total.currency), fee: fromUnits(q.feeUnits, c.total.currency), onLedger: true, network: main.lt.network, txHash: main.lt.hash, ledgerIndex: main.lt.ledgerIndex, checkedAt: main.lt.checkedAt, ...note }));
  if (q.feeUnits > 0) out.push(await feeChargedTx(partyAddress(actor.partyId), c, q, milestone, 'validated', paid.filter((x) => x.leg.role === 'fee').map(({ leg, lt }) => ({ account: leg.account, label: leg.label, units: Number(leg.units), bps: q.payLegs.find((l) => l.account === leg.account)?.bps ?? 0, txHash: lt.hash, ledgerIndex: lt.ledgerIndex, checkedAt: lt.checkedAt })), { network: main.lt.network }));
  return out;
}

// ─── Metered use through a ledger payment channel (rail ledger-channel, XRP) ──

/** The open channel of a metered contract, or the reason there is none. */
function openChannel(c: ContractView) {
  if (contractRail(c) !== 'ledger-channel') fail(`This contract settles on ${contractRail(c)}, not a payment channel.`);
  const ch = c.channel ?? fail('The buyer has not opened the payment channel yet.');
  if (ch.closed) fail('The channel is closed.');
  return ch;
}

/**
 * Record the buyer opening a metered deal's channel from a validated PaymentChannelCreate: the buyer's profile account
 * to the seller's, exactly the cap, a CancelAfter within the 30-day billing cycle (a day of slack, as escrow funding),
 * a SettleDelay in range, the claim key, and the contract memo. The channel id is computed from the creating account,
 * destination and sequence (and must be the PayChannel the metadata shows created).
 */
export async function buildOpenChannel(state: MarketState, actor: Actor, contractId: string, policy: SettlementPolicy, lt: LedgerTx): Promise<MarketTx[]> {
  const c = contract(state, contractId);
  if (c.buyerId !== actor.partyId) fail('Only the buyer opens the payment channel.');
  if (contractRail(c) !== 'ledger-channel') fail(`This contract settles on ${contractRail(c)}, not a payment channel.`);
  if (c.channel) fail(`The channel is already open (${c.channel.channelId}).`);
  if (c.state === 'cancelled' || c.state === 'completed') fail(`The contract is ${c.state}.`);
  if (c.disputes.some((d) => !d.resolved)) fail('The contract has an open dispute; an operator rules first.');
  const { buyer, seller } = ledgerAccounts(state, c);
  const cap = channelCapDrops(c);
  const problems = checkChannelCreate(lt, { network: policy.network, contractId, buyerAccount: buyer, sellerAccount: seller, drops: cap.toString() });
  if (problems.length) fail(problems.join(' '));
  if (c.payments.some((p) => p.reference === lt.hash)) fail(`${lt.hash} is already recorded on this contract.`);
  const fundedAt = lt.closeTime ?? lt.checkedAt;
  const cancelAt = cancelAfterOf(lt) ?? fail('No CancelAfter, so the channel could be held indefinitely.');
  if (Date.parse(cancelAt) > Date.parse(holdUntil(fundedAt)) + 86_400_000) fail(`CancelAfter is more than ${HOLD_LIMIT_DAYS} days after opening; holds are limited to a ${HOLD_LIMIT_DAYS}-day billing cycle.`);
  if (Date.parse(cancelAt) <= Date.parse(fundedAt)) fail('CancelAfter is not after the channel opened.');
  const planned = c.milestones[0].dueBy; const lastDay = new Date(Date.parse(cancelAt) - 86_400_000).toISOString().slice(0, 10);
  const stageCfg = { fundedAt, stageDueBy: planned > lastDay ? lastDay : planned < fundedAt.slice(0, 10) ? fundedAt.slice(0, 10) : planned, holdUntil: cancelAt };
  const note = guard(state, actor, 'marketplace.channel.open', { amount: c.total.amount, currency: 'XRP' }, c.categoryId);
  const onLedger = { network: lt.network, txHash: lt.hash, ledgerIndex: lt.ledgerIndex, checkedAt: lt.checkedAt };
  const channelId = channelIdOf(lt);
  return [
    await tx('EscrowFunded', partyAddress(actor.partyId), contractEscrow(contractId), { contractId, amount: c.total.amount, currency: 'XRP', rail: 'ledger-channel', milestone: 0, channelId, publicKey: String(lt.fields.PublicKey), capDrops: cap.toString(), settleDelay: Number(lt.fields.SettleDelay ?? CHANNEL_SETTLE_DELAY), sequence: Number(lt.fields.Sequence || lt.fields.TicketSequence || 0), ...onLedger, ...stageCfg, ...note }),
    await tx('PaymentConfirmed', partyAddress(actor.partyId), contractEscrow(contractId), { contractId, milestone: 0, amount: c.total.amount, currency: 'XRP', rail: 'ledger-channel', leg: 'channel', to: seller, reference: lt.hash, validated: true, network: lt.network, ledgerIndex: lt.ledgerIndex, checkedAt: lt.checkedAt }),
  ];
}

/**
 * Record a redemption the seller made on the ledger: a validated PaymentChannelClaim on this channel, submitted by the
 * seller, and the channel Balance the metadata shows after it (cumulative drops paid). The new increment is that
 * balance minus what is already recorded — never zero or less, never above the cap. A channel pays only the seller,
 * so the fee on the increment (channelFeeQuote) is paid by the seller with direct ledger Payments to each fee leg,
 * checked like any ledger payment; the redemption is not recorded without them.
 */
export async function buildChannelSettle(state: MarketState, actor: Actor, contractId: string, policy: SettlementPolicy, claimLt: LedgerTx, feeLts: LedgerTx[] = []): Promise<MarketTx[]> {
  const c = contract(state, contractId);
  if (c.sellerId !== actor.partyId) fail('Only the seller redeems the channel.');
  const ch = openChannel(c);
  const { seller } = ledgerAccounts(state, c);
  const claim = checkChannelClaim(claimLt, { network: policy.network, channelId: ch.channelId, submitter: seller });
  if (claim.problems.length) fail(claim.problems.join(' '));
  const used = new Set([...c.payments.map((p) => p.reference), ...c.ledgerSettlements.map((s) => s.txHash)]);
  if (used.has(claimLt.hash)) fail(`${claimLt.hash} is already recorded on this contract.`);
  const balance = claim.balanceDrops ?? 0n; const prior = BigInt(ch.releasedDrops); const cap = BigInt(ch.capDrops);
  if (balance > cap) fail(`The channel shows ${balance} drops paid, above the cap of ${cap}.`);
  const inc = balance - prior;
  if (inc <= 0n) fail(`Nothing new to record: the channel has paid ${balance} drops and ${prior} are already recorded.`);
  const q = channelFeeQuote(c, prior, balance);
  if (q.netUnits < 0) fail(`This redemption (${inc} drops) does not cover the fee due on it (${q.feeUnits} drops); redeem a larger claim.`);
  const taken = new Set<LedgerTx>();
  const paid = q.payLegs.filter((l) => l.units > 0).map((leg) => {
    const lt = feeLts.find((x) => !taken.has(x) && x.destination === leg.account) ?? fail(`Pay the ${leg.label} fee leg (${leg.units} drops to ${leg.account}) from your account before recording: a channel pays only the seller, so the seller pays the fee.`);
    taken.add(lt);
    if (used.has(lt.hash)) fail(`${lt.hash} is already recorded on this contract.`);
    const problems = checkLedgerPayment(lt, { network: policy.network, from: seller, to: leg.account, toLabel: leg.label, code: 'XRP', units: BigInt(leg.units), reference: contractId, index: 0 });
    if (problems.length) fail(`${leg.label} fee leg: ${problems.join(' ')}`);
    return { leg, lt };
  });
  if (taken.size !== feeLts.length) fail('A fee payment matches no fee leg of this redemption.');
  const note = guard(state, actor, 'marketplace.channel.settle', null, c.categoryId);
  const xrp = (d: bigint | number) => Number(d) / DROPS_PER_XRP;
  const src = partyAddress(actor.partyId);
  const out: MarketTx[] = [
    await tx('PaymentConfirmed', src, contractEscrow(contractId), { contractId, milestone: 0, amount: xrp(inc), currency: 'XRP', rail: 'ledger-channel', leg: 'seller', to: seller, reference: claimLt.hash, validated: true, network: claimLt.network, ledgerIndex: claimLt.ledgerIndex, checkedAt: claimLt.checkedAt }),
  ];
  for (const { leg, lt } of paid) out.push(await tx('PaymentConfirmed', src, contractEscrow(contractId), { contractId, milestone: 0, amount: xrp(leg.units), currency: 'XRP', rail: 'ledger-channel', leg: 'fee', paidBy: 'seller', to: leg.account, reference: lt.hash, validated: true, network: lt.network, ledgerIndex: lt.ledgerIndex, checkedAt: lt.checkedAt }));
  out.push(await tx('EscrowReleased', src, contractEscrow(contractId), { contractId, milestone: 0, amount: xrp(inc), currency: 'XRP', to: c.sellerId, direct: false, rail: 'ledger-channel', channelId: ch.channelId, balanceDrops: balance.toString(), incrementDrops: inc.toString(), unitsUsed: unitsForDrops(c, inc), totalUnitsUsed: unitsForDrops(c, balance), netToSeller: xrp(q.netUnits), fee: xrp(q.feeUnits), onLedger: true, network: claimLt.network, txHash: claimLt.hash, ledgerIndex: claimLt.ledgerIndex, checkedAt: claimLt.checkedAt, ...note }));
  if (q.feeUnits > 0) out.push(await feeChargedTx(src, c, q, 0, 'validated', paid.map(({ leg, lt }) => ({ account: leg.account, label: leg.label, units: leg.units, bps: leg.bps, txHash: lt.hash, ledgerIndex: lt.ledgerIndex, checkedAt: lt.checkedAt })), { network: claimLt.network, rail: 'ledger-channel', incrementDrops: inc.toString(), balanceDrops: balance.toString(), reference: claimLt.hash }));
  return out;
}

/**
 * Record the channel closing: a validated transaction whose metadata shows this PayChannel deleted — the seller's
 * tfClose claim (immediate), the buyer's close after SettleDelay or expiry, or any channel transaction after
 * CancelAfter. The final Balance must equal what is recorded as redeemed (record a last redemption first); the rest
 * of the cap returned to the buyer is recorded as EscrowRefunded, and the contract completes (or, if nothing was
 * used, is cancelled).
 */
export async function buildCloseChannel(state: MarketState, actor: Actor, contractId: string, policy: SettlementPolicy, lt: LedgerTx): Promise<MarketTx[]> {
  const c = contract(state, contractId);
  if (actor.partyId !== c.buyerId && actor.partyId !== c.sellerId) fail('Only the parties record the channel closing.');
  const ch = openChannel(c);
  const p: string[] = [];
  if (lt.network !== policy.network) p.push(`On ${lt.network}; this marketplace settles on ${policy.network}.`);
  if (!lt.validated) p.push('Not in a validated ledger yet.');
  if (lt.result !== 'tesSUCCESS') p.push(`Result ${lt.result || 'unknown'}, not tesSUCCESS.`);
  if (lt.type !== 'PaymentChannelClaim' && lt.type !== 'PaymentChannelFund') p.push(`It is a ${lt.type}, not a channel transaction.`);
  if (String(lt.fields.Channel ?? '').toUpperCase() !== ch.channelId.toUpperCase()) p.push('It is for a different channel.');
  if (p.length) fail(p.join(' '));
  const node = payChannelNode(lt, ch.channelId);
  if (!node || node.kind !== 'DeletedNode') return fail(`The ledger has not closed the channel yet${node ? ' (a buyer\'s close takes effect after the SettleDelay, or at CancelAfter; submit a close again then)' : ''}.`);
  const finalBalance = typeof node.fields.Balance === 'string' && /^\d+$/.test(node.fields.Balance) ? BigInt(node.fields.Balance) : 0n;
  const released = BigInt(ch.releasedDrops); const cap = BigInt(ch.capDrops);
  if (finalBalance > released) fail(`The channel paid ${finalBalance} drops but ${released} are recorded: record that redemption first (marketplace.channel.settle${lt.type === 'PaymentChannelClaim' && lt.account === state.parties.get(c.sellerId)?.xrplAccount ? ` with ${lt.hash}` : ''}).`);
  if (finalBalance < released) fail(`The channel's final balance (${finalBalance} drops) is below what is recorded as redeemed (${released}).`);
  const amount = typeof node.fields.Amount === 'string' && /^\d+$/.test(node.fields.Amount) ? BigInt(node.fields.Amount) : cap;
  const refund = cap - released;
  const note = guard(state, actor, 'marketplace.channel.close', null, c.categoryId);
  return [await tx('EscrowRefunded', partyAddress(actor.partyId), contractEscrow(contractId), { contractId, milestone: 0, amount: Number(refund) / DROPS_PER_XRP, to: c.buyerId, rail: 'ledger-channel', channelId: ch.channelId, closed: true, refundedDrops: refund.toString(), ledgerReturnedDrops: (amount - finalBalance).toString(), closedBy: lt.account, onLedger: true, network: lt.network, txHash: lt.hash, ledgerIndex: lt.ledgerIndex, checkedAt: lt.checkedAt, ...note })];
}
