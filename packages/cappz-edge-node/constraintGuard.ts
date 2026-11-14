/**
 * COPE node crystallized.
 * Node ID: v15-40-00-edge-node-constraint-guard
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * Constraint Guard on the edge node (src/lib/constraints): an independent
 * check in front of a controller's write path. Runs when CAPPZ_CONSTRAINTS_CONFIG
 * names a config file (tools/constraint-wizard.ts init writes one). Each
 * configured front listens on its own port and forwards to the controller:
 *
 *   { "envelopeId": "site-17/oven-3", "trustedOperators": ["<hex>"], "minRelaxSigners": 2,
 *     "host": "0.0.0.0",
 *     "http":    { "port": 41452, "upstream": "http://10.0.0.5", "routes": [ ...HttpRoute ] },
 *     "modbus":  { "port": 41502, "upstream": "10.0.0.5:502",   "map": [ ...ModbusRegister ] },
 *     "dnp3":    { "port": 41520, "upstream": "10.0.0.6:20000", "map": [ ...Dnp3PointMap ] },
 *     "iec104":  { "port": 41404, "upstream": "10.0.0.7:2404",  "map": [ ...Iec104PointMap ] },
 *     "mqtt":    { "port": 41883, "upstream": "10.0.0.8:1883",  "topics": { ... }, "sparkplug": { "map": { ... } } },
 *     "bacnet":  { "port": 47809, "upstream": "10.0.0.9:47808", "map": [ ...BacnetObjectMap ] },   (needs --unstable-net)
 *     "gremlin": { "port": 41182, "upstream": "ws://10.0.0.10:8182/gremlin", "map": [ ...GraphPointMap ] },
 *     "allowPrivileged": [], "allowUnmapped": false, "gate": { "minWrites": 20, "minDays": 7, "minCleanWrites": 10 } }
 *
 * Signed inputs in <data> (re-read when they change):
 *   constraint-envelopes.jsonl   envelope versions, endorsements, revocations (constraint-wizard declare / endorse / revoke)
 *   constraint-modes.jsonl       per-point shadow/enforce records citing the report hash (constraint-wizard enforce / shadow)
 *   constraint-key-evidence.json optional KeyZ declarations and revocations for grants that name a wallet
 * Outputs:
 *   constraint-verdicts.jsonl    every write decision          constraint-alerts.jsonl  refusals, fail modes, privileged
 *   constraint-observations.jsonl sealed observation batches (node key, chained) for constraint-reconcile
 *   constraint-shadow.json       guard state, saved every 30 s and on shutdown
 * HTTP front also serves GET /cappz/constraints/report and POST /cappz/constraints/arm.
 * Default mode: CAPPZ_CONSTRAINTS_MODE (shadow). Nothing here can make equipment
 * act: a refusal only withholds a write.
 */

import { createConstraintGuard, replayPointModes, type GuardMode, type GuardState, type GuardVerdict, type PointModeRecord, type GatePolicy } from '../../src/lib/constraints/guard.ts';
import { replayEnvelopes, type EnvelopeBody, type EnvelopeRecord } from '../../src/lib/constraints/envelope.ts';
import { createBacnetGateway, createDnp3Gateway, createGremlinGateway, createHttpControlGuard, createIec104Gateway, createModbusGateway, createMqttGateway, type GatewayResult, type HttpRoute } from '../../src/lib/constraints/gateways.ts';
import { ModbusFramer, type ModbusRegister } from '../../src/lib/constraints/adapters/modbus.ts';
import { Dnp3Framer, type Dnp3PointMap } from '../../src/lib/constraints/adapters/dnp3.ts';
import { Iec104Framer, type Iec104PointMap } from '../../src/lib/constraints/adapters/iec104.ts';
import { MqttFramer, type MqttTopicMap } from '../../src/lib/constraints/adapters/mqtt.ts';
import { createSparkplugReader, type SparkplugMap } from '../../src/lib/constraints/adapters/sparkplug.ts';
import { parseBacnetIp, type BacnetObjectMap } from '../../src/lib/constraints/adapters/bacnet.ts';
import type { GraphPointMap } from '../../src/lib/constraints/adapters/graph.ts';
import { sealObservationBatch, type SealedObservationBatch } from '../../src/lib/constraints/seal.ts';
import type { Observation } from '../../src/lib/constraints/reconcile.ts';
import type { KeyEvidence } from '../../src/lib/identity/keyDeclaration.ts';
import type { SigningKey } from '../../src/lib/sync/helloSignature.ts';

export interface ConstraintsConfig {
  envelopeId: string;
  trustedOperators: string[];
  minRelaxSigners?: number;
  host?: string;
  http?: { port: number; upstream: string; routes: HttpRoute[]; allowUnmatchedWrites?: boolean };
  modbus?: { port: number; upstream: string; map: ModbusRegister[] };
  dnp3?: { port: number; upstream: string; map: Dnp3PointMap[] };
  iec104?: { port: number; upstream: string; map: Iec104PointMap[] };
  mqtt?: { port: number; upstream: string; topics?: MqttTopicMap; sparkplug?: { map: SparkplugMap } };
  bacnet?: { port: number; upstream: string; map: BacnetObjectMap[] };
  gremlin?: { port: number; upstream: string; map: GraphPointMap[] };
  allowPrivileged?: string[];
  allowUnmapped?: boolean;
  gate?: GatePolicy;
}

export async function readJsonl<T>(path: string): Promise<T[]> {
  return (await Deno.readTextFile(path).catch(() => '')).split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as T]; } catch { return []; } });
}
const mtimeOf = (p: string) => Deno.stat(p).then((s) => s.mtime?.getTime() ?? 0).catch(() => -1);

/** A value derived from a file, recomputed only when the file changes (and kept when a re-read fails). */
function onChange<T>(path: string, read: () => Promise<T>, fallback: T): () => Promise<T> {
  let cache: { mtime: number; value: T } | null = null;
  return async () => {
    const m = await mtimeOf(path);
    if (!cache || m !== cache.mtime) { try { cache = { mtime: m, value: await read() }; } catch (e) { console.warn(`[edge-node] ${path}: ${(e as Error).message}; keeping the last good copy`); if (!cache) cache = { mtime: m, value: fallback }; } }
    return cache.value;
  };
}

export function hostPort(s: string): { hostname: string; port: number } {
  const i = s.lastIndexOf(':'); const port = Number(s.slice(i + 1));
  if (i <= 0 || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`upstream ${s}: expected host:port`);
  return { hostname: s.slice(0, i).replace(/^\[|\]$/g, ''), port };
}

export async function constraintGuardFor(dataDir: string, cfg: ConstraintsConfig, o: { mode?: GuardMode; nodeKey?: SigningKey | null; now?: () => number } = {}) {
  if (!cfg.envelopeId || !Array.isArray(cfg.trustedOperators) || !cfg.trustedOperators.length) throw new Error('Constraint Guard config: envelopeId and trustedOperators are required');
  const now = o.now ?? Date.now;
  const envPath = `${dataDir}/constraint-envelopes.jsonl`; const modesPath = `${dataDir}/constraint-modes.jsonl`; const evPath = `${dataDir}/constraint-key-evidence.json`;
  let lastWarn = '';
  // The envelope is replayed on every change of the file, and again every minute so a cooling period that ends takes effect.
  let replayed: { at: number; env: EnvelopeBody | null } = { at: 0, env: null }; let envMtime = -2;
  const envelope = async (): Promise<EnvelopeBody | null> => {
    const m = await mtimeOf(envPath);
    if (m !== envMtime || now() - replayed.at > 60_000) {
      const { lines, refused } = await replayEnvelopes(await readJsonl<EnvelopeRecord>(envPath), { trustedKeys: cfg.trustedOperators, now: now(), minRelaxSigners: cfg.minRelaxSigners });
      const w = refused.map((r) => `${r.record}: ${r.because}`).join('; ');
      if (w && w !== lastWarn) console.warn(`[edge-node] constraint envelopes refused: ${w}`); lastWarn = w;
      replayed = { at: now(), env: lines[cfg.envelopeId]?.active ?? null }; envMtime = m;
    }
    return replayed.env;
  };
  const modes = onChange(modesPath, async () => {
    const { modes: m, refused } = await replayPointModes(await readJsonl<PointModeRecord>(modesPath), cfg.trustedOperators, cfg.envelopeId);
    if (refused) console.warn(`[edge-node] ${refused} constraint mode record(s) ignored (untrusted, other envelope, or enforce without a report hash)`);
    return Object.fromEntries(Object.entries(m).map(([k, r]) => [k, r.mode])) as Record<string, GuardMode>;
  }, {});
  const keyEvidence = onChange(evPath, async () => (await mtimeOf(evPath)) < 0 ? undefined : JSON.parse(await Deno.readTextFile(evPath)) as KeyEvidence, undefined);

  const statePath = `${dataDir}/constraint-shadow.json`;
  let saved: GuardState | undefined; try { saved = JSON.parse(await Deno.readTextFile(statePath)); } catch { /* first run */ }
  const append = (name: string, v: unknown) => Deno.writeTextFile(`${dataDir}/${name}`, JSON.stringify(v) + '\n', { append: true }).catch((e) => console.warn(`[edge-node] ${name} not written:`, e?.message ?? e));

  // Observations are sealed in batches with the node key, chained across restarts.
  const obsPath = `${dataDir}/constraint-observations.jsonl`;
  let pendingObs: Observation[] = [];
  let lastBatch: SealedObservationBatch | null = (await readJsonl<SealedObservationBatch>(obsPath)).pop() ?? null;
  const flushObs = async () => {
    if (!pendingObs.length) return;
    const items = pendingObs; pendingObs = [];
    if (!o.nodeKey) { await append('constraint-observations-unsealed.jsonl', items); return; }
    lastBatch = await sealObservationBatch(items, { collector: cfg.envelopeId, previous: lastBatch, key: o.nodeKey });
    await append('constraint-observations.jsonl', lastBatch);
  };

  const guard = createConstraintGuard({
    envelope, pointModes: modes, keyEvidence, mode: o.mode, allowPrivileged: cfg.allowPrivileged, allowUnmapped: cfg.allowUnmapped, gate: cfg.gate, state: saved, now,
    onVerdict: async (v: GuardVerdict) => {
      if (v.kind === 'read') return;
      await append('constraint-verdicts.jsonl', v);
      if (v.alarm) await append('constraint-alerts.jsonl', v);
    },
  });
  const observe = async (obs?: Observation[]) => { if (obs?.length) { pendingObs.push(...obs); if (pendingObs.length >= 500) await flushObs(); } };
  const save = async () => { await flushObs(); await Deno.writeTextFile(`${statePath}.tmp`, JSON.stringify(guard.state())).then(() => Deno.rename(`${statePath}.tmp`, statePath)).catch((e) => console.warn('[edge-node] constraint shadow state not saved:', e?.message ?? e)); };
  return { guard, observe, save, envelope };
}

type Gw = { fromClient(b: Uint8Array): Promise<GatewayResult>; fromServer(b: Uint8Array): Promise<GatewayResult> };
type Framer = { push(c: Uint8Array): Uint8Array[] };

/** A TCP front: frames from the client go through the gateway; frames from the controller come back through it. */
export function serveTcpFront(name: string, listen: { hostname: string; port: number }, upstream: string, mk: () => { gw: Gw; clientFramer: Framer; serverFramer: Framer }, observe: (o?: Observation[]) => Promise<void>) {
  const up = hostPort(upstream);
  const listener = Deno.listen({ hostname: listen.hostname, port: listen.port, transport: 'tcp' });
  console.log(`[edge-node] Constraint Guard ${name} ${listen.hostname}:${listen.port} → ${upstream}`);
  (async () => {
    for await (const client of listener) {
      (async () => {
        let server: Deno.TcpConn | null = null;
        try { server = await Deno.connect({ hostname: up.hostname, port: up.port }); } catch (e) { console.warn(`[edge-node] ${name}: upstream ${upstream} unreachable: ${(e as Error).message}`); try { client.close(); } catch { /* closed */ } return; }
        const { gw, clientFramer, serverFramer } = mk();
        const closeBoth = () => { try { client.close(); } catch { /* closed */ } try { server!.close(); } catch { /* closed */ } };
        const pump = async (from: Deno.TcpConn, framer: Framer, handle: (f: Uint8Array) => Promise<GatewayResult>, to: Deno.TcpConn, back: Deno.TcpConn) => {
          const buf = new Uint8Array(64 * 1024);
          try {
            for (;;) {
              const n = await from.read(buf); if (n === null) break;
              for (const frame of framer.push(buf.subarray(0, n))) {
                const r = await handle(frame);
                await observe(r.observations);
                if (r.forward) await writeAll(to, r.forward);
                if (r.reply) await writeAll(back, r.reply);
                if (r.close) throw new Error('closed by the guard');
              }
            }
          } catch (e) { if ((e as Error).message !== 'closed by the guard' && !(e instanceof Deno.errors.BadResource) && !(e instanceof Deno.errors.Interrupted) && !/operation canceled|connection reset/i.test((e as Error).message)) console.warn(`[edge-node] ${name}: ${(e as Error).message}`); }
          closeBoth();
        };
        await Promise.all([pump(client, clientFramer, (f) => gw.fromClient(f), server, client), pump(server, serverFramer, (f) => gw.fromServer(f), client, server)]);
      })();
    }
  })();
  return listener;
}

async function writeAll(conn: Deno.Conn, b: Uint8Array) { let o = 0; while (o < b.length) o += await conn.write(b.subarray(o)); }

export async function serveConstraintGuard(dataDir: string, nodeKey: SigningKey | null): Promise<{ save: () => Promise<void> }> {
  const cfgPath = Deno.env.get('CAPPZ_CONSTRAINTS_CONFIG'); if (!cfgPath) throw new Error('Constraint Guard needs CAPPZ_CONSTRAINTS_CONFIG');
  const cfg = JSON.parse(await Deno.readTextFile(cfgPath)) as ConstraintsConfig;
  const mode: GuardMode = Deno.env.get('CAPPZ_CONSTRAINTS_MODE') === 'enforce' ? 'enforce' : 'shadow';
  const { guard, observe, save } = await constraintGuardFor(dataDir, cfg, { mode, nodeKey });
  setInterval(() => void save(), 30_000);
  for (const sig of ['SIGTERM', 'SIGINT'] as const) { try { Deno.addSignalListener(sig, () => { save().finally(() => Deno.exit(0)); }); } catch { /* unsupported */ } }
  const hostname = cfg.host ?? Deno.env.get('CAPPZ_CONSTRAINTS_HOST') ?? '127.0.0.1';
  if (!nodeKey) console.warn('[edge-node] Constraint Guard: no node key (CAPPZ_NODE_KEY/CAPPZ_NODE_PUB): observations are logged unsealed');

  if (cfg.http) {
    const front = createHttpControlGuard({ guard, upstream: cfg.http.upstream, routes: cfg.http.routes, allowUnmatchedWrites: cfg.http.allowUnmatchedWrites });
    Deno.serve({ port: cfg.http.port, hostname, onListen: () => console.log(`[edge-node] Constraint Guard http ${hostname}:${cfg.http!.port} → ${cfg.http!.upstream} (${mode}; report GET /cappz/constraints/report)`) }, (req) => front.handle(req));
  }
  if (cfg.modbus) { const map = cfg.modbus.map; serveTcpFront('modbus', { hostname, port: cfg.modbus.port }, cfg.modbus.upstream, () => ({ gw: createModbusGateway({ guard, map }), clientFramer: new ModbusFramer(), serverFramer: new ModbusFramer() }), observe); }
  if (cfg.dnp3) { const map = cfg.dnp3.map; serveTcpFront('dnp3', { hostname, port: cfg.dnp3.port }, cfg.dnp3.upstream, () => ({ gw: createDnp3Gateway({ guard, map }), clientFramer: new Dnp3Framer(), serverFramer: new Dnp3Framer() }), observe); }
  if (cfg.iec104) { const map = cfg.iec104.map; serveTcpFront('iec104', { hostname, port: cfg.iec104.port }, cfg.iec104.upstream, () => ({ gw: createIec104Gateway({ guard, map }), clientFramer: new Iec104Framer(), serverFramer: new Iec104Framer() }), observe); }
  if (cfg.mqtt) {
    const reader = cfg.mqtt.sparkplug ? createSparkplugReader(cfg.mqtt.sparkplug.map) : undefined; const m = cfg.mqtt;
    serveTcpFront('mqtt', { hostname, port: m.port }, m.upstream, () => {
      const g = createMqttGateway({ guard, topics: m.topics, sparkplug: m.sparkplug ? { map: m.sparkplug.map, reader } : undefined });
      const cf = new MqttFramer();
      return {
        clientFramer: { push: (c) => cf.push(c).map((p) => p.raw) },
        serverFramer: { push: (c) => [c] }, // broker → client bytes pass through unframed
        gw: { fromClient: (raw) => g.fromClient(new MqttFramer().push(raw)[0]), fromServer: async (b) => ({ forward: b }) },
      };
    }, observe);
  }
  if (cfg.bacnet) await serveBacnetFront(cfg.bacnet, hostname, guard, observe);
  if (cfg.gremlin) serveGremlinFront(cfg.gremlin, hostname, guard);
  return { save };
}

async function serveBacnetFront(c: NonNullable<ConstraintsConfig['bacnet']>, hostname: string, guard: ReturnType<typeof createConstraintGuard>, observe: (o?: Observation[]) => Promise<void>) {
  const listen = (Deno as unknown as { listenDatagram?: (o: { hostname: string; port: number; transport: 'udp' }) => Deno.DatagramConn }).listenDatagram;
  if (!listen) { console.warn('[edge-node] Constraint Guard bacnet needs --unstable-net (UDP); not started'); return; }
  const up = hostPort(c.upstream); const gw = createBacnetGateway({ guard, map: c.map });
  const front = listen({ hostname, port: c.port, transport: 'udp' });
  const toDevice = listen({ hostname: '0.0.0.0', port: 0, transport: 'udp' });
  const byInvoke = new Map<number, Deno.NetAddr>(); let lastClient: Deno.NetAddr | null = null;
  console.log(`[edge-node] Constraint Guard bacnet udp ${hostname}:${c.port} → ${c.upstream}`);
  (async () => { for await (const [d, addr] of front) {
    const a = addr as Deno.NetAddr; lastClient = a;
    const r = await gw.fromClient(d, c.upstream);
    if (r.forward) { const f = parseBacnetIp(d); if (f && f.pduType === 0 && f.invokeId !== undefined) { byInvoke.set(f.invokeId, a); if (byInvoke.size > 256) byInvoke.delete(byInvoke.keys().next().value!); } await toDevice.send(r.forward, { transport: 'udp', hostname: up.hostname, port: up.port }); }
    if (r.reply) await front.send(r.reply, a);
  } })();
  (async () => { for await (const [d] of toDevice) {
    const r = await gw.fromServer(d, c.upstream); await observe(r.observations);
    const f = parseBacnetIp(d); const to = (f?.invokeId !== undefined ? byInvoke.get(f.invokeId) : undefined) ?? lastClient;
    if (to) await front.send(d, to);
  } })();
}

function serveGremlinFront(c: NonNullable<ConstraintsConfig['gremlin']>, hostname: string, guard: ReturnType<typeof createConstraintGuard>) {
  const gw = createGremlinGateway({ guard, map: c.map });
  Deno.serve({ port: c.port, hostname, onListen: () => console.log(`[edge-node] Constraint Guard gremlin ws ${hostname}:${c.port} → ${c.upstream}`) }, (req) => {
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Gremlin WebSocket only', { status: 426 });
    const { socket, response } = Deno.upgradeWebSocket(req);
    const upstream = new WebSocket(c.upstream); upstream.binaryType = 'arraybuffer';
    const queue: Array<string | ArrayBuffer> = []; let open = false;
    upstream.onopen = () => { open = true; for (const m of queue.splice(0)) upstream.send(m); };
    upstream.onmessage = (e) => { if (socket.readyState === WebSocket.OPEN) socket.send(e.data); };
    upstream.onclose = () => { try { socket.close(); } catch { /* closed */ } };
    socket.onclose = () => { try { upstream.close(); } catch { /* closed */ } };
    socket.onmessage = async (e) => {
      let text: string; let prefix: Uint8Array | null = null;
      if (typeof e.data === 'string') text = e.data;
      else {
        const b = new Uint8Array(e.data as ArrayBuffer); const n = b[0] ?? 0; const mime = new TextDecoder().decode(b.subarray(1, 1 + n));
        if (!mime.includes('json')) { socket.send(JSON.stringify({ requestId: null, status: { code: 401, message: `refused by the constraint guard — ${mime || 'binary'} requests cannot be checked: use GraphSON`, attributes: {} }, result: { data: null, meta: {} } })); return; }
        prefix = b.subarray(0, 1 + n); text = new TextDecoder().decode(b.subarray(1 + n));
      }
      const r = await gw.fromClient(text);
      if (r.reply) { socket.send(r.reply); return; }
      const out: string | ArrayBuffer = prefix ? (() => { const t = new TextEncoder().encode(r.forward!); const u = new Uint8Array(prefix!.length + t.length); u.set(prefix!); u.set(t, prefix!.length); return u.buffer; })() : r.forward!;
      if (open) upstream.send(out); else queue.push(out);
    };
    return response;
  });
}
