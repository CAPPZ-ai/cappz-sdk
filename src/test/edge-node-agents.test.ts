// The edge node's paid agents (packages/cappz-edge-node/agents, 15.43.0): served docs are
// complete for both networks, and the shipped verifier agrees with signEdgeTx.
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DOC_FILES, docVars, renderDoc, unfilled } from '../../packages/cappz-edge-node/agents/docs';
import { signEdgeTx } from '../lib/functions/edgeJobs';

const dir = resolve(__dirname, '../../packages/cappz-edge-node/agents');
const template = (f: string) => readFileSync(join(dir, 'docs', f), 'utf8');
/** Hosts a shipped file names, other than public CAPPZ/XRPL/GitHub ones: a node's own name belongs in its settings, never in the code. */
const ALLOWED_HOSTS = new Set(['cappz.ai', 'github.com', 'raw.githubusercontent.com', 'xrpl.org', '127.0.0.1']);
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
    for (const f of ['timestamp.SKILL.md', 'webhook.SKILL.md']) {
      const md = renderDoc(template(f), docVars(settings('mainnet')));
      const fm = /^---\nname: ([a-z0-9-]{1,64})\ndescription: (.+)\n---\n/.exec(md)!;
      expect(fm, f).not.toBeNull();
      expect(fm[2].length).toBeLessThanOrEqual(1024);
      expect(fm[2]).toMatch(/Use when/);
      expect(md).toContain('payload.network');
    }
  });
});

describe('edge node paid agents: verify.mjs', () => {
  const keyPair = async () => {
    const k = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey));
    return { privateKey: k.privateKey, publicKeyHex: Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join('') };
  };
  const tx = (eventType: string, payload: Record<string, unknown>) => ({ txId: `${eventType}-1`, timestamp: '2026-11-14T00:00:00.000Z', eventType, sourceAddress: 'rNode', targetAddress: 'rNode/x', payload });
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
});
