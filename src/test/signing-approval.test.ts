import { describe, expect, it } from 'vitest';
import { DEMO_YOU, seedDemoMarket, type DemoRunner } from '../lib/marketplace/demo';
import * as M from '../lib/marketplace/model';
import { prepareEscrowCancel, prepareEscrowFinish, prepareStageEscrows, resolveSettlementPolicy } from '../lib/marketplace/settlement';
import { normalizeTx } from '../lib/xrpl/ledgerCheck';
import { NO_FEES, buildFeeSchedule } from '../lib/marketplace/fees';
import { approvalHook, coSignTx, evaluateSigningIntent, intentHash, signApproval, verifyApproval, verifyCoSignature, MAX_FEE_DROPS, type CoSignature, type CoSignTerms, type SigningIntent } from '../lib/marketplace/signingApproval';
import { Wallet } from 'xrpl';
import { signCheck } from '../lib/marketplace/counterpartyCheck';
import { ed25519 } from '@noble/curves/ed25519';

const START = '2026-11-01T12:00:00.000Z';
const NOW = '2026-11-01T12:05:00.000Z';
const BUYER = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe', SELLER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', ATTACKER = 'rGWrZyQqhTp9Xu7G5Pkayo7bXjH4k4QYpf';
const SEED = '07'.repeat(32);
const PUB = Array.from(ed25519.getPublicKey(new Uint8Array(32).fill(7)), (b) => b.toString(16).padStart(2, '0')).join('');
const autofill = (tx: Record<string, unknown>, over: Record<string, unknown> = {}) => ({ ...tx, Fee: '12', Sequence: 42, LastLedgerSequence: 1000, ...over });
const codes = (d: Awaited<ReturnType<typeof evaluateSigningIntent>>) => (d.approved ? [] : d.reasons.map((r) => r.code));

async function xrpDeal(): Promise<{ r: DemoRunner; contractId: string }> {
  const r = await seedDemoMarket(START);
  r.apply(await buildFeeSchedule('op', r.as('op', 1).at, { marketplace: NO_FEES, securities: NO_FEES, recipients: [], note: 'fees off' }));
  for (const [id, acct] of [[DEMO_YOU, BUYER], ['north-star-grain', SELLER]] as const) { const p = r.state.parties.get(id)!; r.apply(await M.buildProfile(r.state, r.as(id, 1), { ...p, xrplAccount: acct })); }
  r.apply(await M.buildListing(r.state, r.as('north-star-grain'), { listingId: 'l-xrp', sellerId: 'north-star-grain', categoryId: 'crops/grains', kind: 'sale', title: 'Wheat for XRP', description: 'x', unit: 'bu', pricePerUnit: { amount: 2, currency: 'XRP' }, quantity: 100, region: 'MN', delivery: 'ship', leadDays: 7, attributes: {} }));
  const o = await M.buildOrder(r.state, r.as(DEMO_YOU), 'l-xrp', 50); r.apply(o.txs);
  return { r, contractId: o.contractId };
}

describe('deal-bound signing approval', () => {
  it('approves exactly the stage escrow the deal allows, and refuses every substitution', async () => {
    const { r, contractId } = await xrpDeal();
    const c = r.state.contracts.find((x) => x.contractId === contractId)!;
    const [leg] = await prepareStageEscrows(c, 0, BUYER, SELLER, 'CD'.repeat(32), NOW);
    const tx = autofill(leg.tx);
    const ok = await evaluateSigningIntent(r.state, { network: 'testnet', contractId, milestone: 0, tx }, NOW);
    expect(ok.approved).toBe(true);
    if (!ok.approved) return;
    expect(ok.approval).toEqual(expect.objectContaining({ action: 'fund', account: BUYER, destination: SELLER, amountDrops: '100000000', txHash: await intentHash(tx), contractState: 'awaiting-funding' }));

    const refuse = async (over: Record<string, unknown>, intent: Partial<SigningIntent> = {}) => codes(await evaluateSigningIntent(r.state, { network: 'testnet', contractId, milestone: 0, tx: autofill(leg.tx, over), ...intent }, NOW));
    expect(await refuse({ Destination: ATTACKER })).toContain('leg-mismatch');
    expect(await refuse({ Amount: '100000001' })).toContain('leg-mismatch');
    expect(await refuse({ Amount: { currency: 'USD', issuer: ATTACKER, value: '1' } })).toContain('amount-not-xrp');
    expect(await refuse({ Account: ATTACKER })).toContain('not-buyer');
    expect(await refuse({ Condition: undefined })).toContain('no-condition');
    expect(await refuse({ CancelAfter: (leg.tx.CancelAfter as number) + 90 * 86_400 })).toContain('hold-too-long');
    expect(await refuse({ Memos: [] })).toContain('memo');
    expect(await refuse({ Fee: String(MAX_FEE_DROPS + 1) })).toContain('fee-cap');
    expect(await refuse({ LastLedgerSequence: undefined })).toContain('no-expiry');
    expect(await refuse({ DestinationTag: 7 })).toContain('tx-extra-fields');
    expect((await refuse({}, { milestone: 7 }))).toContain('no-milestone');
    expect(await refuse({}, { contractId: 'ct-nope' })).toContain('no-contract');
    expect(codes(await evaluateSigningIntent(r.state, { network: 'testnet', contractId, milestone: 0, tx: { TransactionType: 'Payment', Account: BUYER, Destination: ATTACKER, Amount: '1' } }, NOW))).toEqual(['tx-type']);
  });

  it('a guard verifies the signed approval against the transaction it is about to sign', async () => {
    const { r, contractId } = await xrpDeal();
    const c = r.state.contracts.find((x) => x.contractId === contractId)!;
    const [leg] = await prepareStageEscrows(c, 0, BUYER, SELLER, 'CD'.repeat(32), NOW);
    const tx = autofill(leg.tx);
    const d = await evaluateSigningIntent(r.state, { network: 'testnet', contractId, milestone: 0, tx }, NOW);
    if (!d.approved) throw new Error('expected approval');
    const signed = signApproval(d.approval, SEED);
    expect(await verifyApproval(signed, tx, PUB, NOW)).toEqual([]);
    // The wallet adds its key and signature: still the same approved intent.
    expect(await verifyApproval(signed, { ...tx, SigningPubKey: 'ED00', TxnSignature: 'AB' }, PUB, NOW)).toEqual([]);
    expect(await verifyApproval(signed, { ...tx, Destination: ATTACKER }, PUB, NOW)).toContain('The transaction differs from the one approved.');
    expect(await verifyApproval(signed, tx, 'ab'.repeat(32), NOW)).toContain('Signed by a key other than the published one.');
    expect(await verifyApproval(signed, tx, PUB, '2026-11-01T12:20:00.000Z')).toContain('The approval has expired.');
    expect(await verifyApproval({ ...signed, approval: { ...signed.approval, amountDrops: '1' } }, tx, PUB, NOW)).toContain('The approval signature does not verify.');
    // A counterparty-check signature from the same key is not an approval (domain separation).
    const report = signCheck(signed.approval as never, SEED);
    expect(await verifyApproval({ approval: signed.approval, signature: report.signature }, tx, PUB, NOW)).toContain('The approval signature does not verify.');
  });

  it('release needs the escrow, the accepted stage and its condition; disputes stop it; refunds return to the buyer', async () => {
    const { r, contractId } = await xrpDeal();
    let c = r.state.contracts.find((x) => x.contractId === contractId)!;
    const secret = 'CD'.repeat(32);
    const [leg] = await prepareStageEscrows(c, 0, BUYER, SELLER, secret, START);
    const finishTx = autofill(prepareEscrowFinish(BUYER, BUYER, 42, leg.condition, secret), { Sequence: 43 });
    expect(codes(await evaluateSigningIntent(r.state, { network: 'testnet', contractId, milestone: 0, tx: finishTx }, NOW))).toContain('not-funded');
    const created = normalizeTx({ hash: 'A'.repeat(64), validated: true, ledger_index: 100, tx_json: { ...leg.tx, Sequence: 42, Memos: (leg.tx.Memos as Array<{ Memo: { MemoType: string; MemoData: string } }>).map((m) => ({ Memo: { MemoType: m.Memo.MemoType, MemoData: m.Memo.MemoData } })) }, meta: { TransactionResult: 'tesSUCCESS' } }, 'testnet', START);
    r.apply(await M.buildFundOnLedger(r.state, r.as(DEMO_YOU), contractId, resolveSettlementPolicy(r.txs), [{ milestone: 0, lt: created, condition: leg.condition }]));
    // Funded once: a second fund of the same stage is refused.
    const again = await prepareStageEscrows(r.state.contracts.find((x) => x.contractId === contractId)!, 0, BUYER, SELLER, secret, NOW);
    expect(codes(await evaluateSigningIntent(r.state, { network: 'testnet', contractId, milestone: 0, tx: autofill(again[0].tx) }, NOW))).toContain('already-funded');
    expect(codes(await evaluateSigningIntent(r.state, { network: 'testnet', contractId, milestone: 0, tx: finishTx }, NOW))).toContain('not-accepted');
    r.apply(await M.buildEvidence(r.state, r.as('north-star-grain'), contractId, 0, { kind: 'delivery-receipt', hash: 'e'.repeat(64), note: 'delivered' }));
    r.apply(await M.buildAffirm(r.state, r.as(DEMO_YOU), contractId, 0));
    expect((await evaluateSigningIntent(r.state, { network: 'testnet', contractId, milestone: 0, tx: finishTx }, NOW)).approved).toBe(true);
    expect(codes(await evaluateSigningIntent(r.state, { network: 'testnet', contractId, milestone: 0, tx: { ...finishTx, OfferSequence: 41 } }, NOW))).toContain('offer-sequence');
    expect(codes(await evaluateSigningIntent(r.state, { network: 'testnet', contractId, milestone: 0, tx: { ...finishTx, Condition: 'A0258020' + 'EE'.repeat(32) + '810120' } }, NOW))).toContain('condition');
    // A refund (EscrowCancel back to the buyer) of this escrow is approvable; of another one, not.
    expect((await evaluateSigningIntent(r.state, { network: 'testnet', contractId, milestone: 0, tx: autofill(prepareEscrowCancel(BUYER, BUYER, 42), { Sequence: 44 }) }, NOW)).approved).toBe(true);
    expect(codes(await evaluateSigningIntent(r.state, { network: 'testnet', contractId, milestone: 0, tx: autofill(prepareEscrowCancel(BUYER, ATTACKER, 42)) }, NOW))).toContain('owner');
    // A dispute raised after acceptance stops the release.
    r.apply(await M.buildDispute(r.state, r.as('north-star-grain'), contractId, 0, 'short delivery'));
    c = r.state.contracts.find((x) => x.contractId === contractId)!;
    expect(codes(await evaluateSigningIntent(r.state, { network: 'testnet', contractId, milestone: 0, tx: finishTx }, NOW))).toContain('disputed');
  });

  it('an agent buyer is held to its mandate; above its threshold only the grantor’s own signature counts', async () => {
    const r = await seedDemoMarket(START);
    r.apply(await buildFeeSchedule('op', r.as('op', 1).at, { marketplace: NO_FEES, securities: NO_FEES, recipients: [], note: 'fees off' }));
    const agentWallet = Wallet.generate(); const grantorWallet = Wallet.generate(); const stranger = Wallet.generate();
    const xrp = (amount: number) => ({ amount, currency: 'XRP' as const });
    // An agent whose principal is blue-ridge-herbs (a person's business); the principal grants a mandate; the agent buys above the 50 XRP threshold.
    r.apply(await M.buildProfile(r.state, r.as('agent-buyer', 1), { partyId: 'agent-buyer', kind: 'agent', name: 'Herb buyer agent', roles: ['buyer'], region: 'CA', categories: [], principal: { partyId: 'blue-ridge-herbs' } } as never));
    r.apply((await M.buildMandate(r.state, r.as('blue-ridge-herbs'), 'agent-buyer', { verbs: ['marketplace.order.place', 'marketplace.escrow.fund'], categories: ['crops/specialty'], maxPerContract: xrp(500), maxPerDay: xrp(1000), approvalAbove: xrp(50), expiresAt: '2026-12-01T00:00:00.000Z' })).txs);
    for (const [id, acct] of [['agent-buyer', agentWallet.classicAddress], ['north-star-grain', SELLER], ['blue-ridge-herbs', grantorWallet.classicAddress]] as const) { const p = r.state.parties.get(id)!; r.apply(await M.buildProfile(r.state, r.as(id, 1), { ...p, xrplAccount: acct })); }
    r.apply(await M.buildListing(r.state, r.as('north-star-grain'), { listingId: 'l-viola', sellerId: 'north-star-grain', categoryId: 'crops/specialty', kind: 'sale', title: 'Violas for XRP', description: 'x', unit: 'stem', pricePerUnit: { amount: 2, currency: 'XRP' }, quantity: 100, region: 'CA', delivery: 'ship', leadDays: 7, attributes: {} }));
    const o = await M.buildOrder(r.state, { ...r.as('agent-buyer'), coSignedBy: 'blue-ridge-herbs' }, 'l-viola', 50); r.apply(o.txs);
    const c = r.state.contracts.find((x) => x.contractId === o.contractId)!;
    const [leg] = await prepareStageEscrows(c, 0, agentWallet.classicAddress, SELLER, 'CD'.repeat(32), NOW);
    const intent = { network: 'testnet' as const, contractId: c.contractId, milestone: 0, tx: autofill(leg.tx) };
    const terms: CoSignTerms = { network: 'testnet', contractId: c.contractId, milestone: 0, action: 'fund', amountDrops: leg.drops, expiresAt: '2026-11-02T12:00:00.000Z' };
    const cosign = (w: Wallet, t: CoSignTerms = terms): CoSignature => ({ terms: t, txBlob: w.sign(coSignTx(w.classicAddress, t) as never).tx_blob });

    expect(codes(await evaluateSigningIntent(r.state, intent, NOW))).toContain('co-signature');
    // A name is not a signature: the agent itself, a stranger, or the grantor's key over other terms are refused.
    expect(codes(await evaluateSigningIntent(r.state, { ...intent, coSignature: cosign(agentWallet) }, NOW))).toContain('co-signature');
    expect(codes(await evaluateSigningIntent(r.state, { ...intent, coSignature: cosign(stranger) }, NOW))).toContain('co-signature');
    expect(codes(await evaluateSigningIntent(r.state, { ...intent, coSignature: cosign(grantorWallet, { ...terms, amountDrops: '1' }) }, NOW))).toContain('co-signature');
    expect(codes(await evaluateSigningIntent(r.state, { ...intent, coSignature: { ...cosign(grantorWallet), terms: { ...terms, milestone: 1 } } }, NOW))).toContain('co-signature');
    expect(codes(await evaluateSigningIntent(r.state, { ...intent, coSignature: cosign(grantorWallet, { ...terms, expiresAt: '2026-11-01T12:00:00.000Z' }) }, NOW))).toContain('co-signature');
    const ok = await evaluateSigningIntent(r.state, { ...intent, coSignature: cosign(grantorWallet) }, NOW);
    expect(ok.approved && ok.approval.coSignedBy).toBe('blue-ridge-herbs');
    // The co-signature can never be submitted: it is a no-op AccountSet that expired at ledger 1.
    expect(verifyCoSignature(cosign(grantorWallet), grantorWallet.classicAddress, NOW)).toEqual([]);
    // After the mandate expires, nothing is approved for the agent.
    expect(codes(await evaluateSigningIntent(r.state, { ...intent, coSignature: cosign(grantorWallet, { ...terms, expiresAt: '2026-12-03T00:00:00.000Z' }) }, '2026-12-02T00:00:00.000Z'))).toContain('mandate');
  });
});

describe('check service: POST /<net>/authorize', () => {
  it('answers a signed approval a guard can verify, refusals with reasons, and fails closed when the log is unreadable', async () => {
    const { authorize } = await import('../../packages/cappz-check-worker/worker');
    const { r, contractId } = await xrpDeal();
    const c = r.state.contracts.find((x) => x.contractId === contractId)!;
    const [leg] = await prepareStageEscrows(c, 0, BUYER, SELLER, 'CD'.repeat(32), NOW);
    const tx = autofill(leg.tx);
    const ok = await authorize({ contractId, milestone: 0, tx }, 'testnet', r.state, SEED, NOW);
    expect(ok.code).toBe(200);
    expect(await verifyApproval(ok.body as never, tx, PUB, NOW)).toEqual([]);
    const no = await authorize({ contractId, milestone: 0, tx: { ...tx, Destination: ATTACKER } }, 'testnet', r.state, SEED, NOW);
    expect((no.body as { approved: boolean; reasons: Array<{ code: string }> }).reasons.map((x) => x.code)).toContain('leg-mismatch');
    expect((await authorize({ contractId, milestone: 0, tx }, 'testnet', null, SEED, NOW)).code).toBe(503);
    await expect(authorize({ milestone: 0, tx }, 'testnet', r.state, SEED, NOW)).rejects.toThrow(/contractId/);
  });
});

describe('approvalHook (shared by the agent tool and the web app)', () => {
  it('signs only what the service approved and the published key signed; refusals throw with the reasons', async () => {
    const { authorize } = await import('../../packages/cappz-check-worker/worker');
    const { r, contractId } = await xrpDeal();
    const c = r.state.contracts.find((x) => x.contractId === contractId)!;
    const [leg] = await prepareStageEscrows(c, 0, BUYER, SELLER, 'CD'.repeat(32), NOW);
    const service = (async (_u: string, init: RequestInit) => { const out = await authorize(JSON.parse(String(init.body)), 'testnet', r.state, SEED, new Date().toISOString()); return new Response(JSON.stringify(out.body), { status: out.code }); }) as unknown as typeof fetch;
    const seen: string[] = [];
    const hook = approvalHook({ serviceUrl: 'https://check.example/', publicKey: PUB, network: 'testnet', contractId, milestone: 0, fetcher: service, onApproved: (a) => seen.push(a.approval.txHash) });
    const tx = autofill(leg.tx, { CancelAfter: Math.floor(Date.now() / 1000) - 946_684_800 + 86_400 * 29 });
    await hook(tx);
    expect(seen).toEqual([await intentHash(tx)]);
    await expect(hook({ ...tx, Destination: ATTACKER })).rejects.toThrow(/Not approved for signing: .*Nothing was signed/);
    const wrongKey = approvalHook({ serviceUrl: 'https://check.example', publicKey: 'ab'.repeat(32), network: 'testnet', contractId, milestone: 0, fetcher: service });
    await expect(wrongKey(tx)).rejects.toThrow(/does not cover this transaction/);
    const down = approvalHook({ serviceUrl: 'https://check.example', publicKey: PUB, network: 'testnet', contractId, milestone: 0, fetcher: (async () => { throw new Error('offline'); }) as unknown as typeof fetch });
    await expect(down(tx)).rejects.toThrow(/could not be reached.*nothing was signed/);
  });
});
