import { describe, it, expect, beforeAll } from 'vitest';
import { clockObservations, distanceM, navigationObservations, vehicleEnvelope, navPoints, type PositionFix } from '../lib/constraints/vehicle';
import { declareEnvelope, lintEnvelope, type SignedEnvelope } from '../lib/constraints/envelope';
import { reconcileConstraints, type Observation } from '../lib/constraints/reconcile';
import { triageIncident } from '../lib/constraints/advisor';
import { createConstraintGuard } from '../lib/constraints/guard';
import { generateSigningKey, type SigningKey } from '../lib/sync/helloSignature';

const T = Date.parse('2026-11-13T02:00:00Z');
const NM = 1852;
// Cruise due east along 3°N at 240 m/s (≈ 467 kt): longitude advances 240 / (111 320·cos 3°) degrees per second.
const lonPerS = 240 / (111_320 * Math.cos((3 * Math.PI) / 180));
const truth = (s: number) => ({ lat: 3, lon: -30 + s * lonPerS });
const north = (p: { lat: number; lon: number }, m: number) => ({ lat: p.lat + m / 111_195, lon: p.lon });

function flight(o: { gnss?: (s: number, p: { lat: number; lon: number }) => { lat: number; lon: number }; seconds?: number } = {}): PositionFix[] {
  const out: PositionFix[] = [];
  for (let s = 0; s <= (o.seconds ?? 1200); s += 5) {
    const p = truth(s);
    out.push({ at: T + s * 1000, source: 'gnss', ...(o.gnss ? o.gnss(s, p) : p) });
    out.push({ at: T + s * 1000 + 200, source: 'irs', ...north(p, 0.5 * s) }); // inertial drift ≈ 0.5 m/s
    out.push({ at: T + s * 1000 + 400, source: 'dme', ...north(p, 150 * Math.sin(s / 60)) }); // radio-nav noise ±150 m
  }
  return out;
}

let key: SigningKey; let env: SignedEnvelope;
const spec = { vehicle: 'f-gzcp', positionSources: ['gnss', 'irs', 'dme'], maxSeparationM: 2 * NM, separationPersistMs: 60_000, maxOffsetM: 2 * NM, maxImpliedSpeedMs: 350, timeSources: ['gnss'], maxClockOffsetS: 1 };
beforeAll(async () => {
  key = await generateSigningKey();
  const v = vehicleEnvelope(spec);
  env = await declareEnvelope({ envelopeId: 'aircraft/f-gzcp/nav', asset: 'aircraft/f-gzcp', version: 1, supersedes: null, ...v }, key);
});
const recon = (obs: Observation[]) => reconcileConstraints(env, { observations: obs });

describe('15.40.0 vehicle navigation integrity (advisory)', () => {
  it('distance is the great-circle distance', () => {
    expect(distanceM({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeCloseTo(111_195, -1);
    expect(distanceM({ lat: 51.47, lon: -0.4543 }, { lat: 49.0097, lon: 2.5479 })).toBeCloseTo(347_500, -4); // LHR → CDG
  });

  it('the envelope is advisory, lints clean, and never authorises an inline write', async () => {
    const v = vehicleEnvelope(spec);
    expect(v.advisory).toBe(true);
    expect(lintEnvelope(v)).toEqual([]);
    expect(v.constraints.map((c) => c.id)).toEqual(['nav-separation', 'nav-offset', 'nav-implied-speed', 'time-offset']);
    const g = createConstraintGuard({ envelope: () => env, mode: 'enforce' });
    const p = navPoints('f-gzcp', []).offset('gnss');
    expect((await g.check({ kind: 'write', writes: [{ point: p, value: 1 }], unmapped: [] }, { source: 'x' })).reasons.map((r) => r.reason)).toContain('advisory-envelope');
    expect(vehicleEnvelope({ vehicle: 'x' }).constraints).toEqual([]); // nothing is defaulted
  });

  it('a clean flight is clean: inertial drift and radio-nav noise stay inside the operator\'s limits', async () => {
    const r = await recon(navigationObservations('f-gzcp', flight(), { maxAgeMs: 2000 }));
    expect(r.counts['out-of-envelope']).toBe(0);
  });

  it('GNSS spoofing that walks the position off course is named: GNSS is far from both other sources, they agree with each other', async () => {
    // from t = 300 s the spoofer drags the GNSS position north at 15 m/s
    const r = await recon(navigationObservations('f-gzcp', flight({ gnss: (s, p) => (s < 300 ? p : north(p, 15 * (s - 300))) }), { maxAgeMs: 2000 }));
    const P = navPoints('f-gzcp', []);
    const out = r.findings.filter((f) => f.state === 'out-of-envelope').map((f) => f.point).sort();
    expect(out).toEqual([P.offset('gnss'), P.separation('dme', 'gnss'), P.separation('gnss', 'irs')].sort());
    const first = r.findings.find((f) => f.point === P.offset('gnss'))!;
    expect(Date.parse(first.at) - T).toBeGreaterThan(300_000); expect(Date.parse(first.at) - T).toBeLessThan(600_000); // within minutes of onset
    const t = triageIncident(r);
    expect(t.severity).toBe('medium'); expect(t.affected).toContain(P.offset('gnss'));
  });

  it('a GNSS jump shows as an impossible implied speed on that source only', async () => {
    const r = await recon(navigationObservations('f-gzcp', flight({ gnss: (s, p) => (s >= 600 && s < 605 ? north(p, 50_000) : p) }), { maxAgeMs: 2000 }));
    const speed = r.findings.filter((f) => f.constraintId === 'nav-implied-speed');
    expect(speed.map((f) => f.point)).toEqual([navPoints('f-gzcp', []).impliedSpeed('gnss')]);
  });

  it('a shifted GNSS clock is a time-offset breach', async () => {
    const fixes = Array.from({ length: 60 }, (_, i) => ({ at: T + i * 10_000, source: 'gnss', local: T + i * 10_000, time: T + i * 10_000 + (i > 30 ? (i - 30) * 500 : 0) }));
    const r = await reconcileConstraints(env, { observations: [...clockObservations('f-gzcp', fixes), ...navigationObservations('f-gzcp', flight({ seconds: 590 }), { maxAgeMs: 2000 })] });
    expect(r.findings.filter((f) => f.constraintId === 'time-offset')).toHaveLength(1);
  });

  it('two sources only: separation is checked, the spoofed one cannot be named', async () => {
    const v = vehicleEnvelope({ vehicle: 'ship-1', positionSources: ['gnss', 'radar'], maxSeparationM: 500, maxOffsetM: 500 });
    expect(v.constraints.map((c) => c.id)).toEqual(['nav-separation']); // offset needs three sources
  });

  it('bad or impossible fixes are ignored', () => {
    const obs = navigationObservations('v', [{ at: T, source: 'a', lat: 91, lon: 0 }, { at: T, source: 'b', lat: 0, lon: 0, quality: 'bad' }, { at: NaN, source: 'c', lat: 0, lon: 0 }, { at: T, source: 'd', lat: 0, lon: 0 }], { maxAgeMs: 1000 });
    expect(obs).toEqual([]);
  });
});
