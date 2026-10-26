/**
 * COPE node crystallized.
 * Node ID: v12-23-03-edge-node-bridge
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * WebSocket bridge: the browser app connects to a local edge node over
 * ws://127.0.0.1 and rides the node's TCP/UDP sockets. Frames pass through
 * unchanged — the bridge is a pipe, not a proxy with its own state.
 *
 * v15-03-00: the browser opens the same signed-hello session as a TCP peer
 * (Ed25519-verified), then runs inventory gossip (peers.ts).
 */

import { openEdgeSession, type ByteDuplex, type EdgePeerSession, type EdgeSessionOptions } from '../../src/lib/sync/edgeSession.ts';
import type { TransportHello } from '../../src/lib/sync/transportContract.ts';

/** Binary WebSocket messages as a byte duplex. */
function socketDuplex(socket: WebSocket): ByteDuplex {
  socket.binaryType = 'arraybuffer';
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      socket.onmessage = (e) => { if (typeof e.data !== 'string') controller.enqueue(new Uint8Array(e.data as ArrayBuffer)); };
      socket.onclose = () => { try { controller.close(); } catch { /* already closed */ } };
      socket.onerror = () => { try { controller.error(new Error('websocket error')); } catch { /* already closed */ } };
    },
  });
  const writable = new WritableStream<Uint8Array>({ write(chunk) { socket.send(chunk); } });
  return { readable, writable, close: () => { try { socket.close(); } catch { /* already closed */ } } };
}

export async function serveBrowserBridge(
  port: number,
  hello: () => Promise<TransportHello>,
  onSession: (s: EdgePeerSession) => Promise<void>,
  opts: EdgeSessionOptions = {},
): Promise<void> {
  Deno.serve({ port, hostname: '127.0.0.1' }, (req) => {
    if (req.headers.get('upgrade') !== 'websocket') {
      return new Response('cappz edge node bridge — websocket only', { status: 426 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onopen = () => {
      (async () => {
        const session = await openEdgeSession(socketDuplex(socket), await hello(), opts);
        await onSession(session);
      })().catch((err) => {
        console.warn('[edge-node] bridge peer dropped:', err?.message ?? err);
        try { socket.close(4000, String(err?.message ?? err).slice(0, 120)); } catch { /* already closed */ }
      });
    };
    return response;
  });
}
