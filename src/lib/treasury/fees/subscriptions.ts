/**
 * COPE node crystallized.
 * Node ID: v14-05-00-subscriptions
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Subscriptions: SubscriptionStarted / SubscriptionCancelled TXs at the
 * user's account root, replayed newest-wins per plan (AP-12). Monthly
 * totals come from the platform subscription and the effective price sheets.
 */
import { PLATFORM_SUBSCRIPTION, resolvePriceSheet, type PriceSheet } from './priceSheet';
import { GENESIS_PRICE_SHEETS, NOTARIZER_APP_ROOT, REPLICATOR_APP_ROOT } from './defaultPriceSheets';

export type PlanId = 'platform' | 'notarizer' | 'replicator';
export type PlanTier = 'retail' | 'enterprise';

export interface SubscriptionEvent {
  type: 'SubscriptionStarted' | 'SubscriptionCancelled';
  plan: PlanId;
  tier: PlanTier;
  timestamp: string;
}

/** Notarizer is usage-priced; its app subscription is $5 retail / $20 enterprise per the v14-02-00 plan. */
export const NOTARIZER_APP_SUBSCRIPTION = { retailCents: 500, enterpriseCents: 2000 } as const;

export function planMonthlyCents(plan: PlanId, tier: PlanTier, sheets: PriceSheet[] = GENESIS_PRICE_SHEETS, at = new Date()): number {
  if (plan === 'platform') return tier === 'enterprise' ? PLATFORM_SUBSCRIPTION.enterpriseCents : PLATFORM_SUBSCRIPTION.retailCents;
  if (plan === 'notarizer') return tier === 'enterprise' ? NOTARIZER_APP_SUBSCRIPTION.enterpriseCents : NOTARIZER_APP_SUBSCRIPTION.retailCents;
  const sheet = resolvePriceSheet(sheets.filter((s) => s.appRoot === REPLICATOR_APP_ROOT), at);
  const e = sheet?.entries.find((x) => x.function === 'app-subscription');
  return e ? (tier === 'enterprise' ? e.enterpriseCents : e.retailCents) : 0;
}

export function monthlyTotalCents(plans: PlanId[], tier: PlanTier): number {
  return plans.reduce((sum, p) => sum + planMonthlyCents(p, tier), 0);
}

/** Active plans: newest Started/Cancelled per plan wins. */
export function resolveActiveSubscriptions(events: SubscriptionEvent[]): Array<{ plan: PlanId; tier: PlanTier; since: string }> {
  const latest = new Map<PlanId, SubscriptionEvent>();
  for (const e of [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) latest.set(e.plan, e);
  return [...latest.values()]
    .filter((e) => e.type === 'SubscriptionStarted')
    .map((e) => ({ plan: e.plan, tier: e.tier, since: e.timestamp }));
}

/** App subscriptions need the platform subscription. */
export function validatePlanSelection(plans: PlanId[]): string | null {
  if (plans.length === 0) return 'Choose at least one plan';
  if (!plans.includes('platform')) return 'App subscriptions include the platform subscription';
  return null;
}

export const PLAN_LABEL: Record<PlanId, string> = {
  platform: 'Platform (support & maintenance)',
  notarizer: 'cappz Notarizer Agent',
  replicator: 'cappz Replicator Agent',
};

export const PLAN_APP_ROOT: Record<PlanId, string | null> = {
  platform: null,
  notarizer: NOTARIZER_APP_ROOT,
  replicator: REPLICATOR_APP_ROOT,
};
