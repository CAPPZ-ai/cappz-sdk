/**
 * COPE node crystallized.
 * Node ID: v12-23-04-edge-node-tcp
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * TCP peer sessions over the shared CPZ1 frame codec. Bitcoin-inspired:
 * version hello, inventory gossip, headers-first, pull bodies — without
 * Bitcoin's wire format or proof-of-work. Session logic is shared with QUIC
 * via src/lib/sync/edgeSession.ts.
 *
 * v15-03-00: every inbound connection opens the signed-hello session
 * (Ed25519-verified) and then runs inventory gossip (peers.ts); it used to
 * answer ping only.
 */

import { openEdgeSession, type EdgePeerSession, type EdgeSessionOptions } from '../../src/lib/sync/edgeSession.ts';
import type { TransportHello } from '../../src/lib/sync/transportContract.ts';

export async function serveTcp(
  port: number,
  hello: () => Promise<TransportHello>,
  onSession: (s: EdgePeerSession) => Promise<void>,
  opts: EdgeSessionOptions = {},
): Promise<void> {
  const listener = Deno.listen({ port, transport: 'tcp' });
  for await (const conn of listener) {
    (async () => {
      const session = await openEdgeSession({ readable: conn.readable, writable: conn.writable, close: () => conn.close() }, await hello(), opts);
      await onSession(session);
    })().catch((err) => {
      console.warn('[edge-node] peer dropped:', err?.message ?? err);
      try { conn.close(); } catch { /* already closed */ }
    });
  }
}

export async function dialTcp(host: string, port: number, hello: TransportHello, opts: EdgeSessionOptions = {}): Promise<EdgePeerSession> {
  const conn = await Deno.connect({ hostname: host, port, transport: 'tcp' });
  return openEdgeSession({ readable: conn.readable, writable: conn.writable, close: () => conn.close() }, hello, opts);
}
