// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEMO_YOU, seedDemoMarket } from '../lib/marketplace/demo';
import * as M from '../lib/marketplace/model';
import { buildFeeSchedule, contractFeePlan, NO_FEES } from '../lib/marketplace/fees';
import { normalizeTx, type LedgerTx } from '../lib/xrpl/ledgerCheck';
import { prepareStagePayments, contractRail, settlementPolicyFor } from '../lib/marketplace/settlement';
import { evaluateSigningIntent } from '../lib/marketplace/signingApproval';
import { PAYMENT_ASSETS, PAYMENT_RAILS, assetAvailability, currencyOf, issuedValue, resolvePaymentAsset, unitsOfIssuedValue, USD_TOKENZ_FAMILY } from '../lib/marketplace/paymentAssets';
import { providerSegmentsIn } from '../lib/wallets/paths';
import { fundingNeed } from '../lib/marketplace/walletFunding';
import { applyNetworkAddressOverrides } from '../lib/network/networkConfig';
import { committedKey } from '../lib/marketplace/rules';
import * as fs from 'node:fs';
import * as path from 'node:path';

const START = '2026-11-01T12:00:00.000Z';
const BUYER = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe', SELLER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', ARC = 'rGWrZyQqhTp9Xu7G5Pkayo7bXjH4k4QYpf';
const RLUSD_TESTNET = 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV';
const RLUSD_HEX = '524C555344000000000000000000000000000000';

let n = 0;
/** A validated Payment as the ledger reader returns it. */
function paymentLt(p: { from: string; to: string; value?: string; drops?: string; issuer?: string; currency?: string; contractId: string; milestone: number }): LedgerTx {
  const hash = (++n).toString(16).toUpperCase().padStart(64, 'A');
  const delivered = p.drops ?? { currency: p.currency ?? RLUSD_HEX, issuer: p.issuer ?? RLUSD_TESTNET, value: p.value ?? '0' };
  const memo = (s: string) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return normalizeTx({ hash, validated: true, ledger_index: 100, tx_json: { TransactionType: 'Payment', Account: p.from, Destination: p.to, Amount: delivered, Memos: [{ Memo: { MemoType: memo('cappz-marketplace-monetary'), MemoData: memo(JSON.stringify({ class: 'monetary', contractId: p.contractId, deliveryIndex: p.milestone })) } }] }, meta: { TransactionResult: 'tesSUCCESS', delivered_amount: delivered } }, 'testnet', START);
}

async function tokenDeal(withFees: boolean) {
  const r = await seedDemoMarket(START);
  r.apply(await buildFeeSchedule('op', r.as('op', 1).at, withFees
    ? { marketplace: { percent: { enabled: true, bps: 100 }, flat: { enabled: false, amounts: {} }, perRecord: { enabled: false, amounts: {} } }, securities: NO_FEES, recipients: [{ account: ARC, label: 'Revenue', bps: 10_000 }], collector: { account: ARC, label: 'ARC' }, note: '1%' }
    : { marketplace: NO_FEES, securities: NO_FEES, recipients: [], note: 'fees off' }));
  for (const [id, acct] of [[DEMO_YOU, BUYER], ['north-star-grain', SELLER]] as const) { const p = r.state.parties.get(id)!; r.apply(await M.buildProfile(r.state, r.as(id, 1), { ...p, xrplAccount: acct })); }
  r.apply(await M.buildListing(r.state, { ...r.as('north-star-grain'), network: 'testnet' }, { listingId: 'l-rlusd', sellerId: 'north-star-grain', categoryId: 'crops/grains', kind: 'sale', title: 'Wheat for USD-tokenZ', description: 'x', unit: 'bu', pricePerUnit: { amount: 4, currency: 'USD-tokenZ/1' }, quantity: 100, region: 'MN', delivery: 'ship', leadDays: 7, attributes: {} }));
  const o = await M.buildOrder(r.state, { ...r.as(DEMO_YOU), network: 'testnet' }, 'l-rlusd', 25); r.apply(o.txs);
  return { r, contractId: o.contractId };
}

describe('payment assets and rails registry', () => {
  it('addresses are CAPPZ-rooted, vendor-free, and the USD-tokenZ members are HD children of the family', () => {
    for (const x of [...PAYMENT_ASSETS.map((a) => a.mdmAddress), ...PAYMENT_RAILS.map((r) => r.mdmAddress)]) {
      expect(x.startsWith("m/44'/144'/0'/cappz/config/payment-")).toBe(true);
      expect(providerSegmentsIn(x)).toEqual([]);
    }
    expect(resolvePaymentAsset('USD-tokenZ/1')!.mdmAddress).toBe(`${USD_TOKENZ_FAMILY}/1`);
    expect(resolvePaymentAsset('USD-tokenZ/1')!.label).toBe('RLUSD');
    // Old names and spellings resolve; labels are display only and unique.
    expect(currencyOf('xrp')).toBe('XRP'); expect(currencyOf('usd-card')).toBe('USD'); expect(currencyOf('rlusd')).toBe('USD-tokenZ/1'); expect(currencyOf('nope')).toBeNull();
    expect(new Set(PAYMENT_ASSETS.map((a) => a.label)).size).toBe(PAYMENT_ASSETS.length);
  });

  it('availability is a state with a reason: RLUSD is not issued on devnet; a bad issuer checksum is refused', () => {
    expect(assetAvailability('USD-tokenZ/1', 'testnet').state).toBe('available');
    expect(assetAvailability('USD-tokenZ/1', 'devnet')).toEqual(expect.objectContaining({ state: 'not-issued' }));
    expect(assetAvailability('CAPPZ', 'devnet').state).toBe('available');
    applyNetworkAddressOverrides({ devnet: { issuer: { address: 'rN7n7otQDd6FczFgLdlqtyMVrn3WkRxBPK' } } }); // fails checksum
    try { expect(assetAvailability('CAPPZ', 'devnet').state).toBe('invalid-config'); } finally { applyNetworkAddressOverrides({}); }
    expect(assetAvailability('XRP', 'devnet').state).toBe('available');
  });

  it('issued values round-trip exactly, with no floats', () => {
    expect(issuedValue(100_500_000n, 'USD-tokenZ/1')).toBe('100.5');
    expect(unitsOfIssuedValue('100.5', 'USD-tokenZ/1')).toBe(100_500_000n);
    expect(unitsOfIssuedValue('0.0000001', 'USD-tokenZ/1')).toBeNull();
    expect(unitsOfIssuedValue('1e3', 'USD-tokenZ/1')).toBeNull();
  });

  it('stageMath (import-free, shared with the payments function) knows every asset the registry does', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../lib/marketplace/stageMath.ts'), 'utf8');
    for (const a of PAYMENT_ASSETS) expect(src).toContain(a.code.includes('/') ? `'${a.code}': ${a.minor.toLocaleString('en-US').replace(/,/g, '_')}` : `${a.code}: ${a.minor.toLocaleString('en-US').replace(/,/g, '_')}`);
  });
});

describe('an RLUSD (USD-tokenZ/1) deal paid stage by stage on the ledger', () => {
  it('freezes the ledger-staged rail, needs no funding, and is paid per accepted stage with fee legs to the collection account', async () => {
    const { r, contractId } = await tokenDeal(true);
    let c = r.state.contracts.find((x) => x.contractId === contractId)!;
    expect(c.rail).toBe('ledger-staged'); expect(contractRail(c)).toBe('ledger-staged');
    expect(c.state).toBe('in-progress');
    expect(c.nextAction.by).toBe('seller');
    await expect(M.buildFund(r.state, r.as(DEMO_YOU), contractId, 10, { rail: 'usd-reference', reference: 'x' })).rejects.toThrow(/hold nothing/);

    for (let i = 0; i < c.milestones.length; i++) {
      r.apply(await M.buildEvidence(r.state, r.as('north-star-grain'), contractId, i, { kind: 'document', hash: 'ab'.repeat(32), note: '' }));
      r.apply(await M.buildAffirm(r.state, r.as(DEMO_YOU), contractId, i));
      c = r.state.contracts.find((x) => x.contractId === contractId)!;
      expect(c.nextAction.action).toMatch(/^Pay .* on the ledger/);
      await expect(M.buildRelease(r.state, r.as(DEMO_YOU), contractId, i)).rejects.toThrow(/marketplace\.stage\.pay/);
      const prepared = prepareStagePayments(c, i, BUYER, SELLER, 'testnet');
      expect(prepared.map((p) => p.account)).toEqual([SELLER, ARC]);
      expect(prepared[0].tx.Amount).toEqual(expect.objectContaining({ currency: RLUSD_HEX, issuer: RLUSD_TESTNET }));
      const lts = prepared.map((p) => paymentLt({ from: BUYER, to: p.account, value: (p.tx.Amount as { value: string }).value, contractId, milestone: i }));
      const policy = settlementPolicyFor('testnet');
      // Wrong issuer, short payment and a reused hash are refused.
      await expect(M.buildPayStageOnLedger(r.state, r.as(DEMO_YOU), contractId, i, policy, [paymentLt({ from: BUYER, to: SELLER, value: (prepared[0].tx.Amount as { value: string }).value, issuer: ARC, contractId, milestone: i }), lts[1]])).rejects.toThrow(/did not deliver RLUSD from its issuer/);
      await expect(M.buildPayStageOnLedger(r.state, r.as(DEMO_YOU), contractId, i, policy, [paymentLt({ from: BUYER, to: SELLER, value: '0.01', contractId, milestone: i }), lts[1]])).rejects.toThrow(/owed/);
      r.apply(await M.buildPayStageOnLedger(r.state, r.as(DEMO_YOU), contractId, i, policy, lts));
      if (i === 0) await expect(M.buildPayStageOnLedger(r.state, r.as(DEMO_YOU), contractId, 0, policy, lts)).rejects.toThrow(/already paid/);
    }
    c = r.state.contracts.find((x) => x.contractId === contractId)!;
    expect(c.state).toBe('completed');
    expect(c.escrow.balance).toBe(0);
    expect(c.feeCharges.every((f) => f.settlement === 'validated' && f.currency === 'USD-tokenZ/1')).toBe(true);
    expect(c.feeCharges.reduce((a, f) => a + f.feeUnits, 0)).toBe(contractFeePlan(c).feeUnits);
    expect(c.payments.every((p) => p.confirmedBy === 'ledger')).toBe(true);
  });

  it('approves the exact stage Payment and refuses substitutions', async () => {
    const { r, contractId } = await tokenDeal(false);
    r.apply(await M.buildEvidence(r.state, r.as('north-star-grain'), contractId, 0, { kind: 'document', hash: 'ab'.repeat(32), note: '' }));
    const c0 = r.state.contracts.find((x) => x.contractId === contractId)!;
    const [leg] = prepareStagePayments(c0, 0, BUYER, SELLER, 'testnet');
    const tx: Record<string, unknown> = { ...leg.tx, Fee: '12', Sequence: 5, LastLedgerSequence: 99 };
    const now = r.as(DEMO_YOU, 1).at;
    const codes = async (t: Record<string, unknown>) => { const d = await evaluateSigningIntent(r.state, { network: 'testnet', contractId, milestone: 0, tx: t }, now); return d.approved ? [] : d.reasons.map((x) => x.code); };
    expect(await codes(tx)).toEqual(['not-accepted']);
    r.apply(await M.buildAffirm(r.state, r.as(DEMO_YOU), contractId, 0));
    const ok = await evaluateSigningIntent(r.state, { network: 'testnet', contractId, milestone: 0, tx }, r.as(DEMO_YOU, 1).at);
    expect(ok.approved && ok.approval.action).toBe('pay');
    const later = r.as(DEMO_YOU, 1).at;
    const refuse = async (over: Record<string, unknown>) => { const d = await evaluateSigningIntent(r.state, { network: 'testnet', contractId, milestone: 0, tx: { ...tx, ...over } }, later); return d.approved ? [] : d.reasons.map((x) => x.code); };
    expect(await refuse({ Destination: ARC })).toContain('leg-mismatch');
    expect(await refuse({ Amount: { ...(tx.Amount as object), issuer: ARC } })).toContain('leg-mismatch');
    expect(await refuse({ SendMax: '1' })).toContain('tx-extra-fields');
    expect(await refuse({ Flags: 0x00020000 })).toContain('partial-payment');
    expect(await refuse({ Memos: [] })).toContain('memo');
  });

  it('refuses a price in an asset the market\'s network does not offer, and keeps daily limits per asset', async () => {
    const r = await seedDemoMarket(START);
    await expect(M.buildListing(r.state, { ...r.as('north-star-grain'), network: 'devnet' }, { listingId: 'l-dev', sellerId: 'north-star-grain', categoryId: 'crops/grains', kind: 'sale', title: 't', description: 'x', unit: 'bu', pricePerUnit: { amount: 4, currency: 'USD-tokenZ/1' }, quantity: 1, region: 'MN', delivery: 'ship', leadDays: 7, attributes: {} })).rejects.toThrow(/not issued on devnet/);
    expect(committedKey('a', START, 'XRP')).not.toBe(committedKey('a', START, 'USD'));
  });
});

describe('wallet funding instructions (no provider integrated)', () => {
  it('mainnet: exchange withdrawal, trust line first for tokens, reserves counted; testnet: faucet', () => {
    const m = fundingNeed({ network: 'mainnet', currency: 'USD-tokenZ/1', amount: 50, accountExists: false });
    expect(m.trustLine).toEqual({ currencyHex: RLUSD_HEX, issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' });
    expect(m.xrpForReserves).toBeCloseTo(1.201, 6);
    expect(m.steps.join(' ')).toMatch(/exchange/); expect(m.steps.join(' ')).toMatch(/trust line/);
    expect(m.steps.join(' ')).not.toMatch(/moonpay|ramp\.network/i);
    expect(fundingNeed({ network: 'testnet', currency: 'XRP', amount: 5, accountExists: true }).steps[0]).toMatch(/faucet/);
    expect(fundingNeed({ network: 'devnet', currency: 'USD-tokenZ/1', amount: 5, accountExists: true }).steps[0]).toMatch(/not issued on devnet/);
  });
});

describe('settlement check for issued tokens (trust lines, issuer flags)', () => {
  const fakeLedger = (lines: Record<string, Array<Record<string, unknown>>>, issuerFlags: number): typeof fetch => (async (_u: unknown, init?: { body?: string }) => {
    const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: Array<Record<string, unknown>> };
    const p = params[0];
    const result = method === 'account_lines' ? { lines: lines[String(p.account)] ?? [] }
      : method === 'account_info' ? (p.account === RLUSD_TESTNET ? { account_data: { Flags: issuerFlags, Balance: '1' } } : { account_data: { Flags: 0, Balance: '50000000', OwnerCount: 1 } })
      : method === 'server_info' ? { info: { validated_ledger: { reserve_base_xrp: 1, reserve_inc_xrp: 0.2, seq: 5 } } } : { transactions: [] };
    return new Response(JSON.stringify({ result }), { status: 200 });
  }) as unknown as typeof fetch;

  it('stops when the recipient has no trust line or the payer holds too little; reports that RLUSD cannot be escrowed', async () => {
    const { runCounterpartyCheck } = await import('../lib/marketplace/counterpartyCheck');
    const none = await runCounterpartyCheck({ network: 'testnet', address: SELLER, payer: BUYER, currency: 'USD-tokenZ/1', amount: 10 }, null, START, fakeLedger({}, 0));
    expect(none.verdict).toBe('stop');
    expect(none.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(['recipient-no-trust-line', 'payer-no-trust-line', 'asset-staged']));
    const line = (bal: string) => [{ currency: RLUSD_HEX, balance: bal, limit: '1000000' }];
    const ok = await runCounterpartyCheck({ network: 'testnet', address: SELLER, payer: BUYER, currency: 'USD-tokenZ/1', amount: 10 }, null, START, fakeLedger({ [SELLER]: line('0'), [BUYER]: line('25') }, 0));
    expect(ok.reasons.filter((r) => r.level === 'stop')).toEqual([]);
    expect(ok.asset?.escrowable).toBe(false);
    const short = await runCounterpartyCheck({ network: 'testnet', address: SELLER, payer: BUYER, currency: 'USD-tokenZ/1', amount: 30 }, null, START, fakeLedger({ [SELLER]: line('0'), [BUYER]: line('25') }, 0x40000000));
    expect(short.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(['payer-short-token', 'asset-escrowable']));
  });
});
