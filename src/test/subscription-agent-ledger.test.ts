import { describe, expect, it } from 'vitest';
import {
  checkXrpTopUp, createSubscriptionAgent, memoryFundingStore, planFromPriceSheet, quoteUsage, replayFundingRules,
  replayProposals, resolvePublishedPlan, topUpDestinationTag, treasuryWatchJob, xrpTopUpRequest,
  GENESIS_PRICE_SHEETS_FOR_TEST,
  type AppUsagePlan, type FundingConfigEvent, type FundingRule, type LedgerTx,
} from './helpers/fundingTestExports';

const NOW = new Date('2026-10-28T12:30:00Z');
const XRPL = { payTo: 'rAppReceivingAddressXXXXXXXXXXXXXX', network: 'testnet' as const };

const rule = (over: Partial<FundingRule> = {}): FundingRule => ({
  ruleId: 'r1', appRoot: 'app', appName: 'Demo', currency: 'XRP', belowBalance: 5_000_000, target: 20_000_000,
  source: 'user-wallet', mode: 'confirm', caps: {}, ...over,
});

const ledgerTx = (over: Partial<LedgerTx>): LedgerTx => ({
  hash: 'ABC123', network: 'testnet', validated: true, result: 'tesSUCCESS', type: 'Payment', account: 'rPayer',
  destination: XRPL.payTo, destinationTag: null, deliveredDrops: '15000000', deliveredIssued: null, memos: [], checkedAt: NOW.toISOString(),
  ...over,
} as LedgerTx);

describe('rules and plans on the ledger', () => {
  it('rules replay newest-wins, with removal', () => {
    const ev: FundingConfigEvent[] = [
      { type: 'FundingRuleSet', at: '2026-10-01T00:00:00Z', rule: { ...rule(), target: 1 } },
      { type: 'FundingRuleSet', at: '2026-10-02T00:00:00Z', rule: rule() },
      { type: 'FundingRuleSet', at: '2026-10-03T00:00:00Z', rule: rule({ ruleId: 'r2' }) },
      { type: 'FundingRuleRemoved', at: '2026-10-04T00:00:00Z', ruleId: 'r2' },
    ];
    expect(replayFundingRules(ev)).toEqual([rule()]);
  });

  it('a published plan takes the owner’s later price decisions only', () => {
    const plan: AppUsagePlan = {
      appRoot: 'app', tenant: 'rTenant', contractId: 'c', mode: 'payg', accepts: ['USD'],
      prices: [{ useCase: 'u', function: 'f', process: 'p', unit: 'per-call', perUnit: { USD: 1 }, validation: 'proposed-default' }],
    };
    const before = { type: 'PriceAcknowledged' as const, function: 'f', at: '2026-10-01T00:00:00Z', by: 'owner' };
    const published = { type: 'UsagePlanPublished' as const, at: '2026-10-02T00:00:00Z', plan };
    expect(resolvePublishedPlan([before, published])!.prices[0].validation).toBe('proposed-default');
    const after = { type: 'PriceSet' as const, function: 'f', at: '2026-10-03T00:00:00Z', by: 'owner', perUnit: { USD: 3 } };
    expect(resolvePublishedPlan([before, published, after])!.prices[0]).toMatchObject({ validation: 'owner-set', perUnit: { USD: 3 } });
    expect(resolvePublishedPlan([before])).toBeNull();
  });

  it('a price sheet becomes an owner-set plan', () => {
    const sheet = GENESIS_PRICE_SHEETS_FOR_TEST[0];
    const plan = planFromPriceSheet(sheet, { tenant: 'rTenant', contractId: 'c', mode: 'payg' });
    expect(plan.prices.every((p) => p.validation === 'owner-set')).toBe(true);
    const q = quoteUsage(plan, sheet.entries[0].function, 1, 'USD', { now: NOW });
    expect(q).toMatchObject({ ok: true, usage: sheet.entries[0].retailCents });
  });
});

describe('XRP top-ups from the person’s own wallet', () => {
  it('request and ledger check', async () => {
    const req = await xrpTopUpRequest({ proposalId: 'p1', network: 'testnet', payTo: XRPL.payTo, drops: 15_000_000 });
    expect(req.destinationTag).toBe(await topUpDestinationTag('p1'));
    expect(req.preparedTx).toMatchObject({ TransactionType: 'Payment', Destination: XRPL.payTo, Amount: '15000000', DestinationTag: req.destinationTag });
    const good = ledgerTx({ destinationTag: req.destinationTag });
    expect(checkXrpTopUp(req, good)).toEqual({ ok: true, txHash: 'ABC123', deliveredDrops: 15_000_000 });
    expect(checkXrpTopUp(req, { ...good, deliveredDrops: '1000' })).toMatchObject({ ok: false, reason: 'underpaid' });
    expect(checkXrpTopUp(req, { ...good, destinationTag: 7 })).toMatchObject({ ok: false, reason: 'wrong-tag' });
    expect(checkXrpTopUp(req, { ...good, validated: false })).toMatchObject({ ok: false, reason: 'not-validated' });
    expect(checkXrpTopUp(req, { ...good, deliveredDrops: null })).toMatchObject({ ok: false, reason: 'not-xrp' });
  });

  it('approve → pay in own wallet → settle once', async () => {
    const W = 'uaw';
    const store = memoryFundingStore();
    const kinds: string[] = [];
    let tag = 0;
    const agent = createSubscriptionAgent({
      store, now: () => NOW, notify: (n) => { kinds.push(n.kind); },
      fund: async (r) => ({ awaitingPayment: await xrpTopUpRequest({ proposalId: r.proposalId, network: XRPL.network, payTo: XRPL.payTo, drops: r.amount }) }),
      ledgerTx: async () => ledgerTx({ destinationTag: tag }),
    });
    const [c] = await agent.check(W, [rule()]);
    expect(c.outcome).toBe('proposed');
    const a = await agent.approve(W, c.proposalId!, 'user', [rule()]);
    expect(a.ok).toBe(true);
    expect(a.payment!.drops).toBe(20_000_000);
    // Still pending: the approved proposal blocks a second one.
    expect((await agent.check(W, [rule()]))[0].outcome).toBe('waiting');
    tag = a.payment!.destinationTag;
    expect(await agent.settleXrpTopUp(W, c.proposalId!, 'abc123', [rule()], XRPL)).toMatchObject({ ok: false, detail: expect.stringMatching(/Delivered/) });
    // The ledger shows 15 XRP delivered against a 20 XRP request: underpaid, nothing credited.
    expect(store.all(W).some((e) => e.type === 'AppFunded')).toBe(false);
  });

  it('a full payment is credited once, by its ledger hash', async () => {
    const W = 'uaw';
    const store = memoryFundingStore();
    const agent = createSubscriptionAgent({
      store, now: () => NOW,
      fund: async (r) => ({ awaitingPayment: await xrpTopUpRequest({ proposalId: r.proposalId, network: XRPL.network, payTo: XRPL.payTo, drops: r.amount }) }),
      ledgerTx: async () => ledgerTx({ destinationTag: await topUpDestinationTag(pid), deliveredDrops: '20000000' }),
    });
    let pid = '';
    const [c] = await agent.check(W, [rule()]);
    pid = c.proposalId!;
    await agent.approve(W, pid, 'user', [rule()]);
    expect(await agent.settleXrpTopUp(W, pid, 'ABC123', [rule()], XRPL)).toEqual({ ok: true, detail: 'Topped up' });
    expect(await agent.settleXrpTopUp(W, pid, 'abc123', [rule()], XRPL)).toMatchObject({ ok: false, detail: 'That payment is already recorded' });
    expect(store.all(W).filter((e) => e.type === 'AppFunded')).toEqual([expect.objectContaining({ amount: 20_000_000, txHash: 'ABC123' })]);
  });

  it('an unapproved proposal cannot be settled; approved ones lapse at expiry', async () => {
    const W = 'uaw';
    const store = memoryFundingStore();
    let now = NOW;
    const agent = createSubscriptionAgent({ store, now: () => now, ledgerTx: async () => ledgerTx({}) });
    const [c] = await agent.check(W, [rule()]);
    expect(await agent.settleXrpTopUp(W, c.proposalId!, 'H', [rule()], XRPL)).toMatchObject({ ok: false, detail: 'Only an approved XRP top-up can be settled' });
    await store.append(W, { type: 'TopUpApproved', at: NOW.toISOString(), proposalId: c.proposalId!, by: 'user' });
    now = new Date(NOW.getTime() + 25 * 3_600_000);
    expect(replayProposals(store.all(W), now)[0].state).toBe('expired');
  });
});

describe('treasury watch on an owner’s node', () => {
  it('reads the ledger balance and tops up automatically within caps', async () => {
    const store = memoryFundingStore();
    const paid: number[] = [];
    const lines: string[] = [];
    const t = { wallet: 'rTreasury', rules: [rule({ mode: 'auto', caps: { day: 30_000_000 }, source: 'app-treasury' })] };
    const job = treasuryWatchJob({
      store, now: () => NOW, log: (l) => lines.push(l),
      balanceOf: async () => 1_000_000,
      pay: async (_t, _r, amount) => { paid.push(amount); return { txHash: `H${paid.length}` }; },
    }, async () => [t]);
    expect(await job.run(NOW)).toMatchObject({ ok: true, detail: 'r1: funded' });
    expect(paid).toEqual([19_000_000]);
    // Next run: the day cap has 11 XRP left.
    await job.run(NOW);
    expect(paid).toEqual([19_000_000, 11_000_000]);
    // Then the cap is used up: a warning, no payment.
    expect((await job.run(NOW)).detail).toBe('r1: warned');
    expect(paid).toHaveLength(2);
  });

  it('a non-auto rule is only logged, once', async () => {
    const store = memoryFundingStore();
    const lines: string[] = [];
    const job = treasuryWatchJob({ store, now: () => NOW, log: (l) => lines.push(l), balanceOf: async () => 0, pay: async () => { throw new Error('never'); } },
      async () => [{ wallet: 'rT', rules: [rule()] }]);
    await job.run(NOW);
    await job.run(NOW);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/only tops up automatically/);
  });
});
