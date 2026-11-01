/**
 * COPE node crystallized. Node ID: v15-20-01-funding-runway
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * How fast an app wallet is spending and how long its balance lasts, from
 * replayed FeeCharged TXs; and projected against actual spend for a period
 * (the subscription's projection versus what was charged).
 */
import { periodStart, type FundingEvent, type Period } from './events.ts';
import type { Currency } from './money.ts';

export const BURN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface RunwayEstimate {
  /** Minor units spent per hour over the window. */
  burnPerHour: number;
  /** Hours the balance lasts at that rate; null when nothing is being spent. */
  hours: number | null;
  /** Charges the estimate is based on. */
  samples: number;
}

/**
 * Spend rate over the last `windowMs`, measured from the first charge in the
 * window when the wallet is younger than the window (so a new wallet's burn
 * is not diluted by time it did not exist).
 */
export function estimateRunway(events: readonly FundingEvent[], currency: Currency, balance: number, now: Date, windowMs = BURN_WINDOW_MS): RunwayEstimate {
  const from = now.getTime() - windowMs;
  let spent = 0;
  let first = Infinity;
  let samples = 0;
  for (const e of events) {
    if (e.type !== 'FeeCharged' || e.currency !== currency) continue;
    const t = Date.parse(e.at);
    if (t < from || t > now.getTime()) continue;
    spent += e.amount;
    first = Math.min(first, t);
    samples++;
  }
  if (samples === 0 || spent === 0) return { burnPerHour: 0, hours: null, samples };
  const spanHours = Math.max(1, (now.getTime() - first) / 3_600_000);
  const burnPerHour = spent / spanHours;
  return { burnPerHour, hours: Math.max(0, balance) / burnPerHour, samples };
}

export interface ProjectedVsActual {
  period: Period;
  from: string;
  currency: Currency;
  projected: number;
  actual: number;
  /** actual − projected. */
  variance: number;
  /** variance / projected; null when nothing was projected. */
  variancePct: number | null;
}

/** Compare a projected spend for the current period with the FeeCharged TXs in it. */
export function projectedVsActual(events: readonly FundingEvent[], currency: Currency, projected: number, period: Period, now: Date): ProjectedVsActual {
  const start = periodStart(period, now);
  let actual = 0;
  for (const e of events) {
    if (e.type !== 'FeeCharged' || e.currency !== currency) continue;
    const t = Date.parse(e.at);
    if (t >= start.getTime() && t <= now.getTime()) actual += e.amount;
  }
  const variance = actual - projected;
  return { period, from: start.toISOString(), currency, projected, actual, variance, variancePct: projected > 0 ? variance / projected : null };
}
