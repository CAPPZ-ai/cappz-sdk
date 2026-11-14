/**
 * COPE node crystallized.
 * Node ID: v15-40-00-constraint-adapter-sparkplug
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * MQTT Sparkplug B (Eclipse Sparkplug 3.0) for constraint checks. Topics are
 * spBv1.0/<group>/<NBIRTH|NDEATH|DBIRTH|DDEATH|NDATA|DDATA|NCMD|DCMD|STATE>/<edge node>[/<device>];
 * payloads are the Sparkplug B protobuf. DATA messages become observations;
 * NCMD/DCMD messages are commands (writes) a guard checks. Metric aliases are
 * learned from BIRTH messages, per edge node and device, and forgotten on
 * DEATH — a DATA metric whose alias was never born is reported, not guessed.
 *
 * The protobuf reader is bounded (message size, metric count, nesting) and
 * rejects truncated varints and lengths that run past the buffer.
 */

import type { PointValue } from '../authority.ts';
import type { Observation } from '../reconcile.ts';

export const SPARKPLUG_LIMITS = { maxBytes: 1 << 20, maxMetrics: 10_000, maxString: 64 * 1024 };

export interface SparkplugTopic { namespace: 'spBv1.0'; group: string; type: 'NBIRTH' | 'NDEATH' | 'DBIRTH' | 'DDEATH' | 'NDATA' | 'DDATA' | 'NCMD' | 'DCMD'; edgeNode: string; device?: string }

export function parseSparkplugTopic(topic: string): SparkplugTopic | null {
  const parts = topic.split('/');
  if (parts[0] !== 'spBv1.0' || parts.length < 4 || parts.length > 5 || parts.some((p) => !p || p.includes('+') || p.includes('#'))) return null;
  const type = parts[2] as SparkplugTopic['type'];
  if (!['NBIRTH', 'NDEATH', 'DBIRTH', 'DDEATH', 'NDATA', 'DDATA', 'NCMD', 'DCMD'].includes(type)) return null;
  const isDevice = type.startsWith('D');
  if (isDevice !== (parts.length === 5)) return null;
  return { namespace: 'spBv1.0', group: parts[1], type, edgeNode: parts[3], device: parts[4] };
}

export interface SparkplugMetric { name?: string; alias?: number; timestamp?: number; datatype?: number; isNull?: boolean; isHistorical?: boolean; value?: PointValue }
export interface SparkplugPayload { timestamp?: number; seq?: number; metrics: SparkplugMetric[] }

// Sparkplug B DataType enum (subset with scalar values)
const DT = { Int8: 1, Int16: 2, Int32: 3, Int64: 4, UInt8: 5, UInt16: 6, UInt32: 7, UInt64: 8, Float: 9, Double: 10, Boolean: 11, String: 12, DateTime: 13, Text: 14 } as const;

class Reader {
  i = 0;
  constructor(readonly b: Uint8Array, readonly end = b.length) {}
  varint(): bigint {
    let r = 0n; let shift = 0n;
    for (let n = 0; n < 10; n++) {
      if (this.i >= this.end) throw new Error('truncated varint');
      const byte = this.b[this.i++]; r |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return r;
      shift += 7n;
    }
    throw new Error('varint too long');
  }
  bytes(): Uint8Array {
    const n = Number(this.varint());
    if (n < 0 || this.i + n > this.end) throw new Error('length past end of buffer');
    const out = this.b.subarray(this.i, this.i + n); this.i += n; return out;
  }
  fixed32(): DataView { if (this.i + 4 > this.end) throw new Error('truncated fixed32'); const v = new DataView(this.b.buffer, this.b.byteOffset + this.i, 4); this.i += 4; return v; }
  fixed64(): DataView { if (this.i + 8 > this.end) throw new Error('truncated fixed64'); const v = new DataView(this.b.buffer, this.b.byteOffset + this.i, 8); this.i += 8; return v; }
  skip(wire: number) {
    if (wire === 0) this.varint(); else if (wire === 1) this.fixed64(); else if (wire === 2) this.bytes(); else if (wire === 5) this.fixed32();
    else throw new Error(`unsupported wire type ${wire}`);
  }
}

const dec = new TextDecoder('utf-8', { fatal: true });

function readMetric(b: Uint8Array): SparkplugMetric {
  const r = new Reader(b); const m: SparkplugMetric = {};
  let intV: bigint | undefined; let longV: bigint | undefined;
  while (r.i < r.end) {
    const tag = Number(r.varint()); const field = tag >>> 3; const wire = tag & 7;
    if (field === 1 && wire === 2) { const s = r.bytes(); if (s.length > SPARKPLUG_LIMITS.maxString) throw new Error('metric name too long'); m.name = dec.decode(s); }
    else if (field === 2 && wire === 0) m.alias = Number(r.varint());
    else if (field === 3 && wire === 0) m.timestamp = Number(r.varint());
    else if (field === 4 && wire === 0) m.datatype = Number(r.varint());
    else if (field === 5 && wire === 0) m.isHistorical = r.varint() !== 0n;
    else if (field === 7 && wire === 0) m.isNull = r.varint() !== 0n;
    else if (field === 10 && wire === 0) intV = r.varint();
    else if (field === 11 && wire === 0) longV = r.varint();
    else if (field === 12 && wire === 5) m.value = r.fixed32().getFloat32(0, true);
    else if (field === 13 && wire === 1) m.value = r.fixed64().getFloat64(0, true);
    else if (field === 14 && wire === 0) m.value = r.varint() !== 0n;
    else if (field === 15 && wire === 2) { const s = r.bytes(); if (s.length > SPARKPLUG_LIMITS.maxString) throw new Error('string value too long'); m.value = dec.decode(s); }
    else r.skip(wire);
  }
  if (intV !== undefined) {
    const u = Number(intV & 0xffffffffn);
    m.value = m.datatype === DT.Int8 ? ((u & 0xff) << 24) >> 24 : m.datatype === DT.Int16 ? ((u & 0xffff) << 16) >> 16 : m.datatype === DT.Int32 ? u | 0 : u;
  }
  if (longV !== undefined) {
    const v = m.datatype === DT.Int64 ? BigInt.asIntN(64, longV) : BigInt.asUintN(64, longV);
    m.value = Number(v); // precision beyond 2^53 is lost; envelopes compare engineering values, not counters
  }
  return m;
}

export function decodeSparkplugPayload(bytes: Uint8Array): SparkplugPayload {
  if (bytes.length > SPARKPLUG_LIMITS.maxBytes) throw new Error('Sparkplug payload too large');
  const r = new Reader(bytes); const p: SparkplugPayload = { metrics: [] };
  while (r.i < r.end) {
    const tag = Number(r.varint()); const field = tag >>> 3; const wire = tag & 7;
    if (field === 1 && wire === 0) p.timestamp = Number(r.varint());
    else if (field === 2 && wire === 2) { if (p.metrics.length >= SPARKPLUG_LIMITS.maxMetrics) throw new Error('too many metrics'); p.metrics.push(readMetric(r.bytes())); }
    else if (field === 3 && wire === 0) p.seq = Number(r.varint());
    else r.skip(wire);
  }
  return p;
}

// ── Encoder (tests, simulators and tools) ──
function varint(n: bigint | number): number[] { let v = BigInt.asUintN(64, BigInt(n)); const out: number[] = []; do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v); return out; }
const tagOf = (f: number, w: number) => varint((f << 3) | w);
const lenDelim = (f: number, bytes: number[]) => [...tagOf(f, 2), ...varint(bytes.length), ...bytes];
export function encodeSparkplugPayload(p: SparkplugPayload): Uint8Array {
  const enc = new TextEncoder(); const out: number[] = [];
  if (p.timestamp !== undefined) out.push(...tagOf(1, 0), ...varint(p.timestamp));
  for (const m of p.metrics) {
    const mb: number[] = [];
    if (m.name !== undefined) mb.push(...lenDelim(1, [...enc.encode(m.name)]));
    if (m.alias !== undefined) mb.push(...tagOf(2, 0), ...varint(m.alias));
    if (m.timestamp !== undefined) mb.push(...tagOf(3, 0), ...varint(m.timestamp));
    const dt = m.datatype ?? (typeof m.value === 'boolean' ? DT.Boolean : typeof m.value === 'string' ? DT.String : DT.Double);
    mb.push(...tagOf(4, 0), ...varint(dt));
    if (m.isNull) mb.push(...tagOf(7, 0), 1);
    else if (typeof m.value === 'boolean') mb.push(...tagOf(14, 0), m.value ? 1 : 0);
    else if (typeof m.value === 'string') mb.push(...lenDelim(15, [...enc.encode(m.value)]));
    else if (typeof m.value === 'number') {
      if (dt === DT.Float) { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, m.value, true); mb.push(...tagOf(12, 5), ...new Uint8Array(d.buffer)); }
      else if (dt === DT.Double) { const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, m.value, true); mb.push(...tagOf(13, 1), ...new Uint8Array(d.buffer)); }
      else if (dt === DT.Int64 || dt === DT.UInt64 || dt === DT.DateTime) mb.push(...tagOf(11, 0), ...varint(BigInt(Math.trunc(m.value))));
      else mb.push(...tagOf(10, 0), ...varint(BigInt(Math.trunc(m.value)) & 0xffffffffn));
    }
    out.push(...lenDelim(2, mb));
  }
  if (p.seq !== undefined) out.push(...tagOf(3, 0), ...varint(p.seq));
  return new Uint8Array(out);
}

// ── Alias state and mapping to points ──

/** Map "<group>/<edgeNode>[/<device>]/<metric name>" → point id. */
export type SparkplugMap = Record<string, string>;

export interface SparkplugIngest { observations: Observation[]; commands: Array<{ at: number; point: string; value: PointValue; source: string }>; unmapped: string[]; unknownAliases: number[] }

/** Stateful reader: learns aliases from BIRTH, forgets on DEATH. */
export function createSparkplugReader(map: SparkplugMap) {
  const aliases = new Map<string, Map<number, string>>(); // scope → alias → metric name
  return {
    ingest(topic: string, payload: Uint8Array, receivedAt = Date.now()): SparkplugIngest {
      const out: SparkplugIngest = { observations: [], commands: [], unmapped: [], unknownAliases: [] };
      const t = parseSparkplugTopic(topic); if (!t) return out;
      const scope = [t.group, t.edgeNode, t.device].filter(Boolean).join('/');
      if (t.type === 'NDEATH') { for (const k of [...aliases.keys()]) if (k === scope || k.startsWith(`${scope}/`)) aliases.delete(k); return out; }
      if (t.type === 'DDEATH') { aliases.delete(scope); return out; }
      const p = decodeSparkplugPayload(payload);
      if (t.type === 'NBIRTH' || t.type === 'DBIRTH') { const a = new Map<number, string>(); for (const m of p.metrics) if (m.alias !== undefined && m.name) a.set(m.alias, m.name); aliases.set(scope, a); }
      for (const m of p.metrics) {
        const name = m.name ?? (m.alias !== undefined ? aliases.get(scope)?.get(m.alias) : undefined);
        if (!name) { if (m.alias !== undefined) out.unknownAliases.push(m.alias); continue; }
        if (m.isNull || m.value === undefined) continue;
        const key = `${scope}/${name}`; const point = map[key];
        if (!point) { out.unmapped.push(key); continue; }
        const at = m.timestamp ?? p.timestamp ?? receivedAt;
        if (t.type === 'NCMD' || t.type === 'DCMD') out.commands.push({ at, point, value: m.value, source: `sparkplug:${topic}` });
        else out.observations.push({ at, point, value: m.value, source: `sparkplug:${topic}`, quality: m.isHistorical ? 'uncertain' : 'good' });
      }
      return out;
    },
  };
}
