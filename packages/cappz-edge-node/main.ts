/**
 * COPE node crystallized.
 * Node ID: v12-23-04-edge-node-main
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Standalone Replicator edge node entrypoint (Deno).
 *   deno run --allow-net --allow-read --allow-write --allow-env --allow-run=curl --allow-sys=networkInterfaces --unstable-net main.ts --tcp 41441 --quic 41443 --ws 41442 --jobs 41444 --relay 41445 --verify 41446 --legacy 41447 --ftps 41449 --ldap 41389
 * QUIC needs CAPPZ_TLS_CERT / CAPPZ_TLS_KEY (self-signed is fine — trust is
 * the signed wallet hello). Without them, or without --unstable-net, the
 * node logs the reason and runs TCP only.
 *
 * v15-01-00: --jobs runs BPMN timers and secret-free inbound webhooks
 * (jobs.ts). Every TX it writes is signed with the node key
 * (CAPPZ_NODE_KEY / CAPPZ_NODE_PUB); CAPPZ_NODE_DATA holds the TX log.
 *
 * v15-03-00: --relay serves the HTTPS keep-alive relay (relay.ts) for
 * copies behind firewalls and reverse proxies. UDP beacons only reach the
 * LAN; across networks copies rendezvous by TX bid/ask and dial out.
 * The node key now also signs a fresh hello per connection and every
 * beacon; TCP, QUIC and the WS bridge verify the peer's hello and run
 * inventory gossip (peers.ts); a verified beacon makes the node dial.
 *
 * v15-04-00: sessions pull bodies, not just heads. Bodies live in
 * <CAPPZ_NODE_DATA>/objects/<sha256>; files dropped into inbox/ are taken in.
 *
 * v15-05-00: the node registers its member-table record (directory.ts):
 * where it accepts connections (CAPPZ_NODE_LAN_URL/CAPPZ_NODE_LAN_ID,
 * CAPPZ_NODE_PUBLIC_URL). The record is a body, so peers replicate it, and
 * it rides every connect offer — copies dial this node directly; a relay is
 * only for copies that cannot reach it.
 *
 * v15-09-00: TLS from tlsIdentity.ts (operator files, or CAPPZ_TLS_AUTO=1:
 * in-memory P-256 delegated by the node key). --verify 41446 serves the edge
 * verification gateway for nginx auth_request / proxy mode (verifyGateway.ts).
 * --routes 41450 (with CAPPZ_ROUTES_MODULE / CAPPZ_ROUTES_UPSTREAM) serves the route
 * host that moves a PHP app off php-fpm one route at a time (routes.ts).
 * --legacy 41447 serves the DMZ quarantine and legacy front end, and pulls
 * partner FTPS/SFTP directories (legacy.ts). CAPPZ_SERVE_WALLETS lists the
 * wallets whose multicast groups the node answers (UDP 41448): a signed
 * connect request gets a unicast offer of the node's carriers.
 *
 * v15-10-00: TLS rotates without restart; --ftps 41449 (implicit FTPS drop box
 * into quarantine, legacy.ts) and --ldap 41389 (read-only directory, ldap.ts).
 */

import { serveTcp, dialTcp } from './tcp.ts';
import { serveQuic, quicAvailable } from './quic.ts';
import { startBeacon, listenBeacons, listenWalletGroups, askWalletGroup } from './beacon.ts';
import { resolveTls, rotateTls } from './tlsIdentity.ts';
import { serveVerifyGateway, verifyGatewayFor } from './verifyGateway.ts';
import { serveRoutes } from './routes.ts';
import { serveLegacy } from './legacy.ts';
import { serveLdap } from './ldap.ts';
import { memberTableFromStore } from './directory.ts';
import { projectDirectory } from '../../src/lib/sync/directoryView.ts';
import { signEdgeTx } from '../../src/lib/functions/edgeJobs.ts';
import { serveBrowserBridge } from './bridge.ts';
import { serveJobs } from './jobs.ts';
import { serveRelay, webTransportPossible } from './relay.ts';
import { nodeEndpointsFromEnv, registerNodeRecord } from './directory.ts';
import type { EndpointRecord } from '../../src/lib/sync/endpointDirectory.ts';
import { loadNodeKey, declaredKeysFrom } from './nodeKey.ts';
import { nodeHello, runPeerSession, type NodeIdentity } from './peers.ts';
import { fileBodyStore } from './objects.ts';
import type { EdgeSessionOptions } from '../../src/lib/sync/edgeSession.ts';

function arg(name: string, fallback: number): number {
  const i = Deno.args.indexOf(`--${name}`);
  return i >= 0 ? Number(Deno.args[i + 1]) : fallback;
}

const tcpPort = arg('tcp', 41441);
const quicPort = arg('quic', 41443);
const wsPort = arg('ws', 41442);
const jobsPort = arg('jobs', 41444);
const relayPort = arg('relay', 41445);
const verifyPort = arg('verify', 41446);
const legacyPort = arg('legacy', 41447);
const ftpsPort = arg('ftps', 41449);
const ldapPort = arg('ldap', 41389);
const routesPort = arg('routes', 41450);
const powAddress = Deno.env.get('CAPPZ_POW') ?? 'unset-pow';
const dataDir = Deno.env.get('CAPPZ_NODE_DATA') ?? './cappz-node-data';
const key = await loadNodeKey();
await Deno.mkdir(dataDir, { recursive: true });
const tlsFirst = await resolveTls(key, dataDir);
// v15-10-00: rotation without restart (auto certificates every 6 days, operator files on change).
const tls = tlsFirst ? rotateTls(tlsFirst, key, dataDir) : null;
const quicOn = quicAvailable() && Boolean(tls);

const store = await fileBodyStore(dataDir);
let heads: string[] = [];
const refreshHeads = async () => {
  const n = await store.ingestInbox().catch(() => 0);
  if (n) console.log(`[edge-node] took ${n} file(s) from the inbox`);
  heads = (await store.list()).slice(0, 256);
};
await refreshHeads();
setInterval(() => void refreshHeads(), 30_000);

let endpointRecord: EndpointRecord | null = null;
if (key) {
  endpointRecord = await registerNodeRecord({ powAddress, key, store, endpoints: nodeEndpointsFromEnv(webTransportPossible(tls)) });
  console.log(`[edge-node] member record ${endpointRecord.address} — ${endpointRecord.endpoints.length ? endpointRecord.endpoints.map((e) => `${e.scope} ${e.url}`).join(', ') : 'outbound-only (set CAPPZ_NODE_PUBLIC_URL / CAPPZ_NODE_LAN_URL)'}`);
}

const id: NodeIdentity = {
  powAddress, key, dataDir, store,
  transports: quicOn ? ['tcp', 'quic', 'websocket', 'https'] : ['tcp', 'websocket', 'https'],
};
// Peers' declared keys come from <CAPPZ_NODE_DATA>/declared-hello-keys.json (same list as the relay).
const sessionOpts: EdgeSessionOptions = {
  declaredKeysFor: declaredKeysFrom(dataDir),
  requireBoundKey: Deno.env.get('CAPPZ_PEER_REQUIRE_BOUND') === '1',
};
const hello = () => nodeHello(id);
const onSession = (via: string) => (s: Parameters<typeof runPeerSession>[1]) => runPeerSession(id, s, via);

console.log(`[edge-node] POW ${powAddress}${key ? `  key ${key.publicKeyHex.slice(0, 16)}…` : '  (no node key: peer sessions, beacons and jobs off)'}`);
console.log(`[edge-node] tcp :${tcpPort}  quic :${quicOn ? quicPort : 'off'}  ws :${wsPort}  relay :${relayPort}`);
if (!quicOn) console.log('[edge-node] quic off: needs --unstable-net and TLS (CAPPZ_TLS_CERT/CAPPZ_TLS_KEY or CAPPZ_TLS_AUTO=1)');

// The ontology is the directory: member records, placed only by explicit edges (none on a bare node: listed unplaced).
const directoryRows = async () => projectDirectory({ members: await memberTableFromStore(store), aliases: Deno.env.get('CAPPZ_NODE_NAME') ? { [powAddress]: { name: Deno.env.get('CAPPZ_NODE_NAME')! } } : undefined });
const endpoints = [`tcp://0.0.0.0:${tcpPort}`, ...(quicOn ? [`quic://0.0.0.0:${quicPort}`] : [])];
const dialing = new Set<string>();

// v15-09-00 wallet groups: answer connect requests for these wallets, and ask the same groups for other copies.
const serveWallets = (Deno.env.get('CAPPZ_SERVE_WALLETS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const groupEndpoints = [{ carrier: 'tcp', url: `tcp://0.0.0.0:${tcpPort}` }, ...(quicOn ? [{ carrier: 'quic', url: `quic://0.0.0.0:${quicPort}` }] : [])];
async function kickOffSideChannels(): Promise<void> {
  for (const wallet of serveWallets) {
    const offers = await askWalletGroup({ wallet, copyId: `${powAddress}#node`, carriers: ['tcp'], key: key!, paths: 1 });
    for (const { endpoint, from } of offers) {
      const m = /^tcp:\/\/(?:\[([^\]]+)\]|([^:/]+)):(\d+)/.exec(endpoint.url ?? '');
      if (!m) continue;
      const host = m[1] ?? m[2]; const port = Number(m[3]); const id2 = `${host}:${port}`;
      if (dialing.has(id2)) continue;
      dialing.add(id2);
      dialTcp(host, port, await hello(), sessionOpts)
        .then((session) => runPeerSession(id, session, 'udp wallet-group offer'))
        .catch((err) => console.warn('[edge-node] side channel after offer failed:', err?.message ?? err))
        .finally(() => dialing.delete(id2));
    }
  }
}

await Promise.all([
  key ? serveTcp(tcpPort, hello, onSession('tcp'), sessionOpts) : Promise.resolve(),
  quicOn && key
    ? serveQuic(quicPort, tls!, hello, onSession('quic'), sessionOpts)
    : Promise.resolve(),
  startBeacon(powAddress, endpoints, key, () => heads),
  key
    ? listenBeacons(powAddress, (hint) => {
        // A verified beacon on the LAN: dial it once at a time and gossip heads.
        if (dialing.has(hint.powAddress)) return;
        const m = /^tcp:\/\/([^:/]+):(\d+)/.exec(hint.endpoint);
        if (!m) return;
        dialing.add(hint.powAddress);
        (async () => {
          const session = await dialTcp(m[1], Number(m[2]), await hello(), sessionOpts);
          if (session.remoteHello.walletAddress !== hint.powAddress || session.remoteHello.publicKey !== hint.publicKey) {
            session.close();
            throw new Error('peer hello does not match the beacon it answered');
          }
          await runPeerSession(id, session, 'udp-beacon dial');
        })().catch((err) => console.warn('[edge-node] dial after beacon failed:', err?.message ?? err))
          .finally(() => dialing.delete(hint.powAddress));
      })
    : Promise.resolve(),
  key ? serveBrowserBridge(wsPort, hello, onSession('ws-bridge'), sessionOpts) : Promise.resolve(),
  serveRelay(relayPort, powAddress, dataDir, () => endpointRecord, tls),
  serveVerifyGateway(verifyPort, dataDir),
  serveLegacy({
    port: legacyPort, dataDir, nodeAddress: powAddress, key, bodies: store, verify: verifyGatewayFor(dataDir),
    directory: async () => ({ node: { address: powAddress, name: Deno.env.get('CAPPZ_NODE_NAME') ?? null }, entries: await directoryRows() }),
    ftpsPort, tls,
  }),
  serveLdap(ldapPort, directoryRows),
  // v15-12-00: the route host runs when there is a port module or a legacy app to front.
  Deno.env.get('CAPPZ_ROUTES_MODULE') || Deno.env.get('CAPPZ_ROUTES_UPSTREAM') ? serveRoutes({ port: routesPort, dataDir, nodeAddress: powAddress }) : Promise.resolve(),
  key && serveWallets.length
    ? listenWalletGroups({
        wallets: serveWallets, key, endpoints: groupEndpoints, declaredKeys: sessionOpts.declaredKeysFor,
        record: async (eventType, data) => {
          const tx = { txId: `${eventType}-${crypto.randomUUID()}`, timestamp: new Date().toISOString(), eventType, sourceAddress: powAddress, targetAddress: `${powAddress}/admin/in-queue`, payload: { ...data, bpmnPath: "m/44'/144'/100'/bpmn/substrate/replica-connect", governingPrinciple: "m/44'/144'/100'/principles/cope/v1#local-first" } };
          await Deno.writeTextFile(`${dataDir}/edge-txs.jsonl`, JSON.stringify(await signEdgeTx(tx, key)) + '\n', { append: true });
        },
      })
    : Promise.resolve(),
  key && serveWallets.length ? kickOffSideChannels() : Promise.resolve(),
  serveJobs({
    port: jobsPort,
    nodeAddress: powAddress,
    dataDir,
    bpmnPath: new URL('../../src/bpmn/substrate/functions/edge-node-jobs.bpmn', import.meta.url).pathname,
  }),
]);
