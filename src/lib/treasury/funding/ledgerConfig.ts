/**
 * COPE node crystallized. Node ID: v15-23-01-funding-ledger-config
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * Configuration that lives on the ledger, replayed newest-wins (AP-12):
 *   FundingRuleSet / FundingRuleRemoved   a person's top-up rules, at their
 *                                         account, so every device sees the same rules.
 *   UsagePlanPublished                    an app owner's plan, at the app's root.
 *   PriceAcknowledged / PriceSet          the owner's decisions on proposed prices.
 * And the bridge from a published price sheet to a usage plan.
 */
import type { PriceSheet } from '../fees/priceSheet.ts';
import type { FundingRule } from './fundingPolicy.ts';
import type { Currency } from './money.ts';
import { applyOwnerDecisions, type AppUsagePlan, type OwnerPriceDecision } from './usagePlan.ts';

export type FundingConfigEvent =
  | { type: 'FundingRuleSet'; at: string; rule: FundingRule & Record<string, unknown> }
  | { type: 'FundingRuleRemoved'; at: string; ruleId: string }
  | { type: 'UsagePlanPublished'; at: string; plan: AppUsagePlan }
  | OwnerPriceDecision;

export const FUNDING_CONFIG_EVENT_TYPES = ['FundingRuleSet', 'FundingRuleRemoved', 'UsagePlanPublished', 'PriceAcknowledged', 'PriceSet'] as const;

/** Current rules: the newest FundingRuleSet per id, unless a later FundingRuleRemoved. */
export function replayFundingRules<R extends FundingRule = FundingRule>(events: readonly FundingConfigEvent[]): R[] {
  const latest = new Map<string, { at: string; rule: R | null }>();
  for (const e of [...events].sort((a, b) => a.at.localeCompare(b.at))) {
    if (e.type === 'FundingRuleSet') latest.set(e.rule.ruleId, { at: e.at, rule: e.rule as unknown as R });
    else if (e.type === 'FundingRuleRemoved') latest.set(e.ruleId, { at: e.at, rule: null });
  }
  return [...latest.values()].map((v) => v.rule).filter((r): r is R => r !== null);
}

/** The app's current plan: the newest UsagePlanPublished, with the owner's later price decisions applied. */
export function resolvePublishedPlan(events: readonly FundingConfigEvent[]): AppUsagePlan | null {
  const sorted = [...events].sort((a, b) => a.at.localeCompare(b.at));
  let plan: AppUsagePlan | null = null;
  let publishedAt = '';
  for (const e of sorted) if (e.type === 'UsagePlanPublished') { plan = e.plan; publishedAt = e.at; }
  if (!plan) return null;
  // A decision before the plan was published was about an older plan; only later ones apply.
  const decisions = sorted.filter((e): e is OwnerPriceDecision => (e.type === 'PriceAcknowledged' || e.type === 'PriceSet') && e.at >= publishedAt);
  return { ...plan, prices: applyOwnerDecisions(plan.prices, decisions) };
}

/**
 * A usage plan from a published price sheet. Sheet prices were set by the
 * owner (their sheet), so they count as owner-set. USD only — a sheet has no XRP prices.
 */
export function planFromPriceSheet(sheet: PriceSheet, p: {
  tenant: string; contractId: string; mode: AppUsagePlan['mode']; tier?: 'retail' | 'enterprise';
  accepts?: Currency[]; baseFee?: AppUsagePlan['baseFee']; subscription?: AppUsagePlan['subscription']; xrpl?: AppUsagePlan['xrpl'];
}): AppUsagePlan {
  const tier = p.tier ?? 'retail';
  return {
    appRoot: sheet.appRoot,
    tenant: p.tenant,
    contractId: p.contractId,
    mode: p.mode,
    accepts: p.accepts ?? ['USD'],
    prices: sheet.entries.map((e) => ({
      useCase: e.useCase, function: e.function, process: e.process, unit: e.unit,
      perUnit: { USD: tier === 'enterprise' ? e.enterpriseCents : e.retailCents },
      ...(e.minimumCents > 0 ? { minimum: { USD: e.minimumCents } } : {}),
      validation: 'owner-set' as const,
    })),
    ...(p.baseFee ? { baseFee: p.baseFee } : {}),
    ...(p.subscription ? { subscription: p.subscription } : {}),
    ...(p.xrpl ? { xrpl: p.xrpl } : {}),
  };
}
