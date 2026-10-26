/** v15-11-00 — CAPPZ keys vs X.509, measured; shadow verification of a legacy (PHP) route with a retire gate. */
import { describe, it, expect } from 'vitest';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTrustComparison, DEFAULT_COMPARISON_ASSUMPTIONS, TRADEOFFS, buildPki, signCrl, verifyX509 } from '../lib/identity/trustComparison';
import { createShadowComparison, readLegacyVerdict, DEFAULT_RETIRE_POLICY } from '../lib/identity/shadowCompare';
import { createVerifyGateway, requestSigner, signRequest } from '../lib/identity/edgeVerify';
import { declareKey, revokeKeyDeclaration, type KeyDeclaration, type KeyRevocation } from '../lib/identity/keyDeclaration';
import { generateRecoveryPhrase, keyPairFromPhrase } from '../lib/auth/wallet/session';
import { generateSigningKey } from '../lib/sync/helloSignature';
import { createLegacyGateway, memoryQuarantineStore } from '../lib/sync/transports/legacyGateway';
import { fileURLToPath } from 'node:url';

// Repo-relative files resolve from this file, so the tests run from any working directory (also as a submodule).
const ROOT = join(fileURLToPath(import.meta.url), '../../..');

const hasPhp = spawnSync('php', ['-r', 'exit(function_exists("sodium_crypto_sign_verify_detached") ? 0 : 1);']).status === 0;
const cost = { instanceUsdPerHour: 0.034, vcpus: 2, label: 'assumption' };

describe('CAPPZ key declarations vs X.509 client certificates', () => {
  it('the X.509 baseline is a real chain: valid, revoked, expired and wrong-issuer are told apart', async () => {
    const now = Date.now();
    const pki = await buildPki(now);
    const crl = await signCrl(pki, [], now, 24);
    expect(await verifyX509(pki, pki.leafDer, crl, now)).toBe('valid');
    expect(await verifyX509(pki, pki.leafDer, await signCrl(pki, [pki.leafSerial], now, 24), now)).toBe('revoked');
    expect(await verifyX509(pki, pki.leafDer, crl, now + 400 * 86400_000)).toBe('expired');
    const other = await buildPki(now);
    expect(await verifyX509(pki, other.leafDer, crl, now)).toBe('bad-chain');
  });

  it('after a revocation, X.509 with a cached CRL keeps accepting for hours; CAPPZ refuses once the record arrives', async () => {
    const r = await runTrustComparison({ iterations: 30 });
    const at = (k: string) => r.timeline.find((p) => p.at === k)!;
    expect(at('just before')).toEqual(expect.objectContaining({ x509: 'valid', cappz: '200 declared' }));
    expect(at('+1 minute')).toEqual(expect.objectContaining({ x509: 'valid', cappz: '403 revoked' }));
    expect(at('+12 hours').x509).toBe('valid');           // still inside the CRL the verifier holds
    expect(at('+1 day')).toEqual(expect.objectContaining({ x509: 'revoked', cappz: '403 revoked' }));
    const exp = r.exposure(DEFAULT_COMPARISON_ASSUMPTIONS);
    expect(exp.find((e) => e.mechanism === 'cappz')!.seconds).toBeLessThan(exp.find((e) => e.label.includes('CRL'))!.seconds);
    for (const p of [r.measured.x509Warm, r.measured.cappzWarm]) expect(p.p50).toBeGreaterThan(0);
    const c = r.cost(DEFAULT_COMPARISON_ASSUMPTIONS);
    expect(c.find((x) => x.mechanism === 'cappz')!.credentialsUsdPerMillion).toBe(0);
    expect(c.find((x) => x.mechanism === 'x509')!.credentialsUsdPerMillion).toBeGreaterThan(0);
    // Honest: where X.509 must stay is listed.
    expect(TRADEOFFS.filter((t) => t.edge === 'x509').map((t) => t.aspect)).toEqual(expect.arrayContaining(['Public websites (browser HTTPS)', 'Regulated credentials']));
    // Every place X.509 stays says whether policy or technology keeps it, and how the limit could be lifted.
    for (const t of TRADEOFFS.filter((x) => x.edge === 'x509')) expect(t.constraint?.why && t.constraint.path, t.aspect).toBeTruthy();
    expect(TRADEOFFS.find((t) => t.aspect === 'Regulated credentials')!.constraint!.kind).toBe('policy');
  }, 60_000);
});

async function walletWithKey() {
  const w = keyPairFromPhrase(generateRecoveryPhrase()); const dev = await generateSigningKey();
  const decl = await declareKey(w.privateKey, w.address, { publicKey: dev.publicKeyHex, algorithm: 'ed25519', purpose: 'signing' });
  return { w, dev, decl };
}

describe('shadow verification of a legacy route', () => {
  it('records agreement, classifies disagreements, and gates retirement on evidence', async () => {
    let t = Date.parse('2026-10-01T00:00:00Z');
    const compare = createShadowComparison({ now: () => t, policy: { ...DEFAULT_RETIRE_POLICY, minRequests: 6, minDays: 1, minDenials: 1 } });
    const ok = { allowed: true, signature: 'verified' as const, trust: 'declared' as const, content: 'digest-match' as const };
    const revoked = { allowed: false, signature: 'verified' as const, trust: 'revoked' as const, content: 'digest-match' as const };
    const bad = { allowed: false, signature: 'bad-signature' as const, trust: 'undeclared' as const, content: 'not-checked' as const };
    expect(compare.record({ cappz: ok, cappzMs: 0.2, legacy: 'allow', legacyMs: 1.1, path: '/api/pay' })).toBe('agree');
    expect(compare.record({ cappz: revoked, cappzMs: 0.2, legacy: 'allow', legacyMs: 1.0, path: '/api/pay' })).toBe('cappz-stricter');
    expect(compare.record({ cappz: bad, cappzMs: 0.1, legacy: 'deny', legacyMs: 0.9, path: '/api/pay' })).toBe('agree');
    let r = await compare.report(cost);
    expect(r.retire.ready).toBe(false);
    expect(r.stricterReasons).toEqual({ revoked: 1 });
    t += 2 * 86400_000;
    for (let i = 0; i < 4; i++) compare.record({ cappz: ok, cappzMs: 0.2, legacy: 'allow', legacyMs: 1, path: '/api/pay' });
    r = await compare.report(cost);
    expect(r.retire).toEqual({ ready: true, because: [expect.stringContaining('every gate passed')] });
    expect(r.reportHash).toMatch(/^[0-9a-f]{64}$/);
    // One looser verdict blocks retirement until explained.
    compare.record({ cappz: ok, cappzMs: 0.2, legacy: 'deny', legacyMs: 1, path: '/api/admin' });
    r = await compare.report(cost);
    expect(r.retire.ready).toBe(false);
    expect(r.looserSamples[0].path).toBe('/api/admin');
  });

  it('reads the legacy verdict and Server-Timing from the route response', () => {
    const r = readLegacyVerdict(new Response('', { headers: { 'x-legacy-verdict': 'deny', 'server-timing': 'db;dur=3, verify;dur=0.82' } }));
    expect(r).toEqual({ verdict: 'deny', ms: 0.82 });
    expect(readLegacyVerdict(new Response('')).verdict).toBe('missing');
  });

  it.skipIf(!hasPhp)('against the real PHP route: same verdicts on good and bad traffic; CAPPZ stricter only on revocation and replay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cappz-php-'));
    const { w, dev, decl } = await walletWithKey();
    writeFileSync(join(dir, 'keys.json'), JSON.stringify({ [w.address]: [dev.publicKeyHex] }));
    const port = 40000 + Math.floor(Math.random() * 20000);
    const php = spawn('php', ['-S', `127.0.0.1:${port}`, join(ROOT, 'packages/cappz-sdk/examples/php/verify_route.php')], { env: { ...process.env, CAPPZ_PHP_KEYS: join(dir, 'keys.json') }, stdio: 'ignore' });
    try {
      for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
      const declarations: KeyDeclaration[] = [decl]; const revocations: KeyRevocation[] = [];
      const compare = createShadowComparison({ policy: { ...DEFAULT_RETIRE_POLICY, minRequests: 1, minDays: 0, minDenials: 1 } });
      const gw = createVerifyGateway({ evidence: { evidenceFor: async () => ({ declarations, revocations }) }, requireBound: true, upstream: `http://127.0.0.1:${port}`, shadow: { compare, cost } });
      const send = async (o: { body?: string; tamper?: boolean; key?: Awaited<ReturnType<typeof generateSigningKey>>; reuse?: Request } = {}) => {
        if (o.reuse) return gw.handle(o.reuse);
        const body = new TextEncoder().encode(o.body ?? '{"amount":"10.00"}');
        const h = await signRequest({ method: 'POST', url: 'http://api.example.com/api/pay', body, walletAddress: w.address }, requestSigner(o.key ?? dev));
        const req = new Request('http://api.example.com/api/pay', { method: 'POST', headers: h, body: o.tamper ? new TextEncoder().encode('{"amount":"99999"}') : body });
        return gw.handle(req);
      };
      expect((await send()).status).toBe(200);                       // both allow
      expect((await send({ tamper: true })).status).toBe(401);       // both deny: digest mismatch
      expect((await send({ key: await generateSigningKey() })).status).toBe(401); // both deny: key not listed / undeclared
      const h = await signRequest({ method: 'POST', url: 'http://api.example.com/api/pay', body: new TextEncoder().encode('{}'), walletAddress: w.address }, requestSigner(dev));
      const first = new Request('http://api.example.com/api/pay', { method: 'POST', headers: h, body: '{}' });
      const again = new Request('http://api.example.com/api/pay', { method: 'POST', headers: h, body: '{}' });
      await send({ reuse: first });
      expect((await send({ reuse: again })).status).toBe(200);        // PHP keeps no replay memory: allows; CAPPZ: replayed
      revocations.push(await revokeKeyDeclaration(w.privateKey, decl, 'laptop lost'));
      expect((await send()).status).toBe(200);                       // PHP's key file still lists it; CAPPZ: revoked
      const r = await compare.report(cost);
      expect(r.counts).toEqual(expect.objectContaining({ agree: 4, 'cappz-stricter': 2, 'cappz-looser': 0, 'legacy-missing': 0 }));
      expect(r.stricterReasons).toEqual({ replayed: 1, revoked: 1 });
      expect(r.latencyMs.legacy.p50).toBeGreaterThan(0);
      expect(r.retire.ready).toBe(true);
    } finally { php.kill(); }
  }, 60_000);

  it.skipIf(!hasPhp)('cappz_drop.php signs a drop the edge gateway verifies (PHP example now runs)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cappz-phpdrop-'));
    const script = join(ROOT, 'packages/cappz-sdk/examples/cappz_drop.php');
    const pub = await new Promise<string>((ok) => execFile('php', [script, '--new-key', join(dir, 'device.key')], (_e, out) => ok(String(out).trim())));
    const w = keyPairFromPhrase(generateRecoveryPhrase());
    writeFileSync(join(dir, 'decl.json'), JSON.stringify(await declareKey(w.privateKey, w.address, { publicKey: pub, algorithm: 'ed25519', purpose: 'signing' })));
    writeFileSync(join(dir, 'statement.xml'), '<?xml version="1.0"?><Document/>');
    const gw = createLegacyGateway({ nodeAddress: 'node', store: memoryQuarantineStore(), verify: createVerifyGateway({ evidence: { evidenceFor: async () => ({ declarations: [] }) } }) });
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      const r = await gw.handle(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body: chunks.length ? Buffer.concat(chunks) : undefined }));
      res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const port = (server.address() as { port: number }).port;
    try {
      const out = await new Promise<string>((ok) => execFile('php', [script, join(dir, 'device.key'), w.address, `http://127.0.0.1:${port}/legacy/v1/drop/statement.xml`, join(dir, 'statement.xml'), join(dir, 'decl.json')], (_e, so, se) => ok(String(so) + String(se))));
      expect(out).toMatch(/^201 /);
      expect(JSON.parse(out.slice(4)).checks.find((c: { check: string }) => c.check === 'sender-signature').result).toBe('pass');
    } finally { server.close(); }
  }, 60_000);
});
