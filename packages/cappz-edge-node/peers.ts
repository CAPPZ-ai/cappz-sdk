/**
 * COPE node crystallized.
 * Node ID: v15-03-00-edge-node-peers
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * What the node does with a verified peer session (TCP, QUIC, WS bridge,
 * or a dial after a heard beacon): inventory gossip and body pull over the
 * CPZ1 frames. It announces the ids it holds with `inv`, pulls the bodies it
 * lacks (each checked against its sha256 id) and serves the peer the same
 * way; heads, delivered and rejected bodies are recorded in
 * <CAPPZ_NODE_DATA>/peer-txs.jsonl. Bodies stay sealed; the node never opens them.
 */

import type { EdgePeerSession } from '../../src/lib/sync/edgeSession.ts';
import type { TransportHello } from '../../src/lib/sync/transportContract.ts';
import { signHello, type SigningKey } from '../../src/lib/sync/helloSignature.ts';
import { runBodyExchange, MAX_IDS_PER_FRAME, type BodyStore } from '../../src/lib/sync/edgeBodyPull.ts';

export interface NodeIdentity {
  powAddress: string;
  key: SigningKey | null;
  transports: TransportHello['transports'];
  dataDir: string;
  /** Content-addressed bodies this node holds (objects.ts). */
  store: BodyStore;
}

/** A fresh signed hello per connection, so it never goes stale. */
export async function nodeHello(id: NodeIdentity): Promise<TransportHello> {
  const body = {
    walletAddress: id.powAddress, copyId: `${id.powAddress}#node`, heads: (await id.store.list()).slice(0, MAX_IDS_PER_FRAME),
    transports: id.transports, discovery: ['udp-beacon', 'pairing-code', 'relay-rendezvous'] as TransportHello['discovery'],
    sentAt: new Date().toISOString(),
  };
  if (!id.key) throw new Error('node has no key: set CAPPZ_NODE_KEY / CAPPZ_NODE_PUB to sign its hello');
  return signHello(body, id.key);
}

/**
 * v15-04-00: a verified session gossips heads AND pulls bodies
 * (edgeBodyPull.ts): it asks for every announced id it lacks, checks each
 * body against its sha256 id, stores it, and serves the peer the same way.
 */
export async function runPeerSession(id: NodeIdentity, session: EdgePeerSession, via: string): Promise<void> {
  const peer = session.remoteHello;
  const log = `${id.dataDir}/peer-txs.jsonl`;
  const record = (eventType: string, data: Record<string, unknown>, step: string) => Deno.writeTextFile(log, JSON.stringify({
    txId: `peer-${crypto.randomUUID()}`, eventType, address: `${id.powAddress}/skills/cappz-replicator/peers/${peer.copyId}`,
    correlationId: peer.copyId, governingPrinciple: "m/44'/144'/100'/principles/cope/v1",
    bpmnSteps: [step], timestamp: new Date().toISOString(), data,
  }) + '\n', { append: true });
  console.log(`[edge-node] ${via} peer ${peer.walletAddress} (${session.helloCheck})`);
  await record('PeerHeadAnnounced', { copyId: peer.copyId, walletAddress: peer.walletAddress, heads: peer.heads, via, helloCheck: session.helloCheck }, 'AnnounceHead');
  try {
    const stats = await runBodyExchange(session, id.store, {
      onHeads: (heads) => { void record('PeerHeadAnnounced', { copyId: peer.copyId, walletAddress: peer.walletAddress, heads, via }, 'AnnounceHead'); },
      onBody: (contentHash, bytes) => { void record('SyncItemDelivered', { copyId: peer.copyId, contentHash, bytes, via }, 'ApplyRemoteBlocks'); },
      onReject: (contentHash, reason) => { void record('SyncItemRejected', { copyId: peer.copyId, contentHash, reason, via }, 'ApplyRemoteBlocks'); },
    });
    console.log(`[edge-node] ${via} peer ${peer.walletAddress}: received ${stats.received}, served ${stats.served}, rejected ${stats.rejected.length}`);
  } finally {
    session.close();
  }
}
