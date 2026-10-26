/** v15-10-00 — the SDK examples run as shipped: the TypeScript flow, and Python signing a drop the gateway verifies. */
import { describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateRecoveryPhrase, keyPairFromPhrase } from '../lib/auth/wallet/session';
import { declareKey } from '../lib/identity/keyDeclaration';
import { createVerifyGateway } from '../lib/identity/edgeVerify';
import { createLegacyGateway, memoryQuarantineStore } from '../lib/sync/transports/legacyGateway';
import type { KeyDeclaration } from '../lib/identity/keyDeclaration';

const hasPython = spawnSync('python3', ['-c', 'import cryptography'], { encoding: 'utf8' }).status === 0;

describe('SDK examples', () => {
  it('identity-flow.ts runs as shipped and every demo step passes', async () => {
    const out: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); });
    try { await import('../../packages/cappz-sdk/examples/identity-flow.ts'); } finally { spy.mockRestore(); }
    expect(out[0]).toContain('"state":"verified"');
    expect(out[1].split('\n').every((l) => l.startsWith('PASS'))).toBe(true);
  }, 60_000);

  it.skipIf(!hasPython)('sign_request.py signs an RFC 9421 drop that the edge gateway verifies against a wallet declaration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cappz-py-'));
    const script = 'packages/cappz-sdk/examples/sign_request.py';
    const pub = execFileSync('python3', [script, '--new-key', join(dir, 'device.key')], { encoding: 'utf8' }).trim();
    const wallet = keyPairFromPhrase(generateRecoveryPhrase());
    const decl = await declareKey(wallet.privateKey, wallet.address, { publicKey: pub, algorithm: 'ed25519', purpose: 'signing' });
    writeFileSync(join(dir, 'declaration.json'), JSON.stringify(decl));
    writeFileSync(join(dir, 'statement.xml'), '<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"/>');
    const declarations: KeyDeclaration[] = [];
    const gw = createLegacyGateway({ nodeAddress: 'node', store: memoryQuarantineStore(), verify: createVerifyGateway({ evidence: { evidenceFor: async () => ({ declarations }) } }) });
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      const r = await gw.handle(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body: chunks.length ? Buffer.concat(chunks) : undefined }));
      res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const port = (server.address() as { port: number }).port;
    // Async child process: the gateway answers from this same process, so a blocking spawn would deadlock.
    const run = (name: string, withDecl: boolean) => new Promise<string>((ok) => {
      const args = [script, '--key', join(dir, 'device.key'), '--wallet', wallet.address, '--url', `http://127.0.0.1:${port}/legacy/v1/drop/${name}`, '--file', join(dir, 'statement.xml'), '--content-type', 'application/xml', ...(withDecl ? ['--declaration', join(dir, 'declaration.json')] : [])];
      execFile('python3', args, { encoding: 'utf8' }, (_err, stdout, stderr) => ok(String(stdout) + String(stderr)));
    });
    try {
      // The declaration travels in the request header: no stored state on the node.
      const out = await run('a.xml', true);
      expect(out).toMatch(/^201 /);
      const receipt = JSON.parse(out.slice(4));
      expect(receipt.checks.find((c: { check: string }) => c.check === 'sender-signature')).toEqual(expect.objectContaining({ result: 'pass' }));
    } finally { server.close(); }
  }, 60_000);
});
