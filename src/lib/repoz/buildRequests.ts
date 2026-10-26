/**
 * COPE node crystallized.
 * Node ID: v14-16-00-build-requests
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Request → decision between build-log tasks and builds.
 *   task  ──BuildRequested──▶ build version (or vNext)      (requester → arbiter)
 *   build ──ConstituentIncluded──▶ task  (same correlationId)  (arbiter → requester)
 * The task never states its own inclusion; only the build decides.
 * Pure planning/resolution — the build BPMN emits the TXs.
 */
import type { HDNode } from '../wallets/hd-engine';
import { repozBuildRoot } from './paths';

export const VNEXT = 'vNext';
export const BUILD_LOG_TASK_ROOT = "m/44'/144'/41'/0'";

export interface BuildLogTask {
  taskAddress: string;
  label: string;
  targetVersion: string;
  /** Build accepted it (shipped/complete). */
  accepted: boolean;
}

export interface BuildRequestTx {
  eventType: 'BuildRequested' | 'ConstituentIncluded';
  sourceAddress: string;
  targetAddress: string;
  correlationId: string;
  payload: { taskLabel: string; targetVersion: string; backfill?: boolean };
}

export type TaskBuildState = 'requested' | 'included' | 'vnext' | 'unrequested';

const VERSION_RE = /^v\d+(?:[.-]\d+)*(?:[.-][a-z0-9]+)?$/i;

export function resolveTaskTargetVersion(node: HDNode): string | null {
  const meta = (node.metadata ?? {}) as Record<string, unknown>;
  if (typeof meta.targetVersion === 'string' && meta.targetVersion) return meta.targetVersion;
  const tags = Array.isArray(meta.tags) ? (meta.tags as unknown[]) : [];
  const tag = tags.find((t): t is string => typeof t === 'string' && VERSION_RE.test(t));
  if (tag) return tag;
  const m = node.label.match(/^(v\d+(?:[.-]\d+)*)/i);
  return m ? m[1] : null;
}

const ACCEPTED = new Set(['shipped', 'complete', 'completed', 'done', 'released']);

/** Walk the Version Milestones branch; each milestone and each child item is a task. */
export function collectBuildLogTasks(milestones: HDNode[], root = BUILD_LOG_TASK_ROOT): BuildLogTask[] {
  const out: BuildLogTask[] = [];
  for (const m of milestones) {
    const mAddr = `${root}/${m.index}'`;
    const mVersion = resolveTaskTargetVersion(m);
    const mStatus = String(m.metadata?.status ?? '').toLowerCase();
    out.push({ taskAddress: mAddr, label: m.label, targetVersion: mVersion ?? VNEXT, accepted: !!mVersion && ACCEPTED.has(mStatus) });
    for (const c of m.children ?? []) {
      const cStatus = String(c.metadata?.status ?? mStatus).toLowerCase();
      const v = resolveTaskTargetVersion(c) ?? mVersion;
      out.push({ taskAddress: `${mAddr}/${c.index}'`, label: c.label, targetVersion: v ?? VNEXT, accepted: !!v && ACCEPTED.has(cStatus) });
    }
  }
  return out;
}

export function buildVersionAddress(appRoot: string, version: string): string {
  return repozBuildRoot(appRoot, version);
}

/**
 * Additive backfill: one BuildRequested per task, plus the build's ConstituentIncluded when accepted.
 * v14-16-01: a task may request only with test proof — pass `provenTaskAddresses`
 * (from resolveTestProof); tasks not in the set are skipped and reported.
 */
export function planBuildRequestTxs(
  tasks: BuildLogTask[],
  appRoot: string,
  backfill = false,
  provenTaskAddresses?: Set<string>,
): BuildRequestTx[] {
  const txs: BuildRequestTx[] = [];
  for (const t of tasks) {
    if (provenTaskAddresses && !provenTaskAddresses.has(t.taskAddress)) continue;
    const build = buildVersionAddress(appRoot, t.targetVersion);
    const correlationId = `build-request:${t.taskAddress}:${t.targetVersion}`;
    const payload = { taskLabel: t.label, targetVersion: t.targetVersion, ...(backfill ? { backfill: true } : {}) };
    txs.push({ eventType: 'BuildRequested', sourceAddress: t.taskAddress, targetAddress: build, correlationId, payload });
    if (t.accepted && t.targetVersion !== VNEXT) {
      txs.push({ eventType: 'ConstituentIncluded', sourceAddress: build, targetAddress: t.taskAddress, correlationId, payload });
    }
  }
  return txs;
}

/** Replay: direction matters — inclusion counts only if sent by the requested build to the task. */
export function resolveTaskBuildState(taskAddress: string, txs: BuildRequestTx[]): { state: TaskBuildState; targetVersion?: string } {
  const req = [...txs].reverse().find((t) => t.eventType === 'BuildRequested' && t.sourceAddress === taskAddress);
  if (!req) return { state: 'unrequested' };
  const inc = txs.find((t) => t.eventType === 'ConstituentIncluded' && t.correlationId === req.correlationId && t.sourceAddress === req.targetAddress && t.targetAddress === taskAddress);
  if (inc) return { state: 'included', targetVersion: req.payload.targetVersion };
  return { state: req.payload.targetVersion === VNEXT ? 'vnext' : 'requested', targetVersion: req.payload.targetVersion };
}

/** Release guard: every task requested; every accepted task included by its build; every requested task test-proven. */
export function checkBuildRequestCoverage(
  tasks: BuildLogTask[],
  txs: BuildRequestTx[],
  provenTaskAddresses?: Set<string>,
): { ok: boolean; unrequested: string[]; missingInclusion: string[]; unproven: string[] } {
  const unrequested: string[] = [];
  const missingInclusion: string[] = [];
  const unproven: string[] = [];
  for (const t of tasks) {
    const s = resolveTaskBuildState(t.taskAddress, txs).state;
    if (s === 'unrequested') unrequested.push(t.label);
    else if (t.accepted && s !== 'included') missingInclusion.push(t.label);
    if (provenTaskAddresses && s !== 'unrequested' && !provenTaskAddresses.has(t.taskAddress)) unproven.push(t.label);
  }
  return { ok: unrequested.length === 0 && missingInclusion.length === 0 && unproven.length === 0, unrequested, missingInclusion, unproven };
}
