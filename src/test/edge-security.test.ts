/**
 * v15-11-00 — the edge gateway and key declarations checked against the failure pattern behind the 2026
 * PHP CVEs (CVE-2026-109618 / -109619): a hard failure mid-request (out of memory), state that outlives
 * the request, attacker-shaped input parsed early. Each test pins a fail-closed behaviour.
 */
import { describe, it, expect } from 'vitest';
import { generateRecoveryPhrase, keyPairFromPhrase } from '../lib/auth/wallet/session';
import { generateSigningKey } from '../lib/sync/helloSignature';
import { declareKey } from '../lib/identity/keyDeclaration';
import { createVerifyGateway, signRequest, requestSigner, isDeclarationShape, readBounded } from '../lib/identity/edgeVerify';
import { createShadowComparison } from '../lib/identity/shadowCompare';
import { parseCertificate } from '../lib/identity/x509';
import { createLegacyGateway, memoryQuarantineStore } from '../lib/sync/transports/legacyGateway';

const enc = (s: string) => new TextEncoder().encode(s);
/** A body that streams n bytes in 64 KB chunks without a Content-Length (chunked). */
const endless = (n: number) => { let sent = 0; return new ReadableStream<Uint8Array>({ pull(c) { if (sent >= n) return c.close(); const k = Math.min(65536, n - sent); sent += k; c.enqueue(new Uint8Array(k)); } }); };
const stream = (url: string, body: ReadableStream<Uint8Array>, headers: HeadersInit = {}) => new Request(url, { method: 'POST', body, headers, duplex: 'half' } as RequestInit);

async function signer() {
  const w = keyPairFromPhrase(generateRecoveryPhrase()); const dev = await generateSigningKey();
  const decl = await declareKey(w.privateKey, w.address, { publicKey: dev.publicKeyHex, algorithm: 'ed25519', purpose: 'signing' });
  const signed = async (url = 'https://api.example.com/v1/pay', body = enc('{}'), wallet = w.address) => {
    const h = await signRequest({ method: 'POST', url, body, walletAddress: w.address }, requestSigner(dev));
    h.set('cappz-wallet', wallet);
    return new Request(url, { method: 'POST', headers: h, body });
  };
  return { w, dev, decl, signed };
}

describe('edge gateway: no out-of-memory trigger', () => {
  it('an oversized chunked body is refused while it streams (413), never buffered whole', async () => {
    let upstreamCalled = false;
    const gw = createVerifyGateway({ evidence: { evidenceFor: async () => ({ declarations: [] }) }, upstream: async () => { upstreamCalled = true; return new Response('x'); }, maxBodyBytes: 1024 * 1024 });
    const res = await gw.handle(stream('https://api.example.com/v1/upload', endless(64 * 1024 * 1024)));
    expect(res.status).toBe(413);
    expect(upstreamCalled).toBe(false);
    expect(await readBounded(stream('https://x/', endless(2048)), 1024)).toBeNull();
    expect((await readBounded(stream('https://x/', endless(1000)), 1024))!.length).toBe(1000);
  });

  it('the DMZ drop refuses a chunked body over its limit without reading it all', async () => {
    const gw = createLegacyGateway({ nodeAddress: 'n', store: memoryQuarantineStore(), maxBytes: 1024 * 1024 });
    expect((await gw.handle(stream('https://dmz/legacy/v1/drop/big.bin', endless(32 * 1024 * 1024)))).status).toBe(413);
  });

  it('multipart can be refused before it reaches a PHP upstream', async () => {
    const gw = createVerifyGateway({ evidence: { evidenceFor: async () => ({ declarations: [] }) }, upstream: async () => new Response('x'), denyMultipart: true });
    const res = await gw.handle(new Request('https://api.example.com/upload', { method: 'POST', body: '--b\r\n', headers: { 'content-type': 'multipart/form-data; boundary=b' } }));
    expect(res.status).toBe(415);
  });
});

describe('edge gateway: failures never weaken later requests', () => {
  it('unreadable evidence fails closed (503), it is never read as "no revocations"', async () => {
    const s = await signer();
    const gw = createVerifyGateway({ evidence: { evidenceFor: async () => { throw new Error('key-revocations.json unreadable and no good copy held'); } }, requireBound: false });
    const v = await gw.verifyRequest(await s.signed(), enc('{}'));
    expect(v).toEqual(expect.objectContaining({ allowed: false, status: 503, trust: 'evidence-unavailable' }));
  });

  it('a full replay cache refuses new signers (503) instead of forgetting nonces', async () => {
    const s = await signer();
    const gw = createVerifyGateway({ evidence: { evidenceFor: async () => ({ declarations: [s.decl] }) }, maxNonces: 3 });
    const verdicts = [];
    for (let i = 0; i < 5; i++) verdicts.push((await gw.verifyRequest(await s.signed(), enc('{}'))).status);
    expect(verdicts).toEqual([200, 200, 200, 503, 503]);
  });

  it('a verify fault in shadow mode is recorded and the legacy path still answers', async () => {
    const compare = createShadowComparison();
    const gw = createVerifyGateway({ evidence: { evidenceFor: async () => { throw new Error('boom'); } }, upstream: async () => new Response('legacy', { headers: { 'x-legacy-verdict': 'allow' } }), shadow: { compare, cost: { instanceUsdPerHour: 0.034, vcpus: 2, label: 'a' } } });
    const s = await signer();
    const res = await gw.handle(await s.signed());
    expect(await res.text()).toBe('legacy');
    expect(compare.state().counts['cappz-stricter']).toBe(1);
  });
});

describe('edge gateway: attacker-shaped input', () => {
  it('wallet headers that are not keys are malformed before any lookup or echo (no prototype keys, no header injection)', async () => {
    const s = await signer();
    const operator: Record<string, string[]> = { [s.w.address]: [s.dev.publicKeyHex] };
    const gw = createVerifyGateway({ evidence: { evidenceFor: async () => ({ declarations: [] }), operatorKeysFor: async (w) => (Object.prototype.hasOwnProperty.call(operator, w) ? operator[w] : []) } });
    for (const wallet of ['__proto__', 'constructor', '02' + 'ab'.repeat(32) + ' x']) {
      const v = await gw.verifyRequest(await s.signed(undefined, undefined, wallet), enc('{}'));
      expect(v.signature).toBe('malformed');
      expect(v.walletAddress).toBeUndefined();
    }
  });

  it('a presented declaration of the wrong shape is ignored, not dereferenced', async () => {
    const s = await signer();
    const gw = createVerifyGateway({ evidence: { evidenceFor: async () => ({ declarations: [] }) }, requireBound: true });
    for (const bad of [{ v: 1 }, { v: 2, walletAddress: s.w.address }, [1, 2], 'x', { v: 1, walletAddress: s.w.address, devicePublicKey: { toLowerCase: 1 } }]) {
      const r = await s.signed();
      r.headers.set('cappz-key-declaration', btoa(JSON.stringify(bad)));
      const v = await gw.verifyRequest(r, enc('{}'));
      expect(v.trust).toBe('undeclared');
    }
    expect(isDeclarationShape(s.decl)).toBe(true);
    // Stored evidence with junk entries: skipped, the good one still counts.
    const gw2 = createVerifyGateway({ evidence: { evidenceFor: async () => ({ declarations: [{ v: 1 } as never, null as never, s.decl] }) }, requireBound: true });
    expect((await gw2.verifyRequest(await s.signed(), enc('{}'))).trust).toBe('declared');
  });

  it('a crafted certificate length cannot shift past 32 bits or read past the buffer', async () => {
    // SEQUENCE with a 127-byte length-of-length, and one claiming 4 GB.
    await expect(parseCertificate(Uint8Array.of(0x30, 0xff, 1, 2, 3))).rejects.toThrow(/DER/);
    await expect(parseCertificate(Uint8Array.of(0x30, 0x84, 0xff, 0xff, 0xff, 0xff, 0))).rejects.toThrow(/DER/);
    const gw = createVerifyGateway({ evidence: { evidenceFor: async () => ({ declarations: [] }) } });
    const v = await gw.verifyRequest(new Request('https://x/', { headers: { 'x-ssl-client-cert': encodeURIComponent('-----BEGIN CERTIFICATE-----\nMIT/AQID\n-----END CERTIFICATE-----') } }));
    expect(v.signature).toBe('malformed');
    expect((await gw.verifyRequest(new Request('https://x/', { headers: { 'x-ssl-client-cert': 'A'.repeat(20_000) } }))).signature).toBe('malformed');
  });

  it('content verdicts reject non-hex inputs and oversized JSON', async () => {
    const gw = createVerifyGateway({ evidence: { evidenceFor: async () => ({ declarations: [] }) } });
    const v = await gw.verifyContent({ contentSha256: 'ab'.repeat(32), walletAddress: '__proto__', publicKey: 'x', signature: 'y' });
    expect(v.signature).toBe('malformed');
    const res = await gw.handle(new Request('https://x/cappz/verify/content', { method: 'POST', body: JSON.stringify({ pad: 'x'.repeat(100_000) }) }));
    expect(res.status).toBe(413);
  });
});

describe('evidence reload (found under load: a revoked key could pass at startup)', () => {
  it('concurrent first callers wait for the first load instead of getting an empty default', async () => {
    const { createReloader } = await import('../lib/identity/evidenceReload');
    let release!: (v: string[]) => void;
    const load = createReloader(() => new Promise<string[]>((r) => { release = r; }));
    const a = load(); const b = load();
    release(['revoked-key']);
    expect(await a).toEqual(['revoked-key']);
    expect(await b).toEqual(['revoked-key']);
  });
  it('a failed first load rejects (503 upstream); a failed refresh keeps the last good copy', async () => {
    const { createReloader } = await import('../lib/identity/evidenceReload');
    let t = 0; let fail = true; let value = ['r1'];
    const load = createReloader(async () => { if (fail) throw new Error('half-written'); return value; }, 1000, () => t);
    await expect(load()).rejects.toThrow('half-written');
    fail = false; t += 10;
    expect(await load()).toEqual(['r1']);
    fail = true; value = []; t += 2000;
    expect(await load()).toEqual(['r1']);
    await new Promise((r) => setTimeout(r, 0));
    expect(await load()).toEqual(['r1']); // still the last good copy, never the failed read
  });
});
