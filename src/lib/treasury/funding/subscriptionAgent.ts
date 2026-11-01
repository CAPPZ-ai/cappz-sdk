/**
 * COPE node crystallized. Node ID: v15-20-01-subscription-agent
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * The subscription agent skill: watches app wallets for marketplace apps,
 * services and agents billed by usage, and keeps them funded within the
 * owner's rules — proposing a top-up (one click or a typed command), topping
 * up automatically inside caps, or running the most critical work first when
 * money is short. It charges usage by the app's plan and splits each charge
 * by the contract into AP/AR postings.
 *
 * Hosts plug in through ports, so the same code runs in the browser, on an
 * edge node (for sponsored top-ups from the app's POW treasury) or in Node:
 *   store   read/append the wallet's FundingEvent TXs. The host must apply a
 *           wallet's appends in order (one writer per wallet).
 *   fund    move the money — the wallet or treasury that owns it signs.
 *           Without it, nothing is ever topped up automatically.
 *   notify  show a notice (a toast in the app, a log line on a node).
 *   rate    a fresh USD/XRP rate, when a price must be converted.
 * The agent holds no key and never decides a price or a split itself.
 */
import { postingsFor, splitCharge, type ContractSplit, type Posting, type SplitLine } from './contractSplit.ts';
import { balanceIn, deferredTasks, replayProposals, replayWalletBalance, type FundingEvent } from './events.ts';
import { DEFAULT_PROPOSAL_TTL_MS, decideFunding, parseTopUpCommand, type FundingDecision, type FundingRule } from './fundingPolicy.ts';
import type { Amounts, Currency, Rate } from './money.ts';
import { estimateRunway, type RunwayEstimate } from './runway.ts';
import { planWithinBudget, type BudgetPlan, type PlannedTask } from './taskPriority.ts';
import { quoteUsage, type AppUsagePlan, type UsageQuote } from './usagePlan.ts';

export interface FundingStore {
  read(wallet: string): Promise<FundingEvent[]>;
  append(wallet: string, event: FundingEvent): Promise<void>;
}

export interface FundRequest {
  wallet: string;
  rule: FundingRule;
  proposalId: string;
  currency: Currency;
  amount: number;
}

export type FundingNotice =
  | { kind: 'propose'; wallet: string; ruleId: string; proposalId: string; currency: Currency; amount: number; message: string; command: string; mode: FundingRule['mode']; expiresAt: string }
  | { kind: 'funded'; wallet: string; ruleId: string; proposalId: string; currency: Currency; amount: number; message: string; auto: boolean }
  | { kind: 'warn'; wallet: string; ruleId: string; message: string }
  | { kind: 'failed'; wallet: string; ruleId: string; proposalId: string; message: string };

export interface SubscriptionAgentPorts {
  store: FundingStore;
  fund?: (r: FundRequest) => Promise<{ txHash?: string }>;
  notify?: (n: FundingNotice) => void | Promise<void>;
  rate?: () => Promise<Rate | undefined>;
  now?: () => Date;
}

export interface RuleCheck {
  rule: FundingRule;
  balance: number;
  runway: RunwayEstimate;
  decision: FundingDecision;
  /** What the agent did about it. */
  outcome: 'nothing' | 'proposed' | 'funded' | 'warned' | 'waiting' | 'fund-failed';
  proposalId?: string;
}

export type ChargeResult =
  | { ok: true; chargeId: string; quote: Extract<UsageQuote, { ok: true }>; lines: SplitLine[]; postings: Posting[]; duplicate: boolean }
  | { ok: false; status: 402; reason: 'insufficient-funds'; quote: Extract<UsageQuote, { ok: true }>; balance: number; detail: string }
  | { ok: false; status: 400 | 409; reason: string; detail: string };

/** Stable id for things the agent creates (proposals), from their content. */
async function shortId(prefix: string, text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return `${prefix}-${Array.from(new Uint8Array(d).slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function createSubscriptionAgent(ports: SubscriptionAgentPorts) {
  const now = () => ports.now?.() ?? new Date();
  const notify = async (n: FundingNotice) => { await ports.notify?.(n); };

  async function fundProposal(wallet: string, rule: FundingRule, proposalId: string, currency: Currency, amount: number, auto: boolean): Promise<boolean> {
    if (!ports.fund) return false;
    try {
      const { txHash } = await ports.fund({ wallet, rule, proposalId, currency, amount });
      await ports.store.append(wallet, {
        type: 'AppFunded', at: now().toISOString(), currency, amount, source: rule.source, ruleId: rule.ruleId, proposalId, ...(txHash ? { txHash } : {}),
      });
      await notify({ kind: 'funded', wallet, ruleId: rule.ruleId, proposalId, currency, amount, auto, message: `${rule.appName} topped up.` });
      return true;
    } catch (err) {
      await ports.store.append(wallet, { type: 'TopUpDeclined', at: now().toISOString(), proposalId, by: 'system', reason: `payment failed: ${err instanceof Error ? err.message : String(err)}` });
      await notify({ kind: 'failed', wallet, ruleId: rule.ruleId, proposalId, message: `${rule.appName} top-up failed; nothing was charged by the agent.` });
      return false;
    }
  }

  async function propose(wallet: string, rule: FundingRule, d: Extract<FundingDecision, { action: 'propose' | 'execute' }>): Promise<{ proposalId: string; expiresAt: string }> {
    const at = now();
    const proposalId = await shortId('topup', `${wallet}|${rule.ruleId}|${at.toISOString()}|${d.amount}|${d.currency}`);
    const expiresAt = new Date(at.getTime() + (rule.proposalTtlMs ?? DEFAULT_PROPOSAL_TTL_MS)).toISOString();
    await ports.store.append(wallet, { type: 'TopUpProposed', at: at.toISOString(), proposalId, ruleId: rule.ruleId, currency: d.currency, amount: d.amount, expiresAt, reason: d.reason });
    return { proposalId, expiresAt };
  }

  /** Check one app wallet against its rules and act on each decision. */
  async function check(wallet: string, rules: readonly FundingRule[]): Promise<RuleCheck[]> {
    const out: RuleCheck[] = [];
    for (const rule of rules) {
      const events = await ports.store.read(wallet);
      const t = now();
      const balance = balanceIn(events, rule.currency);
      const runway = estimateRunway(events, rule.currency, balance, t);
      const decision = decideFunding({ rule, balance, runway, events, now: t });
      const base = { rule, balance, runway, decision };
      switch (decision.action) {
        case 'none': out.push({ ...base, outcome: 'nothing' }); break;
        case 'pending': out.push({ ...base, outcome: 'waiting', proposalId: decision.proposalId }); break;
        case 'notify':
        case 'capped': {
          // One warning per rule per hour is enough.
          const hourAgo = t.getTime() - 3_600_000;
          const recent = events.some((e) => e.type === 'RunwayLow' && e.ruleId === rule.ruleId && Date.parse(e.at) > hourAgo);
          if (!recent) {
            await ports.store.append(wallet, { type: 'RunwayLow', at: t.toISOString(), ruleId: rule.ruleId, currency: rule.currency, balance, runwayHours: runway.hours });
            await notify({ kind: 'warn', wallet, ruleId: rule.ruleId, message: decision.message });
          }
          out.push({ ...base, outcome: 'warned' });
          break;
        }
        case 'execute':
        case 'propose': {
          const { proposalId, expiresAt } = await propose(wallet, rule, decision);
          if (decision.action === 'execute' && ports.fund) {
            await ports.store.append(wallet, { type: 'TopUpApproved', at: now().toISOString(), proposalId, by: `rule:${rule.ruleId}` });
            const ok = await fundProposal(wallet, rule, proposalId, decision.currency, decision.amount, true);
            out.push({ ...base, outcome: ok ? 'funded' : 'fund-failed', proposalId });
          } else {
            await notify({ kind: 'propose', wallet, ruleId: rule.ruleId, proposalId, currency: decision.currency, amount: decision.amount, message: decision.message, command: decision.command, mode: rule.mode, expiresAt });
            out.push({ ...base, outcome: 'proposed', proposalId });
          }
          break;
        }
      }
    }
    return out;
  }

  /** Approve an open proposal (the toast's button) and fund it. */
  async function approve(wallet: string, proposalId: string, by: string, rules: readonly FundingRule[]): Promise<{ ok: boolean; detail: string }> {
    const p = replayProposals(await ports.store.read(wallet), now()).find((x) => x.proposalId === proposalId);
    if (!p) return { ok: false, detail: 'No such proposal' };
    if (p.state !== 'open') return { ok: false, detail: `Proposal is ${p.state}` };
    const rule = rules.find((r) => r.ruleId === p.ruleId);
    if (!rule) return { ok: false, detail: 'The rule behind this proposal no longer exists' };
    if (!ports.fund) return { ok: false, detail: 'No wallet is connected to pay with' };
    await ports.store.append(wallet, { type: 'TopUpApproved', at: now().toISOString(), proposalId, by });
    const ok = await fundProposal(wallet, rule, proposalId, p.currency, p.amount, false);
    return { ok, detail: ok ? 'Topped up' : 'Payment failed' };
  }

  /** Approve by the typed command ("top up <app> $20.00"): it must match an open proposal exactly. */
  async function approveCommand(wallet: string, text: string, by: string, rules: readonly FundingRule[]): Promise<{ ok: boolean; detail: string }> {
    const cmd = parseTopUpCommand(text);
    if (!cmd) return { ok: false, detail: 'Not a top-up command' };
    const open = replayProposals(await ports.store.read(wallet), now()).filter((p) => p.state === 'open');
    const match = open.find((p) => {
      const rule = rules.find((r) => r.ruleId === p.ruleId);
      return rule && rule.appName.toLowerCase() === cmd.appName.toLowerCase() && p.currency === cmd.currency && p.amount === cmd.amount;
    });
    if (!match) return { ok: false, detail: 'No open top-up proposal matches that command' };
    return approve(wallet, match.proposalId, by, rules);
  }

  async function decline(wallet: string, proposalId: string, by: string): Promise<void> {
    await ports.store.append(wallet, { type: 'TopUpDeclined', at: now().toISOString(), proposalId, by });
  }

  /**
   * Charge usage to an app wallet. The quote comes from the plan, the split
   * from the contract. `chargeId` makes it idempotent: the same id never
   * charges twice. Not enough money → 402 with the quote (the caller shows
   * the top-up), and nothing is recorded.
   */
  async function charge(i: {
    wallet: string; payer: string; plan: AppUsagePlan; split: ContractSplit;
    fn: string; quantity: number; currency: Currency; chargeId: string;
  }): Promise<ChargeResult> {
    if (i.plan.contractId !== i.split.contractId) return { ok: false, status: 409, reason: 'contract-mismatch', detail: `Plan uses contract ${i.plan.contractId}, split is ${i.split.contractId}` };
    const events = await ports.store.read(i.wallet);
    const t = now();
    const quote = quoteUsage(i.plan, i.fn, i.quantity, i.currency, { events, rate: await ports.rate?.(), now: t });
    // Explicit narrowing: hosts compiling without strictNullChecks do not narrow on `ok`.
    if (!quote.ok) { const q = quote as Extract<UsageQuote, { ok: false }>; return { ok: false, status: 400, reason: q.reason, detail: q.detail }; }
    const split = splitCharge(quote.usage, i.split, i.plan.baseFee && quote.baseFee > 0 ? { amount: quote.baseFee, to: i.plan.baseFee.to } : undefined);
    if (!split.ok) return { ok: false, status: 409, reason: 'contract-split', detail: (split as Extract<typeof split, { ok: false }>).problem };
    const lines = (split as Extract<typeof split, { ok: true }>).lines;
    const postings = postingsFor(lines, i.payer, i.currency, i.chargeId, i.split.contractId);
    if (events.some((e) => e.type === 'FeeCharged' && e.chargeId === i.chargeId)) {
      return { ok: true, chargeId: i.chargeId, quote, lines, postings, duplicate: true };
    }
    const balance = balanceIn(events, i.currency);
    if (quote.total > balance) {
      return { ok: false, status: 402, reason: 'insufficient-funds', quote, balance, detail: `Needs ${quote.total}, wallet has ${balance} (${i.currency} minor units)` };
    }
    await ports.store.append(i.wallet, { type: 'UsageRecorded', at: t.toISOString(), function: i.fn, quantity: i.quantity });
    if (quote.total > 0) {
      await ports.store.append(i.wallet, { type: 'FeeCharged', at: t.toISOString(), currency: i.currency, amount: quote.total, function: i.fn, quantity: i.quantity, chargeId: i.chargeId });
    }
    return { ok: true, chargeId: i.chargeId, quote, lines, postings, duplicate: false };
  }

  /** Decide which queued tasks run now; record deferrals and resumptions. */
  async function planTasks(wallet: string, tasks: readonly PlannedTask[], reserve: Amounts = {}): Promise<BudgetPlan> {
    const events = await ports.store.read(wallet);
    const plan = planWithinBudget(tasks, replayWalletBalance(events), reserve);
    const wasDeferred = new Set(deferredTasks(events));
    const at = now().toISOString();
    for (const d of plan.deferred) if (!wasDeferred.has(d.task.id)) await ports.store.append(wallet, { type: 'TaskDeferred', at, taskId: d.task.id, reason: d.reason });
    for (const r of plan.run) if (wasDeferred.has(r.id)) await ports.store.append(wallet, { type: 'TaskResumed', at, taskId: r.id });
    return plan;
  }

  return { check, approve, approveCommand, decline, charge, planTasks };
}

export type SubscriptionAgent = ReturnType<typeof createSubscriptionAgent>;

/** In-memory store for tests and single-process hosts. */
export function memoryFundingStore(seed: Record<string, FundingEvent[]> = {}): FundingStore & { all(wallet: string): FundingEvent[] } {
  const data = new Map<string, FundingEvent[]>(Object.entries(seed).map(([k, v]) => [k, [...v]]));
  return {
    async read(w) { return [...(data.get(w) ?? [])]; },
    async append(w, e) { data.set(w, [...(data.get(w) ?? []), e]); },
    all(w) { return [...(data.get(w) ?? [])]; },
  };
}
