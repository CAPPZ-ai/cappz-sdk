/**
 * COPE node crystallized. Node ID: v15-20-01-usage-plan
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * How a marketplace app (or service, or agent) bills its users: pay as you go,
 * a subscription, a subscription with paid overage, or sponsored (the app's
 * treasury tops up its users' app wallets). Prices are in USD, XRP or both.
 *
 * An app that has not configured a usage price gets a proposed default. A
 * proposal is shown, clearly marked as not validated by the app owner, and is
 * never charged: it becomes a price only when the owner acknowledges it or
 * sets their own (PriceAcknowledged / PriceSet, newest wins).
 */
import type { FeeUnit } from '../fees/priceSheet.ts';
import type { XrplNetwork } from '../../xrpl/ledgerCheck.ts';
import { amountIn, CURRENCIES, isMinor, type Amounts, type Currency, type Rate } from './money.ts';
import { usageInPeriod, type FundingEvent, type Period } from './events.ts';

export type BillingMode = 'payg' | 'subscription' | 'subscription-overage' | 'sponsored';

export type PriceValidation = 'proposed-default' | 'owner-acknowledged' | 'owner-set';

export interface UsagePrice {
  useCase: string;
  function: string;
  /** BPMN process that evidences the work. */
  process: string;
  unit: FeeUnit;
  /** Price per unit, minor units, in one or both currencies. */
  perUnit: Amounts;
  /** Minimum charge per call, if any. */
  minimum?: Amounts;
  validation: PriceValidation;
}

export interface SubscriptionTerms {
  period: Extract<Period, 'week' | 'month'>;
  price: Amounts;
  /** Units included per period, by function. Usage beyond is overage (charged only in subscription-overage). */
  included?: Record<string, number>;
  /** Amount the subscription credits to the user's app wallet each period (sponsored usage). */
  creditsWallet?: Amounts;
}

export interface AppUsagePlan {
  /** App wallet root (the app owner's POW app path). */
  appRoot: string;
  /** ebb tenant: the app owner. */
  tenant: string;
  /** Contract whose split governs every charge. */
  contractId: string;
  mode: BillingMode;
  /** Currencies users may pay in: one or both. */
  accepts: Currency[];
  prices: UsagePrice[];
  subscription?: SubscriptionTerms;
  /** Platform baseline fee per charged transaction, minor units; paid to `to`. */
  baseFee?: { amount: Amounts; to: string };
  /** Where XRP top-ups are paid: the app's receiving address on XRPL. */
  xrpl?: { payTo: string; network: XrplNetwork };
}

/**
 * Starting points offered when an app has no price for a unit. Owner-facing
 * proposals only — not researched, not charged until acknowledged or changed.
 */
export const DEFAULT_PRICE_PROPOSALS: Readonly<Record<FeeUnit, Amounts>> = {
  'per-call': { USD: 1 },
  'per-document': { USD: 25 },
  'per-mb': { USD: 2 },
  'per-session': { USD: 10 },
  'per-replica-month': { USD: 100 },
  'per-month': { USD: 500 },
};

export const UNVALIDATED_NOTICE = 'Proposed default — not validated by the app owner. Not charged until the owner acknowledges or changes it.';

export function proposeDefaultPrices(functions: ReadonlyArray<{ useCase: string; function: string; process: string; unit: FeeUnit }>): UsagePrice[] {
  return functions.map((f) => ({ ...f, perUnit: { ...DEFAULT_PRICE_PROPOSALS[f.unit] }, validation: 'proposed-default' }));
}

/** The owner's decision on one function's price. */
export type OwnerPriceDecision =
  | { type: 'PriceAcknowledged'; function: string; at: string; by: string }
  | { type: 'PriceSet'; function: string; at: string; by: string; perUnit: Amounts; minimum?: Amounts };

/** Apply owner decisions (newest per function wins) to a plan's prices. */
export function applyOwnerDecisions(prices: readonly UsagePrice[], decisions: readonly OwnerPriceDecision[]): UsagePrice[] {
  const latest = new Map<string, OwnerPriceDecision>();
  for (const d of [...decisions].sort((a, b) => a.at.localeCompare(b.at))) latest.set(d.function, d);
  return prices.map((p) => {
    const d = latest.get(p.function);
    if (!d) return p;
    if (d.type === 'PriceAcknowledged') return { ...p, validation: p.validation === 'owner-set' ? 'owner-set' : 'owner-acknowledged' };
    return { ...p, perUnit: { ...d.perUnit }, ...(d.minimum ? { minimum: { ...d.minimum } } : {}), validation: 'owner-set' };
  });
}

export const isValidated = (p: UsagePrice): boolean => p.validation !== 'proposed-default';

/** Label to show next to a price. */
export function priceStatusLabel(p: UsagePrice): string {
  if (p.validation === 'proposed-default') return UNVALIDATED_NOTICE;
  return p.validation === 'owner-set' ? 'Set by the app owner' : 'Default acknowledged by the app owner';
}

export function planProblems(plan: AppUsagePlan): string[] {
  const out: string[] = [];
  if (plan.accepts.length === 0) out.push('Accept at least one currency (USD, XRP or both)');
  for (const c of plan.accepts) if (!CURRENCIES.includes(c)) out.push(`Unknown currency ${c}`);
  if ((plan.mode === 'subscription' || plan.mode === 'subscription-overage') && !plan.subscription) out.push(`${plan.mode} needs subscription terms`);
  const seen = new Set<string>();
  for (const p of plan.prices) {
    if (seen.has(p.function)) out.push(`Two prices for ${p.function}`);
    seen.add(p.function);
    for (const c of CURRENCIES) if (p.perUnit[c] !== undefined && !isMinor(p.perUnit[c])) out.push(`${p.function}: ${c} price must be whole minor units`);
    if (!CURRENCIES.some((c) => isMinor(p.perUnit[c]))) out.push(`${p.function}: no price in any currency`);
  }
  if (!plan.contractId) out.push('A plan needs the contract whose split governs its charges');
  return out;
}

export type UsageQuote =
  | {
      ok: true;
      function: string;
      currency: Currency;
      quantity: number;
      /** Units charged after the subscription allowance. */
      chargedUnits: number;
      usage: number;
      baseFee: number;
      total: number;
      /** Some amount was converted with the given rate. */
      converted: boolean;
      validation: PriceValidation;
    }
  | { ok: false; reason: 'no-price' | 'currency-not-accepted' | 'no-rate' | 'price-not-validated' | 'allowance-exhausted' | 'bad-quantity'; detail: string };

/**
 * Quote `quantity` units of `fn` in `currency`. Subscription allowances are
 * replayed from UsageRecorded. Unvalidated proposals are refused for charging;
 * pass `estimate: true` to price them for planning (the quote says so).
 */
export function quoteUsage(
  plan: AppUsagePlan,
  fn: string,
  quantity: number,
  currency: Currency,
  o: { events?: readonly FundingEvent[]; rate?: Rate; now?: Date; estimate?: boolean } = {},
): UsageQuote {
  const now = o.now ?? new Date();
  if (!(quantity > 0) || !Number.isFinite(quantity)) return { ok: false, reason: 'bad-quantity', detail: 'Quantity must be positive' };
  if (!plan.accepts.includes(currency)) return { ok: false, reason: 'currency-not-accepted', detail: `${plan.appRoot} accepts ${plan.accepts.join(', ')}` };
  const price = plan.prices.find((p) => p.function === fn);
  if (!price) return { ok: false, reason: 'no-price', detail: `No price for ${fn}` };
  if (!isValidated(price) && !o.estimate) return { ok: false, reason: 'price-not-validated', detail: UNVALIDATED_NOTICE };

  let chargedUnits = quantity;
  const sub = plan.subscription;
  const included = sub?.included?.[fn];
  if (sub && included !== undefined && (plan.mode === 'subscription' || plan.mode === 'subscription-overage')) {
    const used = usageInPeriod(o.events ?? [], fn, sub.period, now);
    const left = Math.max(0, included - used);
    chargedUnits = Math.max(0, quantity - left);
    if (chargedUnits > 0 && plan.mode === 'subscription') {
      return { ok: false, reason: 'allowance-exhausted', detail: `${fn}: ${left} of ${included} left this ${sub.period}` };
    }
  }

  let usage = 0;
  let converted = false;
  if (chargedUnits > 0) {
    const unit = amountIn(price.perUnit, currency, o.rate, now);
    if (!unit) return { ok: false, reason: 'no-rate', detail: `${fn} is priced in another currency and no fresh rate was given` };
    usage = Math.ceil(unit.amount * chargedUnits);
    converted = unit.converted;
    if (price.minimum) {
      const min = amountIn(price.minimum, currency, o.rate, now);
      if (!min) return { ok: false, reason: 'no-rate', detail: `${fn} minimum is in another currency and no fresh rate was given` };
      usage = Math.max(usage, min.amount);
      converted ||= min.converted;
    }
  }
  let baseFee = 0;
  if (plan.baseFee && usage > 0) {
    const b = amountIn(plan.baseFee.amount, currency, o.rate, now);
    if (!b) return { ok: false, reason: 'no-rate', detail: 'The base fee is in another currency and no fresh rate was given' };
    baseFee = b.amount;
    converted ||= b.converted;
  }
  return { ok: true, function: fn, currency, quantity, chargedUnits, usage, baseFee, total: usage + baseFee, converted, validation: price.validation };
}
