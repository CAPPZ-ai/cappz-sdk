import { describe, it, expect, beforeAll } from 'vitest';
import { reconcileConstraints, type CommandRecord, type Observation } from '../lib/constraints/reconcile';
import { signCommand } from '../lib/constraints/authority';
import { declareEnvelope, type SignedEnvelope } from '../lib/constraints/envelope';
import { openSealedObservations, sealObservationBatch } from '../lib/constraints/seal';
import { deviceEnvelope, keys, min, pointsOf, FREEZER, PROFILES, type DeviceProfile, type Keys } from './helpers/constraintFixtures';

const P = pointsOf();

let k: Keys; let env: SignedEnvelope;
beforeAll(async () => { k = await keys(); env = await deviceEnvelope(k); });

const obs = (point: string, at: number, value: number | string, extra: Partial<Observation> = {}): Observation => ({ at, point, value, source: 'historian', ...extra });
/** A steady run of any device: value sampled every 5 min by both sensors, in its run mode. */
function steadyRun(d: DeviceProfile, minutes = 120, valueAt = (_m: number) => d.nominal, indepAt = valueAt): Observation[] {
  const Q = pointsOf(d);
  const out: Observation[] = [obs(Q.mode, min(0), d.runMode)];
  for (let m = 0; m <= minutes; m += 5) out.push(obs(Q.value, min(m), valueAt(m)), obs(Q.independent, min(m) + 10_000, indepAt(m)));
  return out;
}
const setpointsOf = (d: DeviceProfile, pairs: Array<[number, number]>) => pairs.map(([m, v]) => obs(pointsOf(d).setpoint, min(m), v, { source: 'controller-readback' }));
/** The default (freezer) profile, used where a scenario needs concrete numbers. */
const normalNight = (minutes = 120, valueAt?: (m: number) => number, indepAt?: (m: number) => number) => steadyRun(FREEZER, minutes, valueAt, indepAt);
const setpoints = (pairs: Array<[number, number]>) => setpointsOf(FREEZER, pairs);

describe.each(PROFILES.map((d) => [d.id, d] as const))('15.40.0 constraint reconciliation — any setpoint device (%s)', (_id, d) => {
  const Q = pointsOf(d);
  let e: SignedEnvelope;
  beforeAll(async () => { e = await deviceEnvelope(k, { profile: d }); });
  const toward = (target: number, ratePerMin: number, from: number, startMin: number) => (m: number) => {
    if (m < startMin) return d.nominal;
    const v = d.nominal + Math.sign(target - d.nominal) * Math.abs(ratePerMin) * (m - startMin);
    return target > d.nominal ? Math.min(v, target) : Math.max(v, target);
  };
  const cmdAt = async (value: number, at: number, key = k.technician) => ({ at, point: Q.setpoint, value, command: await signCommand({ envelopeId: e.envelopeId, point: Q.setpoint, value, at }, key), source: 'bms' }) as CommandRecord;

  it('a setpoint changed from outside, with no signed command, is an orphan change — even with no guard inline', async () => {
    const drift = toward(d.attack.limit, d.attack.driftPerMin, d.nominal, 60);
    const r = await reconcileConstraints(e, { observations: steadyRun(d, 120, drift), config: setpointsOf(d, [[0, d.nominal], [60, d.attack.to]]) });
    expect(r.verdict).toBe('findings');
    const orphan = r.findings.find((f) => f.state === 'orphan-change')!;
    expect(orphan).toMatchObject({ point: Q.setpoint, value: d.attack.to, at: new Date(min(60)).toISOString() });
    expect(orphan.because).toMatch(/no authorised command/);
    // and the envelope breaches it caused, each once per excursion
    const breaches = r.findings.filter((f) => f.state === 'out-of-envelope').map((f) => f.constraintId).sort();
    expect(breaches).toEqual(['setpoint-range', 'setpoint-step', 'value-dwell', 'value-range']);
    expect(r.summary).toMatch(/change\(s\) without an authorised command/);
    expect(r.reportHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the technician\'s signed change is matched, and its effect is checked', async () => {
    const r = await reconcileConstraints(e, { observations: steadyRun(d, 120, toward(d.change.to, d.change.ratePerMin, d.nominal, 30)), config: setpointsOf(d, [[0, d.nominal], [30, d.change.to]]), commands: [await cmdAt(d.change.to, min(29))] });
    expect(r.counts.matched).toBe(1);
    expect(r.verdict).toBe('clean');
    expect(r.summary).toMatch(/^all 1 setpoint change\(s\) matched/);
  });

  it('a change accounted for only by a refused command says so', async () => {
    const r = await reconcileConstraints(e, { observations: steadyRun(d, 120, toward(d.change.to, d.change.ratePerMin, d.nominal, 30)), config: setpointsOf(d, [[0, d.nominal], [30, d.change.to]]), commands: [await cmdAt(d.change.to, min(29), k.stranger)] });
    expect(r.findings.find((f) => f.state === 'unauthorized-command')).toMatchObject({ authorization: 'not-granted' });
    expect(r.findings.find((f) => f.state === 'orphan-change')!.because).toMatch(/failed authorisation \(not-granted\)/);
  });

  it('one signed command accounts for one change; replaying it does not cover a second', async () => {
    const c = await cmdAt(d.change.to, min(9));
    const r = await reconcileConstraints(e, { observations: steadyRun(d, 60), config: setpointsOf(d, [[0, d.nominal], [10, d.change.to], [11, d.nominal], [12, d.change.to]]), commands: [c, { ...c, at: min(11), source: 'attacker' }] });
    expect(r.findings.find((f) => f.state === 'unauthorized-command')).toMatchObject({ authorization: 'replayed', source: 'attacker' });
    expect(r.counts.matched).toBe(1);
    expect(r.counts['orphan-change']).toBe(2);
  });

  it('a reading that contradicts the independent sensor is a disagreement (the logger was tampered with)', async () => {
    // the attacker rewrites what the controller reports (nominal) while the independent sensor sees the drift
    const r = await reconcileConstraints(e, { observations: steadyRun(d, 120, () => d.nominal, toward(d.attack.limit, d.attack.driftPerMin / 3, d.nominal, 60)), config: setpointsOf(d, [[0, d.nominal]]) });
    const dis = r.findings.find((f) => f.state === 'disagreement')!;
    expect(dis.point).toBe(`${Q.value}|${Q.independent}`);
    expect(dis.because).toMatch(/no majority/); // two sources: which one is right cannot be told from these alone
    expect(r.findings.find((f) => f.state === 'out-of-envelope')).toBeUndefined(); // the controller's own (forged) numbers look fine
  });

  it('a setpoint change the value does not follow is no-response; the wrong way is called out', async () => {
    const commands = [await cmdAt(d.change.to, min(29))]; const config = setpointsOf(d, [[0, d.nominal], [30, d.change.to]]);
    const flat = await reconcileConstraints(e, { observations: steadyRun(d, 120), config, commands });
    expect(flat.findings.find((f) => f.state === 'no-response')!.because).toMatch(/moved only/);
    const away = d.nominal - Math.sign(d.change.to - d.nominal) * 2 * d.response.minChange;
    const wrong = await reconcileConstraints(e, { observations: steadyRun(d, 120, toward(away, d.response.minChange / 5, d.nominal, 30)), config, commands });
    expect(wrong.findings.find((f) => f.state === 'no-response')!.because).toMatch(/other way/);
  });

  it('consecutive in-step commands after one read-back agree with the guard: each step is measured from the last authorised value', async () => {
    const s1 = d.nominal + Math.sign(d.change.to - d.nominal) * d.setpoint.maxStep * 0.9;
    const s2 = s1 + Math.sign(d.change.to - d.nominal) * d.setpoint.maxStep * 0.9;
    const target = Math.max(d.setpoint.min, Math.min(d.setpoint.max, s2));
    const r = await reconcileConstraints(e, { observations: steadyRun(d, 30), config: setpointsOf(d, [[0, d.nominal]]), commands: [await cmdAt(s1, min(10)), await cmdAt(target, min(12))] });
    expect(r.counts['unauthorized-command']).toBe(0);
    // a jump bigger than one step from the last authorised value is still refused
    const far = d.nominal + Math.sign(d.change.to - d.nominal) * d.setpoint.maxStep * 0.9;
    const r2 = await reconcileConstraints(e, { observations: steadyRun(d, 30), config: setpointsOf(d, [[0, d.nominal]]), commands: [await cmdAt(far, min(10)), await cmdAt(d.nominal - (far - d.nominal), min(12))] });
    expect(r2.findings.find((f) => f.state === 'unauthorized-command')?.authorization).toMatch(/step-too-large|out-of-range/);
  });

  it('a response window that runs past the data is not evaluated, not passed', async () => {
    const r = await reconcileConstraints(e, { observations: steadyRun(d, 120), config: setpointsOf(d, [[0, d.nominal], [110, d.change.to]]), commands: [await cmdAt(d.change.to, min(109))] });
    expect(r.findings.find((f) => f.constraintId === 'setpoint-follows')).toMatchObject({ state: 'not-evaluated' });
    expect(r.verdict).toBe('gaps-only');
  });
});

describe('15.40.0 constraint reconciliation — gaps are never clean', () => {
  it('silence beyond maxGapMs is stale, measured from the period edges too', async () => {
    const o = normalNight(120).filter((x) => !(x.point === P.value && x.at > min(30) && x.at < min(90)));
    const r = await reconcileConstraints(env, { observations: o, config: setpoints([[0, -22]]) }, { period: { from: min(0), to: min(140) } });
    const stale = r.findings.filter((f) => f.state === 'stale' && f.point === P.value);
    expect(stale.map((f) => [f.at, f.until])).toEqual([[new Date(min(30)).toISOString(), new Date(min(90)).toISOString()], [new Date(min(120)).toISOString(), new Date(min(140)).toISOString()]]);
    expect(r.verdict).toBe('gaps-only');
  });

  it('unmapped tags, points without data, bad-quality-only data and units that do not convert each count', async () => {
    const o = [obs(P.mode, min(0), 'normal'), obs('device-9/value', min(1), -20), obs(P.value, min(1), -20, { quality: 'bad' }), obs(P.independent, min(1), 5, { unit: 'kPa' })];
    const r = await reconcileConstraints(env, { observations: o });
    expect(r.findings.find((f) => f.state === 'unmapped')).toMatchObject({ point: 'device-9/value' });
    expect(r.findings.find((f) => f.state === 'not-evaluated' && f.point === P.independent)!.because).toMatch(/kPa/);
    expect(r.findings.find((f) => f.state === 'outside-coverage' && f.point === P.value)!.because).toMatch(/bad quality/);
    expect(r.findings.find((f) => f.state === 'outside-coverage' && f.point === P.setpoint)!.because).toMatch(/no data/);
    expect(r.verdict).toBe('gaps-only');
  });

  it('mode-scoped limits are not evaluated while the mode is unknown, and pause outside their modes', async () => {
    const warm = normalNight(60, (m) => (m >= 20 && m <= 40 ? -10 : -22)).filter((x) => x.point !== P.mode);
    const unknown = await reconcileConstraints(env, { observations: warm, config: setpoints([[0, -22]]) });
    expect(unknown.findings.some((f) => f.state === 'not-evaluated' && f.constraintId === 'value-range')).toBe(true);
    const defrost = await reconcileConstraints(env, { observations: [...warm, obs(P.mode, min(0), 'normal'), obs(P.mode, min(15), 'defrost'), obs(P.mode, min(45), 'normal')], config: setpoints([[0, -22]]) });
    expect(defrost.findings.some((f) => f.constraintId === 'value-range')).toBe(false); // defrost: air-range does not apply
    expect(defrost.findings.some((f) => f.constraintId === 'value-dwell')).toBe(true); // the dwell applies in every mode: 25 min above −18
  });

  it('values in another unit are converted before comparing', async () => {
    const f = normalNight(60).map((x) => (x.point === P.value && typeof x.value === 'number' ? { ...x, value: x.value * 9 / 5 + 32, unit: '[degF]' } : x));
    const r = await reconcileConstraints(env, { observations: f, config: setpoints([[0, -22]]) });
    expect(r.verdict).toBe('clean');
  });

  it('the report is deterministic and caps rows, never counts', async () => {
    const many: Observation[] = [obs(P.mode, min(0), 'normal')];
    for (let m = 0; m < 600; m++) many.push(obs(P.value, min(m), m % 2 ? -22 : 0), obs(P.independent, min(m), -22));
    const a = await reconcileConstraints(env, { observations: many, config: setpoints([[0, -22]]) }, { maxRows: 10 });
    const b = await reconcileConstraints(env, { observations: [...many].reverse(), config: setpoints([[0, -22]]) }, { maxRows: 10 });
    expect(a.findings.length).toBe(10);
    expect(a.counts['out-of-envelope']).toBeGreaterThan(200);
    expect(a.counts).toEqual(b.counts);
  });

  it('non-finite timestamps are ignored and an empty input is all gaps', async () => {
    const r = await reconcileConstraints(env, { observations: [obs(P.value, NaN, -22)] });
    expect(r.verdict).toBe('gaps-only');
    expect(r.counts['outside-coverage']).toBeGreaterThan(0);
  });
});

describe('15.40.0 rate and agreement edge cases', () => {
  it('a measurement rate limit flags one run, not every sample', async () => {
    const e = await declareEnvelope({ envelopeId: 'pump', asset: 'pump', version: 1, supersedes: null, points: [{ id: 'p', kind: 'measurement', unit: 'kPa' }], constraints: [{ id: 'ramp', kind: 'rate', points: ['p'], unit: 'kPa', maxDelta: 10, perMs: 60_000 }] }, k.opA);
    const s = [0, 5, 10, 60, 120, 180, 185, 190].map((v, i) => obs('p', min(i), v));
    const r = await reconcileConstraints(e, { observations: s });
    expect(r.counts['out-of-envelope']).toBe(1);
    expect(r.findings[0].because).toMatch(/per 60 s/);
  });

  it('triplex air data: a majority names the outlier, persistence filters a blip', async () => {
    const e = await declareEnvelope({ envelopeId: 'adc', asset: 'aircraft/air-data', version: 1, supersedes: null, advisory: true,
      points: ['ias-1', 'ias-2', 'ias-3'].map((id) => ({ id, kind: 'measurement' as const, unit: '[kn_i]' })),
      constraints: [{ id: 'ias-agree', kind: 'agreement', points: ['ias-1', 'ias-2', 'ias-3'], unit: '[kn_i]', tolerance: 15, maxSkewMs: 1500, persistMs: 3000 }] }, k.opA);
    const s: Observation[] = [];
    for (let t = 0; t < 60; t++) {
      const at = min(0) + t * 1000;
      s.push(obs('ias-1', at, 275), obs('ias-2', at, t >= 20 && t < 50 ? 80 : 276), obs('ias-3', at, t === 5 ? 200 : 274));
    }
    const r = await reconcileConstraints(e, { observations: s });
    const d = r.findings.filter((f) => f.state === 'disagreement');
    expect(d).toHaveLength(1); // the 1-second blip on ias-3 does not count
    expect(d[0].outliers).toEqual(['ias-2']);
    expect(r.envelope.advisory).toBe(true);
  });

  it('two of three iced together: no majority within tolerance is reported as such', async () => {
    const e = await declareEnvelope({ envelopeId: 'adc', asset: 'a', version: 1, supersedes: null,
      points: ['a', 'b', 'c'].map((id) => ({ id, kind: 'measurement' as const, unit: '[kn_i]' })),
      constraints: [{ id: 'agree', kind: 'agreement', points: ['a', 'b', 'c'], unit: '[kn_i]', tolerance: 10 }] }, k.opA);
    const r = await reconcileConstraints(e, { observations: [obs('a', min(0), 275), obs('b', min(0), 150), obs('c', min(0), 60)] });
    expect(r.findings[0]).toMatchObject({ state: 'disagreement' });
    expect(r.findings[0].outliers).toBeUndefined();
  });

  it('stale sources drop out of the comparison instead of being compared with old values', async () => {
    const e = await declareEnvelope({ envelopeId: 'x', asset: 'x', version: 1, supersedes: null,
      points: ['a', 'b'].map((id) => ({ id, kind: 'measurement' as const, unit: 'Cel' })),
      constraints: [{ id: 'agree', kind: 'agreement', points: ['a', 'b'], unit: 'Cel', tolerance: 1, maxSkewMs: 60_000 }] }, k.opA);
    const r = await reconcileConstraints(e, { observations: [obs('a', min(0), 5), obs('b', min(0), 5), obs('a', min(10), 20)] });
    expect(r.counts.disagreement).toBe(0);
  });
});

describe('15.40.0 sealed observations', () => {
  it('a chain verifies; an edit, a removed batch, a reorder or a foreign key breaks it', async () => {
    const night = normalNight(60);
    const b0 = await sealObservationBatch(night.slice(0, 10), { collector: 'store-17/edge-1', previous: null, key: k.collector });
    const b1 = await sealObservationBatch(night.slice(10, 20), { collector: 'store-17/edge-1', previous: b0, key: k.collector });
    const b2 = await sealObservationBatch(night.slice(20), { collector: 'store-17/edge-1', previous: b1, key: k.collector });
    const ok = await openSealedObservations([b2, b0, b1], [k.collector.publicKeyHex]);
    expect(ok.integrity.state).toBe('sealed-verified');
    expect(ok.observations).toHaveLength(night.length);

    const edited = { ...b1, items: b1.items.map((x, i) => (i === 0 ? { ...x, value: -40 } : x)) };
    expect((await openSealedObservations([b0, edited, b2], [k.collector.publicKeyHex])).integrity.because).toMatch(/changed after sealing/);
    expect((await openSealedObservations([b0, b2], [k.collector.publicKeyHex])).integrity.because).toMatch(/chain broken/);
    expect((await openSealedObservations([b0, b1, b2], [k.stranger.publicKeyHex])).integrity.because).toMatch(/not a trusted collector/);
    const reSigned = await sealObservationBatch(b1.items, { collector: 'store-17/edge-1', previous: null, key: k.collector });
    expect((await openSealedObservations([b0, { ...reSigned, seq: 1 }, b2], [k.collector.publicKeyHex])).integrity.state).toBe('sealed-broken');

    const broken = await openSealedObservations([b0, edited, b2], [k.collector.publicKeyHex]);
    const r = await reconcileConstraints(env, { observations: broken.observations, config: setpoints([[0, -22]]) }, { integrity: broken.integrity });
    expect(r.verdict).toBe('findings');
    expect(r.summary).toMatch(/sealed record is broken/);
  });

  it('unsealed data says so in the report', async () => {
    const r = await reconcileConstraints(env, { observations: normalNight(30), config: setpoints([[0, -22]]) });
    expect(r.integrity.state).toBe('unsealed');
  });
});
