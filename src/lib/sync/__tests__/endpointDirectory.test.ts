// @vitest-environment node
/**
 * v15-05-00 — the member table (NetBIOS/bindery-style endpoint directory):
 * each copy's device records where it accepts connections; peers dial it
 * directly, and a relay is only the last resort.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { replayEndpointDirectory, resolvePeerPaths, signEndpointRecord, signEndpointRecordWithWallet, verifyEndpointRecord, endpointRecordId, type EndpointRecord } from '../endpointDirectory';
import { generateSigningKey } from '../helloSignature';
import { declareHelloKey } from '../helloKeyDeclaration';
import { keyPairFromPhrase, generateRecoveryPhrase } from '../../auth/wallet/session';
import { copyDeviceAddress, replicatorNetworkRoot } from '../../wallets/paths';
import { createHttpsRelay, type HttpsRelay } from '../transports/httpsRelay';
import { inProcessFetch, type FetchLike } from '../transports/httpsTunnel';
import { connectToPeer } from '../transports/peerConnect';
import type { A2ASyncEvent } from '../a2aSyncEvents';

const wallet = keyPairFromPhrase(generateRecoveryPhrase());
const net = replicatorNetworkRoot(wallet.address);
const base = (copyId: string, deviceId: string, endpoints: EndpointRecord['endpoints'], at = '2026-10-26T10:00:00Z') =>
  ({ walletAddress: wallet.address, copyId, deviceId, address: copyDeviceAddress(net, copyId, deviceId), endpoints, registeredAt: at });

const relays: HttpsRelay[] = [];
afterEach(() => { for (const r of relays.splice(0)) r.close(); });

describe('endpoint records', () => {
  it('trust: wallet-signed, declared device, undeclared device, tampered', async () => {
    const byWallet = await signEndpointRecordWithWallet(base('hq', 'd1', []), wallet.privateKey);
    expect(await verifyEndpointRecord(byWallet)).toBe('wallet-signed');
    const other = keyPairFromPhrase(generateRecoveryPhrase());
    const impostor = await signEndpointRecordWithWallet({ ...base('hq', 'd1', []), walletAddress: other.address }, other.privateKey);
    expect(await verifyEndpointRecord({ ...impostor, walletAddress: wallet.address })).toBe('bad-signature');

    const key = await generateSigningKey();
    const decl = await declareHelloKey(wallet.privateKey, wallet.address, key.publicKeyHex);
    const declared = await signEndpointRecord(base('hq', 'd2', [{ scope: 'public', url: 'https://hq.example/cpz1', carriers: ['wss', 'https-stream'] }]), key, decl);
    expect(await verifyEndpointRecord(declared)).toBe('declared-device');
    expect(await verifyEndpointRecord({ ...declared, keyDeclaration: undefined })).toBe('undeclared-device');
    expect(await verifyEndpointRecord({ ...declared, endpoints: [{ scope: 'public', url: 'https://evil.example/cpz1', carriers: ['wss'] }] })).toBe('bad-signature');
  });

  it('replay: newest valid record per device; an amendment must name what it amends and come from the same signer', async () => {
    const key = await generateSigningKey();
    const first = await signEndpointRecord(base('hq', 'd1', [{ scope: 'lan', lanId: 'hq-lan', url: 'http://10.0.0.5:41445/cpz1', carriers: ['https-stream'] }]), key);
    const moved = await signEndpointRecord({ ...base('hq', 'd1', [{ scope: 'lan', lanId: 'hq-lan', url: 'http://10.0.0.9:41445/cpz1', carriers: ['https-stream'] }], '2026-10-26T11:00:00Z'), amends: await endpointRecordId(first) }, key);
    const stranger = await signEndpointRecord({ ...base('hq', 'd1', [{ scope: 'public', url: 'https://evil.example/cpz1', carriers: ['wss'] }], '2026-10-26T12:00:00Z'), amends: await endpointRecordId(moved) }, await generateSigningKey());
    const dangling = await signEndpointRecord({ ...base('hq', 'd1', [], '2026-10-26T13:00:00Z'), amends: 'not-a-record' }, key);
    const table = await replayEndpointDirectory([dangling, stranger, moved, first]);
    expect(table).toHaveLength(1);
    expect(table[0].record.endpoints[0].url).toBe('http://10.0.0.9:41445/cpz1');
  });

  it('resolves LAN first, then the public endpoint, then relays', async () => {
    const key = await generateSigningKey();
    const hq = await signEndpointRecord(base('hq', 'd1', [
      { scope: 'public', url: 'https://hq.example/cpz1', carriers: ['wss'] },
      { scope: 'lan', lanId: 'hq-lan', url: 'http://10.0.0.5:41445/cpz1', carriers: ['https-stream'] },
    ]), key);
    const table = await replayEndpointDirectory([hq]);
    expect(resolvePeerPaths(table, 'hq', { lanIds: ['hq-lan'], relays: ['https://relay.example/cpz1'] }).map((p) => p.kind)).toEqual(['direct-lan', 'direct-public', 'relay']);
    expect(resolvePeerPaths(table, 'hq', { relays: ['https://relay.example/cpz1'] }).map((p) => p.kind)).toEqual(['direct-public', 'relay']);
  });
});

describe('connect to a peer by name', () => {
  async function world(hqPublicReachable: boolean) {
    const key = await generateSigningKey();
    const decl = await declareHelloKey(wallet.privateKey, wallet.address, key.publicKeyHex);
    const hqRecord = await signEndpointRecord(base('hq', 'node', [
      { scope: 'lan', lanId: 'hq-lan', url: 'http://10.0.0.5:41445/cpz1', carriers: ['https-stream', 'https-poll'] },
      { scope: 'public', url: 'https://hq.example/cpz1', carriers: ['https-stream', 'https-poll'] },
    ]), key, decl);
    const records: A2ASyncEvent[] = [];
    // The source runs the relay protocol itself and answers for itself with its own record.
    const hq = createHttpsRelay({ nodeAddress: 'hq', ask: { baseCappz: 0, baseUnit: 'flat', priceCappz: 0, unit: 'flat' }, endpointRecord: hqRecord, record: (e) => { records.push(e); } });
    const relay = createHttpsRelay({ nodeAddress: 'partner-relay', ask: { baseCappz: 0, baseUnit: 'flat', priceCappz: 0, unit: 'flat' } });
    relays.push(hq, relay);
    const unreachable: FetchLike = () => Promise.reject(new TypeError('connection refused'));
    const fetchFor = (from: 'hq-lan' | 'bank') => (url: string): FetchLike => {
      if (url.startsWith('http://10.0.0.5')) return from === 'hq-lan' ? inProcessFetch(hq.handle) : unreachable;
      if (url.startsWith('https://hq.example')) return hqPublicReachable ? inProcessFetch(hq.handle) : unreachable;
      return inProcessFetch(relay.handle);
    };
    return { table: await replayEndpointDirectory([hqRecord]), fetchFor, records, hqRecord };
  }
  const opts = async (from: 'hq-lan' | 'bank', w: Awaited<ReturnType<typeof world>>, learned: EndpointRecord[]) => ({
    directory: w.table, peerCopyId: 'hq', lanIds: from === 'hq-lan' ? ['hq-lan'] : [], relays: ['https://partner-relay.example/cpz1'],
    walletAddress: `w-${from}`, copyId: from, channelId: 'net', signingKey: await generateSigningKey(), rungs: ['https-stream', 'https-poll'] as const,
    fetchFor: w.fetchFor(from), onFrame: () => {}, onEndpoint: (r: EndpointRecord) => learned.push(r), rendezvousTimeoutMs: 500,
  });

  it('same LAN dials the source directly; the source answers for itself with its endpoint record', async () => {
    const w = await world(true); const learned: EndpointRecord[] = [];
    const r = await connectToPeer({ ...(await opts('hq-lan', w, learned)), rungs: ['https-stream', 'https-poll'] });
    expect(r.path.kind).toBe('direct-lan');
    expect(learned[0].address).toBe(w.hqRecord.address);
    expect(w.records.find((e) => e.eventType === 'ReplicaConnectOffered')?.data.endpointAddress).toBe(w.hqRecord.address);
    await r.tunnel.close();
  });

  it('outside the LAN dials the public endpoint; only an unreachable source falls back to the relay', async () => {
    const open = await world(true);
    const viaPublic = await connectToPeer({ ...(await opts('bank', open, [])), rungs: ['https-stream', 'https-poll'] });
    expect(viaPublic.path.kind).toBe('direct-public');
    await viaPublic.tunnel.close();

    const closed = await world(false); const failed: string[] = [];
    const viaRelay = await connectToPeer({ ...(await opts('bank', closed, [])), rungs: ['https-stream', 'https-poll'], onPathFailed: (p) => failed.push(p.kind) });
    expect(failed).toEqual(['direct-public']);
    expect(viaRelay.path.kind).toBe('relay');
    await viaRelay.tunnel.close();
  });
});
