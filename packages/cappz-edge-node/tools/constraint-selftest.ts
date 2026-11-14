/**
 * COPE node crystallized.
 * Node ID: v15-40-00-constraint-selftest
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * End-to-end check of the Constraint Guard over real sockets, on this machine:
 *
 *   deno run -A --unstable-net tools/constraint-selftest.ts
 *
 * Starts simulated controllers (HTTP panel, Modbus TCP, DNP3 outstation, IEC 104
 * server, MQTT broker, BACnet/IP device, Gremlin Server), the edge node's guard in
 * enforce mode in front of each, and checks for every protocol that an unsigned
 * out-of-envelope write is refused with the protocol's own refusal and never
 * reaches the controller, and that an armed signed command passes and does.
 * Then the sealed observation chain and the verdict log are reconciled, and the
 * wizard CLI runs (no step) → keygen → init → next → declare → status → command → doctor.
 * Exit code 0 when every expectation holds; each one is printed.
 */

import { generateSigningKey, type SigningKey } from '../../../src/lib/sync/helloSignature.ts';
import { declareEnvelope } from '../../../src/lib/constraints/envelope.ts';
import { signCommand } from '../../../src/lib/constraints/authority.ts';
import { reconcileConstraints, type CommandRecord } from '../../../src/lib/constraints/reconcile.ts';
import { openSealedObservations, type SealedObservationBatch } from '../../../src/lib/constraints/seal.ts';
import type { GuardVerdict } from '../../../src/lib/constraints/guard.ts';
import { ModbusFramer, encodeModbusReadResponse, encodeModbusRequest, encodeModbusWriteEcho, encodeRegisterValue, parseModbusFrame, type ModbusRegister } from '../../../src/lib/constraints/adapters/modbus.ts';
import { Dnp3Framer, encodeDnp3Command, parseDnp3Apdu, parseDnp3Link, type Dnp3LinkFrame } from '../../../src/lib/constraints/adapters/dnp3.ts';
import { Iec104Framer, encodeCommandAsdu, encodeIec104I, parseAsdu, parseIec104 } from '../../../src/lib/constraints/adapters/iec104.ts';
import { MqttFramer, encodeConnect, encodePublish } from '../../../src/lib/constraints/adapters/mqtt.ts';
import { BACNET_OBJECT_TYPES as BT, encodeBacnetWriteProperty } from '../../../src/lib/constraints/adapters/bacnet.ts';
import { constraintGuardFor, readJsonl, serveConstraintGuard, type ConstraintsConfig } from '../constraintGuard.ts';
import { trimChar } from '../../../src/lib/constraints/adapters/common.ts';

/** MQTT framer returning raw packet bytes (the simulators and the client side of the test). */
class MqttFramerRaw { private f = new MqttFramer(); push(c: Uint8Array) { return this.f.push(c).map((p) => p.raw); } }

let failures = 0;
const expect = (ok: boolean, what: string) => { console.log(`${ok ? '  ✓' : '  ✗'} ${what}`); if (!ok) failures++; };
const freePort = () => { const l = Deno.listen({ port: 0, hostname: '127.0.0.1' }); const p = (l.addr as Deno.NetAddr).port; l.close(); return p; };
const freeUdpPort = () => { const l = Deno.listenDatagram({ port: 0, hostname: '127.0.0.1', transport: 'udp' }); const p = (l.addr as Deno.NetAddr).port; l.close(); return p; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
async function exportKey(): Promise<{ key: SigningKey; line: string }> {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const pkcs8 = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))));
  const pub = hex(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  return { key: { publicKeyHex: pub, privateKey: pair.privateKey }, line: `${pkcs8}:${pub}` };
}

/** Read one framed reply from a connection (with a timeout). */
async function readFrame(conn: Deno.TcpConn, framer: { push(c: Uint8Array): Uint8Array[] }, ms = 1500): Promise<Uint8Array | null> {
  const buf = new Uint8Array(4096); const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const n = await Promise.race([conn.read(buf), sleep(deadline - Date.now()).then(() => -1)]);
    if (n === -1 || n === null) return null;
    const frames = framer.push(buf.subarray(0, n as number)); if (frames.length) return frames[0];
  }
  return null;
}

// ── Simulated controllers ──
function tcpSim(port: number, onFrame: (f: Uint8Array, conn: Deno.TcpConn) => Promise<void>, framer: () => { push(c: Uint8Array): Uint8Array[] }) {
  const got: Uint8Array[] = []; const l = Deno.listen({ hostname: '127.0.0.1', port });
  (async () => { for await (const c of l) (async () => { const fr = framer(); const buf = new Uint8Array(4096); try { for (;;) { const n = await c.read(buf); if (n === null) break; for (const f of fr.push(buf.subarray(0, n))) { got.push(f); await onFrame(f, c); } } } catch { /* closed */ } })(); })();
  return { got, close: () => l.close() };
}

if (import.meta.main) {
  const work = await Deno.makeTempDir({ prefix: 'cappz-constraints-' }); const data = `${work}/data`; await Deno.mkdir(data);
  const opA = await exportKey(); const opB = await exportKey(); const tech = await generateSigningKey(); const node = await exportKey();
  const P = { sp: 'oven-3/setpoint', value: 'oven-3/value', mode: 'oven-3/mode', burner: 'oven-3/burner' };
  const env = await declareEnvelope({
    envelopeId: 'site-17/oven-3', asset: "m/44'/144'/25'/sites/17/oven-3", version: 1, supersedes: null, modePoint: P.mode, declaredAt: new Date(Date.now() - 86_400_000).toISOString(),
    points: [{ id: P.sp, kind: 'setpoint', unit: 'Cel', failMode: 'hold-last-good' }, { id: P.value, kind: 'measurement', unit: 'Cel' }, { id: P.mode, kind: 'state', unit: '{state}' }, { id: P.burner, kind: 'command', unit: '{bool}' }],
    constraints: [
      { id: 'sp-range', kind: 'range', points: [P.sp], min: 160, max: 250, unit: 'Cel' },
      { id: 'sp-step', kind: 'rate', points: [P.sp], maxStep: 20, unit: 'Cel' },
      { id: 'who', kind: 'authority', points: [P.sp, P.burner], grants: [{ publicKey: tech.publicKeyHex, points: [P.sp, P.burner] }] },
    ],
  }, opA.key);
  await Deno.writeTextFile(`${data}/constraint-envelopes.jsonl`, JSON.stringify(env) + '\n');
  const sign = (value: number) => signCommand({ envelopeId: env.envelopeId, point: P.sp, value }, tech);

  const ports = { http: freePort(), panel: freePort(), modbus: freePort(), modbusDev: freePort(), dnp3: freePort(), dnp3Dev: freePort(), iec: freePort(), iecDev: freePort(), mqtt: freePort(), broker: freePort(), bacnet: freeUdpPort(), bacnetDev: freeUdpPort(), gremlin: freePort(), gremlinDev: freePort() };
  const MB: ModbusRegister[] = [{ unitId: 1, table: 'holding', address: 100, point: P.sp, type: 'int16', scale: 0.1 }];

  // HTTP panel
  const panelGot: string[] = [];
  const panel = Deno.serve({ port: ports.panel, hostname: '127.0.0.1', onListen: () => {} }, async (r) => { panelGot.push(`${r.method} ${new URL(r.url).pathname} ${await r.text()}`); return new Response('ok'); });
  // Modbus device with one register
  let reg = encodeRegisterValue(MB[0], 200)[0];
  const modbusDev = tcpSim(ports.modbusDev, async (f, c) => { const fr = parseModbusFrame(f)!; if (fr.fn === 3) await c.write(encodeModbusReadResponse(fr, [reg])); if (fr.fn === 6) { reg = (fr.pdu[3] << 8) | fr.pdu[4]; await c.write(encodeModbusWriteEcho(fr)); } }, () => new ModbusFramer());
  const dnp3Dev = tcpSim(ports.dnp3Dev, async () => {}, () => new Dnp3Framer());
  const iecDev = tcpSim(ports.iecDev, async () => {}, () => new Iec104Framer());
  const broker = tcpSim(ports.broker, async () => {}, () => new MqttFramerRaw());
  const bacnetDevSock = Deno.listenDatagram({ port: ports.bacnetDev, hostname: '127.0.0.1', transport: 'udp' }); const bacnetGot: Uint8Array[] = [];
  (async () => { for await (const [d] of bacnetDevSock) bacnetGot.push(d); })();
  const gremlinGot: string[] = [];
  const gremlinDev = Deno.serve({ port: ports.gremlinDev, hostname: '127.0.0.1', onListen: () => {} }, (req) => { const { socket, response } = Deno.upgradeWebSocket(req); socket.onmessage = (e) => { gremlinGot.push(String(e.data)); socket.send(JSON.stringify({ requestId: 'x', status: { code: 200 } })); }; return response; });

  const cfg: ConstraintsConfig = {
    envelopeId: env.envelopeId, trustedOperators: [opA.key.publicKeyHex, opB.key.publicKeyHex], minRelaxSigners: 2, host: '127.0.0.1',
    http: { port: ports.http, upstream: `http://127.0.0.1:${ports.panel}`, routes: [{ method: 'PUT', path: '/api/setpoint', point: P.sp, value: '/value' }] },
    modbus: { port: ports.modbus, upstream: `127.0.0.1:${ports.modbusDev}`, map: MB },
    dnp3: { port: ports.dnp3, upstream: `127.0.0.1:${ports.dnp3Dev}`, map: [{ outstation: 10, table: 'analog-output', index: 0, point: P.sp }] },
    iec104: { port: ports.iec, upstream: `127.0.0.1:${ports.iecDev}`, map: [{ ca: 1, ioa: 6001, point: P.sp }] },
    mqtt: { port: ports.mqtt, upstream: `127.0.0.1:${ports.broker}`, topics: { 'site/17/oven-3/setpoint/set': { point: P.sp, valuePath: 'value', command: true } } },
    bacnet: { port: ports.bacnet, upstream: `127.0.0.1:${ports.bacnetDev}`, map: [{ objectType: BT['analog-value'], instance: 3, point: P.sp }] },
    gremlin: { port: ports.gremlin, upstream: `ws://127.0.0.1:${ports.gremlinDev}`, map: [{ vertexId: 'oven-3', key: 'setpoint', point: P.sp }] },
  };
  await Deno.writeTextFile(`${work}/constraints.json`, JSON.stringify(cfg));
  Deno.env.set('CAPPZ_CONSTRAINTS_CONFIG', `${work}/constraints.json`); Deno.env.set('CAPPZ_CONSTRAINTS_MODE', 'enforce');
  const running = await serveConstraintGuard(data, node.key);
  await sleep(200);
  const arm = async (v: number) => (await fetch(`http://127.0.0.1:${ports.http}/cappz/constraints/arm`, { method: 'POST', body: JSON.stringify(await sign(v)) })).status;

  console.log('HTTP panel');
  const b64 = (o: unknown) => trimChar(btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_'), '=');
  let r = await fetch(`http://127.0.0.1:${ports.http}/api/setpoint`, { method: 'PUT', body: '{"value":400}' });
  expect(r.status === 403 && panelGot.length === 0, `unsigned 400 °C refused with 403 (${r.status}), panel untouched`); await r.body?.cancel();
  r = await fetch(`http://127.0.0.1:${ports.http}/api/setpoint`, { method: 'PUT', body: '{"value":210}', headers: { 'cappz-command': b64(await sign(210)) } });
  expect(r.status === 200 && panelGot.length === 1 && panelGot[0].includes('210'), `signed 210 °C forwarded (${r.status})`); await r.body?.cancel();

  console.log('Modbus TCP');
  const mb = await Deno.connect({ hostname: '127.0.0.1', port: ports.modbus });
  await mb.write(encodeModbusRequest({ transactionId: 1, unitId: 1, fn: 3, address: 100, quantity: 1 }));
  expect(!!(await readFrame(mb, new ModbusFramer())), 'read passes and is answered');
  await mb.write(encodeModbusRequest({ transactionId: 2, unitId: 1, fn: 6, address: 100, values: encodeRegisterValue(MB[0], 400) }));
  let f = await readFrame(mb, new ModbusFramer());
  expect(!!f && f[7] === 0x86 && f[8] === 0x03 && modbusDev.got.filter((x) => x[7] === 6).length === 0, 'unsigned write: exception 0x03, device untouched');
  expect(await arm(210) === 200, 'signed command armed');
  await mb.write(encodeModbusRequest({ transactionId: 3, unitId: 1, fn: 6, address: 100, values: encodeRegisterValue(MB[0], 210) }));
  f = await readFrame(mb, new ModbusFramer());
  expect(!!f && f[7] === 6 && reg === encodeRegisterValue(MB[0], 210)[0], 'armed write reaches the device and is echoed');
  mb.close();

  console.log('DNP3');
  const dn = await Deno.connect({ hostname: '127.0.0.1', port: ports.dnp3 });
  await dn.write(encodeDnp3Command({ fc: 5, seq: 4, master: 1, outstation: 10, objects: [{ group: 41, variation: 3, index: 0, value: 400 }] }));
  f = await readFrame(dn, new Dnp3Framer());
  const apdu = f ? parseDnp3Apdu((parseDnp3Link(f) as Dnp3LinkFrame).userData, false) : null;
  expect(!!apdu && !('error' in apdu) && apdu.objects[0].status === 9 && dnp3Dev.got.length === 0, 'unsigned DIRECT_OPERATE: NOT_AUTHORIZED, outstation untouched');
  await arm(220);
  await dn.write(encodeDnp3Command({ fc: 5, seq: 5, master: 1, outstation: 10, objects: [{ group: 41, variation: 3, index: 0, value: 220 }] }));
  await sleep(150); expect(dnp3Dev.got.length === 1, 'armed operate reaches the outstation'); dn.close();

  console.log('IEC 60870-5-104');
  const ie = await Deno.connect({ hostname: '127.0.0.1', port: ports.iec });
  await ie.write(encodeIec104I(encodeCommandAsdu({ typeId: 50, ca: 1, ioa: 6001, value: 400 }), 0, 0));
  f = await readFrame(ie, new Iec104Framer());
  const asdu = f ? parseAsdu(parseIec104(f)!.asdu!) : null;
  expect(!!asdu && !('error' in asdu) && asdu.cot === 7 && asdu.negative && iecDev.got.length === 0, 'unsigned setpoint: negative confirmation, server untouched');
  await arm(230);
  await ie.write(encodeIec104I(encodeCommandAsdu({ typeId: 50, ca: 1, ioa: 6001, value: 230 }), 1, 1));
  await sleep(150); const fwd = iecDev.got[0] ? parseIec104(iecDev.got[0]) : null;
  expect(!!fwd && fwd.ssn === 0 && fwd.rsn === 0, 'armed setpoint reaches the server renumbered as its first frame'); ie.close();

  console.log('MQTT 5');
  const mq = await Deno.connect({ hostname: '127.0.0.1', port: ports.mqtt });
  await mq.write(encodeConnect('hmi', 5));
  await mq.write(encodePublish({ topic: 'site/17/oven-3/setpoint/set', payload: '{"value":400}', qos: 1, packetId: 9, protocolLevel: 5 }));
  f = await readFrame(mq, new MqttFramerRaw());
  expect(!!f && f[0] === 0x40 && f[4] === 0x87, 'unsigned command: PUBACK reason 0x87 Not authorized');
  await sleep(100); const brokerPublishes = () => broker.got.filter((x) => x[0] >> 4 === 3).length;
  expect(brokerPublishes() === 0 && broker.got.length === 1, 'broker received the CONNECT but not the refused PUBLISH');
  await arm(240);
  await mq.write(encodePublish({ topic: 'site/17/oven-3/setpoint/set', payload: '{"value":240}', qos: 1, packetId: 10, protocolLevel: 5 }));
  await sleep(150); expect(brokerPublishes() === 1, 'armed command reaches the broker'); mq.close();

  console.log('BACnet/IP');
  const bc = Deno.listenDatagram({ port: 0, hostname: '127.0.0.1', transport: 'udp' });
  await bc.send(encodeBacnetWriteProperty({ invokeId: 7, objectType: BT['analog-value'], instance: 3, value: { real: 400 }, priority: 8 }), { transport: 'udp', hostname: '127.0.0.1', port: ports.bacnet });
  const [reply] = await Promise.race([bc.receive(), sleep(1500).then(() => [new Uint8Array()] as [Uint8Array])]);
  expect(reply.length > 0 && reply[reply.length - 7] === 0x50 && reply[reply.length - 1] === 40 && bacnetGot.length === 0, 'unsigned WriteProperty: Error-PDU write-access-denied, device untouched');
  await arm(250);
  await bc.send(encodeBacnetWriteProperty({ invokeId: 8, objectType: BT['analog-value'], instance: 3, value: { real: 250 }, priority: 8 }), { transport: 'udp', hostname: '127.0.0.1', port: ports.bacnet });
  await sleep(200); expect(bacnetGot.length === 1, 'armed WriteProperty reaches the device'); bc.close();

  console.log('Gremlin Server');
  const ws = new WebSocket(`ws://127.0.0.1:${ports.gremlin}`); const msgs: string[] = [];
  await new Promise((res) => { ws.onopen = res; }); ws.onmessage = (e) => msgs.push(String(e.data));
  const req = (v: number) => JSON.stringify({ requestId: `r${v}`, op: 'bytecode', processor: 'traversal', args: { gremlin: { '@type': 'g:Bytecode', '@value': { step: [['V', 'oven-3'], ['property', 'setpoint', { '@type': 'g:Double', '@value': v }]] } } } });
  ws.send(req(400)); await sleep(200);
  expect(msgs.length === 1 && JSON.parse(msgs[0]).status.code === 401 && gremlinGot.length === 0, 'unsigned property write: 401, server untouched');
  await arm(245); ws.send(req(245)); await sleep(300);
  expect(gremlinGot.length === 1, 'armed property write reaches the server'); ws.close();

  console.log('Evidence');
  await sleep(100);
  const { save } = await constraintGuardFor(data, cfg, { nodeKey: node.key }); void save; // a second reader of the same files
  // flush the running guard: SIGTERM is not available in-process, so read what it logged
  const verdicts = await readJsonl<GuardVerdict>(`${data}/constraint-verdicts.jsonl`);
  const refused = verdicts.filter((v) => !v.forward).length; const passed = verdicts.filter((v) => v.forward && !v.wouldRefuse).length;
  expect(refused === 7 && passed === 7, `verdict log: ${refused} refused, ${passed} passed (7 + 7 expected)`);
  const commands: CommandRecord[] = verdicts.filter((v) => v.forward).flatMap((v) => v.writes.map((w) => ({ at: Date.parse(v.at), point: w.point, value: w.value, command: w.command ?? null, source: v.source })));
  const rec = await reconcileConstraints(env, { commands });
  expect(rec.counts['unauthorized-command'] === 0, `every forwarded write re-verifies independently (${commands.length} commands)`);
  const tampered = commands.map((c, i) => (i === 0 ? { ...c, value: 400 } : c));
  expect((await reconcileConstraints(env, { commands: tampered })).counts['unauthorized-command'] === 1, 'an edited verdict log is caught by re-verification');
  const alerts = await readJsonl<GuardVerdict>(`${data}/constraint-alerts.jsonl`);
  expect(alerts.length === 7, `alerts logged for the 7 refusals (${alerts.length})`);

  // sealed observations: the Modbus reads (setpoint read-back) were observed; flush the running guard and verify the chain
  await running.save();
  const obsBatches = await readJsonl<SealedObservationBatch>(`${data}/constraint-observations.jsonl`);
  const opened = await openSealedObservations(obsBatches, [node.key.publicKeyHex]);
  expect(obsBatches.length === 1 && opened.integrity.state === 'sealed-verified' && opened.observations.length >= 1, `sealed observations verify (${opened.observations.length} in ${obsBatches.length} batch)`);
  const recTool = new URL('./constraint-reconcile.ts', import.meta.url).pathname;
  const runRec = async (sealedFile: string) => { const o = await new Deno.Command(Deno.execPath(), { args: ['run', '-A', recTool, '--config', `${work}/constraints.json`, '--data', data, '--sealed', sealedFile, '--collectors', node.key.publicKeyHex, '--commands', `${data}/constraint-verdicts.jsonl`, '--out', `${work}/report.json`], stdout: 'piped', stderr: 'piped' }).output(); return { code: o.code, out: new TextDecoder().decode(o.stdout) + new TextDecoder().decode(o.stderr) }; };
  let rc = await runRec(`${data}/constraint-observations.jsonl`);
  expect(rc.out.includes('integrity: sealed-verified') && !rc.out.includes('unauthorized-command'), `constraint-reconcile CLI on the sealed log (exit ${rc.code}): ${rc.out.split('\n')[0]}`);
  const forged = obsBatches.map((b) => ({ ...b, items: b.items.map((x) => ({ ...x, value: 999 })) }));
  await Deno.writeTextFile(`${work}/forged.jsonl`, forged.map((b) => JSON.stringify(b)).join('\n') + '\n');
  rc = await runRec(`${work}/forged.jsonl`);
  expect(rc.code === 1 && rc.out.includes('sealed-broken'), 'a historian edited after sealing makes constraint-reconcile exit 1 (sealed-broken)');

  console.log('Wizard CLI');
  const wdir = `${work}/wizard`; const wiz = new URL('./constraint-wizard.ts', import.meta.url).pathname;
  const run = async (...a: string[]) => { const o = await new Deno.Command(Deno.execPath(), { args: ['run', '-A', wiz, ...a, '--dir', wdir], env: { CAPPZ_CONSTRAINTS_OPERATOR_KEY: '' }, stdout: 'piped', stderr: 'piped' }).output(); return { code: o.code, out: new TextDecoder().decode(o.stdout) + new TextDecoder().decode(o.stderr) }; };
  let w = await run(); expect(w.code === 0 && w.out.includes('Set up (once)') && w.out.includes('Next: ') && w.out.includes(' keygen'), 'no step: the menu, then where you are and next = keygen');
  w = await run('keygen'); expect(w.code === 0 && /Public key: [0-9a-f]{64}/.test(w.out), 'keygen');
  w = await run('init', '--envelope-id', 'site-17/oven-3'); expect(w.code === 0, 'init');
  w = await run('next'); expect(w.out.includes('✓ your operator key') && w.out.includes('envelope-draft.json'), 'next after init: key and config done; next = write the envelope draft (a second operator is not a blocker yet)');
  await Deno.writeTextFile(`${wdir}/envelope-draft.json`, JSON.stringify({ asset: 'oven-3', points: env.points, constraints: env.constraints, modePoint: P.mode }));
  w = await run('declare'); expect(w.code === 0 && w.out.includes('active now'), 'declare v1 (active now)');
  const looser = { asset: 'oven-3', points: env.points, constraints: env.constraints.map((c) => (c.id === 'sp-range' ? { ...c, max: 300 } : c)), modePoint: P.mode };
  await Deno.writeTextFile(`${wdir}/envelope-draft.json`, JSON.stringify(looser));
  w = await run('declare'); expect(w.code === 0 && w.out.includes('LOOSENS') && w.out.includes('upper limit relaxed'), 'declare v2 lists its loosening');
  w = await run('status'); expect(w.out.includes('version 1 active') && w.out.includes('awaiting-endorsement'), 'status: v1 active, v2 awaiting endorsement');
  expect(w.out.includes('Next: ') && w.out.includes('front'), 'status ends with the next step (add a front)');
  w = await run('command', '--point', P.sp, '--value', '215'); expect(w.code === 0 && w.out.includes('Cappz-Command: '), 'command prints the signed header');
  w = await run('doctor'); expect(w.code === 1 && w.out.includes('only 1 are trusted'), 'doctor flags a single operator (loosening impossible) and no fronts');

  panel.shutdown(); gremlinDev.shutdown(); modbusDev.close(); dnp3Dev.close(); iecDev.close(); broker.close(); bacnetDevSock.close();
  await Deno.remove(work, { recursive: true }).catch(() => {});
  console.log(failures ? `\n${failures} expectation(s) failed` : '\nall expectations hold');
  Deno.exit(failures ? 1 : 0);
}

