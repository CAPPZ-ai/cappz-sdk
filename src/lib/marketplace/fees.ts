/**
 * COPE node crystallized. Node ID: v15-14-00-marketplace-fees.
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Marketplace and securities fees: an administrator publishes a fee schedule
 * (PriceSheetPublished on the marketplace ledger; the latest declaration wins,
 * earlier ones stay on the ledger). Each fee kind — a percentage of value, a
 * flat fee, a fee per ledger record — is enabled and priced on its own, for
 * marketplace deals and for security placements separately, and the whole fee
 * is routed to DARC recipients by the Royalty Flywheel's exact split.
 *
 * A deal copies the schedule into its opening event (contract terms,
 * subscription), so a later schedule never changes a running deal. The seller
 * pays the marketplace fee out of each milestone as it releases; the issuer
 * pays the securities fee before allocation. Amounts are computed in the
 * currency's smallest unit (cents, drops), so legs add up exactly.
 *
 * Collection (v15-15-00): with a collection account (the ARC), each fee is
 * paid on the ledger as ONE leg to that account — two escrows per milestone,
 * one payment per placement — and every charge records what each DARC
 * recipient is owed under the split in force. An administrator later pays
 * the owed amounts from the ARC (buildFeeDistribution), each payment checked
 * on the validated ledger. Without one, legs go to each recipient directly.
 */
import type { LedgerTx, XrplNetwork } from '../xrpl/ledgerCheck';
import { isValidClassicAddress } from 'xrpl';
import { routeRoyalty, validateRoyaltyRecipients, FULL_BPS, type RoyaltyLeg, type RoyaltyRecipient } from '../skills/royaltyRouting';
import { marketLedger, type MarketTx } from './ledger';
import { buildMemo } from './MarketplaceMemoValidator';
import { sha256Hex } from '../governance/PrinciplesChainlet';
import type { MarketState } from './replay';
import { MARKETPLACE_POW_ROOT } from './MarketplacePaths';
import { MarketRuleError, milestoneAmounts } from './rules';
import { CONTRACT_FORMATION_RECORDS, RECORDS_PER_MILESTONE, feeUnitsOf, paymentFeeCents, type FeeComponentsLike, type PaymentFeeRates } from './stageMath';
import type { ContractTerms, Currency, Money } from './types';

const fail = (msg: string): never => { throw new MarketRuleError(msg); };

/** Fee amounts per currency, in major units (USD dollars, XRP). A currency left out is not charged that fee. */
export type FeeAmounts = Partial<Record<Currency, number>>;

/**
 * Seller-paid fee kinds: percentage of value (bps, 50 = 0.50%), a flat fee once per contract (first stage) or per
 * allocation, and a fee per ledger record in the settlement path.
 */
export type FeeComponents = FeeComponentsLike;

export interface FeeSchedule {
  sheetId: string;
  marketplace: FeeComponents;
  securities: FeeComponents;
  /** DARC recipients of every fee; shares in basis points summing to 100%. */
  recipients: RoyaltyRecipient[];
  /** ARC collection account: fees are paid to it in one leg and distributed to the recipients later. Absent = paid to each recipient directly. */
  collector?: { account: string; label: string } | null;
  /**
   * The payment fee on every USD charge through Stripe, paid by the BUYER on top of each stage and identical for
   * every payment method (no surcharges). Priced to cover credit-card processing; when the buyer does not pay by
   * credit card the fee goes to the treasury.
   */
  paymentFee?: PaymentFeeRates | null;
  note: string;
}
export interface FeeScheduleView extends FeeSchedule { by: string; at: string }

/** The fee terms a deal carries from its opening event. */
export interface FeeTerms { sheetId: string; components: FeeComponents; recipients: RoyaltyRecipient[]; collector?: { account: string; label: string } | null; paymentFee?: PaymentFeeRates | null }

export const NO_FEES: FeeComponents = { percent: { enabled: false, bps: 0 }, flat: { enabled: false, amounts: {} }, perRecord: { enabled: false, amounts: {} } };
/** A starting payment fee that covers Stripe's published standard US card rate (2.9% + 30¢) — set it to your account's pricing. */
export const CARD_COVERING_PAYMENT_FEE: PaymentFeeRates = { enabled: true, bps: 290, fixedCents: 30 };
/** Maximum percentage a schedule may set (sanity bound, not a policy). */
export const MAX_FEE_BPS = 5_000;
export { CONTRACT_FORMATION_RECORDS, RECORDS_PER_MILESTONE } from './stageMath';
/** Records in a placement: subscribed, fee charged, allocated. */
export const RECORDS_PER_PLACEMENT = 3;

const MINOR: Record<Currency, number> = { USD: 100, XRP: 1_000_000 };
export const toUnits = (amount: number, currency: Currency) => Math.round(amount * MINOR[currency]);
export const fromUnits = (units: number, currency: Currency) => units / MINOR[currency];
export const formatUnits = (units: number, currency: Currency) => currency === 'USD'
  ? `$${fromUnits(units, 'USD').toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  : `${fromUnits(units, 'XRP').toLocaleString('en-US', { maximumFractionDigits: 6 })} XRP`;
export const formatBps = (bps: number) => `${(bps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;

const anyEnabled = (c: FeeComponents) => c.percent.enabled || c.flat.enabled || c.perRecord.enabled;

function componentViolations(name: string, c: FeeComponents): string[] {
  const v: string[] = [];
  if (c.percent.enabled && !(Number.isInteger(c.percent.bps) && c.percent.bps > 0 && c.percent.bps <= MAX_FEE_BPS)) v.push(`${name}: the percentage must be between 0.01% and ${formatBps(MAX_FEE_BPS)}.`);
  for (const [kind, f] of [['flat fee', c.flat], ['per-record fee', c.perRecord]] as const) {
    const amounts = Object.values(f.amounts);
    if (amounts.some((a) => !(Number.isFinite(a) && (a as number) >= 0))) v.push(`${name}: ${kind} amounts must be zero or more.`);
    if (f.enabled && !amounts.some((a) => (a as number) > 0)) v.push(`${name}: an enabled ${kind} needs an amount in USD or XRP.`);
  }
  return v;
}

/** Violations for a schedule (empty = publishable). */
export function validateFeeSchedule(s: Omit<FeeSchedule, 'sheetId'>): string[] {
  const v = [...componentViolations('Marketplace', s.marketplace), ...componentViolations('Securities', s.securities)];
  const p = s.paymentFee;
  if (p?.enabled && !(Number.isInteger(p.bps) && Number.isInteger(p.fixedCents) && p.bps >= 0 && p.fixedCents >= 0 && p.bps < 1_000 && (p.bps > 0 || p.fixedCents > 0))) v.push('Payment fee: a rate in whole basis points under 10% and/or a fixed amount in whole cents.');
  if (anyEnabled(s.marketplace) || anyEnabled(s.securities)) {
    if (!s.recipients.length) v.push('Name at least one fee recipient (DARC split).');
    v.push(...validateRoyaltyRecipients(s.recipients));
    if (s.collector && !isValidClassicAddress(s.collector.account)) v.push(`Collection account ${s.collector.account || '(blank)'} is not a valid XRPL classic address (checksum).`);
    if (s.collector && !s.collector.label.trim()) v.push('Give the collection account a label.');
  }
  return v;
}

/** Admin policy: publish the fee schedule. It applies to deals formed after it; running deals keep their terms. */
export async function buildFeeSchedule(operatorAddress: string, at: string, s: Omit<FeeSchedule, 'sheetId'>): Promise<MarketTx[]> {
  const violations = validateFeeSchedule(s);
  if (violations.length) fail(violations.join(' '));
  const schedule: FeeSchedule = { ...s, sheetId: `marketplace-fees-${at}` };
  return [await marketLedger.create({ eventType: 'PriceSheetPublished', sourceAddress: operatorAddress, targetAddress: `${MARKETPLACE_POW_ROOT}/fees`, payload: { sheetId: schedule.sheetId, appRoot: MARKETPLACE_POW_ROOT, effectiveFrom: at, publishedAt: at, schedule, by: operatorAddress } })];
}

/** Replay hook: a PriceSheetPublished for the marketplace root, or null for anything else. */
export function feeScheduleFrom(payload: Record<string, unknown>, at: string): FeeScheduleView | null {
  if (payload.appRoot !== MARKETPLACE_POW_ROOT || !payload.schedule) return null;
  return { ...(payload.schedule as FeeSchedule), by: String(payload.by ?? ''), at };
}

/** The terms a new deal copies; null when nothing is charged for that kind of deal. */
export function feeTermsFor(schedule: FeeScheduleView | null, kind: 'marketplace' | 'securities'): FeeTerms | null {
  if (!schedule || !anyEnabled(schedule[kind])) return null;
  return { sheetId: schedule.sheetId, components: schedule[kind], recipients: schedule.recipients, collector: schedule.collector ?? null, paymentFee: schedule.paymentFee ?? null };
}

// ─── Quotes ───────────────────────────────────────────────────────

export interface FeeLine {
  kind: 'percent' | 'flat' | 'per-record';
  label: string;
  /** How the amount was computed, shown to both parties. */
  formula: string;
  units: number;
}

export interface FeeQuote {
  currency: Currency;
  grossUnits: number;
  lines: FeeLine[];
  feeUnits: number;
  /** What the payee (seller, issuer) keeps. */
  netUnits: number;
  /** Where the fee goes (DARC recipients), exact to the unit. */
  legs: RoyaltyLeg[];
  /** What is paid on the ledger now: one leg to the collection account, or the DARC legs directly. */
  payLegs: RoyaltyLeg[];
  /** Enabled fee kinds this currency has no price for (not charged, said so). */
  unpriced: string[];
}

export function quoteFees(terms: FeeTerms | null, gross: Money, opts: { records: number; flat: boolean }): FeeQuote {
  const currency = gross.currency;
  const grossUnits = toUnits(gross.amount, currency);
  const lines: FeeLine[] = []; const unpriced: string[] = [];
  if (terms) {
    // Units come from stageMath (the same bytes the payments function runs); this adds the labels and formulas.
    const c = terms.components;
    const u = feeUnitsOf(c, grossUnits, currency, opts.records, opts.flat);
    unpriced.push(...u.unpriced);
    if (c.percent.enabled) lines.push({ kind: 'percent', label: 'Platform fee', formula: `${formatBps(c.percent.bps)} × ${formatUnits(grossUnits, currency)}`, units: u.percent });
    if (u.flat > 0) lines.push({ kind: 'flat', label: 'Flat fee', formula: `${formatUnits(u.flat, currency)} once`, units: u.flat });
    if (u.perRecord > 0) lines.push({ kind: 'per-record', label: 'Ledger records', formula: `${opts.records} record${opts.records === 1 ? '' : 's'} × ${formatUnits(u.perRecord / opts.records, currency)}`, units: u.perRecord });
  }
  const feeUnits = lines.reduce((n, l) => n + l.units, 0);
  const legs = terms && feeUnits > 0 ? routeRoyalty(feeUnits, terms.recipients) : [];
  const payLegs = terms?.collector && feeUnits > 0 ? [{ account: terms.collector.account, label: terms.collector.label, bps: FULL_BPS, units: feeUnits }] : legs;
  return { currency, grossUnits, lines, feeUnits, netUnits: grossUnits - feeUnits, legs, payLegs, unpriced };
}

export interface ContractFeePlan {
  currency: Currency;
  sheetId: string | null;
  milestones: Array<FeeQuote & { milestone: number; label: string }>;
  grossUnits: number;
  feeUnits: number;
  netUnits: number;
  /** Fee lines summed across milestones, by kind. */
  lines: FeeLine[];
  legs: RoyaltyLeg[];
  collector: { account: string; label: string } | null;
  unpriced: string[];
}

/** The fee on each milestone of a contract, from the terms it was formed with. */
export function contractFeePlan(c: Pick<ContractTerms, 'total' | 'milestones' | 'fees'>): ContractFeePlan {
  const amounts = milestoneAmounts(c.total.amount, c.milestones);
  const terms = c.fees ?? null;
  const milestones = c.milestones.map((m, i) => ({ ...quoteFees(terms, { amount: amounts[i], currency: c.total.currency }, { records: RECORDS_PER_MILESTONE + (i === 0 ? CONTRACT_FORMATION_RECORDS : 0), flat: i === 0 }), milestone: i, label: m.label }));
  const lines = new Map<FeeLine['kind'], FeeLine>();
  for (const q of milestones) for (const l of q.lines) { const prior = lines.get(l.kind); lines.set(l.kind, prior ? { ...prior, units: prior.units + l.units } : { ...l }); }
  // Summed formulas restate the rule over the whole contract.
  const total = milestones.reduce((n, q) => n + q.grossUnits, 0);
  const records = c.milestones.length * RECORDS_PER_MILESTONE + CONTRACT_FORMATION_RECORDS;
  for (const l of lines.values()) {
    if (l.kind === 'percent') l.formula = `${formatBps(terms!.components.percent.bps)} × ${formatUnits(total, c.total.currency)}, per milestone`;
    if (l.kind === 'per-record') l.formula = `${records} records × ${formatUnits(toUnits(terms!.components.perRecord.amounts[c.total.currency]!, c.total.currency), c.total.currency)}`;
  }
  const legs = new Map<string, RoyaltyLeg>();
  for (const q of milestones) for (const l of q.legs) { const prior = legs.get(l.account); legs.set(l.account, prior ? { ...prior, units: prior.units + l.units } : { ...l }); }
  const feeUnits = milestones.reduce((n, q) => n + q.feeUnits, 0);
  return { currency: c.total.currency, sheetId: terms?.sheetId ?? null, milestones, grossUnits: total, feeUnits, netUnits: total - feeUnits, lines: [...lines.values()], legs: [...legs.values()], collector: terms?.collector ?? null, unpriced: [...new Set(milestones.flatMap((q) => q.unpriced))] };
}

/** The buyer's payment fee over a whole USD contract (each stage is charged separately; the same for every method), in cents. */
export function contractPaymentFeeCents(c: Pick<ContractTerms, 'total' | 'milestones' | 'fees'>): number | null {
  const rates = c.fees?.paymentFee;
  if (!rates?.enabled || c.total.currency !== 'USD') return null;
  const stages = milestoneAmounts(c.total.amount, c.milestones).map((a) => toUnits(a, 'USD'));
  return stages.reduce((n, g) => n + paymentFeeCents(rates, g), 0);
}

/** Refuse terms whose fees would exceed what a milestone pays. */
export function assertFeesFit(plan: ContractFeePlan): void {
  for (const q of plan.milestones) if (q.netUnits < 0) fail(`Fees (${formatUnits(q.feeUnits, q.currency)}) exceed what “${q.label}” pays (${formatUnits(q.grossUnits, q.currency)}); raise the price or ask the administrator to lower the fees.`);
}

/** The fee on a placement (issuer pays before allocation). */
export function placementFeeQuote(terms: FeeTerms | null, amount: Money): FeeQuote {
  return quoteFees(terms, amount, { records: RECORDS_PER_PLACEMENT, flat: true });
}

// ─── Settlement of fee legs ───────────────────────────────────────

const feeMemoFor = (lt: LedgerTx) => lt.memos.filter((m) => m.type === 'cappz-marketplace-monetary').map((m) => { try { return JSON.parse(m.data) as { contractId?: string }; } catch { return {}; } });

/** What must be true of a validated Payment for it to settle one fee leg. Returns problems (empty = ok). */
export function checkFeePayment(lt: LedgerTx, expect: { network: XrplNetwork; from: string; leg: RoyaltyLeg; reference: string }): string[] {
  const p: string[] = [];
  if (lt.network !== expect.network) p.push(`On ${lt.network}; this marketplace settles on ${expect.network}.`);
  if (!lt.validated) p.push('Not in a validated ledger yet.');
  if (lt.result !== 'tesSUCCESS') p.push(`Result ${lt.result || 'unknown'}, not tesSUCCESS.`);
  if (lt.type !== 'Payment') p.push(`It is a ${lt.type}, not a Payment.`);
  if (lt.account !== expect.from) p.push(`Sent from ${lt.account}, not ${expect.from}.`);
  if (lt.destination !== expect.leg.account) p.push(`Paid to ${lt.destination}, not ${expect.leg.label} (${expect.leg.account}).`);
  if (lt.deliveredDrops === null || BigInt(lt.deliveredDrops) < BigInt(expect.leg.units)) p.push(`Delivered ${lt.deliveredDrops ?? 'no XRP'} drops; the ${expect.leg.label} leg is ${expect.leg.units}.`);
  if (!feeMemoFor(lt).some((m) => m.contractId === expect.reference)) p.push(`Memo does not name ${expect.reference}.`);
  return p;
}

// ─── Distribution from the collection account (ARC → DARC) ────────

/** A recorded distribution: payments from the collection account to recipients, each read on the validated ledger. */
export interface FeeDistribution { distributionId: string; collector: string; currency: Currency; legs: Array<{ account: string; label: string; units: number; txHash: string }>; at: string; by: string }

export interface CollectedFees {
  collector: { account: string; label: string };
  currency: Currency;
  /** Fees paid into the collector, validated on the ledger. */
  collectedUnits: number;
  distributedUnits: number;
  /** What each recipient is still owed (from the shares recorded on every charge, minus what was paid). */
  outstanding: Array<{ account: string; label: string; units: number }>;
}

/** Fees validated into each collection account, what was distributed, and what each recipient is still owed. */
export function collectedFees(state: Pick<MarketState, 'contracts' | 'offerings' | 'feeDistributions'>): CollectedFees[] {
  const groups = new Map<string, CollectedFees & { owed: Map<string, { label: string; units: number }>; paid: Map<string, number> }>();
  const group = (collector: { account: string; label: string }, currency: Currency) => {
    const k = `${collector.account}|${currency}`;
    let g = groups.get(k);
    if (!g) { g = { collector, currency, collectedUnits: 0, distributedUnits: 0, outstanding: [], owed: new Map(), paid: new Map() }; groups.set(k, g); }
    return g;
  };
  const charge = (collector: { account: string; label: string } | null, currency: Currency, feeUnits: number, owed: readonly RoyaltyLeg[]) => {
    if (!collector) return;
    const g = group(collector, currency);
    g.collectedUnits += feeUnits;
    for (const l of owed) { const o = g.owed.get(l.account); g.owed.set(l.account, { label: l.label, units: (o?.units ?? 0) + l.units }); }
  };
  for (const c of state.contracts) for (const f of c.feeCharges) if (f.settlement === 'validated') charge(f.collector, f.currency, f.feeUnits, f.owed);
  for (const o of state.offerings) for (const s of o.subscriptions) if (s.feeCharged?.settlement === 'validated') charge(s.feeCharged.collector, s.feeCharged.currency, s.feeCharged.feeUnits, s.feeCharged.owed);
  for (const d of state.feeDistributions) {
    const g = [...groups.values()].find((x) => x.collector.account === d.collector && x.currency === d.currency);
    if (!g) continue;
    for (const l of d.legs) { g.paid.set(l.account, (g.paid.get(l.account) ?? 0) + l.units); g.distributedUnits += l.units; }
  }
  return [...groups.values()].map(({ owed, paid, ...g }) => ({ ...g, outstanding: [...owed].map(([account, o]) => ({ account, label: o.label, units: Math.max(0, o.units - (paid.get(account) ?? 0)) })).filter((l) => l.units > 0) }));
}

/** A stable id for paying exactly this outstanding set (so the memo on each payment names it). */
export const distributionIdOf = async (g: Pick<CollectedFees, 'collector' | 'currency' | 'outstanding'>) => `fd-${(await sha256Hex(JSON.stringify([g.collector.account, g.currency, g.outstanding]))).slice(0, 16)}`;

/** One Payment per outstanding recipient, from the collection account — for its holder's wallet to sign. */
export async function prepareFeeDistribution(g: CollectedFees): Promise<{ distributionId: string; payments: Array<Record<string, unknown>> }> {
  if (g.currency !== 'XRP') throw new MarketRuleError('Only XRP collected on the ledger is distributed here; USD fees are recorded by reference and paid off-ledger.');
  const distributionId = await distributionIdOf(g);
  return { distributionId, payments: g.outstanding.map((l) => ({ TransactionType: 'Payment', Account: g.collector.account, Destination: l.account, Amount: String(l.units), Memos: [buildMemo({ class: 'monetary', contractId: distributionId, deliveryIndex: 0, currency: 'XRP' })] })) };
}

/** Record a distribution once every outstanding recipient's Payment from the collection account is validated on the ledger. */
export async function buildFeeDistribution(state: MarketState, operatorAddress: string, network: XrplNetwork, collectorAccount: string, lts: readonly LedgerTx[]): Promise<MarketTx[]> {
  const g = collectedFees(state).find((x) => x.collector.account === collectorAccount && x.currency === 'XRP') ?? fail('Nothing collected in XRP for that account.');
  if (!g.outstanding.length) fail('Every recipient has been paid.');
  const distributionId = await distributionIdOf(g);
  const legs = g.outstanding.map((l) => {
    const lt = lts.find((x) => x.destination === l.account) ?? fail(`Pay ${l.label} (${l.units} drops to ${l.account}) before recording.`);
    const problems = checkFeePayment(lt, { network, from: collectorAccount, leg: { ...l, bps: 0 }, reference: distributionId });
    if (problems.length) fail(`${l.label}: ${problems.join(' ')}`);
    return { account: l.account, label: l.label, units: l.units, txHash: lt.hash, ledgerIndex: lt.ledgerIndex, checkedAt: lt.checkedAt };
  });
  const total = legs.reduce((n, l) => n + l.units, 0);
  return [await marketLedger.create({ eventType: 'PaymentConfirmed', sourceAddress: operatorAddress, targetAddress: `${MARKETPLACE_POW_ROOT}/fees/distributions/${distributionId}`, payload: { contentClass: 'fee-distribution', distributionId, collector: collectorAccount, currency: 'XRP', amount: fromUnits(total, 'XRP'), rail: 'xrpl-payment', reference: distributionId, validated: true, network, legs } })];
}

/**
 * USD payment fees collected through Stripe (they stay in the platform's Stripe balance): the part that covered
 * credit-card charges and the part that belongs to the treasury (all of it when the buyer did not pay by credit card).
 */
export function paymentFeeTotals(state: Pick<MarketState, 'contracts'>): { paymentFeeCents: number; cardCostCents: number; treasuryCents: number; byFunding: Record<string, number> } {
  const out = { paymentFeeCents: 0, cardCostCents: 0, treasuryCents: 0, byFunding: {} as Record<string, number> };
  for (const c of state.contracts) for (const m of c.milestoneStates) {
    const p = m.processor;
    if (!p || p.treasuryCents === undefined) continue;
    out.paymentFeeCents += p.paymentFeeCents; out.cardCostCents += p.cardCostCents ?? 0; out.treasuryCents += p.treasuryCents;
    const k = p.funding ?? 'unknown'; out.byFunding[k] = (out.byFunding[k] ?? 0) + 1;
  }
  return out;
}
