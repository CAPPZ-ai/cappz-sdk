/**
 * COPE node crystallized.
 * Node ID: v15-09-00-transport-types
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * One transport namespace. Each transport type is an MDM account at
 * cappz/config/transports/<id> (transportTypeAddress, paths.ts) — the
 * vocabulary of what a carrier IS, like the event-type registry. Which node
 * serves which type is still declared per node by TransportCapabilityDeclared
 * (AX-73: no static list of implementations), and a channel's configured
 * carrier cross-references its type by MDM address (ChannelConfig.transportType).
 *
 * Before v15-09-00 four lists overlapped: EdgeTransportKind (transportContract),
 * ChannelKind (middlewareChannels), CarrierRung (httpsRelay) and
 * DiscoveryMethod. They stay valid: every old name resolves here through
 * `aliases`, so stored configs and old peers keep working, and new records
 * carry the address instead of a name.
 */

import { transportTypeAddress } from '../wallets/paths.ts';

export type TransportLayer = 'discovery' | 'carrier' | 'bundle' | 'ledger' | 'legacy';

export interface TransportType {
  id: string;
  mdmAddress: string;
  layer: TransportLayer;
  description: string;
  /** Delivery guarantees of the carrier itself (frames are checksummed and deduped above it either way). */
  reliable: boolean;
  ordered: boolean;
  /** One send reaches a group (multicast) rather than one peer. */
  groupcast: boolean;
  /** A browser can open it (no raw sockets in browsers). */
  browserReachable: boolean;
  /** Crosses routers and corporate proxies (multicast does not). */
  crossesNetworks: boolean;
  /** Largest single datagram, where the carrier is datagram-based. */
  maxDatagramBytes?: number;
  /** Old names that mean this type (EdgeTransportKind, ChannelKind, CarrierRung, DiscoveryMethod). */
  aliases: readonly string[];
}

const T = (id: string, layer: TransportLayer, description: string, p: Omit<TransportType, 'id' | 'mdmAddress' | 'layer' | 'description' | 'aliases'>, aliases: string[] = []): TransportType =>
  ({ id, mdmAddress: transportTypeAddress(id), layer, description, ...p, aliases });

const LAN = { crossesNetworks: false, browserReachable: false };

export const TRANSPORT_TYPES: readonly TransportType[] = [
  T('udp-multicast', 'discovery', 'Signed UDP datagram to a multicast group: the LAN beacon and wallet-group connect requests', { reliable: false, ordered: false, groupcast: true, maxDatagramBytes: 1200, ...LAN }, ['udp-beacon']),
  T('udp-unicast', 'discovery', 'Signed UDP datagram to one peer: the answer to a connect request', { reliable: false, ordered: false, groupcast: false, maxDatagramBytes: 1200, ...LAN }),
  T('direct', 'carrier', 'Frames handed over in the same process or device (v1 direct transport)', { reliable: true, ordered: true, groupcast: false, browserReachable: true, crossesNetworks: false }),
  T('relay', 'carrier', 'Ciphertext forwarded by an intermediary node; the concrete carrier is one of the relay rungs below', { reliable: true, ordered: true, groupcast: false, browserReachable: true, crossesNetworks: true }, ['https']),
  T('store-forward', 'carrier', 'Frame parked encrypted to the receiver with a TTL, shredded on pickup', { reliable: true, ordered: false, groupcast: false, browserReachable: true, crossesNetworks: true }),
  T('tcp', 'carrier', 'CPZ1 frames over TCP between nodes', { reliable: true, ordered: true, groupcast: false, browserReachable: false, crossesNetworks: true }),
  T('quic', 'carrier', 'CPZ1 frames over QUIC (TLS 1.3, ALPN cpz1) between nodes', { reliable: true, ordered: true, groupcast: false, browserReachable: false, crossesNetworks: true }),
  T('webtransport', 'carrier', 'HTTP/3 WebTransport streams to a relay or node (browser-reachable QUIC)', { reliable: true, ordered: true, groupcast: false, browserReachable: true, crossesNetworks: true }),
  T('wss', 'carrier', 'WebSocket to a relay or node (TLS except on localhost bridges)', { reliable: true, ordered: true, groupcast: false, browserReachable: true, crossesNetworks: true }, ['websocket']),
  T('https-stream', 'carrier', 'Receiver-initiated HTTP/1.1 keep-alive chunked stream through proxies', { reliable: true, ordered: true, groupcast: false, browserReachable: true, crossesNetworks: true }),
  T('https-poll', 'carrier', 'HTTPS long-poll when an inspecting proxy buffers streams', { reliable: true, ordered: true, groupcast: false, browserReachable: true, crossesNetworks: true }),
  T('bundle', 'bundle', 'Signed air-gap bundle carried by hand or removable media', { reliable: true, ordered: true, groupcast: false, browserReachable: true, crossesNetworks: true }),
  T('pairing-code', 'discovery', 'Short-lived code exchanged by QR, voice or typing', { reliable: false, ordered: false, groupcast: false, browserReachable: true, crossesNetworks: true }),
  T('relay-rendezvous', 'discovery', 'TX bid/ask to a node that answers with a connect offer', { reliable: true, ordered: true, groupcast: false, browserReachable: true, crossesNetworks: true }),
  T('wallet-breadcrumbs', 'discovery', 'Endpoint records replicated in the member table', { reliable: true, ordered: true, groupcast: false, browserReachable: true, crossesNetworks: true }),
  T('chain-xrpl', 'ledger', 'Signals anchored on the XRP Ledger (memos), never payloads', { reliable: true, ordered: true, groupcast: true, browserReachable: true, crossesNetworks: true }, ['chain:xrpl']),
  T('chain-memory', 'ledger', 'In-memory chain for tests and demos', { reliable: true, ordered: true, groupcast: false, browserReachable: true, crossesNetworks: false }, ['chain:memory']),
  T('http-drop', 'legacy', 'Plain HTTP POST/PUT of a file into a DMZ node quarantine (legacy senders, curl, PHP clients)', { reliable: true, ordered: true, groupcast: false, browserReachable: true, crossesNetworks: true }),
  T('ftps', 'legacy', 'FTP over TLS pulled by the DMZ node into quarantine', { reliable: true, ordered: true, groupcast: false, browserReachable: false, crossesNetworks: true }, ['ftp']),
  T('sftp', 'legacy', 'SFTP pulled by the DMZ node into quarantine', { reliable: true, ordered: true, groupcast: false, browserReachable: false, crossesNetworks: true }),
];

const byId = new Map(TRANSPORT_TYPES.map((t) => [t.id, t]));
const byAlias = new Map(TRANSPORT_TYPES.flatMap((t) => t.aliases.map((a) => [a, t] as const)));
const byAddress = new Map(TRANSPORT_TYPES.map((t) => [t.mdmAddress, t]));

/** Resolve a type id, an old kind/rung/method name, or an MDM address. Unknown → null (never a guess). */
export function resolveTransportType(nameOrAddress: string | undefined | null): TransportType | null {
  if (!nameOrAddress) return null;
  return byId.get(nameOrAddress) ?? byAddress.get(nameOrAddress) ?? byAlias.get(nameOrAddress) ?? null;
}

/** The MDM address a stored config should carry for an old kind name. */
export function transportTypeAddressFor(kind: string): string | null {
  return resolveTransportType(kind)?.mdmAddress ?? null;
}

/** Can these two peers share a carrier? Both lists may use old or new names. */
export function commonCarriers(a: readonly string[], b: readonly string[]): TransportType[] {
  const bs = new Set(b.map((x) => resolveTransportType(x)?.id).filter(Boolean));
  const out: TransportType[] = [];
  for (const x of a) {
    const t = resolveTransportType(x);
    if (t && t.layer !== 'discovery' && bs.has(t.id) && !out.includes(t)) out.push(t);
  }
  return out;
}
