/**
 * COPE node crystallized. Node ID: v14-19-00-marketplace-rules.
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Deterministic marketplace rules: input validation, milestone schedules,
 * the receipt-token compliance gate, and agent mandate checks. Pure
 * functions — the same rules run in the UI, the builders and replay, so a
 * transaction the UI would refuse is also refused when an agent submits it.
 */
import { categoryOf } from './catalog';
import { MAX_STAGE_DAYS, stageAmountsUnits } from './stageMath';
import type { ContractView } from './types';
import type { MandateContent, MilestonePlan, MilestoneTerm, Money, SupplyOfferContent, SupplyRequestContent, TokenClassification } from './types';

export class MarketRuleError extends Error {}
const fail = (msg: string): never => { throw new MarketRuleError(msg); };
const isDate = (s: string) => Number.isFinite(Date.parse(s));
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);

export function validateRequest(r: SupplyRequestContent, now: string): void {
  if (!categoryOf(r.categoryId)) fail(`Unknown category "${r.categoryId}".`);
  if (!r.title.trim()) fail('Say what you need.');
  if (!(r.quantity > 0)) fail('Quantity must be more than zero.');
  if (!r.unit) fail('Choose a unit.');
  if (!isDate(r.neededBy)) fail('Choose the date you need it by.');
  if (days(now, r.neededBy) < 0) fail('The needed-by date is in the past.');
  if (r.maxPricePerUnit && !(r.maxPricePerUnit.amount > 0)) fail('A price limit must be more than zero, or leave it open.');
}

/** Feasibility of an offer against its request; returns warnings the buyer should see, throws on hard failures. */
export function validateOffer(o: SupplyOfferContent, r: SupplyRequestContent, now: string): string[] {
  const warn: string[] = [];
  if (o.requestId !== r.requestId) fail('Offer is for a different request.');
  if (!(o.quantity > 0)) fail('Offer quantity must be more than zero.');
  if (!(o.pricePerUnit.amount > 0)) fail('Price must be more than zero.');
  if (!isDate(o.deliveryDate)) fail('Choose a delivery date.');
  if (o.plan.newPlanting && !r.allowNewPlanting) fail('This buyer did not ask for new plantings.');
  if (r.maxPricePerUnit && o.pricePerUnit.currency === r.maxPricePerUnit.currency && o.pricePerUnit.amount > r.maxPricePerUnit.amount) warn.push(`Price is above the buyer's limit (${r.maxPricePerUnit.amount} ${r.maxPricePerUnit.currency}/${r.unit}).`);
  if (o.quantity < r.quantity) warn.push(`Covers ${o.quantity} of ${r.quantity} ${r.unit} — the buyer can split the award.`);
  if (days(o.deliveryDate, r.neededBy) < 0) warn.push('Delivers after the needed-by date.');
  if (o.plan.newPlanting) {
    const lead = categoryOf(r.categoryId)?.typicalLeadDays;
    if (!o.plan.plantingDate || !isDate(o.plan.plantingDate)) fail('A new planting needs a planting date.');
    if (days(now, o.plan.plantingDate!) < 0) fail('The planting date is in the past.');
    const grow = days(o.plan.plantingDate!, o.deliveryDate);
    if (grow <= 0) fail('Delivery must come after planting.');
    if (lead && grow < lead[0]) warn.push(`Only ${grow} days from planting to delivery; this category usually needs ${lead[0]}–${lead[1]}.`);
  }
  validateMilestones(o.milestones);
  return warn;
}

export function validateMilestones(ms: MilestoneTerm[]): void {
  if (!ms.length) fail('At least one milestone is needed.');
  ms.forEach((m, i) => { if (m.index !== i) fail(`Milestone ${i} is out of order.`); if (!(m.share > 0)) fail(`Milestone ${i + 1} needs a share above zero.`); });
  const total = ms.reduce((s, m) => s + m.share, 0);
  if (Math.abs(total - 1) > 1e-6) fail(`Milestone shares add up to ${Math.round(total * 100)}%, not 100%.`);
  if (!ms[ms.length - 1].delivery) fail('The last milestone must be the delivery.');
}

/**
 * Holds are limited to a 30-day billing cycle, so a step that runs longer is broken into stages of under 30 days:
 * each long step becomes k stages with equal shares, due evenly across its span; the earlier ones are progress
 * stages ("— stage 1 of k"), the last keeps the step's own evidence and delivery. Short steps are unchanged.
 */
export function splitIntoStages(ms: MilestoneTerm[], start: string): MilestoneTerm[] {
  const out: MilestoneTerm[] = [];
  let prev = start.slice(0, 10);
  for (const m of ms) {
    const span = Math.max(0, days(prev, m.dueBy));
    const k = Math.max(1, Math.ceil(span / MAX_STAGE_DAYS));
    for (let j = 1; j <= k; j++) {
      const last = j === k;
      out.push({
        index: out.length,
        label: k > 1 ? `${m.label} — stage ${j} of ${k}` : m.label,
        share: last ? m.share - (m.share / k) * (k - 1) : m.share / k,
        dueBy: last ? m.dueBy : addDays(prev, Math.round((span * j) / k)),
        evidence: last ? m.evidence : `Progress toward “${m.label}”: photos, receipts or a short report`,
        delivery: last && m.delivery,
        ...(m.servesMilestone !== undefined ? { servesMilestone: m.servesMilestone } : {}),
      });
    }
    prev = m.dueBy;
  }
  return out;
}

/** Every stage must fit the 30-day hold: under 30 days from the previous stage (the first from formation). */
export function validateStageWindows(ms: MilestoneTerm[], start: string): void {
  let prev = start.slice(0, 10);
  for (const m of ms) {
    const span = days(prev, m.dueBy);
    if (span > MAX_STAGE_DAYS) fail(`“${m.label}” spans ${span} days. Holds are limited to a 30-day billing cycle — break it into stages of under 30 days.`);
    prev = m.dueBy > prev ? m.dueBy : prev;
  }
}

/** A listing's payment schedule turned into an order's milestones, counted from the order date. */
export function milestonesFromPlan(plan: MilestonePlan[], start: string): MilestoneTerm[] {
  if (plan.some((m, i) => !(m.dueInDays >= 0) || (i > 0 && m.dueInDays < plan[i - 1].dueInDays))) fail('Milestone due days must start at 0 or later and never go backwards.');
  if (plan.some((m) => !m.label.trim())) fail('Give every milestone a name.');
  const ms = plan.map((m, i) => ({ index: i, label: m.label.trim(), share: m.share, dueBy: addDays(start, m.dueInDays), evidence: m.evidence, delivery: m.delivery }));
  validateMilestones(ms);
  if (ms.slice(0, -1).some((m) => m.delivery)) fail('Only the last milestone is the delivery.');
  return splitIntoStages(ms, start);
}

/** Ready-made schedules for listings: pay on delivery, deposit + delivery, deposit + milestone + delivery. */
export function milestonePlanPresets(leadDays: number): Record<'on-delivery' | 'deposit' | 'deposit-milestone', { title: string; plan: MilestonePlan[] }> {
  const lead = Math.max(0, Math.round(leadDays));
  return {
    'on-delivery': { title: 'Pay on delivery', plan: [{ label: 'Delivered and accepted', share: 1, dueInDays: lead, evidence: 'Delivery receipt, buyer inspection', delivery: true }] },
    'deposit': { title: 'Deposit + delivery', plan: [
      { label: 'Deposit — work started', share: 0.3, dueInDays: 0, evidence: 'Order accepted and work started', delivery: false },
      { label: 'Delivered and accepted', share: 0.7, dueInDays: lead, evidence: 'Delivered result, buyer acceptance', delivery: true },
    ] },
    'deposit-milestone': { title: 'Deposit, milestone, delivery', plan: [
      { label: 'Deposit — work started', share: 0.2, dueInDays: 0, evidence: 'Order accepted and work started', delivery: false },
      { label: 'Milestone — first draft', share: 0.3, dueInDays: Math.max(0, Math.round(lead / 2)), evidence: 'First draft or progress the buyer can check', delivery: false },
      { label: 'Delivered and accepted', share: 0.5, dueInDays: lead, evidence: 'Delivered result, buyer acceptance', delivery: true },
    ] },
  };
}

/**
 * Default milestone schedules. Spot: one milestone on delivery. Production
 * contract: a small commitment payment, planting verified, mid-season check,
 * then the balance on delivery and acceptance — so a farmer who plants a new
 * crop is paid for progress, and a buyer only pays for verified progress.
 * Steps longer than the 30-day hold are split into stages (splitIntoStages).
 */
export function defaultMilestones(kind: 'spot' | 'production-contract', start: string, deliveryDate: string, plantingDate?: string): MilestoneTerm[] {
  if (kind === 'spot') return splitIntoStages([{ index: 0, label: 'Delivered and accepted', share: 1, dueBy: deliveryDate, evidence: 'Delivery receipt, buyer inspection', delivery: true }], start);
  const plant = plantingDate ?? addDays(start, 14);
  const mid = addDays(plant, Math.max(14, Math.round(days(plant, deliveryDate) / 2)));
  return splitIntoStages([
    { index: 0, label: 'Commitment (inputs and planting stock)', share: 0.1, dueBy: addDays(start, 7), evidence: 'Signed plan; seed or plug purchase receipt', delivery: false },
    { index: 1, label: 'Planting verified', share: 0.2, dueBy: plant, evidence: 'Geo-tagged photos of the planted area', delivery: false },
    { index: 2, label: 'Mid-season check', share: 0.2, dueBy: mid, evidence: 'Crop photos or a third-party scout report', delivery: false },
    { index: 3, label: 'Harvest delivered and accepted', share: 0.5, dueBy: deliveryDate, evidence: 'Delivery receipt, quality inspection', delivery: true },
  ], start);
}

/** Receipt-token compliance gate. Only tokens redeemable for a specific asset, without profit sharing or enterprise ownership, are issued in this release. */
export function classifyToken(answers: Omit<TokenClassification, 'result' | 'reasons'>): TokenClassification {
  const reasons: string[] = [];
  if (!answers.redeemableForSpecificAsset) reasons.push('It is not redeemable for a specific physical asset, right or service.');
  if (answers.profitFromOthersEfforts) reasons.push('Holders expect profit from the efforts of others — that is the hallmark of an investment contract.');
  if (answers.fractionalEnterpriseOwnership) reasons.push('It is a share of a business, not a receipt for an asset.');
  return { ...answers, result: reasons.length ? 'blocked' : 'receipt', reasons: reasons.length ? [...reasons, 'This is a security: issue it through the Securities path (an exempt offering approved by compliance, verified investors, transfer controls), not as a receipt token.'] : ['Receipt token: redeemable for a specific asset; no profit sharing; no enterprise ownership.'] };
}

export interface MandateCheck { ok: boolean; reason: string; needsApproval: boolean }

/** Whether an agent may run `verb` for `amount` in `categoryId` now, given its active mandates and what it already committed today. */
export function checkMandate(mandates: MandateContent[], agentPartyId: string, verb: string, value: Money | null, categoryId: string | null, at: string, committedToday: number): MandateCheck {
  const active = mandates.filter((m) => m.agentPartyId === agentPartyId && Date.parse(m.limits.expiresAt) > Date.parse(at));
  if (!active.length) return { ok: false, reason: 'No active mandate for this agent.', needsApproval: false };
  for (const m of active) {
    const L = m.limits;
    if (!L.verbs.includes(verb)) continue;
    if (categoryId && L.categories.length && !L.categories.some((c) => categoryId === c || categoryId.startsWith(`${c}/`))) continue;
    if (value) {
      if (value.currency !== L.maxPerContract.currency) continue;
      if (value.amount > L.maxPerContract.amount) return { ok: false, reason: `Above the per-contract limit of ${L.maxPerContract.amount} ${L.maxPerContract.currency}.`, needsApproval: false };
      if (committedToday + value.amount > L.maxPerDay.amount) return { ok: false, reason: `Would exceed the daily limit of ${L.maxPerDay.amount} ${L.maxPerDay.currency}.`, needsApproval: false };
      if (L.approvalAbove && value.amount > L.approvalAbove.amount) return { ok: true, reason: `Allowed with co-signature from ${m.grantedBy} (above ${L.approvalAbove.amount} ${L.approvalAbove.currency}).`, needsApproval: true };
    }
    return { ok: true, reason: `Within mandate ${m.mandateId}.`, needsApproval: false };
  }
  return { ok: false, reason: `No mandate allows ${verb}${categoryId ? ` in ${categoryId}` : ''}.`, needsApproval: false };
}

/** The key of an agent's value committed per UTC day, per asset (a daily limit is in one asset; mixing assets would add XRP to dollars). */
export const committedKey = (partyId: string, at: string, currency: string | null) => `${partyId}|${at.slice(0, 10)}${currency ? `|${currency}` : ''}`;

export const contractTotal = (pricePerUnit: Money, quantity: number): Money => ({ amount: Math.round(pricePerUnit.amount * quantity * 100) / 100, currency: pricePerUnit.currency });
/** Cent-exact milestone amounts; the last milestone absorbs rounding so the parts always sum to the total. */
export function milestoneAmounts(total: number, ms: MilestoneTerm[]): number[] {
  return stageAmountsUnits(Math.round(total * 100), ms.map((m) => m.share)).map((c) => c / 100);
}

/**
 * Subcontract funding gate: a child stage is funded or paid only after the parent milestone it serves
 * (`servesMilestone`) was released, so the main contractor pays out only what the parent paid it and is never more
 * than one stage exposed. The parent comes from the replayed ConstituentIncluded link (`parentContractId`); a
 * subcontract without one fails closed. Returns the refusal, or null when the stage may be funded.
 */
export function subcontractGate(contracts: readonly ContractView[], c: ContractView, milestone: number): string | null {
  if (c.source.kind !== 'subcontract') return null;
  if (!c.parentContractId) return 'This subcontract has no replayed link to a parent contract (ConstituentIncluded), so none of its stages can be funded.';
  const parent = contracts.find((x) => x.contractId === c.parentContractId);
  if (!parent) return `The parent contract ${c.parentContractId} is not on this market.`;
  const serves = c.milestones[milestone]?.servesMilestone;
  if (serves === undefined) return `Stage ${milestone + 1} of this subcontract names no parent milestone it serves.`;
  const pm = parent.milestoneStates[serves];
  if (!pm) return `The parent contract has no milestone ${serves}.`;
  if (pm.state !== 'released') return `Stage “${c.milestones[milestone].label}” is funded after the parent milestone “${parent.milestones[serves].label}” is released (it is ${pm.state}): the main contractor pays from what the parent releases.`;
  return null;
}
