import { describe, it, expect, beforeAll } from 'vitest';
import { createConstraintGuard, replayPointModes, signPointMode, type GuardMode, type GuardVerdict } from '../lib/constraints/guard';
import { createBacnetGateway, createDnp3Gateway, createGremlinGateway, createHttpControlGuard, createIec104Gateway, createModbusGateway, createMqttGateway, jsonPointer, matchPath } from '../lib/constraints/gateways';
import { signCommand, type SignedCommand } from '../lib/constraints/authority';
import { declareEnvelope, type EnvelopeBody, type SignedEnvelope } from '../lib/constraints/envelope';
import { encodeModbusReadResponse, encodeModbusRequest, encodeRegisterValue, parseModbusFrame, type ModbusRegister } from '../lib/constraints/adapters/modbus';
import { BACNET_OBJECT_TYPES as BT, encodeBacnetConfirmed, encodeBacnetWriteProperty, parseBacnetIp } from '../lib/constraints/adapters/bacnet';
import { encodeDnp3Command, parseDnp3Apdu, parseDnp3Link, type Dnp3LinkFrame } from '../lib/constraints/adapters/dnp3';
import { encodeCommandAsdu, encodeIec104I, encodeMeasuredAsdu, parseAsdu, parseIec104 } from '../lib/constraints/adapters/iec104';
import { MqttFramer, encodeConnect, encodePublish } from '../lib/constraints/adapters/mqtt';
import { encodeSparkplugPayload } from '../lib/constraints/adapters/sparkplug';
import { deviceEnvelope, keys, OVEN, pointsOf, type Keys } from './helpers/constraintFixtures';

const P = pointsOf(OVEN);
let k: Keys; let env: SignedEnvelope;
const T = Date.parse('2026-11-02T09:00:00Z');
beforeAll(async () => { k = await keys(); env = await deviceEnvelope(k, { profile: OVEN }); });

function guardWith(o: { mode?: GuardMode; modes?: Record<string, GuardMode>; envelope?: () => EnvelopeBody | null; clock?: { t: number }; allowPrivileged?: string[]; allowUnmapped?: boolean } = {}) {
  const clock = o.clock ?? { t: T }; const verdicts: GuardVerdict[] = [];
  const g = createConstraintGuard({ envelope: o.envelope ?? (() => env), mode: o.mode, pointModes: () => o.modes ?? {}, now: () => clock.t, onVerdict: (v) => { verdicts.push(v); }, allowPrivileged: o.allowPrivileged, allowUnmapped: o.allowUnmapped });
  return { g, verdicts, clock };
}
const cmd = (value: number, key = k.technician, at = T, point = P.setpoint) => signCommand({ envelopeId: env.envelopeId, point, value, at }, key);
const write = (value: number | string | boolean, point = P.setpoint) => ({ kind: 'write' as const, writes: [{ point, value }], unmapped: [] });

describe('15.40.0 constraint guard — decisions', () => {
  it('shadow forwards everything and records what it would refuse; enforce refuses', async () => {
    const s = guardWith(); await s.g.observe([{ at: T, point: P.setpoint, value: 200, source: 't' }]);
    const v = await s.g.check(write(400), { source: 'panel' });
    expect(v).toMatchObject({ forward: true, wouldRefuse: true, mode: 'shadow', alarm: true });
    expect(v.reasons.map((r) => r.reason)).toEqual(['unsigned']);
    const e = guardWith({ mode: 'enforce' });
    expect(await e.g.check(write(400), { source: 'panel' })).toMatchObject({ forward: false, wouldRefuse: true, mode: 'enforce' });
  });

  it('a signed command inside the envelope passes once; a replay is refused', async () => {
    const e = guardWith({ mode: 'enforce' }); await e.g.observe([{ at: T, point: P.setpoint, value: 200, source: 't' }]);
    const c = await cmd(215);
    expect(await e.g.check(write(215), { source: 'hmi', command: c })).toMatchObject({ forward: true, wouldRefuse: false });
    expect((await e.g.check(write(215), { source: 'attacker', command: c })).reasons[0].reason).toBe('replayed');
  });

  it('the step limit uses the observed current value', async () => {
    const e = guardWith({ mode: 'enforce' }); await e.g.observe([{ at: T, point: P.setpoint, value: 170, source: 't' }]);
    expect((await e.g.check(write(215), { source: 'hmi', command: await cmd(215) })).reasons[0].reason).toBe('step-too-large');
    await e.g.observe([{ at: T + 1, point: P.setpoint, value: 200, source: 't' }]);
    expect((await e.g.check(write(215), { source: 'hmi', command: await cmd(215) })).forward).toBe(true);
    // bad-quality readings never move the current value
    await e.g.observe([{ at: T + 2, point: P.setpoint, value: 100, quality: 'bad', source: 't' }]);
    expect((await e.g.check(write(230), { source: 'hmi', command: await cmd(230) })).forward).toBe(true);
  });

  it('while the mode is unknown, mode-scoped limits refuse instead of being skipped', async () => {
    const e = guardWith({ mode: 'enforce' });
    expect((await e.g.check(write(999, P.value), { source: 'x' })).reasons[0].reason).toBe('mode-unknown');
    await e.g.observe([{ at: T, point: P.mode, value: OVEN.runMode, source: 't' }]);
    expect((await e.g.check(write(999, P.value), { source: 'x' })).reasons[0].reason).toBe('out-of-range');
    await e.g.observe([{ at: T + 1, point: P.mode, value: 'cleaning', source: 't' }]);
    expect((await e.g.check(write(999, P.value), { source: 'x' })).forward).toBe(true); // the band applies only while baking
  });

  it('per-point modes from signed records: enforce needs the report hash; untrusted and other-envelope records are ignored', async () => {
    const rec = await signPointMode({ envelopeId: env.envelopeId, point: P.setpoint, mode: 'enforce', reason: 'shadow clean 14 days', reportHash: 'ab'.repeat(32), at: '2026-11-01T00:00:00Z' }, k.opA);
    const rollback = await signPointMode({ envelopeId: env.envelopeId, point: P.setpoint, mode: 'shadow', reason: 'rollback: false refusals', at: '2026-11-01T01:00:00Z' }, k.opA);
    const stranger = await signPointMode({ envelopeId: env.envelopeId, point: '*', mode: 'shadow', reason: 'x', at: '2026-11-01T02:00:00Z' }, k.stranger);
    const other = await signPointMode({ envelopeId: 'other', point: P.setpoint, mode: 'enforce', reason: 'x', reportHash: 'cd'.repeat(32) }, k.opA);
    const tampered = { ...rec, point: '*' };
    let r = await replayPointModes([rec, stranger, other, tampered], [k.opA.publicKeyHex], env.envelopeId);
    expect(r.modes[P.setpoint].mode).toBe('enforce'); expect(r.refused).toBe(3);
    r = await replayPointModes([rollback, rec], [k.opA.publicKeyHex], env.envelopeId);
    expect(r.modes[P.setpoint].mode).toBe('shadow');
    await expect(signPointMode({ envelopeId: 'x', point: 'p', mode: 'enforce', reason: 'go' }, k.opA)).rejects.toThrow(/report hash/);
    await expect(signPointMode({ envelopeId: 'x', point: 'p', mode: 'shadow', reason: ' ' }, k.opA)).rejects.toThrow(/reason/);
    const g = guardWith({ modes: { [P.setpoint]: 'enforce' } });
    expect((await g.g.check(write(999), { source: 'x' })).mode).toBe('enforce');
    expect((await g.g.check(write(1, P.mode), { source: 'x' })).mode).toBe('shadow');
  });

  it('a request with one refused write is refused whole, and consumes no command', async () => {
    const e = guardWith({ mode: 'enforce' }); await e.g.observe([{ at: T, point: P.setpoint, value: 200, source: 't' }, { at: T, point: P.mode, value: OVEN.runMode, source: 't' }]);
    const c = await cmd(215);
    const v = await e.g.check({ kind: 'write', writes: [{ point: P.setpoint, value: 215 }, { point: P.value, value: 999 }], unmapped: [] }, { source: 'x', command: c });
    expect(v.reasons).toEqual([expect.objectContaining({ point: P.value, reason: 'out-of-range' })]);
    expect(v.forward).toBe(false);
    expect((await e.g.check(write(215), { source: 'x', command: c })).forward).toBe(true); // c was not consumed
  });

  it('armed commands authorise one matching write from a protocol with no signature field', async () => {
    const e = guardWith({ mode: 'enforce' }); await e.g.observe([{ at: T, point: P.setpoint, value: 200, source: 't' }]);
    expect((await e.g.arm(await cmd(215, k.stranger))).state).toBe('not-granted');
    expect(e.g.armedCount()).toBe(0);
    const c = await cmd(215); expect((await e.g.arm(c)).state).toBe('authorized');
    expect((await e.g.arm(c)).state).toBe('replayed'); // arming twice
    expect((await e.g.check(write(210), { source: 'modbus' })).reasons[0].reason).toBe('value-mismatch');
    expect((await e.g.check(write(215), { source: 'modbus' })).forward).toBe(true);
    expect(e.g.armedCount()).toBe(0);
    expect((await e.g.check(write(215), { source: 'modbus' })).reasons[0].reason).toBe('unsigned');
    // expiry
    await e.g.arm(await cmd(220)); e.clock.t += 6 * 60_000; expect(e.g.armedCount()).toBe(0);
  });

  it('armed commands are bounded', async () => {
    const g = createConstraintGuard({ envelope: () => env, now: () => T, maxArmed: 2 });
    await g.observe([{ at: T, point: P.setpoint, value: 200, source: 't' }]);
    for (const v of [205, 210]) expect((await g.arm(await cmd(v))).state).toBe('authorized');
    expect((await g.arm(await cmd(215))).because).toMatch(/too many armed/);
  });

  it('fail modes: no envelope holds last good values; pass-and-alarm points (from the last envelope read) forward', async () => {
    let up = true; const e = guardWith({ mode: 'enforce', envelope: () => { if (!up) throw new Error('store down'); return env; } });
    await e.g.observe([]); up = false;
    expect(await e.g.check(write(215), { source: 'x' })).toMatchObject({ forward: false, failMode: 'hold-last-good', alarm: true, reasons: [{ reason: 'evidence-unavailable' }] });
    const passEnv = await declareEnvelope({ ...env, version: 1, supersedes: null, points: env.points.map((p) => (p.id === P.setpoint ? { ...p, failMode: 'pass-and-alarm' as const } : p)) }, k.opA);
    let ok = true; const pa = guardWith({ mode: 'enforce', envelope: () => { if (!ok) return null; return passEnv; } });
    await pa.g.observe([]); ok = false;
    expect(await pa.g.check(write(215), { source: 'x' })).toMatchObject({ forward: true, failMode: 'pass-and-alarm', alarm: true });
    expect(await pa.g.check(write(1, 'never-seen'), { source: 'x' })).toMatchObject({ forward: false, failMode: 'hold-last-good' });
    const cold = guardWith({ mode: 'enforce', envelope: () => null }); // never read: nothing to go on
    expect((await cold.g.check(write(215), { source: 'x' })).failMode).toBe('hold-last-good');
  });

  it('key evidence that cannot be read refuses under hold-last-good', async () => {
    const g = createConstraintGuard({ envelope: () => env, mode: 'enforce', now: () => T, keyEvidence: () => { throw new Error('unreadable'); } });
    await g.observe([{ at: T, point: P.setpoint, value: 200, source: 't' }]);
    expect(await g.check(write(215), { source: 'x', command: await cmd(215) })).toMatchObject({ forward: false, failMode: 'hold-last-good' });
  });

  it('advisory envelopes never authorise inline writes', async () => {
    const adv = await declareEnvelope({ ...env, version: 1, supersedes: null, advisory: true }, k.opA);
    const g = guardWith({ mode: 'enforce', envelope: () => adv }); await g.g.observe([{ at: T, point: P.setpoint, value: 200, source: 't' }]);
    expect((await g.g.check(write(215), { source: 'x', command: await cmd(215) })).reasons.map((r) => r.reason)).toContain('advisory-envelope');
  });

  it('privileged operations need the operator\'s allowance by name; malformed and unmapped are refused', async () => {
    const e = guardWith({ mode: 'enforce', allowPrivileged: ['ReinitializeDevice'] });
    expect((await e.g.check({ kind: 'privileged', what: 'ReinitializeDevice' }, { source: 'x' })).forward).toBe(true);
    expect((await e.g.check({ kind: 'privileged', what: 'DeleteObject' }, { source: 'x' })).forward).toBe(false);
    expect((await e.g.check({ kind: 'malformed', because: 'x' }, { source: 'x' })).forward).toBe(false);
    expect((await e.g.check({ kind: 'write', writes: [], unmapped: ['holding:999'] }, { source: 'x' })).forward).toBe(false);
    const allow = guardWith({ mode: 'enforce', allowUnmapped: true });
    expect((await allow.g.check({ kind: 'write', writes: [], unmapped: ['holding:999'] }, { source: 'x' })).forward).toBe(true);
    expect((await allow.g.check(write(1, 'mapped-but-undeclared'), { source: 'x' })).reasons[0].reason).toBe('unmapped');
  });

  it('the enforce gate: enough writes over enough days, and the recent ones all clean', async () => {
    const s = guardWith(); await s.g.observe([{ at: T, point: P.setpoint, value: 200, source: 't' }]);
    let r = await s.g.report();
    expect(r.points[P.setpoint].enforce.ready).toBe(false);
    for (let i = 0; i < 5; i++) await s.g.check(write(205 + i), { source: 'legacy hmi' }); // unsigned: would refuse
    for (let day = 0; day < 8; day++) {
      s.clock.t = T + day * 86_400_000;
      for (let i = 0; i < 3; i++) { const v = 200 + ((day * 3 + i) % 2) * 5; await s.g.check(write(v), { source: 'hmi', command: await cmd(v, k.technician, s.clock.t) }); }
    }
    r = await s.g.report();
    expect(r.points[P.setpoint]).toMatchObject({ writes: 29, wouldRefuse: { unsigned: 5 }, enforce: { ready: true, because: [] } });
    expect(r.reportHash).toMatch(/^[0-9a-f]{64}$/);
    await s.g.check(write(250), { source: 'attacker' });
    expect((await s.g.report()).points[P.setpoint].enforce.because.join()).toMatch(/did not all pass/);
    // state survives a restart
    const again = createConstraintGuard({ envelope: () => env, now: () => s.clock.t, state: s.g.state() });
    expect((await again.report()).points[P.setpoint].writes).toBe(30);
  });

  it('a throwing onVerdict never changes the decision', async () => {
    const g = createConstraintGuard({ envelope: () => env, mode: 'enforce', now: () => T, onVerdict: () => { throw new Error('log down'); } });
    expect((await g.check(write(215), { source: 'x' })).forward).toBe(false);
  });
});

describe('15.40.0 constraint guard — HTTP/REST front', () => {
  const routes = [
    { method: 'PUT' as const, path: '/api/v1/points/{id}/setpoint', point: { param: 'id', map: { 'oven-3': P.setpoint } }, value: '/value' },
    { method: 'POST' as const, path: '/api/mode', point: P.mode, value: '' },
  ];
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  function front(mode: GuardMode) {
    const seen: Request[] = []; const s = guardWith({ mode });
    const h = createHttpControlGuard({ guard: s.g, upstream: async (r) => { seen.push(r); return new Response('ok', { status: 200 }); }, routes, maxBodyBytes: 256 });
    return { h, seen, s };
  }
  const put = (body: unknown, c?: SignedCommand, path = '/api/v1/points/oven-3/setpoint') => new Request(`http://panel${path}`, { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body), headers: c ? { 'cappz-command': b64(c) } : {} });

  it('path templates and JSON pointers are literal', () => {
    expect(matchPath('/a/{id}/b', '/a/x%2Fy/b')).toEqual({ id: 'x/y' });
    expect(matchPath('/a/{id}/b', '/a//b')).toBeNull(); expect(matchPath('/a/{id}', '/a/x/y')).toBeNull(); expect(matchPath('/a/{id}', '/a/%E0%A4%A')).toBeNull();
    expect(jsonPointer({ 'a/b': { '~x': [1, 2] } }, '/a~1b/~0x/1')).toBe(2);
    expect(jsonPointer({ a: [1] }, '/a/01')).toBeUndefined(); expect(jsonPointer({}, '/__proto__')).toBeUndefined(); expect(jsonPointer({ a: 1 }, 'a')).toBeUndefined();
  });

  it('enforce: a signed in-envelope write is forwarded without the command header; others get 403 with reasons', async () => {
    const { h, seen, s } = front('enforce'); await s.g.observe([{ at: T, point: P.setpoint, value: 200, source: 't' }]);
    const ok = await h.handle(put({ value: 215 }, await cmd(215)));
    expect(ok.status).toBe(200); expect(seen[0].headers.get('cappz-command')).toBeNull(); expect(await seen[0].text()).toBe('{"value":215}');
    const no = await h.handle(put({ value: 400 }));
    expect(no.status).toBe(403); expect((await no.json()).reasons[0].reason).toBe('unsigned');
    expect((await h.handle(put({ value: 215 }, await cmd(215), '/api/v1/points/oven-9/setpoint'))).status).toBe(403); // unmapped id
    expect((await h.handle(new Request('http://panel/api/other', { method: 'POST', body: '{}' }))).status).toBe(403); // unmatched write
    expect((await h.handle(put('not json', await cmd(215)))).status).toBe(403);
    expect((await h.handle(new Request('http://panel/api/v1/points/oven-3/setpoint', { method: 'PUT', body: '{}', headers: { 'cappz-command': '%%%' } }))).status).toBe(403);
    expect((await h.handle(put({ value: 'x'.repeat(400) }))).status).toBe(413);
    expect((await h.handle(new Request('http://panel/status'))).status).toBe(200); // reads pass
  });

  it('shadow forwards and marks the response; report and arm endpoints', async () => {
    const { h, s } = front('shadow'); await s.g.observe([{ at: T, point: P.setpoint, value: 200, source: 't' }]);
    const r = await h.handle(put({ value: 400 }));
    expect(r.status).toBe(200); expect(r.headers.get('cappz-constraint-verdict')).toBe('shadow-refused:unsigned');
    const rep = await (await h.handle(new Request('http://panel/cappz/constraints/report'))).json();
    expect(rep.points[P.setpoint].wouldRefuse).toMatchObject({ unsigned: 1 });
    expect((await h.handle(new Request('http://panel/cappz/constraints/arm', { method: 'POST', body: JSON.stringify(await cmd(215)) }))).status).toBe(200);
    expect((await h.handle(new Request('http://panel/cappz/constraints/arm', { method: 'POST', body: 'x' }))).status).toBe(400);
  });
});

describe('15.40.0 constraint guard — protocol gateways', () => {
  const MAP: ModbusRegister[] = [{ unitId: 1, table: 'holding', address: 100, point: P.setpoint, type: 'int16', scale: 0.1 }];

  it('Modbus: refused writes get an exception, armed ones pass, reads feed the current value', async () => {
    const s = guardWith({ mode: 'enforce' }); const gw = createModbusGateway({ guard: s.g, map: MAP });
    const rd = encodeModbusRequest({ transactionId: 1, unitId: 1, fn: 3, address: 100, quantity: 1 });
    expect((await gw.fromClient(rd)).forward).toBeTruthy();
    const back = await gw.fromServer(encodeModbusReadResponse(parseModbusFrame(rd)!, encodeRegisterValue(MAP[0], 200)));
    expect(back.observations).toEqual([expect.objectContaining({ point: P.setpoint, value: 200 })]);
    const wr = encodeModbusRequest({ transactionId: 2, unitId: 1, fn: 6, address: 100, values: encodeRegisterValue(MAP[0], 400) });
    const refused = await gw.fromClient(wr);
    expect(refused.forward).toBeUndefined(); expect(Array.from(refused.reply!.slice(7))).toEqual([0x86, 0x03]);
    await s.g.arm(await cmd(215));
    expect((await gw.fromClient(encodeModbusRequest({ transactionId: 3, unitId: 1, fn: 6, address: 100, values: encodeRegisterValue(MAP[0], 215) }))).forward).toBeTruthy();
    const vendor = await gw.fromClient(new Uint8Array([0, 4, 0, 0, 0, 2, 1, 0x5a]));
    expect(Array.from(vendor.reply!.slice(7))).toEqual([0xda, 0x01]);
    expect((await gw.fromClient(new Uint8Array([1, 2, 3]))).close).toBe(true);
  });

  it('BACnet: Error-PDU for a refused write; unconfirmed refusals are dropped silently', async () => {
    const s = guardWith({ mode: 'enforce' }); const gw = createBacnetGateway({ guard: s.g, map: [{ objectType: BT['analog-value'], instance: 3, point: P.setpoint }] });
    const r = await gw.fromClient(encodeBacnetWriteProperty({ invokeId: 9, objectType: BT['analog-value'], instance: 3, value: { real: 400 } }));
    expect(Array.from(r.reply!.slice(-7))).toEqual([0x50, 9, 15, 0x91, 4, 0x91, 40]);
    expect(await gw.fromClient(new Uint8Array([0x81, 0x0b, 0, 8, 0x01, 0x00, 0x10, 10]))).toMatchObject({ verdict: { forward: false } });
    expect((await gw.fromClient(encodeBacnetConfirmed(1, 12, [0x0c, 0, 0, 0, 1, 0x19, 85]))).forward).toBeTruthy();
    void parseBacnetIp;
  });

  it('DNP3: a refused operate is answered NOT_AUTHORIZED from the outstation', async () => {
    const s = guardWith({ mode: 'enforce' }); const gw = createDnp3Gateway({ guard: s.g, map: [{ outstation: 10, table: 'analog-output', index: 0, point: P.setpoint }] });
    const r = await gw.fromClient(encodeDnp3Command({ fc: 5, seq: 3, master: 1, outstation: 10, objects: [{ group: 41, variation: 3, index: 0, value: 400 }] }));
    const f = parseDnp3Link(r.reply!) as Dnp3LinkFrame;
    expect(parseDnp3Apdu(f.userData, false)).toMatchObject({ fc: 129, seq: 3, objects: [{ status: 9 }] });
    const bad = encodeDnp3Command({ fc: 5, master: 1, outstation: 10, objects: [{ group: 41, variation: 3, index: 0, value: 1 }] }); bad[15] ^= 1;
    expect((await gw.fromClient(bad)).verdict?.reasons[0].reason).toBe('malformed');
  });

  it('IEC 104: refusal is a negative confirmation, and later frames stay in sequence', async () => {
    const s = guardWith({ mode: 'enforce' }); const gw = createIec104Gateway({ guard: s.g, map: [{ ca: 1, ioa: 6001, point: P.setpoint }, { ca: 1, ioa: 7001, point: P.value }] });
    await gw.fromServer(encodeIec104I(encodeMeasuredAsdu({ typeId: 13, ca: 1, ioa: 7001, values: [201] }), 0, 0));
    const r = await gw.fromClient(encodeIec104I(encodeCommandAsdu({ typeId: 50, ca: 1, ioa: 6001, value: 400 }), 0, 1));
    const reply = parseIec104(r.reply!)!; expect(reply).toMatchObject({ ssn: 1, rsn: 1 });
    expect(parseAsdu(reply.asdu!)).toMatchObject({ cot: 7, negative: true });
    const next = await gw.fromClient(encodeIec104I(new Uint8Array([100, 1, 6, 0, 1, 0, 0, 0, 0, 20]), 1, 2));
    expect(parseIec104(next.forward!)).toMatchObject({ ssn: 0, rsn: 1 });
  });

  it('MQTT: v5 not-authorised, v3.1.1 close; Sparkplug DCMD is checked; telemetry feeds observations', async () => {
    const s = guardWith({ mode: 'enforce' });
    const topics = { 'site/17/oven-3/setpoint/set': { point: P.setpoint, valuePath: 'value', command: true }, 'site/17/oven-3/setpoint': { point: P.setpoint, valuePath: 'value' } };
    const v5 = createMqttGateway({ guard: s.g, topics });
    const pk = (b: Uint8Array) => new MqttFramer().push(b)[0];
    await v5.fromClient(pk(encodeConnect('hmi', 5)));
    const tel = await v5.fromClient(pk(encodePublish({ topic: 'site/17/oven-3/setpoint', payload: '{"value":200}', protocolLevel: 5 })));
    expect(tel.observations).toHaveLength(1);
    const r = await v5.fromClient(pk(encodePublish({ topic: 'site/17/oven-3/setpoint/set', payload: '{"value":400}', qos: 1, packetId: 5, protocolLevel: 5 })));
    expect(Array.from(r.reply!)).toEqual([0x40, 3, 0, 5, 0x87]);
    const v3 = createMqttGateway({ guard: s.g, topics }); await v3.fromClient(pk(encodeConnect('hmi', 4)));
    expect((await v3.fromClient(pk(encodePublish({ topic: 'site/17/oven-3/setpoint/set', payload: '{"value":400}', qos: 1, packetId: 5 })))).close).toBe(true);
    await s.g.arm(await cmd(215));
    expect((await v3.fromClient(pk(encodePublish({ topic: 'site/17/oven-3/setpoint/set', payload: '{"value":215}', qos: 1, packetId: 6 })))).forward).toBeTruthy();
    const sp = createMqttGateway({ guard: s.g, sparkplug: { map: { 'plant/edge1/oven3/Setpoint': P.setpoint } } });
    await sp.fromClient(pk(encodeConnect('edge', 4)));
    await sp.fromClient(pk(encodePublish({ topic: 'spBv1.0/plant/DBIRTH/edge1/oven3', payload: encodeSparkplugPayload({ metrics: [{ name: 'Setpoint', alias: 1, value: 215 }] }) })));
    expect((await sp.fromClient(pk(encodePublish({ topic: 'spBv1.0/plant/DCMD/edge1/oven3', payload: encodeSparkplugPayload({ metrics: [{ alias: 1, value: 400 }] }) })))).verdict).toMatchObject({ forward: false });
    expect((await sp.fromClient(pk(encodePublish({ topic: 'spBv1.0/plant/DCMD/edge1/oven3', payload: new Uint8Array([0x12, 0x7f]) })))).verdict?.reasons[0].reason).toBe('malformed');
  });

  it('Gremlin: 401 with the reason; reads pass', async () => {
    const s = guardWith({ mode: 'enforce' }); const gw = createGremlinGateway({ guard: s.g, map: [{ vertexId: 'oven-3', key: 'setpoint', point: P.setpoint }] });
    const req = (step: unknown[]) => JSON.stringify({ requestId: 'r-1', op: 'bytecode', processor: 'traversal', args: { gremlin: { '@type': 'g:Bytecode', '@value': { step } } } });
    const r = await gw.fromClient(req([['V', 'oven-3'], ['property', 'setpoint', { '@type': 'g:Double', '@value': 400 }]]));
    const reply = JSON.parse(r.reply!); expect(reply).toMatchObject({ requestId: 'r-1', status: { code: 401 } }); expect(reply.status.message).toMatch(/unsigned/);
    expect((await gw.fromClient(req([['V', 'oven-3'], ['values', 'setpoint']]))).forward).toBeTruthy();
    expect(JSON.parse((await gw.fromClient('{nope')).reply!).status.code).toBe(401);
  });
});
