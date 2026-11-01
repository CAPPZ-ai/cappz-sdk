/**
 * COPE node crystallized. Node ID: v15-20-01-funding-caps
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * Spending caps on rule-driven top-ups: overall, and per UTC month, ISO week,
 * day and hour. Every cap that is set must have room; the smallest room wins.
 * Only top-ups the rule produced (AppFunded with its ruleId) count — money a
 * person adds by hand does not use up an autopay cap.
 */
import { periodStart, type FundingEvent, type Period } from './events.ts';
import type { Currency } from './money.ts';

export type CapWindow = Period | 'overall';
export const CAP_WINDOWS: readonly CapWindow[] = ['hour', 'day', 'week', 'month', 'overall'];

/** Caps in the rule's currency, minor units. A missing window is uncapped. */
export type Caps = Partial<Record<CapWindow, number>>;

export interface CapRoom {
  /** Most that may still be topped up now; null when no cap is set. */
  room: number | null;
  /** The window that limits it, when capped. */
  limitedBy: CapWindow | null;
  used: Record<CapWindow, number>;
}

export function hasAnyCap(caps: Caps): boolean {
  return CAP_WINDOWS.some((w) => caps[w] !== undefined);
}

export function capProblems(caps: Caps): string[] {
  const out: string[] = [];
  for (const w of CAP_WINDOWS) {
    const v = caps[w];
    if (v !== undefined && (!Number.isSafeInteger(v) || v < 0)) out.push(`${w} cap must be whole minor units, zero or more`);
  }
  // A shorter window above a longer one is never reachable; say so rather than silently ignore it.
  const order: CapWindow[] = ['hour', 'day', 'week', 'month', 'overall'];
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) {
      const a = caps[order[i]], b = caps[order[j]];
      if (a !== undefined && b !== undefined && a > b) out.push(`${order[i]} cap is above the ${order[j]} cap`);
    }
  }
  return out;
}

export function capRoom(caps: Caps, events: readonly FundingEvent[], ruleId: string, currency: Currency, now: Date): CapRoom {
  const used: Record<CapWindow, number> = { hour: 0, day: 0, week: 0, month: 0, overall: 0 };
  const starts: Record<Period, number> = {
    hour: periodStart('hour', now).getTime(),
    day: periodStart('day', now).getTime(),
    week: periodStart('week', now).getTime(),
    month: periodStart('month', now).getTime(),
  };
  for (const e of events) {
    if (e.type !== 'AppFunded' || e.ruleId !== ruleId || e.currency !== currency) continue;
    const t = Date.parse(e.at);
    if (t > now.getTime()) continue;
    used.overall += e.amount;
    for (const p of ['hour', 'day', 'week', 'month'] as Period[]) if (t >= starts[p]) used[p] += e.amount;
  }
  let room: number | null = null;
  let limitedBy: CapWindow | null = null;
  for (const w of CAP_WINDOWS) {
    const cap = caps[w];
    if (cap === undefined) continue;
    const r = Math.max(0, cap - used[w]);
    if (room === null || r < room) { room = r; limitedBy = w; }
  }
  return { room, limitedBy, used };
}
