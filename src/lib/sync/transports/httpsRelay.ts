/**
 * COPE node crystallized.
 * Node ID: v15-03-00-https-relay
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Replicator relay for copies behind firewalls and reverse proxies. One
 * Fetch-API handler (Request → Response), so the same code runs on the
 * Deno edge node, Bun, Node 18+, inside the browser demo and in tests.
 *
 *   POST /rendezvous   ReplicaConnectRequested (bid) → node decides:
 *                      ReplicaConnectOffered (ticket + ask) or ReplicaConnectRejected
 *   GET  /stream       receiver-initiated HTTP/1.1 keep-alive chunked stream:
 *                      CPZ1 frames back to back, no per-message HTTP overhead
 *   GET  /poll         long-poll fallback for proxies that buffer chunked bodies
 *   POST /up           batched CPZ1 frames from the copy
 *   POST /close        TunnelClosed
 *   attach(duplex)     v15-04-00 socket carriers: a WebSocket (wss) or a
 *                      WebTransport stream handed over by the host. The
 *                      first frame is `auth {ticket, cursor}`; then frames
 *                      flow both ways on the one connection.
 *
 * The ticket travels in `Authorization: Bearer`, never in the URL, so it
 * stays out of proxy and server access logs. Hellos are verified (Ed25519,
 * helloSignature.ts), and tickets are capped per wallet and in total.
 *
 * The relay is a pipe: it checks CPZ1 framing and checksums, never opens
 * payloads (seal them end to end), keeps a bounded in-memory log per
 * channel and forgets it after the TTL. Each delivered frame is followed by
 * a `pong {cursor}` so a cut connection resumes from the last cursor; a frame
 * cut before its pong may arrive twice — endpoints dedupe by id/hash.
 */

import { FrameDecoder, decodeJsonFrame, encodeFrame, encodeJsonFrame, type WireFrame } from '../frameCodec.ts';
import type { ByteDuplex } from '../edgeSession.ts';
import type { EndpointRecord } from '../endpointDirectory.ts';
import { comparePrices, type SyncPrice } from '../a2aSyncPricing.ts';
import { adminInQueueAddress, A2A_SYNC_GOVERNING_PRINCIPLE, type A2ASyncEvent } from '../a2aSyncEvents.ts';
import type { TransportHello } from '../transportContract.ts';
import { acceptsSignature, verifyHello, type SignatureCheck } from '../helloSignature.ts';
import { verifyHelloKeyDeclaration, type DeclarationCheck } from '../helloKeyDeclaration.ts';

export const REPLICA_CONNECT_BPMN_PATH = "m/44'/144'/100'/bpmn/substrate/replica-connect";

/**
 * Carrier rungs, fastest first; the client steps down (httpsTunnel.ts).
 * v15-04-00 adds the socket rungs above the HTTP floor.
 */
export type CarrierRung = 'webtransport' | 'wss' | 'https-stream' | 'https-poll';
export type SocketRung = Extract<CarrierRung, 'webtransport' | 'wss'>;

/** Where a node takes socket carriers (from its offer). */
export interface CarrierEndpoints { wss?: string; webtransport?: string; certificateHashes?: string[] }

export interface RendezvousRequest {
  requestId: string;
  walletAddress: string;
  copyId: string;
  /** Network channel or sorted party pair (lib/replicator/network.ts). */
  channelId: string;
  rungs: CarrierRung[];
  /** The bid: the most this copy pays to be carried. */
  bid?: SyncPrice;
  /** Bytes the copy expects to move — priced against the node's ask. */
  expectedBytes?: number;
  hello?: TransportHello;
  sentAt: string;
}

export interface RendezvousOffer {
  eventType: 'ReplicaConnectOffered';
  requestId: string;
  ticket: string;
  channelId: string;
  copyId: string;
  rungs: CarrierRung[];
  /** Socket carrier URLs, when the node serves them. */
  endpoints?: CarrierEndpoints;
  /**
   * v15-05-00 — the answering node's own member-table record: when the
   * source answers for itself, the copy learns where to reach it directly
   * (tx → source endpoint mapping) and stores it in its directory.
   */
  endpoint?: EndpointRecord;
  ask: SyncPrice;
  askTotalCappz: number;
  expiresAt: string;
}
export interface RendezvousReject {
  eventType: 'ReplicaConnectRejected';
  requestId: string;
  reason: string;
  ask?: SyncPrice;
}
export type RendezvousDecision = RendezvousOffer | RendezvousReject;

export interface RelayPolicy {
  /** Node wallet (POW) that decides connect requests. */
  nodeAddress: string;
  /** What the node asks to carry traffic. 0 CAPPZ still records the decision. */
  ask: SyncPrice;
  /**
   * Every copy must send a hello whose Ed25519 signature verifies (v15-04-00:
   * the default; the old demo-only open mode is gone). Only in-process tests
   * that exercise other rules set this to carry copies with no hello at all;
   * a bad, stale or wrong-key signature is refused either way.
   */
  allowUnsignedHello?: boolean;
  /** Keys each wallet declared; with requireBoundKey only those keys are carried. */
  declaredKeys?: (walletAddress: string) => Promise<readonly string[] | null> | readonly string[] | null;
  requireBoundKey?: boolean;
  /** Open tickets per wallet and in total — an open relay must not hoard tickets. */
  maxTicketsPerWallet?: number;
  maxTickets?: number;
  ticketTtlMs?: number;
  /** Keep-alive pong interval — keep it under the proxy's idle timeout. */
  keepAliveMs?: number;
  /** A stream rotates after this long so long-lived proxies never hold a stale one. */
  maxStreamMs?: number;
  maxPollWaitMs?: number;
  maxFramesPerChannel?: number;
  maxUploadBytes?: number;
  channelTtlMs?: number;
  /** CORS origin for browser copies; '*' by default. */
  allowOrigin?: string;
  /**
   * v15-04-00 — socket carriers the host serves (it hands connections to
   * attach()). wss: true derives the URL from the public URL (or the
   * request), a string names it. webtransport needs its own URL (UDP).
   */
  socketRungs?: { wss?: boolean | string; webtransport?: { url: string; certificateHashes?: string[] } };
  /** Public base URL (https://relay.example.com/cpz1) behind a reverse proxy. */
  publicUrl?: string;
  /** v15-05-00 — this node's own endpoint record, returned in every offer (the source answering for itself). */
  endpointRecord?: EndpointRecord | (() => EndpointRecord | null | undefined);
  /** Every decision and tunnel lifecycle record goes here (edge node: signed TX log). */
  record?: (event: A2ASyncEvent) => void | Promise<void>;
  now?: () => number;
}

interface Ticket { copyId: string; walletAddress: string; channelId: string; expiresAt: number; requestId: string; opened: boolean }
interface Entry { seq: number; from: string; bytes: Uint8Array }
interface ChannelLog { seq: number; entries: Entry[]; waiters: Set<() => void>; touchedAt: number }

export interface RelayStats { channels: number; tickets: number; frames: number; bytesIn: number; bytesOut: number; streams: number; polls: number }

export interface HttpsRelay {
  handle(req: Request): Promise<Response>;
  /** Carry a socket connection (wss or webtransport); resolves when it ends. */
  attach(duplex: ByteDuplex, rung: SocketRung): Promise<void>;
  stats(): RelayStats;
  /** Drop everything (tests, node shutdown). */
  close(): void;
}

let counter = 0;
const rid = (p: string) => `${p}-${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

const HTTP_RUNGS: CarrierRung[] = ['https-stream', 'https-poll'];
const LADDER: CarrierRung[] = ['webtransport', 'wss', 'https-stream', 'https-poll'];

const HELLO_REASON: Record<SignatureCheck, string> = {
  'verified-bound': 'accepted',
  'verified-unbound': 'this node only carries keys the wallet declared',
  unsigned: 'no signature',
  'bad-signature': 'the signature does not match the hello',
  'wrong-key': 'the key is not one this wallet declared',
  stale: 'the hello is too old or from the future; sign a fresh one',
};

export function createHttpsRelay(policy: RelayPolicy): HttpsRelay {
  const now = policy.now ?? (() => Date.now());
  const ticketTtl = policy.ticketTtlMs ?? 30 * 60_000;
  const keepAlive = policy.keepAliveMs ?? 15_000;
  const maxStream = policy.maxStreamMs ?? 10 * 60_000;
  const maxWait = policy.maxPollWaitMs ?? 25_000;
  const maxFrames = policy.maxFramesPerChannel ?? 5_000;
  const maxUpload = policy.maxUploadBytes ?? 16 * 1024 * 1024;
  const channelTtl = policy.channelTtlMs ?? 60 * 60_000;
  const maxPerWallet = policy.maxTicketsPerWallet ?? 8;
  const maxTickets = policy.maxTickets ?? 10_000;
  const tickets = new Map<string, Ticket>();
  const channels = new Map<string, ChannelLog>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const stats: RelayStats = { channels: 0, tickets: 0, frames: 0, bytesIn: 0, bytesOut: 0, streams: 0, polls: 0 };

  const cors: Record<string, string> = {
    'Access-Control-Allow-Origin': policy.allowOrigin ?? '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Max-Age': '600',
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

  const record = async (eventType: A2ASyncEvent['eventType'], address: string, correlationId: string, data: Record<string, unknown>, step: string) => {
    const event: A2ASyncEvent = {
      txId: rid('tx'), eventType, address, correlationId, governingPrinciple: A2A_SYNC_GOVERNING_PRINCIPLE,
      bpmnSteps: [step], timestamp: new Date(now()).toISOString(), data: { ...data, bpmnPath: REPLICA_CONNECT_BPMN_PATH },
    };
    try { await policy.record?.(event); } catch { /* recording failure never wedges the pipe */ }
    return event;
  };

  const channel = (id: string) => {
    let c = channels.get(id);
    if (!c) { c = { seq: 0, entries: [], waiters: new Set(), touchedAt: now() }; channels.set(id, c); }
    c.touchedAt = now();
    return c;
  };
  const sweep = () => {
    const t = now();
    for (const [k, v] of tickets) if (v.expiresAt <= t) tickets.delete(k);
    for (const [k, v] of channels) if (t - v.touchedAt > channelTtl && v.waiters.size === 0) channels.delete(k);
    stats.channels = channels.size; stats.tickets = tickets.size;
  };
  const bearer = (req: Request) => /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1] ?? '';
  const ticketOf = (req: Request): Ticket | null => {
    sweep();
    const t = tickets.get(bearer(req));
    if (!t) return null;
    t.expiresAt = now() + ticketTtl; // sliding — an active copy never loses its ticket
    return t;
  };
  const pending = (log: ChannelLog, cursor: number, self: string) => log.entries.filter((e) => e.seq > cursor && e.from !== self);
  const cursorFrame = (log: ChannelLog, cursor: number) => encodeJsonFrame('pong', { cursor, floor: log.entries[0]?.seq ?? log.seq, head: log.seq });

  async function rendezvous(req: Request): Promise<Response> {
    let body: RendezvousRequest;
    try { body = await req.json() as RendezvousRequest; } catch { return json({ error: 'body must be a ReplicaConnectRequested JSON object' }, 400); }
    if (!body?.requestId || !body.copyId || !body.channelId || !body.walletAddress) return json({ error: 'requestId, walletAddress, copyId and channelId are required' }, 422);
    let declared: readonly string[] | null = null;
    try { declared = (await policy.declaredKeys?.(body.walletAddress)) ?? null; } catch { declared = null; }
    // v15-04-00: a declaration signed by the wallet key binds the device key with no file or lookup.
    const declaration = body.hello?.keyDeclaration;
    const keyDeclaration: DeclarationCheck | 'none' = declaration ? await verifyHelloKeyDeclaration(declaration, now()) : 'none';
    if (keyDeclaration === 'valid' && declaration!.walletAddress === body.walletAddress) declared = [...(declared ?? []), declaration!.devicePublicKey];
    const helloCheck: SignatureCheck = await verifyHello(body.hello, { declaredKeys: declared, now: now() });
    // Requester sends XRequested to the decider's in-queue; the decider replies to the requester's.
    await record('ReplicaConnectRequested', adminInQueueAddress(policy.nodeAddress), body.requestId, {
      requestId: body.requestId, walletAddress: body.walletAddress, copyId: body.copyId, channelId: body.channelId,
      rungs: body.rungs, bid: body.bid, expectedBytes: body.expectedBytes ?? 0, helloCheck, keyDeclaration,
    }, 'ReceiveConnectRequest');
    const reject = async (reason: string): Promise<Response> => {
      const decision: RendezvousReject = { eventType: 'ReplicaConnectRejected', requestId: body.requestId, reason, ask: policy.ask };
      await record('ReplicaConnectRejected', adminInQueueAddress(body.walletAddress), body.requestId, { ...decision, decidedBy: policy.nodeAddress }, 'DecideConnect');
      return json(decision, 200);
    };
    if (helloCheck === 'unsigned') {
      if (!policy.allowUnsignedHello || policy.requireBoundKey) return reject('unsigned hello: this node only carries copies that sign their hello');
    } else if (!acceptsSignature(helloCheck, Boolean(policy.requireBoundKey))) {
      return reject(`hello ${helloCheck}: ${HELLO_REASON[helloCheck]}`);
    }
    if (body.hello && body.hello.walletAddress !== body.walletAddress) return reject('hello is for a different wallet than the request');
    const served = servedRungs();
    const rungs = LADDER.filter((r) => served.includes(r) && (body.rungs ?? HTTP_RUNGS).includes(r));
    if (!rungs.length) return reject(`no common carrier: this node speaks ${served.join(', ')}`);
    const price = comparePrices(policy.ask, body.bid, body.expectedBytes ?? 0);
    if (!price.ok) return reject(`bid ${price.bidTotal} CAPPZ is below the ask ${price.askTotal} CAPPZ for ${body.expectedBytes ?? 0} bytes`);
    sweep();
    if (tickets.size >= maxTickets) return reject(`node is at its ticket limit (${maxTickets}); try again later`);
    if ([...tickets.values()].filter((t) => t.walletAddress === body.walletAddress).length >= maxPerWallet) {
      return reject(`wallet already holds ${maxPerWallet} open tickets; close one first`);
    }
    const ticket = `tk-${crypto.randomUUID()}`;
    const expiresAt = now() + ticketTtl;
    tickets.set(ticket, { copyId: body.copyId, walletAddress: body.walletAddress, channelId: body.channelId, expiresAt, requestId: body.requestId, opened: false });
    stats.tickets = tickets.size;
    const decision: RendezvousOffer = {
      eventType: 'ReplicaConnectOffered', requestId: body.requestId, ticket, channelId: body.channelId, copyId: body.copyId,
      rungs, endpoints: endpointsFor(req, rungs), ...(selfRecord() ? { endpoint: selfRecord()! } : {}), ask: policy.ask, askTotalCappz: price.askTotal, expiresAt: new Date(expiresAt).toISOString(),
    };
    // The ticket is a bearer secret: the ledger record carries only its hash prefix.
    const { ticket: _secret, endpoint: selfEndpoint, ...publicDecision } = decision;
    // The record carries only the mapping (tx → the source's endpoint address), not the whole entry.
    await record('ReplicaConnectOffered', adminInQueueAddress(body.walletAddress), body.requestId, { ...publicDecision, ticketRef: await shortHash(ticket), decidedBy: policy.nodeAddress, ...(selfEndpoint ? { endpointAddress: selfEndpoint.address } : {}) }, 'DecideConnect');
    return json(decision, 200);
  }

  async function opened(t: Ticket, rung: CarrierRung) {
    if (t.opened) return;
    t.opened = true;
    await record('TunnelOpened', adminInQueueAddress(t.walletAddress), t.requestId, { requestId: t.requestId, copyId: t.copyId, channelId: t.channelId, rung, node: policy.nodeAddress }, 'OpenTunnel');
  }

  function stream(t: Ticket, cursor: number): Response {
    const log = channel(t.channelId);
    let wake: (() => void) | null = null;
    let closed = false;
    stats.streams++;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const started = now();
        let c = cursor;
        const push = (b: Uint8Array) => { stats.bytesOut += b.length; controller.enqueue(b); };
        // First byte right away: lets the client tell a live stream from a buffering proxy.
        push(await cursorFrame(log, c));
        void opened(t, 'https-stream');
        while (!closed && now() - started < maxStream) {
          for (const e of pending(log, c, t.copyId)) {
            if (closed) break;
            push(e.bytes);
            c = e.seq;
            push(await cursorFrame(log, c));
          }
          if (closed) break;
          const due = Math.max(0, Math.min(keepAlive, maxStream - (now() - started)));
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => { timers.delete(timer); log.waiters.delete(waker); resolve(); }, due);
            timers.add(timer);
            const waker = () => { clearTimeout(timer); timers.delete(timer); log.waiters.delete(waker); resolve(); };
            wake = waker;
            log.waiters.add(waker);
          });
          if (!closed && !pending(log, c, t.copyId).length) push(await cursorFrame(log, c)); // keep-alive
        }
        if (!closed) { closed = true; controller.close(); }
      },
      cancel() { closed = true; if (wake) wake(); },
    });
    return new Response(body, {
      headers: {
        ...cors,
        'Content-Type': 'application/octet-stream',
        // Ask every hop not to buffer or transform the stream (nginx honours X-Accel-Buffering).
        'Cache-Control': 'no-cache, no-store, no-transform',
        'X-Accel-Buffering': 'no',
        'X-Cappz-Rung': 'https-stream',
      },
    });
  }

  async function poll(t: Ticket, cursor: number, waitMs: number, signal?: AbortSignal): Promise<Response> {
    const log = channel(t.channelId);
    stats.polls++;
    void opened(t, 'https-poll');
    if (!pending(log, cursor, t.copyId).length && waitMs > 0 && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { timers.delete(timer); log.waiters.delete(waker); resolve(); }, Math.min(waitMs, maxWait));
        timers.add(timer);
        const waker = () => { clearTimeout(timer); timers.delete(timer); log.waiters.delete(waker); signal?.removeEventListener('abort', waker); resolve(); };
        log.waiters.add(waker);
        // A client that hangs up frees its waiter now, not at the wait timeout.
        signal?.addEventListener('abort', waker, { once: true });
      });
    }
    const parts: Uint8Array[] = [];
    let c = cursor;
    for (const e of pending(log, cursor, t.copyId)) { parts.push(e.bytes); c = e.seq; parts.push(await cursorFrame(log, c)); }
    // Entries from this copy still advance its cursor.
    if (!parts.length) parts.push(await cursorFrame(log, Math.max(c, log.seq)));
    const out = concat(parts);
    stats.bytesOut += out.length;
    return new Response(out as unknown as BodyInit, { headers: { ...cors, 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-cache, no-store, no-transform', 'X-Cappz-Rung': 'https-poll' } });
  }

  /** Append a copy's frames to its channel and wake every waiting reader. */
  async function appendFrames(t: Ticket, frames: WireFrame[]): Promise<ChannelLog> {
    const log = channel(t.channelId);
    for (const f of frames) {
      if (f.command === 'ping' || f.command === 'pong' || f.command === 'auth' || f.command === 'bye') continue; // carrier control stays off the channel
      const raw = await encodeFrame(f.command, f.payload);
      log.entries.push({ seq: ++log.seq, from: t.copyId, bytes: raw });
      stats.frames++;
      stats.bytesIn += raw.length;
    }
    if (log.entries.length > maxFrames) log.entries.splice(0, log.entries.length - maxFrames);
    for (const w of [...log.waiters]) w();
    return log;
  }

  async function up(t: Ticket, req: Request): Promise<Response> {
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length > maxUpload) return json({ error: `upload over ${maxUpload} bytes` }, 413);
    let frames: WireFrame[];
    const decoder = new FrameDecoder();
    try { frames = await decoder.feed(bytes); } catch (e) { return json({ error: `rejected: ${e instanceof Error ? e.message : 'bad frame'}` }, 422); }
    if (decoder.pendingBytes) return json({ error: 'rejected: truncated frame' }, 422);
    const log = await appendFrames(t, frames);
    return json({ accepted: frames.length, head: log.seq });
  }

  function selfRecord(): EndpointRecord | undefined {
    const r = typeof policy.endpointRecord === 'function' ? policy.endpointRecord() : policy.endpointRecord;
    return r ?? undefined;
  }

  function servedRungs(): CarrierRung[] {
    return LADDER.filter((r) => HTTP_RUNGS.includes(r) || (r === 'wss' && policy.socketRungs?.wss) || (r === 'webtransport' && policy.socketRungs?.webtransport));
  }

  function endpointsFor(req: Request, rungs: CarrierRung[]): CarrierEndpoints | undefined {
    const out: CarrierEndpoints = {};
    if (rungs.includes('wss') && policy.socketRungs?.wss) {
      if (typeof policy.socketRungs.wss === 'string') out.wss = policy.socketRungs.wss;
      else {
        const base = new URL(policy.publicUrl ?? req.url);
        const path = base.pathname.replace(/\/(rendezvous)?\/*$/, '');
        out.wss = `${base.protocol === 'https:' ? 'wss:' : 'ws:'}//${base.host}${path}/ws`;
      }
    }
    if (rungs.includes('webtransport') && policy.socketRungs?.webtransport) {
      out.webtransport = policy.socketRungs.webtransport.url;
      if (policy.socketRungs.webtransport.certificateHashes?.length) out.certificateHashes = policy.socketRungs.webtransport.certificateHashes;
    }
    return out.wss || out.webtransport ? out : undefined;
  }

  /**
   * A socket carrier: first frame `auth {ticket, cursor}` within 10 s, then
   * the channel's frames flow down (each followed by its cursor) and the
   * copy's frames flow up, on the one connection.
   */
  async function attach(duplex: ByteDuplex, rung: SocketRung): Promise<void> {
    const reader = duplex.readable.getReader();
    const writer = duplex.writable.getWriter();
    const decoder = new FrameDecoder();
    const inbox: WireFrame[] = [];
    let ended = false;
    let wake: (() => void) | null = null;
    const next = async (): Promise<WireFrame | null> => {
      while (!inbox.length) {
        const r = await reader.read();
        if (r.done) return null;
        inbox.push(...await decoder.feed(r.value));
      }
      return inbox.shift()!;
    };
    const send = async (b: Uint8Array) => { stats.bytesOut += b.length; await writer.write(b); };
    const finish = () => { ended = true; wake?.(); try { duplex.close(); } catch { /* already closed */ } };
    try {
      const first = await Promise.race([next(), new Promise<null>((r) => { const tm = setTimeout(() => r(null), 10_000); timers.add(tm); })]);
      if (!first || first.command !== 'auth') { await send(await encodeJsonFrame('bye', { reason: 'expected auth as first frame' })).catch(() => {}); return; }
      const auth = decodeJsonFrame<{ ticket?: string; cursor?: number }>(first);
      sweep();
      const t = tickets.get(String(auth.ticket ?? ''));
      if (!t) { await send(await encodeJsonFrame('bye', { reason: 'unknown or expired ticket — send ReplicaConnectRequested again' })).catch(() => {}); return; }
      t.expiresAt = now() + ticketTtl;
      stats.streams++;
      void opened(t, rung);
      const log = channel(t.channelId);
      let c = Math.max(0, Number(auth.cursor ?? 0) || 0);
      // Upstream: the copy's frames go onto the channel.
      void (async () => {
        try {
          for (let f = await next(); f; f = await next()) {
            if (f.command === 'bye') break;
            await appendFrames(t, [f]);
          }
        } catch { /* connection dropped */ }
        finish();
      })();
      // Downstream: pending frames, each followed by its cursor; keep-alive pongs between.
      await send(await cursorFrame(log, c));
      while (!ended) {
        for (const e of pending(log, c, t.copyId)) { await send(e.bytes); c = e.seq; await send(await cursorFrame(log, c)); }
        if (ended) break;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { timers.delete(timer); log.waiters.delete(waker); resolve(); }, keepAlive);
          timers.add(timer);
          const waker = () => { clearTimeout(timer); timers.delete(timer); log.waiters.delete(waker); resolve(); };
          wake = waker;
          log.waiters.add(waker);
        });
        if (!ended && !pending(log, c, t.copyId).length) await send(await cursorFrame(log, c));
      }
    } catch { /* write to a closed socket ends the carrier */ }
    finally {
      finish();
      try { reader.releaseLock(); writer.releaseLock(); } catch { /* released */ }
    }
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '').split('/').pop() ?? '';
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method === 'GET' && path === 'health') sweep();
    if (req.method === 'GET' && path === 'health') return json({ ok: true, node: policy.nodeAddress, rungs: servedRungs(), ask: policy.ask, ...stats });
    if (req.method === 'POST' && path === 'rendezvous') return rendezvous(req);
    const t = ticketOf(req);
    if (!t) return json({ error: 'unknown or expired ticket — send ReplicaConnectRequested again' }, 401);
    const cursor = Math.max(0, Number(url.searchParams.get('cursor') ?? 0) || 0);
    if (req.method === 'GET' && path === 'stream') return stream(t, cursor);
    if (req.method === 'GET' && path === 'poll') return poll(t, cursor, Number(url.searchParams.get('wait') ?? maxWait) || 0, req.signal);
    if (req.method === 'POST' && path === 'up') return up(t, req);
    if (req.method === 'POST' && path === 'close') {
      tickets.delete(bearer(req));
      stats.tickets = tickets.size;
      await record('TunnelClosed', adminInQueueAddress(t.walletAddress), t.requestId, { requestId: t.requestId, copyId: t.copyId, channelId: t.channelId, node: policy.nodeAddress }, 'CloseTunnel');
      return json({ closed: true });
    }
    return json({ error: 'not found: /rendezvous, /stream, /poll, /up, /close, /health' }, 404);
  }

  return {
    handle,
    attach,
    stats: () => { sweep(); return { ...stats }; },
    close: () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const c of channels.values()) for (const w of [...c.waiters]) w();
      tickets.clear(); channels.clear();
    },
  };
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function shortHash(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}
