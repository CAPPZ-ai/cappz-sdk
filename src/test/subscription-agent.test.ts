import { describe, expect, it } from 'vitest';
import {
  applyOwnerDecisions, capRoom, convertMinor, createSubscriptionAgent, decideFunding, endpointOrder, estimateRunway,
  markFailed, memoryFundingStore, parseTopUpCommand, periodStart, planWithinBudget, postingsFor, projectedVsActual,
  proposeDefaultPrices, quoteUsage, ruleProblems, splitCharge, splitProblems, subscriptionWatchJob, topUpCommand,
  withFailover, PLATFORM_ADAPTER_TEMPLATES, templateProblems, UNVALIDATED_NOTICE, priceStatusLabel,
  type AppUsagePlan, type ContractSplit, type FundingEvent, type FundingRule,
} from '@cappz/sdk/paidAgent';

const NOW = new Date('2026-10-28T12:30:00Z'); // a Wednesday
const rate = { usdCentsPerXrp: 50, source: 'test', at: '2026-10-28T12:25:00Z' }; // $0.50 / XRP

const plan = (over: Partial<AppUsagePlan> = {}): AppUsagePlan => ({
  appRoot: "m/44'/144'/0'/cappz/apps/demo",
  tenant: 'rTenant',
  contractId: 'c-1',
  mode: 'payg',
  accepts: ['USD', 'XRP'],
  prices: [{ useCase: 'gen', function: 'generate', process: 'fees/fee-charging', unit: 'per-call', perUnit: { USD: 10 }, validation: 'owner-set' }],
  baseFee: { amount: { USD: 1, XRP: 20_000 }, to: 'rPlatform' },
  ...over,
});

const rule = (over: Partial<FundingRule> = {}): FundingRule => ({
  ruleId: 'r1', appRoot: "m/44'/144'/0'/cappz/apps/demo", appName: 'Demo', currency: 'USD',
  belowBalance: 500, target: 2000, source: 'user-wallet', mode: 'confirm', caps: {}, ...over,
});

const noRunway = { burnPerHour: 0, hours: null, samples: 0 };

describe('money: USD, XRP or both', () => {
  it('converts only with a fresh rate, rounding up', () => {
    expect(convertMinor(100, 'USD', 'XRP', rate, NOW)).toBe(2_000_000); // $1 = 2 XRP
    expect(convertMinor(1, 'XRP', 'USD', rate, NOW)).toBe(1); // a drop rounds up to a cent
    expect(convertMinor(100, 'USD', 'XRP', undefined, NOW)).toBeNull();
    expect(convertMinor(100, 'USD', 'XRP', { ...rate, at: '2026-10-28T10:00:00Z' }, NOW)).toBeNull();
  });
});

describe('usage plan', () => {
  it('quotes in either currency the app accepts', () => {
    const usd = quoteUsage(plan(), 'generate', 3, 'USD', { now: NOW });
    expect(usd).toMatchObject({ ok: true, usage: 30, baseFee: 1, total: 31, converted: false });
    const xrp = quoteUsage(plan(), 'generate', 3, 'XRP', { now: NOW, rate });
    expect(xrp).toMatchObject({ ok: true, usage: 600_000, baseFee: 20_000, converted: true });
    expect(quoteUsage(plan(), 'generate', 3, 'XRP', { now: NOW })).toMatchObject({ ok: false, reason: 'no-rate' });
    expect(quoteUsage(plan({ accepts: ['USD'] }), 'generate', 1, 'XRP', { now: NOW, rate })).toMatchObject({ ok: false, reason: 'currency-not-accepted' });
  });

  it('never charges a proposed default until the owner acknowledges or changes it', () => {
    const prices = proposeDefaultPrices([{ useCase: 'gen', function: 'generate', process: 'p', unit: 'per-call' }]);
    expect(prices[0].validation).toBe('proposed-default');
    expect(priceStatusLabel(prices[0])).toBe(UNVALIDATED_NOTICE);
    const p = plan({ prices });
    expect(quoteUsage(p, 'generate', 1, 'USD', { now: NOW })).toMatchObject({ ok: false, reason: 'price-not-validated' });
    expect(quoteUsage(p, 'generate', 1, 'USD', { now: NOW, estimate: true })).toMatchObject({ ok: true, validation: 'proposed-default' });

    const acked = applyOwnerDecisions(prices, [{ type: 'PriceAcknowledged', function: 'generate', at: '2026-10-01T00:00:00Z', by: 'owner' }]);
    expect(quoteUsage(plan({ prices: acked }), 'generate', 1, 'USD', { now: NOW })).toMatchObject({ ok: true, validation: 'owner-acknowledged' });
    const set = applyOwnerDecisions(prices, [{ type: 'PriceSet', function: 'generate', at: '2026-10-02T00:00:00Z', by: 'owner', perUnit: { XRP: 5000 } }]);
    expect(set[0]).toMatchObject({ validation: 'owner-set', perUnit: { XRP: 5000 } });
  });

  it('uses the subscription allowance first; overage only in subscription-overage', () => {
    const sub = { period: 'month' as const, price: { USD: 900 }, included: { generate: 5 } };
    const events: FundingEvent[] = [{ type: 'UsageRecorded', at: '2026-10-05T00:00:00Z', function: 'generate', quantity: 4 }];
    expect(quoteUsage(plan({ mode: 'subscription', subscription: sub }), 'generate', 1, 'USD', { events, now: NOW })).toMatchObject({ ok: true, chargedUnits: 0, total: 0 });
    expect(quoteUsage(plan({ mode: 'subscription', subscription: sub }), 'generate', 2, 'USD', { events, now: NOW })).toMatchObject({ ok: false, reason: 'allowance-exhausted' });
    expect(quoteUsage(plan({ mode: 'subscription-overage', subscription: sub }), 'generate', 3, 'USD', { events, now: NOW })).toMatchObject({ ok: true, chargedUnits: 2, usage: 20 });
  });
});

describe('caps: overall and per month, week, day, hour', () => {
  const funded = (iso: string, amount: number, ruleId = 'r1'): FundingEvent => ({ type: 'AppFunded', at: iso, currency: 'USD', amount, source: 'user-wallet', ruleId });

  it('UTC periods', () => {
    expect(periodStart('week', NOW).toISOString()).toBe('2026-10-26T00:00:00.000Z');
    expect(periodStart('month', NOW).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(periodStart('hour', NOW).toISOString()).toBe('2026-10-28T12:00:00.000Z');
  });

  it('the tightest window wins; hand top-ups do not count', () => {
    const events = [
      funded('2026-09-30T00:00:00Z', 5000), // last month: overall only
      funded('2026-10-26T09:00:00Z', 1000), // this week
      funded('2026-10-28T12:05:00Z', 300), // this hour
      { type: 'AppFunded', at: '2026-10-28T12:10:00Z', currency: 'USD', amount: 9999, source: 'user-wallet' } as FundingEvent, // by hand
    ];
    const r = capRoom({ hour: 500, day: 2000, week: 1500, month: 4000, overall: 7000 }, events, 'r1', 'USD', NOW);
    expect(r.used).toEqual({ hour: 300, day: 300, week: 1300, month: 1300, overall: 6300 });
    expect(r).toMatchObject({ room: 200, limitedBy: 'hour' });
    expect(capRoom({}, events, 'r1', 'USD', NOW).room).toBeNull();
  });
});

describe('funding decision', () => {
  it('does nothing above the rule; proposes below it', () => {
    expect(decideFunding({ rule: rule(), balance: 600, runway: noRunway, events: [], now: NOW }).action).toBe('none');
    expect(decideFunding({ rule: rule(), balance: 100, runway: noRunway, events: [], now: NOW })).toMatchObject({ action: 'propose', amount: 1900, command: 'top up Demo $19.00' });
  });

  it('fires on a short runway too', () => {
    const d = decideFunding({ rule: rule({ belowBalance: undefined, belowRunwayHours: 24 }), balance: 1000, runway: { burnPerHour: 100, hours: 10, samples: 3 }, events: [], now: NOW });
    expect(d.action).toBe('propose');
  });

  it('auto tops up only with a cap, and within it', () => {
    expect(ruleProblems(rule({ mode: 'auto' }))).toContain('Auto top-up needs at least one cap (overall, month, week, day or hour); without one it only proposes');
    expect(decideFunding({ rule: rule({ mode: 'auto' }), balance: 100, runway: noRunway, events: [], now: NOW }).action).toBe('propose');
    expect(decideFunding({ rule: rule({ mode: 'auto', caps: { day: 1000 } }), balance: 100, runway: noRunway, events: [], now: NOW }))
      .toMatchObject({ action: 'execute', amount: 1000, partial: true, limitedBy: 'day' });
    expect(decideFunding({ rule: rule({ mode: 'auto', caps: { month: 5000 }, autoApproveUpTo: 1000 }), balance: 100, runway: noRunway, events: [], now: NOW }).action).toBe('propose');
  });

  it('a used-up cap warns instead', () => {
    const events: FundingEvent[] = [{ type: 'AppFunded', at: '2026-10-28T01:00:00Z', currency: 'USD', amount: 1000, source: 'user-wallet', ruleId: 'r1' }];
    expect(decideFunding({ rule: rule({ mode: 'auto', caps: { day: 1000 } }), balance: 100, runway: noRunway, events, now: NOW })).toMatchObject({ action: 'capped', limitedBy: 'day' });
  });

  it('commands round-trip in both currencies', () => {
    expect(parseTopUpCommand(topUpCommand(rule(), 1950))).toEqual({ appName: 'Demo', currency: 'USD', amount: 1950 });
    expect(parseTopUpCommand(topUpCommand(rule({ currency: 'XRP' }), 2_500_000))).toEqual({ appName: 'Demo', currency: 'XRP', amount: 2_500_000 });
  });
});

describe('contract split', () => {
  const split = (shares: ContractSplit['shares'], remainderTo?: string): ContractSplit => ({ contractId: 'c-1', shares, ...(remainderTo ? { remainderTo } : {}) });

  it('null and zero shares get nothing; lines always add up', () => {
    const r = splitCharge(1001, split([
      { party: 'rPlatform', role: 'platform', bps: 1000 },
      { party: 'rTenant', role: 'tenant', bps: 6000 },
      { party: 'rTalentA', role: 'talent', bps: 3000 },
      { party: 'rTalentB', role: 'talent', bps: null },
      { party: 'rTalentC', role: 'talent', bps: 0 },
    ]), { amount: 1, to: 'rPlatform' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const usageLines = r.lines.filter((l) => l.role !== 'base-fee');
    expect(usageLines.reduce((s, l) => s + l.amount, 0)).toBe(1001);
    expect(r.lines.map((l) => l.party)).toEqual(['rPlatform', 'rTenant', 'rTalentA', 'rPlatform']);
    expect(r.lines.at(-1)).toEqual({ party: 'rPlatform', role: 'base-fee', amount: 1 });
  });

  it('refuses to guess: unallocated shares need a named remainder party', () => {
    const s = split([{ party: 'rTenant', role: 'tenant', bps: 7000 }, { party: 'rPlatform', role: 'platform', bps: null }]);
    expect(splitProblems(s)[0]).toMatch(/3000 basis points unallocated/);
    expect(splitCharge(100, s).ok).toBe(false);
    const withRest = splitCharge(100, { ...s, remainderTo: 'rTenant' });
    expect(withRest).toEqual({ ok: true, lines: [{ party: 'rTenant', role: 'tenant', amount: 100 }] });
    expect(splitProblems(split([{ party: 'a', role: 'tenant', bps: 9000 }, { party: 'b', role: 'talent', bps: 2000 }]))[0]).toMatch(/over 100%/);
  });

  it('exact for very large amounts and posts AP/AR pairs', () => {
    const r = splitCharge(9_000_000_000_000_001, split([{ party: 'a', role: 'tenant', bps: 3333 }, { party: 'b', role: 'talent', bps: 6667 }]));
    if (!r.ok) throw new Error(r.problem);
    expect(r.lines.reduce((s, l) => s + BigInt(l.amount), 0n)).toBe(9_000_000_000_000_001n);
    const p = postingsFor([{ party: 'rTenant', role: 'tenant', amount: 5 }], 'rUser', 'USD', 'ch-1', 'c-1');
    expect(p).toEqual([
      { kind: 'AP', account: 'rUser', counterparty: 'rTenant', currency: 'USD', amount: 5, chargeId: 'ch-1', contractId: 'c-1' },
      { kind: 'AR', account: 'rTenant', counterparty: 'rUser', currency: 'USD', amount: 5, chargeId: 'ch-1', contractId: 'c-1' },
    ]);
  });
});

describe('task priority', () => {
  it('critical first and may use the reserve; the rest is deferred with exact shortfalls', () => {
    const plan = planWithinBudget([
      { id: 'report', criticality: 'deferrable', currency: 'USD', cost: 100 },
      { id: 'claim', criticality: 'critical', currency: 'USD', cost: 400 },
      { id: 'sync', criticality: 'normal', currency: 'USD', cost: 150 },
    ], { USD: 500 }, { USD: 200 });
    expect(plan.run.map((t) => t.id)).toEqual(['claim']);
    expect(plan.deferred.map((d) => d.task.id)).toEqual(['sync', 'report']);
    expect(plan.criticalShortfall).toEqual({});
    expect(plan.totalShortfall).toEqual({ USD: 400 + 150 + 100 + 200 - 500 });
  });
});

describe('runway and projected vs actual', () => {
  it('burn from recent charges', () => {
    const events: FundingEvent[] = [
      { type: 'FeeCharged', at: '2026-10-28T02:30:00Z', currency: 'USD', amount: 500, function: 'generate', quantity: 50, chargeId: 'a' },
      { type: 'FeeCharged', at: '2026-10-28T07:30:00Z', currency: 'USD', amount: 500, function: 'generate', quantity: 50, chargeId: 'b' },
    ];
    const r = estimateRunway(events, 'USD', 2000, NOW);
    expect(r.burnPerHour).toBe(100);
    expect(r.hours).toBe(20);
    expect(projectedVsActual(events, 'USD', 800, 'month', NOW)).toMatchObject({ actual: 1000, variance: 200, variancePct: 0.25 });
  });
});

describe('subscription agent', () => {
  const W = 'uaw-1';
  const split: ContractSplit = { contractId: 'c-1', shares: [{ party: 'rTenant', role: 'tenant', bps: 8000 }, { party: 'rTalent', role: 'talent', bps: 2000 }] };

  it('proposes, then funds on the typed command', async () => {
    const store = memoryFundingStore({ [W]: [{ type: 'AppFunded', at: '2026-10-01T00:00:00Z', currency: 'USD', amount: 100, source: 'user-wallet' }] });
    const notices: string[] = [];
    const paid: number[] = [];
    const agent = createSubscriptionAgent({
      store, now: () => NOW,
      notify: (n) => { notices.push(n.kind); },
      fund: async (r) => { paid.push(r.amount); return { txHash: 'ABC' }; },
    });
    const rules = [rule({ mode: 'command' })];
    const [c] = await agent.check(W, rules);
    expect(c.outcome).toBe('proposed');
    // A second check waits on the open proposal instead of proposing again.
    expect((await agent.check(W, rules))[0].outcome).toBe('waiting');
    expect(await agent.approveCommand(W, 'top up Demo $5.00', 'user', rules)).toMatchObject({ ok: false });
    expect(await agent.approveCommand(W, 'top up demo $19.00', 'user', rules)).toMatchObject({ ok: true });
    expect(paid).toEqual([1900]);
    expect(notices).toEqual(['propose', 'funded']);
    expect(store.all(W).at(-1)).toMatchObject({ type: 'AppFunded', amount: 1900, ruleId: 'r1', txHash: 'ABC' });
  });

  it('auto mode funds within caps; without a fund port it only proposes', async () => {
    const auto = rule({ mode: 'auto', caps: { week: 1500 } });
    const store = memoryFundingStore();
    const agent = createSubscriptionAgent({ store, now: () => NOW, fund: async () => ({}) });
    expect((await agent.check(W, [auto]))[0]).toMatchObject({ outcome: 'funded' });
    expect(store.all(W).filter((e) => e.type === 'AppFunded')).toHaveLength(1);
    const noFund = createSubscriptionAgent({ store: memoryFundingStore(), now: () => NOW });
    expect((await noFund.check(W, [auto]))[0].outcome).toBe('proposed');
  });

  it('a failed payment closes the proposal and says so', async () => {
    const store = memoryFundingStore();
    const kinds: string[] = [];
    const agent = createSubscriptionAgent({ store, now: () => NOW, notify: (n) => { kinds.push(n.kind); }, fund: async () => { throw new Error('rejected'); } });
    expect((await agent.check(W, [rule({ mode: 'auto', caps: { day: 5000 } })]))[0].outcome).toBe('fund-failed');
    expect(kinds).toEqual(['failed']);
    expect(store.all(W).at(-1)).toMatchObject({ type: 'TopUpDeclined', by: 'system' });
  });

  it('charges by plan and contract: 402 when short, idempotent by charge id', async () => {
    const store = memoryFundingStore({ [W]: [{ type: 'AppFunded', at: '2026-10-01T00:00:00Z', currency: 'USD', amount: 40, source: 'app-treasury' }] });
    const agent = createSubscriptionAgent({ store, now: () => NOW });
    const args = { wallet: W, payer: 'rUser', plan: plan(), split, fn: 'generate', quantity: 3, currency: 'USD' as const, chargeId: 'ch-1' };
    const ok = await agent.charge(args);
    expect(ok).toMatchObject({ ok: true, duplicate: false, quote: { total: 31 } });
    if (ok.ok) expect(ok.lines).toEqual([
      { party: 'rTenant', role: 'tenant', amount: 24 },
      { party: 'rTalent', role: 'talent', amount: 6 },
      { party: 'rPlatform', role: 'base-fee', amount: 1 },
    ]);
    expect(await agent.charge(args)).toMatchObject({ ok: true, duplicate: true });
    expect(await agent.charge({ ...args, chargeId: 'ch-2' })).toMatchObject({ ok: false, status: 402, balance: 9 });
    expect(await agent.charge({ ...args, chargeId: 'ch-3', split: { ...split, contractId: 'other' } })).toMatchObject({ ok: false, status: 409 });
  });

  it('records deferrals and resumptions', async () => {
    const store = memoryFundingStore();
    const agent = createSubscriptionAgent({ store, now: () => NOW });
    const tasks = [{ id: 't1', criticality: 'normal' as const, currency: 'USD' as const, cost: 100 }];
    await agent.planTasks(W, tasks);
    await agent.planTasks(W, tasks); // still deferred: not recorded twice
    await store.append(W, { type: 'AppFunded', at: '2026-10-28T12:00:00Z', currency: 'USD', amount: 100, source: 'user-wallet' });
    await agent.planTasks(W, tasks);
    expect(store.all(W).map((e) => e.type)).toEqual(['TaskDeferred', 'AppFunded', 'TaskResumed']);
  });

  it('runs as an edge-node job', async () => {
    const agent = createSubscriptionAgent({ store: memoryFundingStore(), now: () => NOW, fund: async () => ({}) });
    const job = subscriptionWatchJob(agent, async () => [{ wallet: W, rules: [rule({ source: 'app-treasury', mode: 'auto', caps: { month: 10_000 } })] }]);
    expect(await job.run(NOW)).toEqual({ ok: true, detail: 'funded: 1' });
  });
});

describe('platform adapter templates', () => {
  it('templates are valid; order is by priority then weight, backed-off endpoints last', () => {
    for (const t of Object.values(PLATFORM_ADAPTER_TEMPLATES)) expect(templateProblems(t)).toEqual([]);
    const xrpl = PLATFORM_ADAPTER_TEMPLATES['xrpl-public'].services.xrpl;
    const order = endpointOrder(xrpl, {}, 'seed');
    expect(order.at(-1)!.id).toBe('ripple-s2');
    const health = markFailed({}, order[0].id, 1000);
    expect(endpointOrder(xrpl, health, 'seed', 2000).at(-1)!.id).toBe(order[0].id);
  });

  it('fails over to the next endpoint', async () => {
    const xrpl = PLATFORM_ADAPTER_TEMPLATES['xrpl-public'].services.xrpl;
    const first = endpointOrder(xrpl, {}, 's')[0].id;
    const r = await withFailover(xrpl, async (e) => { if (e.id === first) throw new Error('down'); return e.id; }, { seed: 's' });
    expect(r.result).not.toBe(first);
    expect(r.health[first].failures).toBe(1);
  });
});

