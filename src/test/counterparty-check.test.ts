import { describe, expect, it } from 'vitest';
import { canonicalJson, judge, marketFacts, runCounterpartyCheck, signCheck, verifyCheck, type AccountFacts, type CheckReport } from '../lib/marketplace/counterpartyCheck';
import { seedDemoMarket } from '../lib/marketplace/demo';
import { checkInput, d1JobStore } from '../../packages/cappz-check-worker/worker';

const NOW = '2026-11-03T12:00:00.000Z';
const acct = (over: Partial<AccountFacts> = {}): AccountFacts => ({ address: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe', activated: true, balanceXrp: 50, ownedObjects: 0, flags: { requireDestinationTag: false, depositAuth: false, disallowXrp: false, masterDisabled: false, globalFreeze: false }, regularKey: null, firstSeen: '2025-01-01T00:00:00Z', lastActive: NOW, error: null, ...over });
const codes = (rs: Array<{ code: string }>) => rs.map((r) => r.code);

// A fake XRPL JSON-RPC: answers by method from a table, so checks run without the network.
const rpc = (table: Record<string, unknown>) => (async (_url: string, init: { body: string }) => {
  const { method, params } = JSON.parse(init.body); const key = `${method}:${params[0].account ?? ''}`;
  const result = table[key] ?? table[method] ?? { error: 'actNotFound', error_message: 'Account not found.' };
  return new Response(JSON.stringify({ result }), { status: 200 });
}) as unknown as typeof fetch;

describe('counterparty check rules', () => {
  it('stops on accounts that cannot receive, and warns on risk signals; a missing fact is never "fine"', () => {
    expect(codes(judge({ network: 'testnet' }, acct({ activated: false }), null, null, NOW))).toContain('not-activated');
    expect(codes(judge({ network: 'testnet' }, acct({ flags: { ...acct().flags!, depositAuth: true } }), null, null, NOW))).toContain('deposit-auth');
    expect(codes(judge({ network: 'testnet' }, acct({ firstSeen: '2026-11-01T00:00:00Z' }), null, null, NOW))).toContain('new-account');
    expect(codes(judge({ network: 'testnet' }, acct({ flags: { ...acct().flags!, masterDisabled: true } }), null, null, NOW))).toContain('blackholed');
    expect(codes(judge({ network: 'testnet' }, acct({ activated: null, error: 'timeout' }), null, null, NOW))).toContain('ledger-unreadable');
    expect(codes(judge({ network: 'testnet' }, null, null, null, NOW))).toContain('no-address');
    expect(codes(judge({ network: 'testnet' }, acct(), { ...acct(), spendableXrp: 1, needsXrp: 25 }, null, NOW))).toContain('payer-short');
  });

  it('reads the marketplace record: an agent without an active mandate is a stop', async () => {
    const r = await seedDemoMarket(NOW);
    const m = marketFacts(r.state, null, 'agent-petalbot', NOW)!;
    expect(m.kind).toBe('agent');
    const stale = { ...m, mandate: m.mandate ? { ...m.mandate, active: false } : null };
    expect(codes(judge({ network: 'testnet' }, acct(), null, stale, NOW))).toContain('agent-no-mandate');
    expect(marketFacts(r.state, null, 'blue-ridge-herbs', NOW)!.finished).toBeGreaterThan(0);
  });

  it('runs against the ledger (JSON-RPC) and signs; any change to the report breaks the signature', async () => {
    const fetcher = rpc({
      server_info: { info: { validated_ledger: { reserve_base_xrp: 1, reserve_inc_xrp: 0.2, seq: 100 } } },
      'account_info:rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe': { account_data: { Balance: '30000000', OwnerCount: 2, Flags: 0x00020000 }, ledger_index: 100 },
      'account_tx:rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe': { transactions: [{ close_time_iso: '2025-06-01T00:00:00Z' }] },
    });
    const report = await runCounterpartyCheck({ network: 'testnet', address: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe' }, null, NOW, fetcher);
    expect(report.verdict).toBe('ok');
    expect(codes(report.reasons)).toEqual(['dest-tag-required', 'no-market-history']);
    expect(report.ledger!.ownedObjects).toBe(2);
    const signed = signCheck(report, '07'.repeat(32));
    expect(verifyCheck(signed)).toBe(true);
    expect(verifyCheck(signed, signed.signature.publicKey)).toBe(true);
    expect(verifyCheck(signed, 'ab'.repeat(32))).toBe(false);
    expect(verifyCheck({ ...signed, report: { ...signed.report, verdict: 'stop' } as CheckReport })).toBe(false);
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: null }] })).toBe('{"a":[2,{"c":null,"d":3}],"b":1}');
  });

  it('the worker validates input before opening a job, and stores jobs per network', async () => {
    expect(() => checkInput({}, 'testnet')).toThrow(/address/);
    expect(() => checkInput({ address: 'rNOPE' }, 'testnet')).toThrow(/not a valid/);
    expect(checkInput({ party: 'p-1', amountXrp: '2' }, 'mainnet')).toEqual({ network: 'mainnet', party: 'p-1', amountXrp: 2 });
    const calls: string[] = [];
    const db = { prepare: (sql: string) => { const stmt = { bind: (...v: unknown[]) => { calls.push(`${sql.split(' ')[0]} ${v[0]}`); return stmt; }, all: async () => ({ results: [] }), first: async () => null, run: async () => ({}) }; return stmt; } };
    const store = d1JobStore(db as never, 'mainnet');
    await store.append({ type: 'JobOpened', jobId: 'job-1', at: NOW, terms: {} as never, input: {} });
    expect(await store.paymentUsed!('ABC')).toBe(false);
    expect(calls.every((c) => c.endsWith('mainnet'))).toBe(true);
  });
});
