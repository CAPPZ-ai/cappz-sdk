// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpsRelay, type HttpsRelay } from '../transports/httpsRelay';
import { connectThroughFirewall, inProcessFetch, requestReplicaConnect, type HttpsTunnel } from '../transports/httpsTunnel';
import { proxiedFetch, proxiedSocketDialer, PROXY_PROFILES, type ProxyProfile } from '../transports/proxySimulator';
import { decodeJsonFrame, encodeJsonFrame, FrameDecoder, type WireFrame } from '../frameCodec';
import { memoryDuplexPair } from '../edgeSession';
import type { A2ASyncEvent } from '../a2aSyncEvents';
import { generateSigningKey, signHello } from '../helloSignature';
import type { TransportHello } from '../transportContract';

const EP = 'https://relay.test/cpz1';
const price = (priceCappz: number, unit: 'flat' | 'per-MB' = 'per-MB') => ({ baseCappz: priceCappz, baseUnit: unit, priceCappz, unit });
const helloFor = async (walletAddress: string, key?: Awaited<ReturnType<typeof generateSigningKey>>, sentAt = new Date().toISOString()): Promise<TransportHello> =>
  signHello({ walletAddress, copyId: 'A', heads: [], transports: ['tcp'], discovery: ['relay-rendezvous'], sentAt }, key ?? await generateSigningKey());
const until = async (ok: () => boolean, ms = 3000) => { const t = Date.now(); while (!ok()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); } };

let relay: HttpsRelay | null = null;
const tunnels: HttpsTunnel[] = [];
afterEach(async () => { for (const t of tunnels.splice(0)) await t.close(); relay?.close(); relay = null; });

function setup(profile: ProxyProfile, extra: Partial<Parameters<typeof createHttpsRelay>[0]> = {}) {
  const records: A2ASyncEvent[] = [];
  relay = createHttpsRelay({ nodeAddress: 'node-1', ask: price(0.02), record: (e) => { records.push(e); }, keepAliveMs: 50, allowUnsignedHello: true, ...extra });
  const fetchImpl = proxiedFetch(inProcessFetch(relay.handle), () => profile);
  return { records, fetchImpl };
}

async function copy(name: string, fetchImpl: ReturnType<typeof inProcessFetch>, got: WireFrame[], firstByteTimeoutMs = 300) {
  const { tunnel, decision } = await connectThroughFirewall({
    endpoint: EP, walletAddress: `w-${name}`, copyId: name, channelId: 'A~B', bid: price(0.05), expectedBytes: 1_048_576,
    fetchImpl, firstByteTimeoutMs, pollWaitMs: 200, onFrame: (f) => got.push(f),
  });
  tunnels.push(tunnel);
  return { tunnel, decision };
}

describe('TX bid/ask rendezvous', () => {
  it('node offers a ticket when bid ≥ ask and records requester → decider TXs', async () => {
    const { records, fetchImpl } = setup(PROXY_PROFILES.open);
    const { decision } = await requestReplicaConnect({ endpoint: EP, walletAddress: 'w-a', copyId: 'A', channelId: 'A~B', bid: price(0.05), expectedBytes: 2_097_152, fetchImpl });
    expect(decision.eventType).toBe('ReplicaConnectOffered');
    if (decision.eventType !== 'ReplicaConnectOffered') return;
    expect(decision.askTotalCappz).toBeCloseTo(0.04);
    const [req, offer] = records;
    expect(req.eventType).toBe('ReplicaConnectRequested');
    expect(req.address).toBe('node-1/admin/in-queue');
    expect(offer.eventType).toBe('ReplicaConnectOffered');
    expect(offer.address).toBe('w-a/admin/in-queue');
    expect(offer.correlationId).toBe(req.correlationId);
    expect(JSON.stringify(offer.data)).not.toContain(decision.ticket); // bearer secret stays off the record
  });

  it('rejects a bid below the ask, and unsigned hellos when the node requires them', async () => {
    const { fetchImpl } = setup(PROXY_PROFILES.open, { allowUnsignedHello: false });
    const low = await requestReplicaConnect({ endpoint: EP, walletAddress: 'w-a', copyId: 'A', channelId: 'A~B', bid: price(0.001), expectedBytes: 1_048_576, fetchImpl });
    expect(low.decision.eventType).toBe('ReplicaConnectRejected');
    const unsigned = await requestReplicaConnect({ endpoint: EP, walletAddress: 'w-a', copyId: 'A', channelId: 'A~B', bid: price(1), fetchImpl });
    expect(unsigned.decision.eventType === 'ReplicaConnectRejected' && unsigned.decision.reason).toMatch(/unsigned hello/);
  });

  it('verifies hello signatures: carries a valid one, rejects tampered, stale and undeclared keys', async () => {
    const key = await generateSigningKey();
    const { records, fetchImpl } = setup(PROXY_PROFILES.open, { allowUnsignedHello: false });
    const ask = (hello: TransportHello, walletAddress = 'w-a') => requestReplicaConnect({ endpoint: EP, walletAddress, copyId: 'A', channelId: 'A~B', bid: price(1), hello, fetchImpl });
    const ok = await ask(await helloFor('w-a', key));
    expect(ok.decision.eventType).toBe('ReplicaConnectOffered');
    expect(records[0].data.helloCheck).toBe('verified-unbound');
    const tampered = { ...(await helloFor('w-a', key)), heads: ['forged-head'] };
    expect((await ask(tampered)).decision).toMatchObject({ reason: expect.stringMatching(/bad-signature/) });
    const presenceOnly = { ...(await helloFor('w-a', key)), signature: 'ab'.repeat(64) };
    expect((await ask(presenceOnly)).decision).toMatchObject({ reason: expect.stringMatching(/bad-signature/) });
    const old = await helloFor('w-a', key, new Date(Date.now() - 3_600_000).toISOString());
    expect((await ask(old)).decision).toMatchObject({ reason: expect.stringMatching(/stale/) });
    expect((await ask(await helloFor('w-b', key))).decision).toMatchObject({ reason: expect.stringMatching(/different wallet/) });

    const bound = setup(PROXY_PROFILES.open, { requireBoundKey: true, declaredKeys: (w) => (w === 'w-a' ? [key.publicKeyHex] : []) });
    const askBound = async (hello: TransportHello) => (await requestReplicaConnect({ endpoint: EP, walletAddress: 'w-a', copyId: 'A', channelId: 'A~B', bid: price(1), hello, fetchImpl: bound.fetchImpl })).decision;
    expect((await askBound(await helloFor('w-a', key))).eventType).toBe('ReplicaConnectOffered');
    expect(await askBound(await helloFor('w-a'))).toMatchObject({ reason: expect.stringMatching(/wrong-key/) });
  });

  it('caps open tickets per wallet and in total', async () => {
    const { fetchImpl } = setup(PROXY_PROFILES.open, { maxTicketsPerWallet: 2, maxTickets: 3 });
    const ask = (walletAddress: string) => requestReplicaConnect({ endpoint: EP, walletAddress, copyId: 'A', channelId: 'A~B', bid: price(1), fetchImpl }).then((r) => r.decision);
    expect((await ask('w-a')).eventType).toBe('ReplicaConnectOffered');
    expect((await ask('w-a')).eventType).toBe('ReplicaConnectOffered');
    expect(await ask('w-a')).toMatchObject({ reason: expect.stringMatching(/2 open tickets/) });
    expect((await ask('w-b')).eventType).toBe('ReplicaConnectOffered');
    expect(await ask('w-c')).toMatchObject({ reason: expect.stringMatching(/ticket limit/) });
  });

  it('takes the ticket only from the Authorization header, never the URL', async () => {
    const { fetchImpl } = setup(PROXY_PROFILES.open);
    const { decision } = await requestReplicaConnect({ endpoint: EP, walletAddress: 'w-a', copyId: 'A', channelId: 'A~B', bid: price(1), fetchImpl });
    if (decision.eventType !== 'ReplicaConnectOffered') throw new Error('expected offer');
    expect((await fetchImpl(`${EP}/poll?wait=0&ticket=${decision.ticket}`)).status).toBe(401);
    expect((await fetchImpl(`${EP}/poll?wait=0`, { headers: { Authorization: 'Bearer nope' } })).status).toBe(401);
    expect((await fetchImpl(`${EP}/poll?wait=0`, { headers: { Authorization: `Bearer ${decision.ticket}` } })).status).toBe(200);
    const seen: string[] = [];
    const spy = (input: string, init?: RequestInit) => { seen.push(input); return fetchImpl(input, init); };
    const a = await connectThroughFirewall({ endpoint: EP, walletAddress: 'w-z', copyId: 'Z', channelId: 'A~B', bid: price(1), fetchImpl: spy, pollWaitMs: 50, onFrame: () => {} });
    tunnels.push(a.tunnel);
    await a.tunnel.send('log', { text: 'hi' });
    await until(() => seen.some((u) => u.includes('/up')));
    expect(seen.every((u) => !u.includes('ticket') && !u.includes(a.decision.eventType === 'ReplicaConnectOffered' ? a.decision.ticket : '__'))).toBe(true);
  });
});

describe('HTTPS keep-alive tunnel', () => {
  it('carries frames both ways over one chunked stream per copy', async () => {
    const { records, fetchImpl } = setup(PROXY_PROFILES.open);
    const gotA: WireFrame[] = []; const gotB: WireFrame[] = [];
    const a = await copy('A', fetchImpl, gotA);
    const b = await copy('B', fetchImpl, gotB);
    await a.tunnel.send('inv', { ids: ['doc-1'] });
    await a.tunnel.send('frame', { id: 'doc-1', body: 'hello' });
    await until(() => gotB.length === 2);
    await b.tunnel.send('ack', { id: 'doc-1' });
    await until(() => gotA.length === 1);
    expect(gotB.map((f) => f.command)).toEqual(['inv', 'frame']);
    expect(decodeJsonFrame<{ id: string }>(gotA[0]).id).toBe('doc-1');
    expect(a.tunnel.rung).toBe('https-stream');
    // Two messages in, but only one stream request: no per-message HTTP.
    const statsB = b.tunnel.stats();
    expect(statsB.framesIn).toBe(2);
    expect(statsB.httpRequests).toBeLessThanOrEqual(2);
    await until(() => records.some((r) => r.eventType === 'TunnelOpened'));
  });

  it('steps down to long-poll behind a proxy that buffers chunked bodies, without losing frames', async () => {
    const { fetchImpl } = setup(PROXY_PROFILES['bank-inspecting']);
    const gotA: WireFrame[] = []; const gotB: WireFrame[] = [];
    const a = await copy('A', fetchImpl, gotA, 150);
    const b = await copy('B', fetchImpl, gotB, 150);
    await a.tunnel.send('frame', { id: 'doc-1' });
    await until(() => gotB.length === 1, 4000);
    expect(b.tunnel.rung).toBe('https-poll');
    expect(b.tunnel.stats().stepDowns[0].reason).toMatch(/buffering/);
    expect(gotA.length).toBe(0);
  });

  it('resumes from its cursor after a proxy idle cut', async () => {
    const profile: ProxyProfile = { name: 'tight', bufferChunked: false, idleTimeoutMs: 40, blockMulticast: true };
    const { fetchImpl } = setup(profile, { keepAliveMs: 1000 });
    const gotA: WireFrame[] = []; const gotB: WireFrame[] = [];
    const a = await copy('A', fetchImpl, gotA);
    const b = await copy('B', fetchImpl, gotB);
    for (let i = 0; i < 3; i++) { await a.tunnel.send('frame', { id: `doc-${i}` }); await new Promise((r) => setTimeout(r, 80)); }
    await until(() => new Set(gotB.map((f) => decodeJsonFrame<{ id: string }>(f).id)).size === 3, 4000);
    expect(b.tunnel.stats().reconnects).toBeGreaterThan(0);
  });

  it('rejects corrupted uploads at the relay', async () => {
    const { fetchImpl } = setup(PROXY_PROFILES.open);
    const { decision } = await requestReplicaConnect({ endpoint: EP, walletAddress: 'w-a', copyId: 'A', channelId: 'A~B', bid: price(1), fetchImpl });
    if (decision.eventType !== 'ReplicaConnectOffered') throw new Error('expected offer');
    const bytes = await encodeJsonFrame('frame', { id: 'x' });
    bytes[bytes.length - 1] ^= 0xff;
    const res = await fetchImpl(`${EP}/up`, { method: 'POST', body: bytes as unknown as BodyInit, headers: { Authorization: `Bearer ${decision.ticket}` } });
    expect(res.status).toBe(422);
  });
});

describe('published key declarations (v15-04-00)', () => {
  it('binds a device key with the wallet-signed declaration — no file, no lookup', async () => {
    const { declareHelloKey } = await import('../helloKeyDeclaration');
    const { keyPairFromPhrase, generateRecoveryPhrase } = await import('../../auth/wallet/session');
    const wallet = keyPairFromPhrase(generateRecoveryPhrase());
    const other = keyPairFromPhrase(generateRecoveryPhrase());
    const key = await generateSigningKey();
    const { records, fetchImpl } = setup(PROXY_PROFILES.open, { requireBoundKey: true });
    const ask = async (keyDeclaration?: Awaited<ReturnType<typeof declareHelloKey>>) => (await requestReplicaConnect({
      endpoint: EP, walletAddress: wallet.address, copyId: 'A', channelId: 'A~B', bid: price(1), signingKey: key, keyDeclaration, fetchImpl,
    })).decision;

    expect(await ask()).toMatchObject({ reason: expect.stringMatching(/verified-unbound/) });
    expect((await ask(await declareHelloKey(wallet.privateKey, wallet.address, key.publicKeyHex))).eventType).toBe('ReplicaConnectOffered');
    expect(records.filter((r) => r.eventType === 'ReplicaConnectRequested').map((r) => [r.data.keyDeclaration, r.data.helloCheck]).at(-1)).toEqual(['valid', 'verified-bound']);
    // signed by a different wallet's key, claiming this wallet
    const forged = { ...(await declareHelloKey(other.privateKey, other.address, key.publicKeyHex)), walletAddress: wallet.address };
    expect(await ask(forged)).toMatchObject({ reason: expect.stringMatching(/verified-unbound/) });
    expect(records.at(-2)?.data.keyDeclaration).toBe('bad-signature');
    const expired = await declareHelloKey(wallet.privateKey, wallet.address, key.publicKeyHex, 1000, Date.now() - 10_000);
    expect(await ask(expired)).toMatchObject({ reason: expect.stringMatching(/verified-unbound/) });
  });
});

describe('socket rungs: WebTransport and WebSocket above the HTTPS floor (v15-04-00)', () => {
  function socketSetup(profile: ProxyProfile) {
    const records: A2ASyncEvent[] = [];
    relay = createHttpsRelay({ nodeAddress: 'node-1', ask: price(0), record: (e) => { records.push(e); }, keepAliveMs: 50, allowUnsignedHello: true, socketRungs: { wss: true, webtransport: { url: 'https://relay.test:41445/cpz1/wt' } } });
    const r = relay;
    const fetchImpl = proxiedFetch(inProcessFetch(r.handle), () => profile);
    const dialSocket = proxiedSocketDialer(() => r, () => profile);
    return { records, fetchImpl, dialSocket };
  }
  async function socketCopy(name: string, env: ReturnType<typeof socketSetup>, got: WireFrame[]) {
    const { tunnel, decision } = await connectThroughFirewall({
      endpoint: EP, walletAddress: `w-${name}`, copyId: name, channelId: 'A~B', bid: price(1), fetchImpl: env.fetchImpl, dialSocket: env.dialSocket,
      firstByteTimeoutMs: 300, pollWaitMs: 200, onFrame: (f) => got.push(f),
    });
    tunnels.push(tunnel);
    return { tunnel, decision };
  }

  it('offers every rung with socket endpoints; an open network uses WebTransport both ways', async () => {
    const env = socketSetup(PROXY_PROFILES.open);
    const gotA: WireFrame[] = []; const gotB: WireFrame[] = [];
    const a = await socketCopy('A', env, gotA);
    const b = await socketCopy('B', env, gotB);
    if (a.decision.eventType !== 'ReplicaConnectOffered') throw new Error('expected offer');
    expect(a.decision.rungs).toEqual(['webtransport', 'wss', 'https-stream', 'https-poll']);
    expect(a.decision.endpoints).toMatchObject({ wss: 'wss://relay.test/cpz1/ws', webtransport: 'https://relay.test:41445/cpz1/wt' });
    await a.tunnel.send('frame', { id: 'doc-1' });
    await b.tunnel.send('ack', { id: 'doc-1' });
    await until(() => gotB.length === 1 && gotA.length === 1);
    expect([a.tunnel.rung, b.tunnel.rung]).toEqual(['webtransport', 'webtransport']);
    // Frames went up the socket, not as POSTs: one connection per copy.
    expect(a.tunnel.stats().httpRequests).toBe(1);
    await until(() => env.records.some((r) => r.eventType === 'TunnelOpened' && r.data.rung === 'webtransport'));
  });

  it('a reverse proxy that drops UDP lands on WebSocket; the bank proxy steps all the way down to polling, losing nothing', async () => {
    const env = socketSetup(PROXY_PROFILES['reverse-proxy']);
    const got: WireFrame[] = [];
    const a = await socketCopy('A', env, []);
    const b = await socketCopy('B', env, got);
    await until(() => a.tunnel.rung === 'wss' && b.tunnel.rung === 'wss');
    await a.tunnel.send('frame', { id: 'x' });
    await until(() => got.length === 1);
    expect(b.tunnel.stats().stepDowns.map((s) => s.reason)).toEqual([expect.stringMatching(/UDP is blocked/)]);

    relay?.close();
    const bank = socketSetup(PROXY_PROFILES['bank-inspecting']);
    const gotBank: WireFrame[] = [];
    const c = await socketCopy('C', bank, []);
    const d = await socketCopy('D', bank, gotBank);
    await c.tunnel.send('frame', { id: 'y' });
    await until(() => gotBank.length === 1, 5000);
    expect(d.tunnel.rung).toBe('https-poll');
    expect(d.tunnel.stats().stepDowns.map((s) => `${s.from}>${s.to}`)).toEqual(['webtransport>wss', 'wss>https-stream', 'https-stream>https-poll']);
  });

  it('a socket that sends anything but auth first, or a stale ticket, gets bye', async () => {
    const env = socketSetup(PROXY_PROFILES.open);
    const [client, server] = memoryDuplexPair();
    void relay!.attach(server, 'wss');
    const w = client.writable.getWriter();
    await w.write(await encodeJsonFrame('auth', { ticket: 'tk-nope', cursor: 0 }));
    const r = client.readable.getReader();
    const { value } = await r.read();
    const frames = await new FrameDecoder().feed(value!);
    expect(frames[0].command).toBe('bye');
    expect(decodeJsonFrame<{ reason: string }>(frames[0]).reason).toMatch(/ticket/);
    void env;
  });
});
