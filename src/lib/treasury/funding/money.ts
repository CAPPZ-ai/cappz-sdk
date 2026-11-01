/**
 * COPE node crystallized. Node ID: v15-20-01-funding-money
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * Amounts for usage billing, in USD, XRP or both. Every amount is an integer
 * in minor units — USD cents, XRP drops — so nothing is lost to rounding.
 * An app accepts either currency or both; a price may be set in one or both.
 * A price set only in the other currency is converted only with an explicit,
 * fresh rate. No rate means no conversion, never a guessed one.
 */

export type Currency = 'USD' | 'XRP';
export const CURRENCIES: readonly Currency[] = ['USD', 'XRP'];

/** Minor units per whole unit: cents per dollar, drops per XRP. */
export const MINOR_PER_UNIT: Readonly<Record<Currency, number>> = { USD: 100, XRP: 1_000_000 };

/** Amounts per currency, in minor units. A missing currency means "not set", not zero. */
export type Amounts = Partial<Record<Currency, number>>;

/** USD per XRP, as quoted by a named source at a time. */
export interface Rate {
  usdCentsPerXrp: number;
  source: string;
  at: string;
}

/** A rate older than this is not used for conversion. */
export const RATE_MAX_AGE_MS = 15 * 60 * 1000;

export function isMinor(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

export function rateUsable(rate: Rate | undefined, now: Date, maxAgeMs = RATE_MAX_AGE_MS): rate is Rate {
  if (!rate || !(rate.usdCentsPerXrp > 0) || !Number.isFinite(rate.usdCentsPerXrp)) return false;
  const age = now.getTime() - Date.parse(rate.at);
  return Number.isFinite(age) && age <= maxAgeMs && age >= -60_000;
}

/**
 * Convert minor units between currencies, rounding up (a converted price never
 * undercharges). Same currency returns the amount; otherwise null without a usable rate.
 */
export function convertMinor(amount: number, from: Currency, to: Currency, rate: Rate | undefined, now: Date): number | null {
  if (from === to) return amount;
  if (!rateUsable(rate, now)) return null;
  // USD cents → XRP drops: cents / (cents per XRP) * 1e6.
  if (from === 'USD') return Math.ceil((amount * MINOR_PER_UNIT.XRP) / rate.usdCentsPerXrp);
  return Math.ceil((amount * rate.usdCentsPerXrp) / MINOR_PER_UNIT.XRP);
}

/** The amount in `currency`: set directly, or converted from the other currency with a usable rate. */
export function amountIn(amounts: Amounts, currency: Currency, rate: Rate | undefined, now: Date): { amount: number; converted: boolean } | null {
  const direct = amounts[currency];
  if (isMinor(direct)) return { amount: direct, converted: false };
  for (const other of CURRENCIES) {
    const v = amounts[other];
    if (other === currency || !isMinor(v)) continue;
    const c = convertMinor(v, other, currency, rate, now);
    if (c !== null) return { amount: c, converted: true };
  }
  return null;
}

/** "$12.34" / "1.5 XRP". */
export function formatMinor(amount: number, currency: Currency): string {
  if (currency === 'USD') return `$${(amount / 100).toFixed(2)}`;
  const whole = amount / MINOR_PER_UNIT.XRP;
  return `${Number(whole.toFixed(6))} XRP`;
}

export function addAmounts(a: Amounts, b: Amounts): Amounts {
  const out: Amounts = { ...a };
  for (const c of CURRENCIES) if (b[c] !== undefined) out[c] = (out[c] ?? 0) + (b[c] as number);
  return out;
}
