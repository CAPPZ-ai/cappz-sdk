/**
 * COPE node crystallized.
 * Node ID: v15-40-00-constraint-adapter-mqtt
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Plain MQTT (3.1.1 and 5.0) for constraint checks: IoT devices that publish
 * JSON telemetry and take commands on a topic. A topic map names, per exact
 * topic or per filter with + and # wildcards (matched level by level, never as
 * a pattern), the point, where the value is in the JSON (a dot path, or the
 * whole payload), where the time is, and whether the topic is a command topic.
 *
 * For an inline guard between clients and a broker, the packet reader splits
 * the TCP stream (remaining-length varint, bounded), reads PUBLISH (topic,
 * packet id, MQTT 5 properties skipped by their declared length) and builds
 * the refusal: MQTT 5 PUBACK/PUBREC with reason 0x87 Not authorized; MQTT
 * 3.1.1 has no negative acknowledgement, so a refused QoS 1/2 command closes
 * the connection (what the specification allows for an authorisation failure)
 * and a QoS 0 command is dropped — both alarmed. Sparkplug B topics go to the
 * Sparkplug adapter.
 */

import type { PointValue } from '../authority.ts';
import type { Observation } from '../reconcile.ts';
import { NUMBER_TEXT, type WriteDecode } from './common.ts';

export interface MqttTopicRule { point: string; valuePath?: string; timePath?: string; unit?: string; command?: boolean }
/** Topic or filter → rule. Exact topics win over filters; among filters the one with fewer wildcards wins. */
export type MqttTopicMap = Record<string, MqttTopicRule>;

export function topicMatches(filter: string, topic: string): boolean {
  const f = filter.split('/'); const t = topic.split('/');
  if (topic.startsWith('$') && (f[0] === '+' || f[0] === '#')) return false; // $SYS etc. never match a leading wildcard
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return i === f.length - 1;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

export function ruleFor(map: MqttTopicMap, topic: string): MqttTopicRule | undefined {
  if (map[topic]) return map[topic];
  const wild = (f: string) => f.split('/').filter((x) => x === '+' || x === '#').length;
  const best = Object.keys(map).filter((f) => (f.includes('+') || f.includes('#')) && topicMatches(f, topic)).sort((a, b) => wild(a) - wild(b) || b.length - a.length || (a < b ? -1 : 1))[0];
  return best === undefined ? undefined : map[best];
}

const get = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), o);

function payloadValue(payload: Uint8Array, rule: MqttTopicRule): { value?: PointValue; at?: number; error?: string } {
  let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(payload); } catch { return { error: 'payload is not UTF-8' }; }
  if (text.length > 256 * 1024) return { error: 'payload too large' };
  let doc: unknown = text.trim();
  try { doc = JSON.parse(text); } catch { /* a bare value: "21.5", "ON" */ }
  const raw = rule.valuePath ? get(doc, rule.valuePath) : doc;
  const value: PointValue | undefined = typeof raw === 'number' && Number.isFinite(raw) ? raw : typeof raw === 'boolean' ? raw
    : typeof raw === 'string' ? (NUMBER_TEXT.test(raw.trim()) ? Number(raw) : raw.trim().toUpperCase() === 'ON' ? true : raw.trim().toUpperCase() === 'OFF' ? false : raw) : undefined;
  if (value === undefined) return { error: `no value at ${rule.valuePath ?? 'the payload'}` };
  let at: number | undefined;
  if (rule.timePath) { const t = get(doc, rule.timePath); at = typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : typeof t === 'string' ? Date.parse(t) : undefined; if (at !== undefined && !Number.isFinite(at)) at = undefined; }
  return { value, at };
}

/** One received message → an observation or a command (or why not). */
export function readMqttMessage(topic: string, payload: Uint8Array, map: MqttTopicMap, receivedAt = Date.now()): { observation?: Observation; command?: { at: number; point: string; value: PointValue; unit?: string; source: string }; unmapped?: string; error?: string } {
  const rule = ruleFor(map, topic); if (!rule) return { unmapped: topic };
  const v = payloadValue(payload, rule); if (v.error) return { error: `${topic}: ${v.error}` };
  const at = v.at ?? receivedAt; const source = `mqtt:${topic}`;
  return rule.command ? { command: { at, point: rule.point, value: v.value!, unit: rule.unit, source } } : { observation: { at, point: rule.point, value: v.value!, unit: rule.unit, source } };
}

// ── Packets ──

export interface MqttPacket { type: number; flags: number; body: Uint8Array; raw: Uint8Array }
export interface MqttPublish { topic: string; qos: 0 | 1 | 2; retain: boolean; dup: boolean; packetId?: number; payload: Uint8Array }

export const MQTT_MAX_PACKET = 1 << 20;

export class MqttFramer {
  private buf = new Uint8Array(0);
  constructor(private readonly maxPacket = MQTT_MAX_PACKET) {}
  push(chunk: Uint8Array): MqttPacket[] {
    const b = new Uint8Array(this.buf.length + chunk.length); b.set(this.buf); b.set(chunk, this.buf.length); this.buf = b;
    const out: MqttPacket[] = [];
    for (;;) {
      if (this.buf.length < 2) break;
      let len = 0; let mul = 1; let i = 1; let done = false;
      for (; i <= 4 && i < this.buf.length; i++) { len += (this.buf[i] & 0x7f) * mul; if (!(this.buf[i] & 0x80)) { done = true; break; } mul *= 128; }
      if (!done) { if (i > 4) throw new Error('MQTT: remaining length longer than 4 bytes'); break; }
      if (len > this.maxPacket) throw new Error(`MQTT: packet of ${len} bytes over the ${this.maxPacket} limit`);
      const total = i + 1 + len; if (this.buf.length < total) break;
      const raw = this.buf.slice(0, total); this.buf = this.buf.slice(total);
      out.push({ type: raw[0] >> 4, flags: raw[0] & 0x0f, body: raw.slice(i + 1), raw });
    }
    return out;
  }
}

function varInt(b: Uint8Array, p: number): { value: number; next: number } {
  let v = 0; let mul = 1;
  for (let i = 0; i < 4; i++) { if (p + i >= b.length) throw new Error('truncated varint'); v += (b[p + i] & 0x7f) * mul; if (!(b[p + i] & 0x80)) return { value: v, next: p + i + 1 }; mul *= 128; }
  throw new Error('varint too long');
}

export function parsePublish(pkt: MqttPacket, protocolLevel: 4 | 5): MqttPublish | { error: string } {
  if (pkt.type !== 3) return { error: 'not a PUBLISH' };
  const qos = ((pkt.flags >> 1) & 3) as 0 | 1 | 2; if (qos === 3 as number) return { error: 'QoS 3 is malformed' };
  const b = pkt.body;
  try {
    if (b.length < 2) throw new Error('truncated topic');
    const tl = (b[0] << 8) | b[1]; if (2 + tl > b.length) throw new Error('topic past end');
    const topic = new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(2, 2 + tl));
    if (!topic || topic.includes('+') || topic.includes('#') || topic.includes('\u0000')) throw new Error('invalid topic name');
    let p = 2 + tl; let packetId: number | undefined;
    if (qos > 0) { if (p + 2 > b.length) throw new Error('truncated packet id'); packetId = (b[p] << 8) | b[p + 1]; if (!packetId) throw new Error('packet id 0'); p += 2; }
    if (protocolLevel === 5) { const pl = varInt(b, p); if (pl.next + pl.value > b.length) throw new Error('properties past end'); p = pl.next + pl.value; }
    return { topic, qos, retain: !!(pkt.flags & 1), dup: !!(pkt.flags & 8), packetId, payload: b.slice(p) };
  } catch (e) { return { error: (e as Error).message }; }
}

/** The protocol level from a CONNECT packet (4 = 3.1.1, 5 = 5.0). */
export function connectLevel(pkt: MqttPacket): 4 | 5 | 3 | null {
  if (pkt.type !== 1 || pkt.body.length < 7) return null;
  const nl = (pkt.body[0] << 8) | pkt.body[1]; const lvl = pkt.body[2 + nl];
  return lvl === 4 || lvl === 5 || lvl === 3 ? lvl : null;
}

/** Decide a PUBLISH for the guard: command topics are writes, everything else passes. */
export function decodeMqttPublish(pub: MqttPublish, map: MqttTopicMap): WriteDecode {
  const rule = ruleFor(map, pub.topic);
  if (!rule) return { kind: 'read' }; // not a governed topic (the broker's ACLs apply)
  if (!rule.command) return { kind: 'read' };
  const v = payloadValue(pub.payload, rule);
  if (v.error) return { kind: 'malformed', because: v.error };
  return { kind: 'write', writes: [{ point: rule.point, value: v.value! }], unmapped: [] };
}

/** Refusal for a PUBLISH: MQTT 5 PUBACK/PUBREC with reason 0x87; 3.1.1 → 'close' (QoS>0) or 'drop' (QoS 0). */
export function mqttRefusal(pub: MqttPublish, protocolLevel: 4 | 5): { reply?: Uint8Array; action: 'reply' | 'close' | 'drop' } {
  if (pub.qos === 0) return { action: 'drop' };
  if (protocolLevel === 5) return { action: 'reply', reply: new Uint8Array([pub.qos === 1 ? 0x40 : 0x50, 3, pub.packetId! >> 8, pub.packetId! & 0xff, 0x87]) };
  return { action: 'close' };
}

export function encodePublish(r: { topic: string; payload: Uint8Array | string; qos?: 0 | 1 | 2; packetId?: number; protocolLevel?: 4 | 5; retain?: boolean }): Uint8Array {
  const t = new TextEncoder().encode(r.topic); const p = typeof r.payload === 'string' ? new TextEncoder().encode(r.payload) : r.payload;
  const qos = r.qos ?? 0; const body = [t.length >> 8, t.length & 0xff, ...t, ...(qos ? [(r.packetId ?? 1) >> 8, (r.packetId ?? 1) & 0xff] : []), ...(r.protocolLevel === 5 ? [0] : []), ...p];
  const len: number[] = []; let n = body.length; do { let x = n % 128; n = Math.floor(n / 128); if (n) x |= 0x80; len.push(x); } while (n);
  return new Uint8Array([0x30 | (qos << 1) | (r.retain ? 1 : 0), ...len, ...body]);
}

export function encodeConnect(clientId: string, protocolLevel: 4 | 5): Uint8Array {
  const id = new TextEncoder().encode(clientId);
  const body = [0, 4, 0x4d, 0x51, 0x54, 0x54, protocolLevel, 0x02, 0, 60, ...(protocolLevel === 5 ? [0] : []), id.length >> 8, id.length & 0xff, ...id];
  return new Uint8Array([0x10, body.length, ...body]);
}
