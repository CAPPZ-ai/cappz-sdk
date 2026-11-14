/**
 * COPE node crystallized.
 * Node ID: v15-40-00-constraint-adapter-bacnet
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * BACnet/IP (ASHRAE 135, Annex J) for constraint checks: building automation,
 * HVAC and refrigeration controllers. Writes arrive as WriteProperty and
 * WritePropertyMultiple confirmed requests; values come back as
 * ReadProperty-ACKs and COV notifications. BACnet/IP has no authentication on
 * these services (BACnet Secure Connect aside), so a gateway in front of the
 * controller is where a write can be checked.
 *
 * Decoded strictly: BVLC (unicast, broadcast, forwarded), NPDU with routing
 * fields, unsegmented APDUs, and BACnet tags with extended tag numbers and
 * lengths. Segmented requests cannot be checked whole and are refused.
 * Services that change a device without being a point write (CreateObject,
 * DeleteObject, AtomicWriteFile, ReinitializeDevice,
 * DeviceCommunicationControl, private transfers, WriteGroup, list
 * add/remove) are `privileged`. Writing NULL relinquishes a priority slot and
 * is reported as the value 'relinquish'.
 */

import type { PointValue } from '../authority.ts';
import type { Observation } from '../reconcile.ts';
import type { WriteDecode } from './common.ts';

export const BACNET_OBJECT_TYPES = { 'analog-input': 0, 'analog-output': 1, 'analog-value': 2, 'binary-input': 3, 'binary-output': 4, 'binary-value': 5, device: 8, 'multi-state-input': 13, 'multi-state-output': 14, 'multi-state-value': 19 } as const;
export const BACNET_PRESENT_VALUE = 85;

export interface BacnetObjectMap { objectType: number; instance: number; /** default 85 present-value */ property?: number; point: string; /** Device (gateway target) this applies to, when one gateway fronts several. */ target?: string }

interface Tag { number: number; context: boolean; lvt: number; open: boolean; close: boolean; start: number; dataStart: number; end: number }

function readTag(b: Uint8Array, i: number): Tag {
  if (i >= b.length) throw new Error('truncated tag');
  const t = b[i]; let p = i + 1;
  let number = t >> 4; if (number === 0x0f) { if (p >= b.length) throw new Error('truncated tag'); number = b[p++]; }
  const context = !!(t & 0x08); let lvt = t & 0x07;
  if (context && lvt === 6) return { number, context, lvt, open: true, close: false, start: i, dataStart: p, end: p };
  if (context && lvt === 7) return { number, context, lvt, open: false, close: true, start: i, dataStart: p, end: p };
  if (!context && number === 1) return { number, context, lvt, open: false, close: false, start: i, dataStart: p, end: p }; // application boolean: value in LVT
  if (lvt === 5) {
    if (p >= b.length) throw new Error('truncated length');
    lvt = b[p++];
    if (lvt === 254) { if (p + 2 > b.length) throw new Error('truncated length'); lvt = (b[p] << 8) | b[p + 1]; p += 2; }
    else if (lvt === 255) { if (p + 4 > b.length) throw new Error('truncated length'); lvt = ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3]; p += 4; }
  }
  if (p + lvt > b.length) throw new Error('tag length past end');
  return { number, context, lvt, open: false, close: false, start: i, dataStart: p, end: p + lvt };
}

const uint = (b: Uint8Array, t: Tag) => { let v = 0; for (let i = t.dataStart; i < t.end; i++) v = v * 256 + b[i]; return v; };
const sint = (b: Uint8Array, t: Tag) => { const n = t.end - t.dataStart; const u = uint(b, t); return n && b[t.dataStart] & 0x80 ? u - 2 ** (8 * n) : u; };

/** One application-tagged value → a point value (null → 'relinquish'). */
function appValue(b: Uint8Array, t: Tag): PointValue {
  if (t.context) throw new Error('expected an application tag');
  switch (t.number) {
    case 0: return 'relinquish';
    case 1: return t.lvt === 1;
    case 2: return uint(b, t);
    case 3: return sint(b, t);
    case 4: if (t.lvt !== 4) throw new Error('REAL must be 4 bytes'); return new DataView(b.buffer, b.byteOffset + t.dataStart, 4).getFloat32(0);
    case 5: if (t.lvt !== 8) throw new Error('Double must be 8 bytes'); return new DataView(b.buffer, b.byteOffset + t.dataStart, 8).getFloat64(0);
    case 7: { if (b[t.dataStart] !== 0) throw new Error('only UTF-8 character strings'); return new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(t.dataStart + 1, t.end)); }
    case 9: return uint(b, t);
    default: throw new Error(`application tag ${t.number} not supported as a point value`);
  }
}

/** Values between an opening and closing context tag `n` (constructed values are refused unless a single primitive). */
function readValueList(b: Uint8Array, i: number, n: number): { values: PointValue[]; next: number } {
  const open = readTag(b, i); if (!open.open || open.number !== n) throw new Error(`expected opening tag ${n}`);
  let p = open.end; const values: PointValue[] = [];
  for (;;) {
    const t = readTag(b, p);
    if (t.close && t.number === n) return { values, next: t.end };
    if (t.open || t.close || t.context) throw new Error('constructed property values are not checked');
    values.push(appValue(b, t)); p = t.end;
    if (values.length > 64) throw new Error('too many values');
  }
}

export interface BacnetFrame {
  bvlcFunction: number;
  /** NPDU routing, needed to address a reply. */
  snet?: { net: number; adr: Uint8Array }; dnet?: { net: number; adr: Uint8Array };
  networkMessage: boolean;
  pduType: number;
  segmented: boolean;
  invokeId?: number;
  service?: number;
  /** APDU service data (after the service choice). */
  data: Uint8Array;
}

export function parseBacnetIp(bytes: Uint8Array): BacnetFrame | null {
  if (bytes.length < 6 || bytes[0] !== 0x81) return null;
  const fn = bytes[1]; const len = (bytes[2] << 8) | bytes[3];
  if (len !== bytes.length) return null;
  let p = 4;
  if (fn === 0x04) p += 6; // Forwarded-NPDU carries the originating B/IP address
  else if (fn !== 0x0a && fn !== 0x0b) return { bvlcFunction: fn, networkMessage: true, pduType: -1, segmented: false, data: new Uint8Array() };
  if (p + 2 > bytes.length || bytes[p] !== 0x01) return null;
  const ctrl = bytes[p + 1]; p += 2;
  const f: BacnetFrame = { bvlcFunction: fn, networkMessage: !!(ctrl & 0x80), pduType: -1, segmented: false, data: new Uint8Array() };
  try {
    if (ctrl & 0x20) { const net = (bytes[p] << 8) | bytes[p + 1]; const l = bytes[p + 2]; f.dnet = { net, adr: bytes.slice(p + 3, p + 3 + l) }; p += 3 + l; }
    if (ctrl & 0x08) { const net = (bytes[p] << 8) | bytes[p + 1]; const l = bytes[p + 2]; f.snet = { net, adr: bytes.slice(p + 3, p + 3 + l) }; p += 3 + l; }
    if (ctrl & 0x20) p += 1; // hop count
    if (p > bytes.length) return null;
    if (f.networkMessage) return f;
    const a = bytes.subarray(p); if (!a.length) return null;
    f.pduType = a[0] >> 4;
    if (f.pduType === 0) { // confirmed request
      f.segmented = !!(a[0] & 0x08);
      if (a.length < 4) return null;
      f.invokeId = a[2];
      const q = f.segmented ? 5 : 3; if (a.length <= q) return null;
      f.service = a[q]; f.data = a.subarray(q + 1);
    } else if (f.pduType === 1) { if (a.length < 2) return null; f.service = a[1]; f.data = a.subarray(2); }
    else if (f.pduType === 3) { f.segmented = !!(a[0] & 0x08); if (a.length < 3) return null; f.invokeId = a[1]; const q = f.segmented ? 4 : 2; f.service = a[q]; f.data = a.subarray(q + 1); }
    else if (a.length >= 2) { f.invokeId = a[1]; f.service = a[2]; f.data = a.subarray(3); }
    return f;
  } catch { return null; }
}

const PRIVILEGED_CONFIRMED: Record<number, string> = { 6: 'AtomicReadFile', 7: 'AtomicWriteFile', 8: 'AddListElement', 9: 'RemoveListElement', 10: 'CreateObject', 11: 'DeleteObject', 17: 'DeviceCommunicationControl', 18: 'ConfirmedPrivateTransfer', 20: 'ReinitializeDevice', 21: 'VT-Open', 22: 'VT-Close', 23: 'VT-Data' };
const READ_CONFIRMED = new Set([0, 1, 2, 3, 4, 5, 12, 14, 26, 27, 28, 29, 30, 31]); // alarms/events/COV subscribe/reads
const PRIVILEGED_UNCONFIRMED: Record<number, string> = { 4: 'UnconfirmedPrivateTransfer', 5: 'UnconfirmedTextMessage', 6: 'TimeSynchronization', 9: 'UTCTimeSynchronization', 10: 'WriteGroup' };

function objectId(b: Uint8Array, t: Tag) { if (t.lvt !== 4) throw new Error('object identifier must be 4 bytes'); const v = uint(b, t); return { type: Math.floor(v / 2 ** 22), instance: v & 0x3fffff }; }

/** What a request intends to write, in envelope points. */
export function decodeBacnetRequest(f: BacnetFrame, map: readonly BacnetObjectMap[], target?: string): WriteDecode {
  if (f.networkMessage) return f.pduType === -1 && f.bvlcFunction !== 0x0a && f.bvlcFunction !== 0x0b && f.bvlcFunction !== 0x04 ? { kind: 'privileged', what: `BVLC function 0x${f.bvlcFunction.toString(16)}` } : { kind: 'privileged', what: 'network layer message' };
  if (f.pduType === 1) { const p = PRIVILEGED_UNCONFIRMED[f.service!]; return p ? { kind: 'privileged', what: p } : { kind: 'read' }; }
  if (f.pduType !== 0) return { kind: 'read' }; // acks, errors, aborts flowing toward the device
  if (f.segmented) return { kind: 'malformed', because: 'segmented requests cannot be checked whole' };
  const s = f.service!; const b = f.data;
  if (READ_CONFIRMED.has(s)) return { kind: 'read' };
  if (PRIVILEGED_CONFIRMED[s]) return { kind: 'privileged', what: PRIVILEGED_CONFIRMED[s] };
  const find = (type: number, instance: number, property: number) => map.find((m) => m.objectType === type && m.instance === instance && (m.property ?? BACNET_PRESENT_VALUE) === property && (!m.target || m.target === target));
  try {
    if (s === 15) {
      let t = readTag(b, 0); if (!t.context || t.number !== 0) throw new Error('missing object identifier');
      const oid = objectId(b, t);
      t = readTag(b, t.end); if (!t.context || t.number !== 1) throw new Error('missing property identifier');
      const prop = uint(b, t); let p = t.end;
      let arrayIndex: number | undefined;
      const peek = readTag(b, p); if (peek.context && peek.number === 2 && !peek.open) { arrayIndex = uint(b, peek); p = peek.end; }
      const { values, next } = readValueList(b, p, 3);
      if (next < b.length) { const pr = readTag(b, next); if (!pr.context || pr.number !== 4) throw new Error('unexpected data after the value'); const prio = uint(b, pr); if (prio < 1 || prio > 16) throw new Error('priority must be 1..16'); if (pr.end !== b.length) throw new Error('trailing bytes'); }
      if (values.length !== 1) throw new Error('exactly one value expected');
      const m = arrayIndex === undefined ? find(oid.type, oid.instance, prop) : undefined;
      return m ? { kind: 'write', writes: [{ point: m.point, value: values[0] }], unmapped: [] } : { kind: 'write', writes: [], unmapped: [`${oid.type}:${oid.instance}/${prop}${arrayIndex !== undefined ? `[${arrayIndex}]` : ''}`] };
    }
    if (s === 16) {
      const writes: Array<{ point: string; value: PointValue }> = []; const unmapped: string[] = [];
      let p = 0;
      while (p < b.length) {
        const ot = readTag(b, p); if (!ot.context || ot.number !== 0) throw new Error('missing object identifier'); const oid = objectId(b, ot);
        const open = readTag(b, ot.end); if (!open.open || open.number !== 1) throw new Error('missing list of properties'); p = open.end;
        for (;;) {
          const t = readTag(b, p);
          if (t.close && t.number === 1) { p = t.end; break; }
          if (!t.context || t.number !== 0) throw new Error('missing property identifier');
          const prop = uint(b, t); p = t.end;
          let arrayIndex: number | undefined; const pk = readTag(b, p); if (pk.context && pk.number === 1 && !pk.open && !pk.close) { arrayIndex = uint(b, pk); p = pk.end; }
          const { values, next } = readValueList(b, p, 2); p = next;
          const pr = p < b.length ? readTag(b, p) : null; if (pr && pr.context && pr.number === 3 && !pr.open && !pr.close) p = pr.end;
          if (values.length !== 1) throw new Error('exactly one value expected');
          const m = arrayIndex === undefined ? find(oid.type, oid.instance, prop) : undefined;
          if (m) writes.push({ point: m.point, value: values[0] }); else unmapped.push(`${oid.type}:${oid.instance}/${prop}`);
          if (writes.length + unmapped.length > 256) throw new Error('too many properties');
        }
      }
      return { kind: 'write', writes, unmapped };
    }
    return { kind: 'privileged', what: `confirmed service ${s}` };
  } catch (e) { return { kind: 'malformed', because: (e as Error).message }; }
}

/** Observations from a ReadProperty-ACK or a COV notification (confirmed or unconfirmed). */
export function observationsFromBacnet(f: BacnetFrame, map: readonly BacnetObjectMap[], at: number, target?: string, source = 'bacnet'): Observation[] {
  const find = (type: number, instance: number, property: number) => map.find((m) => m.objectType === type && m.instance === instance && (m.property ?? BACNET_PRESENT_VALUE) === property && (!m.target || m.target === target));
  const b = f.data; const out: Observation[] = [];
  try {
    if (f.pduType === 3 && f.service === 12 && !f.segmented) {
      const ot = readTag(b, 0); const oid = objectId(b, ot); const pt = readTag(b, ot.end); const prop = uint(b, pt); let p = pt.end;
      const pk = readTag(b, p); if (pk.context && pk.number === 2 && !pk.open) return out; // array element
      const { values } = readValueList(b, p, 3); const m = find(oid.type, oid.instance, prop);
      if (m && values.length === 1) out.push({ at, point: m.point, value: values[0], source });
      void p;
    } else if ((f.pduType === 1 && f.service === 2) || (f.pduType === 0 && f.service === 1)) {
      let t = readTag(b, 0); t = readTag(b, t.end); // [0] process id, [1] initiating device
      const ot = readTag(b, t.end); const oid = objectId(b, ot); const tr = readTag(b, ot.end); // [2] monitored object, [3] time remaining
      const open = readTag(b, tr.end); if (!open.open || open.number !== 4) return out;
      let p = open.end;
      for (;;) {
        const pt = readTag(b, p); if (pt.close && pt.number === 4) break;
        const prop = uint(b, pt); p = pt.end;
        const pk = readTag(b, p); let arr = false; if (pk.context && pk.number === 1 && !pk.open) { arr = true; p = pk.end; }
        const { values, next } = readValueList(b, p, 2); p = next;
        if (p < b.length) { const pr = readTag(b, p); if (pr.context && pr.number === 3 && !pr.open && !pr.close) p = pr.end; }
        const m = arr ? undefined : find(oid.type, oid.instance, prop);
        // Status flags are a bit string: map only primitive values
        if (m && values.length === 1) out.push({ at, point: m.point, value: values[0], source });
      }
    }
  } catch { /* malformed: no observations */ }
  return out;
}

function npduReply(req: BacnetFrame): number[] {
  if (req.snet) return [0x01, 0x20, req.snet.net >> 8, req.snet.net & 0xff, req.snet.adr.length, ...req.snet.adr, 0xff];
  return [0x01, 0x00];
}

/** An Error-PDU for a refused confirmed request: error class security (4), code write-access-denied (40). */
export function bacnetErrorReply(req: BacnetFrame, errorClass = 4, errorCode = 40): Uint8Array | null {
  if (req.pduType !== 0 || req.invokeId === undefined || req.service === undefined) return null; // unconfirmed: nothing to answer
  const apdu = [0x50, req.invokeId, req.service, 0x91, errorClass, 0x91, errorCode];
  const body = [...npduReply(req), ...apdu]; const len = body.length + 4;
  return new Uint8Array([0x81, 0x0a, len >> 8, len & 0xff, ...body]);
}

// ── Encoders (tests, tools, simulators) ──
const ctxUint = (n: number, v: number) => { const bytes: number[] = []; let x = v; do { bytes.unshift(x & 0xff); x = Math.floor(x / 256); } while (x > 0); return [(n << 4) | 0x08 | bytes.length, ...bytes]; };
const oidBytes = (type: number, instance: number) => { const v = type * 2 ** 22 + instance; return [0x0c, (v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]; };
export type BacnetEncodable = { real: number } | { unsigned: number } | { enumerated: number } | { boolean: boolean } | { null: true } | { string: string };
function appBytes(v: BacnetEncodable): number[] {
  if ('real' in v) { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, v.real); return [0x44, ...new Uint8Array(d.buffer)]; }
  if ('unsigned' in v || 'enumerated' in v) { const n = 'unsigned' in v ? v.unsigned : v.enumerated; const tag = 'unsigned' in v ? 2 : 9; const bytes: number[] = []; let x = n; do { bytes.unshift(x & 0xff); x = Math.floor(x / 256); } while (x > 0); return [(tag << 4) | bytes.length, ...bytes]; }
  if ('boolean' in v) return [0x10 | (v.boolean ? 1 : 0)];
  if ('string' in v) { const s = [0, ...new TextEncoder().encode(v.string)]; return s.length <= 4 ? [0x70 | s.length, ...s] : [0x75, s.length, ...s]; }
  return [0x00];
}
const wrap = (apdu: number[], npdu: number[] = [0x01, 0x04]) => { const body = [...npdu, ...apdu]; const len = body.length + 4; return new Uint8Array([0x81, 0x0a, len >> 8, len & 0xff, ...body]); };

export function encodeBacnetWriteProperty(r: { invokeId: number; objectType: number; instance: number; property?: number; value: BacnetEncodable; priority?: number; arrayIndex?: number }): Uint8Array {
  const data = [0x0c, ...oidBytes(r.objectType, r.instance).slice(1), ...ctxUint(1, r.property ?? BACNET_PRESENT_VALUE), ...(r.arrayIndex !== undefined ? ctxUint(2, r.arrayIndex) : []), 0x3e, ...appBytes(r.value), 0x3f, ...(r.priority !== undefined ? ctxUint(4, r.priority) : [])];
  return wrap([0x00, 0x05, r.invokeId, 15, ...data]);
}

export function encodeBacnetWritePropertyMultiple(r: { invokeId: number; objects: Array<{ objectType: number; instance: number; props: Array<{ property?: number; value: BacnetEncodable; priority?: number }> }> }): Uint8Array {
  const data: number[] = [];
  for (const o of r.objects) {
    data.push(0x0c, ...oidBytes(o.objectType, o.instance).slice(1), 0x1e);
    for (const p of o.props) data.push(...ctxUint(0, p.property ?? BACNET_PRESENT_VALUE), 0x2e, ...appBytes(p.value), 0x2f, ...(p.priority !== undefined ? ctxUint(3, p.priority) : []));
    data.push(0x1f);
  }
  return wrap([0x00, 0x05, r.invokeId, 16, ...data]);
}

export function encodeBacnetReadPropertyAck(r: { invokeId: number; objectType: number; instance: number; property?: number; value: BacnetEncodable }): Uint8Array {
  return wrap([0x30, r.invokeId, 12, 0x0c, ...oidBytes(r.objectType, r.instance).slice(1), ...ctxUint(1, r.property ?? BACNET_PRESENT_VALUE), 0x3e, ...appBytes(r.value), 0x3f], [0x01, 0x00]);
}

export function encodeBacnetCov(r: { device: number; objectType: number; instance: number; value: BacnetEncodable }): Uint8Array {
  const dev = oidBytes(8, r.device).slice(1); const obj = oidBytes(r.objectType, r.instance).slice(1);
  return wrap([0x10, 2, ...ctxUint(0, 1), 0x1c, ...dev, 0x2c, ...obj, ...ctxUint(3, 0), 0x4e, ...ctxUint(0, BACNET_PRESENT_VALUE), 0x2e, ...appBytes(r.value), 0x2f, 0x4f], [0x01, 0x00]);
}

/** Raw request with any service (tests of privileged and unknown services). */
export function encodeBacnetConfirmed(invokeId: number, service: number, data: number[] = [], segmented = false): Uint8Array {
  return wrap(segmented ? [0x08, 0x05, invokeId, 0, 1, service, ...data] : [0x00, 0x05, invokeId, service, ...data]);
}
