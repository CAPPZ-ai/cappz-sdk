/**
 * COPE node crystallized.
 * Node ID: v15-13-00-mesh-ip-link
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * The mesh over any IP network with no internet behind it: a phone's hotspot,
 * a Wi-Fi Direct group, an ad-hoc (IBSS) cell, a switch in a basement. Peers
 * find each other with a signed UDP beacon on the mesh's own multicast group
 * (derived from the mesh id the way a wallet's group is) and, because some
 * hotspots filter multicast, on the subnet broadcast address too; then they
 * exchange CPZ1 frames over TCP. Peers given with --peer are dialled directly.
 *
 * Node.js (node:dgram, node:net) — runs on laptops, Raspberry Pi and Android
 * under Termux. The beacon only triggers a dial; the TCP hello is what
 * authenticates (KeyZ declaration + membership), so a forged beacon costs one
 * refused connection. Beacons are rate-limited per sender.
 */

import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import { walletMulticastGroup } from '../../src/lib/sync/discovery/walletMulticast.ts';
import { signCanonical, verifyCanonical } from '../../src/lib/sync/helloSignature.ts';
import { canonicalJson } from '../../src/lib/identity/canonical.ts';
import type { MeshNode, MeshLink } from '../../src/lib/mesh/meshNode.ts';

export const MESH_BEACON_PORT = 41449;
export const MESH_TCP_PORT = 41460;
const BEACON_EVERY_MS = 5_000;
const REDIAL_EVERY_MS = 10_000;

interface Beacon { v: 1; kind: 'cpz-mesh-beacon'; meshId: string; key: string; port: number; sentAt: number; sig?: string }

export interface IpMeshOptions {
  port?: number;
  beaconPort?: number;
  peers?: string[];
  discovery?: boolean;
  log?: (line: string) => void;
}

export interface IpMesh {
  connectedKeys(): string[];
  links(): Array<{ id: string; remote: string }>;
  close(): void;
}

function ipv4Interfaces(): Array<{ address: string; broadcast: string }> {
  const out: Array<{ address: string; broadcast: string }> = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list ?? []) {
    if (i.family !== 'IPv4' || i.internal) continue;
    const a = i.address.split('.').map(Number), m = i.netmask.split('.').map(Number);
    out.push({ address: i.address, broadcast: a.map((x, k) => (x & m[k]) | (~m[k] & 255)).join('.') });
  }
  return out;
}

export async function startIpMesh(node: MeshNode, o: IpMeshOptions = {}): Promise<IpMesh> {
  const log = o.log ?? (() => {});
  const port = o.port ?? MESH_TCP_PORT;
  const beaconPort = o.beaconPort ?? MESH_BEACON_PORT;
  const myKey = node.identity.deviceKey.publicKeyHex.toLowerCase();
  const group = (await walletMulticastGroup(node.meshId)).ipv4;
  const sockets = new Map<string, { sock: net.Socket; remote: string }>();
  const byRemote = new Map<string, string>(); // host:port dialled → link id
  const lastBeacon = new Map<string, number>();
  let n = 0;
  let closed = false;

  const attach = (sock: net.Socket, remote: string, dialled?: string) => {
    const id = `tcp:${remote}#${++n}`;
    const link: MeshLink = { id, carrier: 'tcp', send: (bytes) => { if (!sock.destroyed) sock.write(bytes); }, close: () => sock.destroy() };
    sockets.set(id, { sock, remote });
    if (dialled) byRemote.set(dialled, id);
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 15_000);
    sock.on('data', (chunk) => { void node.receive(id, new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)); });
    const down = () => { if (!sockets.has(id)) return; sockets.delete(id); if (dialled && byRemote.get(dialled) === id) byRemote.delete(dialled); node.linkDown(id); log(`link down ${remote}`); };
    sock.on('close', down);
    sock.on('error', down);
    log(`link up ${remote}`);
    void node.linkUp(link);
  };

  const dial = (host: string, p: number) => {
    const key = `${host}:${p}`;
    if (closed || byRemote.has(key)) return;
    byRemote.set(key, 'dialling');
    const sock = net.connect({ host, port: p });
    sock.once('connect', () => attach(sock, key, key));
    sock.once('error', () => { if (byRemote.get(key) === 'dialling') byRemote.delete(key); });
  };

  const server = net.createServer((sock) => attach(sock, `${sock.remoteAddress}:${sock.remotePort}`));
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '0.0.0.0', () => resolve()); });
  log(`listening tcp ${port}; mesh group ${group}:${beaconPort}`);

  const statics = (o.peers ?? []).map((s) => { const [h, p] = s.split(':'); return { host: h, port: Number(p || MESH_TCP_PORT) }; });
  const redial = setInterval(() => { for (const s of statics) dial(s.host, s.port); }, REDIAL_EVERY_MS);
  for (const s of statics) dial(s.host, s.port);

  let udp: dgram.Socket | null = null;
  let beaconTimer: ReturnType<typeof setInterval> | null = null;
  if (o.discovery !== false) {
    udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    udp.on('error', (e) => log(`udp: ${e.message}`));
    udp.on('message', async (msg, rinfo) => {
      try {
        if (msg.byteLength > 1200) return;
        const b = JSON.parse(msg.toString('utf8')) as Beacon;
        if (b.kind !== 'cpz-mesh-beacon' || b.meshId !== node.meshId || b.key === myKey || !b.sig) return;
        const t = Date.now();
        if (t - (lastBeacon.get(b.key) ?? 0) < BEACON_EVERY_MS / 2) return;
        lastBeacon.set(b.key, t);
        if (Math.abs(t - b.sentAt) > 10 * 60_000) return;
        const { sig, ...unsigned } = b;
        if (!(await verifyCanonical(canonicalJson(unsigned), sig, b.key))) return;
        if (myKey < b.key) dial(rinfo.address, b.port); // one side dials, so a pair opens one link
      } catch { /* not a beacon */ }
    });
    await new Promise<void>((resolve) => udp!.bind(beaconPort, '0.0.0.0', () => resolve()));
    udp.setBroadcast(true);
    udp.setMulticastLoopback(true);
    for (const i of ipv4Interfaces()) { try { udp.addMembership(group, i.address); } catch (e) { log(`join ${group} on ${i.address}: ${(e as Error).message}`); } }
    const send = async () => {
      const unsigned: Beacon = { v: 1, kind: 'cpz-mesh-beacon', meshId: node.meshId, key: myKey, port, sentAt: Date.now() };
      const bytes = Buffer.from(JSON.stringify({ ...unsigned, sig: await signCanonical(canonicalJson(unsigned), node.identity.deviceKey) }));
      udp?.send(bytes, beaconPort, group);
      for (const i of ipv4Interfaces()) udp?.send(bytes, beaconPort, i.broadcast);
    };
    void send();
    beaconTimer = setInterval(() => void send(), BEACON_EVERY_MS);
  }
  const tick = setInterval(() => node.tick(), 60_000);

  return {
    connectedKeys: () => node.links,
    links: () => [...sockets.entries()].map(([id, s]) => ({ id, remote: s.remote })),
    close() {
      closed = true;
      clearInterval(redial); clearInterval(tick); if (beaconTimer) clearInterval(beaconTimer);
      udp?.close(); server.close();
      for (const { sock } of sockets.values()) sock.destroy();
    },
  };
}
