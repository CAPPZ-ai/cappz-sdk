/**
 * COPE node crystallized.
 * Node ID: v14-16-01-test-run-proof
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Test runs are first-class wallets. A suite run lives at
 * <suiteAddress>/runs/<n>' and emits:
 *   TestRunInitiated                    run → suite context + code version hash
 *   TestRunSucceeded|TestRunFailed|TestRunPartiallyFailed   exactly one outcome
 *   TestRunLogged                       run → failing Test address, per failure
 * Suites are wallet accounts that include their tests via ConstituentIncluded
 * (suite → test). Run state is derived by replay (AP-12), never a stored flag.
 * Pure planning/resolution — the build BPMN emits the TXs.
 */
import { repozCodeRoot } from './paths';

export type TestRunOutcome = 'TestRunSucceeded' | 'TestRunFailed' | 'TestRunPartiallyFailed';

export interface TestRunTx {
  eventType: 'TestRunInitiated' | TestRunOutcome | 'TestRunLogged';
  sourceAddress: string;
  targetAddress: string;
  correlationId: string;
  payload: { suiteAddress?: string; codeHeadTxId?: string; detail?: string; backfill?: boolean };
}

export interface SuiteTx {
  eventType: 'ConstituentIncluded' | 'ConstituentExcluded';
  sourceAddress: string; // suite address
  targetAddress: string; // test address
  correlationId: string;
}

export function testAddress(appRoot: string, testPath: string): string {
  return `${repozCodeRoot(appRoot)}/${testPath.split('/').map(encodeURIComponent).join('/')}`;
}

export function testRunAddress(suiteAddress: string, runIndex: number): string {
  return `${suiteAddress}/runs/${runIndex}'`;
}

/** Latest-wins suite membership: a test is in the suite if its last inclusion edge is ConstituentIncluded. */
export function resolveSuiteTests(suiteAddress: string, txs: SuiteTx[]): string[] {
  const member = new Map<string, boolean>();
  for (const t of txs) {
    if (t.sourceAddress !== suiteAddress) continue;
    member.set(t.targetAddress, t.eventType === 'ConstituentIncluded');
  }
  return [...member.entries()].filter(([, v]) => v).map(([k]) => k).sort();
}

export interface TestRunState {
  initiated: boolean;
  outcome?: TestRunOutcome;
  codeHeadTxId?: string;
  /** Test addresses with logged failures. */
  failures: string[];
}

/** Replay one run's TXs into its state (AP-12: no stored flags). */
export function resolveTestRunState(runAddress: string, txs: TestRunTx[]): TestRunState {
  const mine = txs.filter((t) => t.sourceAddress === runAddress || t.correlationId === runAddress);
  const init = mine.find((t) => t.eventType === 'TestRunInitiated');
  const out = [...mine].reverse().find((t) => t.eventType !== 'TestRunInitiated' && t.eventType !== 'TestRunLogged');
  const failures = mine.filter((t) => t.eventType === 'TestRunLogged').map((t) => t.targetAddress);
  return {
    initiated: !!init,
    outcome: out?.eventType as TestRunOutcome | undefined,
    codeHeadTxId: init?.payload.codeHeadTxId,
    failures: [...new Set(failures)].sort(),
  };
}

/** Plan one full run record: initiated, one outcome, and one TestRunLogged per failure. */
export function planTestRunTxs(
  suiteAddress: string,
  runIndex: number,
  codeHeadTxId: string,
  failures: { testAddress: string; detail: string }[] = [],
  backfill = false,
): TestRunTx[] {
  const run = testRunAddress(suiteAddress, runIndex);
  const correlationId = run;
  const base = { correlationId, payload: { suiteAddress, codeHeadTxId, ...(backfill ? { backfill: true } : {}) } };
  const txs: TestRunTx[] = [
    { eventType: 'TestRunInitiated', sourceAddress: run, targetAddress: suiteAddress, ...base },
  ];
  const outcome: TestRunOutcome = failures.length === 0 ? 'TestRunSucceeded' : 'TestRunFailed';
  txs.push({ eventType: outcome, sourceAddress: run, targetAddress: suiteAddress, ...base });
  for (const f of failures) {
    txs.push({ eventType: 'TestRunLogged', sourceAddress: run, targetAddress: f.testAddress, correlationId, payload: { ...base.payload, detail: f.detail } });
  }
  return txs;
}

/**
 * Proof gate: does a suite covering `testAddresses` have a run that succeeded
 * at or after `codeHeadTxId`? TX order is the replay order, so "at or after"
 * means the run's initiating TX appears no earlier than the head TX.
 */
export function resolveTestProof(
  suiteAddress: string,
  testAddresses: string[],
  runTxs: TestRunTx[],
  suiteTxs: SuiteTx[],
  codeHeadTxId: string,
  txOrder: string[],
): { proven: boolean; runAddress?: string; missingTests: string[]; failedTests: string[] } {
  const members = resolveSuiteTests(suiteAddress, suiteTxs);
  const missingTests = testAddresses.filter((t) => !members.includes(t));
  const headPos = txOrder.indexOf(codeHeadTxId);
  const runs = [...new Set(runTxs.filter((t) => t.payload.suiteAddress === suiteAddress).map((t) => t.correlationId))].sort();
  let best: string | undefined;
  const failedTests = new Set<string>();
  for (const run of runs) {
    const s = resolveTestRunState(run, runTxs);
    if (!s.initiated || !s.outcome) continue;
    const initTx = runTxs.find((t) => t.correlationId === run && t.eventType === 'TestRunInitiated')!;
    const runPos = txOrder.indexOf(`${run}:TestRunInitiated`) >= 0 ? txOrder.indexOf(`${run}:TestRunInitiated`) : txOrder.indexOf(initTx.correlationId);
    if (headPos >= 0 && runPos >= 0 && runPos < headPos) continue; // ran before this code head
    if (s.outcome === 'TestRunSucceeded') best = run;
    else s.failures.forEach((f) => failedTests.add(f));
  }
  return { proven: missingTests.length === 0 && !!best, runAddress: best, missingTests, failedTests: [...failedTests].sort() };
}
