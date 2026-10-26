import { describe, it, expect } from 'vitest';
import { generateRecoveryPhrase, keyPairFromPhrase } from '../lib/auth/wallet/session';
import { generateSigningKey } from '../lib/sync/helloSignature';
import { declareHelloKey } from '../lib/sync/helloKeyDeclaration';
import { declareKey, declarationHash, delegateKey, revokeKeyDeclaration, type KeyDeclaration, type KeyDelegation, type KeyEvidence, type KeyRevocation } from '../lib/identity/keyDeclaration';
import type { HelloKeyDeclaration } from '../lib/sync/helloKeyDeclaration';
import { createVerifyGateway, signRequest, requestSigner, signContentHash, checkContentDigest } from '../lib/identity/edgeVerify';
import { issueSelfSignedCertificate, KEYDECL_URI_PREFIX } from '../lib/identity/x509';
import { didKeyFor } from '../lib/identity/didKey';
import { toHex } from '../lib/identity/canonical';

const enc = (s: string) => new TextEncoder().encode(s);

async function setup(evidence: Partial<KeyEvidence> = {}, opts: { requireBound?: boolean; operator?: string[] } = {}) {
  const w = keyPairFromPhrase(generateRecoveryPhrase());
  const dev = await generateSigningKey();
  const store = { declarations: [...(evidence.declarations ?? [])] as Array<HelloKeyDeclaration | KeyDeclaration>, revocations: [] as KeyRevocation[], delegations: [] as KeyDelegation[] };
  const forwarded: Request[] = [];
  const gw = createVerifyGateway({
    evidence: { evidenceFor: async () => store, operatorKeysFor: async () => opts.operator ?? null },
    requireBound: opts.requireBound,
    upstream: async (r) => { forwarded.push(r); return new Response('origin ok'); },
  });
  const signed = async (body = 'hello', url = 'https://api.example.com/v1/orders', declaration?: Parameters<typeof signRequest>[0]['declaration']) => {
    const b = enc(body);
    const h = await signRequest({ method: 'POST', url, body: b, walletAddress: w.address, declaration }, requestSigner(dev));
    return new Request(url, { method: 'POST', headers: h, body: b });
  };
  return { w, dev, store, gw, signed, forwarded };
}

describe('v15-09-00 edge verification gateway', () => {
  it('a wallet-declared device key passes; the origin receives verified headers and cannot be spoofed', async () => {
    const s = await setup();
    s.store.declarations.push(await declareHelloKey(s.w.privateKey, s.w.address, s.dev.publicKeyHex));
    const req = await s.signed();
    req.headers.set('cappz-verified-trust', 'declared'); // a client trying to pre-set the verdict
    const res = await s.gw.handle(req);
    expect(res.status).toBe(200);
    const f = s.forwarded[0];
    expect(f.headers.get('cappz-verified-signature')).toBe('verified');
    expect(f.headers.get('cappz-verified-trust')).toBe('declared');
    expect(f.headers.get('cappz-verified-content')).toBe('digest-match');
    expect(f.headers.get('cappz-verified-anchor')).toBe('unchecked');
    expect(await f.text()).toBe('hello');
  });

  it('replay, tampered body, tampered path and stale signatures are refused with their own states', async () => {
    const s = await setup();
    s.store.declarations.push(await declareHelloKey(s.w.privateKey, s.w.address, s.dev.publicKeyHex));
    const req = await s.signed();
    const again = req.clone();
    expect((await s.gw.handle(req)).status).toBe(200);
    expect((await s.gw.verifyRequest(again, enc('hello'))).signature).toBe('replayed');
    const r2 = await s.signed('hello');
    expect((await s.gw.verifyRequest(r2, enc('tampered'))).content).toBe('digest-mismatch');
    const r3 = await s.signed();
    const moved = new Request('https://api.example.com/v1/admin', { method: 'POST', headers: r3.headers, body: 'hello' });
    expect((await s.gw.verifyRequest(moved, enc('hello'))).signature).toBe('bad-signature');
    const stale = await signRequest({ method: 'GET', url: 'https://a.example/x', walletAddress: s.w.address }, requestSigner(s.dev), Date.now() - 3600_000);
    expect((await s.gw.verifyRequest(new Request('https://a.example/x', { headers: stale }))).signature).toBe('stale');
    expect((await s.gw.verifyRequest(new Request('https://a.example/x'))).signature).toBe('unsigned');
  });

  it('revocation takes effect on the next request; undeclared keys pass only when binding is not required', async () => {
    const s = await setup({}, { requireBound: true });
    const d = await declareKey(s.w.privateKey, s.w.address, { publicKey: s.dev.publicKeyHex, algorithm: 'ed25519', purpose: 'signing' });
    s.store.declarations.push(d);
    expect((await s.gw.verifyRequest(await s.signed(), enc('hello'))).trust).toBe('declared');
    s.store.revocations.push(await revokeKeyDeclaration(s.w.privateKey, d, 'laptop stolen'));
    const v = await s.gw.verifyRequest(await s.signed(), enc('hello'));
    expect(v).toEqual(expect.objectContaining({ trust: 'revoked', status: 403, allowed: false }));
    const open = await setup();
    expect((await open.gw.verifyRequest(await open.signed(), enc('hello')))).toEqual(expect.objectContaining({ trust: 'undeclared', allowed: true }));
    const strict = await setup({}, { requireBound: true });
    expect((await strict.gw.verifyRequest(await strict.signed(), enc('hello'))).status).toBe(403);
  });

  it('a declaration presented in the request header binds the key without any stored state', async () => {
    const s = await setup({}, { requireBound: true });
    const d = await declareHelloKey(s.w.privateKey, s.w.address, s.dev.publicKeyHex);
    const v = await s.gw.verifyRequest(await s.signed('hello', undefined, d), enc('hello'));
    expect(v.trust).toBe('declared');
  });

  it('legacy operator key lists are honoured but reported as operator-listed', async () => {
    const t = await setup({}, { requireBound: true });
    const listed = createVerifyGateway({ evidence: { evidenceFor: async () => ({ declarations: [] }), operatorKeysFor: async () => [t.dev.publicKeyHex] }, requireBound: true });
    expect((await listed.verifyRequest(await t.signed(), enc('hello')))).toEqual(expect.objectContaining({ trust: 'operator-listed', allowed: true }));
  });

  it('auth_request mode answers 204 with headers; the origin checks the body against the signed digest', async () => {
    const s = await setup();
    const h = await signRequest({ method: 'POST', url: 'https://api.example.com/v1/orders', body: enc('payload'), walletAddress: s.w.address }, requestSigner(s.dev));
    const auth = (host: string) => new Request('http://127.0.0.1:41446/cappz/verify', { headers: new Headers([...h, ['x-original-uri', '/v1/orders'], ['x-original-method', 'POST'], ['x-original-host', host]]) });
    const res = await s.gw.handle(auth('api.example.com'));
    expect(res.status).toBe(204);
    expect(res.headers.get('cappz-verified-content')).toBe('signed-digest');
    expect(await checkContentDigest(enc('payload'), h.get('content-digest'))).toBe(true);
    expect(await checkContentDigest(enc('other'), h.get('content-digest'))).toBe(false);
    // The same signature presented for another host does not verify.
    expect((await s.gw.handle(auth('evil.example.com'))).status).toBe(401);
  });

  it('mTLS: a wallet-projected client certificate is trusted as far as its delegated TLS key', async () => {
    const s = await setup();
    s.store.declarations.push(await declareHelloKey(s.w.privateKey, s.w.address, s.dev.publicKeyHex));
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const raw = toHex(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)));
    const dl = await delegateKey(s.dev, s.w.address, { publicKey: raw, algorithm: 'p256', purpose: 'tls' });
    s.store.delegations.push(dl);
    const cert = await issueSelfSignedCertificate({ keyPair: kp, algorithm: 'p256', commonName: 'client', uris: [didKeyFor('secp256k1', s.w.address), `${KEYDECL_URI_PREFIX}${await declarationHash(s.store.declarations[0])}`], notAfter: new Date(Date.now() + 86400_000) });
    const req = new Request('https://api.example.com/x', { headers: { 'x-ssl-client-cert': encodeURIComponent(cert.pem) } });
    expect(await s.gw.verifyRequest(req)).toEqual(expect.objectContaining({ signature: 'mtls', trust: 'delegated', allowed: true, walletAddress: s.w.address }));
    // A certificate without a wallet SAN gets mtls/undeclared, never declared.
    const bare = await issueSelfSignedCertificate({ keyPair: kp, algorithm: 'p256', commonName: 'client', notAfter: new Date(Date.now() + 86400_000) });
    expect((await s.gw.verifyRequest(new Request('https://x/', { headers: { 'x-ssl-client-cert': encodeURIComponent(bare.pem) } }))).trust).toBe('undeclared');
  });

  it('content verdicts: a detached signature over a hash, cached by hash; key trust re-read each time', async () => {
    const s = await setup();
    const d = await declareKey(s.w.privateKey, s.w.address, { publicKey: s.dev.publicKeyHex, algorithm: 'ed25519', purpose: 'signing' });
    s.store.declarations.push(d);
    const h = 'ab'.repeat(32);
    const sig = await signContentHash(h, s.dev);
    const res = await s.gw.handle(new Request('http://n/cappz/verify/content', { method: 'POST', body: JSON.stringify({ contentSha256: h, walletAddress: s.w.address, publicKey: s.dev.publicKeyHex, signature: sig }) }));
    expect(res.status).toBe(200);
    expect((await res.json()).trust).toBe('declared');
    s.store.revocations.push(await revokeKeyDeclaration(s.w.privateKey, d, 'rotated'));
    expect((await s.gw.verifyContent({ contentSha256: h, walletAddress: s.w.address, publicKey: s.dev.publicKeyHex, signature: sig })).trust).toBe('revoked');
    expect((await s.gw.verifyContent({ contentSha256: 'cd'.repeat(32), walletAddress: s.w.address, publicKey: s.dev.publicKeyHex, signature: sig })).signature).toBe('bad-signature');
  });
});
