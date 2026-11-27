// @vitest-environment node
// The edge node's paid agents (packages/cappz-edge-node/agents, 15.43.0): served docs are
// complete for both networks, and the shipped verifier agrees with signEdgeTx.
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DOC_FILES, docVars, renderDoc, unfilled } from '../../packages/cappz-edge-node/agents/docs';
import { signEdgeTx } from '../lib/functions/edgeJobs';
import { declareKey, declarationHash, revokeKeyDeclaration } from '../lib/identity/keyDeclaration';
import * as secp from '@noble/secp256k1';
import { decodeSeed, deriveAddress, Wallet } from 'xrpl';

const dir = resolve(__dirname, '../../packages/cappz-edge-node/agents');
const template = (f: string) => readFileSync(join(dir, 'docs', f), 'utf8');
/** Hosts a shipped file names, other than public CAPPZ/XRPL/GitHub ones: a node's own name belongs in its settings, never in the code. */
const ALLOWED_HOSTS = new Set(['cappz.ai', 'github.com', 'raw.githubusercontent.com', 'xrpl.org', '127.0.0.1', /* public XRPL servers verify.mjs reads (15.45.0) */ 'xrplcluster.com', 's1.ripple.com', 's.altnet.rippletest.net', 's.devnet.rippletest.net', /* Xaman */ 'xumm.app', 'apps.xumm.dev', 'xaman.app']);
const hostsIn = (text: string) => [...new Set([...text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase()))].filter((h) => !ALLOWED_HOSTS.has(h));
const settings = (network: 'mainnet' | 'testnet') => ({
  publicBase: network === 'mainnet' ? 'https://node.example.com/agents' : 'https://node.example.com/testnet/agents',
  peerBase: network === 'mainnet' ? 'https://node.example.com/testnet/agents' : 'https://node.example.com/agents',
  network, payTo: 'rExamplePayout', nodePublicKeyHex: 'ab'.repeat(32), timestampPrice: 0.05, webhookPrice: 2, webhookDays: 30,
});

describe('edge node paid agents: docs', () => {
  it('every template fills completely on both networks, naming no particular node', () => {
    for (const network of ['mainnet', 'testnet'] as const) {
      const vars = docVars(settings(network));
      for (const { file } of Object.values(DOC_FILES)) {
        const t = template(file);
        expect(unfilled(t, vars), file).toEqual([]);
        expect(renderDoc(t, vars)).not.toMatch(/\{\{[A-Z_]+\}\}/);
        expect(hostsIn(t), file).toEqual([]);
      }
      expect(renderDoc(template('llms.txt'), vars)).toContain(`The same agents run on ${network === 'mainnet' ? 'testnet' : 'mainnet'}`);
    }
    expect(hostsIn(readFileSync(join(dir, 'server.ts'), 'utf8'))).toEqual([]);
  });

  it('webhook stages add up to the price; prices print without float noise', () => {
    const v = docVars({ ...settings('mainnet'), webhookPrice: 2 });
    expect([v.WH_DEPOSIT, v.WH_REST]).toEqual(['0.6', '1.4']);
    expect(docVars({ ...settings('mainnet'), webhookPrice: 0.1 }).WH_REST).toBe('0.07');
    expect(v.HOST).toBe('node.example.com');
    expect(v.PEER_NETWORK).toBe('testnet');
  });

  it('each served SKILL.md is a valid Agent Skill (name, third-person description with when-to-use)', () => {
    for (const f of ['timestamp.SKILL.md', 'webhook.SKILL.md', 'draw.SKILL.md', 'vault-check.SKILL.md', 'vault-guard.SKILL.md']) {
      const md = renderDoc(template(f), docVars(settings('mainnet')));
      const fm = /^---\nname: ([a-z0-9-]{1,64})\ndescription: (.+)\n---\n/.exec(md)!;
      expect(fm, f).not.toBeNull();
      expect(fm[2].length).toBeLessThanOrEqual(1024);
      expect(fm[2]).toMatch(/Use when/);
      expect(md).toContain('payload.network');
    }
  });
});

describe('edge node paid agents: durable jobs', () => {
  it('the launcher lets the agents read back what they write, and the server never takes a read error for "no jobs"', () => {
    // 15.43.1: 15.43.0's launcher granted --allow-read on the SDK only, so a paid result came back empty and a restart forgot every job.
    const launcher = readFileSync(join(dir, 'run-agents.ps1'), 'utf8');
    // 15.44.0: plus the node's key declarations and revocations (read only).
    // 16.5.0: plus the sealed store's drive (read and write) when CAPPZ_SEALED_STORE_DIR is set.
    expect(launcher).toMatch(/--allow-read=`"\$sdk`",`"\$data`",`"\$decl`",`"\$revs`"\$sealedGrant --allow-write=`"\$data`"\$sealedGrant/);
    const server = readFileSync(join(dir, 'server.ts'), 'utf8');
    expect(server.split('\n').filter((l) => /Deno\.read/.test(l) && /catch\s*\{/.test(l))).toEqual([]);
    expect(server.match(/catch \(e\) \{ onlyMissing\(e\);/g)).toHaveLength(6); // 15.47.0: + the draw commitment log and public results; 15.49.0: + the vault guard's logs (readJsonl)
  });
});

describe('edge node paid agents: verify.mjs', () => {
  const keyPair = async () => {
    const k = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey));
    return { privateKey: k.privateKey, publicKeyHex: Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join('') };
  };
  const tx = (eventType: string, payload: Record<string, unknown>) => ({ txId: `${eventType}-1`, timestamp: '2026-11-14T00:00:00.000Z', eventType, sourceAddress: 'rNode', targetAddress: 'rNode/x', payload: { governingPrinciple: 'test', ...payload } });
  const tmp = mkdtempSync(join(tmpdir(), 'cappz-verify-'));
  const verify = (doc: unknown, ...args: string[]) => {
    const file = join(tmp, `${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify(doc));
    const r = spawnSync(process.execPath, [join(dir, 'docs', 'verify.mjs'), file, ...args], { encoding: 'utf8' });
    return { code: r.status, out: r.stdout };
  };

  it('accepts a receipt signEdgeTx made, rejects an edited one or the wrong signer, and flags test records', async () => {
    const key = await keyPair();
    const receipt = await signEdgeTx(tx('HashTimestamped', { sha256: 'a'.repeat(64), note: null, network: 'mainnet' }), key);
    expect(verify({ receipt }, key.publicKeyHex)).toMatchObject({ code: 0 });
    expect(verify({ receipt: { ...receipt, payload: { ...receipt.payload, note: 'edited' } } }).code).toBe(1);
    expect(verify({ receipt }, 'cd'.repeat(32)).code).toBe(1);
    const test = await signEdgeTx(tx('HashTimestamped', { sha256: 'b'.repeat(64), network: 'testnet' }), key);
    const r = verify({ receipt: test });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/network testnet .*TEST record/);
  });

  it('checks a webhook bundle covers exactly its records', async () => {
    const key = await keyPair();
    const records = await Promise.all([1, 2, 3].map((n) => signEdgeTx(tx('WebhookReceived', { n, network: 'mainnet' }), key)));
    const sha = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))), (b) => b.toString(16).padStart(2, '0')).join('');
    const bundle = await signEdgeTx(tx('WebhookPeriodClosed', { count: 3, recordsSha256: await sha(JSON.stringify(records)), periodStart: 's', periodEnd: 'e', network: 'mainnet' }), key);
    expect(verify({ bundle, records }).code).toBe(0);
    expect(verify({ bundle, records: records.slice(0, 2) }).code).toBe(1);
  });

  // 15.49.0: vault reports. Found on the live node: verify.mjs read {report} as a bare record and printed INVALID.
  it('verifies a vault check report and a guard period report with its decisions and alerts', async () => {
    const key = await keyPair();
    const sha = async (x: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(x))), (b) => b.toString(16).padStart(2, '0')).join('');
    const report = await signEdgeTx(tx('VaultChecked', { account: 'rVault', state: 'guard-load-bearing', findings: [], network: 'mainnet' }), key);
    const ok = verify({ report }, key.publicKeyHex);
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/VaultChecked for rVault: guard-load-bearing/);
    expect(verify({ report: { ...report, payload: { ...report.payload, state: 'edited' } } }).code).toBe(1);
    const decisions = await Promise.all([true, false].map((approved) => signEdgeTx(tx('VaultCosignDecided', { account: 'rVault', approved, network: 'mainnet' }), key)));
    const alerts = [await signEdgeTx(tx('VaultOutflowUnapproved', { account: 'rVault', hash: 'H', network: 'mainnet' }), key)];
    const period = await signEdgeTx(tx('VaultGuardPeriodClosed', { account: 'rVault', decisions: 2, decisionsSha256: await sha(JSON.stringify(decisions)), setupAtEnd: 'guard-load-bearing', network: 'mainnet' }), key);
    expect(verify({ report: period, decisions, alerts }).code).toBe(0);
    expect(verify({ report: period, decisions: decisions.slice(0, 1), alerts }).code).toBe(1);
    expect(verify({ report: period, decisions: [{ ...decisions[0], payload: { ...decisions[0].payload, approved: false } }, decisions[1]], alerts }).code).toBe(1);
  });

  // 15.44.0: a wallet, not the website's certificate, vouches for the signer.
  describe('wallet declarations (KeyZ)', () => {
    const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    const wallet = () => { const priv = secp.utils.randomSecretKey(); const pub = toHex(secp.getPublicKey(priv, true)); return { priv, pub, address: deriveAddress(pub.toUpperCase()) }; };
    const now = Date.parse('2026-11-14T00:00:00.000Z') - 3600_000;
    const declared = async (w: ReturnType<typeof wallet>, nodePub: string) => {
      const declaration = await declareKey(w.priv, w.pub, { publicKey: nodePub, algorithm: 'ed25519', purpose: 'signing' }, undefined, now);
      return { declaration, hash: await declarationHash(declaration) };
    };

    it('shows the declaring wallet’s XRPL address (as xrpl derives it) and can require it', async () => {
      const key = await keyPair(); const w = wallet();
      const { declaration, hash } = await declared(w, key.publicKeyHex);
      const receipt = await signEdgeTx(tx('HashTimestamped', { sha256: 'c'.repeat(64), network: 'mainnet', signerDeclaration: hash }), key);
      const ok = verify({ receipt, declarations: [declaration], revocations: [] }, w.address);
      expect(ok.out).toContain(`declared by wallet ${w.address}`);
      expect(ok.code).toBe(0);
      expect(verify({ receipt, declarations: [declaration] }, w.pub).code).toBe(0);
      expect(verify({ receipt, declarations: [declaration] }, wallet().address).code).toBe(1);
      expect(verify({ receipt }, w.address).code).toBe(1); // no declaration: the address cannot be shown
    });

    it('an XRPL family-seed account declares as itself (the payout account can be the anchor)', async () => {
      const seed = Wallet.generate('ecdsa-secp256k1' as never).seed!; const xw = Wallet.fromSeed(seed, { algorithm: (decodeSeed(seed).type === 'ed25519' ? 'ed25519' : 'ecdsa-secp256k1') as never }); // as tools/declare-node-key.ts reads it
      const key = await keyPair();
      const declaration = await declareKey(Uint8Array.from(Buffer.from(xw.privateKey.replace(/^00/, ''), 'hex')), xw.publicKey.toLowerCase(), { publicKey: key.publicKeyHex, algorithm: 'ed25519', purpose: 'signing' }, undefined, now);
      const receipt = await signEdgeTx(tx('HashTimestamped', { sha256: 'd'.repeat(64), network: 'mainnet', signerDeclaration: await declarationHash(declaration) }), key);
      expect(verify({ receipt, declarations: [declaration] }, xw.classicAddress).code).toBe(0);
    });

    it('refuses a forged wallet signature, a declaration of another key, and a revoked declaration', async () => {
      const key = await keyPair(); const w = wallet();
      const { declaration, hash } = await declared(w, key.publicKeyHex);
      const receipt = await signEdgeTx(tx('HashTimestamped', { sha256: 'e'.repeat(64), network: 'mainnet', signerDeclaration: hash }), key);
      const forged = { ...declaration, signature: declaration.signature.slice(0, -2) + (declaration.signature.endsWith('00') ? '01' : '00') };
      expect(verify({ receipt, declarations: [forged] }, w.address).code).toBe(1);
      const other = await declared(w, (await keyPair()).publicKeyHex);
      const r2 = await signEdgeTx(tx('HashTimestamped', { sha256: 'e'.repeat(64), network: 'mainnet', signerDeclaration: other.hash }), key);
      expect(verify({ receipt: r2, declarations: [other.declaration] }, w.address).code).toBe(1);
      const revocation = await revokeKeyDeclaration(w.priv, declaration, 'key leaked', now + 1000);
      const revoked = verify({ receipt, declarations: [declaration], revocations: [revocation] });
      expect(revoked.code).toBe(1);
      expect(revoked.out).toMatch(/REVOKED/);
      // a revocation published later, passed as fresher evidence, also refuses
      const evidence = join(tmp, 'evidence.json'); writeFileSync(evidence, JSON.stringify({ declarations: [declaration], revocations: [revocation] }));
      expect(verify({ receipt, declarations: [declaration] }, w.address, '--evidence', evidence).code).toBe(1);
      // a revocation the wallet did not sign changes nothing
      expect(verify({ receipt, declarations: [declaration], revocations: [{ ...revocation, signature: forged.signature }] }, w.address).code).toBe(0);
    });

    it('a bundle needs every record declared by the same wallet', async () => {
      const key = await keyPair(); const w = wallet();
      const { declaration, hash } = await declared(w, key.publicKeyHex);
      const records = await Promise.all([1, 2].map((n) => signEdgeTx(tx('WebhookReceived', { n, network: 'mainnet', signerDeclaration: hash }), key)));
      const sha = async (s: string) => toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
      const bundle = await signEdgeTx(tx('WebhookPeriodClosed', { count: 2, recordsSha256: await sha(JSON.stringify(records)), periodStart: 's', periodEnd: 'e', network: 'mainnet', signerDeclaration: hash }), key);
      expect(verify({ bundle, records, declarations: [declaration] }, w.address).code).toBe(0);
      const loose = [records[0], await signEdgeTx(tx('WebhookReceived', { n: 3, network: 'mainnet' }), key)];
      const b2 = await signEdgeTx(tx('WebhookPeriodClosed', { count: 2, recordsSha256: await sha(JSON.stringify(loose)), periodStart: 's', periodEnd: 'e', network: 'mainnet', signerDeclaration: hash }), key);
      expect(verify({ bundle: b2, records: loose, declarations: [declaration] }, w.address).code).toBe(1);
    });
  });
});
