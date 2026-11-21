// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { Wallet, decode, multisign } from 'xrpl';
import {
  amountUnits, checkSignerSetup, evaluateOutflow, guardCosign, guardSetupTransactions, outflowIntentHash, reconcileOutflows, signerWeights,
  LSF_DISABLE_MASTER, type OutflowApproval, type OutflowContext, type OutflowPolicy,
} from '../lib/treasury/vaultGuard';

const vault = Wallet.generate();
const guard = Wallet.generate();
const ops = [Wallet.generate(), Wallet.generate(), Wallet.generate()];
const rec = [Wallet.generate(), Wallet.generate(), Wallet.generate()];
const payee = Wallet.generate().classicAddress;
const attacker = Wallet.generate().classicAddress;
const RLUSD = 'USD/rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
const NOW = '2026-11-21T12:00:00.000Z';

const policy: OutflowPolicy = {
  kind: 'cappz-outflow-policy/v1', network: 'testnet', account: vault.classicAddress, guard: guard.classicAddress,
  destinations: [{ address: payee, label: 'Settlement desk' }, { address: 'rExchangeHotWa11etXXXXXXXXXXXXXXXX', tag: 77, label: 'Exchange' }],
  limits: [{ asset: 'XRP', perTx: '50000000', perWindow: '100000000' }, { asset: RLUSD, perTx: '1000', perWindow: '2500.5' }],
  windowHours: 24, maxFeeDrops: 1000, maxLedgerAhead: 20,
};
const ctx = (over: Partial<OutflowContext> = {}): OutflowContext => ({ nextSequence: 42, currentLedger: 1000, spent: [], ...over });
const pay = (over: Record<string, unknown> = {}) => ({ TransactionType: 'Payment', Account: vault.classicAddress, Destination: payee, Amount: '10000000', Fee: '120', Sequence: 42, LastLedgerSequence: 1010, Flags: 0, ...over });
const codes = async (tx: Record<string, unknown>, c = ctx()) => { const d = await evaluateOutflow(policy, c, tx, NOW); return d.approved ? [] : d.reasons.map((r) => r.code); };

describe('vault guard — outflow policy', () => {
  it('approves an in-policy payment and records its intent hash', async () => {
    const d = await evaluateOutflow(policy, ctx(), pay(), NOW);
    expect(d.approved).toBe(true);
    if (d.approved) {
      expect(d.approval.intentHash).toBe(await outflowIntentHash(pay()));
      expect(d.approval).toMatchObject({ destination: payee, asset: 'XRP', amount: '10000000', sequence: 42, expiresLedger: 1010 });
    }
  });

  it('refuses the Chainflip drain: whole balance, fresh address, out-of-band counter', async () => {
    const drain = pay({ Destination: attacker, Amount: '520200000000', Sequence: 315000000000000000000000000000000000000 });
    const c = await codes(drain);
    expect(c).toEqual(expect.arrayContaining(['destination-not-allowed', 'over-tx-cap', 'over-window-cap', 'sequence-gap']));
  });

  it('refuses tickets, partial payments, paths, missing or distant expiry and high fees', async () => {
    expect(await codes(pay({ Sequence: 0, TicketSequence: 7 }))).toContain('ticket-sequence');
    expect(await codes(pay({ Flags: 0x00020000 }))).toContain('partial-payment');
    expect(await codes(pay({ Paths: [[{ currency: 'USD' }]], SendMax: '999' }))).toContain('unexpected-field');
    expect(await codes(pay({ LastLedgerSequence: undefined }))).toContain('no-expiry');
    expect(await codes(pay({ LastLedgerSequence: 5000 }))).toContain('expiry-too-far');
    expect(await codes(pay({ Fee: '500000' }))).toContain('fee-over-cap');
    expect(await codes(pay({ Flags: 0x00010000 }))).toContain('unexpected-flags');
    expect(await codes(pay({ Flags: 0x80000000 }))).toEqual([]);
  });

  it('never co-signs key, signer or account changes', async () => {
    for (const t of ['SignerListSet', 'SetRegularKey', 'AccountSet', 'AccountDelete', 'TrustSet', 'TicketCreate']) {
      expect(await codes({ TransactionType: t, Account: vault.classicAddress, Fee: '12', Sequence: 42, LastLedgerSequence: 1010 })).toContain('governance-change');
    }
    expect(await codes(pay({ TransactionType: 'EscrowCreate', FinishAfter: 1 }))).toContain('type-not-allowed');
  });

  it('enforces destination tags and the rolling window, per asset, with exact token decimals', async () => {
    expect(await codes(pay({ Destination: 'rExchangeHotWa11etXXXXXXXXXXXXXXXX' }))).toContain('destination-tag');
    expect(await codes(pay({ Destination: 'rExchangeHotWa11etXXXXXXXXXXXXXXXX', DestinationTag: 77 }))).toEqual([]);
    const recent = { at: '2026-11-21T06:00:00.000Z', asset: 'XRP', amount: '95000000' };
    const old = { at: '2026-11-19T06:00:00.000Z', asset: 'XRP', amount: '95000000' };
    expect(await codes(pay(), ctx({ spent: [recent] }))).toContain('over-window-cap');
    expect(await codes(pay(), ctx({ spent: [old] }))).toEqual([]);
    const usd = (value: string) => pay({ Amount: { currency: 'USD', issuer: RLUSD.split('/')[1], value } });
    const spentUsd = [{ at: NOW, asset: RLUSD, amount: '1000' }, { at: NOW, asset: RLUSD, amount: '1e3' }];
    expect(await codes(usd('500.5'), ctx({ spent: spentUsd }))).toEqual([]);
    expect(await codes(usd('500.500000000000001'), ctx({ spent: spentUsd }))).toContain('over-window-cap');
    expect(await codes(pay({ Amount: { currency: 'EUR', issuer: RLUSD.split('/')[1], value: '1' } }))).toContain('asset-not-allowed');
    expect(amountUnits(RLUSD, '1.5e-3')).toBe(1_500_000_000_000n);
  });

  it('the guard adds its multisignature only to approved transactions, and only with its own key', async () => {
    const ok = await guardCosign(policy, ctx(), pay(), guard, NOW);
    expect(ok.txBlob).toBeTruthy();
    const signed = decode(ok.txBlob!) as Record<string, unknown>;
    expect((signed.Signers as Array<{ Signer: { Account: string } }>)[0].Signer.Account).toBe(guard.classicAddress);
    const op = ops[0].sign({ ...pay(), SigningPubKey: '' } as never, true).tx_blob;
    expect(decode(multisign([ok.txBlob!, op])).Signers).toHaveLength(2);
    expect((await guardCosign(policy, ctx(), pay({ Destination: attacker }), guard, NOW)).txBlob).toBeUndefined();
    expect((await guardCosign(policy, ctx(), pay(), ops[1], NOW)).decision).toMatchObject({ approved: false, reasons: [{ code: 'not-the-guard' }] });
  });
});

describe('vault guard — signer setup', () => {
  it('weights make the guard load-bearing for any operator count', () => {
    for (let n = 1; n <= 10; n++) for (let k = 1; k <= n; k++) {
      const w = signerWeights(n, k);
      expect(n * w.operator).toBeLessThan(w.quorum);              // every operator key together: no
      expect(w.guard).toBeLessThan(w.quorum);                     // the guard alone: no
      expect(w.guard + k * w.operator).toBeGreaterThanOrEqual(w.quorum); // guard + k operators: yes
      expect(w.guard + (k - 1) * w.operator).toBeLessThan(w.quorum);     // guard + k−1: no
      expect(2 * w.recovery).toBeGreaterThanOrEqual(w.quorum);    // two recovery keys: yes
      expect(w.recovery + n * w.operator).toBeLessThan(w.quorum); // one recovery key + every operator: no
    }
  });

  it('the setup transactions pass the check; common mistakes are blocking', () => {
    const [list, disable] = guardSetupTransactions(vault.classicAddress, guard.classicAddress, ops.map((o) => o.classicAddress), { perSpend: 2, recovery: rec.map((r) => r.classicAddress) });
    expect(disable).toMatchObject({ TransactionType: 'AccountSet', SetFlag: 4 });
    const entries = (list.SignerEntries as Array<{ SignerEntry: { Account: string; SignerWeight: number } }>).map((e) => ({ account: e.SignerEntry.Account, weight: e.SignerEntry.SignerWeight }));
    const setup = { flags: LSF_DISABLE_MASTER, signerList: { quorum: list.SignerQuorum as number, entries } };
    const recovery = rec.map((r) => r.classicAddress);
    expect(checkSignerSetup(policy, setup, recovery)).toEqual({ state: 'guard-load-bearing', findings: [] });

    const blocking = (s: typeof setup & { regularKey?: string }) => checkSignerSetup(policy, s, recovery).findings.filter((f) => f.blocking).map((f) => f.code);
    expect(blocking({ ...setup, flags: 0 })).toEqual(['master-enabled']);
    expect(blocking({ ...setup, regularKey: attacker })).toEqual(['regular-key-set']);
    // A "threshold" list without a guard — the Chainflip shape: 100 of 150 online keys.
    const threshold = { flags: LSF_DISABLE_MASTER, signerList: { quorum: 100, entries: Array.from({ length: 150 }, (_, i) => ({ account: `rValidator${i}`, weight: 1 })) } };
    expect(checkSignerSetup(policy, threshold).state).toBe('guard-bypassable');
    expect(blocking(threshold)).toEqual(expect.arrayContaining(['guard-not-listed', 'online-keys-reach-quorum']));
    expect(checkSignerSetup(policy, { flags: 0 }).state).toBe('not-set-up');
    expect(() => guardSetupTransactions(vault.classicAddress, guard.classicAddress, [ops[0].classicAddress], { recovery: [rec[0].classicAddress] })).toThrow(/single recovery key/);
  });
});

describe('vault guard — reconciliation', () => {
  it('matches approved outflows, flags unapproved ones (even failed), and hashes the report', async () => {
    const d = await evaluateOutflow(policy, ctx(), pay(), NOW);
    const approvals = [d.approved ? d.approval : (null as never)] as OutflowApproval[];
    // The ledger's view (API v2): DeliverMax instead of Amount, signing fields, annotations.
    const asValidated = { ...pay(), Amount: undefined, DeliverMax: '10000000', SigningPubKey: '', Signers: [{ Signer: {} }], hash: 'AB', date: 1, ledger_index: 1009 };
    delete (asValidated as Record<string, unknown>).Amount;
    const report = await reconcileOutflows(policy, approvals, [
      { hash: 'H1', tx: asValidated, result: 'tesSUCCESS', closeTime: NOW },
      { hash: 'H2', tx: pay({ Destination: attacker, Amount: '90000000', Sequence: 43 }), result: 'tesSUCCESS', closeTime: NOW },
      { hash: 'H3', tx: pay({ Sequence: 44, Amount: '1' }), result: 'tecUNFUNDED_PAYMENT', closeTime: NOW },
      { hash: 'H4', tx: { TransactionType: 'SignerListSet', Account: vault.classicAddress, Sequence: 45 }, result: 'tesSUCCESS', closeTime: NOW },
      { hash: 'H5', tx: pay({ Account: payee }), result: 'tesSUCCESS', closeTime: NOW },
    ]);
    expect(report.findings.map((f) => [f.hash, f.state])).toEqual([['H1', 'matched'], ['H2', 'unapproved'], ['H3', 'unapproved'], ['H4', 'governance-change']]);
    expect(report.clean).toBe(false);
    expect(report.spent.map((s) => s.amount)).toEqual(['10000000', '90000000']);
    expect(report.reportHash).toMatch(/^[0-9a-f]{64}$/);
    const clean = await reconcileOutflows(policy, approvals, [{ hash: 'H1', tx: asValidated, result: 'tesSUCCESS', closeTime: NOW }]);
    expect(clean.clean).toBe(true);
  });
});
