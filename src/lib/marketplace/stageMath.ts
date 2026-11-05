/**
 * COPE node crystallized. Node ID: v15-16-00-marketplace-stage-math.
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * The money arithmetic every party and the payments function must agree on:
 * stage amounts, the seller's fee per stage, the buyer's payment-processing
 * fee, and the 30-day hold. No imports, so the same bytes run in the browser
 * and in supabase/functions/_shared/marketplaceStageMath.ts (a guarded copy,
 * byte-identical — src/test/marketplace-stripe.test.ts). Amounts are integers
 * in the currency's smallest unit (cents, drops, token micro-units).
 */

/** Holds are limited to a 30-day billing cycle: a stage is funded, worked and released within it. */
export const HOLD_LIMIT_DAYS = 30;
/** A stage spans less than 30 days. */
export const MAX_STAGE_DAYS = HOLD_LIMIT_DAYS - 1;
const DAY_MS = 86_400_000;

/** When a hold that starts at `fundedAt` must be released or refunded. */
export const holdUntil = (fundedAt: string): string => new Date(Date.parse(fundedAt) + HOLD_LIMIT_DAYS * DAY_MS).toISOString();

/** Split a total (smallest units) by shares; the last stage takes the rounding remainder. */
export function stageAmountsUnits(totalUnits: number, shares: readonly number[]): number[] {
  const parts = shares.map((s) => Math.floor(totalUnits * s));
  parts[parts.length - 1] += totalUnits - parts.reduce((a, b) => a + b, 0);
  return parts;
}

/** Records in a contract's settlement path: formed once, then funded, accepted and released per stage. */
export const CONTRACT_FORMATION_RECORDS = 1;
export const RECORDS_PER_MILESTONE = 3;
export const stageRecords = (stage: number): number => RECORDS_PER_MILESTONE + (stage === 0 ? CONTRACT_FORMATION_RECORDS : 0);

/** Asset codes (paymentAssets.ts); repeated here because this file has no imports. Issued tokens use six decimals. */
type Cur = 'USD' | 'XRP' | 'CAPPZ' | 'USD-tokenZ/1';
const MINOR: Record<Cur, number> = { USD: 100, XRP: 1_000_000, CAPPZ: 1_000_000, 'USD-tokenZ/1': 1_000_000 };
export const toUnits = (amount: number, currency: Cur): number => Math.round(amount * MINOR[currency]);

export interface FeeComponentsLike {
  percent: { enabled: boolean; bps: number };
  flat: { enabled: boolean; amounts: Partial<Record<Cur, number>> };
  perRecord: { enabled: boolean; amounts: Partial<Record<Cur, number>> };
}

/** The seller's fee units on one payment, by kind; `unpriced` names enabled kinds with no price in this currency. */
export function feeUnitsOf(c: FeeComponentsLike | null | undefined, grossUnits: number, currency: Cur, records: number, includeFlat: boolean): { percent: number; flat: number; perRecord: number; unpriced: string[] } {
  const out = { percent: 0, flat: 0, perRecord: 0, unpriced: [] as string[] };
  if (!c) return out;
  if (c.percent.enabled) out.percent = Math.round((grossUnits * c.percent.bps) / 10_000);
  if (c.flat.enabled && includeFlat) { const a = c.flat.amounts[currency]; if (a && a > 0) out.flat = toUnits(a, currency); else out.unpriced.push(`flat fee (no ${currency} price)`); }
  if (c.perRecord.enabled && records > 0) { const a = c.perRecord.amounts[currency]; if (a && a > 0) out.perRecord = records * toUnits(a, currency); else out.unpriced.push(`per-record fee (no ${currency} price)`); }
  return out;
}

/**
 * The payment fee on every USD charge, whatever the method — never a surcharge: card, debit and bank payments
 * pay the same. It is priced to cover credit-card processing (rate + fixed, grossed up so the processor's charge on
 * the whole payment leaves the stage intact).
 */
export interface PaymentFeeRates { enabled: boolean; bps: number; fixedCents: number }

/** The payment fee on a stage of `grossCents` (identical for every payment method). */
export function paymentFeeCents(rates: PaymentFeeRates | null | undefined, grossCents: number): number {
  if (!rates?.enabled || grossCents <= 0) return 0;
  return Math.ceil(((grossCents + rates.fixedCents) * 10_000) / (10_000 - rates.bps)) - grossCents;
}

/** How the buyer actually paid: a credit card, or anything else (debit or prepaid card, US bank account). */
export type PaymentFunding = 'credit' | 'debit' | 'prepaid' | 'bank' | 'unknown';

/**
 * Where a collected payment fee goes. Paid by credit card, it covers the processor's charge and any remainder goes
 * to the treasury. Paid any other way, the whole fee goes to the treasury (the processor's smaller charge for those
 * methods is the platform's cost).
 */
export function paymentFeeAllocation(feeCents: number, funding: PaymentFunding, processorCostCents: number): { cardCostCents: number; treasuryCents: number } {
  if (funding !== 'credit') return { cardCostCents: 0, treasuryCents: feeCents };
  const cardCostCents = Math.min(feeCents, Math.max(0, processorCostCents));
  return { cardCostCents, treasuryCents: feeCents - cardCostCents };
}
