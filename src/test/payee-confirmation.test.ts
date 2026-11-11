import { describe, expect, it } from 'vitest';
import {
  bankAccountDigest, buildPayeeAnchor, buildPayeeInstructions, buildPayeeRevocation, instructionsHash, instructionsProblems, lookalike, prepareEndorsement,
  resolvePayeeLogs, runPayeeConfirmation, signPayeeReport, verifyPayeeReport, PAYEE_ANCHOR_MEMO, type PayeeInstructionsContent, type PayeeReport,
} from '../lib/marketplace/payeeConfirmation';
import { marketLedger, type MarketTxLike } from '../lib/marketplace/ledger';
import { partyAddress } from '../lib/marketplace/MarketplacePaths';
import { resolveMarket } from '../lib/marketplace/replay';
import { signCheck, verifyCheck } from '../lib/marketplace/counterpartyCheck';
import { createPaidAgent, memoryJobStore, paymentRequest, checkPayment, type LedgerTx } from '../lib/agentKit/paidAgent';
import { payeeInput, payeeOffer } from '../../packages/cappz-check-worker/worker';

const NOW = '2026-11-11T12:00:00.000Z';
const SELLER_WALLET = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';
const ESCROW_AGENT = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'; // the address the seller declares
const POISON = 'rHb9CVsTUknbpFhHyuRrkmVE1kMTg7tyTh'; // same first five / last four as ESCROW_AGENT
const FRAUD = 'rGWrZyQqhTp9Xu7G5Pkayo7bXjH4k4QYpf';
const PAYER = 'rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv';
const codes = (rs: Array<{ code: string }>) => rs.map((r) => r.code);
const hours = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();

const at = async (timestamp: string, eventType: MarketTxLike['eventType'], sourceAddress: string, payload: Record<string, unknown>): Promise<MarketTxLike> =>
  ({ ...(await marketLedger.create({ eventType, sourceAddress, targetAddress: sourceAddress, payload })), timestamp });
const profile = (partyId: string, name: string, xrplAccount: string | undefined, timestamp: string, amended = false) =>
  at(timestamp, amended ? 'ContentAmended' : 'ContentCreated', partyAddress(partyId), { contentClass: 'party', profile: { partyId, name, kind: 'organization', roles: ['seller'], region: 'NJ', about: '', capabilities: { categories: [], canPlantNew: false }, ...(xrplAccount ? { xrplAccount } : {}) } });
const decl = (partyId: string, instrument: PayeeInstructionsContent['instrument'], id = 'pi-0123456789ab', extra: Partial<PayeeInstructionsContent> = {}): PayeeInstructionsContent =>
  ({ instructionsId: id, partyId, network: 'testnet', instrument, validFrom: hours(24 * 30), validUntil: null, purpose: 'Land purchase, Block 12 Lot 3', ...extra });
const restamp = async (timestamp: string, txs: Promise<MarketTxLike[]> | MarketTxLike[]) => (await txs).map((t) => ({ ...t, timestamp }));

/** A fake XRPL JSON-RPC: anchors by hash, payer history, and enough account data for the counterparty check. */
function ledger(opts: { anchors?: Record<string, { account: string; memo: string; closeTime: string; result?: string }>; payerPaid?: Array<{ to: string; tag?: number; at: string }> } = {}) {
  return (async (_url: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body); const q = params[0];
    const ok = (result: unknown) => new Response(JSON.stringify({ result }), { status: 200 });
    if (method === 'tx') {
      const a = opts.anchors?.[q.transaction];
      if (!a) return ok({ error: 'txnNotFound', error_message: 'Transaction not found.' });
      const h = (s: string) => Buffer.from(s).toString('hex').toUpperCase();
      return ok({ hash: q.transaction, validated: true, close_time_iso: a.closeTime, meta: { TransactionResult: a.result ?? 'tesSUCCESS' }, tx_json: { TransactionType: 'AccountSet', Account: a.account, Memos: [{ Memo: { MemoType: h(PAYEE_ANCHOR_MEMO), MemoData: h(a.memo) } }] } });
    }
    if (method === 'account_tx' && q.account === PAYER && q.limit > 1) return ok({ transactions: (opts.payerPaid ?? []).map((p, i) => ({ hash: `H${i}`, validated: true, close_time_iso: p.at, meta: { TransactionResult: 'tesSUCCESS', delivered_amount: '1000000' }, tx_json: { TransactionType: 'Payment', Account: PAYER, Destination: p.to, ...(p.tag !== undefined ? { DestinationTag: p.tag } : {}) } })) });
    if (method === 'account_tx') return ok({ transactions: [{ close_time_iso: '2024-01-01T00:00:00Z' }] });
    if (method === 'server_info') return ok({ info: { validated_ledger: { reserve_base_xrp: 1, reserve_inc_xrp: 0.2, seq: 100 } } });
    if (method === 'account_info') return ok({ account_data: { Balance: '5000000000', OwnerCount: 0, Flags: 0 }, ledger_index: 100 });
    return ok({ error: 'unknownCmd' });
  }) as unknown as typeof fetch;
}

/** The seller (p-seller) declares ESCROW_AGENT and endorses it from its profile wallet `endorsedHoursAgo` ago. */
async function market(endorsedHoursAgo = 24 * 10, extra: MarketTxLike[] = []) {
  const base = [await profile('p-seller', 'Main Street Land LLC', SELLER_WALLET, hours(24 * 400)), await profile('p-town', 'Township', PAYER, hours(24 * 400))];
  const state0 = resolveMarket(base);
  const content = decl('p-seller', { kind: 'xrpl', address: ESCROW_AGENT, destinationTag: 7 });
  const { txs, hash } = await buildPayeeInstructions(state0, 'p-seller', content);
  const anchorHash = 'A'.repeat(64);
  const txsAll = [...base, ...(await restamp(hours(endorsedHoursAgo + 1), txs)), ...(await restamp(hours(endorsedHoursAgo), buildPayeeAnchor('p-seller', content.instructionsId, anchorHash))), ...extra];
  return { txs: txsAll, state: resolveMarket(txsAll), content, hash, anchors: { [anchorHash]: { account: SELLER_WALLET, memo: `${content.instructionsId}:${hash}`, closeTime: hours(endorsedHoursAgo) } } };
}

describe('payee confirmation: declarations', () => {
  it('refuses malformed declarations and never publishes a bank number', async () => {
    expect(instructionsProblems(decl('p', { kind: 'xrpl', address: 'rNOPE' }))).toEqual(expect.arrayContaining([expect.stringMatching(/not an XRPL/)]));
    expect(instructionsProblems(decl('p', { kind: 'bank', salt: '00'.repeat(16), digest: 'ab'.repeat(32), hint: 'Acct 021000021 123456789' }))).toEqual([expect.stringMatching(/four digits/)]);
    const d = await bankAccountDigest('00'.repeat(16), '021000021', '1234-5678 9');
    expect(d).toBe(await bankAccountDigest('00'.repeat(16), '021 000 021', '123456789'));
    expect(d).not.toBe(await bankAccountDigest('11'.repeat(16), '021000021', '123456789'));
  });

  it('only the party itself can declare, anchor or revoke; one id is never rewritten', async () => {
    const m = await market();
    const forged = await at(hours(1), 'ContentCreated', partyAddress('p-fraud'), { contentClass: 'payee-instructions', instructions: decl('p-seller', { kind: 'xrpl', address: FRAUD }, 'pi-ffffffffffff') });
    const foreignRevoke = await restamp(hours(1), buildPayeeRevocation('p-fraud', m.content.instructionsId, 'x'));
    const logs = await resolvePayeeLogs([...m.txs, forged, ...foreignRevoke]);
    expect(logs.get('p-seller')!.declarations.map((d) => d.content.instructionsId)).toEqual([m.content.instructionsId]);
    expect(logs.get('p-seller')!.declarations[0].revoked).toBeNull();
    await expect(buildPayeeInstructions(m.state, 'p-town', m.content)).rejects.toThrow(/your own/);
  });

  it('the endorsement is a no-op AccountSet whose memo names the declaration hash', async () => {
    const c = decl('p-seller', { kind: 'xrpl', address: ESCROW_AGENT });
    const t = prepareEndorsement(SELLER_WALLET, c.instructionsId, await instructionsHash(c));
    expect(t.TransactionType).toBe('AccountSet');
    expect(t).not.toHaveProperty('SetFlag');
    expect(Buffer.from((t.Memos as Array<{ Memo: { MemoData: string } }>)[0].Memo.MemoData, 'hex').toString()).toBe(`${c.instructionsId}:${await instructionsHash(c)}`);
  });
});

describe('payee confirmation: the check', () => {
  it('confirms declared, endorsed instructions past the cooling period', async () => {
    const m = await market();
    const r = await runPayeeConfirmation({ network: 'testnet', payee: 'p-seller', instrument: { kind: 'xrpl', address: ESCROW_AGENT, destinationTag: 7 }, amount: 1000, payer: PAYER }, m.state, m.txs, NOW, ledger({ anchors: m.anchors }));
    expect(r.binding.state).toBe('confirmed');
    expect(r.binding.control).toBe('payee-wallet-only');
    expect(codes(r.reasons)).toEqual(expect.arrayContaining(['payee-confirmed', 'control-not-proven']));
    expect(r.verdict).toBe('warn');
    expect(r.advice.join(' ')).toMatch(/second person/);
  });

  it('stops the fraud: an address the payee never declared, or one another party declared', async () => {
    const fraudDecl = await at(hours(200), 'ContentCreated', partyAddress('p-fraud'), { contentClass: 'payee-instructions', instructions: decl('p-fraud', { kind: 'xrpl', address: FRAUD }, 'pi-ffffffffffff') });
    const m = await market(240, [await profile('p-fraud', 'Main Street Land, LLC', FRAUD, hours(300)), fraudDecl]);
    const f = ledger({ anchors: m.anchors });
    const other = await runPayeeConfirmation({ network: 'testnet', payee: 'p-seller', instrument: { kind: 'xrpl', address: FRAUD } }, m.state, m.txs, NOW, f);
    expect(other.binding.state).toBe('declared-by-other');
    expect(other.verdict).toBe('stop');
    expect(codes(other.reasons)).toContain('payee-name-shared');
    const never = await runPayeeConfirmation({ network: 'testnet', payee: 'p-seller', instrument: { kind: 'xrpl', address: ESCROW_AGENT, destinationTag: 8 } }, m.state, m.txs, NOW, f);
    expect(never.binding.state).toBe('not-declared');
    expect(never.advice[0]).toBe('Do not pay.');
  });

  it('holds new endorsements for the cooling period, and a profile wallet change restarts it', async () => {
    const m = await market(10);
    const r = await runPayeeConfirmation({ network: 'testnet', payee: 'p-seller', instrument: { kind: 'xrpl', address: ESCROW_AGENT, destinationTag: 7 } }, m.state, m.txs, NOW, ledger({ anchors: m.anchors }));
    expect(r.binding.state).toBe('cooling');
    expect(r.binding.inForceFrom).toBe(new Date(Date.parse(hours(10)) + 72 * 3_600_000).toISOString());
    // A hijacked account points the profile at the attacker's wallet: the old endorsement no longer counts.
    const m2 = await market(240, [await profile('p-seller', 'Main Street Land LLC', FRAUD, hours(2), true)]);
    const r2 = await runPayeeConfirmation({ network: 'testnet', payee: 'p-seller', instrument: { kind: 'xrpl', address: ESCROW_AGENT, destinationTag: 7 } }, m2.state, m2.txs, NOW, ledger({ anchors: m2.anchors }));
    expect(r2.binding.state).toBe('unanchored');
    expect(codes(r2.reasons)).toContain('payee-wallet-changed');
  });

  it('a revocation takes effect at once; an unreadable anchor is never "fine"', async () => {
    const m = await market();
    const revoked = [...m.txs, ...(await restamp(hours(1), buildPayeeRevocation('p-seller', m.content.instructionsId, 'email compromised')))];
    const r = await runPayeeConfirmation({ network: 'testnet', payee: 'p-seller', instrument: { kind: 'xrpl', address: ESCROW_AGENT, destinationTag: 7 } }, resolveMarket(revoked), revoked, NOW, ledger({ anchors: m.anchors }));
    expect(r.binding.state).toBe('revoked');
    const down = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    const r2 = await runPayeeConfirmation({ network: 'testnet', payee: 'p-seller', instrument: { kind: 'xrpl', address: ESCROW_AGENT, destinationTag: 7 } }, m.state, m.txs, NOW, down);
    expect(r2.binding.state).toBe('anchor-unreadable');
    expect(r2.verdict).toBe('stop');
  });

  it('an anchor from the address itself proves control; a wrong memo proves nothing', async () => {
    const m = await market();
    const memo = `${m.content.instructionsId}:${m.hash}`;
    const both = [...m.txs, ...(await restamp(hours(100), buildPayeeAnchor('p-seller', m.content.instructionsId, 'B'.repeat(64))))];
    const r = await runPayeeConfirmation({ network: 'testnet', payee: 'p-seller', instrument: { kind: 'xrpl', address: ESCROW_AGENT, destinationTag: 7 } }, resolveMarket(both), both, NOW, ledger({ anchors: { ...m.anchors, ['B'.repeat(64)]: { account: ESCROW_AGENT, memo, closeTime: hours(100) } } }));
    expect(r.binding.control).toBe('address-key');
    expect(r.verdict).toBe('ok');
    const bad = await runPayeeConfirmation({ network: 'testnet', payee: 'p-seller', instrument: { kind: 'xrpl', address: ESCROW_AGENT, destinationTag: 7 } }, m.state, m.txs, NOW, ledger({ anchors: { ['A'.repeat(64)]: { account: SELLER_WALLET, memo: `${m.content.instructionsId}:${'0'.repeat(64)}`, closeTime: hours(240) } } }));
    expect(bad.binding.state).toBe('unanchored');
  });

  it('flags changed instructions and address poisoning from the payer\'s own history', async () => {
    expect(lookalike(ESCROW_AGENT, POISON)).toBe(true);
    expect(lookalike(ESCROW_AGENT, ESCROW_AGENT)).toBe(false);
    const m = await market();
    const f = ledger({ anchors: m.anchors, payerPaid: [{ to: POISON, at: hours(48) }, { to: ESCROW_AGENT, tag: 3, at: hours(24 * 90) }] });
    const r = await runPayeeConfirmation({ network: 'testnet', payee: 'p-seller', instrument: { kind: 'xrpl', address: ESCROW_AGENT, destinationTag: 7 }, payer: PAYER }, m.state, m.txs, NOW, f);
    expect(codes(r.reasons)).toEqual(expect.arrayContaining(['instructions-changed', 'lookalike-address']));
    expect(r.payerHistory!.paidPayeeElsewhere!.destinationTag).toBe(3);
  });

  it('matches a bank account by digest computed on the payer\'s device', async () => {
    const salt = 'cd'.repeat(16);
    const base = [await profile('p-seller', 'Main Street Land LLC', SELLER_WALLET, hours(24 * 400))];
    const c = decl('p-seller', { kind: 'bank', salt, digest: await bankAccountDigest(salt, '021000021', '987654321'), hint: 'First Bank ••4321' });
    const { txs, hash } = await buildPayeeInstructions(resolveMarket(base), 'p-seller', c);
    const all = [...base, ...(await restamp(hours(200), txs)), ...(await restamp(hours(199), buildPayeeAnchor('p-seller', c.instructionsId, 'C'.repeat(64))))];
    const f = ledger({ anchors: { ['C'.repeat(64)]: { account: SELLER_WALLET, memo: `${c.instructionsId}:${hash}`, closeTime: hours(199) } } });
    const ok = await runPayeeConfirmation({ network: 'testnet', payee: 'p-seller', instrument: { kind: 'bank', digests: [await bankAccountDigest(salt, '021000021', '987654321')] } }, resolveMarket(all), all, NOW, f);
    expect(ok.binding.state).toBe('confirmed');
    expect(ok.subject.instrument).toEqual({ kind: 'bank', hint: 'First Bank ••4321', matched: true });
    expect(codes(ok.reasons)).toContain('bank-holder-unverified');
    expect(JSON.stringify(ok)).not.toContain('987654321');
    const wrong = await runPayeeConfirmation({ network: 'testnet', payee: 'p-seller', instrument: { kind: 'bank', digests: [await bankAccountDigest(salt, '026009593', '111222333')] } }, resolveMarket(all), all, NOW, f);
    expect(wrong.binding.state).toBe('not-declared');
  });

  it('signs under its own domain: a payee report is not a check report', async () => {
    const m = await market();
    const r = await runPayeeConfirmation({ network: 'testnet', payee: 'p-seller', instrument: { kind: 'xrpl', address: ESCROW_AGENT, destinationTag: 7 } }, m.state, m.txs, NOW, ledger({ anchors: m.anchors }));
    const s = signPayeeReport(r, '07'.repeat(32));
    expect(verifyPayeeReport(s, s.signature.publicKey)).toBe(true);
    expect(verifyPayeeReport({ ...s, report: { ...s.report, verdict: 'ok' } as PayeeReport })).toBe(false);
    expect(verifyCheck({ report: r as never, signature: s.signature })).toBe(false);
    expect(verifyPayeeReport({ report: r, signature: signCheck(r as never, '07'.repeat(32)).signature })).toBe(false);
  });
});

describe('paid agents: a stage paid to its own address', () => {
  const tx = (over: Partial<LedgerTx>): LedgerTx => ({ hash: 'T'.repeat(64), network: 'mainnet', validated: true, result: 'tesSUCCESS', ledgerIndex: 1, type: 'Payment', account: PAYER, destination: null, deliveredDrops: null, deliveredIssued: null, destinationTag: null, fields: {}, memos: [], closeTime: NOW, checkedAt: NOW, ...over });

  it('the payee service charges the platform fee to the treasury up front and 0.1 XRP to the operator on completion', async () => {
    const offer = payeeOffer({ PAY_TO_MAINNET: 'rUqPbiwe2Z5rj2AewokbFHCGQPtwjtzjHM', AGENT_PAY_TO_MAINNET: 'rhszv2Ghe8NbqPDmmdJvJ4Cq2E3hjfYnYh' } as never, 'mainnet');
    const agent = createPaidAgent({ offer, store: memoryJobStore(), work: async () => 'ok', newJobId: () => 'job-0000000000000001' });
    const card = agent.card();
    expect(card.stages.map((s) => [s.kind, s.payTo, s.amount])).toEqual([['upfront', 'rUqPbiwe2Z5rj2AewokbFHCGQPtwjtzjHM', '0.01'], ['completion', 'rhszv2Ghe8NbqPDmmdJvJ4Cq2E3hjfYnYh', '0.1']]);
    const { job, pay } = await agent.openJob({});
    expect(pay!.destination).toBe('rUqPbiwe2Z5rj2AewokbFHCGQPtwjtzjHM');
    const req1 = await paymentRequest(job.terms, job.jobId, 1);
    expect(req1.preparedTx.Destination).toBe('rhszv2Ghe8NbqPDmmdJvJ4Cq2E3hjfYnYh');
    expect(req1.amount).toBe('0.1');
    // Paying the operator's stage to the treasury (or the reverse) does not count.
    expect(checkPayment(job.terms, req1, tx({ destination: 'rUqPbiwe2Z5rj2AewokbFHCGQPtwjtzjHM', destinationTag: req1.destinationTag, deliveredDrops: '100000' })).state).toBe('wrong-destination');
    expect(checkPayment(job.terms, req1, tx({ destination: 'rhszv2Ghe8NbqPDmmdJvJ4Cq2E3hjfYnYh', destinationTag: req1.destinationTag, deliveredDrops: '100000' })).state).toBe('paid');
  });

  it('the job keeps the request as sent, so the work step can validate it again (found on testnet)', async () => {
    const raw = { payee: 'p-seller', address: ESCROW_AGENT, destinationTag: 7 };
    const opened: Array<{ type: string; input?: unknown }> = [];
    const db = { prepare: (sql: string) => { let v: unknown[] = []; const st = { bind: (...b: unknown[]) => { v = b; return st; }, run: async () => { if (sql.startsWith('INSERT INTO events')) opened.push(JSON.parse(v[4] as string)); return {}; }, all: async () => ({ results: opened.map((e) => ({ body: JSON.stringify(e) })) }), first: async () => null }; return st; } };
    const prof = await profile('p-seller', 'Main Street Land LLC', SELLER_WALLET, hours(100));
    const rows = [{ metadata: { publicTx: { tx: prof, author: 'a1', actingParty: 'p-seller' } }, created_at: hours(100) }];
    const { default: worker } = await import('../../packages/cappz-check-worker/worker');
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify(rows), { status: 200 })) as typeof fetch;
    try {
      const env = { DB: db, CHECK_SIGNING_SEED: '07'.repeat(32), MIRROR_URL: 'http://mirror', MIRROR_KEY: 'k', PAY_TO_TESTNET: 'rnQ3gydd9kTdx6gHKzhNHSKHSq6whzdiMe', PAY_TO_MAINNET: 'rUqPbiwe2Z5rj2AewokbFHCGQPtwjtzjHM', PRICE_XRP: '0.01' };
      const res = await worker.fetch(new Request('http://x/testnet/payee/jobs', { method: 'POST', body: JSON.stringify({ input: raw }) }), env as never, { waitUntil: () => {} });
      expect(res.status).toBe(201);
      expect((await res.json()).pay.amount).toBe('0.01');
    } finally { globalThis.fetch = realFetch; }
    const input = opened.find((e) => e.type === 'JobOpened')!.input;
    expect(input).toEqual(raw);
    expect(() => payeeInput(input)).not.toThrow();
  });

  it('validates the request before any job opens', () => {
    expect(() => payeeInput({ payee: 'p-1', address: 'rNOPE' })).toThrow(/not a valid/);
    expect(() => payeeInput({ address: ESCROW_AGENT })).toThrow(/payee/);
    expect(() => payeeInput({ payee: 'p-1', bankDigests: ['xyz'] })).toThrow(/digest/);
    expect(payeeInput({ payee: 'p-1', address: ESCROW_AGENT, destinationTag: '7', amount: '25' })).toEqual({ payee: 'p-1', instrument: { kind: 'xrpl', address: ESCROW_AGENT, destinationTag: 7 }, amount: 25 });
  });
});
