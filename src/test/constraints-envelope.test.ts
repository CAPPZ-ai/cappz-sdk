import { describe, it, expect, beforeAll } from 'vitest';
import { convert, convertDelta, UNITS } from '../lib/constraints/units';
import { CONSTRAINT_KINDS, declareEnvelope, endorseEnvelope, inWindows, lintEnvelope, looserThan, replayEnvelopes, revokeEnvelope, verifyEnvelope, type Constraint, type SignedEnvelope } from '../lib/constraints/envelope';
import { authorize, signCommand, COMMAND_MAX_TTL_MS } from '../lib/constraints/authority';
import { declareKey, revokeKeyDeclaration } from '../lib/identity/keyDeclaration';
import { generateRecoveryPhrase, keyPairFromPhrase } from '../lib/auth/wallet/session';
import { deviceConstraints, deviceEnvelope, devicePoints, keys, min, T0, type Keys, pointsOf, envelopeIdOf } from './helpers/constraintFixtures';

const P = pointsOf(); const ENV_ID = envelopeIdOf();

let k: Keys;
beforeAll(async () => { k = await keys(); });

describe('15.40.0 constraint units', () => {
  it('converts temperatures with offsets and differences without them', () => {
    expect(convert(-18, 'Cel', '[degF]')).toBeCloseTo(-0.4, 6);
    expect(convert(32, '[degF]', 'Cel')).toBeCloseTo(0, 9);
    expect(convert(0, 'Cel', 'K')).toBeCloseTo(273.15, 9);
    expect(convertDelta(9, '[degF]', 'Cel')).toBeCloseTo(5, 9);
    expect(convertDelta(1, 'Cel', 'K')).toBe(1);
  });
  it('refuses to compare across dimensions or with unknown codes', () => {
    expect(convert(1, 'kPa', 'Cel')).toBeNull();
    expect(convert(1, 'Celsius', 'Cel')).toBeNull();
    expect(convert(NaN, 'Cel', 'Cel')).toBeNull();
    expect(convert(Infinity, 'Cel', 'K')).toBeNull();
    expect(convertDelta(1, 'm', '[kn_i]')).toBeNull();
  });
  it('covers aviation and process units', () => {
    expect(convert(100, '[kn_i]', 'm/s')).toBeCloseTo(51.444, 3);
    expect(convert(35000, '[ft_i]', 'm')).toBeCloseTo(10668, 0);
    expect(convert(1, 'bar', '[psi]')).toBeCloseTo(14.5038, 3);
    expect(Object.keys(UNITS).length).toBeGreaterThan(50);
  });
});

describe('15.40.0 constraint envelopes', () => {
  it('kinds are registry accounts with vendor-neutral addresses', () => {
    expect(CONSTRAINT_KINDS.map((x) => x.id)).toEqual(['range', 'rate', 'dwell', 'agreement', 'response', 'authority', 'schedule']);
    for (const x of CONSTRAINT_KINDS) expect(x.address).toBe(`cappz/config/constraint-kinds/${x.id}`);
  });

  it('lint finds every structural problem instead of declaring a broken envelope', async () => {
    const bad: Constraint[] = [
      { id: 'r', kind: 'range', points: ['nope'], unit: 'Cel' },
      { id: 'r', kind: 'range', points: [P.value], min: 5, max: 1, unit: 'kPa' },
      { id: 'a', kind: 'agreement', points: [P.value], tolerance: 1, unit: 'Cel' },
      { id: 'resp', kind: 'response', points: [P.value], unit: 'Cel', withinMs: 1, deadband: 0 },
      { id: 'rate', kind: 'rate', points: [P.value], unit: 'Cel' },
      { id: 'sch', kind: 'schedule', points: [P.setpoint], windows: [{ days: [7], from: '7:00', to: '19:00' }] },
      { id: 'auth', kind: 'authority', points: [P.setpoint], grants: [] },
    ];
    const problems = lintEnvelope({ points: [...devicePoints(), { id: P.value, kind: 'measurement', unit: 'Celsius' }], constraints: bad, modePoint: 'missing' });
    const text = problems.join('\n');
    for (const s of ['declared twice', 'unknown unit Celsius', 'modePoint missing', 'point nope is not declared', 'min is above max', 'does not convert to kPa', 'at least two sources', 'exactly [command point', 'maxStep, or maxDelta', 'HH:MM', '0 (Sunday)', 'no grants']) expect(text).toContain(s);
    await expect(declareEnvelope({ envelopeId: 'x', asset: 'x', version: 1, supersedes: null, points: devicePoints(), constraints: bad }, k.opA)).rejects.toThrow(/not declared/);
  });

  it('signs and verifies; any change after signing is caught', async () => {
    const e = await deviceEnvelope(k);
    expect(await verifyEnvelope(e)).toBe('valid');
    const edited = { ...e, constraints: e.constraints.map((c) => (c.id === 'setpoint-range' ? { ...c, max: 40 } : c)) } as SignedEnvelope;
    expect(await verifyEnvelope(edited)).toBe('changed');
    const forged = { ...e, signature: e.signature.replace(/^./, (ch) => (ch === 'a' ? 'b' : 'a')) };
    expect(await verifyEnvelope(forged)).toBe('bad-signature');
    expect(await verifyEnvelope({ ...e, kind: 'other' } as unknown as SignedEnvelope)).toBe('malformed');
  });

  it('lists every loosening, in plain words, and treats tightening as none', async () => {
    const a = await deviceEnvelope(k);
    const tighter = deviceConstraints(k.technician.publicKeyHex).map((c) => (c.id === 'setpoint-range' ? { ...c, max: -20 } : c));
    expect(looserThan(a, { ...a, constraints: tighter })).toEqual([]);
    const cs = deviceConstraints(k.technician.publicKeyHex)
      .filter((c) => c.id !== 'value-dwell')
      .map((c) => {
        if (c.id === 'setpoint-range') return { ...c, max: 45 };
        if (c.id === 'setpoint-step') return { ...c, maxStep: 50 };
        if (c.id === 'value-agree') return { ...c, tolerance: 10 };
        if (c.id === 'setpoint-follows') return { ...c, withinMs: 3_600_000 };
        if (c.id === 'who' && c.kind === 'authority') return { ...c, grants: [...c.grants, { publicKey: k.stranger.publicKeyHex, points: ['*'] }] };
        if (c.id === 'value-range') return { ...c, modes: ['normal', 'defrost'].slice(0, 0).concat(['night']) };
        return c;
      });
    const reasons = looserThan(a, { ...a, constraints: cs, coolingMs: 1000, points: a.points.map((p) => (p.id === P.setpoint ? { ...p, failMode: 'pass-and-alarm' as const } : p)) });
    const text = reasons.join('\n');
    for (const s of ['value-dwell (dwell) removed', 'upper limit relaxed', 'largest setpoint step increased', 'tolerance widened', 'response time lengthened', 'new key', 'cooling period shortened', 'fail mode weakened', 'applies in fewer modes']) expect(text).toContain(s);
  });

  it('compares limits across units: −0.4 [degF] equals −18 Cel, −0.3 [degF] is looser', async () => {
    const a = await deviceEnvelope(k);
    const inF = (max: number) => ({ ...a, constraints: a.constraints.map((c) => (c.id === 'setpoint-range' ? { ...c, unit: '[degF]', min: -13, max } : c)) });
    expect(looserThan(a, inF(-0.4))).toEqual([]);
    expect(looserThan(a, inF(-0.3)).join()).toContain('upper limit relaxed');
  });

  it('authority windows: a longer window or more points is looser; fewer is not', async () => {
    const mk = (windows?: { days: number[]; from: string; to: string }[], points = [P.setpoint]) => deviceConstraints(k.technician.publicKeyHex).map((c) => (c.kind === 'authority' ? { ...c, grants: [{ publicKey: k.technician.publicKeyHex, points, windows }] } : c));
    const a = await deviceEnvelope(k, { constraints: mk([{ days: [1, 2, 3, 4, 5], from: '07:00', to: '19:00' }]) });
    expect(looserThan(a, { ...a, constraints: mk([{ days: [1, 2, 3], from: '08:00', to: '18:00' }]) })).toEqual([]);
    expect(looserThan(a, { ...a, constraints: mk([{ days: [1, 2, 3, 4, 5, 6], from: '07:00', to: '19:00' }]) }).join()).toContain('more times');
    expect(looserThan(a, { ...a, constraints: mk(undefined) }).join()).toContain('more times');
    expect(looserThan(a, { ...a, constraints: mk([{ days: [1, 2, 3, 4, 5], from: '07:00', to: '19:00' }], ['*']) }).join()).toContain('more points');
  });

  it('windows across midnight and time zones', () => {
    const w = [{ days: [1], from: '22:00', to: '02:00', utcOffsetMin: 60 }]; // Monday 22:00–02:00 at UTC+1
    expect(inWindows(Date.parse('2026-11-02T21:30:00Z'), w)).toBe(true); // Mon 22:30 local
    expect(inWindows(Date.parse('2026-11-03T00:59:00Z'), w)).toBe(true); // Tue 01:59 local
    expect(inWindows(Date.parse('2026-11-03T01:00:00Z'), w)).toBe(false); // Tue 02:00 local
    expect(inWindows(Date.parse('2026-11-02T20:59:00Z'), w)).toBe(false);
    expect(inWindows(Date.parse('2026-11-08T23:30:00Z'), [{ days: [0], from: '23:00', to: '01:00' }])).toBe(true); // Sunday → Monday wrap of the week
    expect(inWindows(Date.parse('2026-11-09T00:30:00Z'), [{ days: [0], from: '23:00', to: '01:00' }])).toBe(true);
  });
});

describe('15.40.0 envelope lifecycle', () => {
  it('the first version and every tightening are active at once, from one operator', async () => {
    const v1 = await deviceEnvelope(k);
    const v2 = await deviceEnvelope(k, { version: 2, supersedes: v1.envelopeHash, at: T0 - 86_400_000, constraints: deviceConstraints(k.technician.publicKeyHex).map((c) => (c.id === 'setpoint-range' ? { ...c, max: -20 } : c)) });
    const { lines, refused } = await replayEnvelopes([v2, v1], { trustedKeys: [k.opA.publicKeyHex], now: T0 });
    expect(refused).toEqual([]);
    expect(lines[ENV_ID].active?.version).toBe(2);
    expect(lines[ENV_ID].history.map((h) => h.state)).toEqual(['active', 'superseded', 'active']);
  });

  it('a loosening waits for two distinct operators and then the cooling period', async () => {
    const v1 = await deviceEnvelope(k);
    const looser = deviceConstraints(k.technician.publicKeyHex).map((c) => (c.id === 'setpoint-range' ? { ...c, max: 10 } : c));
    const v2 = await deviceEnvelope(k, { version: 2, supersedes: v1.envelopeHash, constraints: looser, at: T0 - 3600_000 });
    const opts = { trustedKeys: [k.opA.publicKeyHex, k.opB.publicKeyHex] };
    let r = await replayEnvelopes([v1, v2], { ...opts, now: T0 });
    expect(r.lines[ENV_ID].active?.version).toBe(1);
    expect(r.lines[ENV_ID].pending).toMatchObject({ state: 'awaiting-endorsement', needs: 2, endorsedBy: [k.opA.publicKeyHex] });
    expect(r.lines[ENV_ID].pending!.loosens.join()).toContain('upper limit relaxed');
    // the same operator endorsing twice is still one signer
    const selfEndorse = await endorseEnvelope(v2, k.opA, new Date(T0 - 1000).toISOString());
    r = await replayEnvelopes([v1, v2, selfEndorse], { ...opts, now: T0 });
    expect(r.lines[ENV_ID].pending?.state).toBe('awaiting-endorsement');
    // an untrusted endorsement is refused
    const strangerEndorse = await endorseEnvelope(v2, k.stranger, new Date(T0 - 1000).toISOString());
    r = await replayEnvelopes([v1, v2, strangerEndorse], { ...opts, now: T0 });
    expect(r.refused.some((x) => x.because.includes('not a trusted operator'))).toBe(true);
    expect(r.lines[ENV_ID].pending?.state).toBe('awaiting-endorsement');
    // a second operator: cooling for 72 h from that endorsement
    const endorse = await endorseEnvelope(v2, k.opB, new Date(T0).toISOString());
    r = await replayEnvelopes([v1, v2, endorse], { ...opts, now: T0 + 3600_000 });
    expect(r.lines[ENV_ID].pending).toMatchObject({ state: 'cooling', activeFrom: new Date(T0 + 72 * 3600_000).toISOString() });
    expect(r.lines[ENV_ID].active?.version).toBe(1);
    r = await replayEnvelopes([v1, v2, endorse], { ...opts, now: T0 + 72 * 3600_000 });
    expect(r.lines[ENV_ID].active?.version).toBe(2);
    expect(r.lines[ENV_ID].pending).toBeUndefined();
  });

  it('rewriting a pending loosening cannot skip its endorsements', async () => {
    const v1 = await deviceEnvelope(k);
    const looser = deviceConstraints(k.technician.publicKeyHex).map((c) => (c.id === 'setpoint-range' ? { ...c, max: 10 } : c));
    const v2 = await deviceEnvelope(k, { version: 2, supersedes: v1.envelopeHash, constraints: looser, at: T0 - 7200_000 });
    // v3 equals v2 (so "not looser than its head") but is still looser than the active v1
    const v3 = await deviceEnvelope(k, { version: 3, supersedes: v2.envelopeHash, constraints: looser, at: T0 - 3600_000 });
    const r = await replayEnvelopes([v1, v2, v3], { trustedKeys: [k.opA.publicKeyHex, k.opB.publicKeyHex], now: T0 });
    expect(r.lines[ENV_ID].active?.version).toBe(1);
    expect(r.lines[ENV_ID].pending?.envelopeHash).toBe(v3.envelopeHash);
  });

  it('a shortened cooling period is itself a loosening, and the longer of the two periods applies', async () => {
    const v1 = await deviceEnvelope(k);
    const v2 = await deviceEnvelope(k, { version: 2, supersedes: v1.envelopeHash, coolingMs: 60_000, at: T0 - 3600_000 });
    const e = await endorseEnvelope(v2, k.opB, new Date(T0).toISOString());
    const r = await replayEnvelopes([v1, v2, e], { trustedKeys: [k.opA.publicKeyHex, k.opB.publicKeyHex], now: T0 + 120_000 });
    expect(r.lines[ENV_ID].pending).toMatchObject({ state: 'cooling', activeFrom: new Date(T0 + 72 * 3600_000).toISOString() });
  });

  it('forks, future-dated versions, edited versions and untrusted signers are refused', async () => {
    const v1 = await deviceEnvelope(k);
    const v2a = await deviceEnvelope(k, { version: 2, supersedes: v1.envelopeHash, at: T0 - 7200_000 });
    const v2b = await deviceEnvelope(k, { version: 2, supersedes: v1.envelopeHash, at: T0 - 3600_000, constraints: deviceConstraints(k.technician.publicKeyHex).map((c) => (c.id === 'setpoint-range' ? { ...c, max: -19 } : c)) });
    const future = await deviceEnvelope(k, { version: 3, supersedes: v2a.envelopeHash, at: T0 + 86_400_000 });
    const byStranger = await deviceEnvelope(k, { version: 4, supersedes: v2a.envelopeHash, signer: k.stranger, at: T0 - 60_000 });
    const edited = { ...v2a, version: 5 } as SignedEnvelope;
    const r = await replayEnvelopes([v1, v2a, v2b, future, byStranger, edited], { trustedKeys: [k.opA.publicKeyHex], now: T0 });
    expect(r.lines[ENV_ID].active?.envelopeHash).toBe(v2a.envelopeHash);
    const states = r.lines[ENV_ID].history.filter((h) => h.state === 'refused').map((h) => h.because).join('\n');
    expect(states).toContain('fork is refused');
    expect(states).toContain('in the future');
    expect(r.refused.map((x) => x.because).join('\n')).toMatch(/not a trusted operator[\s\S]*envelope changed|envelope changed[\s\S]*not a trusted operator/);
  });

  it('revocation removes every constraint, so it needs two operators and cooling too', async () => {
    const v1 = await deviceEnvelope(k);
    const r1 = await revokeEnvelope(v1, 'controller replaced', k.opA, new Date(T0 - 1000).toISOString());
    let r = await replayEnvelopes([v1, r1], { trustedKeys: [k.opA.publicKeyHex, k.opB.publicKeyHex], now: T0 });
    expect(r.lines[ENV_ID].active?.version).toBe(1);
    expect(r.lines[ENV_ID].pending?.state).toBe('awaiting-endorsement');
    const r2 = await revokeEnvelope(v1, 'controller replaced', k.opB, new Date(T0).toISOString());
    r = await replayEnvelopes([v1, r1, r2], { trustedKeys: [k.opA.publicKeyHex, k.opB.publicKeyHex], now: T0 + 1000 });
    expect(r.lines[ENV_ID].pending?.state).toBe('revocation-cooling');
    r = await replayEnvelopes([v1, r1, r2], { trustedKeys: [k.opA.publicKeyHex, k.opB.publicKeyHex], now: T0 + 73 * 3600_000 });
    expect(r.lines[ENV_ID].active).toBeNull();
    await expect(revokeEnvelope(v1, '  ', k.opA)).rejects.toThrow(/reason/);
  });
});

describe('15.40.0 command authorisation', () => {
  let env: SignedEnvelope;
  beforeAll(async () => { env = await deviceEnvelope(k); });
  const write = (value: number, unit?: string) => ({ point: P.setpoint, value, unit });

  it('a signed command from a granted key inside the limits is authorised once', async () => {
    const cmd = await signCommand({ envelopeId: env.envelopeId, point: P.setpoint, value: -20, at: min(0) }, k.technician);
    const used = new Set<string>();
    expect(await authorize(env, { at: min(1), write: write(-20), command: cmd, current: -21, mode: 'normal', usedNonces: used })).toMatchObject({ state: 'authorized', keyTrust: 'envelope-listed' });
    expect((await authorize(env, { at: min(2), write: write(-20), command: cmd, current: -20, mode: 'normal', usedNonces: used })).state).toBe('replayed');
  });

  it('refuses each failure with its own state', async () => {
    const at = min(1); const base = { envelopeId: env.envelopeId, point: P.setpoint, at: min(0) };
    const ok = await signCommand({ ...base, value: -20 }, k.technician);
    const cases: Array<[string, Parameters<typeof authorize>[1]]> = [
      ['unsigned', { at, write: write(-20), current: -21, mode: 'normal' }],
      ['bad-signature', { at, write: write(-20), command: { ...ok, value: -19 }, current: -21, mode: 'normal' }],
      ['not-granted', { at, write: write(-20), command: await signCommand({ ...base, value: -20 }, k.stranger), current: -21, mode: 'normal' }],
      ['value-mismatch', { at, write: write(-19), command: ok, current: -21, mode: 'normal' }],
      ['expired', { at: min(30), write: write(-20), command: ok, current: -21, mode: 'normal' }],
      ['not-yet-valid', { at: min(-5), write: write(-20), command: ok, current: -21, mode: 'normal' }],
      ['wrong-envelope', { at, write: write(-20), command: await signCommand({ ...base, envelopeId: 'other', value: -20 }, k.technician), current: -21, mode: 'normal' }],
      ['out-of-range', { at, write: write(10), command: await signCommand({ ...base, value: 10 }, k.technician), current: -20, mode: 'normal' }],
      ['step-too-large', { at, write: write(-25), command: await signCommand({ ...base, value: -25 }, k.technician), current: -19, mode: 'normal' }],
      ['malformed', { at, write: write(-20), command: { kind: 'x' } as never, current: -21, mode: 'normal' }],
    ];
    for (const [want, ctx] of cases) expect((await authorize(env, ctx)).state, want).toBe(want);
  });

  it('caps a command\'s validity, even when the signer asks for longer', async () => {
    const cmd = await signCommand({ envelopeId: env.envelopeId, point: P.setpoint, value: -20, at: min(0), ttlMs: 86_400_000 }, k.technician);
    expect(Date.parse(cmd.expiresAt) - Date.parse(cmd.issuedAt)).toBe(COMMAND_MAX_TTL_MS);
  });

  it('a write in another unit is compared in the point\'s unit', async () => {
    const cmd = await signCommand({ envelopeId: env.envelopeId, point: P.setpoint, value: -4, unit: '[degF]', at: min(0) }, k.technician);
    expect((await authorize(env, { at: min(1), write: write(-20), command: cmd, current: -21, mode: 'normal' })).state).toBe('authorized');
    expect((await authorize(env, { at: min(1), write: { point: P.setpoint, value: 1, unit: 'kPa' }, command: cmd, current: -21 })).state).toBe('unit-mismatch');
  });

  it('a grant naming a wallet follows that wallet\'s KeyZ declarations and revocations', async () => {
    const w = keyPairFromPhrase(generateRecoveryPhrase()); const wallet = w.address;
    const constraints = deviceConstraints(k.technician.publicKeyHex).map((c) => (c.kind === 'authority' ? { ...c, grants: [{ publicKey: k.technician.publicKeyHex, wallet, points: [P.setpoint] }] } : c));
    const e = await deviceEnvelope(k, { constraints });
    const decl = await declareKey(w.privateKey, wallet, { publicKey: k.technician.publicKeyHex, algorithm: 'ed25519', purpose: 'signing' }, undefined, min(-60));
    const cmd = await signCommand({ envelopeId: e.envelopeId, point: P.setpoint, value: -20, at: min(0) }, k.technician);
    expect(await authorize(e, { at: min(1), write: write(-20), command: cmd, current: -21, mode: 'normal', keyEvidence: { declarations: [decl] } })).toMatchObject({ state: 'authorized', keyTrust: 'declared' });
    expect((await authorize(e, { at: min(1), write: write(-20), command: cmd, current: -21, mode: 'normal', keyEvidence: { declarations: [] } })).state).toBe('key-undeclared');
    const rev = await revokeKeyDeclaration(w.privateKey, decl, 'contract ended', min(-1));
    expect((await authorize(e, { at: min(1), write: write(-20), command: cmd, current: -21, mode: 'normal', keyEvidence: { declarations: [decl], revocations: [rev] } })).state).toBe('key-revoked');
  });

  it('schedules, grant windows and unknown modes refuse', async () => {
    const cs = deviceConstraints(k.technician.publicKeyHex, [{ id: 'hours', kind: 'schedule', points: [P.setpoint], windows: [{ days: [1, 2, 3, 4, 5], from: '07:00', to: '19:00' }] }])
      .map((c) => (c.id === 'setpoint-range' ? { ...c, modes: ['normal'] } : c));
    const e = await deviceEnvelope(k, { constraints: cs });
    const night = await signCommand({ envelopeId: e.envelopeId, point: P.setpoint, value: -20, at: min(0) }, k.technician);
    expect((await authorize(e, { at: min(1), write: write(-20), command: night, current: -21, mode: 'normal' })).state).toBe('outside-schedule'); // 01:00 Monday
    const day = Date.parse('2026-11-02T09:00:00Z');
    const dcmd = await signCommand({ envelopeId: e.envelopeId, point: P.setpoint, value: -20, at: day }, k.technician);
    expect((await authorize(e, { at: day + 1000, write: write(-20), command: dcmd, current: -21, mode: null })).state).toBe('mode-unknown');
    expect((await authorize(e, { at: day + 1000, write: write(-20), command: dcmd, current: -21, mode: 'normal' })).state).toBe('authorized');
    const windowed = deviceConstraints(k.technician.publicKeyHex).map((c) => (c.kind === 'authority' ? { ...c, grants: [{ publicKey: k.technician.publicKeyHex, points: [P.setpoint], windows: [{ days: [6], from: '00:00', to: '23:59' }] }] } : c));
    const e2 = await deviceEnvelope(k, { constraints: windowed });
    expect((await authorize(e2, { at: day + 1000, write: write(-20), command: dcmd, current: -21, mode: 'normal' })).state).toBe('outside-window');
  });

  it('points without an authority constraint need no signature but still meet their limits', async () => {
    const e = await deviceEnvelope(k, { constraints: deviceConstraints(k.technician.publicKeyHex).filter((c) => c.kind !== 'authority') });
    expect((await authorize(e, { at: min(1), write: write(-20), current: -21, mode: 'normal' })).state).toBe('authorized');
    expect((await authorize(e, { at: min(1), write: write(5), current: -21, mode: 'normal' })).state).toBe('out-of-range');
  });

  void T0;
});
