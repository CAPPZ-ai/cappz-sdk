// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { Wallet } from 'xrpl';
import { keyExposure, quickSweepTransaction, regularKeyFor, rotationTransaction, disableMasterTransaction } from '../lib/treasury/keyExposure';
import type { ValidatedTx } from '../lib/treasury/vaultGuard';

const DAY = 86_400_000;
const now = Date.parse('2026-11-23T12:00:00Z');
const at = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString();
let n = 0;
const sent = (account: string, signer: Wallet | null, daysAgo: number, signers: Wallet[] = []): ValidatedTx => ({
  hash: `H${++n}`, result: 'tesSUCCESS', closeTime: at(daysAgo),
  tx: { TransactionType: 'Payment', Account: account, SigningPubKey: signer ? signer.publicKey : '', ...(signers.length ? { Signers: signers.map((s) => ({ Signer: { Account: s.classicAddress, SigningPubKey: s.publicKey } })) } : {}) },
});

describe('v16-02-00 key exposure on the XRP Ledger', () => {
  it('an account whose master key signed and is still enabled is master-exposed', async () => {
    const w = Wallet.generate();
    const r = await keyExposure({ account: w.classicAddress, setup: { flags: 0 }, txs: [sent(w.classicAddress, w, 3)], historyComplete: true, now });
    expect(r.posture).toBe('master-exposed');
    expect(r.master.state).toBe('exposed');
    expect(r.master.exposure?.firstTx).toMatch(/^H/);
    expect(r.ledgerSignatures).toBe('classical-only');
  });

  it('master disabled behind a fresh regular key: rotating while young, stale when old', async () => {
    const w = Wallet.generate(); const rk = Wallet.generate();
    const setup = { flags: 0x00100000, regularKey: rk.classicAddress };
    const young = await keyExposure({ account: w.classicAddress, setup, txs: [sent(w.classicAddress, w, 100), sent(w.classicAddress, rk, 5)], historyComplete: true, now, maxExposureDays: 30 });
    expect(young.master.state).toBe('exposed-disabled');
    expect(young.regularKey).toMatchObject({ state: 'exposed', exposedDays: 5 });
    expect(young.posture).toBe('rotating');
    const old = await keyExposure({ account: w.classicAddress, setup, txs: [sent(w.classicAddress, rk, 45)], historyComplete: true, now, maxExposureDays: 30 });
    expect(old.posture).toBe('stale-exposure');
    expect(old.findings.map((f) => f.code)).toContain('rotate-regular-key');
  });

  it('a receive-only account is unexposed only when the whole history was read', async () => {
    const v = Wallet.generate(); const payer = Wallet.generate();
    const incoming = sent(payer.classicAddress, payer, 1);
    const full = await keyExposure({ account: v.classicAddress, setup: { flags: 0 }, txs: [incoming], historyComplete: true, now });
    expect(full.posture).toBe('unexposed');
    expect(full.findings.map((f) => f.code)).toContain('receive-only');
    const partial = await keyExposure({ account: v.classicAddress, setup: { flags: 0 }, txs: [incoming], historyComplete: false, now });
    expect(partial.posture).toBe('unknown');
    expect(partial.master.state).toBe('unknown');
  });

  it('multi-signed accounts list each exposed signer', async () => {
    const w = Wallet.generate(); const s1 = Wallet.generate(); const s2 = Wallet.generate();
    const r = await keyExposure({ account: w.classicAddress, setup: { flags: 0x00100000, signerList: { quorum: 2, entries: [{ account: s1.classicAddress, weight: 1 }, { account: s2.classicAddress, weight: 1 }] } }, txs: [sent(w.classicAddress, null, 2, [s1, s2])], historyComplete: true, now });
    expect(r.posture).toBe('multisig');
    expect(r.multiSigners.map((k) => k.address).sort()).toEqual([s1.classicAddress, s2.classicAddress].sort());
  });

  it('regular keys rotate deterministically from a private root; each index is a different key', async () => {
    const root = 'ab'.repeat(32); const acct = Wallet.generate().classicAddress;
    const k0 = await regularKeyFor(root, 'mainnet', acct, 0); const k0b = await regularKeyFor(root, 'mainnet', acct, 0); const k1 = await regularKeyFor(root, 'mainnet', acct, 1);
    expect(k0.classicAddress).toBe(k0b.classicAddress);
    expect(k1.classicAddress).not.toBe(k0.classicAddress);
    expect(rotationTransaction(acct, k1.classicAddress)).toEqual({ TransactionType: 'SetRegularKey', Account: acct, RegularKey: k1.classicAddress });
    expect(disableMasterTransaction(acct)).toMatchObject({ SetFlag: 4 });
  });

  it('quickSweep moves what is above reserve + buffer to a never-signed vault, and refuses an exposed or unread one', async () => {
    const hot = Wallet.generate(); const vault = Wallet.generate();
    const safe = await keyExposure({ account: vault.classicAddress, setup: { flags: 0 }, txs: [], historyComplete: true, now });
    const ok = quickSweepTransaction({ account: hot.classicAddress, balanceDrops: '150000000', reserveDrops: '1000000', bufferDrops: '20000000', vault: safe });
    expect('tx' in ok && ok.amountDrops).toBe(String(150000000 - 1000000 - 20000000 - 12));
    const exposed = await keyExposure({ account: vault.classicAddress, setup: { flags: 0 }, txs: [sent(vault.classicAddress, vault, 1)], historyComplete: true, now });
    expect(quickSweepTransaction({ account: hot.classicAddress, balanceDrops: '150000000', reserveDrops: '1000000', bufferDrops: '0', vault: exposed })).toMatchObject({ refused: 'vault-exposed' });
    const unread = await keyExposure({ account: vault.classicAddress, setup: { flags: 0 }, txs: [], historyComplete: false, now });
    expect(quickSweepTransaction({ account: hot.classicAddress, balanceDrops: '150000000', reserveDrops: '1000000', bufferDrops: '0', vault: unread })).toMatchObject({ refused: 'vault-unknown' });
    expect(quickSweepTransaction({ account: hot.classicAddress, balanceDrops: '1000000', reserveDrops: '1000000', bufferDrops: '0', vault: safe })).toMatchObject({ refused: 'nothing-above-buffer' });
  });
});
