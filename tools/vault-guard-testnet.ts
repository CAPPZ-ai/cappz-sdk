/**
 * Real XRPL testnet run of the vault guard (v15-48-00): the Chainflip attack against a guarded vault.
 *
 *   npx vite-node tools/vault-guard-testnet.ts [-- --out <file>]
 *
 * Everything is real (testnet): a faucet-funded vault (the other keys need no account), the signer list and master-key disable, every attack
 * submitted to the ledger, and the ledger's own answer recorded. Wallets are fresh each run (nothing kept).
 *
 *   1. Set up: vault, guard, two operators (one co-signs per spend), two offline recovery keys, a payee.
 *   2. Check the setup from account_info (checkSignerSetup) — must be guard-load-bearing.
 *   3. Attacks, each submitted: master key drain; both operator keys drain (the "aggregate key" stolen);
 *      both operators remove the guard from the signer list; both operators set a regular key.
 *   4. The guard is asked to co-sign the drain and refuses (reasons recorded).
 *   5. A routine payment inside the policy: guard + one operator → tesSUCCESS.
 *   6. A second payment past the rolling-window cap: the guard refuses.
 *   7. Break-glass: two recovery keys move funds without the guard → succeeds, and reconciliation reports it
 *      as unapproved (recovery is never silent).
 */
import { writeFile } from 'node:fs/promises';
import { Client, Wallet, multisign } from 'xrpl';
import { XRPL_ENDPOINTS } from '../src/lib/xrpl/ledgerCheck';
import {
  checkSignerSetup, evaluateOutflow, guardCosign, guardSetupTransactions, reconcileOutflows,
  type OutflowApproval, type OutflowContext, type OutflowPolicy, type Spent, type ValidatedTx,
} from '../src/lib/treasury/vaultGuard';

const log = (...a: unknown[]) => console.error('·', ...a);
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : undefined;
type Tx = Record<string, unknown>;

async function main() {
  const client = new Client(XRPL_ENDPOINTS.testnet);
  await client.connect();
  const record: Record<string, unknown> = { network: 'testnet', startedAt: new Date().toISOString(), steps: [] as unknown[] };
  const step = (name: string, data: Record<string, unknown>) => { (record.steps as unknown[]).push({ name, ...data }); log(name, JSON.stringify(data)); };

  // 1. Wallets.
  // Only the vault needs XRP: signer-list keys need no account, and the first payment activates the payee.
  const fund = async (): Promise<Wallet> => {
    for (let i = 0; ; i++) {
      try { return (await client.fundWallet()).wallet; }
      catch (e) { if (i >= 5) throw e; log('faucet busy, retrying in', 15 * (i + 1), 's'); await new Promise((r) => setTimeout(r, 15_000 * (i + 1))); }
    }
  };
  const vault = await fund();
  const [guard, op1, op2, rec1, rec2, payee] = Array.from({ length: 6 }, () => Wallet.generate());
  const attacker = Wallet.generate();
  record.accounts = { vault: vault.classicAddress, guard: guard.classicAddress, operators: [op1.classicAddress, op2.classicAddress], recovery: [rec1.classicAddress, rec2.classicAddress], payee: payee.classicAddress, attacker: attacker.classicAddress };
  log('accounts', record.accounts);

  const policy: OutflowPolicy = {
    kind: 'cappz-outflow-policy/v1', network: 'testnet', account: vault.classicAddress, guard: guard.classicAddress,
    destinations: [{ address: payee.classicAddress, label: 'Settlement desk' }],
    limits: [{ asset: 'XRP', perTx: '20000000', perWindow: '30000000' }], // 20 XRP per payment, 30 XRP per 24 h
    windowHours: 24, maxFeeDrops: 1000, maxLedgerAhead: 20,
  };
  record.policy = policy;

  // Setup, signed by the master key (its last act).
  for (const tx of guardSetupTransactions(vault.classicAddress, guard.classicAddress, [op1.classicAddress, op2.classicAddress], { perSpend: 1, recovery: [rec1.classicAddress, rec2.classicAddress] })) {
    const r = await client.submitAndWait(tx as never, { wallet: vault, autofill: true });
    step(`setup ${tx.TransactionType}`, { hash: r.result.hash, result: (r.result.meta as { TransactionResult: string }).TransactionResult, tx: tx.TransactionType === 'SignerListSet' ? { SignerQuorum: tx.SignerQuorum, SignerEntries: tx.SignerEntries } : { SetFlag: tx.SetFlag } });
  }

  // 2. Check the setup from the ledger.
  const info = (await client.request({ command: 'account_info', account: vault.classicAddress, ledger_index: 'validated', signer_lists: true } as never)).result as unknown as { account_data: { Flags: number; RegularKey?: string; Sequence: number; Balance: string; signer_lists?: Array<{ SignerQuorum: number; SignerEntries: Array<{ SignerEntry: { Account: string; SignerWeight: number } }> }> }; signer_lists?: Array<{ SignerQuorum: number; SignerEntries: Array<{ SignerEntry: { Account: string; SignerWeight: number } }> }> };
  const lists = info.signer_lists ?? info.account_data.signer_lists ?? [];
  const setup = { flags: info.account_data.Flags, regularKey: info.account_data.RegularKey, signerList: lists[0] ? { quorum: lists[0].SignerQuorum, entries: lists[0].SignerEntries.map((e) => ({ account: e.SignerEntry.Account, weight: e.SignerEntry.SignerWeight })) } : undefined };
  const check = checkSignerSetup(policy, setup, [rec1.classicAddress, rec2.classicAddress]);
  step('check setup', { state: check.state, findings: check.findings, balanceDrops: info.account_data.Balance });
  if (check.state !== 'guard-load-bearing') throw new Error('setup is not load-bearing');

  const multi = async (tx: Tx, signers: Wallet[]): Promise<string> => {
    const prepared = await client.autofill(tx as never, signers.length);
    return multisign(signers.map((w) => w.sign(prepared as never, true).tx_blob));
  };
  const submitBlob = async (blob: string) => {
    const r = (await client.request({ command: 'submit', tx_blob: blob })).result as unknown as { engine_result: string; engine_result_message: string; tx_json: { hash: string } };
    return { result: r.engine_result, message: r.engine_result_message, hash: r.tx_json.hash };
  };

  // 3. Attacks.
  const balance = BigInt(info.account_data.Balance);
  const drain = (): Tx => ({ TransactionType: 'Payment', Account: vault.classicAddress, Destination: attacker.classicAddress, Amount: (balance - 2_000_000n).toString() });
  {
    const prepared = await client.autofill(drain() as never);
    const r = await submitBlob(vault.sign(prepared as never).tx_blob);
    step('attack: master key drains the vault', { expected: 'tefMASTER_DISABLED', ...r });
  }
  step('attack: both operator keys drain the vault (aggregate key stolen)', { expected: 'tefBAD_QUORUM', ...(await submitBlob(await multi(drain(), [op1, op2]))) });
  step('attack: both operators remove the guard from the signer list', {
    expected: 'tefBAD_QUORUM',
    ...(await submitBlob(await multi({ TransactionType: 'SignerListSet', Account: vault.classicAddress, SignerQuorum: 1, SignerEntries: [{ SignerEntry: { Account: op1.classicAddress, SignerWeight: 1 } }] }, [op1, op2]))),
  });
  step('attack: both operators set a regular key', { expected: 'tefBAD_QUORUM', ...(await submitBlob(await multi({ TransactionType: 'SetRegularKey', Account: vault.classicAddress, RegularKey: attacker.classicAddress }, [op1, op2]))) });

  const approvals: OutflowApproval[] = [];
  const spent: Spent[] = [];
  const context = async (): Promise<OutflowContext> => {
    const ai = (await client.request({ command: 'account_info', account: vault.classicAddress, ledger_index: 'current' })).result.account_data;
    return { nextSequence: ai.Sequence, currentLedger: await client.getLedgerIndex(), spent };
  };

  // 4. The guard is asked to co-sign the drain.
  {
    const prepared = await client.autofill(drain() as never, 2) as unknown as Tx;
    const d = await guardCosign(policy, await context(), { ...prepared, Sequence: 315_000 }, guard, new Date().toISOString());
    step('guard asked to co-sign the drain (with an out-of-band sequence)', { approved: d.decision.approved, reasons: d.decision.approved ? [] : d.decision.reasons.map((r) => r.code), signed: Boolean(d.txBlob) });
  }

  // 5. Routine payment inside the policy: guard + one operator.
  const routine = async (drops: string, label: string) => {
    const prepared = await client.autofill({ TransactionType: 'Payment', Account: vault.classicAddress, Destination: payee.classicAddress, Amount: drops } as never, 2) as unknown as Tx;
    const now = new Date().toISOString();
    const g = await guardCosign(policy, await context(), prepared, guard, now);
    if (!g.decision.approved || !g.txBlob) { step(label, { approved: false, reasons: g.decision.approved ? [] : g.decision.reasons.map((r) => `${r.code}: ${r.message}`) }); return; }
    approvals.push(g.decision.approval); // recorded before submitting
    const blob = multisign([g.txBlob, op1.sign({ ...prepared, SigningPubKey: '' } as never, true).tx_blob]);
    const r = await client.submitAndWait(blob);
    const result = (r.result.meta as { TransactionResult: string }).TransactionResult;
    if (result === 'tesSUCCESS') spent.push({ at: now, asset: 'XRP', amount: drops });
    step(label, { approved: true, intentHash: g.decision.approval.intentHash, hash: r.result.hash, result });
  };
  await routine('15000000', 'routine: 15 XRP to the settlement desk, guard + one operator');
  // 6. Past the window cap (15 + 20 > 30 XRP in 24 h).
  await routine('20000000', 'routine: 20 more XRP within 24 h (window cap 30 XRP)');

  // 7. Break-glass: two recovery keys, no guard.
  {
    const blob = await multi({ TransactionType: 'Payment', Account: vault.classicAddress, Destination: payee.classicAddress, Amount: '5000000' }, [rec1, rec2]);
    const r = await client.submitAndWait(blob);
    step('break-glass: two offline recovery keys move 5 XRP without the guard', { hash: r.result.hash, result: (r.result.meta as { TransactionResult: string }).TransactionResult });
  }

  // Reconcile everything the vault sent.
  const atx = (await client.request({ command: 'account_tx', account: vault.classicAddress, ledger_index_min: -1, ledger_index_max: -1, forward: true, api_version: 2 } as never)).result as unknown as { transactions: Array<{ hash: string; tx_json: Tx; meta: { TransactionResult: string; delivered_amount?: unknown }; close_time_iso: string }> };
  const validated: ValidatedTx[] = atx.transactions.map((t) => ({ hash: t.hash, tx: t.tx_json, result: t.meta.TransactionResult, closeTime: t.close_time_iso, delivered: t.meta.delivered_amount as never }));
  const report = await reconcileOutflows(policy, approvals, validated);
  step('reconcile', { clean: report.clean, reportHash: report.reportHash, findings: report.findings.map((f) => ({ hash: f.hash, state: f.state, type: f.type, amount: f.amount })) });

  const final = (await client.request({ command: 'account_info', account: vault.classicAddress, ledger_index: 'validated' })).result.account_data;
  record.finalBalanceDrops = final.Balance;
  record.attackerActivated = await client.request({ command: 'account_info', account: attacker.classicAddress, ledger_index: 'validated' }).then(() => true, () => false);
  record.finishedAt = new Date().toISOString();
  await client.disconnect();

  // Verdict.
  const steps = record.steps as Array<Record<string, unknown>>;
  const attacks = steps.filter((s) => String(s.name).startsWith('attack:'));
  const ok = attacks.every((a) => a.result === a.expected)
    && steps.find((s) => String(s.name).startsWith('guard asked'))?.signed === false
    && steps.find((s) => String(s.name).startsWith('routine: 15'))?.result === 'tesSUCCESS'
    && steps.find((s) => String(s.name).startsWith('routine: 20'))?.approved === false
    && steps.find((s) => String(s.name).startsWith('break-glass'))?.result === 'tesSUCCESS'
    && report.findings.some((f) => f.state === 'unapproved' && f.amount === '5000000')
    && report.findings.some((f) => f.state === 'matched' && f.amount === '15000000')
    && record.attackerActivated === false;
  record.verdict = ok ? 'PASS' : 'FAIL';
  if (out) await writeFile(out, JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ verdict: record.verdict, out }, null, 2));
  if (!ok) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
