/**
 * COPE node crystallized.
 * Node ID: v15-03-00-https-tunnel
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Outbound-only carrier for a copy behind a firewall or reverse proxy. The
 * copy (receiver) initiates everything over HTTPS on 443, so no inbound
 * port, multicast or UDP is needed:
 *
 *   rung 1  https-stream  one long-lived HTTP/1.1 keep-alive response with
 *                         chunked transfer; CPZ1 frames ride back to back
 *                         with no per-message HTTP overhead (the pattern
 *                         market-data vendors used to push prices through
 *                         bank firewalls).
 *   rung 2  https-poll    long-poll batches, for proxies that buffer chunked
 *                         bodies (no first byte within firstByteTimeoutMs).
 *
 * The ticket rides in `Authorization: Bearer`, never in the URL, so proxy
 * and server access logs never hold it.
 *
 * Upstream frames are batched into one POST per tick. Every frame keeps its
 * own CPZ1 checksum; the relay's `pong {cursor}` frames let a connection cut
 * by a proxy idle timeout resume where it stopped.
 */

import { FrameDecoder, encodeJsonFrame, decodeJsonFrame, type WireFrame, type FrameCommand } from '../frameCodec.ts';
import type { SyncPrice } from '../a2aSyncPricing.ts';
import type { TransportHello } from '../transportContract.ts';
import { signHello, type SigningKey } from '../helloSignature.ts';
import type { HelloKeyDeclaration } from '../helloKeyDeclaration.ts';
import { concat, type CarrierEndpoints, type CarrierRung, type RendezvousDecision, type RendezvousRequest, type SocketRung } from './httpsRelay.ts';
import { dialWebSocket, dialWebTransport } from './socketDuplex.ts';
import type { ByteDuplex } from '../edgeSession.ts';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Fastest-first ladder; a copy steps down, never up, within one tunnel.
 * v15-04-00: WebTransport (QUIC/UDP) and WebSocket sit above the HTTPS
 * floor. Each rung carries the same CPZ1 frames; the HTTPS stream remains
 * the proxy-safe floor and long-poll the last resort.
 */
export const CARRIER_LADDER: CarrierRung[] = ['webtransport', 'wss', 'https-stream', 'https-poll'];
const SOCKET_RUNGS: CarrierRung[] = ['webtransport', 'wss'];
export const isSocketRung = (r: CarrierRung): r is SocketRung => SOCKET_RUNGS.includes(r);

export const RUNG_LABEL: Record<CarrierRung, string> = {
  webtransport: 'WebTransport (HTTP/3, QUIC)',
  wss: 'WebSocket (wss)',
  'https-stream': 'HTTPS keep-alive stream (chunked)',
  'https-poll': 'HTTPS long-poll',
};

/** Open a socket carrier; the default uses the runtime's WebSocket / WebTransport. */
export type SocketDialer = (rung: SocketRung, endpoints: CarrierEndpoints) => Promise<ByteDuplex>;

export const defaultSocketDialer: SocketDialer = (rung, ep) => {
  if (rung === 'wss') { if (!ep.wss) throw new Error('node offered no WebSocket URL'); return dialWebSocket(ep.wss); }
  if (!ep.webtransport) throw new Error('node offered no WebTransport URL');
  return dialWebTransport(ep.webtransport, { certificateHashes: ep.certificateHashes });
};

/** Rungs this runtime can try (socket rungs only where the runtime has them, or a dialer is given). */
export function runtimeRungs(dialer?: SocketDialer): CarrierRung[] {
  return CARRIER_LADDER.filter((r) => !isSocketRung(r) || Boolean(dialer)
    || (r === 'wss' && typeof WebSocket !== 'undefined')
    || (r === 'webtransport' && typeof (globalThis as { WebTransport?: unknown }).WebTransport !== 'undefined'));
}

export interface TunnelStats {
  rung: CarrierRung;
  cursor: number;
  framesIn: number;
  framesOut: number;
  bytesIn: number;
  bytesOut: number;
  /** HTTP requests made — the stream rung needs one per connection, not per message. */
  httpRequests: number;
  reconnects: number;
  stepDowns: Array<{ from: CarrierRung; to: CarrierRung; reason: string; at: string }>;
}

export interface HttpsTunnelOptions {
  /** Relay base URL, e.g. https://relay.example.com/cpz1 */
  endpoint: string;
  ticket: string;
  fetchImpl?: FetchLike;
  /** Start on this rung (default: the first of `rungs`). */
  rung?: CarrierRung;
  /** The rungs the node offered, fastest first (default: the HTTPS rungs). */
  rungs?: CarrierRung[];
  /** Socket carrier URLs from the node's offer. */
  endpoints?: CarrierEndpoints;
  dialSocket?: SocketDialer;
  /** No first byte within this window = a buffering proxy → step down. */
  firstByteTimeoutMs?: number;
  pollWaitMs?: number;
  /** Streams that end this fast, this many times in a row, step down too. */
  shortStreamMs?: number;
  shortStreamLimit?: number;
  onFrame: (frame: WireFrame) => void;
  onRung?: (rung: CarrierRung, reason: string) => void;
  onError?: (message: string) => void;
}

export interface HttpsTunnel {
  readonly rung: CarrierRung;
  send(command: FrameCommand, value: unknown): Promise<void>;
  sendBytes(frame: Uint8Array): void;
  stats(): TunnelStats;
  close(): Promise<void>;
}

const url = (base: string, path: string, params: Record<string, string | number>) => {
  const u = new URL(`${base.replace(/\/+$/, '')}/${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return u.toString();
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function openHttpsTunnel(opts: HttpsTunnelOptions): HttpsTunnel {
  const doFetch: FetchLike = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  const firstByteMs = opts.firstByteTimeoutMs ?? 5_000;
  const pollWait = opts.pollWaitMs ?? 20_000;
  const shortMs = opts.shortStreamMs ?? 1_000;
  const shortLimit = opts.shortStreamLimit ?? 3;
  const auth = { Authorization: `Bearer ${opts.ticket}` };
  const ladder = (opts.rungs?.length ? opts.rungs : ['https-stream', 'https-poll'] as CarrierRung[]).filter((r) => CARRIER_LADDER.includes(r));
  const dial = opts.dialSocket ?? defaultSocketDialer;
  let socketWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  const stats: TunnelStats = { rung: opts.rung ?? ladder[0], cursor: 0, framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0, httpRequests: 0, reconnects: 0, stepDowns: [] };
  let closed = false;
  let outbox: Uint8Array[] = [];
  let flushing: Promise<void> | null = null;
  let current: { cancel: () => void } | null = null;
  let shortStreams = 0;

  const stepDown = (reason: string) => {
    const i = ladder.indexOf(stats.rung);
    const next = ladder[i + 1];
    if (!next) return;
    stats.stepDowns.push({ from: stats.rung, to: next, reason, at: new Date().toISOString() });
    stats.rung = next;
    opts.onRung?.(next, reason);
  };

  const deliver = (frames: WireFrame[]) => {
    for (const f of frames) {
      if (f.command === 'pong') {
        const c = Number(decodeJsonFrame<{ cursor?: number }>(f).cursor);
        if (Number.isFinite(c) && c > stats.cursor) stats.cursor = c;
        continue;
      }
      stats.framesIn++;
      opts.onFrame(f);
    }
  };

  async function streamOnce(): Promise<void> {
    const ctl = new AbortController();
    const started = Date.now();
    let gotFirst = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const cancel = () => { ctl.abort(); void reader?.cancel().catch(() => {}); };
    current = { cancel };
    const timer = setTimeout(() => { if (!gotFirst && !closed) { stepDown(`no first byte in ${firstByteMs} ms — a proxy is buffering chunked responses`); cancel(); } }, firstByteMs);
    try {
      stats.httpRequests++;
      const res = await doFetch(url(opts.endpoint, 'stream', { cursor: stats.cursor }), { signal: ctl.signal, cache: 'no-store', headers: auth });
      if (res.status === 401) throw new Error('ticket rejected — rendezvous again');
      if (!res.ok || !res.body) throw new Error(`stream HTTP ${res.status}`);
      reader = res.body.getReader();
      const decoder = new FrameDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        gotFirst = true;
        stats.bytesIn += value.length;
        deliver(await decoder.feed(value));
      }
    } finally {
      clearTimeout(timer);
      current = null;
    }
    // Stream ended (proxy idle cut, node rotation): resume from the cursor.
    if (!closed && stats.rung === 'https-stream') {
      stats.reconnects++;
      shortStreams = Date.now() - started < shortMs ? shortStreams + 1 : 0;
      if (shortStreams >= shortLimit) stepDown(`${shortLimit} streams closed within ${shortMs} ms — the proxy is cutting long responses`);
    }
  }

  async function pollOnce(): Promise<void> {
    const ctl = new AbortController();
    current = { cancel: () => ctl.abort() };
    try {
      stats.httpRequests++;
      const res = await doFetch(url(opts.endpoint, 'poll', { cursor: stats.cursor, wait: pollWait }), { signal: ctl.signal, cache: 'no-store', headers: auth });
      if (res.status === 401) throw new Error('ticket rejected — rendezvous again');
      if (!res.ok) throw new Error(`poll HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      stats.bytesIn += bytes.length;
      deliver(await new FrameDecoder().feed(bytes));
    } finally {
      current = null;
    }
  }

  /**
   * A socket carrier (WebTransport or WebSocket): one connection carries
   * frames both ways. The ticket goes in the first frame (`auth`), never in
   * the URL. Failing to open, or no first frame in time, steps down.
   */
  async function socketOnce(rung: SocketRung): Promise<void> {
    const started = Date.now();
    let duplex: ByteDuplex;
    try {
      duplex = await dial(rung, opts.endpoints ?? {});
    } catch (e) {
      if (!closed) stepDown(`${RUNG_LABEL[rung]} unavailable: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    stats.httpRequests++; // one connection, counted like a request
    const reader = duplex.readable.getReader();
    const writer = duplex.writable.getWriter();
    let gotFirst = false;
    current = { cancel: () => { void reader.cancel().catch(() => {}); duplex.close(); } };
    const timer = setTimeout(() => { if (!gotFirst && !closed) { stepDown(`no first frame over ${RUNG_LABEL[rung]} in ${firstByteMs} ms`); current?.cancel(); } }, firstByteMs);
    try {
      await writer.write(await encodeJsonFrame('auth', { ticket: opts.ticket, cursor: stats.cursor }));
      socketWriter = writer;
      kick(); // frames queued before the socket opened go over it now
      const decoder = new FrameDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        gotFirst = true;
        stats.bytesIn += value.length;
        const frames = await decoder.feed(value);
        const bye = frames.find((f) => f.command === 'bye');
        deliver(frames.filter((f) => f.command !== 'bye'));
        if (bye) {
          const reason = String(decodeJsonFrame<{ reason?: string }>(bye).reason ?? '');
          if (/ticket/.test(reason)) throw new Error('ticket rejected — rendezvous again');
          break;
        }
      }
    } finally {
      clearTimeout(timer);
      socketWriter = null;
      current = null;
      try { reader.releaseLock(); writer.releaseLock(); } catch { /* released */ }
      duplex.close();
    }
    if (!closed && stats.rung === rung) {
      stats.reconnects++;
      shortStreams = Date.now() - started < shortMs ? shortStreams + 1 : 0;
      if (shortStreams >= shortLimit) stepDown(`${shortLimit} ${RUNG_LABEL[rung]} connections closed within ${shortMs} ms`);
    }
  }

  const loop = (async () => {
    let backoff = 250;
    while (!closed) {
      try {
        const rung = stats.rung;
        if (isSocketRung(rung)) await socketOnce(rung);
        else if (rung === 'https-stream') await streamOnce(); else await pollOnce();
        backoff = 250;
      } catch (e) {
        if (closed) break;
        const message = e instanceof Error ? e.message : String(e);
        if (!/abort/i.test(message)) opts.onError?.(message);
        if (/ticket rejected/.test(message)) { closed = true; break; }
        await delay(backoff);
        backoff = Math.min(backoff * 2, 10_000);
      }
    }
  })();

  async function flush(): Promise<void> {
    while (outbox.length && !closed) {
      const parts = outbox;
      outbox = [];
      const batch = concat(parts);
      try {
        if (socketWriter) {
          await socketWriter.write(batch); // on a socket rung frames go up the same connection
        } else {
          stats.httpRequests++;
          const res = await doFetch(url(opts.endpoint, 'up', {}), { method: 'POST', body: batch as unknown as BodyInit, headers: { ...auth, 'Content-Type': 'application/octet-stream' } });
          if (!res.ok) throw new Error(`up HTTP ${res.status}: ${await res.text().catch(() => '')}`);
        }
        stats.framesOut += parts.length;
        stats.bytesOut += batch.length;
      } catch (e) {
        outbox = [...parts, ...outbox]; // nothing is dropped; retried on the next tick
        opts.onError?.(e instanceof Error ? e.message : String(e));
        throw e;
      }
    }
  }

  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const kick = () => {
    if (flushing || closed) return;
    // One POST per tick: frames queued in the same tick share a request.
    flushing = Promise.resolve().then(flush)
      .catch(() => { retryTimer ??= setTimeout(() => { retryTimer = null; kick(); }, 1_000); })
      .finally(() => { flushing = null; if (outbox.length && !retryTimer) kick(); });
  };
  const sendBytes = (frame: Uint8Array) => { outbox.push(frame); kick(); };

  return {
    get rung() { return stats.rung; },
    send: async (command, value) => { sendBytes(await encodeJsonFrame(command, value)); },
    sendBytes: (frame) => { if (frame.length) sendBytes(frame); },
    stats: () => ({ ...stats, stepDowns: [...stats.stepDowns] }),
    close: async () => {
      if (closed) return;
      await flushing?.catch(() => {});
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      current?.cancel();
      await loop.catch(() => {});
      try { await doFetch(url(opts.endpoint, 'close', {}), { method: 'POST', headers: auth }); } catch { /* best effort */ }
    },
  };
}

export interface ConnectOptions {
  endpoint: string;
  walletAddress: string;
  copyId: string;
  channelId: string;
  bid?: SyncPrice;
  expectedBytes?: number;
  hello?: TransportHello;
  /** Sign a fresh hello with this key when no hello is given (nodes verify it). */
  signingKey?: SigningKey;
  /** Head txIds this copy holds, carried in the signed hello. */
  heads?: string[];
  /** The wallet's signed declaration of signingKey (helloKeyDeclaration.ts); lets nodes bind the key. */
  keyDeclaration?: HelloKeyDeclaration;
  /** Rungs to offer (default: what this runtime can do). */
  rungs?: CarrierRung[];
  /** Opens socket carriers; tests and demos pass an in-process dialer. */
  dialSocket?: SocketDialer;
  /** Give up on an endpoint that does not answer the bid/ask in this long (default 5 s), so the next path is tried. */
  rendezvousTimeoutMs?: number;
  fetchImpl?: FetchLike;
}

/**
 * TX bid/ask rendezvous: the copy sends ReplicaConnectRequested to the node,
 * the node decides (ReplicaConnectOffered with a ticket, or Rejected).
 * The node records both on its log; the caller records its own copies.
 */
export async function requestReplicaConnect(o: ConnectOptions): Promise<{ request: RendezvousRequest; decision: RendezvousDecision }> {
  const doFetch: FetchLike = o.fetchImpl ?? ((i, init) => fetch(i, init));
  const sentAt = new Date().toISOString();
  const hello = o.hello ?? (o.signingKey
    ? { ...(await signHello({ walletAddress: o.walletAddress, copyId: o.copyId, heads: o.heads ?? [], transports: ['https'], discovery: ['relay-rendezvous'], sentAt }, o.signingKey)), ...(o.keyDeclaration ? { keyDeclaration: o.keyDeclaration } : {}) }
    : undefined);
  const request: RendezvousRequest = {
    requestId: `rq-${crypto.randomUUID()}`, walletAddress: o.walletAddress, copyId: o.copyId, channelId: o.channelId,
    rungs: o.rungs ?? runtimeRungs(o.dialSocket), bid: o.bid, expectedBytes: o.expectedBytes, hello, sentAt,
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.rendezvousTimeoutMs ?? 5_000);
  let res: Response;
  try {
    res = await doFetch(`${o.endpoint.replace(/\/+$/, '')}/rendezvous`, { method: 'POST', body: JSON.stringify(request), headers: { 'Content-Type': 'application/json' }, signal: ctl.signal });
  } catch (e) {
    throw new Error(ctl.signal.aborted ? `no answer from ${o.endpoint} in ${o.rendezvousTimeoutMs ?? 5_000} ms` : `cannot reach ${o.endpoint}: ${e instanceof Error ? e.message : String(e)}`);
  } finally { clearTimeout(timer); }
  if (!res.ok) throw new Error(`rendezvous HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  return { request, decision: await res.json() as RendezvousDecision };
}

/** Rendezvous then open the tunnel; throws with the node's reason when rejected. */
export async function connectThroughFirewall(o: ConnectOptions & Omit<HttpsTunnelOptions, 'endpoint' | 'ticket' | 'fetchImpl' | 'rungs' | 'endpoints'>) {
  const { request, decision } = await requestReplicaConnect(o);
  if (decision.eventType !== 'ReplicaConnectOffered') throw new Error(`connect rejected: ${decision.reason}`);
  // Start at the fastest rung both sides have; the tunnel steps down from there.
  const tunnel = openHttpsTunnel({ ...o, endpoint: o.endpoint, ticket: decision.ticket, fetchImpl: o.fetchImpl, rungs: decision.rungs, endpoints: decision.endpoints, rung: decision.rungs[0] });
  return { request, decision, tunnel };
}

/** Wrap a fetch handler (relay.handle) as an in-process fetch — demos and tests. */
export function inProcessFetch(handle: (req: Request) => Promise<Response>): FetchLike {
  return (input, init) => {
    const req = new Request(input, init);
    const signal = init?.signal;
    if (!signal) return handle(req);
    if (signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
    // Like a network fetch, an abort rejects the pending request at once.
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => reject(new DOMException('aborted', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });
      handle(req).then((r) => { signal.removeEventListener('abort', onAbort); resolve(r); }, reject);
    });
  };
}
