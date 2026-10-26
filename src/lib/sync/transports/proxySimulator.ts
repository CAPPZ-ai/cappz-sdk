/**
 * COPE node crystallized.
 * Node ID: v15-03-00-proxy-simulator
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * A stand-in for the corporate network between a copy and its relay, so
 * the demo and tests can show the carrier ladder react to real proxy
 * behaviour without leaving the browser:
 *   - bufferChunked: the proxy holds a response until it is complete
 *     (TLS-inspecting proxies often do this to chunked bodies), so a
 *     live stream never shows a first byte.
 *   - idleTimeoutMs: the proxy cuts a response that stays silent too long.
 *   - maxResponseMs: the proxy cuts any response after this long.
 *   - blockMulticast: what every bank network does to UDP discovery.
 *   - blockUdp / blockWebSocket (v15-04-00): corporate egress usually drops
 *     outbound UDP (no WebTransport) and inspecting proxies often refuse
 *     the WebSocket upgrade.
 * It wraps any fetch, and dials sockets in-process; nothing here is a network endpoint.
 */

import type { FetchLike, SocketDialer } from './httpsTunnel.ts';
import type { HttpsRelay } from './httpsRelay.ts';
import { memoryDuplexPair } from '../edgeSession.ts';

export interface ProxyProfile {
  name: string;
  bufferChunked: boolean;
  idleTimeoutMs?: number;
  maxResponseMs?: number;
  blockMulticast: boolean;
  blockUdp?: boolean;
  blockWebSocket?: boolean;
}

export const PROXY_PROFILES: Record<'open' | 'reverse-proxy' | 'bank-inspecting', ProxyProfile> = {
  open: { name: 'No proxy (home network)', bufferChunked: false, blockMulticast: false },
  'reverse-proxy': { name: 'Reverse proxy, 60 s idle timeout', bufferChunked: false, idleTimeoutMs: 60_000, maxResponseMs: 5 * 60_000, blockMulticast: true, blockUdp: true },
  'bank-inspecting': { name: 'Bank TLS-inspecting proxy (buffers chunked bodies)', bufferChunked: true, idleTimeoutMs: 30_000, blockMulticast: true, blockUdp: true, blockWebSocket: true },
};

export interface ProxyCounters { requests: number; cutIdle: number; cutMax: number; buffered: number }

export function proxiedFetch(inner: FetchLike, profile: () => ProxyProfile, counters?: ProxyCounters): FetchLike {
  return async (input, init) => {
    if (counters) counters.requests++;
    const p = profile();
    const res = await inner(input, init);
    if (!res.body) return res;
    const streaming = res.headers.get('X-Cappz-Rung') === 'https-stream';
    if (p.bufferChunked && streaming) {
      if (counters) counters.buffered++;
      // Hold the whole body before answering — an endless stream never answers.
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { void reader.cancel().catch(() => {}); reject(new DOMException('aborted', 'AbortError')); };
        init?.signal?.addEventListener('abort', onAbort, { once: true });
        (async () => {
          for (;;) { const { value, done } = await reader.read(); if (done) break; chunks.push(value); }
          init?.signal?.removeEventListener('abort', onAbort);
          resolve();
        })().catch(reject);
      });
      return new Response(new Blob(chunks as BlobPart[]), { status: res.status, headers: res.headers });
    }
    if (!p.idleTimeoutMs && !p.maxResponseMs) return res;
    const reader = res.body.getReader();
    const started = Date.now();
    let idle: ReturnType<typeof setTimeout> | null = null;
    let max: ReturnType<typeof setTimeout> | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const cut = (why: 'idle' | 'max') => {
          if (counters) counters[why === 'idle' ? 'cutIdle' : 'cutMax']++;
          if (idle) clearTimeout(idle);
          if (max) clearTimeout(max);
          void reader.cancel().catch(() => {});
          try { controller.close(); } catch { /* already closed */ }
        };
        const armIdle = () => { if (!p.idleTimeoutMs) return; if (idle) clearTimeout(idle); idle = setTimeout(() => cut('idle'), p.idleTimeoutMs); };
        if (p.maxResponseMs) max = setTimeout(() => cut('max'), Math.max(0, p.maxResponseMs - (Date.now() - started)));
        armIdle();
        (async () => {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            armIdle();
            controller.enqueue(value);
          }
          if (idle) clearTimeout(idle);
          if (max) clearTimeout(max);
          try { controller.close(); } catch { /* cut already */ }
        })().catch(() => { try { controller.close(); } catch { /* closed */ } });
      },
      cancel() { if (idle) clearTimeout(idle); if (max) clearTimeout(max); void reader.cancel().catch(() => {}); },
    });
    return new Response(body, { status: res.status, headers: res.headers });
  };
}

/**
 * v15-04-00 — dial socket carriers straight into an in-process relay, behind
 * a simulated network: WebTransport fails where UDP is blocked, WebSocket
 * where the proxy refuses the upgrade (as a real dial would, quickly).
 */
export function proxiedSocketDialer(relay: () => HttpsRelay | null, profile: () => ProxyProfile, counters?: ProxyCounters): SocketDialer {
  return async (rung) => {
    if (counters) counters.requests++;
    const p = profile();
    if (rung === 'webtransport' && p.blockUdp) throw new Error('UDP is blocked on this network');
    if (rung === 'wss' && p.blockWebSocket) throw new Error('the proxy refused the WebSocket upgrade');
    const r = relay();
    if (!r) throw new Error('no relay');
    const [client, server] = memoryDuplexPair();
    void r.attach(server, rung);
    return client;
  };
}
