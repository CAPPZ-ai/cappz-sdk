// @vitest-environment node
/**
 * COPE node crystallized. Node ID: v15-31-00-payment-channels-test.
 * Provenance: m/44'/144'/100'/principles/cope/v1#marketplace
 *
 * The ledger-channel rail: metered use paid through one XRPL payment channel. Ledger transactions are faked as the
 * validated ledger reader returns them (normalizeTx), metadata included, since only what the ledger DID counts.
 */
import { describe, expect, it } from 'vitest';
import { hashes, Wallet } from 'xrpl';
import { DEMO_YOU, seedDemoMarket } from '../lib/marketplace/demo';
import * as M from '../lib/marketplace/model';
import { buildFeeSchedule, NO_FEES } from '../lib/marketplace/fees';
import { normalizeTx, type LedgerTx } from '../lib/xrpl/ledgerCheck';
import { RIPPLE_EPOCH, TF_CLOSE, channelFeeQuote, contractRail, prepareChannelClaim, prepareChannelClose, prepareChannelCreate, prepareChannelFeePayments, settlementPolicyFor, signChannelClaim, verifyChannelClaim } from '../lib/marketplace/settlement';
import { evaluateSigningIntent } from '../lib/marketplace/signingApproval';
import { executeAgentOperation } from '../lib/marketplace/agentApi';
import { MARKETPLACE_VERBS } from '../lib/marketplace/marketplaceVerbs';

const START = '2026-11-01T12:00:00.000Z';
const BUYER_W = Wallet.generate(); const SELLER_W = Wallet.generate(); const ARC = Wallet.generate().classicAddress;
const BUYER = BUYER_W.classicAddress, SELLER = SELLER_W.classicAddress;
const SELLER_ID = 'north-star-grain';
const policy = settlementPolicyFor('testnet');
const CAP_DROPS = 5_000_000n; // 100 queries × 0.05 XRP

let n = 0;
const nextHash = () => (++n).toString(16).toUpperCase().padStart(64, 'C');
const memo = (s: string) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
function lt(tx: Record<string, unknown>, meta: Record<string, unknown>, at: string, opts: { result?: string; validated?: boolean } = {}): LedgerTx {
  return normalizeTx({ hash: nextHash(), validated: opts.validated ?? true, ledger_index: 100 + n, close_time_iso: at, tx_json: tx, meta: { TransactionResult: opts.result ?? 'tesSUCCESS', ...meta } }, 'testnet', at);
}
const createLt = (tx: Record<string, unknown>, at: string, sequence = 7) => lt({ ...tx, Sequence: sequence }, { AffectedNodes: [{ CreatedNode: { LedgerEntryType: 'PayChannel', LedgerIndex: hashes.hashPaymentChannel(String(tx.Account), String(tx.Destination), sequence), NewFields: { Account: tx.Account, Destination: tx.Destination, Amount: tx.Amount, SettleDelay: tx.SettleDelay } } }] }, at);
const claimLt = (account: string, channelId: string, balance: bigint, at: string, opts: { close?: boolean; signature?: string } = {}) =>
  lt(prepareChannelClaim(account, channelId, balance, opts.signature ?? signChannelClaim(channelId, balance, BUYER_W.privateKey), BUYER_W.publicKey, opts.close),
    { AffectedNodes: [{ [opts.close ? 'DeletedNode' : 'ModifiedNode']: { LedgerEntryType: 'PayChannel', LedgerIndex: channelId, FinalFields: { Amount: CAP_DROPS.toString(), Balance: balance.toString() } } }] }, at);
const feeLt = (from: string, to: string, drops: number, contractId: string, at: string) =>
  lt({ TransactionType: 'Payment', Account: from, Destination: to, Amount: String(drops), Memos: [{ Memo: { MemoType: memo('cappz-marketplace-monetary'), MemoData: memo(JSON.stringify({ class: 'monetary', contractId, deliveryIndex: 0 })) } }] }, { delivered_amount: String(drops) }, at);

async function meteredDeal(opts: { fees?: boolean; buyerId?: string } = {}) {
  const r = await seedDemoMarket(START);
  r.apply(await buildFeeSchedule('op', r.as('op', 1).at, opts.fees === false
    ? { marketplace: NO_FEES, securities: NO_FEES, recipients: [], note: 'fees off' }
    : { marketplace: { percent: { enabled: true, bps: 200 }, flat: { enabled: false, amounts: {} }, perRecord: { enabled: false, amounts: {} } }, securities: NO_FEES, recipients: [{ account: ARC, label: 'Revenue', bps: 10_000 }], collector: { account: ARC, label: 'ARC' }, note: '2%' }));
  const buyerId = opts.buyerId ?? DEMO_YOU;
  for (const [id, acct] of [[buyerId, BUYER], [SELLER_ID, SELLER]] as const) { const p = r.state.parties.get(id)!; r.apply(await M.buildProfile(r.state, r.as(id, 1), { ...p, xrplAccount: acct })); }
  r.apply(await M.buildListing(r.state, { ...r.as(SELLER_ID), network: 'testnet' }, { listingId: 'l-metered', sellerId: SELLER_ID, categoryId: 'digital', kind: 'service', title: 'Agronomy Q&A API', description: 'Per query', unit: 'query', pricePerUnit: { amount: 0.05, currency: 'XRP' }, quantity: 10_000, region: 'MN', delivery: 'online', leadDays: 0, attributes: {}, metered: true }));
  return { r, buyerId };
}
const view = (r: Awaited<ReturnType<typeof seedDemoMarket>>, id: string) => r.state.contracts.find((x) => x.contractId === id)!;

describe('metered listings and orders (rail ledger-channel)', () => {
  it('a metered listing is XRP-priced only; an order forms one capped channel stage', async () => {
    const { r } = await meteredDeal();
    await expect(M.buildListing(r.state, r.as(SELLER_ID), { listingId: 'l-usd', sellerId: SELLER_ID, categoryId: 'digital', kind: 'service', title: 't', description: 'x', unit: 'query', pricePerUnit: { amount: 1, currency: 'USD' }, quantity: 10, region: 'MN', delivery: 'online', leadDays: 0, attributes: {}, metered: true })).rejects.toThrow(/XRP only/);
    const o = await M.buildOrder(r.state, r.as(DEMO_YOU), 'l-metered', 100); r.apply(o.txs);
    const c = view(r, o.contractId);
    expect(c.rail).toBe('ledger-channel'); expect(contractRail(c)).toBe('ledger-channel');
    expect(c.milestones).toHaveLength(1);
    expect(c.milestones[0]).toEqual(expect.objectContaining({ label: 'Metered use (up to 100 query)', share: 1 }));
    expect((Date.parse(c.milestones[0].dueBy) - Date.parse(c.formedAt.slice(0, 10))) / 86_400_000).toBeLessThanOrEqual(29);
    expect(c.state).toBe('awaiting-funding'); expect(c.because).toMatch(/payment channel/);
    expect(c.nextAction).toEqual(expect.objectContaining({ by: 'buyer' })); expect(c.nextAction.action).toMatch(/^Open the payment channel/);
    await expect(M.buildFund(r.state, r.as(DEMO_YOU), o.contractId, 5, { rail: 'usd-reference', reference: 'x' })).rejects.toThrow(/payment channel/);
    expect(MARKETPLACE_VERBS).toEqual(expect.arrayContaining(['marketplace.channel.open', 'marketplace.channel.settle', 'marketplace.channel.close']));
  });
});

describe('a metered deal through a payment channel', () => {
  it('opens (exact cap, seller, ≤ 30-day CancelAfter), settles increments with seller-paid fee legs, closes and completes', async () => {
    const { r } = await meteredDeal();
    const o = await M.buildOrder(r.state, r.as(DEMO_YOU), 'l-metered', 100); r.apply(o.txs);
    const id = o.contractId;
    let c = view(r, id);
    const at = r.as(DEMO_YOU, 1).at;
    const create = prepareChannelCreate(c, BUYER, SELLER, BUYER_W.publicKey, at);
    expect(create).toEqual(expect.objectContaining({ TransactionType: 'PaymentChannelCreate', Amount: CAP_DROPS.toString(), Destination: SELLER, SettleDelay: 3600 }));

    // Wrong cap, wrong destination, too long a hold, not validated: refused.
    await expect(M.buildOpenChannel(r.state, r.as(DEMO_YOU), id, policy, createLt({ ...create, Amount: '4000000' }, at))).rejects.toThrow(/cap is 5000000/);
    await expect(M.buildOpenChannel(r.state, r.as(DEMO_YOU), id, policy, createLt({ ...create, Destination: ARC }, at))).rejects.toThrow(/not the seller's account/);
    await expect(M.buildOpenChannel(r.state, r.as(DEMO_YOU), id, policy, createLt({ ...create, CancelAfter: Number(create.CancelAfter) + 10 * 86_400 }, at))).rejects.toThrow(/30-day billing cycle/);
    const { CancelAfter: _ca, ...noCancel } = create;
    await expect(M.buildOpenChannel(r.state, r.as(DEMO_YOU), id, policy, createLt(noCancel, at))).rejects.toThrow(/No CancelAfter/);
    await expect(M.buildOpenChannel(r.state, r.as(SELLER_ID), id, policy, createLt(create, at))).rejects.toThrow(/Only the buyer/);

    const open = createLt(create, at);
    r.apply(await M.buildOpenChannel(r.state, r.as(DEMO_YOU), id, policy, open));
    c = view(r, id);
    const channelId = hashes.hashPaymentChannel(BUYER, SELLER, 7);
    expect(c.channel).toEqual(expect.objectContaining({ channelId, capDrops: CAP_DROPS.toString(), releasedDrops: '0', closed: false, publicKey: BUYER_W.publicKey }));
    expect(c.ledgerEscrows).toEqual([]);
    expect(c.state).toBe('in-progress'); expect(c.because).toMatch(/Payment channel opened/);
    expect(c.nextAction.by).toBe('buyer'); expect(c.nextAction.action).toMatch(/sign claims/);
    await expect(M.buildOpenChannel(r.state, r.as(DEMO_YOU), id, policy, createLt(create, at, 8))).rejects.toThrow(/already open/);

    // First redemption: 40 queries = 2 XRP; the fee (2%) is paid by the seller from their own account.
    const t1 = r.as(SELLER_ID, 60).at;
    const claim1 = claimLt(SELLER, channelId, 2_000_000n, t1);
    expect(channelFeeQuote(c, 0n, 2_000_000n).feeUnits).toBe(40_000);
    await expect(M.buildChannelSettle(r.state, r.as(SELLER_ID), id, policy, claim1)).rejects.toThrow(/Pay the ARC fee leg/);
    await expect(M.buildChannelSettle(r.state, r.as(SELLER_ID), id, policy, claim1, [feeLt(BUYER, ARC, 40_000, id, t1)])).rejects.toThrow(/Sent from/);
    await expect(M.buildChannelSettle(r.state, r.as(SELLER_ID), id, policy, claim1, [feeLt(SELLER, ARC, 39_999, id, t1)])).rejects.toThrow(/owed 40000/);
    await expect(M.buildChannelSettle(r.state, r.as(DEMO_YOU), id, policy, claim1, [feeLt(SELLER, ARC, 40_000, id, t1)])).rejects.toThrow(/Only the seller/);
    const [fee1] = prepareChannelFeePayments(c, SELLER, 0n, 2_000_000n, 'testnet');
    expect(fee1).toEqual(expect.objectContaining({ account: ARC, units: 40_000 }));
    r.apply(await M.buildChannelSettle(r.state, r.as(SELLER_ID), id, policy, claim1, [feeLt(SELLER, ARC, 40_000, id, t1)]));
    c = view(r, id);
    expect(c.channel).toEqual(expect.objectContaining({ releasedDrops: '2000000', unitsUsed: 40 }));
    expect(c.milestoneStates[0].state).not.toBe('released');
    expect(c.state).toBe('in-progress'); expect(c.because).toMatch(/40 of 100 query used/);
    expect(c.nextAction.by).toBe('seller'); expect(c.nextAction.action).toMatch(/^Redeem the buyer's latest claim/);
    expect(c.feeCharges).toEqual([expect.objectContaining({ feeUnits: 40_000, settlement: 'validated' })]);

    // Double counting: the same claim transaction, or a claim that adds nothing, is refused; so is a balance above the cap.
    const t2 = r.as(SELLER_ID, 60).at;
    await expect(M.buildChannelSettle(r.state, r.as(SELLER_ID), id, policy, claim1, [feeLt(SELLER, ARC, 40_000, id, t2)])).rejects.toThrow(/already recorded/);
    await expect(M.buildChannelSettle(r.state, r.as(SELLER_ID), id, policy, claimLt(SELLER, channelId, 2_000_000n, t2))).rejects.toThrow(/Nothing new/);
    await expect(M.buildChannelSettle(r.state, r.as(SELLER_ID), id, policy, claimLt(SELLER, channelId, 6_000_000n, t2))).rejects.toThrow(/above the cap/);
    await expect(M.buildChannelSettle(r.state, r.as(SELLER_ID), id, policy, lt({ TransactionType: 'PaymentChannelClaim', Account: SELLER, Channel: channelId, Balance: '3000000' }, {}, t2))).rejects.toThrow(/metadata does not show/);

    // Second redemption: 70 queries in total; only the increase (1.5 XRP) is recorded, with its fee.
    const claim2 = claimLt(SELLER, channelId, 3_500_000n, t2);
    r.apply(await M.buildChannelSettle(r.state, r.as(SELLER_ID), id, policy, claim2, [feeLt(SELLER, ARC, 30_000, id, t2)]));
    c = view(r, id);
    expect(c.channel!.releasedDrops).toBe('3500000'); expect(c.channel!.unitsUsed).toBe(70);
    expect(c.escrow.released).toBeCloseTo(3.5, 6);

    // A close whose final balance is above what is recorded is refused; a close the ledger has not done yet too.
    const t3 = r.as(SELLER_ID, 60).at;
    const closeMore = lt(prepareChannelClose(SELLER, channelId), { AffectedNodes: [{ DeletedNode: { LedgerEntryType: 'PayChannel', LedgerIndex: channelId, FinalFields: { Amount: CAP_DROPS.toString(), Balance: '4000000' } } }] }, t3);
    await expect(M.buildCloseChannel(r.state, r.as(SELLER_ID), id, policy, closeMore)).rejects.toThrow(/record that redemption first/);
    const scheduled = lt(prepareChannelClose(BUYER, channelId), { AffectedNodes: [{ ModifiedNode: { LedgerEntryType: 'PayChannel', LedgerIndex: channelId, FinalFields: { Amount: CAP_DROPS.toString(), Balance: '3500000', Expiration: 1 } } }] }, t3);
    await expect(M.buildCloseChannel(r.state, r.as(DEMO_YOU), id, policy, scheduled)).rejects.toThrow(/not closed the channel yet/);

    const close = lt({ ...prepareChannelClose(SELLER, channelId), Flags: TF_CLOSE }, { AffectedNodes: [{ DeletedNode: { LedgerEntryType: 'PayChannel', LedgerIndex: channelId, FinalFields: { Amount: CAP_DROPS.toString(), Balance: '3500000' } } }] }, t3);
    r.apply(await M.buildCloseChannel(r.state, r.as(SELLER_ID), id, policy, close));
    c = view(r, id);
    expect(c.channel).toEqual(expect.objectContaining({ closed: true, refundedDrops: '1500000', closeTxHash: close.hash }));
    expect(c.state).toBe('completed');
    expect(c.because).toMatch(/Channel closed on the ledger/);
    expect(c.escrow.balance).toBe(0); expect(c.escrow.refunded).toBeCloseTo(1.5, 6);
    expect(c.feeCharges.reduce((a, f) => a + f.feeUnits, 0)).toBe(70_000); // 2% of what was used, not of the cap
    expect(c.payments.every((p) => p.confirmedBy === 'ledger')).toBe(true);
    await expect(M.buildCloseChannel(r.state, r.as(SELLER_ID), id, policy, close)).rejects.toThrow(/closed/);
  });

  it('a channel closed with nothing used cancels the deal; redeem-and-close in one claim is recorded as both', async () => {
    const { r } = await meteredDeal({ fees: false });
    const a = await M.buildOrder(r.state, r.as(DEMO_YOU), 'l-metered', 100); r.apply(a.txs);
    const at = r.as(DEMO_YOU, 1).at;
    r.apply(await M.buildOpenChannel(r.state, r.as(DEMO_YOU), a.contractId, policy, createLt(prepareChannelCreate(view(r, a.contractId), BUYER, SELLER, BUYER_W.publicKey, at), at, 21)));
    const chA = hashes.hashPaymentChannel(BUYER, SELLER, 21);
    const expired = lt(prepareChannelClose(BUYER, chA), { AffectedNodes: [{ DeletedNode: { LedgerEntryType: 'PayChannel', LedgerIndex: chA, FinalFields: { Amount: CAP_DROPS.toString() } } }] }, r.as(DEMO_YOU, 60 * 24 * 31).at);
    r.apply(await M.buildCloseChannel(r.state, r.as(DEMO_YOU), a.contractId, policy, expired));
    expect(view(r, a.contractId).state).toBe('cancelled');

    const b = await M.buildOrder(r.state, r.as(DEMO_YOU), 'l-metered', 100); r.apply(b.txs);
    const bt = r.as(DEMO_YOU, 1).at;
    r.apply(await M.buildOpenChannel(r.state, r.as(DEMO_YOU), b.contractId, policy, createLt(prepareChannelCreate(view(r, b.contractId), BUYER, SELLER, BUYER_W.publicKey, bt), bt, 22)));
    const chB = hashes.hashPaymentChannel(BUYER, SELLER, 22);
    const both = claimLt(SELLER, chB, 5_000_000n, r.as(SELLER_ID, 30).at, { close: true });
    r.apply(await M.buildChannelSettle(r.state, r.as(SELLER_ID), b.contractId, policy, both));
    r.apply(await M.buildCloseChannel(r.state, r.as(SELLER_ID), b.contractId, policy, both));
    const c = view(r, b.contractId);
    expect(c.state).toBe('completed'); expect(c.channel!.unitsUsed).toBe(100); expect(c.channel!.refundedDrops).toBe('0');
  });

  it('claims sign and verify round trip (cumulative drops; any change fails)', () => {
    const ch = hashes.hashPaymentChannel(BUYER, SELLER, 3);
    const sig = signChannelClaim(ch, 1_234_567n, BUYER_W.privateKey);
    expect(verifyChannelClaim(ch, 1_234_567n, sig, BUYER_W.publicKey)).toBe(true);
    expect(verifyChannelClaim(ch, 1_234_568n, sig, BUYER_W.publicKey)).toBe(false);
    expect(verifyChannelClaim(hashes.hashPaymentChannel(BUYER, SELLER, 4), 1_234_567n, sig, BUYER_W.publicKey)).toBe(false);
    expect(verifyChannelClaim(ch, 1_234_567n, sig, SELLER_W.publicKey)).toBe(false);
    expect(verifyChannelClaim(ch, 1_234_567n, 'nonsense', BUYER_W.publicKey)).toBe(false);
  });
});

describe('signing approval for payment channels', () => {
  it('approves the exact PaymentChannelCreate and refuses substitutions; approves a valid redemption only', async () => {
    const { r } = await meteredDeal({ fees: false });
    const o = await M.buildOrder(r.state, r.as(DEMO_YOU), 'l-metered', 100); r.apply(o.txs);
    const now = r.as(DEMO_YOU, 1).at;
    const c = view(r, o.contractId);
    const tx: Record<string, unknown> = { ...prepareChannelCreate(c, BUYER, SELLER, BUYER_W.publicKey, now), Fee: '12', Sequence: 9, LastLedgerSequence: 99 };
    const intent = (t: Record<string, unknown>) => evaluateSigningIntent(r.state, { network: 'testnet', contractId: o.contractId, milestone: 0, tx: t }, now);
    const ok = await intent(tx);
    expect(ok.approved && ok.approval.action).toBe('channel');
    expect(ok.approved && ok.approval.amountDrops).toBe(CAP_DROPS.toString());
    const refuse = async (over: Record<string, unknown>) => { const d = await intent({ ...tx, ...over }); return d.approved ? [] : d.reasons.map((x) => x.code); };
    expect(await refuse({ Amount: '5000001' })).toContain('cap-mismatch');
    expect(await refuse({ Destination: ARC })).toContain('destination');
    expect(await refuse({ CancelAfter: Math.floor(Date.parse(now) / 1000) - RIPPLE_EPOCH + 40 * 86_400 })).toContain('hold-too-long');
    expect(await refuse({ CancelAfter: undefined })).toContain('no-cancel-after');
    expect(await refuse({ DestinationTag: 1 })).toContain('tx-extra-fields');
    expect(await refuse({ Memos: [] })).toContain('memo');
    expect(await refuse({ SettleDelay: 0 })).toContain('settle-delay');
    expect(await refuse({ Account: ARC })).toContain('not-buyer');

    // After opening: the seller's redemption with the buyer's real claim is approved; a forged or over-cap one is not.
    r.apply(await M.buildOpenChannel(r.state, r.as(DEMO_YOU), o.contractId, policy, createLt(prepareChannelCreate(c, BUYER, SELLER, BUYER_W.publicKey, now), now, 9)));
    const ch = hashes.hashPaymentChannel(BUYER, SELLER, 9);
    const later = r.as(SELLER_ID, 5).at;
    const claimTx = (b: bigint, sig = signChannelClaim(ch, b, BUYER_W.privateKey)) => ({ ...prepareChannelClaim(SELLER, ch, b, sig, BUYER_W.publicKey), Fee: '12', Sequence: 3, LastLedgerSequence: 99 });
    const decide = (t: Record<string, unknown>) => evaluateSigningIntent(r.state, { network: 'testnet', contractId: o.contractId, milestone: 0, tx: t }, later);
    const good = await decide(claimTx(1_000_000n));
    expect(good.approved && good.approval.action).toBe('claim');
    expect(good.approved && good.approval.actorPartyId).toBe(SELLER_ID);
    const codes = async (t: Record<string, unknown>) => { const d = await decide(t); return d.approved ? [] : d.reasons.map((x) => x.code); };
    expect(await codes(claimTx(1_000_000n, signChannelClaim(ch, 999_999n, BUYER_W.privateKey)))).toContain('claim-signature');
    expect(await codes(claimTx(6_000_000n))).toContain('over-cap');
    expect(await codes({ ...claimTx(1_000_000n), Account: BUYER })).toContain('not-seller');
    expect(await codes({ ...claimTx(1_000_000n), Flags: 0x00010000 })).toContain('tx-flags'); // tfRenew: never
    const closeOk = await decide({ ...prepareChannelClose(BUYER, ch), Fee: '12', Sequence: 4, LastLedgerSequence: 99 });
    expect(closeOk.approved).toBe(true);
  });
});

describe('agent buyers under a mandate', () => {
  it('opening a channel needs marketplace.channel.open within the per-contract limit', async () => {
    const { r } = await meteredDeal({ buyerId: 'agent-petalbot', fees: false });
    const exp = new Date(Date.parse(START) + 90 * 86_400_000).toISOString();
    const xrp = (amount: number) => ({ amount, currency: 'XRP' as const });
    r.apply((await M.buildMandate(r.state, r.as('agent-petalbot'), 'agent-petalbot', { verbs: ['marketplace.order.place'], categories: ['digital'], maxPerContract: xrp(100), maxPerDay: xrp(1000), approvalAbove: null, expiresAt: exp })).txs);
    const o = await M.buildOrder(r.state, r.as('agent-petalbot'), 'l-metered', 100); r.apply(o.txs);
    const at = r.as('agent-petalbot', 1).at;
    const c = view(r, o.contractId);
    const create = prepareChannelCreate(c, BUYER, SELLER, BUYER_W.publicKey, at);
    await expect(M.buildOpenChannel(r.state, r.as('agent-petalbot'), o.contractId, policy, createLt(create, at))).rejects.toThrow(/No mandate allows marketplace\.channel\.open/);
    const small = await M.buildMandate(r.state, r.as('agent-petalbot'), 'agent-petalbot', { verbs: ['marketplace.channel.open'], categories: ['digital'], maxPerContract: xrp(2), maxPerDay: xrp(1000), approvalAbove: null, expiresAt: exp }); r.apply(small.txs);
    await expect(M.buildOpenChannel(r.state, r.as('agent-petalbot'), o.contractId, policy, createLt(create, at))).rejects.toThrow(/per-contract limit of 2 XRP/);
    const tx = { ...create, Fee: '12', Sequence: 9, LastLedgerSequence: 99 };
    const d = await evaluateSigningIntent(r.state, { network: 'testnet', contractId: o.contractId, milestone: 0, tx }, at);
    expect(d.approved ? [] : d.reasons.map((x) => x.code)).toContain('mandate');
    r.apply(await M.buildRevokeMandate(r.state, r.as('agent-petalbot'), small.mandateId));
    r.apply((await M.buildMandate(r.state, r.as('agent-petalbot'), 'agent-petalbot', { verbs: ['marketplace.channel.open'], categories: ['digital'], maxPerContract: xrp(10), maxPerDay: xrp(1000), approvalAbove: null, expiresAt: exp })).txs);
    // Through the agent API, reading the transaction from the ledger.
    const open = createLt(create, at);
    const res = await executeAgentOperation(r.state, r.as('agent-petalbot'), 'marketplace.channel.open', { contractId: o.contractId, txHash: open.hash }, { policy, fetchLedgerTx: async () => open });
    r.apply(res.txs);
    expect(view(r, o.contractId).channel?.channelId).toBe(hashes.hashPaymentChannel(BUYER, SELLER, 7));
    expect(res.txs[0].payload).toEqual(expect.objectContaining({ agentPartyId: 'agent-petalbot' }));
  });
});
