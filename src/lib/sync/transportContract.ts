/**
 * COPE node crystallized.
 * Node ID: v12-23-03-transport-contract-v2
 * Provenance: m/44'/144'/100'/principles/cope/v1
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Transport contract v2. The v1 SyncTransport (available/carry) stays for
 * the existing engine; EdgeTransport adds connection lifecycle, frame
 * streaming, and the signed capability hello every connection opens with.
 * Transports are declared per node by TransportCapabilityDeclared TXs on
 * the node's POW (AX-73 — no static registry); this file only holds the
 * shape, never a list of implementations.
 */

import type { SealedFrame } from './a2aSecureChannel';
import type { SyncTransport } from './syncTransport';
import type { WireFrame } from './frameCodec';
import type { HelloKeyDeclaration } from './helloKeyDeclaration';

export type EdgeTransportKind =
  | 'direct' | 'relay' | 'store-forward' // v1 kinds (unchanged)
  | 'tcp' | 'quic' | 'bundle' | 'websocket'
  | 'https'; // v15-03-00 relay ladder (transports/httpsTunnel.ts): WebTransport, WebSocket, HTTPS stream, long-poll
// v15-04-00: 'webrtc' removed — it was declared but never implemented; the relay ladder is how a browser reaches peers.

export type DiscoveryMethod = 'udp-beacon' | 'relay-rendezvous' | 'pairing-code' | 'wallet-breadcrumbs';

/** Signed hello sent as the first frame on every connection. */
export interface TransportHello {
  walletAddress: string;
  copyId: string;
  /** Head txIds this copy holds (inventory gossip seed). */
  heads: string[];
  transports: EdgeTransportKind[];
  discovery: DiscoveryMethod[];
  /** ed25519 signature over sha256(canonical JSON of the fields above). */
  signature: string;
  publicKey: string;
  sentAt: string;
  /**
   * v15-04-00 — the wallet's own signed statement that publicKey speaks for
   * it (secp256k1, wallet key). Outside the hello signature: it carries its own.
   */
  keyDeclaration?: HelloKeyDeclaration;
}

export interface EdgeTransport {
  kind: EdgeTransportKind;
  available(): boolean;
  /** Open a connection; resolves after the hello/hello-ack handshake. */
  open?(remoteHello?: TransportHello): Promise<TransportHello>;
  /** Stream raw wire frames both ways until closed. */
  stream?(): {
    send(frame: WireFrame): Promise<void>;
    receive(): AsyncIterable<WireFrame>;
  };
  /** v1-compatible single-frame carry for the existing sync engine. */
  carry(frame: SealedFrame): Promise<{ frame: SealedFrame; blobKey?: string }>;
  release?(blobKey: string): Promise<void>;
  close?(): Promise<void> | void;
}

/** Wrap a v1 SyncTransport so old transports satisfy the v2 contract. */
export function asEdgeTransport(t: SyncTransport, kind: EdgeTransportKind = t.kind): EdgeTransport {
  return {
    kind,
    available: () => t.available(),
    carry: (frame) => t.carry(frame),
    release: t.release?.bind(t),
  };
}

/** Canonical JSON for hello signing — stable key order, no whitespace. */
export function canonicalHelloJson(hello: Omit<TransportHello, 'signature'>): string {
  return JSON.stringify({
    copyId: hello.copyId,
    discovery: [...hello.discovery].sort(),
    heads: [...hello.heads].sort(),
    publicKey: hello.publicKey,
    sentAt: hello.sentAt,
    transports: [...hello.transports].sort(),
    walletAddress: hello.walletAddress,
  });
}
