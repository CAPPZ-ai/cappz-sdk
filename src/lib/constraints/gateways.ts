/**
 * COPE node crystallized.
 * Node ID: v15-40-00-constraint-gateways
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * The guard in front of each kind of write path. Each gateway turns wire
 * traffic into the guard's one decision and the protocol's own refusal:
 *
 *   HTTP/REST panels    403 with the verdict; signed command in `Cappz-Command`
 *   Modbus TCP          exception 0x01 (privileged) / 0x03 (refused)
 *   BACnet/IP           Error-PDU security / write-access-denied
 *   DNP3                response echoing the objects with NOT_AUTHORIZED
 *   IEC 60870-5-104     negative activation confirmation; sequence numbers kept
 *   MQTT (+ Sparkplug)  MQTT 5 reason 0x87; 3.1.1 close (QoS>0) or drop
 *   Gremlin Server      status 401 with the reason
 *
 * Gateways are transport-free (bytes in, bytes out) so the same code runs in
 * the edge node, a small board, or a test. Reads pass; responses flowing back
 * feed the guard's current values and the observation log.
 */

import type { SignedCommand } from './authority.ts';
import type { ConstraintGuard, GuardVerdict } from './guard.ts';
import type { Observation } from './reconcile.ts';
import type { WriteDecode } from './adapters/common.ts';
import { decodeModbusRequest, modbusException, observationsFromModbusRead, parseModbusFrame, type ModbusFrame, type ModbusRegister } from './adapters/modbus.ts';
import { bacnetErrorReply, decodeBacnetRequest, observationsFromBacnet, parseBacnetIp, type BacnetObjectMap } from './adapters/bacnet.ts';
import { decodeDnp3Request, dnp3RefusalResponse, observationsFromDnp3, parseDnp3Link, type Dnp3PointMap } from './adapters/dnp3.ts';
import { createIec104Session, decodeIec104Request, observationsFromIec104, parseIec104, type Iec104PointMap } from './adapters/iec104.ts';
import { connectLevel, decodeMqttPublish, mqttRefusal, parsePublish, readMqttMessage, type MqttPacket, type MqttTopicMap } from './adapters/mqtt.ts';
import { createSparkplugReader, parseSparkplugTopic, type SparkplugMap } from './adapters/sparkplug.ts';
import { decodeGremlinRequest, type GraphPointMap } from './adapters/graph.ts';

export interface GatewayResult { forward?: Uint8Array; reply?: Uint8Array; close?: boolean; verdict?: GuardVerdict; observations?: Observation[] }

const fromB64Url = (s: string) => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };

// ── HTTP / REST ──

export interface HttpRoute {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Literal segments and {name} placeholders: /api/v1/points/{id}/setpoint */
  path: string;
  /** A fixed point, or a placeholder whose value is looked up in `map`. */
  point: string | { param: string; map: Record<string, string> };
  /** JSON Pointer (RFC 6901) to the value in the body; '' = the whole body. */
  value: string;
  unit?: string;
}

export function matchPath(template: string, path: string): Record<string, string> | null {
  const t = template.split('/'); const p = path.split('/');
  if (t.length !== p.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < t.length; i++) {
    if (t[i].startsWith('{') && t[i].endsWith('}')) { if (!p[i]) return null; try { out[t[i].slice(1, -1)] = decodeURIComponent(p[i]); } catch { return null; } }
    else if (t[i] !== p[i]) return null;
  }
  return out;
}

export function jsonPointer(doc: unknown, pointer: string): unknown {
  if (pointer === '') return doc;
  if (!pointer.startsWith('/')) return undefined;
  let cur: unknown = doc;
  for (const raw of pointer.slice(1).split('/')) {
    const k = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cur)) { if (!/^(0|[1-9]\d*)$/.test(k)) return undefined; cur = cur[Number(k)]; }
    else if (cur && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, k)) cur = (cur as Record<string, unknown>)[k];
    else return undefined;
  }
  return cur;
}

const HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'host', 'content-length', 'expect'];

export interface HttpGuardOptions {
  guard: ConstraintGuard;
  upstream: string | ((req: Request) => Promise<Response>);
  routes: readonly HttpRoute[];
  /** Write methods on paths no route covers (default false: refused in enforce, recorded in shadow). */
  allowUnmatchedWrites?: boolean;
  maxBodyBytes?: number;
}

/** A guard in front of a controller's web panel or REST API. */
export function createHttpControlGuard(o: HttpGuardOptions) {
  const max = o.maxBodyBytes ?? 64 * 1024;
  const forward = async (req: Request, body: Uint8Array | null, url: URL) => {
    const headers = new Headers(); req.headers.forEach((v, k) => { if (!HOP.includes(k.toLowerCase()) && k.toLowerCase() !== 'cappz-command') headers.set(k, v); });
    const init: RequestInit = { method: req.method, headers, body: body && body.length ? (body.slice().buffer as ArrayBuffer) : undefined, redirect: 'manual' };
    if (typeof o.upstream === 'function') return o.upstream(new Request(url.toString(), init));
    const target = new URL(url.pathname + url.search, o.upstream);
    return fetch(target, init);
  };
  const refuse = (v: GuardVerdict) => new Response(JSON.stringify({ refused: true, reasons: v.reasons }), { status: 403, headers: { 'content-type': 'application/json', 'cappz-constraint-verdict': 'refused' } });

  async function decide(req: Request, body: Uint8Array | null, url: URL): Promise<{ decode: WriteDecode; command: SignedCommand | null }> {
    const route = o.routes.map((r) => ({ r, params: r.method === req.method ? matchPath(r.path, url.pathname) : null })).find((x) => x.params);
    if (!route) return { decode: o.allowUnmatchedWrites ? { kind: 'read' } : { kind: 'write', writes: [], unmapped: [`${req.method} ${url.pathname}`] }, command: null };
    const point = typeof route.r.point === 'string' ? route.r.point : route.r.point.map[route.params![route.r.point.param]];
    if (!point) return { decode: { kind: 'write', writes: [], unmapped: [`${req.method} ${url.pathname}`] }, command: null };
    let command: SignedCommand | null = null;
    const h = req.headers.get('cappz-command');
    if (h) { try { if (h.length > 8192) throw new Error('too long'); command = JSON.parse(new TextDecoder().decode(fromB64Url(h))); } catch { return { decode: { kind: 'malformed', because: 'Cappz-Command is not base64url JSON' }, command: null }; } }
    if (req.method === 'DELETE') return { decode: { kind: 'write', writes: [{ point, value: 'delete' }], unmapped: [] }, command };
    let doc: unknown;
    try { doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body ?? new Uint8Array())); } catch { return { decode: { kind: 'malformed', because: 'the body is not JSON' }, command }; }
    const raw = jsonPointer(doc, route.r.value);
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : typeof raw === 'boolean' || typeof raw === 'string' ? raw : undefined;
    if (value === undefined) return { decode: { kind: 'malformed', because: `no value at ${route.r.value || 'the body'}` }, command };
    return { decode: { kind: 'write', writes: [{ point, value }], unmapped: [] }, command: command && route.r.unit && !command.unit ? command : command };
  }

  return {
    async handle(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname === '/cappz/constraints/report' && req.method === 'GET') return Response.json(await o.guard.report());
      if (url.pathname === '/cappz/constraints/arm' && req.method === 'POST') {
        let cmd: SignedCommand; try { cmd = JSON.parse(await req.text()); } catch { return Response.json({ error: 'body must be a signed command' }, { status: 400 }); }
        const a = await o.guard.arm(cmd); return Response.json(a, { status: a.state === 'authorized' ? 200 : 403 });
      }
      const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
      if (!isWrite) return forward(req, null, url);
      const len = Number(req.headers.get('content-length') ?? 0); if (len > max) return new Response('body too large', { status: 413 });
      let body: Uint8Array;
      try { body = await readLimited(req, max); } catch { return new Response('body too large', { status: 413 }); }
      const { decode, command } = await decide(req, body, url);
      const v = await o.guard.check(decode, { source: `http:${req.method} ${url.pathname}`, command });
      if (!v.forward) return refuse(v);
      const res = await forward(req, body, url);
      if (!v.wouldRefuse) return res;
      const h = new Headers(res.headers); h.set('cappz-constraint-verdict', `shadow-refused:${v.reasons.map((r) => r.reason).join(',')}`);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
    },
  };
}

async function readLimited(req: Request, max: number): Promise<Uint8Array> {
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader(); const parts: Uint8Array[] = []; let n = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; if (n > max) { await reader.cancel(); throw new Error('too large'); } parts.push(value); }
  const out = new Uint8Array(n); let p = 0; for (const x of parts) { out.set(x, p); p += x.length; } return out;
}

// ── Modbus TCP ──

export function createModbusGateway(o: { guard: ConstraintGuard; map: readonly ModbusRegister[]; source?: string }) {
  const pending = new Map<number, ModbusFrame>();
  return {
    async fromClient(frame: Uint8Array): Promise<GatewayResult> {
      const f = parseModbusFrame(frame);
      if (!f) { const v = await o.guard.check({ kind: 'malformed', because: 'not a Modbus TCP frame' }, { source: o.source ?? 'modbus' }); return v.forward ? { forward: frame, verdict: v } : { close: true, verdict: v }; }
      const d = decodeModbusRequest(f, o.map);
      const decode: WriteDecode = d.kind === 'unknown-function' ? { kind: 'privileged', what: `Modbus function ${d.fn}` } : d.kind === 'write' ? { kind: 'write', writes: d.writes.map((w) => ({ point: w.point, value: w.value })), unmapped: d.unmapped.map((u) => `${u.table}:${u.address}@${f.unitId}`) } : d;
      const v = await o.guard.check(decode, { source: o.source ?? `modbus:unit${f.unitId}` });
      if (!v.forward) return { reply: modbusException(f, decode.kind === 'privileged' ? 0x01 : 0x03), verdict: v };
      if (f.fn >= 1 && f.fn <= 4) { pending.set(f.transactionId, f); if (pending.size > 1024) pending.delete(pending.keys().next().value!); }
      return { forward: frame, verdict: v };
    },
    async fromServer(frame: Uint8Array, at = Date.now()): Promise<GatewayResult> {
      const f = parseModbusFrame(frame); if (!f) return { forward: frame };
      const req = pending.get(f.transactionId); pending.delete(f.transactionId);
      const observations = req ? observationsFromModbusRead(req, f, o.map, at, o.source ?? 'modbus') : [];
      if (observations.length) await o.guard.observe(observations);
      return { forward: frame, observations };
    },
  };
}

// ── BACnet/IP ──

export function createBacnetGateway(o: { guard: ConstraintGuard; map: readonly BacnetObjectMap[] }) {
  return {
    async fromClient(datagram: Uint8Array, target?: string): Promise<GatewayResult> {
      const f = parseBacnetIp(datagram);
      const decode: WriteDecode = f ? decodeBacnetRequest(f, o.map, target) : { kind: 'malformed', because: 'not BACnet/IP' };
      const v = await o.guard.check(decode, { source: `bacnet:${target ?? ''}` });
      if (v.forward) return { forward: datagram, verdict: v };
      const reply = f ? bacnetErrorReply(f) : null;
      return reply ? { reply, verdict: v } : { verdict: v };
    },
    async fromServer(datagram: Uint8Array, target?: string, at = Date.now()): Promise<GatewayResult> {
      const f = parseBacnetIp(datagram); const observations = f ? observationsFromBacnet(f, o.map, at, target) : [];
      if (observations.length) await o.guard.observe(observations);
      return { forward: datagram, observations };
    },
  };
}

// ── DNP3 ──

export function createDnp3Gateway(o: { guard: ConstraintGuard; map: readonly Dnp3PointMap[] }) {
  return {
    async fromClient(frame: Uint8Array): Promise<GatewayResult> {
      const f = parseDnp3Link(frame);
      if ('error' in f) { const v = await o.guard.check({ kind: 'malformed', because: `DNP3 link: ${f.error}` }, { source: 'dnp3' }); return v.forward ? { forward: frame, verdict: v } : { verdict: v }; }
      if (!f.userData.length) return { forward: frame }; // link-layer only (status, reset)
      const decode = decodeDnp3Request(f, o.map);
      const v = await o.guard.check(decode, { source: `dnp3:${f.source}->${f.destination}` });
      if (v.forward) return { forward: frame, verdict: v };
      const reply = dnp3RefusalResponse(f); return reply ? { reply, verdict: v } : { verdict: v };
    },
    async fromServer(frame: Uint8Array, at = Date.now()): Promise<GatewayResult> {
      const f = parseDnp3Link(frame); if ('error' in f || !f.userData.length) return { forward: frame };
      const observations = observationsFromDnp3(f, o.map, at);
      if (observations.length) await o.guard.observe(observations);
      return { forward: frame, observations };
    },
  };
}

// ── IEC 60870-5-104 (one instance per client connection) ──

export function createIec104Gateway(o: { guard: ConstraintGuard; map: readonly Iec104PointMap[] }) {
  const session = createIec104Session();
  return {
    async fromClient(frame: Uint8Array): Promise<GatewayResult> {
      const a = parseIec104(frame);
      if (!a) { const v = await o.guard.check({ kind: 'malformed', because: 'not an IEC 104 APDU' }, { source: 'iec104' }); return v.forward ? { forward: frame, verdict: v } : { close: true, verdict: v }; }
      const decode = decodeIec104Request(a, o.map);
      if (decode.kind === 'read') return { forward: session.toServer(a) };
      const v = await o.guard.check(decode, { source: 'iec104' });
      if (v.forward) return { forward: session.toServer(a), verdict: v };
      return { reply: session.refuse(a), verdict: v };
    },
    async fromServer(frame: Uint8Array, at = Date.now()): Promise<GatewayResult> {
      const a = parseIec104(frame); if (!a) return { forward: frame };
      const observations = observationsFromIec104(a, o.map, at);
      if (observations.length) await o.guard.observe(observations);
      return { forward: session.toClient(a), observations };
    },
    state: () => session.state(),
  };
}

// ── MQTT (one instance per client connection; Sparkplug reader shared) ──

export function createMqttGateway(o: { guard: ConstraintGuard; topics?: MqttTopicMap; sparkplug?: { map: SparkplugMap; reader?: ReturnType<typeof createSparkplugReader> } }) {
  let level: 4 | 5 = 4; const sp = o.sparkplug ? (o.sparkplug.reader ?? createSparkplugReader(o.sparkplug.map)) : undefined;
  return {
    async fromClient(pkt: MqttPacket, at = Date.now()): Promise<GatewayResult> {
      if (pkt.type === 1) { const l = connectLevel(pkt); if (l === 5 || l === 4) level = l; return { forward: pkt.raw }; }
      if (pkt.type !== 3) return { forward: pkt.raw };
      const pub = parsePublish(pkt, level);
      if ('error' in pub) { const v = await o.guard.check({ kind: 'malformed', because: `MQTT PUBLISH: ${pub.error}` }, { source: 'mqtt' }); return v.forward ? { forward: pkt.raw, verdict: v } : { close: true, verdict: v }; }
      let decode: WriteDecode = { kind: 'read' }; let observations: Observation[] = [];
      const spt = sp ? parseSparkplugTopic(pub.topic) : null;
      if (sp && spt) {
        try {
          const r = sp.ingest(pub.topic, pub.payload, at); observations = r.observations;
          if (spt.type === 'NCMD' || spt.type === 'DCMD') decode = { kind: 'write', writes: r.commands.map((c) => ({ point: c.point, value: c.value })), unmapped: [...r.unmapped, ...r.unknownAliases.map((x) => `alias ${x}`)] };
        } catch (e) { decode = { kind: 'malformed', because: `Sparkplug payload: ${(e as Error).message}` }; }
      } else if (o.topics) {
        decode = decodeMqttPublish(pub, o.topics);
        if (decode.kind === 'read') { const m = readMqttMessage(pub.topic, pub.payload, o.topics, at); if (m.observation) observations = [m.observation]; }
      }
      if (observations.length) await o.guard.observe(observations);
      if (decode.kind === 'read') return { forward: pkt.raw, observations };
      const v = await o.guard.check(decode, { source: `mqtt:${pub.topic}` });
      if (v.forward) return { forward: pkt.raw, verdict: v, observations };
      const r = mqttRefusal(pub, level);
      return r.action === 'reply' ? { reply: r.reply, verdict: v } : r.action === 'close' ? { close: true, verdict: v } : { verdict: v };
    },
  };
}

// ── Gremlin Server (GraphSON 3 over WebSocket or HTTP) ──

export function createGremlinGateway(o: { guard: ConstraintGuard; map: readonly GraphPointMap[]; maxBytes?: number }) {
  return {
    async fromClient(text: string): Promise<{ forward?: string; reply?: string; verdict?: GuardVerdict }> {
      if (text.length > (o.maxBytes ?? 1 << 20)) { const v = await o.guard.check({ kind: 'malformed', because: 'request too large' }, { source: 'gremlin' }); return v.forward ? { forward: text, verdict: v } : { reply: gremlinError(undefined, 'request too large'), verdict: v }; }
      let msg: { requestId?: unknown } | null = null; try { msg = JSON.parse(text); } catch { /* malformed below */ }
      const decode: WriteDecode = msg ? decodeGremlinRequest(msg, o.map) : { kind: 'malformed', because: 'not JSON' };
      const v = await o.guard.check(decode, { source: 'gremlin' });
      if (v.forward) return { forward: text, verdict: v };
      return { reply: gremlinError(msg?.requestId, v.reasons.map((r) => `${r.reason}: ${r.because}`).join('; ')), verdict: v };
    },
  };
}

const gremlinError = (requestId: unknown, message: string) => JSON.stringify({ requestId: typeof requestId === 'string' ? requestId : null, status: { message: `refused by the constraint guard — ${message}`, code: 401, attributes: {} }, result: { data: null, meta: {} } });
