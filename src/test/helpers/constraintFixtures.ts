/**
 * A generic setpoint-controlled device for constraint tests: one measured
 * value, an independent sensor of the same quantity, a setpoint and an
 * operating mode. Profiles (a freezer, an oven, a dosing pump …) are data;
 * every scenario runs against any profile.
 */
import { generateSigningKey, type SigningKey } from '../../lib/sync/helloSignature';
import { declareEnvelope, type Constraint, type ConstraintPoint, type SignedEnvelope } from '../../lib/constraints/envelope';

export const T0 = Date.parse('2026-11-02T01:00:00Z'); // a Monday, 01:00 UTC
export const min = (n: number) => T0 + n * 60_000;

export interface Keys { opA: SigningKey; opB: SigningKey; opC: SigningKey; technician: SigningKey; stranger: SigningKey; collector: SigningKey }
export async function keys(): Promise<Keys> {
  const [opA, opB, opC, technician, stranger, collector] = await Promise.all(Array.from({ length: 6 }, () => generateSigningKey()));
  return { opA, opB, opC, technician, stranger, collector };
}

export interface DeviceProfile {
  /** Device id; point ids are `<id>/value`, `<id>/value-independent`, `<id>/setpoint`, `<id>/mode`. */
  id: string;
  unit: string;
  /** The mode the value band applies in. */
  runMode: string;
  /** Value band while running. */
  value: { min: number; max: number };
  setpoint: { min: number; max: number; maxStep: number };
  /** Band the value may leave only briefly. */
  dwell: { min?: number; max?: number; maxMs: number };
  agreeTolerance: number;
  response: { withinMs: number; deadband: number; minChange: number };
  /** Normal operating value and setpoint. */
  nominal: number;
  /** A legitimate setpoint change (within one step and the range) and how fast the value follows (units per minute). */
  change: { to: number; ratePerMin: number };
  /** What an attacker drives the setpoint to (outside the range), how fast the value then drifts per minute, and where it levels off. */
  attack: { to: number; driftPerMin: number; limit: number };
}

export const FREEZER: DeviceProfile = {
  id: 'freezer-1', unit: 'Cel', runMode: 'normal',
  value: { min: -30, max: -15 }, setpoint: { min: -25, max: -18, maxStep: 3 }, dwell: { max: -18, maxMs: 15 * 60_000 },
  agreeTolerance: 2, response: { withinMs: 20 * 60_000, deadband: 0.5, minChange: 1 },
  nominal: -22, change: { to: -24, ratePerMin: -0.2 }, attack: { to: 50, driftPerMin: 0.8, limit: 20 },
};

export const OVEN: DeviceProfile = {
  id: 'oven-3', unit: 'Cel', runMode: 'baking',
  value: { min: 150, max: 260 }, setpoint: { min: 160, max: 250, maxStep: 20 }, dwell: { min: 160, max: 250, maxMs: 10 * 60_000 },
  agreeTolerance: 6, response: { withinMs: 15 * 60_000, deadband: 2, minChange: 5 },
  nominal: 200, change: { to: 215, ratePerMin: 1.5 }, attack: { to: 400, driftPerMin: 6, limit: 380 },
};

export const PROFILES = [FREEZER, OVEN];

export const pointsOf = (d: DeviceProfile = FREEZER) => ({ value: `${d.id}/value`, independent: `${d.id}/value-independent`, setpoint: `${d.id}/setpoint`, mode: `${d.id}/mode` });
export const envelopeIdOf = (d: DeviceProfile = FREEZER) => `site-17/${d.id}`;

export function devicePoints(d: DeviceProfile = FREEZER): ConstraintPoint[] {
  const P = pointsOf(d);
  return [
    { id: P.value, kind: 'measurement', unit: d.unit, maxGapMs: 10 * 60_000 },
    { id: P.independent, kind: 'measurement', unit: d.unit },
    { id: P.setpoint, kind: 'setpoint', unit: d.unit, failMode: 'hold-last-good' },
    { id: P.mode, kind: 'state', unit: '{state}' },
  ];
}

export function deviceConstraints(technicianKey: string, extra: Constraint[] = [], d: DeviceProfile = FREEZER): Constraint[] {
  const P = pointsOf(d);
  return [
    { id: 'value-range', kind: 'range', points: [P.value], min: d.value.min, max: d.value.max, unit: d.unit, modes: [d.runMode] },
    { id: 'setpoint-range', kind: 'range', points: [P.setpoint], min: d.setpoint.min, max: d.setpoint.max, unit: d.unit },
    { id: 'setpoint-step', kind: 'rate', points: [P.setpoint], maxStep: d.setpoint.maxStep, unit: d.unit },
    { id: 'value-dwell', kind: 'dwell', points: [P.value], ...d.dwell, unit: d.unit },
    { id: 'value-agree', kind: 'agreement', points: [P.value, P.independent], tolerance: d.agreeTolerance, unit: d.unit, maxSkewMs: 120_000 },
    { id: 'setpoint-follows', kind: 'response', points: [P.setpoint, P.value], unit: d.unit, ...d.response },
    { id: 'who', kind: 'authority', points: [P.setpoint], grants: [{ publicKey: technicianKey, points: [P.setpoint], label: 'service technician' }] },
    ...extra,
  ];
}

export async function deviceEnvelope(k: Keys, o: { profile?: DeviceProfile; version?: number; supersedes?: string | null; constraints?: Constraint[]; at?: number; signer?: SigningKey; coolingMs?: number } = {}): Promise<SignedEnvelope> {
  const d = o.profile ?? FREEZER;
  return declareEnvelope({
    envelopeId: envelopeIdOf(d), asset: `m/44'/144'/25'/sites/17/${d.id}`, version: o.version ?? 1, supersedes: o.supersedes ?? null,
    points: devicePoints(d), constraints: o.constraints ?? deviceConstraints(k.technician.publicKeyHex, [], d), modePoint: pointsOf(d).mode,
    declaredAt: new Date(o.at ?? T0 - 86_400_000 * 10).toISOString(), coolingMs: o.coolingMs,
  }, o.signer ?? k.opA);
}
