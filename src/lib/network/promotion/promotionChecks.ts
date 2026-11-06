/**
 * Promotion checks — what each promotable app adds to the one promotion
 * process (15.33.0). An app declares checks and, optionally, flow steps; it
 * never brings its own pipeline.
 *
 * A check reads; it never writes to the target network. Its outcome is a
 * lifecycle state, not a boolean: `unknown` (could not tell) is not `passed`,
 * and a thrown error becomes `unknown` with the error as the reason.
 */
import type { PromotionNetwork, PromotionTarget } from './promotionRun';

export type PromotionCheckStatus = 'passed' | 'failed' | 'unknown' | 'skipped';

export interface PromotionCheckContext {
  source: PromotionNetwork;
  target: PromotionTarget;
  apps: readonly string[];
  /** Read-only ledger/wallet access the host provides (opaque to the SDK). */
  read?: Record<string, unknown>;
}

export interface PromotionCheckOutcome {
  status: PromotionCheckStatus;
  reason: string;
  /** Hash of what the check looked at, so a later step can prove it saw the same thing. */
  evidenceHash?: string;
}

export interface PromotionCheck<C extends PromotionCheckContext = PromotionCheckContext> {
  id: string;
  label: string;
  /** Undefined: a platform check that runs for every promotion. */
  appId?: string;
  /** A critical check must pass; `unknown` on it blocks the promotion. */
  critical: boolean;
  governingPrinciple: string;
  run(ctx: C): Promise<PromotionCheckOutcome>;
}

export interface PromotionCheckResult extends PromotionCheckOutcome {
  id: string;
  label: string;
  appId?: string;
  critical: boolean;
}

export interface PromotionStepOutcome {
  detail: string;
  evidenceHash?: string;
  ledgerTxHashes?: string[];
}

/**
 * A step the app contributes to the flow-configuration phase (e.g. a donation
 * flow). It runs after the mirror, so it may write to the target; it must be
 * idempotent (a resume runs it again) and throw to fail the step.
 */
export interface PromotableFlowStep<C extends PromotionCheckContext = PromotionCheckContext> {
  id: string;
  label: string;
  governingPrinciple: string;
  run(ctx: C): Promise<PromotionStepOutcome>;
}

export interface PromotableApp<C extends PromotionCheckContext = PromotionCheckContext> {
  appId: string;
  label: string;
  /** The skill this app's clone runs (announced by SkillClonePromoted). */
  skillAddress: string;
  checks: readonly PromotionCheck<C>[];
  flowSteps?: readonly PromotableFlowStep<C>[];
}

const PLATFORM_CHECKS = new Map<string, PromotionCheck<any>>();
const APPS = new Map<string, PromotableApp<any>>();

export function registerPlatformCheck<C extends PromotionCheckContext>(check: PromotionCheck<C>): void {
  if (check.appId) throw new Error(`Platform check ${check.id} must not name an app.`);
  PLATFORM_CHECKS.set(check.id, check);
}

export function registerPromotableApp<C extends PromotionCheckContext>(app: PromotableApp<C>): void {
  for (const c of app.checks) {
    if (c.appId !== app.appId) throw new Error(`Check ${c.id} belongs to ${c.appId ?? 'the platform'}, not ${app.appId}.`);
  }
  APPS.set(app.appId, app);
}

export function promotableApps(): PromotableApp[] {
  return [...APPS.values()].sort((a, b) => a.appId.localeCompare(b.appId));
}

export function promotableApp(appId: string): PromotableApp | undefined {
  return APPS.get(appId);
}

/** Platform checks first, then each app's checks (apps sorted). Unknown apps throw. */
export function checksFor(apps: readonly string[]): PromotionCheck[] {
  const out: PromotionCheck[] = [...PLATFORM_CHECKS.values()];
  for (const appId of [...apps].sort()) {
    const app = APPS.get(appId);
    if (!app) throw new Error(`${appId} has not declared itself promotable.`);
    out.push(...app.checks);
  }
  return out;
}

/** Run every check; never throws. */
export async function runPromotionChecks<C extends PromotionCheckContext>(
  checks: readonly PromotionCheck<C>[],
  ctx: C,
): Promise<PromotionCheckResult[]> {
  const results: PromotionCheckResult[] = [];
  for (const c of checks) {
    let outcome: PromotionCheckOutcome;
    try {
      outcome = await c.run(ctx);
    } catch (e) {
      outcome = { status: 'unknown', reason: e instanceof Error ? e.message : String(e) };
    }
    results.push({ id: c.id, label: c.label, appId: c.appId, critical: c.critical, ...outcome });
  }
  return results;
}

/** Passes only when nothing failed and every critical check passed. */
export function checksPassed(results: readonly PromotionCheckResult[]): boolean {
  return results.length > 0
    && !results.some((r) => r.status === 'failed')
    && results.filter((r) => r.critical).every((r) => r.status === 'passed');
}

export function blockingChecks(results: readonly PromotionCheckResult[]): PromotionCheckResult[] {
  return results.filter((r) => r.status === 'failed' || (r.critical && r.status !== 'passed'));
}

/** Test helper: forget every registration. */
export function resetPromotionRegistry(): void {
  PLATFORM_CHECKS.clear();
  APPS.clear();
}
