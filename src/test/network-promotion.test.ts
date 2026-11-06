/** 15.33.0: network promotion — run replay, resume, checks, preflight evidence, issuer-grant dry run. */
import { afterEach, describe, expect, it } from 'vitest';
import {
  PROMOTION_EVENTS as E, replayPromotionRun, stepsToRun, resumeRefusal, cancelRefusal, staleStep, expandPromotionPlan, type PromotionStepSpec, type PromotionTxLike,
} from '../lib/network/promotion/promotionRun';
import {
  registerPlatformCheck, registerPromotableApp, checksFor, runPromotionChecks, checksPassed, resetPromotionRegistry, type PromotionCheck,
} from '../lib/network/promotion/promotionChecks';
import { buildPreflightEvidence, preflightHash, verifyPreflightForStart } from '../lib/network/promotion/preflightEvidence';
import { planIssuerGrant, LSF_DEFAULT_RIPPLE, TF_CLEAR_NO_RIPPLE, TF_SET_NO_RIPPLE, type LedgerAccountState } from '../lib/network/promotion/issuerGrant';

const INST = "m/44'/144'/0'/cappz/admin/bpmn/NetworkPromotion/instances/0'";
const PLAN: PromotionStepSpec[] = [
  { id: 'Gate', name: 'Gate', reversible: true, writesTarget: false },
  { id: 'AppChecks', name: 'App checks', reversible: true, writesTarget: false, perApp: true },
  { id: 'Mirror', name: 'Mirror', reversible: false, writesTarget: true },
  { id: 'Verify', name: 'Verify', reversible: false, writesTarget: false },
];
let t = 0;
const at = () => new Date(Date.UTC(2026, 10, 6, 12, 0, t++)).toISOString();
const requested = (): PromotionTxLike => ({ eventType: E.Requested, sourceAddress: 'admin', targetAddress: INST, timestamp: at(), payload: { apps: ['charm', 'bible'], source: 'testnet', target: 'testnet', preflightHash: 'h' } });
const ask = (stepId: string, requestId: string): PromotionTxLike => ({ eventType: E.StepRequested, sourceAddress: `${INST}/ports/out/${stepId}`, timestamp: at(), payload: { stepId, requestId } });
const reply = (ok: boolean, requestId: string, extra: Record<string, unknown> = {}): PromotionTxLike => ({ eventType: ok ? E.StepCompleted : E.StepFailed, sourceAddress: 'handler', targetAddress: `${INST}/ports/in/x`, timestamp: at(), payload: { requestId, ...extra } });

describe('promotion run replay', () => {
  it('expands per-app steps in app order', () => {
    expect(expandPromotionPlan(PLAN, ['charm', 'bible']).map((s) => s.id)).toEqual(['Gate', 'AppChecks/bible', 'AppChecks/charm', 'Mirror', 'Verify']);
  });

  it('derives status from events only; a failed step stops the run and resume skips completed steps', () => {
    const txs = [requested(), ask('Gate', 'r1'), reply(true, 'r1'), ask('AppChecks/bible', 'r2'), reply(true, 'r2'), ask('AppChecks/charm', 'r3'), reply(false, 'r3', { reason: 'PHI found' })];
    const run = replayPromotionRun(txs, INST, PLAN);
    expect(run.state).toBe('stopped');
    expect(run.lastCompleted).toBe('AppChecks/bible');
    expect(run.resumeFrom).toBe('AppChecks/charm');
    expect(run.steps.find((s) => s.id === 'AppChecks/charm')?.reason).toBe('PHI found');
    expect(stepsToRun(run).map((s) => s.id)).toEqual(['AppChecks/charm', 'Mirror', 'Verify']);
    expect(resumeRefusal(run)).toBeNull();
    expect(run.rollback).toBe('clean');
  });

  it('ignores replies nobody asked for and marks rollback impossible once an irreversible step ran', () => {
    const txs = [requested(), reply(true, 'ghost'), ask('Gate', 'r1'), reply(true, 'r1'), ask('AppChecks/bible', 'a'), reply(true, 'a'), ask('AppChecks/charm', 'b'), reply(true, 'b'), ask('Mirror', 'm')];
    const run = replayPromotionRun(txs, INST, PLAN);
    expect(run.state).toBe('active');
    expect(resumeRefusal(run, Date.parse(run.steps[3].requestedAt!) + 1000)).toMatch(/still running/);
    expect(run.irreversibleFrom).toBe('Mirror');
    expect(run.rollback).toBe('impossible');
    expect(run.steps.map((s) => s.rollback)).toEqual(['clean', 'clean', 'clean', 'impossible', 'impossible']);
  });

  it('a retried step counts attempts and completes on the new request', () => {
    const txs = [requested(), ask('Gate', 'r1'), reply(false, 'r1'), ask('Gate', 'r2'), reply(true, 'r2', { evidenceHash: 'e' }), reply(true, 'r1')];
    const gate = replayPromotionRun(txs, INST, PLAN).steps[0];
    expect(gate).toMatchObject({ state: 'completed', attempts: 2, evidenceHash: 'e' });
  });

  it('a step with no reply for 15 minutes is stale, so resume may ask again', () => {
    const txs = [requested(), ask('Gate', 'r1')];
    const run = replayPromotionRun(txs, INST, PLAN);
    const asked = Date.parse(run.steps[0].requestedAt!);
    expect(resumeRefusal(run, asked + 60_000)).toMatch(/still running/);
    expect(staleStep(run, asked + 16 * 60_000)?.id).toBe('Gate');
    expect(resumeRefusal(run, asked + 16 * 60_000)).toBeNull();
  });

  it('cancel needs a reason, closes the run and keeps its history', () => {
    const open = replayPromotionRun([requested(), ask('Gate', 'r1'), reply(false, 'r1')], INST, PLAN);
    expect(cancelRefusal(open, ' ')).toMatch(/reason/);
    expect(cancelRefusal(open, 'operator abandoned')).toBeNull();
    const txs = [requested(), ask('Gate', 'r1'), reply(false, 'r1'), { eventType: E.InstanceCancelled, sourceAddress: INST, timestamp: at(), payload: { reason: 'wrong accounts', cancelledBy: 'a@x' } }];
    const run = replayPromotionRun(txs, INST, PLAN);
    expect(run).toMatchObject({ state: 'cancelled', cancelReason: 'wrong accounts', cancelledBy: 'a@x' });
    expect(run.steps[0].state).toBe('failed');
    expect(stepsToRun(run)).toEqual([]);
    expect(resumeRefusal(run)).toMatch(/cancelled/);
    expect(cancelRefusal(run, 'again')).toMatch(/already/);
  });

  it('completion closes the run', () => {
    const txs = [requested(), { eventType: E.InstanceCompleted, sourceAddress: INST, timestamp: at() }];
    const run = replayPromotionRun(txs, INST, PLAN);
    expect(run.state).toBe('completed');
    expect(stepsToRun(run)).toEqual([]);
  });
});

describe('promotion checks', () => {
  afterEach(resetPromotionRegistry);
  const check = (id: string, appId: string | undefined, critical: boolean, run: PromotionCheck['run']): PromotionCheck => ({ id, label: id, appId, critical, governingPrinciple: 'p', run });

  it('platform checks run first; an app adds only its own checks', async () => {
    registerPlatformCheck(check('gate', undefined, true, async () => ({ status: 'passed', reason: 'ok' })));
    registerPromotableApp({ appId: 'bible', label: 'Bible', skillAddress: 's', checks: [check('canon', 'bible', true, async () => ({ status: 'passed', reason: '86 books' }))] });
    expect(checksFor(['bible']).map((c) => c.id)).toEqual(['gate', 'canon']);
    expect(() => checksFor(['nope'])).toThrow(/promotable/);
    expect(() => registerPromotableApp({ appId: 'x', label: 'x', skillAddress: 's', checks: [check('c', 'y', true, async () => ({ status: 'passed', reason: '' }))] })).toThrow();
  });

  it('a thrown check is unknown, and unknown on a critical check blocks', async () => {
    const results = await runPromotionChecks([check('a', undefined, true, async () => { throw new Error('rpc down'); })], { source: 'testnet', target: 'mainnet', apps: [] });
    expect(results[0]).toMatchObject({ status: 'unknown', reason: 'rpc down' });
    expect(checksPassed(results)).toBe(false);
  });
});

describe('preflight evidence', () => {
  const base = { source: 'testnet' as const, target: 'mainnet' as const, apps: ['charm', 'bible'], sessionId: 's1', checkedAt: '2026-11-06T12:00:00.000Z' };
  const passing = [{ id: 'gate', label: 'gate', critical: true, status: 'passed' as const, reason: 'ok' }];
  const now = Date.parse('2026-11-06T12:05:00.000Z');

  it('start needs a passing preflight from the same session, pair and apps', async () => {
    const e = buildPreflightEvidence({ ...base, results: passing });
    const h = await preflightHash(e);
    const ok = { evidence: e, citedHash: h, sessionId: 's1', source: 'testnet' as const, target: 'mainnet' as const, apps: ['bible', 'charm'], now };
    expect(await verifyPreflightForStart(ok)).toEqual({ ok: true });
    expect(await verifyPreflightForStart({ ...ok, citedHash: undefined })).toMatchObject({ ok: false });
    expect(await verifyPreflightForStart({ ...ok, sessionId: 's2' })).toMatchObject({ ok: false, reason: expect.stringMatching(/session/) });
    expect(await verifyPreflightForStart({ ...ok, apps: ['bible'] })).toMatchObject({ ok: false });
    expect(await verifyPreflightForStart({ ...ok, target: 'testnet' })).toMatchObject({ ok: false });
    expect(await verifyPreflightForStart({ ...ok, networkSwitchedAt: '2026-11-06T12:01:00.000Z' })).toMatchObject({ ok: false, reason: expect.stringMatching(/switched/) });
    expect(await verifyPreflightForStart({ ...ok, now: now + 60 * 60_000 })).toMatchObject({ ok: false, reason: expect.stringMatching(/old/) });
    expect(await verifyPreflightForStart({ ...ok, citedHash: 'f'.repeat(64) })).toMatchObject({ ok: false });
  });

  it('a failing preflight never starts', async () => {
    const e = buildPreflightEvidence({ ...base, results: [{ ...passing[0], status: 'failed' }] });
    expect(await verifyPreflightForStart({ evidence: e, citedHash: await preflightHash(e), sessionId: 's1', source: 'testnet', target: 'mainnet', apps: base.apps, now })).toMatchObject({ ok: false, reason: expect.stringMatching(/did not pass/) });
  });
});

describe('issuer grant dry run', () => {
  const CUR = '434150505A000000000000000000000000000000';
  const acct = (address: string, over: Partial<LedgerAccountState> = {}): LedgerAccountState => ({ address, activated: true, flags: 0, balanceDrops: 50_000_000n, ownerCount: 0, lines: [], ...over });
  const reserve = { baseDrops: 1_000_000n, incDrops: 200_000n };

  it('sets DefaultRipple first, then holder lines, then fee lines', () => {
    const plan = planIssuerGrant({
      currencyHex: CUR, issuer: acct('rIss'), holders: [{ role: 'treasury', state: acct('rTre') }, { role: 'service', state: acct('rSvc') }],
      holderLimit: '100000000000', domain: 'cappz.ai', reserve,
      feeLines: [{ role: 'treasury', holder: 'rTre', currencyHex: '524C555344000000000000000000000000000000', issuer: 'rRL', label: 'RLUSD', limit: '1000000000' }],
    });
    expect(plan.ok).toBe(true);
    expect(plan.txs.map((x) => x.tx.TransactionType)).toEqual(['AccountSet', 'TrustSet', 'TrustSet', 'TrustSet']);
    expect(plan.txs[0].tx).toMatchObject({ SetFlag: 8, Domain: '636170707A2E6169' });
    expect(plan.txs[3].tx.Flags).toBe(TF_SET_NO_RIPPLE);
  });

  it('is empty when everything is in place, and repairs NoRipple on older lines', () => {
    const line = { account: 'rIss', currency: CUR, limit: '1', no_ripple_peer: false };
    const done = planIssuerGrant({ currencyHex: CUR, issuer: acct('rIss', { flags: LSF_DEFAULT_RIPPLE }), holders: [{ role: 'treasury', state: acct('rTre', { lines: [line] }) }], holderLimit: '1', reserve });
    expect(done.txs).toEqual([]);
    expect(done.ok).toBe(true);
    const repair = planIssuerGrant({ currencyHex: CUR, issuer: acct('rIss', { flags: LSF_DEFAULT_RIPPLE }), holders: [{ role: 'treasury', state: acct('rTre', { lines: [{ ...line, no_ripple_peer: true }] }) }], holderLimit: '1', reserve });
    expect(repair.txs).toHaveLength(1);
    expect(repair.txs[0]).toMatchObject({ signerRole: 'issuer', tx: { Flags: TF_CLEAR_NO_RIPPLE } });
  });

  it('refuses when an account is not activated or short of reserve', () => {
    const plan = planIssuerGrant({ currencyHex: CUR, issuer: acct('rIss'), holders: [{ role: 'service', state: acct('rSvc', { balanceDrops: 1_000_000n }) }, { role: 'treasury', state: acct('rTre', { activated: false }) }], holderLimit: '1', reserve });
    expect(plan.ok).toBe(false);
    expect(plan.problems.join(' ')).toMatch(/treasury .* not activated/);
    expect(plan.problems.join(' ')).toMatch(/service needs/);
  });
});
