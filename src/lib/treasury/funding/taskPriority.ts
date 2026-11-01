/**
 * COPE node crystallized. Node ID: v15-20-01-task-priority
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * When an app wallet cannot pay for everything queued, run what matters
 * first. Critical tasks are funded first and may use the reserve; normal and
 * deferrable tasks run only from money above the reserve. Within a level,
 * the earliest due runs first, then the cheapest (so more work gets done).
 * What does not fit is deferred with a reason, never dropped.
 */
import type { Currency } from './money.ts';

export type Criticality = 'critical' | 'normal' | 'deferrable';
const RANK: Record<Criticality, number> = { critical: 0, normal: 1, deferrable: 2 };

export interface PlannedTask {
  id: string;
  criticality: Criticality;
  currency: Currency;
  /** Estimated cost, minor units (from quoteUsage). */
  cost: number;
  dueAt?: string;
}

export interface BudgetPlan {
  run: PlannedTask[];
  deferred: Array<{ task: PlannedTask; reason: string }>;
  /** Extra money (per currency) that would let every critical task run. */
  criticalShortfall: Partial<Record<Currency, number>>;
  /** Extra money that would let everything run. */
  totalShortfall: Partial<Record<Currency, number>>;
}

export function planWithinBudget(
  tasks: readonly PlannedTask[],
  balances: Partial<Record<Currency, number>>,
  reserve: Partial<Record<Currency, number>> = {},
): BudgetPlan {
  const order = [...tasks].sort((a, b) =>
    RANK[a.criticality] - RANK[b.criticality]
    || (a.dueAt ?? '￿').localeCompare(b.dueAt ?? '￿')
    || a.cost - b.cost);
  const left: Partial<Record<Currency, number>> = { ...balances };
  const run: PlannedTask[] = [];
  const deferred: BudgetPlan['deferred'] = [];
  const criticalShortfall: BudgetPlan['criticalShortfall'] = {};
  const totalShortfall: BudgetPlan['totalShortfall'] = {};
  for (const t of order) {
    const have = left[t.currency] ?? 0;
    const floor = t.criticality === 'critical' ? 0 : reserve[t.currency] ?? 0;
    if (have - t.cost >= floor) {
      left[t.currency] = have - t.cost;
      run.push(t);
      continue;
    }
    deferred.push({ task: t, reason: t.criticality === 'critical' ? 'insufficient funds for a critical task' : 'insufficient funds above the reserve' });
  }
  if (deferred.length > 0) {
    // Exact shortfalls: criticals need their total; everything else must also leave the reserve intact.
    const currencies = new Set(tasks.map((t) => t.currency));
    for (const c of currencies) {
      const mine = tasks.filter((t) => t.currency === c);
      const bal = balances[c] ?? 0;
      const crit = mine.filter((t) => t.criticality === 'critical').reduce((s, t) => s + t.cost, 0);
      const all = mine.reduce((s, t) => s + t.cost, 0) + (mine.some((t) => t.criticality !== 'critical') ? reserve[c] ?? 0 : 0);
      if (crit > bal) criticalShortfall[c] = crit - bal;
      if (all > bal && deferred.some((d) => d.task.currency === c)) totalShortfall[c] = all - bal;
    }
  }
  return { run, deferred, criticalShortfall, totalShortfall };
}
