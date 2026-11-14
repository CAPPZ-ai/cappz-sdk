/**
 * COPE node crystallized.
 * Node ID: v15-40-00-constraint-adapter-dnp3
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * DNP3 (IEEE 1815) over TCP for constraint checks: water, wastewater and
 * electric utilities. Commands are SELECT / OPERATE / DIRECT_OPERATE(_NR) of
 * control relay output blocks (group 12) and analog outputs (group 41);
 * values come back in responses as binary inputs (group 1), analog inputs
 * (group 30) and analog output status (group 40).
 *
 * Decoded strictly: the link frame with its CRC on the header and every
 * 16-byte block (DNP3 CRC-16, polynomial 0x3D65), one transport segment (FIR
 * and FIN both set — a multi-segment request cannot be checked whole and is
 * refused), the application header and the object headers with qualifiers
 * 0x00/0x01 (start–stop), 0x07/0x08 (count) and 0x17/0x28 (indexed). WRITE,
 * restarts, file operations, freezes, enabling/disabling unsolicited and
 * assigning classes are `privileged`. Without DNP3 Secure Authentication,
 * nothing on the wire says who sent a command; a gateway is where it can be
 * checked. A refused command is answered with the same objects and status
 * NOT_AUTHORIZED (9), so the master sees a clear refusal.
 */

import type { Observation } from '../reconcile.ts';
import type { WriteDecode } from './common.ts';

// ── CRC ──
const CRC_TABLE = (() => { const t = new Uint16Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xa6bc : c >>> 1; t[i] = c; } return t; })();
export function dnp3Crc(b: Uint8Array | number[], start = 0, end = b.length): number { let c = 0; for (let i = start; i < end; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ b[i]) & 0xff]; return ~c & 0xffff; }

export interface Dnp3LinkFrame { control: number; destination: number; source: number; userData: Uint8Array }

/** Split a TCP stream into whole link frames. */
export class Dnp3Framer {
  private buf = new Uint8Array(0);
  push(chunk: Uint8Array): Uint8Array[] {
    const b = new Uint8Array(this.buf.length + chunk.length); b.set(this.buf); b.set(chunk, this.buf.length); this.buf = b;
    const out: Uint8Array[] = [];
    while (this.buf.length >= 10) {
      if (this.buf[0] !== 0x05 || this.buf[1] !== 0x64) throw new Error('DNP3: lost frame sync');
      const len = this.buf[2]; if (len < 5) throw new Error('DNP3: link length below 5');
      const data = len - 5; const total = 10 + data + 2 * Math.ceil(data / 16);
      if (this.buf.length < total) break;
      out.push(this.buf.slice(0, total)); this.buf = this.buf.slice(total);
    }
    return out;
  }
}

export function parseDnp3Link(bytes: Uint8Array): Dnp3LinkFrame | { error: string } {
  if (bytes.length < 10 || bytes[0] !== 0x05 || bytes[1] !== 0x64) return { error: 'not a DNP3 link frame' };
  if (dnp3Crc(bytes, 0, 8) !== (bytes[8] | (bytes[9] << 8))) return { error: 'header CRC' };
  const len = bytes[2]; const n = len - 5; if (n < 0) return { error: 'link length' };
  const expected = 10 + n + 2 * Math.ceil(n / 16); if (bytes.length !== expected) return { error: 'frame length' };
  const user = new Uint8Array(n); let p = 10; let w = 0;
  while (w < n) {
    const blk = Math.min(16, n - w);
    if (dnp3Crc(bytes, p, p + blk) !== (bytes[p + blk] | (bytes[p + blk + 1] << 8))) return { error: `data CRC (block ${w / 16})` };
    user.set(bytes.subarray(p, p + blk), w); p += blk + 2; w += blk;
  }
  return { control: bytes[3], destination: bytes[4] | (bytes[5] << 8), source: bytes[6] | (bytes[7] << 8), userData: user };
}

export function encodeDnp3Link(f: { control: number; destination: number; source: number; userData: Uint8Array | number[] }): Uint8Array {
  const u = Array.from(f.userData); if (u.length > 250) throw new Error('DNP3: user data too long for one frame');
  const head = [0x05, 0x64, u.length + 5, f.control, f.destination & 0xff, f.destination >> 8, f.source & 0xff, f.source >> 8];
  const c = dnp3Crc(head); const out = [...head, c & 0xff, c >> 8];
  for (let i = 0; i < u.length; i += 16) { const blk = u.slice(i, i + 16); const bc = dnp3Crc(blk); out.push(...blk, bc & 0xff, bc >> 8); }
  return new Uint8Array(out);
}

// ── Application layer ──
export const DNP3_FC = { CONFIRM: 0, READ: 1, WRITE: 2, SELECT: 3, OPERATE: 4, DIRECT_OPERATE: 5, DIRECT_OPERATE_NR: 6, RESPONSE: 129, UNSOLICITED: 130 } as const;
const PRIVILEGED_FC: Record<number, string> = { 2: 'WRITE', 7: 'IMMED_FREEZE', 8: 'IMMED_FREEZE_NR', 9: 'FREEZE_CLEAR', 10: 'FREEZE_CLEAR_NR', 11: 'FREEZE_AT_TIME', 12: 'FREEZE_AT_TIME_NR', 13: 'COLD_RESTART', 14: 'WARM_RESTART', 15: 'INITIALIZE_DATA', 16: 'INITIALIZE_APPL', 17: 'START_APPL', 18: 'STOP_APPL', 19: 'SAVE_CONFIG', 20: 'ENABLE_UNSOLICITED', 21: 'DISABLE_UNSOLICITED', 22: 'ASSIGN_CLASS', 25: 'OPEN_FILE', 26: 'CLOSE_FILE', 27: 'DELETE_FILE', 29: 'ABORT_FILE', 31: 'ACTIVATE_CONFIG', 33: 'AUTHENTICATE_REQ_NR' };
const READ_FC = new Set([0, 1, 23, 24, 28, 30, 32, 129, 130, 131, 132, 133]);

export type Dnp3Table = 'binary-output' | 'analog-output' | 'binary-input' | 'analog-input' | 'analog-output-status' | 'binary-output-status';
export interface Dnp3PointMap { outstation: number; table: Dnp3Table; index: number; point: string; scale?: number; offset?: number }

export interface Dnp3Object { group: number; variation: number; qualifier: number; index: number; value?: number | boolean; status?: number; flags?: number; controlCode?: number; raw: Uint8Array }
export interface Dnp3Apdu { transport: number; appControl: number; seq: number; fc: number; iin?: number; objects: Dnp3Object[] }

/** Size of one object (without prefix) for the groups this module reads; undefined: not supported. */
function objSize(g: number, v: number): number | undefined {
  if (g === 12 && v === 1) return 11;
  if (g === 41) return ({ 1: 5, 2: 3, 3: 5, 4: 9 } as Record<number, number>)[v];
  if (g === 30) return ({ 1: 5, 2: 3, 3: 4, 4: 2, 5: 5, 6: 9 } as Record<number, number>)[v];
  if (g === 40) return ({ 1: 5, 2: 3, 3: 5, 4: 9 } as Record<number, number>)[v];
  if (g === 1 && v === 2) return 1;
  if (g === 10 && v === 2) return 1;
  return undefined;
}

function decodeValue(g: number, v: number, b: Uint8Array, p: number): Pick<Dnp3Object, 'value' | 'status' | 'flags' | 'controlCode'> {
  const dv = new DataView(b.buffer, b.byteOffset + p);
  if (g === 12) {
    // control code: bits 0–3 operation (1 PULSE_ON, 2 PULSE_OFF, 3 LATCH_ON, 4 LATCH_OFF), bit 4 queue, bit 5 clear, bits 6–7 trip/close (1 CLOSE, 2 TRIP)
    const c = b[p]; const op = c & 0x0f; const tcc = (c >> 6) & 3; let value: boolean | undefined;
    if (!(c & 0x30)) {
      if (tcc === 0) value = op === 1 || op === 3 ? true : op === 2 || op === 4 ? false : undefined;
      else if (op === 1 && tcc === 1) value = true;
      else if (op === 1 && tcc === 2) value = false;
    }
    return { controlCode: c, status: b[p + 10], value };
  }
  if (g === 41) { const val = v === 1 ? dv.getInt32(0, true) : v === 2 ? dv.getInt16(0, true) : v === 3 ? dv.getFloat32(0, true) : dv.getFloat64(0, true); return { value: val, status: b[p + (v === 2 ? 2 : v === 4 ? 8 : 4)] }; }
  if (g === 30 || g === 40) {
    const flagged = g === 40 || v === 1 || v === 2 || v === 5 || v === 6; const o = flagged ? 1 : 0;
    const d2 = new DataView(b.buffer, b.byteOffset + p + o);
    const val = v === 1 || v === 3 ? d2.getInt32(0, true) : v === 2 || v === 4 ? d2.getInt16(0, true) : v === 5 ? d2.getFloat32(0, true) : d2.getFloat64(0, true);
    return { value: g === 40 ? (v === 1 ? dv.getInt32(1, true) : v === 2 ? dv.getInt16(1, true) : v === 3 ? dv.getFloat32(1, true) : dv.getFloat64(1, true)) : val, flags: flagged ? b[p] : undefined };
  }
  if (g === 1 || g === 10) return { value: !!(b[p] & 0x80), flags: b[p] };
  return {};
}

export function parseDnp3Apdu(user: Uint8Array, request: boolean): Dnp3Apdu | { error: string } {
  if (user.length < 3) return { error: 'too short' };
  const transport = user[0];
  if (!(transport & 0x80) || !(transport & 0x40)) return { error: 'multi-segment message (FIR and FIN must both be set)' };
  const appControl = user[1]; const fc = user[2]; let p = 3; let iin: number | undefined;
  if (!request) { if (user.length < 5) return { error: 'response without IIN' }; iin = user[3] | (user[4] << 8); p = 5; }
  if (!(appControl & 0x80) || !(appControl & 0x40)) return { error: 'multi-fragment application message' };
  const objects: Dnp3Object[] = [];
  try {
    while (p < user.length) {
      if (p + 3 > user.length) throw new Error('truncated object header');
      const g = user[p]; const v = user[p + 1]; const q = user[p + 2]; p += 3;
      const prefixCode = (q >> 4) & 7; const range = q & 0x0f;
      let indices: number[] = []; let indexed = false;
      if (range === 0x00 || range === 0x01) { const w = range === 0 ? 1 : 2; if (p + 2 * w > user.length) throw new Error('truncated range'); const s = w === 1 ? user[p] : user[p] | (user[p + 1] << 8); const e = w === 1 ? user[p + 1] : user[p + 2] | (user[p + 3] << 8); p += 2 * w; if (e < s || e - s > 4096) throw new Error('bad range'); indices = Array.from({ length: e - s + 1 }, (_, i) => s + i); }
      else if (range === 0x07 || range === 0x08) { const w = range === 7 ? 1 : 2; if (p + w > user.length) throw new Error('truncated count'); const n = w === 1 ? user[p] : user[p] | (user[p + 1] << 8); p += w; if (prefixCode === 1 || prefixCode === 2) { indexed = true; indices = new Array(n).fill(-1); } else indices = Array.from({ length: n }, (_, i) => i); }
      else if (range === 0x06) { indices = []; } // all objects (a read)
      else throw new Error(`qualifier 0x${q.toString(16)} not supported`);
      if (indices.length > 4096) throw new Error('too many objects');
      const prefixW = prefixCode === 1 ? 1 : prefixCode === 2 ? 2 : 0;
      if ((range === 0x07 || range === 0x08) && prefixCode !== 0 && !prefixW) throw new Error('unsupported prefix');
      const size = objSize(g, v);
      if (request && (fc === 1) ) { objects.push({ group: g, variation: v, qualifier: q, index: -1, raw: new Uint8Array() }); continue; } // read requests carry headers only
      if (size === undefined) { if (indices.length === 0) { objects.push({ group: g, variation: v, qualifier: q, index: -1, raw: new Uint8Array() }); continue; } throw new Error(`object g${g}v${v} not supported`); }
      for (let i = 0; i < indices.length; i++) {
        let idx = indices[i];
        if (indexed || prefixW) { if (p + prefixW > user.length) throw new Error('truncated prefix'); idx = prefixW === 1 ? user[p] : user[p] | (user[p + 1] << 8); p += prefixW; }
        if (p + size > user.length) throw new Error('truncated object');
        objects.push({ group: g, variation: v, qualifier: q, index: idx, raw: user.slice(p, p + size), ...decodeValue(g, v, user, p) });
        p += size;
      }
    }
  } catch (e) { return { error: (e as Error).message }; }
  return { transport, appControl, seq: appControl & 0x0f, fc, iin, objects };
}

/** What a master's request intends to write, in envelope points (SELECT is checked like the OPERATE it prepares). */
export function decodeDnp3Request(frame: Dnp3LinkFrame, map: readonly Dnp3PointMap[]): WriteDecode {
  const a = parseDnp3Apdu(frame.userData, true);
  if ('error' in a) return { kind: 'malformed', because: a.error };
  if (READ_FC.has(a.fc)) return { kind: 'read' };
  if (PRIVILEGED_FC[a.fc]) return { kind: 'privileged', what: PRIVILEGED_FC[a.fc] };
  if (a.fc < 3 || a.fc > 6) return { kind: 'privileged', what: `function code ${a.fc}` };
  const writes: Array<{ point: string; value: number | boolean }> = []; const unmapped: string[] = [];
  for (const o of a.objects) {
    const table: Dnp3Table | undefined = o.group === 12 ? 'binary-output' : o.group === 41 ? 'analog-output' : undefined;
    if (!table) return { kind: 'malformed', because: `g${o.group}v${o.variation} is not a command object` };
    if (o.value === undefined) return { kind: 'malformed', because: `control code 0x${(o.controlCode ?? 0).toString(16)} is not a plain on/off (pulse/trip/close/latch only)` };
    const m = map.find((x) => x.outstation === frame.destination && x.table === table && x.index === o.index);
    if (!m) { unmapped.push(`${table}[${o.index}]@${frame.destination}`); continue; }
    writes.push({ point: m.point, value: typeof o.value === 'number' ? o.value * (m.scale ?? 1) + (m.offset ?? 0) : o.value });
  }
  return { kind: 'write', writes, unmapped };
}

/** Observations in an outstation's response or unsolicited message. */
export function observationsFromDnp3(frame: Dnp3LinkFrame, map: readonly Dnp3PointMap[], at: number, source = 'dnp3'): Observation[] {
  const a = parseDnp3Apdu(frame.userData, false); if ('error' in a || (a.fc !== 129 && a.fc !== 130)) return [];
  const out: Observation[] = [];
  for (const o of a.objects) {
    const table: Dnp3Table | undefined = o.group === 30 ? 'analog-input' : o.group === 1 ? 'binary-input' : o.group === 40 ? 'analog-output-status' : o.group === 10 ? 'binary-output-status' : undefined;
    if (!table || o.value === undefined) continue;
    const m = map.find((x) => x.outstation === frame.source && x.table === table && x.index === o.index); if (!m) continue;
    // flags bit0 ONLINE; bit1 RESTART, bit2 COMM_LOST, bit3 REMOTE_FORCED, bit4 LOCAL_FORCED, bit5 OVER_RANGE / CHATTER
    const quality = o.flags === undefined ? 'good' : !(o.flags & 0x01) || o.flags & 0x04 ? 'bad' : o.flags & 0x3a ? 'uncertain' : 'good';
    out.push({ at, point: m.point, value: typeof o.value === 'number' ? o.value * (m.scale ?? 1) + (m.offset ?? 0) : o.value, quality, source });
  }
  return out;
}

/** Response to a refused command: the same objects with status NOT_AUTHORIZED (9), from the outstation's address. */
export function dnp3RefusalResponse(frame: Dnp3LinkFrame, status = 9): Uint8Array | null {
  const a = parseDnp3Apdu(frame.userData, true); if ('error' in a || a.fc === DNP3_FC.DIRECT_OPERATE_NR) return null;
  const objs: number[] = [];
  for (const o of a.objects) {
    const raw = Array.from(o.raw); const statusAt = o.group === 12 ? 10 : o.variation === 2 ? 2 : o.variation === 4 ? 8 : 4; raw[statusAt] = status;
    objs.push(o.group, o.variation, 0x28, 1, 0, o.index & 0xff, o.index >> 8, ...raw);
  }
  const user = [0xc0 | 0, 0xc0 | a.seq, DNP3_FC.RESPONSE, 0x00, 0x00, ...objs];
  return encodeDnp3Link({ control: 0x44, destination: frame.source, source: frame.destination, userData: user });
}

// ── Encoders (tests, tools, simulators) ──
export function encodeDnp3Command(r: { fc: number; seq?: number; master: number; outstation: number; objects: Array<{ group: 12; index: number; on: boolean } | { group: 41; variation: 1 | 2 | 3 | 4; index: number; value: number }> }): Uint8Array {
  const body: number[] = [0xc0, 0xc0 | (r.seq ?? 0), r.fc];
  for (const o of r.objects) {
    if (o.group === 12) body.push(12, 1, 0x28, 1, 0, o.index & 0xff, o.index >> 8, o.on ? 0x03 : 0x04, 1, 100, 0, 0, 0, 0, 0, 0, 0, 0);
    else {
      const size = objSize(41, o.variation)!; const b = new Uint8Array(size); const d = new DataView(b.buffer);
      if (o.variation === 1) d.setInt32(0, o.value, true); else if (o.variation === 2) d.setInt16(0, o.value, true); else if (o.variation === 3) d.setFloat32(0, o.value, true); else d.setFloat64(0, o.value, true);
      body.push(41, o.variation, 0x28, 1, 0, o.index & 0xff, o.index >> 8, ...b);
    }
  }
  return encodeDnp3Link({ control: 0xc4, destination: r.outstation, source: r.master, userData: body });
}

export function encodeDnp3AnalogResponse(r: { outstation: number; master: number; seq?: number; start: number; values: number[]; variation?: 1 | 5; flags?: number }): Uint8Array {
  const v = r.variation ?? 5; const body: number[] = [0xc0, 0xc0 | (r.seq ?? 0), 129, 0, 0, 30, v, 0x01, r.start & 0xff, r.start >> 8, (r.start + r.values.length - 1) & 0xff, (r.start + r.values.length - 1) >> 8];
  for (const x of r.values) { const b = new Uint8Array(5); const d = new DataView(b.buffer); b[0] = r.flags ?? 0x01; if (v === 5) d.setFloat32(1, x, true); else d.setInt32(1, x, true); body.push(...b); }
  return encodeDnp3Link({ control: 0x44, destination: r.master, source: r.outstation, userData: body });
}
