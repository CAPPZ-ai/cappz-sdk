/**
 * COPE node crystallized.
 * Node ID: v15-04-00-socket-duplex
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * WebSocket and WebTransport as the same byte duplex the edge session and
 * the relay already speak (edgeSession.ts ByteDuplex). Runs in browsers,
 * Deno (client and server side) and Node 22+.
 */

import type { ByteDuplex } from '../edgeSession.ts';

/** Binary WebSocket messages as a byte duplex. Call once the socket exists (open or opening). */
export function webSocketDuplex(socket: WebSocket): ByteDuplex {
  socket.binaryType = 'arraybuffer';
  let closed = false;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      socket.addEventListener('message', (e) => { if (typeof e.data !== 'string') controller.enqueue(new Uint8Array(e.data as ArrayBuffer)); });
      socket.addEventListener('close', () => { closed = true; try { controller.close(); } catch { /* already closed */ } });
      socket.addEventListener('error', () => { try { controller.error(new Error('websocket error')); } catch { /* already closed */ } });
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write(chunk) { if (closed) throw new Error('websocket closed'); socket.send(chunk as unknown as BufferSource); },
  });
  return { readable, writable, close: () => { try { socket.close(); } catch { /* already closed */ } } };
}

/** Open a WebSocket and resolve once it is open; rejects on error, close or timeout first. */
export function dialWebSocket(url: string, timeoutMs = 4_000): Promise<ByteDuplex> {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket === 'undefined') { reject(new Error('WebSocket unavailable in this runtime')); return; }
    let socket: WebSocket;
    try { socket = new WebSocket(url); } catch (e) { reject(e); return; }
    const duplex = webSocketDuplex(socket);
    const timer = setTimeout(() => { duplex.close(); reject(new Error(`websocket did not open in ${timeoutMs} ms`)); }, timeoutMs);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(duplex); }, { once: true });
    socket.addEventListener('close', () => { clearTimeout(timer); reject(new Error('websocket refused (the proxy may block the upgrade)')); }, { once: true });
  });
}

export interface WebTransportDialOptions {
  /** sha-256 of a self-signed certificate (hex), for nodes without a public cert. */
  certificateHashes?: string[];
  timeoutMs?: number;
}

/** Open a WebTransport session and one bidirectional stream as a byte duplex. */
export async function dialWebTransport(url: string, opts: WebTransportDialOptions = {}): Promise<ByteDuplex> {
  const WT = (globalThis as { WebTransport?: new (url: string, init?: unknown) => WebTransportLike }).WebTransport;
  if (!WT) throw new Error('WebTransport unavailable in this runtime');
  const hashes = (opts.certificateHashes ?? []).map((h) => ({ algorithm: 'sha-256', value: Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16)) }));
  const wt = new WT(url, hashes.length ? { serverCertificateHashes: hashes } : undefined);
  const timeoutMs = opts.timeoutMs ?? 4_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([wt.ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`webtransport did not open in ${timeoutMs} ms (UDP may be blocked)`)), timeoutMs); })]);
  } catch (e) {
    try { wt.close(); } catch { /* not open */ }
    throw e;
  } finally { clearTimeout(timer); }
  const stream = await wt.createBidirectionalStream();
  return { readable: stream.readable, writable: stream.writable, close: () => { try { wt.close(); } catch { /* already closed */ } } };
}

/** The slice of the WebTransport API used here (browsers, Deno). */
export interface WebTransportLike {
  ready: Promise<unknown>;
  closed?: Promise<unknown>;
  createBidirectionalStream(): Promise<{ readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }>;
  incomingBidirectionalStreams?: ReadableStream<{ readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }>;
  close(info?: unknown): void;
}
