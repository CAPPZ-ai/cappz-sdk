import { describe, expect, it } from 'vitest';
import { planTestRunTxs, resolveSuiteTests, resolveTestProof, resolveTestRunState, testAddress, testRunAddress } from '../lib/repoz/testRuns';
import { planGitHubImport } from '../lib/repoz/codeManifest';
import { checkBuildRequestCoverage, planBuildRequestTxs } from '../lib/repoz/buildRequests';

const APP = "m/44'/144'/0'/cappz";
const SUITE = `${APP}/repoz/suites/unit`;
const T1 = testAddress(APP, 'src/test/a.test.ts');
const T2 = testAddress(APP, 'src/test/b.test.ts');

describe('test runs as wallets', () => {
  const suiteTxs = [
    { eventType: 'ConstituentIncluded' as const, sourceAddress: SUITE, targetAddress: T1, correlationId: 's1' },
    { eventType: 'ConstituentIncluded' as const, sourceAddress: SUITE, targetAddress: T2, correlationId: 's2' },
  ];

  it('suite membership is composed by ConstituentIncluded, latest-wins on exclusion', () => {
    expect(resolveSuiteTests(SUITE, suiteTxs)).toEqual([T1, T2]);
    const ex = [...suiteTxs, { eventType: 'ConstituentExcluded' as const, sourceAddress: SUITE, targetAddress: T2, correlationId: 's3' }];
    expect(resolveSuiteTests(SUITE, ex)).toEqual([T1]);
  });

  it('a passing run replays to succeeded with no failures', () => {
    const txs = planTestRunTxs(SUITE, 0, 'head1');
    const s = resolveTestRunState(testRunAddress(SUITE, 0), txs);
    expect(s.initiated).toBe(true);
    expect(s.outcome).toBe('TestRunSucceeded');
    expect(s.codeHeadTxId).toBe('head1');
    expect(s.failures).toEqual([]);
  });

  it('failures are logged from the run address to each failing test address', () => {
    const txs = planTestRunTxs(SUITE, 1, 'head1', [{ testAddress: T2, detail: 'expected 1 got 2' }]);
    const run = testRunAddress(SUITE, 1);
    const s = resolveTestRunState(run, txs);
    expect(s.outcome).toBe('TestRunFailed');
    expect(s.failures).toEqual([T2]);
    const log = txs.find((t) => t.eventType === 'TestRunLogged')!;
    expect(log.sourceAddress).toBe(run);
    expect(log.targetAddress).toBe(T2);
    expect(log.payload.suiteAddress).toBe(SUITE); // back reference gives use-case context
  });

  it('proof requires a succeeded run at or after the code head, covering the tests', () => {
    const runTxs = planTestRunTxs(SUITE, 0, 'head1');
    const order = ['head1', `${testRunAddress(SUITE, 0)}:TestRunInitiated`];
    const ok = resolveTestProof(SUITE, [T1, T2], runTxs, suiteTxs, 'head1', order);
    expect(ok.proven).toBe(true);
    expect(ok.runAddress).toBe(testRunAddress(SUITE, 0));
    // run before the head does not prove the head
    const stale = resolveTestProof(SUITE, [T1], runTxs, suiteTxs, 'head2', [...order, 'head2']);
    expect(stale.proven).toBe(false);
    // test not included in the suite blocks proof
    const missing = resolveTestProof(SUITE, [T1, testAddress(APP, 'src/test/c.test.ts')], runTxs, suiteTxs, 'head1', order);
    expect(missing.proven).toBe(false);
    expect(missing.missingTests).toHaveLength(1);
    // failed run blocks proof and names the failing test
    const failTxs = planTestRunTxs(SUITE, 2, 'head1', [{ testAddress: T1, detail: 'boom' }]);
    const failed = resolveTestProof(SUITE, [T1], failTxs, suiteTxs, 'head1', order);
    expect(failed.proven).toBe(false);
    expect(failed.failedTests).toEqual([T1]);
  });
});

describe('BuildRequested gate', () => {
  const tasks = [
    { taskAddress: 'task/a', label: 'a', targetVersion: 'v1', accepted: true },
    { taskAddress: 'task/b', label: 'b', targetVersion: 'v1', accepted: true },
  ];

  it('unproven tasks are skipped and reported by the guard', () => {
    const proven = new Set(['task/a']);
    const txs = planBuildRequestTxs(tasks, APP, false, proven);
    expect(txs.filter((t) => t.eventType === 'BuildRequested').map((t) => t.sourceAddress)).toEqual(['task/a']);
    const cov = checkBuildRequestCoverage(tasks, txs, proven);
    expect(cov.ok).toBe(false);
    expect(cov.unrequested).toEqual(['b']);
  });

  it('a requested task without proof fails coverage as unproven', () => {
    const txs = planBuildRequestTxs(tasks, APP);
    const cov = checkBuildRequestCoverage(tasks, txs, new Set(['task/a']));
    expect(cov.ok).toBe(false);
    expect(cov.unproven).toEqual(['b']);
  });

  it('fully proven tasks pass coverage', () => {
    const proven = new Set(['task/a', 'task/b']);
    const txs = planBuildRequestTxs(tasks, APP, false, proven);
    expect(checkBuildRequestCoverage(tasks, txs, proven).ok).toBe(true);
  });
});

describe('multi-master GitHub import staging', () => {
  it('new mirror files stage as ContentCreated, changed ones as ContentAmended with base', () => {
    const staged = planGitHubImport(APP, { 'src/a.ts': '2', 'src/new.ts': '1' }, { 'src/a.ts': '1' });
    expect(staged).toEqual([
      { path: 'src/a.ts', address: `${APP}/repoz/code/src/a.ts`, event: 'ContentAmended', baseHash: '1', incomingHash: '2' },
      { path: 'src/new.ts', address: `${APP}/repoz/code/src/new.ts`, event: 'ContentCreated', baseHash: undefined, incomingHash: '1' },
    ]);
  });

  it('a file changed on both masters is flagged ConflictDetected, never silently merged', () => {
    const staged = planGitHubImport(APP, { 'src/a.ts': 'gh' }, { 'src/a.ts': 'base' }, { 'src/a.ts': 'repoz' });
    expect(staged[0].event).toBe('ConflictDetected');
    expect(staged[0].baseHash).toBe('base');
  });

  it('secret paths are never staged', () => {
    expect(planGitHubImport(APP, { '.env': 'x' }, {})).toEqual([]);
  });
});
