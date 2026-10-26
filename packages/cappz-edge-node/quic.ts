/**
 * COPE node crystallized.
 * Node ID: v12-23-04-edge-node-quic
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * QUIC peer sessions (UDP-based, reliable, encrypted, NAT-friendly). Same
 * CPZ1 frames and signed hello as TCP via the shared edge session. TLS uses
 * a node-local self-signed cert; trust comes from the signed wallet hello.
 * Requires: deno run --unstable-net
 *
 * v15-04-00: Deno 2.x replaced Deno.listenQuic with Deno.QuicEndpoint; the
 * node used the old call, so QUIC peering was silently off. It now uses the
 * endpoint API (and Deno.connectQuic to dial).
 *
 * v15-10-00: the listener follows TLS rotation (stop, listen again on the
 * same endpoint with the new certificate). Deno 2.5's connectQuic has no
 * unsafelyTrustAnyCertificate (it was silently ignored, so a dial to a
 * self-signed peer failed with UnknownIssuer); dialQuic pins the peer's own
 * certificate through caCerts (served at <relay>/cpz1/tls). Trust still comes
 * from the signed hello; the pin only gets TLS up.
 */

import { openEdgeSession, type EdgePeerSession, type EdgeSessionOptions } from '../../src/lib/sync/edgeSession.ts';
import type { TransportHello } from '../../src/lib/sync/transportContract.ts';
import type { TlsHandle } from './tlsIdentity.ts';

// deno-lint-ignore no-explicit-any
const D = Deno as any;

export function quicAvailable(): boolean {
  return typeof D.QuicEndpoint === 'function' && typeof D.connectQuic === 'function';
}

export async function serveQuic(
  port: number,
  tls: TlsHandle,
  hello: () => Promise<TransportHello>,
  onSession: (s: EdgePeerSession) => Promise<void> | void,
  opts: EdgeSessionOptions = {},
): Promise<void> {
  if (!quicAvailable()) {
    console.warn('[edge-node] QUIC unavailable on this runtime (need --unstable-net); TCP stays active');
    return;
  }
  const endpoint = new D.QuicEndpoint({ hostname: '0.0.0.0', port });
  const listen = () => endpoint.listen({ cert: tls.current().cert, key: tls.current().key, alpnProtocols: ['cpz1'] });
  let listener = listen();
  tls.onRotate(() => { listener.stop(); listener = listen(); }, 'quic'); // stop, then listen again: the order verified on Deno 2.5
  for (;;) {
    let conn;
    try { conn = await listener.accept(); } catch { continue; } // the listener was stopped for a rotation
    (async () => {
      for await (const stream of conn.incomingBidirectionalStreams) {
        const session = await openEdgeSession({ ...stream, close: () => conn.close() }, await hello(), opts);
        void onSession(session);
      }
    })().catch((err) => console.warn('[edge-node] quic peer dropped:', err?.message ?? err));
  }
}

/** peerCertificatePem: the peer's own (self-signed) certificate, pinned as its CA; without it only CA-issued certificates connect. */
export async function dialQuic(host: string, port: number, hello: TransportHello, opts: EdgeSessionOptions = {}, peerCertificatePem?: string): Promise<EdgePeerSession> {
  if (!quicAvailable()) throw new Error('QUIC unavailable — fall back to tcp');
  // Trust comes from the verified signed hello; the pinned certificate only gets TLS up.
  const conn = await D.connectQuic({ hostname: host, port, alpnProtocols: ['cpz1'], ...(peerCertificatePem ? { caCerts: [peerCertificatePem] } : {}) });
  const stream = await conn.createBidirectionalStream();
  return openEdgeSession({ ...stream, close: () => conn.close() }, hello, opts);
}
