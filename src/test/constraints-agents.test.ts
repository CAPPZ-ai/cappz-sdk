import { describe, it, expect, beforeAll } from 'vitest';
import { createConstraintGuard } from '../lib/constraints/guard';
import { reconcileConstraints } from '../lib/constraints/reconcile';
import { verifyAdvice, type SignedAdvice, type RawEnvelopeDraft } from '../lib/constraints/advisor';
import type { SignedEnvelope } from '../lib/constraints/envelope';
import { deviceEnvelope, keys, min, OVEN, pointsOf, type Keys } from './helpers/constraintFixtures';

/** In-memory D1 (events + results), as the worker's job store uses it. */
const memoryD1 = () => {
  const events: Array<{ network: string; job_id: string; body: string }> = []; const results = new Map<string, Uint8Array>();
  return { prepare: (sql: string) => { let v: unknown[] = []; const st = {
    bind: (...b: unknown[]) => { v = b; return st; },
    run: async () => { if (sql.startsWith('INSERT INTO events')) events.push({ network: String(v[0]), job_id: String(v[1]), body: String(v[4]) }); else if (sql.startsWith('INSERT OR REPLACE INTO results')) results.set(`${v[0]}|${v[1]}|${v[2]}`, v[3] as Uint8Array); return {}; },
    all: async <T,>() => ({ results: events.filter((e) => e.network === v[0] && (v.length < 2 || e.job_id === v[1])).map((e) => ({ body: e.body })) as T[] }),
    first: async <T,>() => (sql.includes('FROM results') ? (results.has(`${v[0]}|${v[1]}|${v[2]}`) ? { bytes: results.get(`${v[0]}|${v[1]}|${v[2]}`) } : null) : null) as T | null,
  }; return st; }, events, results };
};
const SEED = '07'.repeat(32);
const ENV = (db: unknown) => ({ DB: db, CHECK_SIGNING_SEED: SEED, MIRROR_URL: '', MIRROR_KEY: '', PAY_TO_TESTNET: 'rnQ3gydd9kTdx6gHKzhNHSKHSq6whzdiMe', PAY_TO_MAINNET: 'rUqPbiwe2Z5rj2AewokbFHCGQPtwjtzjHM', PRICE_XRP: '0.01', AGENT_PAY_TO_MAINNET: 'rhszv2Ghe8NbqPDmmdJvJ4Cq2E3hjfYnYh' }) as never;
const ctx = { waitUntil: () => {} } as never;

describe('15.40.0 Constraint Guard agents on the check service', () => {
  let k: Keys; let env: SignedEnvelope; const P = pointsOf(OVEN);
  beforeAll(async () => { k = await keys(); env = await deviceEnvelope(k, { profile: OVEN }); });
  const post = async (path: string, body: unknown, db = memoryD1()) => {
    const { default: worker } = await import('../../packages/cappz-check-worker/worker');
    const res = await worker.fetch(new Request(`http://x${path}`, { method: 'POST', body: JSON.stringify(body) }), ENV(db), ctx);
    return { res, db, body: await res.json() as Record<string, unknown> };
  };
  const resultOf = (db: ReturnType<typeof memoryD1>) => JSON.parse(new TextDecoder().decode([...db.results.values()][0])) as SignedAdvice<Record<string, unknown>>;

  it('prices, pay-to and cards: review and triage are rules-only; the drafter needs a model', async () => {
    const { namedAgent, agentPrice, default: worker } = await import('../../packages/cappz-check-worker/worker');
    const e = ENV(memoryD1());
    expect([agentPrice(e, 'envelope'), agentPrice(e, 'review'), agentPrice(e, 'triage')]).toEqual([0.05, 0.02, 0.02]);
    expect(namedAgent(e, 'mainnet', 'triage').offer.payTo).toBe('rhszv2Ghe8NbqPDmmdJvJ4Cq2E3hjfYnYh');
    const h = async (a: string) => (await (await worker.fetch(new Request(`http://x/testnet/${a}/health`), e, ctx)).json()) as { ok: boolean };
    expect([(await h('review')).ok, (await h('triage')).ok, (await h('envelope')).ok]).toEqual([true, true, false]);
    const card = await (await worker.fetch(new Request('http://x/testnet/review/agent'), e, ctx)).json() as { model: unknown; description: string };
    expect(card.model).toBeNull(); expect(card.description).toMatch(/Rules only/);
  });

  it('every service links the skill that says how to use it, and each linked skill exists in skills/', async () => {
    const { AGENT_SKILLS, default: worker } = await import('../../packages/cappz-check-worker/worker');
    const { existsSync } = await import('node:fs'); const { resolve } = await import('node:path');
    for (const [, { skill, guide }] of Object.entries(AGENT_SKILLS)) {
      const dir = skill.split('/tree/main/')[1];
      expect(existsSync(resolve(__dirname, '../..', dir, 'SKILL.md'))).toBe(true);
      if (guide) expect(existsSync(resolve(__dirname, '../..', guide.split('/blob/main/')[1].split('#')[0]))).toBe(true);
    }
    const e = ENV(memoryD1());
    const card = await (await worker.fetch(new Request('http://x/testnet/triage/agent'), e, ctx)).json() as { skill: string; guide: string };
    expect(card.skill).toMatch(/skills\/monitoring-constraints$/); expect(card.guide).toMatch(/CONSTRAINT_GUARD\.md#marketplace-agents$/);
    const index = await (await worker.fetch(new Request('http://x/'), e, ctx)).json() as { skills: string; agents: Record<string, { skill: string }> };
    expect(index.skills).toMatch(/skills\/index\.json$/);
    expect(index.agents.envelope.skill).toMatch(/securing-control-systems$/);
    const a2a = await (await worker.fetch(new Request('http://x/.well-known/agent-card.json'), e, ctx)).json() as { skills: Array<{ id: string; description: string }> };
    expect(a2a.skills.find((s) => s.id === 'review-testnet')!.description).toMatch(/Skill: https:\/\/github\.com\/CAPPZ-ai\/cappz-sdk\/tree\/main\/skills\/securing-control-systems/);
  });

  it('review: a real shadow report is reviewed and signed; an edited one is refused before any job opens', async () => {
    const t = Date.parse('2026-11-02T09:00:00Z');
    const g = createConstraintGuard({ envelope: () => env, now: () => t });
    await g.check({ kind: 'write', writes: [{ point: P.setpoint, value: 400 }], unmapped: [] }, { source: 'panel' });
    const report = await g.report();
    const { res, body, db } = await post('/testnet/review/jobs', { input: { report } });
    expect(res.status).toBe(201); expect((body.pay as { amount: string }).amount).toBe('0.02');
    const signed = resultOf(db);
    expect(verifyAdvice(signed)).toBe(true);
    expect(signed.advice).toMatchObject({ kind: 'cappz-shadow-review', reportHash: report.reportHash });
    const edited = { ...report, points: { ...report.points, [P.setpoint]: { ...report.points[P.setpoint], wouldRefuse: {} } } };
    const bad = await post('/testnet/review/jobs', { input: { report: edited } });
    expect(bad.res.status).toBe(400); expect(String(bad.body.error)).toMatch(/reportHash/);
    expect(bad.db.events).toHaveLength(0);
    expect((await post('/testnet/review/jobs', { input: {} })).res.status).toBe(400);
  });

  it('triage: a reconciliation report gets a signed severity and ordered actions', async () => {
    const r = await reconcileConstraints(env, { observations: [{ at: min(0), point: P.mode, value: 'baking', source: 'h' }], config: [{ at: min(0), point: P.setpoint, value: 200, source: 'c' }, { at: min(5), point: P.setpoint, value: 400, source: 'c' }] });
    const { res, db } = await post('/testnet/triage/jobs', { input: { report: r } });
    expect(res.status).toBe(201);
    const signed = resultOf(db);
    expect(verifyAdvice(signed)).toBe(true);
    expect(signed.advice).toMatchObject({ kind: 'cappz-incident-triage', reportHash: r.reportHash });
    expect(['high', 'critical']).toContain(signed.advice.severity);
    const tooMany = { ...r, findings: new Array(5001).fill(r.findings[0]) };
    expect((await post('/testnet/triage/jobs', { input: { report: tooMany } })).res.status).toBe(400);
  });

  it('envelope drafter: 503 with no model, nothing opened; with a model, invented numbers are dropped', async () => {
    const none = await post('/testnet/envelope/jobs', { input: { text: 'Setpoint 160 °C to 250 °C.' } });
    expect(none.res.status).toBe(503); expect(none.db.events).toHaveLength(0);
    expect((await post('/testnet/envelope/jobs', { input: { text: '' } })).res.status).toBe(400);
    expect((await post('/testnet/envelope/jobs', { input: { text: 'x'.repeat(60_001) } })).res.status).toBe(400);
    const { registerModelPorts } = await import('../../packages/cappz-check-worker/worker');
    const fake: RawEnvelopeDraft = { device: 'oven', modePoint: null, questions: [], redundancy: [], responses: [],
      points: [{ id: 'setpoint', kind: 'setpoint', unit: 'Cel', label: '' }],
      limits: [{ point: 'setpoint', kind: 'range', unit: 'Cel', min: 160, max: 250, maxStep: null, maxDelta: null, perSeconds: null, maxMinutes: null, modes: null, quote: 'Setpoint 160 °C to 250 °C.' },
        { point: 'setpoint', kind: 'rate', unit: 'Cel', min: null, max: null, maxStep: 30, maxDelta: null, perSeconds: null, maxMinutes: null, modes: null, quote: 'Setpoint 160 °C to 250 °C.' }] };
    registerModelPorts((e) => ({ model: e.MODEL || 'test-model', judge: null, drafter: null, planner: null, envelopeDrafter: { model: 'test-model', draft: async () => fake } }));
    try {
      const { res, db } = await post('/testnet/envelope/jobs', { input: { text: 'Setpoint 160 °C to 250 °C.', device: 'oven-3' } });
      expect(res.status).toBe(201);
      const d = resultOf(db).advice as { draft: { constraints: Array<{ kind: string }> }; dropped: Array<{ because: string }>; model: string };
      expect(d.draft.constraints.map((c) => c.kind)).toEqual(['range']);
      expect(d.dropped[0].because).toMatch(/number 30 is not in its quote/);
      expect(d.model).toBe('test-model');
    } finally { registerModelPorts((e) => ({ model: e.MODEL || 'claude-haiku-5-5', judge: null, drafter: null, planner: null, envelopeDrafter: null })); }
  });
});
