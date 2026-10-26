import { describe, it, expect } from 'vitest';
import { generateRecoveryPhrase, keyPairFromPhrase } from '../lib/auth/wallet/session';
import { generateSigningKey } from '../lib/sync/helloSignature';
import { declareHelloKey } from '../lib/sync/helloKeyDeclaration';
import { walletMulticastGroup, endpointUrl, buildConnectRequest, readConnectRequest, buildConnectOffer, readConnectOffer, planSideChannels, NonceWindow, UDP_DATAGRAM_MAX } from '../lib/sync/discovery/walletMulticast';
import { UDP_BEACON_GROUP } from '../lib/sync/discovery/discoveryPlugins';

const wallet = () => keyPairFromPhrase(generateRecoveryPhrase());

describe('v15-09-00 wallet multicast groups and UDP kick-off', () => {
  it('groups are reproducible from the wallet address, in the scoped ranges, and distinct from the LAN beacon', async () => {
    const w = wallet();
    const a = await walletMulticastGroup(w.address);
    expect(await walletMulticastGroup(w.address)).toEqual(a);
    expect(a.ipv6).toMatch(/^ff15(:[0-9a-f]{1,4}){7}$/);
    const [o1, o2] = a.ipv4.split('.').map(Number);
    expect(o1).toBe(239); expect(o2).toBeGreaterThanOrEqual(192); expect(o2).toBeLessThanOrEqual(195);
    expect(a.ipv4).not.toBe(UDP_BEACON_GROUP);
    expect((await walletMulticastGroup(wallet().address)).ipv6).not.toBe(a.ipv6);
  });

  it('a signed connect request with a key declaration fits one datagram and verifies bound', async () => {
    const w = wallet(); const dev = await generateSigningKey();
    const decl = await declareHelloKey(w.privateKey, w.address, dev.publicKeyHex);
    const { request, bytes } = await buildConnectRequest({ walletAddress: w.address, targetWallet: w.address, copyId: 'laptop', carriers: ['quic', 'tcp', 'https'], keyDeclaration: decl }, dev);
    expect(bytes.length).toBeLessThanOrEqual(UDP_DATAGRAM_MAX);
    const nonces = new NonceWindow();
    const r = await readConnectRequest(bytes, { wallets: [w.address], nonces, declaredKeys: async () => [dev.publicKeyHex] });
    expect(r.check).toBe('verified-bound');
    expect((await readConnectRequest(bytes, { wallets: [w.address], nonces })).check).toBe('replayed');
    expect((await readConnectRequest(bytes, { wallets: ['someone-else'], nonces: new NonceWindow() })).check).toBe('not-for-us');
    const forged = new TextEncoder().encode(JSON.stringify({ ...request, carriers: ['tcp'] }));
    expect((await readConnectRequest(forged, { wallets: [w.address], nonces: new NonceWindow() })).check).toBe('bad-signature');
    expect((await readConnectRequest(new Uint8Array(UDP_DATAGRAM_MAX + 1), { wallets: [w.address], nonces: new NonceWindow() })).check).toBe('too-large');
  });

  it('the offer names only common carriers, is never larger than the request, and plans several paths', async () => {
    const w = wallet(); const copy = await generateSigningKey(); const node = await generateSigningKey();
    const { request, bytes } = await buildConnectRequest({ walletAddress: w.address, targetWallet: w.address, copyId: 'c1', carriers: ['quic', 'tcp'] }, copy);
    const built = await buildConnectOffer(request, bytes.length, { walletAddress: w.address, endpoints: [
      { carrier: 'tcp', url: 'tcp://10.0.0.5:41441' }, { carrier: 'quic', url: 'quic://10.0.0.5:41443' }, { carrier: 'wss', url: 'wss://10.0.0.5:41442' },
    ] }, node);
    expect(built).not.toBeNull();
    expect(built!.bytes.length).toBeLessThanOrEqual(bytes.length);
    expect(built!.offer.endpoints.map((e) => e.carrier)).toEqual(['tcp', 'quic']);
    const read = await readConnectOffer(built!.bytes, request);
    expect(read.check).toBe('verified-unbound');
    expect(planSideChannels(read.offer!, ['quic', 'tcp'], 2).map((e) => e.carrier)).toEqual(['quic', 'tcp']);
    expect(endpointUrl(read.offer!.endpoints[0], '10.0.0.5')).toBe('tcp://10.0.0.5:41441');
    expect(planSideChannels(read.offer!, ['tcp'], 2).map((e) => e.carrier)).toEqual(['tcp']);
    // Nothing in common: stay silent.
    expect(await buildConnectOffer(request, bytes.length, { walletAddress: w.address, endpoints: [{ carrier: 'wss', url: 'wss://x' }] }, node)).toBeNull();
    // An offer answering another request is not for us.
    const other = (await buildConnectRequest({ walletAddress: w.address, targetWallet: w.address, copyId: 'c2', carriers: ['tcp'] }, copy)).request;
    expect((await readConnectOffer(built!.bytes, other)).check).toBe('not-for-us');
  });

  it('v15-10-00: bind addresses are offered as ports; a padded ask gets every common carrier back (1:1)', async () => {
    const w = wallet(); const copy = await generateSigningKey(); const node = await generateSigningKey();
    const endpoints = [{ carrier: 'quic', url: 'quic://0.0.0.0:41443' }, { carrier: 'tcp', url: 'tcp://0.0.0.0:41441' }, { carrier: 'wss', url: 'wss://relay.example.com/cpz1/ws' }];
    const small = await buildConnectRequest({ walletAddress: w.address, targetWallet: w.address, copyId: 'c', carriers: ['quic', 'tcp', 'wss'] }, copy);
    const padded = await buildConnectRequest({ walletAddress: w.address, targetWallet: w.address, copyId: 'c', carriers: ['quic', 'tcp', 'wss'] }, copy, Date.now(), 1200);
    expect(padded.bytes.length).toBeGreaterThan(1150);
    expect(padded.bytes.length).toBeLessThanOrEqual(UDP_DATAGRAM_MAX);
    // The padding is signed: stripping it breaks the signature.
    const stripped = new TextEncoder().encode(JSON.stringify({ ...padded.request, pad: undefined }));
    expect((await readConnectRequest(stripped, { wallets: [w.address], nonces: new NonceWindow() })).check).toBe('bad-signature');
    expect((await readConnectRequest(padded.bytes, { wallets: [w.address], nonces: new NonceWindow() })).check).toBe('verified-unbound');
    const a = await buildConnectOffer(small.request, small.bytes.length, { walletAddress: w.address, endpoints }, node);
    const b = await buildConnectOffer(padded.request, padded.bytes.length, { walletAddress: w.address, endpoints }, node);
    expect(a!.bytes.length).toBeLessThanOrEqual(small.bytes.length);
    expect(b!.offer.endpoints).toEqual([{ carrier: 'quic', port: 41443 }, { carrier: 'tcp', port: 41441 }, { carrier: 'wss', url: 'wss://relay.example.com/cpz1/ws' }]);
    expect(planSideChannels(b!.offer, ['quic', 'tcp'], 2).map((e) => endpointUrl(e, 'fe80::1'))).toEqual(['quic://[fe80::1]:41443', 'tcp://[fe80::1]:41441']);
  });
});
