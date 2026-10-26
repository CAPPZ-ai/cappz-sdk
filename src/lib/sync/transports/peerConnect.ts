/**
 * COPE node crystallized.
 * Node ID: v15-05-00-peer-connect
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Connect to a peer copy by name, not by relay. The caller's own member
 * table (endpointDirectory.ts) says where the peer accepts connections; the
 * paths are tried best first — same LAN, the peer's public endpoint, then a
 * relay only if neither answers. Every path speaks the same protocol (TX
 * bid/ask, then the carrier ladder), because a reachable copy serves the
 * relay protocol itself: dialing it directly IS the source answering for
 * itself. A source's offer carries its own endpoint record, which the
 * caller adds to its table (onEndpoint).
 */

import { connectThroughFirewall, type ConnectOptions, type FetchLike, type HttpsTunnelOptions, type SocketDialer } from './httpsTunnel.ts';
import { resolvePeerPaths, type DirectoryEntry, type EndpointRecord, type PeerPath } from '../endpointDirectory.ts';

export interface PeerConnectOptions extends Omit<ConnectOptions, 'endpoint' | 'fetchImpl' | 'dialSocket'>, Omit<HttpsTunnelOptions, 'endpoint' | 'ticket' | 'fetchImpl' | 'rungs' | 'endpoints' | 'dialSocket'> {
  directory: DirectoryEntry[];
  peerCopyId: string;
  /** LANs this device is on (matched against the peer's LAN endpoints). */
  lanIds?: string[];
  /** Relay nodes to fall back to, in order. */
  relays?: string[];
  /** How to reach a URL from here (tests and demos simulate networks; default: fetch). */
  fetchFor?: (url: string) => FetchLike | undefined;
  dialFor?: (url: string) => SocketDialer | undefined;
  /** A source answered for itself: its record, for the caller's member table. */
  onEndpoint?: (record: EndpointRecord) => void;
  /** Called for each path that failed, before the next is tried. */
  onPathFailed?: (path: PeerPath, reason: string) => void;
}

export async function connectToPeer(o: PeerConnectOptions) {
  const paths = resolvePeerPaths(o.directory, o.peerCopyId, { lanIds: o.lanIds, relays: o.relays });
  if (!paths.length) throw new Error(`no path to ${o.peerCopyId}: it has no endpoint in the member table and no relay is configured`);
  const failures: string[] = [];
  for (const path of paths) {
    try {
      const r = await connectThroughFirewall({ ...o, endpoint: path.url, fetchImpl: o.fetchFor?.(path.url), dialSocket: o.dialFor?.(path.url) });
      if (r.decision.eventType === 'ReplicaConnectOffered' && r.decision.endpoint) o.onEndpoint?.(r.decision.endpoint);
      return { ...r, path };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      failures.push(`${path.kind} ${path.url}: ${reason}`);
      o.onPathFailed?.(path, reason);
    }
  }
  throw new Error(`could not reach ${o.peerCopyId}: ${failures.join('; ')}`);
}
