import { describe, it, expect, beforeAll } from 'vitest';
import { normalizeEnvelopeDraft, numbersIn, reviewShadow, signAdvice, triageIncident, verifyAdvice, ENVELOPE_DRAFT_SCHEMA, type RawEnvelopeDraft } from '../lib/constraints/advisor';
import { reconcileConstraints, type Observation } from '../lib/constraints/reconcile';
import { createConstraintGuard } from '../lib/constraints/guard';
import { signCommand } from '../lib/constraints/authority';
import type { SignedEnvelope } from '../lib/constraints/envelope';
import { deviceEnvelope, keys, min, OVEN, pointsOf, type Keys } from './helpers/constraintFixtures';

const MANUAL = `Deck oven DX-3 — operating limits.
Baking chamber temperature: 150 °C to 260 °C during baking.
Setpoint adjustable from 160 °C to 250 °C; change the setpoint by no more than 20 °C at a time.
The chamber must not stay above 250 °C for more than 10 minutes.
The redundant chamber probe must agree with the control probe within 6 °C.
After a setpoint change the chamber reaches the new setpoint within 15 minutes (±2 °C).
Freezer models: hold at −18 °C or colder.`;

const raw = (over: Partial<RawEnvelopeDraft> = {}): RawEnvelopeDraft => ({
  device: 'Oven 3', modePoint: 'mode',
  points: [{ id: 'value', kind: 'measurement', unit: 'Cel' }, { id: 'probe', kind: 'measurement', unit: 'Cel' }, { id: 'setpoint', kind: 'setpoint', unit: 'Cel' }, { id: 'mode', kind: 'state', unit: '{state}' }],
  limits: [
    { point: 'value', kind: 'range', unit: 'Cel', min: 150, max: 260, modes: ['baking'], quote: 'Baking chamber temperature: 150 °C to 260 °C during baking.' },
    { point: 'setpoint', kind: 'range', unit: 'Cel', min: 160, max: 250, quote: 'Setpoint adjustable from 160 °C to 250 °C' },
    { point: 'setpoint', kind: 'rate', unit: 'Cel', maxStep: 20, quote: 'change the setpoint by no more than 20 °C at a time' },
    { point: 'value', kind: 'dwell', unit: 'Cel', max: 250, maxMinutes: 10, quote: 'The chamber must not stay above 250 °C for more than 10 minutes.' },
  ],
  redundancy: [{ a: 'value', b: 'probe', tolerance: 6, unit: 'Cel', quote: 'must agree with the control probe within 6 °C' }],
  responses: [{ setpoint: 'setpoint', value: 'value', withinMinutes: 15, deadband: 2, unit: 'Cel', quote: 'reaches the new setpoint within 15 minutes (±2 °C)' }],
  questions: ['Who may change the setpoint, and when?'],
  ...over,
});

describe('15.40.0 envelope drafter rules', () => {
  it('reads numbers as written, including U+2212 minus; hyphens between numbers are not signs', () => {
    expect(numbersIn('hold at −18 °C, between -25 and -18, 10-20 min, 2,5 bar')).toEqual([-18, -25, -18, 10, 20, 2.5]);
  });

  it('keeps every limit whose quote is verbatim and contains its numbers; lints clean', () => {
    const d = normalizeEnvelopeDraft(raw(), MANUAL, { model: 'm' });
    expect(d.dropped).toEqual([]);
    expect(d.draft.points.map((p) => p.id)).toEqual(['oven-3/value', 'oven-3/probe', 'oven-3/setpoint', 'oven-3/mode']);
    expect(d.draft.constraints.map((c) => c.kind)).toEqual(['range', 'range', 'rate', 'dwell', 'agreement', 'response']);
    expect(d.lint).toEqual([]); expect(d.ready).toBe(true);
    expect(d.needs).toEqual(['who may command oven-3/setpoint (an authority constraint with the operators\' keys — never drafted)', 'limits for oven-3/probe (none stated in the documents)']);
  });

  it('drops invented numbers, paraphrased quotes, unknown units and undeclared points — each with a reason', () => {
    const d = normalizeEnvelopeDraft(raw({ limits: [
      { point: 'setpoint', kind: 'range', unit: 'Cel', min: 160, max: 270, quote: 'Setpoint adjustable from 160 °C to 250 °C' },
      { point: 'value', kind: 'range', unit: 'Cel', min: 150, max: 260, quote: 'Chamber temp is 150 to 260 C' },
      { point: 'value', kind: 'range', unit: 'Celsius', max: 260, quote: 'Baking chamber temperature: 150 °C to 260 °C during baking.' },
      { point: 'door', kind: 'range', unit: 'Cel', max: 1, quote: 'x' },
      { point: 'value', kind: 'dwell', unit: 'Cel', max: 250, quote: 'The chamber must not stay above 250 °C for more than 10 minutes.' },
      { point: 'setpoint', kind: 'rate', unit: 'Cel', quote: 'change the setpoint by no more than 20 °C at a time' },
      { point: 'value', kind: 'range', unit: 'Cel', min: -18, quote: 'Freezer models: hold at −18 °C or colder.' },
    ], points: [...raw().points, { id: 'weird', kind: 'sensor' as never, unit: 'Cel' }, { id: 'p2', kind: 'measurement', unit: 'degrees' }] }), MANUAL, { model: 'm' });
    const reasons = d.dropped.map((x) => `${x.what}: ${x.because}`).join('\n');
    for (const s of ['number 270 is not in its quote', 'not in the documents verbatim', 'unit Celsius', 'point door was not proposed', 'dwell needs maxMinutes', 'rate needs maxStep', 'kind sensor', 'unit degrees']) expect(reasons).toContain(s);
    // kept: the −18 limit (verbatim, its number written with U+2212) plus the fixture's agreement and response
    expect(d.draft.constraints.map((c) => c.kind)).toEqual(['range', 'agreement', 'response']);
    expect((d.draft.constraints[0] as { min?: number }).min).toBe(-18);
    expect(d.needs.join()).toContain('the unit of oven-3/p2');
  });

  it('a quote is matched ignoring whitespace and case only', () => {
    const d = normalizeEnvelopeDraft(raw({ limits: [{ point: 'setpoint', kind: 'rate', unit: 'Cel', maxStep: 20, quote: 'CHANGE the setpoint   by no more than 20 °C\nat a time' }], redundancy: [], responses: [] }), MANUAL, { model: 'm' });
    expect(d.draft.constraints).toHaveLength(1);
  });

  it('the schema is strict JSON schema for structured output', () => {
    expect(ENVELOPE_DRAFT_SCHEMA.additionalProperties).toBe(false);
    expect(ENVELOPE_DRAFT_SCHEMA.required).toContain('limits');
  });
});

describe('15.40.0 shadow review and incident triage', () => {
  let k: Keys; let env: SignedEnvelope; const P = pointsOf(OVEN);
  beforeAll(async () => { k = await keys(); env = await deviceEnvelope(k, { profile: OVEN }); });

  it('review: ready points get the exact enforce command; credential signals mean investigate first', async () => {
    let t = Date.parse('2026-11-02T09:00:00Z');
    const g = createConstraintGuard({ envelope: () => env, now: () => t, gate: { minWrites: 4, minDays: 1, minCleanWrites: 3 } });
    await g.observe([{ at: t, point: P.setpoint, value: 200, source: 's' }]);
    await g.check({ kind: 'write', writes: [{ point: P.setpoint, value: 205 }], unmapped: [] }, { source: 'old-hmi' });
    for (let i = 0; i < 4; i++) { t += 9 * 3600_000; const v = i % 2 ? 200 : 205; await g.check({ kind: 'write', writes: [{ point: P.setpoint, value: v }], unmapped: [] }, { source: 'hmi', command: await signCommand({ envelopeId: env.envelopeId, point: P.setpoint, value: v, at: t }, k.technician) }); }
    await g.check({ kind: 'privileged', what: 'ReinitializeDevice' }, { source: 'x' });
    const rep = await g.report();
    const rv = reviewShadow(rep);
    expect(rv.other.join()).toContain('ReinitializeDevice');
    // the old unsigned write is history; the last clean writes meet the gate → enforce now, and the history still shows
    const ready = rv.points.find((p) => p.point === P.setpoint)!;
    expect(rep.points[P.setpoint].enforce.ready).toBe(true);
    expect(ready).toMatchObject({ advice: 'enforce-now', because: ['unsigned ×1'] });
    expect(ready.command).toBe(`constraint-wizard enforce --point ${P.setpoint} --report ${rep.reportHash} --reason "shadow clean: 5 writes over 1.5 days"`);
    expect(ready.actions[0]).toMatch(/signed commands/);
    // not ready → keep shadowing, with the gate's reasons
    const young = { ...rep, points: { ...rep.points, [P.setpoint]: { ...rep.points[P.setpoint], wouldRefuse: {}, enforce: { ready: false, because: ['0.5 of 7 days'] } } } };
    expect(reviewShadow(young).points.find((p) => p.point === P.setpoint)).toMatchObject({ advice: 'keep-shadow', because: ['0.5 of 7 days'] });
    // a replayed command makes it an investigation regardless of readiness
    const replayed = { ...rep, points: { ...rep.points, [P.setpoint]: { ...rep.points[P.setpoint], wouldRefuse: { replayed: 1 }, enforce: { ready: true, because: [] } } } };
    expect(reviewShadow(replayed).points.find((p) => p.point === P.setpoint)).toMatchObject({ advice: 'investigate' });
    const enforced = { ...rep, points: { ...rep.points, [P.setpoint]: { ...rep.points[P.setpoint], mode: 'enforce' as const } } };
    expect(reviewShadow(enforced).points.find((p) => p.point === P.setpoint)!.advice).toBe('enforced');
  });

  const obs = (point: string, m: number, value: number | string): Observation => ({ at: min(m), point, value, source: 'h' });
  const run = (valueAt: (m: number) => number, indepAt = valueAt) => { const o: Observation[] = [obs(P.mode, 0, 'baking')]; for (let m = 0; m <= 90; m += 5) o.push(obs(P.value, m, valueAt(m)), obs(P.independent, m, indepAt(m))); return o; };

  it('triage: an unexplained setpoint change followed by breaches is critical, with contain → notify actions', async () => {
    const r = await reconcileConstraints(env, { observations: run((m) => (m < 30 ? 200 : Math.min(200 + (m - 30) * 6, 380))), config: [obs(P.setpoint, 0, 200), obs(P.setpoint, 30, 400)] });
    const t = triageIncident(r);
    expect(t.severity).toBe('critical');
    expect(t.hypotheses[0]).toMatchObject({ confidence: 'strong' });
    expect(t.actions.map((a) => a.phase)).toEqual(['contain', 'preserve', 'verify', 'recover', 'notify']);
    expect(t.actions.find((a) => a.phase === 'notify')!.action).toMatch(/24 hours/);
    expect(t.affected).toContain(P.setpoint);
  });

  it('triage: disagreement alone is medium and says to verify; with a broken seal it is critical', async () => {
    const dis = await reconcileConstraints(env, { observations: run(() => 200, (m) => (m < 30 ? 200 : 200 + (m - 30))), config: [obs(P.setpoint, 0, 200)] });
    expect(triageIncident(dis)).toMatchObject({ severity: 'medium' });
    const broken = await reconcileConstraints(env, { observations: run(() => 200, (m) => (m < 30 ? 200 : 200 + (m - 30))), config: [obs(P.setpoint, 0, 200)] }, { integrity: { state: 'sealed-broken', because: 'batch 3 changed' } });
    const t = triageIncident(broken);
    expect(t.severity).toBe('critical'); expect(t.hypotheses.some((h) => /falsified/.test(h.meaning))).toBe(true);
  });

  it('triage: nothing found is none; gaps only is low', async () => {
    expect(triageIncident(await reconcileConstraints(env, { observations: run(() => 200), config: [obs(P.setpoint, 0, 200)] })).severity).toBe('none');
    expect(triageIncident(await reconcileConstraints(env, { observations: [] })).severity).toBe('low');
  });

  it('advice is signed and verifiable; any change breaks it', () => {
    const seed = '11'.repeat(32);
    const s = signAdvice({ kind: 'x', n: 1 }, seed);
    expect(verifyAdvice(s)).toBe(true); expect(verifyAdvice(s, s.signature.publicKey)).toBe(true);
    expect(verifyAdvice({ ...s, advice: { kind: 'x', n: 2 } })).toBe(false);
    expect(verifyAdvice(s, '00'.repeat(32))).toBe(false);
  });
});
