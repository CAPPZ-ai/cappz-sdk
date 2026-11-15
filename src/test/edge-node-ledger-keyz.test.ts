// @vitest-environment node
// 15.45.0: the payout account declares the edge node's key ON THE XRP LEDGER (signed in its own
// wallet, e.g. Xaman; no seed on the node). ledgerKeyz.ts (server, tool) and docs/verify.mjs
// (buyers, no dependencies) must apply the same rules.
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  anchorRef, checkAnchor, declarationMemo, evaluateLedgerDeclaration, isLedgerAnchor, keyzMemoOf, keyzTransaction, parseAnchorRef, type Rpc,
} from '../../packages/cappz-edge-node/agents/ledgerKeyz';
import { normalizeTx, type LedgerTx } from '../lib/xrpl/ledgerCheck';
import { signEdgeTx } from '../lib/functions/edgeJobs';

const agents = resolve(__dirname, '../../packages/cappz-edge-node/agents');
const ACCOUNT = 'rhszv2Ghe8NbqPDmmdJvJ4Cq2E3hjfYnYh';
const NODE = 'ab'.repeat(32);
const T0 = Date.parse('2026-11-15T12:00:00Z');
const RIPPLE_EPOCH = 946684800;
let seq = 0;
const hash = () => (++seq).toString(16).toUpperCase().padStart(64, '0');

/** A transaction as rippled's `tx` / `account_tx` (API v1) returns it. */
function ledgerEntry(account: string, memo: unknown, at: number, ledger: number, result = 'tesSUCCESS', type = 'AccountSet') {
  const tx = keyzTransaction(account, memo as never);
  return { ...tx, TransactionType: type, hash: hash(), ledger_index: ledger, date: Math.floor(at / 1000) - RIPPLE_EPOCH, validated: true, meta: { TransactionResult: result } };
}
const asTx = (e: Record<string, unknown>): LedgerTx => normalizeTx(e, 'mainnet', new Date(T0).toISOString());

describe('on-ledger KeyZ declarations: rules', () => {
  const memo = { ...(declarationMemo(NODE, ['signing'], 30, T0) as Extract<ReturnType<typeof declarationMemo>, { op: 'declare' }>), n: 'x' };

  it('the transaction is an AccountSet that changes nothing, carrying one cappz/keyz memo that reads back', () => {
    const tx = keyzTransaction(ACCOUNT, memo);
    expect(Object.keys(tx).sort()).toEqual(['Account', 'Memos', 'TransactionType']);
    expect(tx.TransactionType).toBe('AccountSet');
    expect(keyzMemoOf(asTx(ledgerEntry(ACCOUNT, memo, T0, 100)))).toEqual(memo);
    expect(() => declarationMemo(NODE, ['signing'], 91)).toThrow(/1–90/);
    expect(() => declarationMemo('xyz', ['signing'], 30)).toThrow();
  });

  it('declared inside its window; expired after; refused when failed, another key, another purpose, or over 90 days', () => {
    const decl = asTx(ledgerEntry(ACCOUNT, memo, T0, 100));
    expect(evaluateLedgerDeclaration(decl, [], NODE, 'signing', T0 + 1000)).toMatchObject({ state: 'declared', account: ACCOUNT, until: memo.until });
    expect(evaluateLedgerDeclaration(decl, [], NODE, 'signing', T0 + 31 * 86_400_000).state).toBe('expired');
    expect(evaluateLedgerDeclaration(decl, [], NODE, 'signing', T0 - 3600_000).state).toBe('not-yet');
    expect(evaluateLedgerDeclaration(decl, [], 'cd'.repeat(32), 'signing', T0).state).toBe('invalid');
    expect(evaluateLedgerDeclaration(decl, [], NODE, 'hello', T0).state).toBe('invalid');
    expect(evaluateLedgerDeclaration(asTx(ledgerEntry(ACCOUNT, memo, T0, 100, 'tecNO_PERMISSION')), [], NODE, 'signing', T0).state).toBe('invalid');
    expect(evaluateLedgerDeclaration(asTx(ledgerEntry(ACCOUNT, memo, T0, 100, 'tesSUCCESS', 'Payment')), [], NODE, 'signing', T0).state).toBe('invalid');
    const long = { ...memo, until: new Date(T0 + 200 * 86_400_000).toISOString() };
    expect(evaluateLedgerDeclaration(asTx(ledgerEntry(ACCOUNT, long, T0, 100)), [], NODE, 'signing', T0).because).toMatch(/more than 90 days/);
  });

  it('a later revocation by the same account withdraws it (by hash or by key); others change nothing', () => {
    const decl = asTx(ledgerEntry(ACCOUNT, memo, T0, 100));
    const byHash = asTx(ledgerEntry(ACCOUNT, { v: 1, op: 'revoke', tx: decl.hash }, T0 + 5000, 105));
    const byKey = asTx(ledgerEntry(ACCOUNT, { v: 1, op: 'revoke', key: NODE }, T0 + 5000, 105));
    expect(evaluateLedgerDeclaration(decl, [byHash], NODE, 'signing', T0 + 1000)).toMatchObject({ state: 'revoked' });
    expect(evaluateLedgerDeclaration(decl, [byKey], NODE, 'signing', T0 + 1000)).toMatchObject({ state: 'revoked' }); // backdated records too
    const stranger = asTx(ledgerEntry('rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', { v: 1, op: 'revoke', key: NODE }, T0 + 5000, 105));
    const failed = asTx(ledgerEntry(ACCOUNT, { v: 1, op: 'revoke', key: NODE }, T0 + 5000, 105, 'tecFAILED'));
    const earlier = asTx(ledgerEntry(ACCOUNT, { v: 1, op: 'revoke', key: NODE }, T0 - 5000, 95)); // an older revocation does not undo a new declaration
    expect(evaluateLedgerDeclaration(decl, [stranger, failed, earlier], NODE, 'signing', T0 + 1000).state).toBe('declared');
  });

  it('anchors and references round-trip', () => {
    const h = 'AB'.repeat(32);
    expect(parseAnchorRef(anchorRef('testnet', h.toLowerCase()))).toEqual({ network: 'testnet', txHash: h });
    expect(parseAnchorRef('xrpl:moon:' + h)).toBeNull();
    expect(isLedgerAnchor({ v: 'xrpl', network: 'mainnet', txHash: h })).toBe(true);
    expect(isLedgerAnchor({ v: 2, walletAddress: '02ab' })).toBe(false);
  });

  it('checkAnchor reads the declaration and the account history after it from the ledger', async () => {
    const declE = ledgerEntry(ACCOUNT, memo, Date.now() - 1000, 200);
    const revE = ledgerEntry(ACCOUNT, { v: 1, op: 'revoke', tx: declE.hash }, Date.now(), 201);
    let history: unknown[] = [];
    const rpc: Rpc = async (_n, method, params) => {
      if (method === 'tx') return params.transaction === declE.hash ? declE : (() => { throw Object.assign(new Error('nf'), { code: 'txnNotFound' }); })();
      expect(params).toMatchObject({ account: ACCOUNT, ledger_index_min: 200, forward: true });
      return { transactions: history.map((t) => ({ tx: t, meta: (t as { meta: unknown }).meta, validated: true, ledger_index: (t as { ledger_index: number }).ledger_index })) };
    };
    history = [declE];
    expect((await checkAnchor({ network: 'mainnet', txHash: declE.hash }, NODE, 'signing', rpc)).state).toBe('declared');
    history = [declE, revE];
    expect((await checkAnchor({ network: 'mainnet', txHash: declE.hash }, NODE, 'signing', rpc)).state).toBe('revoked');
    expect((await checkAnchor({ network: 'mainnet', txHash: 'CD'.repeat(32) }, NODE, 'signing', rpc)).state).toBe('invalid');
  });
});

describe('on-ledger KeyZ declarations: verify.mjs reads the ledger itself', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cappz-ledger-verify-'));
  /** A stand-in rippled JSON-RPC endpoint (verify.mjs is pointed at it with CAPPZ_XRPL_RPC_MAINNET). */
  async function withLedger<T>(entries: Array<Record<string, unknown>>, fn: (url: string) => Promise<T>): Promise<T> {
    const server = createServer((req, res) => {
      let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
        const { method, params: [p] } = JSON.parse(body);
        let result: unknown;
        if (method === 'tx') { const e = entries.find((x) => x.hash === p.transaction); result = e ?? { status: 'error', error: 'txnNotFound' }; }
        else result = { transactions: entries.filter((e) => e.Account === p.account && (e.ledger_index as number) >= p.ledger_index_min).map((e) => ({ tx: e, meta: e.meta, validated: true, ledger_index: e.ledger_index })) };
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ result }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try { return await fn(`http://127.0.0.1:${(server.address() as { port: number }).port}/`); } finally { server.close(); }
  }
  const verify = (doc: unknown, url: string, ...args: string[]) => new Promise<{ code: number | null; out: string }>((done) => {
    const file = join(tmp, `${Math.random().toString(36).slice(2)}.json`); writeFileSync(file, JSON.stringify(doc));
    const p = spawn(process.execPath, [join(agents, 'docs', 'verify.mjs'), file, ...args], { env: { ...process.env, CAPPZ_XRPL_RPC_MAINNET: url } });
    let out = ''; p.stdout.on('data', (c) => (out += c)); p.on('close', (code) => done({ code, out }));
  });
  const nodeKey = async () => {
    const k = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    return { privateKey: k.privateKey, publicKeyHex: Buffer.from(await crypto.subtle.exportKey('raw', k.publicKey)).toString('hex') };
  };

  it('shows the declaring account, requires it when asked, and refuses after a revocation', async () => {
    const key = await nodeKey(); const now = Date.now();
    const decl = ledgerEntry(ACCOUNT, declarationMemo(key.publicKeyHex, ['signing'], 30, now - 60_000), now - 60_000, 300);
    const ref = anchorRef('mainnet', decl.hash as string);
    const receipt = await signEdgeTx({ txId: 'HashTimestamped-1', timestamp: new Date(now).toISOString(), eventType: 'HashTimestamped', sourceAddress: ACCOUNT, targetAddress: 'x', payload: { governingPrinciple: 'test', sha256: 'a'.repeat(64), network: 'mainnet', signerDeclaration: ref } }, key);
    await withLedger([decl], async (url) => {
      const ok = await verify({ receipt }, url, ACCOUNT);
      expect(ok.out).toContain(`declared ON THE XRP LEDGER (mainnet) by wallet ${ACCOUNT}`);
      expect(ok.code).toBe(0);
      expect((await verify({ receipt }, url, 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh')).code).toBe(1);
      const off = await verify({ receipt }, url, ACCOUNT, '--offline');
      expect(off.code).toBe(1); expect(off.out).toMatch(/not checked \(--offline\)/);
    });
    const revoke = ledgerEntry(ACCOUNT, { v: 1, op: 'revoke', key: key.publicKeyHex }, now, 301);
    await withLedger([decl, revoke], async (url) => {
      const r = await verify({ receipt }, url, ACCOUNT);
      expect(r.code).toBe(1); expect(r.out).toMatch(/REVOKED/);
    });
    // another account's "revocation", or a declaration of another key, never counts as this account's word
    const other = ledgerEntry(ACCOUNT, declarationMemo('cd'.repeat(32), ['signing'], 30, now - 60_000), now - 60_000, 300);
    const r2 = await signEdgeTx({ ...receipt, txId: 'HashTimestamped-2', payload: { ...receipt.payload, signerDeclaration: anchorRef('mainnet', other.hash as string) } } as never, key);
    await withLedger([other], async (url) => expect((await verify({ receipt: r2 }, url, ACCOUNT)).code).toBe(1));
  });

  it('the shipped rules match: verify.mjs and ledgerKeyz.ts name the same memo type, limits and servers', () => {
    const v = readFileSync(join(agents, 'docs', 'verify.mjs'), 'utf8');
    const l = readFileSync(join(agents, 'ledgerKeyz.ts'), 'utf8');
    expect(v).toContain("m.type !== 'cappz/keyz'"); expect(l).toContain("KEYZ_MEMO_TYPE = 'cappz/keyz'");
    for (const url of ['https://xrplcluster.com/', 'https://s1.ripple.com:51234/', 'https://s.altnet.rippletest.net:51234/']) { expect(v).toContain(url); expect(l).toContain(url); }
    expect(v).toContain('91 * 86_400_000'); expect(l).toContain('MAX_LEDGER_DECLARATION_DAYS + 1');
  });
});
