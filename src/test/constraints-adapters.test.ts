import { describe, it, expect } from 'vitest';
import { ModbusFramer, decodeModbusRequest, encodeModbusReadResponse, encodeModbusRequest, encodeRegisterValue, isModbusWrite, modbusException, observationsFromModbusRead, parseModbusFrame, type ModbusRegister } from '../lib/constraints/adapters/modbus';
import { createSparkplugReader, decodeSparkplugPayload, encodeSparkplugPayload, parseSparkplugTopic, SPARKPLUG_LIMITS } from '../lib/constraints/adapters/sparkplug';
import { observationsFromCsv, observationsFromOpcUaJson, observationsFromRecords, opcuaQuality } from '../lib/constraints/adapters/records';

const MAP: ModbusRegister[] = [
  { unitId: 1, table: 'holding', address: 100, point: 'device-1/setpoint', type: 'int16', scale: 0.1 },
  { unitId: 1, table: 'holding', address: 200, point: 'dosing/rate', type: 'float32' },
  { unitId: 1, table: 'holding', address: 300, point: 'dosing/rate-le', type: 'float32', wordOrder: 'little' },
  { unitId: 1, table: 'holding', address: 400, point: 'counter', type: 'uint32' },
  { unitId: 1, table: 'coil', address: 5, point: 'breaker-7/close' },
  { unitId: 1, table: 'input', address: 0, point: 'device-1/value', type: 'int16', scale: 0.1 },
];

describe('15.40.0 Modbus TCP adapter', () => {
  it('decodes a single-register setpoint write in engineering units, signed and scaled', () => {
    const f = parseModbusFrame(encodeModbusRequest({ unitId: 1, fn: 6, address: 100, values: encodeRegisterValue(MAP[0], -22) }))!;
    expect(isModbusWrite(f.fn)).toBe(true);
    const d = decodeModbusRequest(f, MAP);
    expect(d).toMatchObject({ kind: 'write', unmapped: [] });
    if (d.kind === 'write') expect(d.writes[0].value).toBeCloseTo(-22, 6);
  });

  it('float32 in both word orders and uint32 across two registers', () => {
    for (const r of [MAP[1], MAP[2]]) {
      const f = parseModbusFrame(encodeModbusRequest({ unitId: 1, fn: 16, address: r.address, values: encodeRegisterValue(r, 3.75) }))!;
      const d = decodeModbusRequest(f, MAP);
      expect(d.kind === 'write' && d.writes[0]).toMatchObject({ point: r.point, value: 3.75 });
    }
    const f = parseModbusFrame(encodeModbusRequest({ unitId: 1, fn: 16, address: 400, values: encodeRegisterValue(MAP[3], 3_000_000_000) }))!;
    expect(decodeModbusRequest(f, MAP)).toMatchObject({ kind: 'write', writes: [{ value: 3_000_000_000 }] });
  });

  it('half of a 32-bit value, or registers outside the map, are unmapped (never guessed)', () => {
    const half = decodeModbusRequest(parseModbusFrame(encodeModbusRequest({ unitId: 1, fn: 6, address: 201, values: [0x4000] }))!, MAP);
    expect(half).toMatchObject({ kind: 'write', writes: [], unmapped: [{ table: 'holding', address: 201 }] });
    const span = decodeModbusRequest(parseModbusFrame(encodeModbusRequest({ unitId: 1, fn: 16, address: 99, values: [1, 2, 3] }))!, MAP);
    expect(span).toMatchObject({ kind: 'write', unmapped: [{ address: 99 }, { address: 101 }] });
    const otherUnit = decodeModbusRequest(parseModbusFrame(encodeModbusRequest({ unitId: 2, fn: 6, address: 100, values: [1] }))!, MAP);
    expect(otherUnit).toMatchObject({ writes: [], unmapped: [{ address: 100 }] });
  });

  it('coils: single and multiple, with strict values', () => {
    expect(decodeModbusRequest(parseModbusFrame(encodeModbusRequest({ unitId: 1, fn: 5, address: 5, coils: [true] }))!, MAP)).toMatchObject({ writes: [{ point: 'breaker-7/close', value: true }] });
    const multi = decodeModbusRequest(parseModbusFrame(encodeModbusRequest({ unitId: 1, fn: 15, address: 4, coils: [true, false, true] }))!, MAP);
    expect(multi).toMatchObject({ writes: [{ point: 'breaker-7/close', value: false }], unmapped: [{ address: 4 }, { address: 6 }] });
    const bad = encodeModbusRequest({ unitId: 1, fn: 5, address: 5, coils: [true] }); bad[10] = 0x12;
    expect(decodeModbusRequest(parseModbusFrame(bad)!, MAP)).toMatchObject({ kind: 'malformed' });
  });

  it('malformed lengths, unknown and vendor functions are reported for a guard to refuse', () => {
    const f = encodeModbusRequest({ unitId: 1, fn: 16, address: 100, values: [1, 2] });
    const lie = f.slice(); lie[12] = 9; // byte count disagrees with quantity
    expect(decodeModbusRequest(parseModbusFrame(lie)!, MAP)).toMatchObject({ kind: 'malformed' });
    const vendor = new Uint8Array([0, 1, 0, 0, 0, 3, 1, 0x41, 0]);
    expect(decodeModbusRequest(parseModbusFrame(vendor)!, MAP)).toEqual({ kind: 'unknown-function', fn: 0x41 });
    const mask = new Uint8Array([0, 1, 0, 0, 0, 8, 1, 22, 0, 100, 0xff, 0xff, 0, 0]);
    expect(decodeModbusRequest(parseModbusFrame(mask)!, MAP)).toMatchObject({ kind: 'write', writes: [], unmapped: [{ address: 100 }] });
    expect(parseModbusFrame(new Uint8Array([0, 1, 0, 0, 0, 9, 1, 3]))).toBeNull(); // length header lies
    expect(parseModbusFrame(new Uint8Array(3))).toBeNull();
  });

  it('the framer splits a TCP stream across arbitrary chunk boundaries and rejects absurd lengths', () => {
    const a = encodeModbusRequest({ transactionId: 1, unitId: 1, fn: 6, address: 100, values: [1] });
    const b = encodeModbusRequest({ transactionId: 2, unitId: 1, fn: 3, address: 0, quantity: 2 });
    const stream = new Uint8Array([...a, ...b]);
    for (let cut = 1; cut < stream.length; cut++) {
      const fr = new ModbusFramer();
      const frames = [...fr.push(stream.slice(0, cut)), ...fr.push(stream.slice(cut))];
      expect(frames.map((x) => parseModbusFrame(x)!.transactionId)).toEqual([1, 2]);
    }
    expect(() => new ModbusFramer().push(new Uint8Array([0, 1, 0, 0, 0xff, 0xff, 1, 3]))).toThrow(/out of range/);
    expect(() => new ModbusFramer().push(new Uint8Array([0, 1, 0, 0, 0, 1, 1, 3]))).toThrow(/out of range/);
  });

  it('reads become observations; exceptions and mismatched replies do not', () => {
    const req = parseModbusFrame(encodeModbusRequest({ transactionId: 7, unitId: 1, fn: 4, address: 0, quantity: 1 }))!;
    const res = parseModbusFrame(encodeModbusReadResponse(req, [encodeRegisterValue(MAP[5], -21.5)[0]]))!;
    expect(observationsFromModbusRead(req, res, MAP, 1000)).toEqual([{ at: 1000, point: 'device-1/value', value: -21.5, source: 'modbus' }]);
    const exc = parseModbusFrame(modbusException(req, 2))!;
    expect(exc).toMatchObject({ fn: 0x84, exception: 2, transactionId: 7 });
    expect(observationsFromModbusRead(req, exc, MAP, 1000)).toEqual([]);
    const coilReq = parseModbusFrame(encodeModbusRequest({ unitId: 1, fn: 1, address: 4, quantity: 3 }))!;
    expect(observationsFromModbusRead(coilReq, parseModbusFrame(encodeModbusReadResponse(coilReq, [false, true, false]))!, MAP, 5)).toEqual([{ at: 5, point: 'breaker-7/close', value: true, source: 'modbus' }]);
  });
});

describe('15.40.0 Sparkplug B adapter', () => {
  it('parses topics strictly', () => {
    expect(parseSparkplugTopic('spBv1.0/plant/DDATA/edge1/device1')).toMatchObject({ group: 'plant', type: 'DDATA', edgeNode: 'edge1', device: 'device1' });
    expect(parseSparkplugTopic('spBv1.0/plant/NDATA/edge1')).toMatchObject({ type: 'NDATA', device: undefined });
    for (const bad of ['spBv1.0/plant/DDATA/edge1', 'spBv1.0/plant/NDATA/edge1/dev', 'spBv1.0/plant/XDATA/edge1', 'spBv1.0/+/NDATA/edge1', 'spAv1.0/plant/NDATA/e', 'spBv1.0//NDATA/e']) expect(parseSparkplugTopic(bad), bad).toBeNull();
  });

  it('round-trips every scalar type, with sign extension for small signed ints', () => {
    const p = { timestamp: 1_700_000_000_000, seq: 3, metrics: [
      { name: 'a', datatype: 1, value: -5 }, { name: 'b', datatype: 2, value: -300 }, { name: 'c', datatype: 3, value: -70000 },
      { name: 'd', datatype: 4, value: -9_000_000_000 }, { name: 'e', datatype: 7, value: 4_000_000_000 }, { name: 'f', datatype: 9, value: 1.5 },
      { name: 'g', datatype: 10, value: -22.25 }, { name: 'h', value: true }, { name: 'i', value: 'defrost' }, { name: 'j', isNull: true, datatype: 10 },
    ] };
    const d = decodeSparkplugPayload(encodeSparkplugPayload(p));
    expect(d.timestamp).toBe(p.timestamp); expect(d.seq).toBe(3);
    expect(d.metrics.map((m) => m.value)).toEqual([-5, -300, -70000, -9_000_000_000, 4_000_000_000, 1.5, -22.25, true, 'defrost', undefined]);
    expect(d.metrics[9].isNull).toBe(true);
  });

  it('rejects truncated, overlong and oversized payloads', () => {
    const good = encodeSparkplugPayload({ metrics: [{ name: 'x', value: 1 }] });
    expect(() => decodeSparkplugPayload(good.slice(0, good.length - 3))).toThrow();
    expect(() => decodeSparkplugPayload(new Uint8Array([0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]))).toThrow(/too long/);
    expect(() => decodeSparkplugPayload(new Uint8Array([0x12, 0x7f, 0x01]))).toThrow(/past end/);
    expect(() => decodeSparkplugPayload(new Uint8Array(SPARKPLUG_LIMITS.maxBytes + 1))).toThrow(/too large/);
    expect(() => decodeSparkplugPayload(new Uint8Array([0x0b]))).toThrow(/wire type/); // group start (deprecated)
    expect(() => decodeSparkplugPayload(encodeSparkplugPayload({ metrics: [{ name: 'x', value: 'a' }] }).map((b, i, arr) => (i === arr.length - 1 ? 0xff : b)))).toThrow(); // invalid UTF-8
  });

  it('learns aliases at birth, forgets them at death, maps data and commands', () => {
    const r = createSparkplugReader({ 'plant/edge1/device1/Temperature': 'device-1/value', 'plant/edge1/device1/Setpoint': 'device-1/setpoint' });
    const birth = encodeSparkplugPayload({ timestamp: 1, metrics: [{ name: 'Temperature', alias: 1, value: -22 }, { name: 'Setpoint', alias: 2, value: -22 }, { name: 'Fan', alias: 3, value: true }] });
    const b = r.ingest('spBv1.0/plant/DBIRTH/edge1/device1', birth);
    expect(b.observations.map((o) => o.point)).toEqual(['device-1/value', 'device-1/setpoint']);
    expect(b.unmapped).toEqual(['plant/edge1/device1/Fan']);
    const data = r.ingest('spBv1.0/plant/DDATA/edge1/device1', encodeSparkplugPayload({ timestamp: 2, metrics: [{ alias: 1, value: -21.5 }, { alias: 9, value: 1 }] }));
    expect(data.observations).toEqual([{ at: 2, point: 'device-1/value', value: -21.5, source: 'sparkplug:spBv1.0/plant/DDATA/edge1/device1', quality: 'good' }]);
    expect(data.unknownAliases).toEqual([9]);
    const cmd = r.ingest('spBv1.0/plant/DCMD/edge1/device1', encodeSparkplugPayload({ timestamp: 3, metrics: [{ alias: 2, value: 50 }] }));
    expect(cmd.commands).toEqual([{ at: 3, point: 'device-1/setpoint', value: 50, source: 'sparkplug:spBv1.0/plant/DCMD/edge1/device1' }]);
    r.ingest('spBv1.0/plant/NDEATH/edge1', new Uint8Array());
    expect(r.ingest('spBv1.0/plant/DDATA/edge1/device1', encodeSparkplugPayload({ metrics: [{ alias: 1, value: -21 }] })).unknownAliases).toEqual([1]);
    expect(r.ingest('not/a/sparkplug/topic', new Uint8Array([1, 2, 3])).observations).toEqual([]);
  });
});

describe('15.40.0 OPC UA PubSub JSON and historian adapters', () => {
  it('reads DataValues, Variants and raw fields, mapping the most specific key', () => {
    const msg = { MessageId: '1', MessageType: 'ua-data', PublisherId: 'plc-7', Messages: [{ DataSetWriterId: 12, Timestamp: '2026-11-02T01:00:00Z', Payload: {
      Air: { Value: { Type: 11, Body: -21.5 }, SourceTimestamp: '2026-11-02T00:59:58Z' },
      Setpoint: { UaType: 11, Value: -22 },
      Mode: 'normal',
      Door: { Value: true, StatusCode: { Code: 0x40000000, Symbol: 'Uncertain' } },
      Fan: { Value: 1, StatusCode: 0x80000000 },
      Other: 5,
    } }] };
    const { observations, unmapped } = observationsFromOpcUaJson(msg, { 'plc-7/12/Air': 'device-1/value', '12/Setpoint': 'device-1/setpoint', Mode: 'device-1/mode', Door: 'door', Fan: 'fan' });
    expect(observations).toEqual([
      { at: Date.parse('2026-11-02T00:59:58Z'), point: 'device-1/value', value: -21.5, quality: 'good', source: 'opcua:plc-7/12/Air' },
      { at: Date.parse('2026-11-02T01:00:00Z'), point: 'device-1/setpoint', value: -22, quality: 'good', source: 'opcua:plc-7/12/Setpoint' },
      { at: Date.parse('2026-11-02T01:00:00Z'), point: 'device-1/mode', value: 'normal', quality: 'good', source: 'opcua:plc-7/12/Mode' },
      { at: Date.parse('2026-11-02T01:00:00Z'), point: 'door', value: true, quality: 'uncertain', source: 'opcua:plc-7/12/Door' },
      { at: Date.parse('2026-11-02T01:00:00Z'), point: 'fan', value: 1, quality: 'bad', source: 'opcua:plc-7/12/Fan' },
    ]);
    expect(unmapped).toEqual(['plc-7/12/Other']);
    expect(observationsFromOpcUaJson({ MessageType: 'ua-metadata', Messages: [] }, {}).observations).toEqual([]);
    expect(observationsFromOpcUaJson(null, {}).observations).toEqual([]);
  });

  it('StatusCode severity', () => {
    expect(opcuaQuality(undefined)).toBe('good'); expect(opcuaQuality(0x00AF0000)).toBe('good');
    expect(opcuaQuality(0x40920000)).toBe('uncertain'); expect(opcuaQuality(0x80340000)).toBe('bad'); expect(opcuaQuality({ Code: 'x' })).toBe('bad');
  });

  it('historian long format: tags, units, quality, epoch seconds, bad rows skipped, unmapped tags listed', () => {
    const csv = 'time,tag,val,eu,q\n1793581200,DEV1.AIR,-22.1,Cel,Good\n2026-11-02T01:05:00Z,DEV1.AIR,-4,[degF],good\n2026-11-02T01:10:00Z,DEV1.AIR,,Cel,Good\nnot a time,DEV1.AIR,1,Cel,Good\n2026-11-02T01:15:00Z,DEV1.AIR,-22,Cel,Comm Failure\n2026-11-02T01:15:00Z,DEV9.AIR,-22,Cel,Good\n2026-11-02T01:20:00Z,DEV1.MODE,defrost,,Good\n';
    const r = observationsFromCsv(csv, { at: 'time', tag: 'tag', value: 'val', unit: 'eu', quality: 'q', tags: { 'DEV1.AIR': 'device-1/value', 'DEV1.MODE': 'device-1/mode' } });
    expect(r.observations.map((o) => [o.at, o.value, o.unit, o.quality])).toEqual([
      [1793581200000, -22.1, 'Cel', 'good'], [Date.parse('2026-11-02T01:05:00Z'), -4, '[degF]', 'good'], [Date.parse('2026-11-02T01:15:00Z'), -22, 'Cel', 'bad'], [Date.parse('2026-11-02T01:20:00Z'), 'defrost', undefined, 'good'],
    ]);
    expect(r.unmapped).toEqual(['DEV9.AIR']);
    expect(r.skipped).toBe(2);
  });

  it('historian wide format and JSON rows by dot path', () => {
    const r = observationsFromCsv('ts,Air,Indep\n2026-11-02T01:00:00Z,-22,-21.8\n2026-11-02T01:05:00Z,,-21.9\n', { format: 'wide', at: 'ts', columns: { Air: 'device-1/value', Indep: 'device-1/air-independent' }, units: { Air: 'Cel', Indep: 'Cel' } });
    expect(r.observations).toHaveLength(3);
    const j = observationsFromRecords([{ t: 1793581200000, p: { name: 'x' }, v: { num: '1.5e1' } }], { at: 't', tag: 'p.name', value: 'v.num', tags: { x: 'pt' } });
    expect(j.observations[0]).toMatchObject({ at: 1793581200000, point: 'pt', value: 15 });
    const w = observationsFromRecords([{ t: 1, site: 'a', tag: 'x', v: 1 }, { t: 2, site: 'b', tag: 'x', v: 2 }], { at: 't', tag: 'tag', value: 'v', tags: { x: 'pt' }, where: { site: 'a' } });
    expect(w.observations.map((o) => o.value)).toEqual([1]);
  });
});
