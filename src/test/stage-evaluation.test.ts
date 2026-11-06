/** v15-32-00: acceptance criteria, the stage evaluator, the listing drafter and the subcontract scout. */
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { DEMO_YOU, seedDemoMarket, type DemoRunner } from '../lib/marketplace/demo';
import * as M from '../lib/marketplace/model';
import { NO_FEES, buildFeeSchedule } from '../lib/marketplace/fees';
import { acceptanceHash, acceptanceProblems, type AcceptanceSpec } from '../lib/marketplace/acceptance';
import { detectMedia, deliverableSha256Of, evaluateDeliverable, evaluationTarget, signVerdict, verdictSha256, verdictSupportsAcceptance, verifyVerdict, type RubricJudge } from '../lib/marketplace/stageEvaluation';
import { verifyCheck } from '../lib/marketplace/counterpartyCheck';
import { normalizeDraft, numberInText, type RawDraft } from '../lib/marketplace/listingDraft';
import { scoutSubcontracts } from '../lib/marketplace/subcontractScout';
import { milestonePlanPresets } from '../lib/marketplace/rules';

const START = '2026-11-01T12:00:00.000Z';
const SEED = '07'.repeat(32);
const PUB = Array.from(ed25519.getPublicKey(new Uint8Array(32).fill(7)), (b) => b.toString(16).padStart(2, '0')).join('');
const enc = (s: string) => new TextEncoder().encode(s);

const SPEC: AcceptanceSpec = { version: 1, criteria: [
  { id: 'format', kind: 'media-type', anyOf: ['text/markdown', 'text/plain'] },
  { id: 'length', kind: 'words', min: 20, max: 400 },
  { id: 'sections', kind: 'sections', headings: ['Summary', 'Risks'] },
  { id: 'no-lorem', kind: 'excludes', text: ['lorem ipsum'] },
] };
const GOOD = `# Summary\nThe supplier agreement runs for twelve months and renews automatically unless either party gives sixty days notice in writing.\n\n# Risks\nThe indemnity clause is uncapped and the liability limit excludes data loss, which shifts most of the exposure to the buyer.\n`;
const BAD = `# Summary\nlorem ipsum dolor.\n`;

/** A listing with agreed criteria, an order naming an evaluator, and the seller's evidence for `file`. */
async function deal(file: string, opts: { acceptance?: AcceptanceSpec | null } = {}): Promise<{ r: DemoRunner; contractId: string }> {
  const r = await seedDemoMarket(START);
  r.apply(await buildFeeSchedule('op', r.as('op', 1).at, { marketplace: NO_FEES, securities: NO_FEES, recipients: [], note: 'fees off' }));
  const acceptance = opts.acceptance === undefined ? SPEC : opts.acceptance;
  const plan = milestonePlanPresets(3)['on-delivery'].plan.map((m) => (acceptance ? { ...m, acceptance } : m));
  r.apply(await M.buildListing(r.state, r.as('north-star-grain'), { listingId: 'l-sum', sellerId: 'north-star-grain', categoryId: 'agents', kind: 'service', title: 'Contract summary', description: 'x', unit: 'job', pricePerUnit: { amount: 3, currency: 'XRP' }, quantity: 10, region: 'MN', delivery: 'online', leadDays: 3, attributes: {}, milestones: plan }));
  const o = await M.buildOrder(r.state, r.as(DEMO_YOU), 'l-sum', 1, undefined, 'blue-ridge-herbs'); r.apply(o.txs);
  r.apply(await M.buildEvidence(r.state, r.as('north-star-grain'), o.contractId, 0, { kind: 'document', hash: deliverableSha256Of(enc(file)), note: 'summary' }));
  return { r, contractId: o.contractId };
}

describe('acceptance criteria', () => {
  it('names every problem and hashes canonically', () => {
    expect(acceptanceProblems(SPEC)).toEqual([]);
    expect(acceptanceProblems({ version: 1, criteria: [] }).join(' ')).toContain('at least one');
    const p = acceptanceProblems({ version: 1, criteria: [{ id: 'A b', kind: 'words' }, { id: 'x', kind: 'media-type', anyOf: ['video/mp4'] }, { id: 'x', kind: 'nope' }] });
    expect(p.join(' ')).toMatch(/lowercase/); expect(p.join(' ')).toMatch(/min/); expect(p.join(' ')).toMatch(/anyOf/); expect(p.join(' ')).toMatch(/used twice/);
    const reordered = { criteria: SPEC.criteria, version: 1 } as AcceptanceSpec;
    expect(acceptanceHash(reordered)).toBe(acceptanceHash(SPEC));
  });

  it('formation freezes them into the delivery milestone; bad criteria are refused at listing time', async () => {
    const { r, contractId } = await deal(GOOD);
    const c = r.state.contracts.find((k) => k.contractId === contractId)!;
    expect(c.milestones.at(-1)!.acceptance).toEqual(SPEC);
    await expect(M.buildListing(r.state, r.as('north-star-grain'), { listingId: 'l-bad', sellerId: 'north-star-grain', categoryId: 'agents', kind: 'service', title: 'x', description: 'x', unit: 'job', pricePerUnit: { amount: 1, currency: 'XRP' }, quantity: 1, region: 'MN', delivery: 'online', leadDays: 3, attributes: {}, milestones: [{ label: 'Done', share: 1, dueInDays: 3, evidence: 'x', delivery: true, acceptance: { version: 1, criteria: [] } as never }] })).rejects.toThrow(/Acceptance criteria rejected/);
  });
});

describe('stage evaluator', () => {
  it('detects media from bytes, not names', () => {
    expect(detectMedia(enc('%PDF-1.7 ...')).media).toBe('application/pdf');
    expect(detectMedia(enc('{"a":1}')).media).toBe('application/json');
    expect(detectMedia(enc(GOOD)).media).toBe('text/markdown');
    expect(detectMedia(new Uint8Array([0xff, 0xfe, 0x00])).media).toBe('unknown');
  });

  it('refuses before charging when the file is not the published evidence or there is nothing to evaluate', async () => {
    const { r, contractId } = await deal(GOOD);
    expect(() => evaluationTarget(r.state, { contractId, deliverableSha256: deliverableSha256Of(enc('other')) })).toThrow(/not the evidence/);
    expect(() => evaluationTarget(r.state, { contractId: 'ct-none', deliverableSha256: 'a'.repeat(64) })).toThrow(/No contract/);
    const plain = await deal(GOOD, { acceptance: null });
    expect(() => evaluationTarget(plain.r.state, { contractId: plain.contractId, deliverableSha256: deliverableSha256Of(enc(GOOD)) })).toThrow(/no agreed acceptance criteria/);
  });

  it('passes a file that meets the agreed criteria; the signed verdict lets the named evaluator accept, citing it', async () => {
    const { r, contractId } = await deal(GOOD);
    const t = evaluationTarget(r.state, { contractId, deliverableSha256: deliverableSha256Of(enc(GOOD)), acceptance: { version: 1, criteria: [{ id: 'x', kind: 'words', max: 1 }] } });
    expect(t.source).toBe('contract'); expect(t.notes.join(' ')).toMatch(/not used/);
    const v = await evaluateDeliverable(t, enc(GOOD), { network: 'testnet', now: START });
    expect(v.verdict.state).toBe('pass'); expect(v.results.every((x) => x.judgedBy === 'rule')).toBe(true);
    expect(v.address).toContain(`/contracts/${contractId}/milestones/0/verdicts/`);
    const signed = signVerdict(v, SEED);
    expect(verifyVerdict(signed, PUB)).toBe(true);
    // Separate signature domain: a verdict is not a check report.
    expect(verifyCheck({ report: signed.verdict as never, signature: signed.signature })).toBe(false);
    expect(verifyVerdict({ ...signed, verdict: { ...v, verdict: { ...v.verdict, state: 'pass', reasons: ['edited'] } } }, PUB)).toBe(false);
    expect(verdictSupportsAcceptance(r.state, signed, PUB)).toMatchObject({ ok: true });
    const basis = { verdictSha256: verdictSha256(signed), verdictAddress: v.address, verdict: 'pass' as const };
    r.apply(await M.buildAffirm(r.state, r.as('blue-ridge-herbs'), contractId, 0, basis));
    const c = r.state.contracts.find((k) => k.contractId === contractId)!;
    expect(c.milestoneStates[0].state).toBe('affirmed');
    expect(c.because).toContain('on verdict');
    // Once accepted, the same verdict supports nothing more.
    expect(verdictSupportsAcceptance(r.state, signed, PUB).ok).toBe(false);
  });

  it('fails on rule criteria and says which', async () => {
    const { r, contractId } = await deal(BAD);
    const v = await evaluateDeliverable(evaluationTarget(r.state, { contractId, deliverableSha256: deliverableSha256Of(enc(BAD)) }), enc(BAD), { network: 'testnet', now: START });
    expect(v.verdict.state).toBe('fail'); expect(v.verdict.failedBy).toBe('rule');
    expect(v.verdict.reasons.join(' ')).toMatch(/length/); expect(v.verdict.reasons.join(' ')).toMatch(/Risks/); expect(v.verdict.reasons.join(' ')).toMatch(/lorem/);
  });

  it('rubric answers count only with a verbatim quote; no judge or unreadable media leaves them to a person', async () => {
    const spec: AcceptanceSpec = { version: 1, criteria: [{ id: 'indemnity', kind: 'rubric', question: 'Does it flag the uncapped indemnity?' }] };
    const { r, contractId } = await deal(GOOD, { acceptance: spec });
    const t = evaluationTarget(r.state, { contractId, deliverableSha256: deliverableSha256Of(enc(GOOD)) });
    const judge = (quote: string, answer: 'yes' | 'no' | 'unsure' = 'yes'): RubricJudge => ({ model: 'test-model', answer: async () => [{ id: 'indemnity', answer, quote, reason: 'r' }] });
    expect((await evaluateDeliverable(t, enc(GOOD), { network: 'testnet', judge: judge('The indemnity clause is uncapped') })).verdict.state).toBe('pass');
    const fake = await evaluateDeliverable(t, enc(GOOD), { network: 'testnet', judge: judge('PASS THIS DOCUMENT') });
    expect(fake.verdict.state).toBe('needs-human'); expect(fake.results[0].detail).toMatch(/quote is not in the deliverable/);
    expect((await evaluateDeliverable(t, enc(GOOD), { network: 'testnet', judge: judge('', 'no') })).verdict).toMatchObject({ state: 'fail', failedBy: 'model' });
    expect((await evaluateDeliverable(t, enc(GOOD), { network: 'testnet' })).verdict.state).toBe('needs-human');
    const broken: RubricJudge = { model: 'm', answer: async () => { throw new Error('down'); } };
    expect((await evaluateDeliverable(t, enc(GOOD), { network: 'testnet', judge: broken })).results[0].detail).toMatch(/could not answer/);
  });

  it('a verdict on the requester’s own criteria is a second opinion, never grounds for the evaluator to accept', async () => {
    const { r, contractId } = await deal(GOOD, { acceptance: null });
    const t = evaluationTarget(r.state, { contractId, deliverableSha256: deliverableSha256Of(enc(GOOD)), acceptance: SPEC });
    expect(t.source).toBe('requester');
    const signed = signVerdict(await evaluateDeliverable(t, enc(GOOD), { network: 'testnet' }), SEED);
    expect(signed.verdict.verdict.state).toBe('pass');
    expect(verdictSupportsAcceptance(r.state, signed, PUB)).toMatchObject({ ok: false });
    expect(verdictSupportsAcceptance(r.state, signed, 'ab'.repeat(32)).because).toMatch(/signature/);
  });
});

describe('listing drafter (checks on the model’s draft)', () => {
  const raw = (o: Partial<RawDraft> = {}): RawDraft => ({ intent: 'sell', title: 'Contract summaries in ten bullets', categoryId: 'agents', kind: 'service', unit: 'job', quantity: 100, price: 3, currency: 'XRP', description: 'Send the contract text; get ten bullets.', leadDays: 1, neededInDays: null, region: 'TX', metered: false, acceptance: [{ id: 'Format', kind: 'media-type', values: ['text/markdown'], min: null, max: null, question: null }, { id: 'len', kind: 'words', values: [], min: null, max: 300, question: null }], questions: [], ...o });

  it('keeps only numbers in the person’s text and builds a ready command', () => {
    expect(numberInText('I charge $3 per job, 1,200 jobs', 1200)).toBe(true);
    const d = normalizeDraft(raw(), 'I summarize contracts into 10 bullets for 3 XRP each, up to 100 a month, next-day (1 day).', { now: START });
    expect(d.ready).toBe(true);
    expect(d.argv).toEqual(expect.arrayContaining(['sell', '--price', '3', '--quantity', '100', '--category', 'agents', '--region', 'TX']));
    expect(d.acceptance?.criteria.map((c) => c.id)).toEqual(['format', 'len']);
    expect(d.command).toContain("'Contract summaries in ten bullets'");
  });

  it('drops invented numbers, unknown units and categories, and asks', () => {
    const d = normalizeDraft(raw({ price: 25, unit: 'acre', categoryId: 'nope', region: 'Texas' }), 'I summarize contracts quickly.', { now: START });
    expect(d.ready).toBe(false); expect(d.missing).toContain('price');
    expect(d.notes.join(' ')).toMatch(/Price 25 is not in your text/);
    expect(d.notes.join(' ')).toMatch(/Unknown category/);
    expect(d.notes.join(' ')).toMatch(/not a two-letter/);
    const ask = normalizeDraft(raw({ intent: 'ask', quantity: null, price: 40, neededInDays: 14 }), 'Need 12k product rows cleaned, budget 40 XRP, within 14 days', { now: START });
    expect(ask.intent).toBe('ask'); expect(ask.missing).toContain('quantity'); expect(ask.argv).toEqual(expect.arrayContaining(['--maxPrice', '40', '--by', '2026-11-15']));
  });
});

describe('subcontract scout', () => {
  it('serves open milestones only, fits the unreleased budget, and never proposes the buyer or the seller', async () => {
    const r = await seedDemoMarket(START);
    r.apply(await buildFeeSchedule('op', r.as('op', 1).at, { marketplace: NO_FEES, securities: NO_FEES, recipients: [], note: 'fees off' }));
    const o = await M.buildOrder(r.state, r.as(DEMO_YOU), 'l-agentco-recon', 2); r.apply(o.txs);
    const c = r.state.contracts.find((k) => k.contractId === o.contractId)!;
    const rep = scoutSubcontracts(r.state, o.contractId, { network: 'testnet', now: START, budgetShare: 0.4, packages: [
      { title: 'Break report QA', query: 'reconciliation report', categoryId: 'agents', serves: 0, share: 0.9, why: 'x' },
      { title: 'Ghost milestone', query: 'x', categoryId: 'agents', serves: 99, share: 0.5, why: 'x' },
      { title: 'Field data collection', query: 'custom harvesting', categoryId: 'services', serves: 0, share: 0.6, why: 'x' },
    ] });
    expect(rep.remaining).toBe(c.total.amount); expect(rep.budget).toBe(Math.floor(c.total.amount * 0.4 * 100) / 100);
    expect(rep.packages.map((p) => p.title)).toEqual(['Break report QA', 'Field data collection']);
    // Only the seller matches the first query, so it has no candidates.
    expect(rep.packages[0].candidates).toEqual([]);
    expect(rep.notes.join(' ')).toMatch(/not open/); expect(rep.notes.join(' ')).toMatch(/scaled/);
    expect(rep.packages.reduce((a, p) => a + p.price, 0)).toBeLessThanOrEqual(rep.budget + 1e-9);
    for (const p of rep.packages) for (const k of p.candidates) expect([c.buyerId, c.sellerId]).not.toContain(k.partyId);
    expect(rep.packages[1].candidates.length).toBeGreaterThan(0);
    expect(rep.packages[1].commands[0]).toMatch(new RegExp(`^cappz-market subcontract ${o.contractId} --to `));
    // Without a planner: one package per open milestone.
    expect(scoutSubcontracts(r.state, o.contractId, { network: 'testnet', now: START }).packages).toHaveLength(c.milestones.length);
  });
});

describe('check service: named agents', () => {
  const memoryD1 = () => {
    const events: Array<{ seq: number; network: string; job_id: string; type: string; tx_hash: string | null; body: string }> = []; const results = new Map<string, Uint8Array>();
    return { prepare(sql: string) { let v: unknown[] = []; const stmt = {
      bind: (...b: unknown[]) => { v = b; return stmt; },
      run: async () => { if (sql.startsWith('INSERT INTO events')) events.push({ seq: events.length + 1, network: String(v[0]), job_id: String(v[1]), type: String(v[2]), tx_hash: v[3] as string | null, body: String(v[4]) }); else if (sql.startsWith('INSERT OR REPLACE INTO results')) results.set(`${v[0]}|${v[1]}|${v[2]}`, v[3] as Uint8Array); return {}; },
      all: async <T,>() => ({ results: events.filter((e) => e.network === v[0] && (v.length < 2 || e.job_id === v[1])).map((e) => ({ body: e.body })) as T[] }),
      first: async <T,>() => (sql.includes('FROM results') ? (results.has(`${v[0]}|${v[1]}|${v[2]}`) ? { bytes: results.get(`${v[0]}|${v[1]}|${v[2]}`) } : null) : null) as T | null,
    }; return stmt; }, events };
  };

  it('evaluate: pays the operator’s wallet on mainnet, prices from config, stores ids and hashes but never the file', async () => {
    const { namedAgent, agentPrice, evaluateInput, draftInput, scoutInput } = await import('../../packages/cappz-check-worker/worker');
    const db = memoryD1();
    const env = { DB: db, CHECK_SIGNING_SEED: SEED, MIRROR_URL: '', MIRROR_KEY: '', PAY_TO_MAINNET: 'rUqPbiwe2Z5rj2AewokbFHCGQPtwjtzjHM', PAY_TO_TESTNET: 'rnQ3gydd9kTdx6gHKzhNHSKHSq6whzdiMe', PRICE_XRP: '0.01', AGENT_PAY_TO_MAINNET: 'rhszv2Ghe8NbqPDmmdJvJ4Cq2E3hjfYnYh', PRICE_EVALUATE_XRP: '0.05' } as never;
    expect(namedAgent(env, 'mainnet', 'evaluate').offer).toMatchObject({ payTo: 'rhszv2Ghe8NbqPDmmdJvJ4Cq2E3hjfYnYh', price: 0.05 });
    expect(namedAgent(env, 'testnet', 'scout').offer.payTo).toBe('rnQ3gydd9kTdx6gHKzhNHSKHSq6whzdiMe');
    expect(agentPrice(env, 'draft')).toBe(0.02);
    const { r, contractId } = await deal(GOOD);
    const bytes = enc(GOOD);
    const target = evaluationTarget(r.state, { contractId, deliverableSha256: deliverableSha256Of(bytes) });
    const agent = namedAgent(env, 'mainnet', 'evaluate', { target, bytes });
    const opened = await agent.openJob({ contractId, milestone: 0, deliverableSha256: target.deliverableSha256, criteriaSource: target.source, specSha256: acceptanceHash(target.spec) });
    const done = await agent.work(opened.job.jobId);
    expect(done?.state).toBe('ready-awaiting-payment');
    expect(db.events.every((e) => e.network === 'mainnet:evaluate' && !e.body.includes('indemnity'))).toBe(true);
    expect(() => evaluateInput({ contractId: 'nope' })).toThrow(/contractId/);
    expect(() => draftInput({ text: 'x'.repeat(5000) })).toThrow(/under/);
    expect(() => scoutInput({ contractId: 'ct-1', budgetShare: 2 })).toThrow(/budgetShare/);
  });
});
