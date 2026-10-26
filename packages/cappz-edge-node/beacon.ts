/**
 * COPE node crystallized.
 * Node ID: v12-23-03-edge-node-beacon
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * UDP LAN beacon: signed multicast announcements ("I hold heads for
 * wallet X") on 239.44.144.100:41440. Discovery only — beacons never
 * carry state. Transfer opens over TCP after a beacon is heard.
 *
 * v15-03-00: beacons are Ed25519-signed with the node key (they used to go
 * out unsigned), listeners drop unsigned, forged and stale beacons, and a
 * verified beacon is handed on so the node dials the peer. LAN only:
 * routers and corporate proxies drop multicast; across networks copies use
 * the TX bid/ask rendezvous and the HTTPS relay.
 *
 * v15-09-00: group membership used `sock.joinMulticast?.()`, which Deno does
 * not have, so the optional call did nothing and the node never joined the
 * group (beacons arrived only where the OS looped them back). joinGroup()
 * uses Deno's joinMulticastV4 / joinMulticastV6 and says when it cannot.
 * Wallet groups (src/lib/sync/discovery/walletMulticast.ts): the node joins
 * the group of every wallet it serves (CAPPZ_SERVE_WALLETS), answers signed
 * connect requests with a unicast offer of its carriers, and kicks off its own
 * side channels by asking the same groups. The 239.44.144.100 beacon is unchanged.
 */

import {
  UDP_BEACON_GROUP,
  UDP_BEACON_PORT,
  BeaconRateLimiter,
  type UdpBeacon,
  type PeerHint,
} from '../../src/lib/sync/discovery/discoveryPlugins.ts';
import { signBeacon, verifyBeacon, type SigningKey } from '../../src/lib/sync/helloSignature.ts';
import { WALLET_GROUP_PORT, endpointUrl, walletMulticastGroup, readConnectRequest, buildConnectOffer, buildConnectRequest, readConnectOffer, planSideChannels, NonceWindow, type OfferedEndpoint, type UdpConnectRequest } from '../../src/lib/sync/discovery/walletMulticast.ts';
import type { HelloKeyDeclaration } from '../../src/lib/sync/helloKeyDeclaration.ts';

/**
 * Join a multicast group with Deno's API (unstable-net). An IPv4 join on
 * 0.0.0.0 was accepted but delivered nothing (seen on Linux/WSL2 with Deno
 * 2.5), so the node joins on every IPv4 interface address — or only on
 * CAPPZ_MULTICAST_IF — which needs --allow-sys=networkInterfaces; without it,
 * it falls back to 0.0.0.0 and says so.
 */
// deno-lint-ignore no-explicit-any
export async function joinGroup(sock: any, group: string): Promise<{ joined: boolean; reason?: string; interfaces?: string[] }> {
  try {
    if (group.includes(':')) {
      if (typeof sock.joinMulticastV6 !== 'function') return { joined: false, reason: 'no joinMulticastV6 (needs --unstable-net)' };
      await sock.joinMulticastV6(group, Number(Deno.env.get('CAPPZ_MULTICAST_IF6') ?? '0'));
      return { joined: true };
    }
    if (typeof sock.joinMulticastV4 !== 'function') return { joined: false, reason: 'no joinMulticastV4 (needs --unstable-net)' };
    let candidates: string[];
    const pinned = Deno.env.get('CAPPZ_MULTICAST_IF');
    let note = '';
    if (pinned) candidates = [pinned];
    else {
      try { candidates = Deno.networkInterfaces().filter((i) => i.family === 'IPv4').map((i) => i.address); }
      catch { candidates = ['0.0.0.0']; note = ' (0.0.0.0 only: grant --allow-sys=networkInterfaces to join per interface)'; }
    }
    const joined: string[] = []; const errors: string[] = [];
    for (const a of candidates) {
      try {
        const membership = await sock.joinMulticastV4(group, a);
        // Loop our own sends back so copies on the same host hear each other (it is a socket option, set via the membership).
        await membership?.setLoopback?.(true);
        joined.push(a);
      } catch (err) { errors.push(`${a}: ${err instanceof Error ? err.message : err}`); }
    }
    return joined.length ? { joined: true, interfaces: joined, ...(note ? { reason: note.trim() } : {}) } : { joined: false, reason: errors.join('; ') || 'no IPv4 interface' };
  } catch (err) {
    return { joined: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

const limiter = new BeaconRateLimiter();
// deno-lint-ignore no-explicit-any
const udpAvailable = () => typeof (Deno as any).listenDatagram === 'function';

export async function startBeacon(powAddress: string, endpoints: string[], key: SigningKey | null, heads: () => string[]): Promise<void> {
  if (!key) {
    console.log('[edge-node] beacon off: needs CAPPZ_NODE_KEY / CAPPZ_NODE_PUB (beacons are signed)');
    return;
  }
  if (!udpAvailable()) {
    console.log('[edge-node] beacon off: UDP needs --unstable-net');
    return;
  }
  const sock = Deno.listenDatagram({ port: 0, transport: 'udp', hostname: '0.0.0.0' });
  const group: Deno.NetAddr = { transport: 'udp', hostname: UDP_BEACON_GROUP, port: UDP_BEACON_PORT };
  await joinGroup(sock, UDP_BEACON_GROUP); // multicast loopback for nodes on the same host
  const announce = async () => {
    const beacon = await signBeacon({
      version: 1, powAddress, heads: heads(), transports: ['tcp'], endpoints, sentAt: new Date().toISOString(),
    }, key);
    await sock.send(new TextEncoder().encode(JSON.stringify(beacon)), group);
  };
  setInterval(() => { void announce().catch((err) => console.warn('[edge-node] beacon send failed:', err?.message ?? err)); }, 15_000);
  await announce();
}

export async function listenBeacons(selfPow: string, onPeer: (hint: PeerHint) => void): Promise<void> {
  if (!udpAvailable()) return;
  const sock = Deno.listenDatagram({ port: UDP_BEACON_PORT, transport: 'udp', reuseAddress: true, hostname: '0.0.0.0' });
  // Bound to the wildcard: a socket bound without hostname did not receive group traffic (seen with Deno 2.5).
  const m = await joinGroup(sock, UDP_BEACON_GROUP);
  if (!m.joined) console.log(`[edge-node] beacon group ${UDP_BEACON_GROUP} not joined (${m.reason}); only looped-back beacons arrive`);
  for await (const [data, addr] of sock) {
    try {
      const beacon = JSON.parse(new TextDecoder().decode(data)) as UdpBeacon;
      if (beacon.version !== 1 || !beacon.powAddress || beacon.powAddress === selfPow) continue;
      if (!limiter.admit(beacon.powAddress)) continue;
      const check = await verifyBeacon(beacon);
      if (check !== 'verified-unbound' && check !== 'verified-bound') {
        console.log(`[edge-node] beacon from ${beacon.powAddress} dropped: ${check}`);
        continue;
      }
      const host = (addr as Deno.NetAddr).hostname;
      // Dial the address the datagram came from; the beacon's own 0.0.0.0 bind address is not reachable.
      const advertised = beacon.endpoints.find((e) => e.startsWith('tcp://')) ?? 'tcp://0.0.0.0:41441';
      const endpoint = advertised.replace(/^tcp:\/\/[^:/]+/, `tcp://${host}`);
      onPeer({ powAddress: beacon.powAddress, via: 'udp-beacon', endpoint, publicKey: beacon.publicKey, heardAt: new Date().toISOString() });
    } catch { /* malformed datagram — ignore */ }
  }
}

export interface WalletGroupOptions {
  /** Wallets this node holds copies of; it answers connect requests for these. */
  wallets: string[];
  key: SigningKey;
  /** Where this node accepts each carrier (transport type ids, transportTypes.ts). */
  endpoints: OfferedEndpoint[];
  declaredKeys?: (wallet: string) => readonly string[] | null | Promise<readonly string[] | null>;
  /** A verified request was answered: record it (ReplicaConnectRequested/Offered). */
  record?: (eventType: 'ReplicaConnectRequested' | 'ReplicaConnectOffered', data: Record<string, unknown>) => Promise<void>;
}

/** Answer signed connect requests sent to the groups of the wallets this node serves. */
export async function listenWalletGroups(o: WalletGroupOptions): Promise<void> {
  if (!udpAvailable() || !o.wallets.length) return;
  const sock = Deno.listenDatagram({ port: WALLET_GROUP_PORT, transport: 'udp', reuseAddress: true, hostname: '0.0.0.0' });
  for (const w of o.wallets) {
    const g = await walletMulticastGroup(w);
    const m = await joinGroup(sock, g.ipv4);
    console.log(`[edge-node] wallet group ${g.ipv4} (${w.slice(0, 12)}…) ${m.joined ? `joined on ${m.interfaces?.join(', ')}${m.reason ? ` ${m.reason}` : ''}` : `not joined: ${m.reason}`}`);
  }
  const nonces = new NonceWindow();
  for await (const [data, addr] of sock) {
    try {
      const { check, request } = await readConnectRequest(data, { wallets: o.wallets, nonces, declaredKeys: o.declaredKeys });
      if (check !== 'verified-bound' && check !== 'verified-unbound') { if (check !== 'not-for-us') console.log(`[edge-node] connect request dropped: ${check}`); continue; }
      if (request!.publicKey.toLowerCase() === o.key.publicKeyHex.toLowerCase()) continue; // our own ask, looped back
      const offer = await buildConnectOffer(request!, data.length, { walletAddress: request!.targetWallet, endpoints: o.endpoints }, o.key);
      if (!offer) continue;
      await sock.send(offer.bytes, addr);
      await o.record?.('ReplicaConnectRequested', { via: 'udp-multicast', walletAddress: request!.walletAddress, copyId: request!.copyId, carriers: request!.carriers, nonce: request!.nonce, check });
      await o.record?.('ReplicaConnectOffered', { via: 'udp-unicast', inReplyTo: request!.nonce, endpoints: offer.offer.endpoints });
    } catch (err) {
      // readConnectRequest reports malformed datagrams itself; anything thrown here is a node fault worth seeing.
      console.warn('[edge-node] wallet-group answer failed:', err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Kick off side channels: ask a wallet's group who holds it, wait briefly for
 * offers, and hand back the endpoints to dial (several when paths > 1).
 */
export async function askWalletGroup(o: { wallet: string; copyId: string; carriers: string[]; key: SigningKey; keyDeclaration?: HelloKeyDeclaration; waitMs?: number; paths?: number }): Promise<Array<{ endpoint: OfferedEndpoint; from: Deno.NetAddr; request: UdpConnectRequest }>> {
  if (!udpAvailable()) return [];
  const g = await walletMulticastGroup(o.wallet);
  const sock = Deno.listenDatagram({ port: 0, transport: 'udp', hostname: '0.0.0.0' });
  await joinGroup(sock, g.ipv4); // sets multicast loopback, so a node on this host hears the ask too
  // Asking for several paths pads the request, so the answer may carry several carriers (1:1 at most).
  const { request, bytes } = await buildConnectRequest({ walletAddress: o.wallet, targetWallet: o.wallet, copyId: o.copyId, carriers: o.carriers, keyDeclaration: o.keyDeclaration }, o.key, Date.now(), (o.paths ?? 1) > 1 ? 1200 : 0);
  await sock.send(bytes, { transport: 'udp', hostname: g.ipv4, port: g.port });
  const found: Array<{ endpoint: OfferedEndpoint; from: Deno.NetAddr; request: UdpConnectRequest }> = [];
  const timer = setTimeout(() => sock.close(), o.waitMs ?? 1500);
  try {
    for await (const [data, addr] of sock) {
      const { check, offer } = await readConnectOffer(data, request);
      if (check !== 'verified-unbound' || !offer) continue;
      const from = addr as Deno.NetAddr;
      // Port-only and bind-address endpoints are dialled at the address the offer came from.
      for (const e of planSideChannels(offer, o.carriers, o.paths ?? 1)) { const url = endpointUrl(e, from.hostname); if (url) found.push({ endpoint: { carrier: e.carrier, url }, from, request }); }
    }
  } catch { /* closed by the timer */ } finally { clearTimeout(timer); }
  return found;
}
