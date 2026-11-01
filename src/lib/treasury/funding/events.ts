/**
 * COPE node crystallized. Node ID: v15-20-01-funding-events
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * The TXs a user app wallet (UAW) carries for usage billing. Balances, usage,
 * spending and open top-up proposals are all replayed from these (AP-12: no
 * stored numbers or flags). Calendar periods are UTC.
 */
import type { Amounts, Currency } from './money.ts';

export type FundingSource = 'user-wallet' | 'app-treasury' | 'subscription';

/** Money arrived in the app wallet. `ruleId` set when a funding rule produced it (counts against that rule's caps). */
export interface AppFunded {
  type: 'AppFunded';
  at: string;
  currency: Currency;
  amount: number;
  source: FundingSource;
  ruleId?: string;
  proposalId?: string;
  /** Ledger hash of the payment, when settled on XRPL. */
  txHash?: string;
}

/** A usage charge against the app wallet. */
export interface FeeChargedTx {
  type: 'FeeCharged';
  at: string;
  currency: Currency;
  amount: number;
  function: string;
  quantity: number;
  /** Charge id: the split lines and AP/AR postings reference it. */
  chargeId: string;
}

/** Usage counted against a subscription allowance (recorded with or without a charge). */
export interface UsageRecorded {
  type: 'UsageRecorded';
  at: string;
  function: string;
  quantity: number;
}

export interface TopUpProposed {
  type: 'TopUpProposed';
  at: string;
  proposalId: string;
  ruleId: string;
  currency: Currency;
  amount: number;
  /** Proposal is void after this time. */
  expiresAt: string;
  reason: string;
}
export interface TopUpApproved { type: 'TopUpApproved'; at: string; proposalId: string; by: string }
export interface TopUpDeclined { type: 'TopUpDeclined'; at: string; proposalId: string; by: string; reason?: string }
export interface RunwayLow { type: 'RunwayLow'; at: string; ruleId: string; currency: Currency; balance: number; runwayHours: number | null }
export interface TaskDeferred { type: 'TaskDeferred'; at: string; taskId: string; reason: string }
export interface TaskResumed { type: 'TaskResumed'; at: string; taskId: string }

export type FundingEvent =
  | AppFunded | FeeChargedTx | UsageRecorded
  | TopUpProposed | TopUpApproved | TopUpDeclined
  | RunwayLow | TaskDeferred | TaskResumed;

export const FUNDING_EVENT_TYPES: readonly FundingEvent['type'][] = [
  'AppFunded', 'FeeCharged', 'UsageRecorded', 'TopUpProposed', 'TopUpApproved', 'TopUpDeclined', 'RunwayLow', 'TaskDeferred', 'TaskResumed',
];

export function sortedEvents<T extends { at: string }>(events: readonly T[]): T[] {
  return [...events].sort((a, b) => a.at.localeCompare(b.at));
}

/** App wallet balance per currency: funded minus charged. Currencies with no activity are absent. */
export function replayWalletBalance(events: readonly FundingEvent[]): Amounts {
  const out: Amounts = {};
  for (const e of events) {
    if (e.type === 'AppFunded') out[e.currency] = (out[e.currency] ?? 0) + e.amount;
    else if (e.type === 'FeeCharged') out[e.currency] = (out[e.currency] ?? 0) - e.amount;
  }
  return out;
}

export function balanceIn(events: readonly FundingEvent[], currency: Currency): number {
  return replayWalletBalance(events)[currency] ?? 0;
}

export type ProposalState = 'open' | 'approved' | 'declined' | 'expired' | 'funded';

/** Was this proposal ever approved (whatever its state now)? */
export function wasApproved(events: readonly FundingEvent[], proposalId: string): boolean {
  return events.some((e) => e.type === 'TopUpApproved' && e.proposalId === proposalId);
}

/** Proposals with their replayed state. A funded proposal has an AppFunded carrying its id. */
export function replayProposals(events: readonly FundingEvent[], now: Date): Array<TopUpProposed & { state: ProposalState }> {
  const decided = new Map<string, 'approved' | 'declined'>();
  const funded = new Set<string>();
  for (const e of sortedEvents(events)) {
    if (e.type === 'TopUpApproved') decided.set(e.proposalId, 'approved');
    else if (e.type === 'TopUpDeclined') decided.set(e.proposalId, 'declined');
    else if (e.type === 'AppFunded' && e.proposalId) funded.add(e.proposalId);
  }
  return events
    .filter((e): e is TopUpProposed => e.type === 'TopUpProposed')
    .map((p) => {
      // An approved proposal still waiting for its payment (an XRP top-up the person pays from
      // their own wallet) also lapses at expiresAt, so the rule can propose again.
      const expired = Date.parse(p.expiresAt) <= now.getTime();
      const d = decided.get(p.proposalId);
      const state: ProposalState = funded.has(p.proposalId) ? 'funded'
        : d === 'declined' ? 'declined'
        : expired ? 'expired'
        : d ?? 'open';
      return { ...p, state };
    });
}

/** Tasks currently deferred (a TaskDeferred with no later TaskResumed). */
export function deferredTasks(events: readonly FundingEvent[]): string[] {
  const open = new Set<string>();
  for (const e of sortedEvents(events)) {
    if (e.type === 'TaskDeferred') open.add(e.taskId);
    else if (e.type === 'TaskResumed') open.delete(e.taskId);
  }
  return [...open];
}

// ─── UTC calendar periods ─────────────────────────────────────────

export type Period = 'hour' | 'day' | 'week' | 'month';

/** Start of the UTC hour, day, ISO week (Monday) or month containing `now`. */
export function periodStart(period: Period, now: Date): Date {
  const d = new Date(now.getTime());
  d.setUTCMinutes(0, 0, 0);
  if (period === 'hour') return d;
  d.setUTCHours(0);
  if (period === 'day') return d;
  if (period === 'week') {
    const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
    d.setUTCDate(d.getUTCDate() - dow);
    return d;
  }
  d.setUTCDate(1);
  return d;
}

/** Usage of `fn` recorded in the current period. */
export function usageInPeriod(events: readonly FundingEvent[], fn: string, period: Period, now: Date): number {
  const from = periodStart(period, now).getTime();
  let q = 0;
  for (const e of events) {
    if (e.type === 'UsageRecorded' && e.function === fn) {
      const t = Date.parse(e.at);
      if (t >= from && t <= now.getTime()) q += e.quantity;
    }
  }
  return q;
}
