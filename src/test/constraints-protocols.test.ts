import { describe, it, expect } from 'vitest';
import { BACNET_OBJECT_TYPES as BT, bacnetErrorReply, decodeBacnetRequest, encodeBacnetConfirmed, encodeBacnetCov, encodeBacnetReadPropertyAck, encodeBacnetWriteProperty, encodeBacnetWritePropertyMultiple, observationsFromBacnet, parseBacnetIp, type BacnetObjectMap } from '../lib/constraints/adapters/bacnet';
import { Dnp3Framer, decodeDnp3Request, dnp3Crc, dnp3RefusalResponse, encodeDnp3AnalogResponse, encodeDnp3Command, encodeDnp3Link, observationsFromDnp3, parseDnp3Apdu, parseDnp3Link, type Dnp3LinkFrame, type Dnp3PointMap } from '../lib/constraints/adapters/dnp3';
import { Iec104Framer, cp56ToMs, createIec104Session, decodeIec104Request, encodeCommandAsdu, encodeIec104I, encodeMeasuredAsdu, msToCp56, observationsFromIec104, parseAsdu, parseIec104, type Iec104PointMap } from '../lib/constraints/adapters/iec104';
import { MqttFramer, connectLevel, decodeMqttPublish, encodeConnect, encodePublish, mqttRefusal, parsePublish, readMqttMessage, ruleFor, topicMatches, type MqttTopicMap } from '../lib/constraints/adapters/mqtt';
import { decodeGremlinRequest, draftEnvelopeFromGraph, fromGraphSON, observationsFromGraph, type GraphPointMap } from '../lib/constraints/adapters/graph';
import { lintEnvelope } from '../lib/constraints/envelope';

// ─── BACnet/IP ────────────────────────────────────────────────────
const BMAP: BacnetObjectMap[] = [
  { objectType: BT['analog-value'], instance: 3, point: 'oven-3/setpoint' },
  { objectType: BT['binary-output'], instance: 1, point: 'oven-3/burner' },
  { objectType: BT['analog-input'], instance: 7, point: 'oven-3/value' },
  { objectType: BT['multi-state-value'], instance: 2, point: 'oven-3/mode' },
];

describe('15.40.0 BACnet/IP adapter', () => {
  it('WriteProperty: REAL, enumerated, unsigned, boolean, NULL (relinquish), with priority', () => {
    const cases: Array<[Parameters<typeof encodeBacnetWriteProperty>[0], unknown, string]> = [
      [{ invokeId: 1, objectType: BT['analog-value'], instance: 3, value: { real: 215.5 }, priority: 8 }, 215.5, 'oven-3/setpoint'],
      [{ invokeId: 2, objectType: BT['binary-output'], instance: 1, value: { enumerated: 1 } }, 1, 'oven-3/burner'],
      [{ invokeId: 3, objectType: BT['multi-state-value'], instance: 2, value: { unsigned: 3 } }, 3, 'oven-3/mode'],
      [{ invokeId: 4, objectType: BT['binary-output'], instance: 1, value: { boolean: true } }, true, 'oven-3/burner'],
      [{ invokeId: 5, objectType: BT['analog-value'], instance: 3, value: { null: true }, priority: 8 }, 'relinquish', 'oven-3/setpoint'],
    ];
    for (const [req, value, point] of cases) {
      const f = parseBacnetIp(encodeBacnetWriteProperty(req))!;
      expect(f).toMatchObject({ pduType: 0, service: 15, invokeId: req.invokeId });
      expect(decodeBacnetRequest(f, BMAP)).toEqual({ kind: 'write', writes: [{ point, value }], unmapped: [] });
    }
  });

  it('WritePropertyMultiple maps every property; other properties and array elements are unmapped', () => {
    const f = parseBacnetIp(encodeBacnetWritePropertyMultiple({ invokeId: 9, objects: [
      { objectType: BT['analog-value'], instance: 3, props: [{ value: { real: 200 }, priority: 10 }, { property: 77, value: { string: 'Oven 3 setpoint' } }] },
      { objectType: BT['binary-output'], instance: 1, props: [{ value: { enumerated: 0 } }] },
    ] }))!;
    expect(decodeBacnetRequest(f, BMAP)).toEqual({ kind: 'write', writes: [{ point: 'oven-3/setpoint', value: 200 }, { point: 'oven-3/burner', value: 0 }], unmapped: ['2:3/77'] });
    const arr = parseBacnetIp(encodeBacnetWriteProperty({ invokeId: 1, objectType: BT['analog-value'], instance: 3, value: { real: 1 }, arrayIndex: 2 }))!;
    expect(decodeBacnetRequest(arr, BMAP)).toMatchObject({ writes: [], unmapped: ['2:3/85[2]'] });
  });

  it('targets: a map entry for one device does not cover the same object on another', () => {
    const map = [{ ...BMAP[0], target: '10.0.0.5' }];
    const f = parseBacnetIp(encodeBacnetWriteProperty({ invokeId: 1, objectType: BT['analog-value'], instance: 3, value: { real: 1 } }))!;
    expect(decodeBacnetRequest(f, map, '10.0.0.5')).toMatchObject({ writes: [{ point: 'oven-3/setpoint' }] });
    expect(decodeBacnetRequest(f, map, '10.0.0.6')).toMatchObject({ writes: [] });
  });

  it('privileged services, segmentation and reads', () => {
    for (const [svc, what] of [[20, 'ReinitializeDevice'], [17, 'DeviceCommunicationControl'], [10, 'CreateObject'], [11, 'DeleteObject'], [7, 'AtomicWriteFile'], [18, 'ConfirmedPrivateTransfer'], [99, 'confirmed service 99']] as const) expect(decodeBacnetRequest(parseBacnetIp(encodeBacnetConfirmed(1, svc))!, BMAP)).toEqual({ kind: 'privileged', what });
    expect(decodeBacnetRequest(parseBacnetIp(encodeBacnetConfirmed(1, 12, [0x0c, 0, 0, 0, 1, 0x19, 85]))!, BMAP)).toEqual({ kind: 'read' });
    expect(decodeBacnetRequest(parseBacnetIp(encodeBacnetConfirmed(1, 15, [], true))!, BMAP)).toMatchObject({ kind: 'malformed', because: expect.stringMatching(/segmented/) });
    const writeGroup = new Uint8Array([0x81, 0x0b, 0, 8, 0x01, 0x00, 0x10, 10]);
    expect(decodeBacnetRequest(parseBacnetIp(writeGroup)!, BMAP)).toEqual({ kind: 'privileged', what: 'WriteGroup' });
    const whoIs = new Uint8Array([0x81, 0x0b, 0, 8, 0x01, 0x00, 0x10, 8]);
    expect(decodeBacnetRequest(parseBacnetIp(whoIs)!, BMAP)).toEqual({ kind: 'read' });
    const registerFd = new Uint8Array([0x81, 0x05, 0, 6, 0, 60]);
    expect(decodeBacnetRequest(parseBacnetIp(registerFd)!, BMAP).kind).toBe('privileged');
  });

  it('malformed: truncated tags, lengths past the end, trailing bytes, bad priority, constructed values', () => {
    const good = encodeBacnetWriteProperty({ invokeId: 1, objectType: BT['analog-value'], instance: 3, value: { real: 1 }, priority: 8 });
    const fix = (b: number[]) => { const u = new Uint8Array(b); u[2] = u.length >> 8; u[3] = u.length & 0xff; return u; };
    const g = Array.from(good);
    expect(decodeBacnetRequest(parseBacnetIp(fix(g.slice(0, -4)))!, BMAP).kind).toBe('malformed'); // no closing tag
    expect(decodeBacnetRequest(parseBacnetIp(fix([...g, 0x00]))!, BMAP).kind).toBe('malformed'); // trailing byte
    const prio = g.slice(); prio[prio.length - 1] = 17; expect(decodeBacnetRequest(parseBacnetIp(fix(prio))!, BMAP)).toMatchObject({ kind: 'malformed', because: expect.stringMatching(/priority/) });
    const longLen = g.slice(); const realAt = longLen.indexOf(0x44); longLen[realAt] = 0x45; longLen.splice(realAt + 1, 0, 200); // REAL with extended length 200
    expect(decodeBacnetRequest(parseBacnetIp(fix(longLen))!, BMAP).kind).toBe('malformed');
    const nested = encodeBacnetConfirmed(1, 15, [0x0c, 0x00, 0x80, 0x00, 0x03, 0x19, 85, 0x3e, 0x0e, 0x44, 0, 0, 0, 0, 0x0f, 0x3f]);
    expect(decodeBacnetRequest(parseBacnetIp(nested)!, BMAP)).toMatchObject({ kind: 'malformed', because: expect.stringMatching(/constructed/) });
    expect(parseBacnetIp(new Uint8Array([0x81, 0x0a, 0, 99, 1, 0]))).toBeNull(); // BVLC length lies
    expect(parseBacnetIp(new Uint8Array([0x82, 0x0a, 0, 6, 1, 0]))).toBeNull();
    expect(parseBacnetIp(new Uint8Array([0x81, 0x0a, 0, 6, 2, 0]))).toBeNull(); // NPDU version
  });

  it('routed requests: the error reply goes back to the source network', () => {
    const plain = Array.from(encodeBacnetWriteProperty({ invokeId: 42, objectType: BT['analog-value'], instance: 3, value: { real: 400 } }));
    const routed = [0x81, 0x0a, 0, 0, 0x01, 0x0c, 0x00, 0x05, 0x01, 0x07, ...plain.slice(6)]; routed[3] = routed.length; // SNET 5, SADR 07
    const f = parseBacnetIp(new Uint8Array(routed))!;
    expect(f.snet).toEqual({ net: 5, adr: new Uint8Array([7]) });
    expect(decodeBacnetRequest(f, BMAP)).toMatchObject({ writes: [{ value: 400 }] });
    const reply = bacnetErrorReply(f)!;
    expect(Array.from(reply.slice(4, 11))).toEqual([0x01, 0x20, 0, 5, 1, 7, 0xff]);
    expect(Array.from(reply.slice(-7))).toEqual([0x50, 42, 15, 0x91, 4, 0x91, 40]);
    expect(reply[3]).toBe(reply.length);
    expect(bacnetErrorReply(parseBacnetIp(new Uint8Array([0x81, 0x0b, 0, 8, 0x01, 0x00, 0x10, 10]))!)).toBeNull();
  });

  it('observations from ReadProperty-ACK and COV notifications', () => {
    expect(observationsFromBacnet(parseBacnetIp(encodeBacnetReadPropertyAck({ invokeId: 1, objectType: BT['analog-input'], instance: 7, value: { real: 201.25 } }))!, BMAP, 5)).toEqual([{ at: 5, point: 'oven-3/value', value: 201.25, source: 'bacnet' }]);
    expect(observationsFromBacnet(parseBacnetIp(encodeBacnetCov({ device: 1234, objectType: BT['analog-input'], instance: 7, value: { real: 199.5 } }))!, BMAP, 6)).toEqual([{ at: 6, point: 'oven-3/value', value: 199.5, source: 'bacnet' }]);
    expect(observationsFromBacnet(parseBacnetIp(encodeBacnetReadPropertyAck({ invokeId: 1, objectType: BT['analog-input'], instance: 8, value: { real: 1 } }))!, BMAP, 5)).toEqual([]);
  });
});

// ─── DNP3 ─────────────────────────────────────────────────────────
const DMAP: Dnp3PointMap[] = [
  { outstation: 10, table: 'analog-output', index: 2, point: 'pump-4/dose-setpoint' },
  { outstation: 10, table: 'binary-output', index: 0, point: 'breaker-7/closed' },
  { outstation: 10, table: 'analog-input', index: 1, point: 'pump-4/chlorine', scale: 0.01 },
];
const link = (b: Uint8Array) => parseDnp3Link(b) as Dnp3LinkFrame;

describe('15.40.0 DNP3 adapter', () => {
  it('CRC matches the DNP3 check value and frames round-trip across block boundaries', () => {
    expect(dnp3Crc(new TextEncoder().encode('123456789'))).toBe(0xea82);
    for (const n of [0, 1, 15, 16, 17, 32, 33, 250]) {
      const user = Array.from({ length: n }, (_, i) => (i * 7) & 0xff);
      const f = parseDnp3Link(encodeDnp3Link({ control: 0xc4, destination: 10, source: 1, userData: user }));
      expect('error' in f ? f.error : Array.from(f.userData)).toEqual(user);
    }
  });

  it('decodes analog output and CROB commands for every operate function', () => {
    for (const fc of [3, 4, 5, 6]) {
      for (const variation of [1, 2, 3, 4] as const) {
        const d = decodeDnp3Request(link(encodeDnp3Command({ fc, master: 1, outstation: 10, objects: [{ group: 41, variation, index: 2, value: variation >= 3 ? 1.5 : 150 }] })), DMAP);
        expect(d).toEqual({ kind: 'write', writes: [{ point: 'pump-4/dose-setpoint', value: variation >= 3 ? 1.5 : 150 }], unmapped: [] });
      }
    }
    expect(decodeDnp3Request(link(encodeDnp3Command({ fc: 5, master: 1, outstation: 10, objects: [{ group: 12, index: 0, on: false }, { group: 12, index: 9, on: true }] })), DMAP)).toEqual({ kind: 'write', writes: [{ point: 'breaker-7/closed', value: false }], unmapped: ['binary-output[9]@10'] });
    // the same index on another outstation is not covered
    expect(decodeDnp3Request(link(encodeDnp3Command({ fc: 5, master: 1, outstation: 11, objects: [{ group: 12, index: 0, on: true }] })), DMAP)).toMatchObject({ writes: [], unmapped: ['binary-output[0]@11'] });
  });

  it('CROB control codes: pulse/trip/close/latch read as on/off; queue, clear and odd codes are refused', () => {
    const crob = (code: number) => { const b = encodeDnp3Command({ fc: 5, master: 1, outstation: 10, objects: [{ group: 12, index: 0, on: true }] }); const f = link(b); const u = Array.from(f.userData); u[10] = code; return { ...f, userData: new Uint8Array(u) }; };
    expect(decodeDnp3Request(crob(0x41), DMAP)).toMatchObject({ writes: [{ value: true }] }); // PULSE_ON + CLOSE
    expect(decodeDnp3Request(crob(0x81), DMAP)).toMatchObject({ writes: [{ value: false }] }); // PULSE_ON + TRIP
    expect(decodeDnp3Request(crob(0x02), DMAP)).toMatchObject({ writes: [{ value: false }] }); // PULSE_OFF
    for (const c of [0x13, 0x23, 0x00, 0x05, 0x43]) expect(decodeDnp3Request(crob(c), DMAP).kind, c.toString(16)).toBe('malformed');
  });

  it('privileged functions, reads and broken frames', () => {
    const fc = (f: number) => link(encodeDnp3Link({ control: 0xc4, destination: 10, source: 1, userData: [0xc0, 0xc0, f] }));
    expect(decodeDnp3Request(fc(13), DMAP)).toEqual({ kind: 'privileged', what: 'COLD_RESTART' });
    expect(decodeDnp3Request(fc(2), DMAP)).toEqual({ kind: 'privileged', what: 'WRITE' });
    expect(decodeDnp3Request(fc(21), DMAP)).toEqual({ kind: 'privileged', what: 'DISABLE_UNSOLICITED' });
    expect(decodeDnp3Request(link(encodeDnp3Link({ control: 0xc4, destination: 10, source: 1, userData: [0xc0, 0xc0, 1, 60, 2, 0x06] })), DMAP)).toEqual({ kind: 'read' });
    expect(decodeDnp3Request(link(encodeDnp3Link({ control: 0xc4, destination: 10, source: 1, userData: [0x40, 0xc0, 5] })), DMAP)).toMatchObject({ kind: 'malformed', because: expect.stringMatching(/multi-segment/) });
    expect(decodeDnp3Request(link(encodeDnp3Link({ control: 0xc4, destination: 10, source: 1, userData: [0xc0, 0xc0, 5, 41, 1, 0x28, 1, 0, 2, 0, 1] })), DMAP)).toMatchObject({ kind: 'malformed', because: expect.stringMatching(/truncated/) });
    expect(decodeDnp3Request(link(encodeDnp3Link({ control: 0xc4, destination: 10, source: 1, userData: [0xc0, 0xc0, 5, 30, 1, 0x28, 1, 0, 2, 0, 1, 0, 0, 0, 0] })), DMAP)).toMatchObject({ kind: 'malformed', because: expect.stringMatching(/not a command/) });
    const frame = encodeDnp3Command({ fc: 5, master: 1, outstation: 10, objects: [{ group: 41, variation: 1, index: 2, value: 1 }] });
    const bad = frame.slice(); bad[12] ^= 0xff; expect(parseDnp3Link(bad)).toEqual({ error: 'data CRC (block 0)' });
    const badHead = frame.slice(); badHead[4] = 99; expect(parseDnp3Link(badHead)).toEqual({ error: 'header CRC' });
    expect(parseDnp3Apdu(new Uint8Array([0xc0, 0xc0, 5, 41, 1, 0x5b, 1]), true)).toMatchObject({ error: expect.stringMatching(/qualifier/) });
  });

  it('the framer resyncs nowhere: garbage throws, partial frames wait', () => {
    const a = encodeDnp3Command({ fc: 5, master: 1, outstation: 10, objects: [{ group: 41, variation: 3, index: 2, value: 1 }] });
    const fr = new Dnp3Framer();
    expect(fr.push(a.slice(0, 5))).toEqual([]);
    expect(fr.push(a.slice(5))).toHaveLength(1);
    expect(() => new Dnp3Framer().push(new Uint8Array(12))).toThrow(/sync/);
  });

  it('refusal echoes the objects with NOT_AUTHORIZED and the request sequence; DIRECT_OPERATE_NR gets none', () => {
    const req = link(encodeDnp3Command({ fc: 5, seq: 7, master: 1, outstation: 10, objects: [{ group: 41, variation: 2, index: 2, value: 900 }] }));
    const res = link(dnp3RefusalResponse(req)!);
    expect(res).toMatchObject({ destination: 1, source: 10 });
    const apdu = parseDnp3Apdu(res.userData, false);
    expect(apdu).toMatchObject({ fc: 129, seq: 7, objects: [{ group: 41, variation: 2, index: 2, value: 900, status: 9 }] });
    expect(dnp3RefusalResponse(link(encodeDnp3Command({ fc: 6, master: 1, outstation: 10, objects: [{ group: 12, index: 0, on: true }] })))).toBeNull();
  });

  it('observations with scaling and quality flags', () => {
    const ok = observationsFromDnp3(link(encodeDnp3AnalogResponse({ outstation: 10, master: 1, start: 0, values: [5, 250], variation: 1 })), DMAP, 9);
    expect(ok).toEqual([{ at: 9, point: 'pump-4/chlorine', value: 2.5, quality: 'good', source: 'dnp3' }]);
    expect(observationsFromDnp3(link(encodeDnp3AnalogResponse({ outstation: 10, master: 1, start: 1, values: [250], flags: 0x05 })), DMAP, 9)[0].quality).toBe('bad'); // COMM_LOST
    expect(observationsFromDnp3(link(encodeDnp3AnalogResponse({ outstation: 10, master: 1, start: 1, values: [250], flags: 0x11 })), DMAP, 9)[0].quality).toBe('uncertain'); // LOCAL_FORCED
    expect(observationsFromDnp3(link(encodeDnp3AnalogResponse({ outstation: 10, master: 1, start: 1, values: [250], flags: 0x00 })), DMAP, 9)[0].quality).toBe('bad'); // offline
  });
});

// ─── IEC 60870-5-104 ──────────────────────────────────────────────
const IMAP: Iec104PointMap[] = [
  { ca: 1, ioa: 5001, point: 'feeder-2/breaker' },
  { ca: 1, ioa: 6001, point: 'transformer-1/tap-setpoint' },
  { ca: 1, ioa: 6002, point: 'feeder-2/power-limit', scale: 10 },
  { ca: 1, ioa: 7001, point: 'feeder-2/current' },
];
const I = (asdu: Uint8Array, ssn = 0, rsn = 0) => parseIec104(encodeIec104I(asdu, ssn, rsn))!;

describe('15.40.0 IEC 60870-5-104 adapter', () => {
  it('decodes every command type, with and without time tags; select is checked like execute', () => {
    const t = Date.parse('2026-11-02T01:02:03.456Z');
    const cases: Array<[number, number | boolean, string, unknown]> = [
      [45, true, 'feeder-2/breaker', true], [58, false, 'feeder-2/breaker', false], [46, true, 'feeder-2/breaker', true], [59, false, 'feeder-2/breaker', false],
      [50, 1.25, 'transformer-1/tap-setpoint', 1.25], [63, 2.5, 'transformer-1/tap-setpoint', 2.5], [49, -120, 'feeder-2/power-limit', -1200], [48, 0.5, 'feeder-2/power-limit', 5],
    ];
    for (const [typeId, value, point, want] of cases) {
      const ioa = IMAP.find((m) => m.point === point)!.ioa;
      for (const select of [false, true]) expect(decodeIec104Request(I(encodeCommandAsdu({ typeId, ca: 1, ioa, value, select, time: t })), IMAP), `${typeId}`).toEqual({ kind: 'write', writes: [{ point, value: want }], unmapped: [] });
    }
    const asdu = parseAsdu(encodeCommandAsdu({ typeId: 63, ca: 1, ioa: 6001, value: 1, time: t }));
    expect('error' in asdu ? 0 : asdu.objects[0].time).toBe(t);
  });

  it('deactivation always passes; other causes, unmapped addresses, invalid states and privileged types', () => {
    expect(decodeIec104Request(I(encodeCommandAsdu({ typeId: 45, ca: 1, ioa: 5001, value: true, cot: 8 })), IMAP)).toEqual({ kind: 'read' });
    expect(decodeIec104Request(I(encodeCommandAsdu({ typeId: 45, ca: 1, ioa: 5001, value: true, cot: 3 })), IMAP)).toMatchObject({ kind: 'malformed' });
    expect(decodeIec104Request(I(encodeCommandAsdu({ typeId: 45, ca: 2, ioa: 5001, value: true })), IMAP)).toEqual({ kind: 'write', writes: [], unmapped: ['2:5001'] });
    const dc = encodeCommandAsdu({ typeId: 46, ca: 1, ioa: 5001, value: true }); dc[9] = 0x03;
    expect(decodeIec104Request(I(dc), IMAP)).toMatchObject({ kind: 'malformed', because: expect.stringMatching(/not permitted/) });
    expect(decodeIec104Request(I(new Uint8Array([105, 1, 6, 0, 1, 0, 0, 0, 0, 1])), IMAP)).toMatchObject({ kind: 'privileged', what: expect.stringMatching(/reset process/) });
    expect(decodeIec104Request(I(new Uint8Array([100, 1, 6, 0, 1, 0, 0, 0, 0, 20])), IMAP)).toEqual({ kind: 'read' });
    expect(decodeIec104Request(I(new Uint8Array([200, 1, 6, 0, 1, 0, 0, 0, 0, 1])), IMAP)).toMatchObject({ kind: 'privileged' });
    const short = encodeCommandAsdu({ typeId: 50, ca: 1, ioa: 6001, value: 1 }).slice(0, -1);
    expect(decodeIec104Request(I(short), IMAP)).toMatchObject({ kind: 'malformed', because: expect.stringMatching(/length/) });
    expect(decodeIec104Request(parseIec104(new Uint8Array([0x68, 4, 0x01, 0, 0, 0]))!, IMAP)).toEqual({ kind: 'read' }); // S-frame
  });

  it('APCI framing: sync, length bounds, I/S/U formats', () => {
    const a = encodeIec104I(encodeCommandAsdu({ typeId: 45, ca: 1, ioa: 5001, value: true }), 3, 4);
    const fr = new Iec104Framer();
    expect(fr.push(a.slice(0, 3))).toEqual([]);
    const [f] = fr.push(a.slice(3));
    expect(parseIec104(f)).toMatchObject({ format: 'I', ssn: 3, rsn: 4 });
    expect(parseIec104(new Uint8Array([0x68, 4, 0x07, 0, 0, 0]))).toMatchObject({ format: 'U', u: 0x07 });
    expect(() => new Iec104Framer().push(new Uint8Array([0x67, 4]))).toThrow(/sync/);
    expect(() => new Iec104Framer().push(new Uint8Array([0x68, 2]))).toThrow(/out of range/);
    expect(() => new Iec104Framer().push(new Uint8Array([0x68, 254]))).toThrow(/out of range/);
    expect(parseIec104(new Uint8Array([0x68, 5, 0x01, 0, 0, 0, 9]))).toBeNull(); // S with payload
  });

  it('measurements with sequences, quality and time tags', () => {
    const t = Date.parse('2026-11-02T01:00:00.250Z');
    expect(observationsFromIec104(I(encodeMeasuredAsdu({ typeId: 36, ca: 1, ioa: 7001, values: [412.5], time: t })), IMAP, 0)).toEqual([{ at: t, point: 'feeder-2/current', value: 412.5, quality: 'good', source: 'iec104' }]);
    const seq = observationsFromIec104(I(encodeMeasuredAsdu({ typeId: 13, ca: 1, ioa: 7000, values: [1, 2, 3], sq: true, qds: 0x80 })), IMAP, 5);
    expect(seq).toEqual([{ at: 5, point: 'feeder-2/current', value: 2, quality: 'bad', source: 'iec104' }]);
    expect(cp56ToMs(new Uint8Array(msToCp56(t)), 0)).toBe(t);
    const invalid = msToCp56(t); invalid[2] |= 0x80; expect(cp56ToMs(new Uint8Array(invalid), 0)).toBeUndefined();
  });

  it('a gateway that refuses a command keeps both sides\' sequence numbers consistent', () => {
    const s = createIec104Session();
    // server sends 2 measurements to the client
    expect(parseIec104(s.toClient(I(encodeMeasuredAsdu({ typeId: 13, ca: 1, ioa: 7001, values: [1] }), 0, 0)))).toMatchObject({ ssn: 0, rsn: 0 });
    expect(parseIec104(s.toClient(I(encodeMeasuredAsdu({ typeId: 13, ca: 1, ioa: 7001, values: [1] }), 1, 0)))).toMatchObject({ ssn: 1, rsn: 0 });
    // client command #0 is forwarded
    expect(parseIec104(s.toServer(I(encodeCommandAsdu({ typeId: 45, ca: 1, ioa: 5001, value: true }), 0, 2)))).toMatchObject({ ssn: 0, rsn: 2 });
    // client command #1 is refused: the client gets a negative confirmation numbered after the server's 2 frames
    const reply = parseIec104(s.refuse(I(encodeCommandAsdu({ typeId: 50, ca: 1, ioa: 6001, value: 99 }), 1, 2)))!;
    expect(reply).toMatchObject({ format: 'I', ssn: 2, rsn: 2 });
    const asdu = parseAsdu(reply.asdu!); expect(asdu).toMatchObject({ typeId: 50, cot: 7, negative: true, ca: 1, objects: [{ ioa: 6001, value: 99 }] });
    // client command #2 reaches the server as #1; the client's ack of 3 frames becomes 2
    expect(parseIec104(s.toServer(I(encodeCommandAsdu({ typeId: 45, ca: 1, ioa: 5001, value: false }), 2, 3)))).toMatchObject({ ssn: 1, rsn: 2 });
    // the server's next frame (its #2, acking 2 of the client's frames) reaches the client as #3 acking 3
    expect(parseIec104(s.toClient(I(encodeMeasuredAsdu({ typeId: 13, ca: 1, ioa: 7001, values: [1] }), 2, 2)))).toMatchObject({ ssn: 3, rsn: 3 });
    // S-frames are renumbered too
    expect(parseIec104(s.toServer(parseIec104(new Uint8Array([0x68, 4, 0x01, 0, 8, 0]))!))).toMatchObject({ format: 'S', rsn: 3 });
    expect(s.state()).toEqual({ dropped: 1, injected: 1 });
  });
});

// ─── MQTT ─────────────────────────────────────────────────────────
const MMAP: MqttTopicMap = {
  'site/17/oven-3/temp': { point: 'oven-3/value', valuePath: 'value', timePath: 'ts', unit: '[degF]' },
  'site/17/oven-3/setpoint/set': { point: 'oven-3/setpoint', valuePath: 'value', command: true },
  'site/17/+/door': { point: 'door', valuePath: 'open' },
  'site/17/#': { point: 'catch-all' },
};

describe('15.40.0 MQTT adapter', () => {
  it('topic filters match level by level; $-topics never match a leading wildcard', () => {
    expect(topicMatches('a/+/c', 'a/b/c')).toBe(true); expect(topicMatches('a/+/c', 'a/b/x/c')).toBe(false);
    expect(topicMatches('a/#', 'a')).toBe(true); expect(topicMatches('a/#', 'a/b/c')).toBe(true);
    expect(topicMatches('#', '$SYS/x')).toBe(false); expect(topicMatches('a/b', 'a/b/')).toBe(false);
    expect(topicMatches('a/.*', 'a/xyz')).toBe(false); // nothing is a regular expression
    expect(ruleFor(MMAP, 'site/17/oven-3/temp')!.point).toBe('oven-3/value');
    expect(ruleFor(MMAP, 'site/17/oven-9/door')!.point).toBe('door');
    expect(ruleFor(MMAP, 'site/17/x/y/z')!.point).toBe('catch-all');
    expect(ruleFor(MMAP, 'other')).toBeUndefined();
  });

  it('reads JSON, bare values, ON/OFF, times in s/ms/ISO, and reports what it cannot read', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(readMqttMessage('site/17/oven-3/temp', enc('{"value": 392, "ts": 1793581200}'), MMAP)).toMatchObject({ observation: { at: 1793581200000, point: 'oven-3/value', value: 392, unit: '[degF]' } });
    expect(readMqttMessage('site/17/oven-3/setpoint/set', enc('{"value":"215"}'), MMAP, 7)).toMatchObject({ command: { at: 7, point: 'oven-3/setpoint', value: 215 } });
    expect(readMqttMessage('site/17/a/b', enc('ON'), MMAP, 1)).toMatchObject({ observation: { value: true } });
    expect(readMqttMessage('site/17/oven-3/temp', enc('{"nope":1}'), MMAP).error).toMatch(/no value at value/);
    expect(readMqttMessage('site/17/oven-3/temp', new Uint8Array([0xff, 0xfe]), MMAP).error).toMatch(/UTF-8/);
    expect(readMqttMessage('elsewhere', enc('1'), MMAP)).toEqual({ unmapped: 'elsewhere' });
  });

  it('packets: framing, PUBLISH in 3.1.1 and 5.0, bounded lengths, strict topics', () => {
    const fr = new MqttFramer();
    const c = encodeConnect('gw', 5); const p = encodePublish({ topic: 'site/17/oven-3/setpoint/set', payload: '{"value":400}', qos: 1, packetId: 77, protocolLevel: 5 });
    const pk = [...fr.push(c.slice(0, 4)), ...fr.push(new Uint8Array([...c.slice(4), ...p]))];
    expect(pk.map((x) => x.type)).toEqual([1, 3]);
    expect(connectLevel(pk[0])).toBe(5);
    const pub = parsePublish(pk[1], 5);
    expect(pub).toMatchObject({ topic: 'site/17/oven-3/setpoint/set', qos: 1, packetId: 77 });
    expect(decodeMqttPublish(pub as never, MMAP)).toEqual({ kind: 'write', writes: [{ point: 'oven-3/setpoint', value: 400 }], unmapped: [] });
    expect(decodeMqttPublish(parsePublish(new MqttFramer().push(encodePublish({ topic: 'site/17/oven-3/temp', payload: '1' }))[0], 4) as never, MMAP)).toEqual({ kind: 'read' });
    expect(() => new MqttFramer(100).push(encodePublish({ topic: 't', payload: 'x'.repeat(200) }))).toThrow(/limit/);
    expect(() => new MqttFramer().push(new Uint8Array([0x30, 0xff, 0xff, 0xff, 0xff, 0x01]))).toThrow(/4 bytes/);
    const wild = new MqttFramer().push(encodePublish({ topic: 'a/+', payload: '1' }))[0];
    expect(parsePublish(wild, 4)).toEqual({ error: 'invalid topic name' });
    const zeroId = new MqttFramer().push(encodePublish({ topic: 'a', payload: '1', qos: 1, packetId: 0 }))[0];
    expect(parsePublish(zeroId, 4)).toEqual({ error: 'packet id 0' });
    const badProps = new Uint8Array([0x32, 6, 0, 1, 0x61, 0, 1, 50]); // property length 50 past the end
    expect(parsePublish(new MqttFramer().push(badProps)[0], 5)).toEqual({ error: 'properties past end' });
  });

  it('refusals: MQTT 5 says not authorised; 3.1.1 closes for QoS 1/2 and drops QoS 0', () => {
    const pub = (qos: 0 | 1 | 2) => ({ topic: 't', qos, retain: false, dup: false, packetId: 0x1234, payload: new Uint8Array() });
    expect(mqttRefusal(pub(1), 5)).toEqual({ action: 'reply', reply: new Uint8Array([0x40, 3, 0x12, 0x34, 0x87]) });
    expect(mqttRefusal(pub(2), 5).reply![0]).toBe(0x50);
    expect(mqttRefusal(pub(1), 4)).toEqual({ action: 'close' });
    expect(mqttRefusal(pub(0), 5)).toEqual({ action: 'drop' });
  });
});

// ─── Apache TinkerPop (Gremlin / GraphSON 3) ──────────────────────
const GMAP: GraphPointMap[] = [
  { vertexId: 'oven-3', key: 'setpoint', point: 'oven-3/setpoint' },
  { vertexId: 'oven-4', key: 'setpoint', point: 'oven-4/setpoint' },
  { vertexId: 'oven-3', key: 'temperature', point: 'oven-3/value' },
];
const bytecode = (step: unknown[], source: unknown[] = []) => ({ requestId: 'r1', op: 'bytecode', processor: 'traversal', args: { gremlin: { '@type': 'g:Bytecode', '@value': { step, source } }, aliases: { g: 'g' } } });
const d = (n: number) => ({ '@type': 'g:Double', '@value': n });

describe('15.40.0 Apache TinkerPop adapter', () => {
  it('GraphSON 3 values: numbers, lists, maps, dates, depth limit', () => {
    expect(fromGraphSON({ '@type': 'g:Map', '@value': ['a', { '@type': 'g:List', '@value': [{ '@type': 'g:Int32', '@value': 1 }, { '@type': 'g:Int64', '@value': 2 }] }] })).toEqual({ a: [1, 2] });
    expect(fromGraphSON({ '@type': 'g:Date', '@value': 5 })).toEqual({ $date: 5 });
    let deep: unknown = 1; for (let i = 0; i < 100; i++) deep = [deep];
    expect(() => fromGraphSON(deep as never)).toThrow(/deeply/);
  });

  it('literal vertex ids → point writes, including cardinality and several ids', () => {
    expect(decodeGremlinRequest(bytecode([['V', 'oven-3'], ['property', 'setpoint', d(215)]]), GMAP)).toEqual({ kind: 'write', writes: [{ point: 'oven-3/setpoint', value: 215 }], unmapped: [] });
    expect(decodeGremlinRequest(bytecode([['V', 'oven-3', 'oven-4'], ['has', 'site', '17'], ['property', { '@type': 'g:Cardinality', '@value': 'single' }, 'setpoint', d(220)], ['property', 'note', 'retune'], ['iterate']]), GMAP))
      .toEqual({ kind: 'write', writes: [{ point: 'oven-3/setpoint', value: 220 }, { point: 'oven-4/setpoint', value: 220 }], unmapped: ['oven-3.note', 'oven-4.note'] });
    expect(decodeGremlinRequest(bytecode([['V', 'oven-3'], ['values', 'setpoint']]), GMAP)).toEqual({ kind: 'read' });
  });

  it('a bulk write to a governed property cannot be checked and is refused; an ungoverned one is unmapped', () => {
    expect(decodeGremlinRequest(bytecode([['V'], ['has', 'type', 'oven'], ['property', 'setpoint', d(400)]]), GMAP)).toMatchObject({ kind: 'malformed', because: expect.stringMatching(/bulk write/) });
    expect(decodeGremlinRequest(bytecode([['V', 'line-1'], ['out', 'contains'], ['property', 'setpoint', d(400)]]), GMAP)).toMatchObject({ kind: 'malformed' });
    expect(decodeGremlinRequest(bytecode([['V'], ['property', 'color', 'red']]), GMAP)).toEqual({ kind: 'write', writes: [], unmapped: ['*.color'] });
    expect(decodeGremlinRequest(bytecode([['E', 'e1'], ['property', 'setpoint', d(1)]]), GMAP)).toMatchObject({ kind: 'malformed', because: expect.stringMatching(/edge/) });
  });

  it('scripts, lambdas, structure changes, identity changes and computed values are privileged', () => {
    expect(decodeGremlinRequest({ op: 'eval', args: { gremlin: "g.V('oven-3').property('setpoint', 400)" } }, GMAP)).toMatchObject({ kind: 'privileged', what: expect.stringMatching(/script/) });
    expect(decodeGremlinRequest(bytecode([['V', 'oven-3'], ['map', { '@type': 'g:Lambda', '@value': { script: 'x -> 1', language: 'gremlin-groovy', arguments: 1 } }]]), GMAP)).toMatchObject({ kind: 'privileged', what: expect.stringMatching(/lambda/) });
    for (const s of ['drop', 'addV', 'addE', 'mergeV', 'mergeE', 'io', 'call']) expect(decodeGremlinRequest(bytecode([['V', 'oven-3'], [s]]), GMAP).kind, s).toBe('privileged');
    expect(decodeGremlinRequest(bytecode([['V', 'oven-3'], ['property', { '@type': 'g:T', '@value': 'id' }, 'x']]), GMAP)).toMatchObject({ kind: 'privileged' });
    expect(decodeGremlinRequest(bytecode([['V', 'oven-3'], ['property', 'setpoint', { '@type': 'g:Bytecode', '@value': { step: [['constant', d(400)]] } }]]), GMAP)).toMatchObject({ kind: 'privileged', what: expect.stringMatching(/computed/) });
    expect(decodeGremlinRequest(bytecode([['V', 'oven-3'], ['sideEffect', { '@type': 'g:Bytecode', '@value': { step: [['drop']] } }]]), GMAP)).toMatchObject({ kind: 'privileged' });
    expect(decodeGremlinRequest(bytecode([['V', 'oven-3'], ['weirdStep']]), GMAP)).toMatchObject({ kind: 'privileged', what: expect.stringMatching(/checked list/) });
    expect(decodeGremlinRequest(bytecode([['V', 'oven-3']], [['withComputer']]), GMAP)).toMatchObject({ kind: 'privileged' });
    expect(decodeGremlinRequest({ op: 'bytecode', args: { gremlin: 'g.V()' } }, GMAP)).toMatchObject({ kind: 'malformed' });
    expect(decodeGremlinRequest({ op: 'authentication', args: {} }, GMAP)).toEqual({ kind: 'read' });
  });

  it('observations from GraphSON vertices with timestamp meta-properties', () => {
    const v = { '@type': 'g:List', '@value': [{ '@type': 'g:Vertex', '@value': { id: 'oven-3', label: 'oven', properties: {
      temperature: [{ '@type': 'g:VertexProperty', '@value': { id: 'p1', label: 'temperature', value: d(201.5), properties: { ts: { '@type': 'g:Date', '@value': 1793581200000 } } } }],
      setpoint: [{ '@type': 'g:VertexProperty', '@value': { id: 'p2', label: 'setpoint', value: d(200) } }],
      color: [{ '@type': 'g:VertexProperty', '@value': { id: 'p3', label: 'color', value: 'steel' } }],
    } } }] };
    const r = observationsFromGraph(v, GMAP, { receivedAt: 9 });
    expect(r.observations).toEqual([{ at: 1793581200000, point: 'oven-3/value', value: 201.5, source: 'graph:oven-3' }, { at: 9, point: 'oven-3/setpoint', value: 200, source: 'graph:oven-3' }]);
    expect(r.unmapped).toEqual(['oven-3.color']);
  });

  it('drafts an envelope from explicit graph structure; missing numbers are listed, never invented', () => {
    const vp = (value: unknown) => [{ id: 'x', value }];
    const graph = {
      vertices: [
        { id: 'oven-3/value', label: 'sensor', properties: { unit: vp('Cel'), min: vp(150), max: vp(260), gapMs: vp(600000) } },
        { id: 'oven-3/probe', label: 'sensor', properties: { unit: vp('Cel') } },
        { id: 'oven-3/setpoint', label: 'setpoint', properties: { unit: vp('Cel'), min: vp(160), max: vp(250), step: vp(20) } },
        { id: 'oven-3', label: 'oven', properties: {} },
        { id: 'oven-3/fan', label: 'setpoint', properties: {} },
      ],
      edges: [
        { id: 'e1', label: 'redundantWith', outV: 'oven-3/value', inV: 'oven-3/probe', properties: { tolerance: { value: 6 } } },
        { id: 'e2', label: 'controls', outV: 'oven-3/setpoint', inV: 'oven-3/value', properties: { withinMs: { value: 900000 }, deadband: { value: 2 } } },
        { id: 'e3', label: 'redundantWith', outV: 'oven-3/value', inV: 'oven-3/setpoint', properties: {} },
        { id: 'e4', label: 'partOf', outV: 'oven-3/value', inV: 'oven-3', properties: {} },
      ],
    };
    const r = draftEnvelopeFromGraph(graph, { pointLabels: { sensor: 'measurement', setpoint: 'setpoint' }, keys: { unit: 'unit', min: 'min', max: 'max', maxStep: 'step', maxGapMs: 'gapMs' }, redundancy: { label: 'redundantWith', toleranceKey: 'tolerance' }, control: { label: 'controls', withinMsKey: 'withinMs', deadbandKey: 'deadband' } });
    expect(r.points.map((p) => p.id)).toEqual(['oven-3/value', 'oven-3/probe', 'oven-3/setpoint']);
    expect(r.constraints.map((c) => `${c.kind}:${c.id}`)).toEqual(['range:oven-3/value/range', 'range:oven-3/setpoint/range', 'rate:oven-3/setpoint/step', 'agreement:oven-3/value~oven-3/probe/agree', 'response:oven-3/setpoint->oven-3/value/response']);
    expect(r.needs).toEqual(['point oven-3/probe: limits (properties min / max)', 'point oven-3/fan: unit (property unit)', 'redundancy oven-3/value–oven-3/setpoint: tolerance (edge property tolerance)']);
    expect(lintEnvelope({ points: r.points, constraints: r.constraints })).toEqual([]);
  });
});
