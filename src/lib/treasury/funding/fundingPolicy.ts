/**
 * COPE node crystallized. Node ID: v15-20-01-funding-policy
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * A user's (or an app owner's) rule for keeping an app wallet funded, and the
 * pure decision it produces. The decision never moves money: it says whether
 * to do nothing, warn, propose a top-up (a one-click toast, or a typed
 * command), or — only in auto mode, within caps — top up now. The wallet that
 * owns the money signs; this code holds no key.
 *
 *   auto     top up without asking, up to `autoApproveUpTo` and within caps;
 *            a rule with no cap at all never auto-tops-up (it proposes).
 *   confirm  propose; the person approves with one click.
 *   command  propose; the person approves by typing the command shown.
 *   off      warn only.
 */
import { capProblems, capRoom, hasAnyCap, type CapWindow, type Caps } from './caps.ts';
import { replayProposals, type FundingEvent, type FundingSource } from './events.ts';
import { formatMinor, isMinor, type Currency } from './money.ts';
import type { RunwayEstimate } from './runway.ts';

export type FundingMode = 'auto' | 'confirm' | 'command' | 'off';

export interface FundingRule {
  ruleId: string;
  /** App the rule funds (its wallet root). */
  appRoot: string;
  /** Short app name for notices and commands. */
  appName: string;
  currency: Currency;
  /** Fires when the balance is below this (minor units)… */
  belowBalance?: number;
  /** …or when the runway is shorter than this many hours. */
  belowRunwayHours?: number;
  /** Top up to this balance. */
  target: number;
  /** Smallest top-up worth making. */
  minTopUp?: number;
  source: Exclude<FundingSource, 'subscription'>;
  mode: FundingMode;
  caps: Caps;
  /** In auto mode, larger top-ups are proposed instead. Unset = any amount within caps. */
  autoApproveUpTo?: number;
  /** How long a proposal stays open. Default 24 h. */
  proposalTtlMs?: number;
}

export const DEFAULT_PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

export function ruleProblems(r: FundingRule): string[] {
  const out = capProblems(r.caps);
  if (!r.ruleId) out.push('Rule needs an id');
  if (r.belowBalance === undefined && r.belowRunwayHours === undefined) out.push('Set a low-balance amount or a runway in hours');
  if (r.belowBalance !== undefined && !isMinor(r.belowBalance)) out.push('Low-balance amount must be whole minor units');
  if (!isMinor(r.target) || r.target === 0) out.push('Target balance must be more than zero');
  if (r.belowBalance !== undefined && isMinor(r.target) && r.target <= r.belowBalance) out.push('Target balance must be above the low-balance amount');
  if (r.mode === 'auto' && !hasAnyCap(r.caps)) out.push('Auto top-up needs at least one cap (overall, month, week, day or hour); without one it only proposes');
  return out;
}

export type FundingDecision =
  | { action: 'none'; reason: string }
  | { action: 'pending'; proposalId: string; reason: string }
  | { action: 'notify'; reason: string; message: string }
  | { action: 'capped'; limitedBy: CapWindow; reason: string; message: string }
  | {
      action: 'propose' | 'execute';
      amount: number;
      currency: Currency;
      /** Reduced by a cap. */
      partial: boolean;
      limitedBy: CapWindow | null;
      reason: string;
      message: string;
      /** For command mode: the text the person types to approve. */
      command: string;
    };

export function topUpCommand(r: FundingRule, amount: number): string {
  return `top up ${r.appName} ${formatMinor(amount, r.currency)}`;
}

/** Parse "top up <app> $12.34" / "top up <app> 5 XRP" back to an amount in minor units. */
export function parseTopUpCommand(text: string): { appName: string; currency: Currency; amount: number } | null {
  const t = text.trim();
  const usd = t.match(/^top up (.+) \$(\d+(?:\.\d{1,2})?)$/i);
  if (usd) return { appName: usd[1], currency: 'USD', amount: Math.round(Number(usd[2]) * 100) };
  const xrp = t.match(/^top up (.+) (\d+(?:\.\d{1,6})?) XRP$/i);
  if (xrp) return { appName: xrp[1], currency: 'XRP', amount: Math.round(Number(xrp[2]) * 1_000_000) };
  return null;
}

export function decideFunding(i: {
  rule: FundingRule;
  balance: number;
  runway: RunwayEstimate;
  events: readonly FundingEvent[];
  now: Date;
}): FundingDecision {
  const { rule: r, balance, runway, events, now } = i;
  const lowBalance = r.belowBalance !== undefined && balance < r.belowBalance;
  const lowRunway = r.belowRunwayHours !== undefined && runway.hours !== null && runway.hours < r.belowRunwayHours;
  if (!lowBalance && !lowRunway) return { action: 'none', reason: 'Balance and runway are above the rule' };

  const why = lowBalance
    ? `${r.appName} balance ${formatMinor(balance, r.currency)} is below ${formatMinor(r.belowBalance!, r.currency)}`
    : `${r.appName} has about ${Math.floor(runway.hours!)} h of usage left`;

  const open = replayProposals(events, now).find((p) => p.ruleId === r.ruleId && (p.state === 'open' || p.state === 'approved'));
  if (open) return { action: 'pending', proposalId: open.proposalId, reason: `Waiting on ${open.state} proposal ${open.proposalId}` };

  if (r.mode === 'off') return { action: 'notify', reason: why, message: `${why}. Automatic top-up is off.` };

  let amount = Math.max(r.target - balance, r.minTopUp ?? 0);
  const caps = capRoom(r.caps, events, r.ruleId, r.currency, now);
  if (caps.room !== null && caps.room === 0) {
    return { action: 'capped', limitedBy: caps.limitedBy!, reason: why, message: `${why}. The ${caps.limitedBy} top-up cap is used up.` };
  }
  let partial = false;
  if (caps.room !== null && amount > caps.room) { amount = caps.room; partial = true; }
  if (r.minTopUp !== undefined && amount < r.minTopUp) {
    return { action: 'capped', limitedBy: caps.limitedBy ?? 'overall', reason: why, message: `${why}. The cap leaves less than the minimum top-up.` };
  }
  const command = topUpCommand(r, amount);
  const amountText = formatMinor(amount, r.currency);
  const capped = partial ? ` (limited by the ${caps.limitedBy} cap)` : '';

  const canAuto = r.mode === 'auto' && hasAnyCap(r.caps) && (r.autoApproveUpTo === undefined || amount <= r.autoApproveUpTo);
  if (canAuto) {
    return { action: 'execute', amount, currency: r.currency, partial, limitedBy: caps.limitedBy, reason: why, message: `${why}. Topping up ${amountText}${capped}.`, command };
  }
  const ask = r.mode === 'command' ? `Type "${command}" to approve.` : `Top up ${amountText}${capped}?`;
  return { action: 'propose', amount, currency: r.currency, partial, limitedBy: caps.limitedBy, reason: why, message: `${why}. ${ask}`, command };
}
