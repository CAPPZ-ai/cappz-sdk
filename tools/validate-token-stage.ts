/**
 * COPE node crystallized. Node ID: v15-31-01-validate-token-stage.
 * Provenance: m/44'/144'/100'/principles/cope/v1#marketplace
 *
 * Validate a stage-by-stage token deal (rail ledger-staged) on the real XRPL
 * testnet: test money only. It runs every money step on the ledger and every
 * rule with the SDK's own code — the same builders, replay, signing-approval
 * rules and counterparty check the web app, the agent tool and the check
 * service run:
 *
 *   1. two fresh faucet wallets (buyer, seller); the buyer buys test RLUSD
 *      (USD-tokenZ/1) with test XRP from the testnet XRP/RLUSD pool;
 *   2. counterparty check before the seller has a trust line → must stop;
 *      the seller sets the line; the check passes;
 *   3. a deal priced in RLUSD forms with the fee schedule (1% to the fee
 *      collection account, the live testnet treasury) and freezes the
 *      ledger-staged rail; the seller evidences, the buyer accepts;
 *   4. each stage Payment (seller net, fee leg) is approved for its exact bytes
 *      (evaluateSigningIntent; a substituted destination must be refused),
 *      signed in this process, submitted and read back validated;
 *   5. the payments are recorded (buildPayStageOnLedger): the contract
 *      completes; recording them twice and a wrong-issuer check are refused.
 *
 * Trust boundary, said plainly: the deal is replayed in this process, not
 * published to the shared marketplace log (that needs two signed-in accounts),
 * so the approvals come from the SDK's rules run here, not from the hosted
 * check service. The ledger transactions are real testnet transactions.
 *
 *   npx vite-node tools/validate-token-stage.ts -- [--rlusd 2] [--out report.json]
 */
import { writeFile } from 'node:fs/promises';
import { Client, Wallet, type SubmittableTransaction } from 'xrpl';
import { DemoRunner } from '../src/lib/marketplace/demo';
import * as M from '../src/lib/marketplace/model';
import { buildFeeSchedule, NO_FEES } from '../src/lib/marketplace/fees';
import { prepareStagePayments, settlementPolicyFor, contractRail } from '../src/lib/marketplace/settlement';
import { evaluateSigningIntent } from '../src/lib/marketplace/signingApproval';
import { runCounterpartyCheck } from '../src/lib/marketplace/counterpartyCheck';
import { liveSigningDeps, seedSigner, signAndSubmit, signAndSubmitAll } from '../src/lib/marketplace/ledgerSigning';
import { issuedTokenFor } from '../src/lib/marketplace/paymentAssets';
import { checkLedgerPayment } from '../src/lib/marketplace/ledgerPayments';
import { resolveTreasury } from '../src/lib/network/networkConfig';
import { XRPL_ENDPOINTS, fetchLedgerTx, type LedgerTx } from '../src/lib/xrpl/ledgerCheck';

const NET = 'testnet' as const;
const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const RLUSD = Number(arg('rlusd', '2'));
const OUT = arg('out', '');
const report: Record<string, unknown> = { network: NET, startedAt: new Date().toISOString(), steps: [] as unknown[] };
const step = (name: string, detail: unknown) => { (report.steps as unknown[]).push({ name, ...(typeof detail === 'object' ? detail as object : { detail }) }); console.log(`✓ ${name}`, typeof detail === 'string' ? detail : JSON.stringify(detail)); };
const fail = (msg: string): never => { throw new Error(msg); };

async function main() {
  const token = issuedTokenFor('USD-tokenZ/1', NET);
  const treasury = resolveTreasury(NET);
  const client = new Client(XRPL_ENDPOINTS[NET]); await client.connect();
  const submit = async (w: Wallet, tx: Record<string, unknown>, label: string) => {
    const lt = await signAndSubmit(seedSigner(w.seed!), { ...tx, Account: w.classicAddress }, NET);
    if (lt.result !== 'tesSUCCESS') fail(`${label}: ${lt.result}`);
    return lt;
  };
  try {
    // 1. Wallets and test RLUSD
    const buyer = (await client.fundWallet()).wallet; const seller = (await client.fundWallet()).wallet;
    step('faucet wallets', { buyer: buyer.classicAddress, seller: seller.classicAddress });
    const trust = (w: Wallet) => submit(w, { TransactionType: 'TrustSet', Flags: 0x00020000, LimitAmount: { currency: token.currencyHex, issuer: token.issuer, value: '1000000' } }, 'trust line');
    step('buyer RLUSD trust line', { tx: (await trust(buyer)).hash });
    const want = (RLUSD * 1.05).toFixed(6);
    const buy = await submit(buyer, { TransactionType: 'OfferCreate', Flags: 0x00020000 /* tfImmediateOrCancel */, TakerPays: { currency: token.currencyHex, issuer: token.issuer, value: want }, TakerGets: String(Math.round(RLUSD * 25 * 1e6)) }, 'buy RLUSD');
    const lines = (await client.request({ command: 'account_lines', account: buyer.classicAddress, peer: token.issuer, ledger_index: 'validated' })).result.lines;
    const held = Number(lines.find((l) => l.currency === token.currencyHex)?.balance ?? 0);
    if (held < RLUSD) fail(`Bought only ${held} RLUSD (wanted ${RLUSD}); the testnet pool may be thin.`);
    step('buyer bought test RLUSD from the testnet XRP/RLUSD pool', { tx: buy.hash, rlusd: held });

    // 2. Counterparty check: no trust line → stop; then the seller adds it → no stop
    const before = await runCounterpartyCheck({ network: NET, address: seller.classicAddress, payer: buyer.classicAddress, currency: 'USD-tokenZ/1', amount: RLUSD }, null);
    if (!before.reasons.some((r) => r.code === 'recipient-no-trust-line')) fail('The check did not stop a payment to a seller with no RLUSD trust line.');
    step('counterparty check refuses a seller without a trust line', { verdict: before.verdict, codes: before.reasons.map((r) => r.code) });
    step('seller RLUSD trust line', { tx: (await trust(seller)).hash });
    const after = await runCounterpartyCheck({ network: NET, address: seller.classicAddress, payer: buyer.classicAddress, currency: 'USD-tokenZ/1', amount: RLUSD }, null);
    const stops = after.reasons.filter((r) => r.level === 'stop');
    if (stops.some((r) => r.code.startsWith('recipient') || r.code.startsWith('payer') || r.code.startsWith('asset'))) fail(`Check still stops: ${stops.map((r) => r.code).join(', ')}`);
    step('counterparty check passes the token checks', { verdict: after.verdict, escrowable: after.asset?.escrowable, codes: after.reasons.map((r) => r.code) });

    // 3. A deal priced in RLUSD, replayed with the SDK's builders
    const r = new DemoRunner(new Date(Date.now() - 60 * 60_000).toISOString()); // one minute per step, ending before now
    r.apply(await buildFeeSchedule('m/44\'/144\'/0\'/cappz/operational/marketplace/operators/validator', r.as('op', 1).at, { marketplace: { percent: { enabled: true, bps: 100 }, flat: { enabled: false, amounts: {} }, perRecord: { enabled: false, amounts: {} } }, securities: NO_FEES, recipients: [{ account: treasury, label: 'CAPPZ treasury', bps: 10_000 }], collector: { account: treasury, label: 'CAPPZ treasury (fee collection)' }, note: 'validation: 1% to the testnet treasury' }));
    const profile = (partyId: string, name: string, xrplAccount: string) => ({ partyId, kind: 'organization' as const, name, roles: ['buyer', 'seller'] as const, region: 'TX', about: 'validation', capabilities: { categories: ['agents'], canPlantNew: false }, xrplAccount });
    r.apply(await M.buildProfile(r.state, r.as('p-val-buyer', 1), { ...profile('p-val-buyer', 'Validation buyer', buyer.classicAddress), roles: ['buyer'] }));
    r.apply(await M.buildProfile(r.state, r.as('p-val-seller', 1), { ...profile('p-val-seller', 'Validation seller', seller.classicAddress), roles: ['seller'] }));
    r.apply(await M.buildListing(r.state, { ...r.as('p-val-seller', 1), network: NET }, { listingId: 'l-val-rlusd', sellerId: 'p-val-seller', categoryId: 'agents', kind: 'service', title: 'Research brief (validation)', description: 'validation', unit: 'job', pricePerUnit: { amount: RLUSD, currency: 'USD-tokenZ/1' }, quantity: 1, region: 'TX', delivery: 'online', leadDays: 1, attributes: {}, milestones: [{ label: 'Brief delivered', share: 1, dueInDays: 7, evidence: 'SHA-256 of the brief', delivery: true }] }));
    const o = await M.buildOrder(r.state, { ...r.as('p-val-buyer', 1), network: NET }, 'l-val-rlusd', 1); r.apply(o.txs);
    let c = r.state.contracts.find((x) => x.contractId === o.contractId)!;
    if (contractRail(c) !== 'ledger-staged') fail(`Rail ${contractRail(c)}, expected ledger-staged.`);
    step('deal formed in RLUSD on the ledger-staged rail', { contractId: c.contractId, total: c.total, fees: c.fees?.components.percent, state: c.state, next: c.nextAction.action });
    const brief = new TextEncoder().encode(`validation brief ${c.contractId}`);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', brief)), (b) => b.toString(16).padStart(2, '0')).join('');
    r.apply(await M.buildEvidence(r.state, r.as('p-val-seller', 1), c.contractId, 0, { kind: 'delivery-receipt', hash, note: 'brief' }));
    r.apply(await M.buildAffirm(r.state, r.as('p-val-buyer', 1), c.contractId, 0));
    c = r.state.contracts.find((x) => x.contractId === o.contractId)!;
    step('seller evidenced, buyer accepted', { next: c.nextAction.action });

    // 4. Approve each exact Payment, refuse a substitution, sign, submit, read back
    const legs = prepareStagePayments(c, 0, buyer.classicAddress, seller.classicAddress, NET);
    const approvals: string[] = [];
    const deps = { ...liveSigningDeps, approve: async (prepared: Record<string, unknown>) => {
      const now = new Date().toISOString();
      const bad = await evaluateSigningIntent(r.state, { network: NET, contractId: c.contractId, milestone: 0, tx: { ...prepared, Destination: buyer.classicAddress } }, now);
      if (bad.approved) fail('A payment substituted to another destination was approved.');
      const d = await evaluateSigningIntent(r.state, { network: NET, contractId: c.contractId, milestone: 0, tx: prepared }, now);
      if (!d.approved) fail(`Not approved: ${d.reasons.map((x) => x.message).join(' ')}`);
      approvals.push(`${d.approval.action} ${d.approval.destination} ${d.approval.amountDrops} units ${d.approval.txHash.slice(0, 16)}… (substitution refused: ${bad.approved ? 'no' : bad.reasons.map((x) => x.code).join(',')})`);
    } };
    const lts: LedgerTx[] = await signAndSubmitAll(seedSigner(buyer.seed!), legs.map((l) => l.tx), NET, undefined, deps);
    step('stage payments approved, signed and validated on the ledger', { legs: legs.map((l, i) => ({ to: l.label, account: l.account, rlusd: (l.tx.Amount as { value: string }).value, tx: lts[i].hash, delivered: lts[i].deliveredIssued })), approvals });

    // 5. Record; refusals
    r.apply(await M.buildPayStageOnLedger(r.state, r.as('p-val-buyer', 1), c.contractId, 0, settlementPolicyFor(NET), lts));
    c = r.state.contracts.find((x) => x.contractId === o.contractId)!;
    if (c.state !== 'completed') fail(`Contract is ${c.state}, expected completed.`);
    step('payments recorded from the validated ledger; contract completed', { state: c.state, because: c.because, feeCharges: c.feeCharges.map((f) => ({ settlement: f.settlement, feeUnits: f.feeUnits, currency: f.currency })), payments: c.payments.map((p) => ({ tx: p.reference, amount: p.amount, confirmedBy: p.confirmedBy })) });
    let again = 'recorded twice';
    try { await M.buildPayStageOnLedger(r.state, r.as('p-val-buyer', 1), c.contractId, 0, settlementPolicyFor(NET), lts); } catch (e) { again = `refused: ${(e as Error).message}`; }
    if (again === 'recorded twice') fail('The same payments were recorded twice.');
    const fresh = await fetchLedgerTx(NET, lts[0].hash);
    const wrongIssuer = checkLedgerPayment({ ...fresh, deliveredIssued: { ...fresh.deliveredIssued!, issuer: seller.classicAddress } }, { network: NET, from: buyer.classicAddress, to: seller.classicAddress, toLabel: 'Seller', code: 'USD-tokenZ/1', units: 1n, reference: c.contractId, index: 0 });
    if (!wrongIssuer.length) fail('A payment delivered by another issuer was accepted.');
    step('refusals hold', { recordTwice: again, wrongIssuer: wrongIssuer[0] });
    report.result = 'passed';
  } finally { await client.disconnect().catch(() => {}); }
}

main().then(async () => { if (OUT) await writeFile(OUT, JSON.stringify(report, null, 2)); console.log('\nVALIDATION PASSED'); }, async (e) => { report.result = 'failed'; report.error = (e as Error).message; if (OUT) await writeFile(OUT, JSON.stringify(report, null, 2)); console.error('\nVALIDATION FAILED:', (e as Error).message); process.exit(1); });
