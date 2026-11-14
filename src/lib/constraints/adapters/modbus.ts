/**
 * COPE node crystallized.
 * Node ID: v15-40-00-constraint-adapter-modbus
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Modbus TCP (MBAP header + PDU, Modbus Application Protocol v1.1b3) for
 * constraint checks. Modbus has no authentication: any host that reaches
 * port 502 can write any register. This module reads frames in both
 * directions, maps registers and coils to envelope points through an explicit
 * register map, and builds exception replies so a gateway can refuse a write
 * without the controller ever seeing it.
 *
 * Covered: read coils/discrete inputs/holding/input registers (1–4), write
 * single coil (5), write single register (6), write multiple coils (15), write
 * multiple registers (16), mask write (22) and read/write multiple (23) — the
 * last two are always treated as writes the map must cover. Anything else that
 * could write (file records, vendor function codes) is `unknown-function` and a
 * guard refuses it unless the operator allows it explicitly.
 */

import type { PointValue } from '../authority.ts';

export type ModbusTable = 'coil' | 'discrete' | 'holding' | 'input';
export type ModbusType = 'bool' | 'int16' | 'uint16' | 'int32' | 'uint32' | 'float32';

export interface ModbusRegister {
  unitId: number; table: ModbusTable; address: number; point: string;
  type?: ModbusType; /** For 32-bit values: which register holds the high word (default 'big': first). */ wordOrder?: 'big' | 'little';
  /** Engineering value = raw * scale + offset (default 1, 0). */ scale?: number; offset?: number;
}

export interface ModbusFrame {
  transactionId: number; protocolId: number; unitId: number; fn: number;
  exception?: number;
  pdu: Uint8Array;
}

export interface ModbusWrite { point: string; value: PointValue; register: ModbusRegister }
export type ModbusWriteDecode =
  | { kind: 'read' }
  | { kind: 'write'; writes: ModbusWrite[]; unmapped: Array<{ table: ModbusTable; address: number }> }
  | { kind: 'unknown-function'; fn: number }
  | { kind: 'malformed'; because: string };

const WRITE_FNS = new Set([5, 6, 15, 16, 22, 23]);
export const isModbusWrite = (fn: number) => WRITE_FNS.has(fn & 0x7f);

/** Split a TCP byte stream into whole MBAP frames (keeps the remainder). */
export class ModbusFramer {
  private buf = new Uint8Array(0);
  push(chunk: Uint8Array): Uint8Array[] {
    const b = new Uint8Array(this.buf.length + chunk.length); b.set(this.buf); b.set(chunk, this.buf.length); this.buf = b;
    const out: Uint8Array[] = [];
    while (this.buf.length >= 7) {
      const len = (this.buf[4] << 8) | this.buf[5];
      if (len < 2 || len > 254) throw new Error(`Modbus frame length ${len} out of range`);
      if (this.buf.length < 6 + len) break;
      out.push(this.buf.slice(0, 6 + len)); this.buf = this.buf.slice(6 + len);
    }
    return out;
  }
}

export function parseModbusFrame(bytes: Uint8Array): ModbusFrame | null {
  if (bytes.length < 8) return null;
  const len = (bytes[4] << 8) | bytes[5];
  if (bytes.length !== 6 + len) return null;
  const fn = bytes[7];
  return { transactionId: (bytes[0] << 8) | bytes[1], protocolId: (bytes[2] << 8) | bytes[3], unitId: bytes[6], fn, exception: fn & 0x80 ? bytes[8] : undefined, pdu: bytes.slice(7) };
}

const u16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];

function regs(map: readonly ModbusRegister[], unitId: number, table: ModbusTable) { return map.filter((r) => r.unitId === unitId && r.table === table); }
const width = (r: ModbusRegister) => (r.type === 'int32' || r.type === 'uint32' || r.type === 'float32' ? 2 : 1);

function decodeRegisters(r: ModbusRegister, words: number[]): number {
  const t = r.type ?? 'uint16'; let raw: number;
  if (t === 'int16') raw = words[0] & 0x8000 ? words[0] - 0x10000 : words[0];
  else if (t === 'uint16' || t === 'bool') raw = words[0];
  else {
    const [hi, lo] = (r.wordOrder ?? 'big') === 'big' ? [words[0], words[1]] : [words[1], words[0]];
    const dv = new DataView(new ArrayBuffer(4)); dv.setUint16(0, hi); dv.setUint16(2, lo);
    raw = t === 'float32' ? dv.getFloat32(0) : t === 'int32' ? dv.getInt32(0) : dv.getUint32(0);
  }
  return raw * (r.scale ?? 1) + (r.offset ?? 0);
}

/** Engineering value → register words (for building writes in tests and tools). */
export function encodeRegisterValue(r: ModbusRegister, value: number): number[] {
  const raw = (value - (r.offset ?? 0)) / (r.scale ?? 1); const t = r.type ?? 'uint16';
  if (t === 'int16' || t === 'uint16' || t === 'bool') return [Math.round(raw) & 0xffff];
  const dv = new DataView(new ArrayBuffer(4));
  if (t === 'float32') dv.setFloat32(0, raw); else if (t === 'int32') dv.setInt32(0, Math.round(raw)); else dv.setUint32(0, Math.round(raw));
  const words = [dv.getUint16(0), dv.getUint16(2)];
  return (r.wordOrder ?? 'big') === 'big' ? words : [words[1], words[0]];
}

/** Register values written to a block starting at `start`, mapped to points. */
function mapRegisterBlock(map: readonly ModbusRegister[], unitId: number, table: ModbusTable, start: number, words: number[]): { writes: ModbusWrite[]; unmapped: Array<{ table: ModbusTable; address: number }> } {
  const writes: ModbusWrite[] = []; const covered = new Set<number>();
  for (const r of regs(map, unitId, table)) {
    const w = width(r);
    if (r.address >= start && r.address + w <= start + words.length) {
      writes.push({ point: r.point, value: decodeRegisters(r, words.slice(r.address - start, r.address - start + w)), register: r });
      for (let i = 0; i < w; i++) covered.add(r.address + i);
    } else if (r.address < start + words.length && r.address + w > start) {
      // a 32-bit value written half: refuse as unmapped (the other half is undefined)
    }
  }
  const unmapped = words.map((_, i) => start + i).filter((a) => !covered.has(a)).map((address) => ({ table, address }));
  return { writes, unmapped };
}

/** What a client request intends to write, in envelope points. */
export function decodeModbusRequest(frame: ModbusFrame, map: readonly ModbusRegister[]): ModbusWriteDecode {
  const p = frame.pdu; const fn = frame.fn;
  try {
    if (fn >= 1 && fn <= 4) return p.length === 5 ? { kind: 'read' } : { kind: 'malformed', because: 'read request length' };
    if (fn === 5) {
      if (p.length !== 5) return { kind: 'malformed', because: 'write single coil length' };
      const addr = u16(p, 1); const v = u16(p, 3);
      if (v !== 0xff00 && v !== 0x0000) return { kind: 'malformed', because: 'coil value must be FF00 or 0000' };
      const r = regs(map, frame.unitId, 'coil').find((x) => x.address === addr);
      return r ? { kind: 'write', writes: [{ point: r.point, value: v === 0xff00, register: r }], unmapped: [] } : { kind: 'write', writes: [], unmapped: [{ table: 'coil', address: addr }] };
    }
    if (fn === 6) {
      if (p.length !== 5) return { kind: 'malformed', because: 'write single register length' };
      return { kind: 'write', ...mapRegisterBlock(map, frame.unitId, 'holding', u16(p, 1), [u16(p, 3)]) };
    }
    if (fn === 15) {
      const start = u16(p, 1); const qty = u16(p, 3); const n = p[5];
      if (qty < 1 || qty > 1968 || n !== Math.ceil(qty / 8) || p.length !== 6 + n) return { kind: 'malformed', because: 'write multiple coils length' };
      const writes: ModbusWrite[] = []; const unmapped: Array<{ table: ModbusTable; address: number }> = [];
      for (let i = 0; i < qty; i++) {
        const on = !!(p[6 + (i >> 3)] & (1 << (i & 7)));
        const r = regs(map, frame.unitId, 'coil').find((x) => x.address === start + i);
        if (r) writes.push({ point: r.point, value: on, register: r }); else unmapped.push({ table: 'coil', address: start + i });
      }
      return { kind: 'write', writes, unmapped };
    }
    if (fn === 16) {
      const start = u16(p, 1); const qty = u16(p, 3); const n = p[5];
      if (qty < 1 || qty > 123 || n !== qty * 2 || p.length !== 6 + n) return { kind: 'malformed', because: 'write multiple registers length' };
      const words = Array.from({ length: qty }, (_, i) => u16(p, 6 + i * 2));
      return { kind: 'write', ...mapRegisterBlock(map, frame.unitId, 'holding', start, words) };
    }
    if (fn === 22) {
      // Mask write: the result depends on the current value, so it can only pass when the register is unmapped-and-allowed. Report it as unmapped.
      if (p.length !== 7) return { kind: 'malformed', because: 'mask write length' };
      return { kind: 'write', writes: [], unmapped: [{ table: 'holding', address: u16(p, 1) }] };
    }
    if (fn === 23) {
      const wStart = u16(p, 5); const wQty = u16(p, 7); const n = p[9];
      if (wQty < 1 || wQty > 121 || n !== wQty * 2 || p.length !== 10 + n) return { kind: 'malformed', because: 'read/write multiple length' };
      return { kind: 'write', ...mapRegisterBlock(map, frame.unitId, 'holding', wStart, Array.from({ length: wQty }, (_, i) => u16(p, 10 + i * 2))) };
    }
    return { kind: 'unknown-function', fn };
  } catch (e) { return { kind: 'malformed', because: (e as Error).message }; }
}

/** Observations from a read request and its response (the gateway pairs them by transaction id). */
export function observationsFromModbusRead(request: ModbusFrame, response: ModbusFrame, map: readonly ModbusRegister[], at: number, source = 'modbus'): Array<{ at: number; point: string; value: PointValue; source: string }> {
  if (response.exception !== undefined || request.fn !== response.fn || request.fn < 1 || request.fn > 4) return [];
  const start = u16(request.pdu, 1); const qty = u16(request.pdu, 3); const data = response.pdu.slice(2);
  const table: ModbusTable = ({ 1: 'coil', 2: 'discrete', 3: 'holding', 4: 'input' } as const)[request.fn as 1 | 2 | 3 | 4];
  const out: Array<{ at: number; point: string; value: PointValue; source: string }> = [];
  if (request.fn <= 2) {
    for (const r of regs(map, request.unitId, table)) { const i = r.address - start; if (i >= 0 && i < qty) out.push({ at, point: r.point, value: !!(data[i >> 3] & (1 << (i & 7))), source }); }
  } else {
    const words = Array.from({ length: qty }, (_, i) => u16(data, i * 2));
    for (const r of regs(map, request.unitId, table)) { const i = r.address - start; const w = width(r); if (i >= 0 && i + w <= qty) out.push({ at, point: r.point, value: decodeRegisters(r, words.slice(i, i + w)), source }); }
  }
  return out;
}

/** Exception response for a request (default code 0x03 Illegal Data Value; 0x01 for a refused function). */
export function modbusException(request: ModbusFrame, code = 0x03): Uint8Array {
  const b = new Uint8Array(9);
  b[0] = request.transactionId >> 8; b[1] = request.transactionId & 0xff; b[2] = request.protocolId >> 8; b[3] = request.protocolId & 0xff;
  b[4] = 0; b[5] = 3; b[6] = request.unitId; b[7] = (request.fn | 0x80) & 0xff; b[8] = code;
  return b;
}

/** Build a request frame (tools and tests). */
export function encodeModbusRequest(r: { transactionId?: number; unitId: number; fn: number; address: number; quantity?: number; values?: number[]; coils?: boolean[] }): Uint8Array {
  const pdu: number[] = [r.fn, r.address >> 8, r.address & 0xff];
  if (r.fn >= 1 && r.fn <= 4) pdu.push((r.quantity ?? 1) >> 8, (r.quantity ?? 1) & 0xff);
  else if (r.fn === 5) pdu.push(r.coils?.[0] ? 0xff : 0, 0);
  else if (r.fn === 6) pdu.push((r.values![0] >> 8) & 0xff, r.values![0] & 0xff);
  else if (r.fn === 16) { const v = r.values!; pdu.push(v.length >> 8, v.length & 0xff, v.length * 2, ...v.flatMap((x) => [(x >> 8) & 0xff, x & 0xff])); }
  else if (r.fn === 15) { const c = r.coils!; const bytes = new Array(Math.ceil(c.length / 8)).fill(0); c.forEach((on, i) => { if (on) bytes[i >> 3] |= 1 << (i & 7); }); pdu.push(c.length >> 8, c.length & 0xff, bytes.length, ...bytes); }
  else throw new Error(`encodeModbusRequest: function ${r.fn} not supported`);
  const t = r.transactionId ?? 1; const len = pdu.length + 1;
  return new Uint8Array([t >> 8, t & 0xff, 0, 0, len >> 8, len & 0xff, r.unitId, ...pdu]);
}

/** Build a read response (tests and simulators). */
export function encodeModbusReadResponse(request: ModbusFrame, words: number[] | boolean[]): Uint8Array {
  let data: number[];
  if (request.fn <= 2) { const bits = words as boolean[]; data = new Array(Math.ceil(bits.length / 8)).fill(0); bits.forEach((on, i) => { if (on) data[i >> 3] |= 1 << (i & 7); }); }
  else data = (words as number[]).flatMap((x) => [(x >> 8) & 0xff, x & 0xff]);
  const len = data.length + 3;
  return new Uint8Array([request.transactionId >> 8, request.transactionId & 0xff, 0, 0, len >> 8, len & 0xff, request.unitId, request.fn, data.length, ...data]);
}

/** Echo response for a write the controller accepted (fn 5/6/15/16 echo address and value/quantity). */
export function encodeModbusWriteEcho(request: ModbusFrame): Uint8Array {
  const p = request.pdu.slice(0, 5); const len = p.length + 1;
  return new Uint8Array([request.transactionId >> 8, request.transactionId & 0xff, 0, 0, len >> 8, len & 0xff, request.unitId, ...p]);
}
