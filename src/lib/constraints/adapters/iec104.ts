/**
 * COPE node crystallized.
 * Node ID: v15-40-00-constraint-adapter-iec104
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * IEC 60870-5-104 for constraint checks: substations, grid control and
 * telecontrol, mostly in Europe. Commands are single/double/regulating-step
 * commands and setpoints (normalised, scaled, short float), with or without
 * a CP56Time2a time tag; values come back as single/double points and
 * measured values with quality descriptors.
 *
 * Decoded strictly: APCI (start 0x68, length 4..253, I/S/U formats) and ASDUs
 * with a two-octet cause of transmission, two-octet common address and
 * three-octet object addresses, sequence (SQ=1) and single-object forms.
 * Reset process, file transfer, parameter loading and unknown type ids are
 * `privileged`. Select-before-operate (S/E=1) is checked like the execute it
 * prepares.
 *
 * Refusing inline in 104 means removing an I-frame from one direction and
 * answering it from the other, which shifts both sides' send/receive sequence
 * numbers. createIec104Session() keeps those offsets so client and server
 * each keep seeing a consistent sequence, and builds the negative activation
 * confirmation (COT 7 with P/N set) the client expects.
 */

import type { PointValue } from '../authority.ts';
import type { Observation, Quality } from '../reconcile.ts';
import { u16le, u24le, type WriteDecode } from './common.ts';

export type Iec104Format = 'I' | 'S' | 'U';
export interface Iec104Apdu { format: Iec104Format; ssn?: number; rsn?: number; u?: number; asdu?: Uint8Array; raw: Uint8Array }

export class Iec104Framer {
  private buf = new Uint8Array(0);
  push(chunk: Uint8Array): Uint8Array[] {
    const b = new Uint8Array(this.buf.length + chunk.length); b.set(this.buf); b.set(chunk, this.buf.length); this.buf = b;
    const out: Uint8Array[] = [];
    while (this.buf.length >= 2) {
      if (this.buf[0] !== 0x68) throw new Error('IEC 104: lost frame sync');
      const len = this.buf[1]; if (len < 4 || len > 253) throw new Error(`IEC 104: APDU length ${len} out of range`);
      if (this.buf.length < 2 + len) break;
      out.push(this.buf.slice(0, 2 + len)); this.buf = this.buf.slice(2 + len);
    }
    return out;
  }
}

export function parseIec104(bytes: Uint8Array): Iec104Apdu | null {
  if (bytes.length < 6 || bytes[0] !== 0x68 || bytes[1] !== bytes.length - 2) return null;
  const c1 = bytes[2]; const c3 = bytes[4];
  if (!(c1 & 1)) { if (c3 & 1) return null; return { format: 'I', ssn: u16le(bytes, 2) >> 1, rsn: u16le(bytes, 4) >> 1, asdu: bytes.slice(6), raw: bytes }; }
  if ((c1 & 3) === 1) { if (bytes.length !== 6) return null; return { format: 'S', rsn: u16le(bytes, 4) >> 1, raw: bytes }; }
  if (bytes.length !== 6) return null;
  return { format: 'U', u: c1, raw: bytes };
}

export function encodeIec104I(asdu: Uint8Array | number[], ssn: number, rsn: number): Uint8Array {
  const a = Array.from(asdu); if (a.length > 249) throw new Error('IEC 104: ASDU too long');
  const s = (ssn & 0x7fff) << 1; const r = (rsn & 0x7fff) << 1;
  return new Uint8Array([0x68, a.length + 4, s & 0xff, s >> 8, r & 0xff, r >> 8, ...a]);
}

export interface Iec104Asdu { typeId: number; sq: boolean; count: number; cot: number; negative: boolean; test: boolean; originator: number; ca: number; objects: Array<{ ioa: number; value?: PointValue; select?: boolean; quality?: Quality; time?: number }> }

const CMD_SIZE: Record<number, number> = { 45: 1, 46: 1, 47: 1, 48: 3, 49: 3, 50: 5, 51: 4, 58: 8, 59: 8, 60: 8, 61: 10, 62: 10, 63: 12, 64: 11 };
const MON_SIZE: Record<number, number> = { 1: 1, 3: 1, 9: 3, 11: 3, 13: 5, 30: 8, 31: 8, 34: 10, 35: 10, 36: 12 };
const PRIVILEGED_TYPES: Record<number, string> = { 105: 'C_RP_NA_1 reset process', 106: 'C_CD_NA_1 delay acquisition', 107: 'C_TS_TA_1 test', 110: 'P_ME_NA_1 parameter', 111: 'P_ME_NB_1 parameter', 112: 'P_ME_NC_1 parameter', 113: 'P_AC_NA_1 parameter activation', 120: 'F_FR_NA_1 file', 121: 'F_SR_NA_1 file', 122: 'F_SC_NA_1 file', 123: 'F_LS_NA_1 file', 124: 'F_AF_NA_1 file', 125: 'F_SG_NA_1 file', 126: 'F_DR_TA_1 directory', 103: 'C_CS_NA_1 clock synchronisation' };
const READ_TYPES = new Set([100, 101, 102, 104]);

export function cp56ToMs(b: Uint8Array, p: number): number | undefined {
  const ms = u16le(b, p); const mi = b[p + 2]; if (mi & 0x80) return undefined; // IV: invalid time
  const h = b[p + 3] & 0x1f; const d = b[p + 4] & 0x1f; const mo = b[p + 5] & 0x0f; const y = 2000 + (b[p + 6] & 0x7f);
  const t = Date.UTC(y, mo - 1, d, h, mi & 0x3f, 0, ms);
  return Number.isFinite(t) && mo >= 1 && d >= 1 ? t : undefined;
}
export function msToCp56(t: number): number[] {
  const d = new Date(t); const ms = d.getUTCSeconds() * 1000 + d.getUTCMilliseconds();
  return [ms & 0xff, ms >> 8, d.getUTCMinutes(), d.getUTCHours(), d.getUTCDate() | (((d.getUTCDay() || 7) & 7) << 5), d.getUTCMonth() + 1, d.getUTCFullYear() - 2000];
}

const qds = (q: number): Quality => (q & 0x80 ? 'bad' : q & 0x71 ? 'uncertain' : 'good'); // IV bad; NT/SB/BL/OV uncertain

function element(type: number, b: Uint8Array, p: number): { value?: PointValue; select?: boolean; quality?: Quality; time?: number } {
  const dv = new DataView(b.buffer, b.byteOffset + p);
  switch (type) {
    case 45: case 58: return { value: !!(b[p] & 1), select: !!(b[p] & 0x80), time: type === 58 ? cp56ToMs(b, p + 1) : undefined };
    case 46: case 59: { const s = b[p] & 3; return { value: s === 2 ? true : s === 1 ? false : undefined, select: !!(b[p] & 0x80), time: type === 59 ? cp56ToMs(b, p + 1) : undefined }; }
    case 47: case 60: { const s = b[p] & 3; return { value: s === 2 ? 'step-up' : s === 1 ? 'step-down' : undefined, select: !!(b[p] & 0x80), time: type === 60 ? cp56ToMs(b, p + 1) : undefined }; }
    case 48: case 61: return { value: dv.getInt16(0, true) / 32768, select: !!(b[p + 2] & 0x80), time: type === 61 ? cp56ToMs(b, p + 3) : undefined };
    case 49: case 62: return { value: dv.getInt16(0, true), select: !!(b[p + 2] & 0x80), time: type === 62 ? cp56ToMs(b, p + 3) : undefined };
    case 50: case 63: return { value: dv.getFloat32(0, true), select: !!(b[p + 4] & 0x80), time: type === 63 ? cp56ToMs(b, p + 5) : undefined };
    case 51: case 64: return { value: dv.getUint32(0, true), time: type === 64 ? cp56ToMs(b, p + 4) : undefined };
    case 1: case 30: return { value: !!(b[p] & 1), quality: qds(b[p] & 0xf0), time: type === 30 ? cp56ToMs(b, p + 1) : undefined };
    case 3: case 31: { const s = b[p] & 3; return { value: s === 2 ? true : s === 1 ? false : undefined, quality: s === 0 || s === 3 ? 'bad' : qds(b[p] & 0xf0), time: type === 31 ? cp56ToMs(b, p + 1) : undefined }; }
    case 9: case 34: return { value: dv.getInt16(0, true) / 32768, quality: qds(b[p + 2]), time: type === 34 ? cp56ToMs(b, p + 3) : undefined };
    case 11: case 35: return { value: dv.getInt16(0, true), quality: qds(b[p + 2]), time: type === 35 ? cp56ToMs(b, p + 3) : undefined };
    case 13: case 36: return { value: dv.getFloat32(0, true), quality: qds(b[p + 4]), time: type === 36 ? cp56ToMs(b, p + 5) : undefined };
  }
  return {};
}

export function parseAsdu(a: Uint8Array): Iec104Asdu | { error: string } {
  if (a.length < 6) return { error: 'ASDU too short' };
  const typeId = a[0]; const sq = !!(a[1] & 0x80); const count = a[1] & 0x7f; const cot = a[2] & 0x3f; const negative = !!(a[2] & 0x40); const test = !!(a[2] & 0x80);
  const base = { typeId, sq, count, cot, negative, test, originator: a[3], ca: u16le(a, 4), objects: [] as Iec104Asdu['objects'] };
  const size = CMD_SIZE[typeId] ?? MON_SIZE[typeId];
  if (size === undefined) return base; // header only (reads, privileged, unsupported)
  if (count === 0) return { error: 'no information objects' };
  const need = sq ? 6 + 3 + count * size : 6 + count * (3 + size);
  if (a.length !== need) return { error: `ASDU length ${a.length}, expected ${need}` };
  let p = 6; let ioa = 0;
  for (let i = 0; i < count; i++) {
    if (!sq || i === 0) { ioa = u24le(a, p); p += 3; } else ioa++;
    base.objects.push({ ioa, ...element(typeId, a, p) }); p += size;
  }
  return base;
}

export interface Iec104PointMap { ca: number; ioa: number; point: string; scale?: number; offset?: number }

/** What a client's I-frame intends to write. */
export function decodeIec104Request(apdu: Iec104Apdu, map: readonly Iec104PointMap[]): WriteDecode {
  if (apdu.format !== 'I') return { kind: 'read' };
  const a = parseAsdu(apdu.asdu!); if ('error' in a) return { kind: 'malformed', because: a.error };
  if (READ_TYPES.has(a.typeId)) return { kind: 'read' };
  if (PRIVILEGED_TYPES[a.typeId]) return { kind: 'privileged', what: PRIVILEGED_TYPES[a.typeId] };
  if (!CMD_SIZE[a.typeId]) return MON_SIZE[a.typeId] ? { kind: 'read' } : { kind: 'privileged', what: `type id ${a.typeId}` };
  if (a.cot === 8) return { kind: 'read' }; // deactivation: stopping a command is always allowed
  if (a.cot !== 6) return { kind: 'malformed', because: `command with cause ${a.cot} (only activation 6 or deactivation 8)` };
  const writes: Array<{ point: string; value: PointValue }> = []; const unmapped: string[] = [];
  for (const o of a.objects) {
    if (o.value === undefined) return { kind: 'malformed', because: 'command state not permitted (0 or 3)' };
    const m = map.find((x) => x.ca === a.ca && x.ioa === o.ioa);
    if (!m) { unmapped.push(`${a.ca}:${o.ioa}`); continue; }
    writes.push({ point: m.point, value: typeof o.value === 'number' ? o.value * (m.scale ?? 1) + (m.offset ?? 0) : o.value });
  }
  return { kind: 'write', writes, unmapped };
}

export function observationsFromIec104(apdu: Iec104Apdu, map: readonly Iec104PointMap[], receivedAt: number, source = 'iec104'): Observation[] {
  if (apdu.format !== 'I') return [];
  const a = parseAsdu(apdu.asdu!); if ('error' in a || !MON_SIZE[a.typeId]) return [];
  const out: Observation[] = [];
  for (const o of a.objects) {
    const m = map.find((x) => x.ca === a.ca && x.ioa === o.ioa); if (!m || o.value === undefined) continue;
    out.push({ at: o.time ?? receivedAt, point: m.point, value: typeof o.value === 'number' ? o.value * (m.scale ?? 1) + (m.offset ?? 0) : o.value, quality: o.quality ?? 'good', source });
  }
  return out;
}

/** Negative activation confirmation for a command ASDU (same type, objects and addresses; COT 7, P/N=1). */
export function negativeConfirmAsdu(asdu: Uint8Array): Uint8Array { const a = asdu.slice(); a[2] = (a[2] & 0x80) | 0x40 | 7; return a; }

/**
 * Sequence bookkeeping for a 104 gateway that drops client I-frames and
 * answers them itself. dropped = I-frames the server never saw;
 * injected = I-frames the client got that the server never sent.
 */
export function createIec104Session() {
  let dropped = 0; let injected = 0;
  let serverNextSsn = 0; // the server's next N(S) as the client sees it (before our injected frames)
  let clientNextSsn = 0; // the client's next N(S)
  const m = (n: number) => ((n % 32768) + 32768) % 32768;
  const rewrite = (raw: Uint8Array, ssn: number | undefined, rsn: number) => {
    const b = raw.slice();
    if (ssn !== undefined) { const s = m(ssn) << 1; b[2] = s & 0xff; b[3] = s >> 8; }
    const r = m(rsn) << 1; b[4] = r & 0xff; b[5] = r >> 8; return b;
  };
  return {
    /** A frame from the client to forward to the server: renumbered. */
    toServer(apdu: Iec104Apdu): Uint8Array {
      if (apdu.format === 'I') { clientNextSsn = m(apdu.ssn! + 1); return rewrite(apdu.raw, apdu.ssn! - dropped, apdu.rsn! - injected); }
      if (apdu.format === 'S') return rewrite(apdu.raw, undefined, apdu.rsn! - injected);
      return apdu.raw;
    },
    /** A frame from the server to forward to the client: renumbered. */
    toClient(apdu: Iec104Apdu): Uint8Array {
      if (apdu.format === 'I') { const out = rewrite(apdu.raw, apdu.ssn! + injected, apdu.rsn! + dropped); serverNextSsn = m(apdu.ssn! + 1); return out; }
      if (apdu.format === 'S') return rewrite(apdu.raw, undefined, apdu.rsn! + dropped);
      return apdu.raw;
    },
    /** Drop a client I-frame and return the negative confirmation to send to the client instead. */
    refuse(apdu: Iec104Apdu): Uint8Array {
      clientNextSsn = m(apdu.ssn! + 1);
      const reply = encodeIec104I(negativeConfirmAsdu(apdu.asdu!), serverNextSsn + injected, clientNextSsn);
      dropped++; injected++;
      return reply;
    },
    state: () => ({ dropped, injected }),
  };
}

// ── Encoders (tests, tools, simulators) ──
export function encodeCommandAsdu(r: { typeId: number; ca: number; ioa: number; value: number | boolean; select?: boolean; cot?: number; time?: number }): Uint8Array {
  const se = r.select ? 0x80 : 0; const el: number[] = [];
  const t = r.typeId;
  if (t === 45 || t === 58) el.push((r.value ? 1 : 0) | se);
  else if (t === 46 || t === 59) el.push((r.value ? 2 : 1) | se);
  else if (t === 48 || t === 61) { const v = Math.max(-32768, Math.min(32767, Math.round((r.value as number) * 32768))); el.push(v & 0xff, (v >> 8) & 0xff, se); }
  else if (t === 49 || t === 62) { const v = (r.value as number) | 0; el.push(v & 0xff, (v >> 8) & 0xff, se); }
  else if (t === 50 || t === 63) { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, r.value as number, true); el.push(...new Uint8Array(d.buffer), se); }
  else throw new Error(`encodeCommandAsdu: type ${t} not supported`);
  if (t >= 58) el.push(...msToCp56(r.time ?? Date.now()));
  return new Uint8Array([t, 1, r.cot ?? 6, 0, r.ca & 0xff, r.ca >> 8, r.ioa & 0xff, (r.ioa >> 8) & 0xff, r.ioa >> 16, ...el]);
}

export function encodeMeasuredAsdu(r: { typeId: 13 | 36 | 11 | 1; ca: number; ioa: number; values: Array<number | boolean>; qds?: number; time?: number; sq?: boolean }): Uint8Array {
  const out: number[] = [r.typeId, (r.sq ? 0x80 : 0) | r.values.length, 3, 0, r.ca & 0xff, r.ca >> 8];
  r.values.forEach((v, i) => {
    if (!r.sq || i === 0) { const ioa = r.ioa + (r.sq ? 0 : i); out.push(ioa & 0xff, (ioa >> 8) & 0xff, ioa >> 16); }
    if (r.typeId === 1) out.push((v ? 1 : 0) | (r.qds ?? 0));
    else if (r.typeId === 11) { const n = (v as number) | 0; out.push(n & 0xff, (n >> 8) & 0xff, r.qds ?? 0); }
    else { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, v as number, true); out.push(...new Uint8Array(d.buffer), r.qds ?? 0); if (r.typeId === 36) out.push(...msToCp56(r.time ?? 0)); }
  });
  return new Uint8Array(out);
}
