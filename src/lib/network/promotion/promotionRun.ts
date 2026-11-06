/**
 * Network promotion run — replayed from the run's own TXs (15.33.0).
 *
 * A promotion is one BPMN process instance. Its history is:
 *
 *   NetworkPromotionRequested   admin → instance (carries plan inputs + preflight hash)
 *   PromotionStepRequested      instance port out  (requestId, stepId)
 *   PromotionStepCompleted      reply, same requestId (evidence, ledger hashes)
 *   PromotionStepFailed         reply, same requestId (reason)
 *   ProcessInstanceCompleted    the last step completed
 *   ProcessInstanceCancelled    an admin abandoned the run (reason required)
 *
 * Status is never stored: every view below is computed from those TXs. A reply
 * whose requestId was never requested is ignored, not guessed. A failed step
 * leaves the run `stopped`; resume asks again from the first step that has not
 * completed, so completed steps are never re-run. A step still `active` long
 * after its request (the operator's browser closed mid-step) is stale: resume
 * may ask for it again, since every step handler is idempotent. A cancelled run
 * closes; it no longer blocks a new one, and its history stays.
 */

export type PromotionNetwork = 'testnet' | 'devnet' | 'mainnet';
/** Networks a promotion may write to. Devnet resets too often to rehearse on. */
export type PromotionTarget = 'testnet' | 'mainnet';
export const PROMOTION_TARGETS: readonly PromotionTarget[] = ['testnet', 'mainnet'];
/** A step with no reply this long after its request is treated as abandoned. */
export const PROMOTION_STEP_STALE_MS = 15 * 60_000;

export const PROMOTION_EVENTS = {
  Requested: 'NetworkPromotionRequested',
  PreflightRecorded: 'PromotionPreflightRecorded',
  StepRequested: 'PromotionStepRequested',
  StepCompleted: 'PromotionStepCompleted',
  StepFailed: 'PromotionStepFailed',
  ClonePromoted: 'SkillClonePromoted',
  InstanceCompleted: 'ProcessInstanceCompleted',
  InstanceCancelled: 'ProcessInstanceCancelled',
} as const;

/** One step of the promotion process, read from its BPMN task. */
export interface PromotionStepSpec {
  id: string;
  name: string;
  /** `cappz:reversible` on the task: false once the target network holds what the step wrote. */
  reversible: boolean;
  /** The step submits to the target network (preflight never runs these). */
  writesTarget: boolean;
  /** Runs once per promoted app (multi-instance); the expanded id is `<id>/<appId>`. */
  perApp?: boolean;
}

export interface PromotionTxLike {
  eventType: string;
  sourceAddress: string;
  targetAddress?: string;
  timestamp: string;
  txId?: string;
  payload?: Record<string, unknown>;
}

export type PromotionStepState = 'pending' | 'active' | 'completed' | 'failed';
export type PromotionRunState = 'requested' | 'active' | 'stopped' | 'completed' | 'cancelled';
export type RollbackState = 'clean' | 'impossible';

export interface PromotionStepView {
  id: string;
  /** The BPMN task this step runs (the id without the app, for per-app steps). */
  task: string;
  name: string;
  appId?: string;
  reversible: boolean;
  writesTarget: boolean;
  state: PromotionStepState;
  /** Requests made for this step (retries and resumes each add one). */
  attempts: number;
  requestedAt?: string;
  closedAt?: string;
  reason?: string;
  evidenceHash?: string;
  ledgerTxHashes: string[];
  /** Rolling back past this step: clean while nothing irreversible ran. */
  rollback: RollbackState;
}

export interface PromotionRunView {
  instanceAddress: string;
  requestedBy?: string;
  source?: PromotionNetwork;
  target?: PromotionTarget;
  apps: string[];
  preflightHash?: string;
  requestedAt?: string;
  closedAt?: string;
  /** Set when an admin cancelled the run. */
  cancelReason?: string;
  cancelledBy?: string;
  state: PromotionRunState;
  steps: PromotionStepView[];
  /** First step (plan order) that has not completed; null when all have. */
  resumeFrom: string | null;
  lastCompleted: string | null;
  /** First step whose completion cannot be undone. */
  irreversibleFrom: string | null;
  /** Whole run: impossible once any irreversible step was requested. */
  rollback: RollbackState;
  elapsedMs: number;
}

/** The plan with per-app steps expanded, in BPMN order. */
export function expandPromotionPlan(
  steps: readonly PromotionStepSpec[],
  apps: readonly string[],
): Array<PromotionStepSpec & { task: string; appId?: string }> {
  return steps.flatMap((s) =>
    s.perApp ? [...apps].sort().map((appId) => ({ ...s, id: `${s.id}/${appId}`, task: s.id, appId })) : [{ ...s, task: s.id }],
  );
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const mine = (tx: PromotionTxLike, at: string) => tx.sourceAddress.startsWith(at) || !!tx.targetAddress?.startsWith(at);

/** Replay one promotion instance against its plan. */
export function replayPromotionRun(
  txs: readonly PromotionTxLike[],
  instanceAddress: string,
  plan: readonly PromotionStepSpec[],
  now: number = Date.now(),
): PromotionRunView {
  const sorted = txs.filter((t) => mine(t, instanceAddress)).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const req = sorted.find((t) => t.eventType === PROMOTION_EVENTS.Requested);
  const rp = (req?.payload ?? {}) as Record<string, unknown>;
  const apps = strs(rp.apps).sort();
  const expanded = expandPromotionPlan(plan, apps);

  const view = new Map<string, PromotionStepView>();
  for (const s of expanded) {
    view.set(s.id, {
      id: s.id, task: s.task, name: s.name, appId: s.appId, reversible: s.reversible, writesTarget: s.writesTarget,
      state: 'pending', attempts: 0, ledgerTxHashes: [], rollback: 'clean',
    });
  }

  const requestStep = new Map<string, string>(); // requestId → stepId
  let lastStepEvent: string | undefined;
  let closed: { state: PromotionRunState; at: string; reason?: string; by?: string } | undefined;

  for (const tx of sorted) {
    const p = (tx.payload ?? {}) as Record<string, unknown>;
    if (tx.eventType === PROMOTION_EVENTS.StepRequested) {
      const stepId = str(p.stepId);
      const requestId = str(p.requestId);
      const step = stepId ? view.get(stepId) : undefined;
      if (!step || !requestId) continue;
      requestStep.set(requestId, step.id);
      step.state = 'active';
      step.attempts += 1;
      step.requestedAt = tx.timestamp;
      step.closedAt = undefined;
      step.reason = undefined;
      lastStepEvent = tx.eventType;
    } else if (tx.eventType === PROMOTION_EVENTS.StepCompleted || tx.eventType === PROMOTION_EVENTS.StepFailed) {
      const requestId = str(p.requestId);
      const stepId = requestId ? requestStep.get(requestId) : undefined;
      const step = stepId ? view.get(stepId) : undefined;
      if (!step || step.state !== 'active') continue;
      step.state = tx.eventType === PROMOTION_EVENTS.StepCompleted ? 'completed' : 'failed';
      step.closedAt = tx.timestamp;
      step.reason = str(p.reason) ?? str(p.detail);
      step.evidenceHash = str(p.evidenceHash);
      step.ledgerTxHashes = strs(p.ledgerTxHashes);
      lastStepEvent = tx.eventType;
    } else if (tx.eventType === PROMOTION_EVENTS.InstanceCompleted && tx.sourceAddress === instanceAddress) {
      closed = { state: 'completed', at: tx.timestamp };
    } else if (tx.eventType === PROMOTION_EVENTS.InstanceCancelled && tx.sourceAddress === instanceAddress) {
      closed = { state: 'cancelled', at: tx.timestamp, reason: str(p.reason), by: str(p.cancelledBy) };
    }
  }

  const steps = expanded.map((s) => view.get(s.id)!);
  const irreversibleIdx = steps.findIndex((s) => !s.reversible);
  const irreversibleTouched = steps.some((s) => !s.reversible && s.attempts > 0);
  for (const [i, s] of steps.entries()) {
    s.rollback = irreversibleIdx >= 0 && i >= irreversibleIdx ? 'impossible' : 'clean';
  }

  const firstOpen = steps.find((s) => s.state !== 'completed');
  const completed = steps.filter((s) => s.state === 'completed');
  const state: PromotionRunState = closed?.state
    ?? (lastStepEvent === PROMOTION_EVENTS.StepFailed ? 'stopped'
      : lastStepEvent ? 'active'
        : 'requested');
  const start = req ? Date.parse(req.timestamp) : NaN;
  const end = closed ? Date.parse(closed.at) : now;

  return {
    instanceAddress,
    requestedBy: str(rp.requestedBy),
    source: str(rp.source) as PromotionNetwork | undefined,
    target: str(rp.target) as PromotionTarget | undefined,
    apps,
    preflightHash: str(rp.preflightHash),
    requestedAt: req?.timestamp,
    closedAt: closed?.at,
    cancelReason: closed?.reason,
    cancelledBy: closed?.by,
    state,
    steps,
    resumeFrom: firstOpen?.id ?? null,
    lastCompleted: completed.length ? completed[completed.length - 1].id : null,
    irreversibleFrom: irreversibleIdx >= 0 ? steps[irreversibleIdx].id : null,
    rollback: irreversibleTouched ? 'impossible' : 'clean',
    elapsedMs: Number.isFinite(start) ? Math.max(0, end - start) : 0,
  };
}

/** Steps still to run, in order, from the resume point (completed steps are skipped). */
export function stepsToRun(run: PromotionRunView): PromotionStepView[] {
  if (run.state === 'completed' || run.state === 'cancelled') return [];
  return run.steps.filter((s) => s.state !== 'completed');
}

/** The active step whose request has had no reply for longer than `staleAfterMs`, if any. */
export function staleStep(run: PromotionRunView, now: number = Date.now(), staleAfterMs = PROMOTION_STEP_STALE_MS): PromotionStepView | null {
  const s = run.steps.find((x) => x.state === 'active');
  if (!s?.requestedAt) return null;
  return now - Date.parse(s.requestedAt) > staleAfterMs ? s : null;
}

/** Why a resume would be refused, or null when it may proceed. */
export function resumeRefusal(run: PromotionRunView, now: number = Date.now(), staleAfterMs = PROMOTION_STEP_STALE_MS): string | null {
  if (!run.requestedAt) return 'No such promotion run.';
  if (run.state === 'completed') return 'The run already completed.';
  if (run.state === 'cancelled') return 'The run was cancelled.';
  if (run.state === 'active' && !staleStep(run, now, staleAfterMs)) return 'A step is still running; wait for its reply (or cancel the run).';
  return null;
}

/** Why a cancel would be refused, or null. Any open run may be cancelled, with a reason. */
export function cancelRefusal(run: PromotionRunView, reason: string): string | null {
  if (!run.requestedAt) return 'No such promotion run.';
  if (run.state === 'completed') return 'The run already completed; there is nothing to cancel.';
  if (run.state === 'cancelled') return 'The run is already cancelled.';
  if (!reason.trim()) return 'Give a reason: it stays in the run\'s history.';
  return null;
}
