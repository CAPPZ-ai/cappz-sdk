/**
 * Preflight evidence — what lets a promotion start (15.33.0).
 *
 * Preflight runs every check and writes nothing on the target network. Its
 * result is hashed together with everything it depended on: the network pair,
 * the apps, the operator's session and the check outcomes. Start cites the
 * hash; the verifier recomputes it and refuses when anything moved — another
 * session, other apps, a network switch since the checks ran, or age. There is
 * no "gate passed" flag to forget to reset.
 */
import { canonicalJson, sha256HexOf } from '../../identity/canonical';
import type { PromotionNetwork, PromotionTarget } from './promotionRun';
import { checksPassed, type PromotionCheckResult } from './promotionChecks';

export const PREFLIGHT_MAX_AGE_MS = 30 * 60_000;

export interface PreflightEvidence {
  kind: 'network-promotion-preflight';
  source: PromotionNetwork;
  target: PromotionTarget;
  apps: string[];
  sessionId: string;
  checkedAt: string;
  checks: Array<Pick<PromotionCheckResult, 'id' | 'status' | 'evidenceHash'>>;
  passed: boolean;
}

export function buildPreflightEvidence(p: {
  source: PromotionNetwork;
  target: PromotionTarget;
  apps: readonly string[];
  sessionId: string;
  checkedAt: string;
  results: readonly PromotionCheckResult[];
}): PreflightEvidence {
  return {
    kind: 'network-promotion-preflight',
    source: p.source,
    target: p.target,
    apps: [...p.apps].sort(),
    sessionId: p.sessionId,
    checkedAt: p.checkedAt,
    checks: p.results.map((r) => ({ id: r.id, status: r.status, ...(r.evidenceHash ? { evidenceHash: r.evidenceHash } : {}) })),
    passed: checksPassed(p.results),
  };
}

export function preflightHash(e: PreflightEvidence): Promise<string> {
  return sha256HexOf(canonicalJson(e));
}

export type StartVerdict = { ok: true } | { ok: false; reason: string };

/** May a promotion start on this evidence? Every refusal names its reason. */
export async function verifyPreflightForStart(p: {
  evidence: PreflightEvidence | null | undefined;
  citedHash: string | undefined;
  sessionId: string;
  source: PromotionNetwork;
  target: PromotionTarget;
  apps: readonly string[];
  /** When the operator last switched network (any switch resets the gate). */
  networkSwitchedAt?: string;
  now?: number;
  maxAgeMs?: number;
}): Promise<StartVerdict> {
  const e = p.evidence;
  if (!e || !p.citedHash) return { ok: false, reason: 'Run preflight first: start needs a passing preflight from this session.' };
  if ((await preflightHash(e)) !== p.citedHash) return { ok: false, reason: 'The preflight evidence does not match the cited hash.' };
  if (!e.passed) return { ok: false, reason: 'The preflight did not pass.' };
  if (e.sessionId !== p.sessionId) return { ok: false, reason: 'The preflight ran in another session; run it again here.' };
  if (e.source !== p.source || e.target !== p.target) return { ok: false, reason: `The preflight checked ${e.source} → ${e.target}, not ${p.source} → ${p.target}.` };
  const apps = [...p.apps].sort();
  if (canonicalJson(apps) !== canonicalJson(e.apps)) return { ok: false, reason: 'The preflight checked a different set of apps.' };
  const checkedAt = Date.parse(e.checkedAt);
  if (!Number.isFinite(checkedAt)) return { ok: false, reason: 'The preflight has no valid time.' };
  if (p.networkSwitchedAt && Date.parse(p.networkSwitchedAt) >= checkedAt) return { ok: false, reason: 'The network was switched after the preflight; run it again.' };
  if ((p.now ?? Date.now()) - checkedAt > (p.maxAgeMs ?? PREFLIGHT_MAX_AGE_MS)) return { ok: false, reason: 'The preflight is too old; run it again.' };
  return { ok: true };
}

/** The phrase an operator types to confirm the irreversible step of one run. */
export function irreversibleConfirmation(target: PromotionTarget, preflight: string): string {
  return `promote to ${target} ${preflight.slice(0, 8)}`;
}
