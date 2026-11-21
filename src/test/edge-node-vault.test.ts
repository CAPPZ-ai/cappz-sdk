// @vitest-environment node
// Edge node vault agents (15.49.0): guard key derivation, input checks, window accounting, job authorisation.
import { describe, expect, it } from 'vitest';
import { Wallet } from 'xrpl';
import {
  authorizeGuardJob, checkInputProblem, fullPolicy, guardInputProblem, guardWalletFor, policyProblem, setupFromAccountInfo, windowSpent,
} from '../../packages/cappz-edge-node/agents/vault';
import type { OutflowApproval } from '../lib/treasury/vaultGuard';

const SECRET = 'ab'.repeat(32);
const vault = Wallet.generate().classicAddress;
const desk = Wallet.generate().classicAddress;
const policy = { destinations: [{ address: desk, label: 'Desk' }], limits: [{ asset: 'XRP', perTx: '20000000', perWindow: '50000000' }] };

describe('vault agents: guard keys', () => {
  it('derives one stable Ed25519 guard per vault and network, different everywhere else', async () => {
    const a = await guardWalletFor(SECRET, 'mainnet', vault);
    expect((await guardWalletFor(SECRET, 'mainnet', vault)).classicAddress).toBe(a.classicAddress);
    expect(a.publicKey.startsWith('ED')).toBe(true);
    expect((await guardWalletFor(SECRET, 'testnet', vault)).classicAddress).not.toBe(a.classicAddress);
    expect((await guardWalletFor(SECRET, 'mainnet', desk)).classicAddress).not.toBe(a.classicAddress);
    expect((await guardWalletFor('cd'.repeat(32), 'mainnet', vault)).classicAddress).not.toBe(a.classicAddress);
    await expect(guardWalletFor('short', 'mainnet', vault)).rejects.toThrow(/64 hex/);
  });
});

describe('vault agents: inputs', () => {
  it('accepts a sound policy and names what is wrong otherwise', () => {
    expect(guardInputProblem({ account: vault, policy, recovery: [Wallet.generate().classicAddress, Wallet.generate().classicAddress], alertUrl: 'https://example.com/hook' })).toBeNull();
    expect(guardInputProblem({ account: 'nope', policy })).toMatch(/account/);
    expect(policyProblem({ ...policy, destinations: [{ address: vault, label: 'self' }] }, vault)).toMatch(/cannot pay itself/);
    expect(policyProblem({ ...policy, limits: [{ asset: 'XRP', perTx: '20', perWindow: '10' }] }, vault)).toMatch(/perTx is larger/);
    expect(policyProblem({ ...policy, limits: [{ asset: 'XRP', perTx: '1.5', perWindow: '10' }] }, vault)).toMatch(/drops/);
    expect(policyProblem({ ...policy, limits: [{ asset: 'XRP', perTx: '1', perWindow: '2' }, { asset: 'XRP', perTx: '1', perWindow: '2' }] }, vault)).toMatch(/twice/);
    expect(policyProblem({ ...policy, limits: [{ asset: `USD/${desk}`, perTx: '100.5', perWindow: '250' }] }, vault)).toBeNull();
    expect(guardInputProblem({ account: vault, policy, alertUrl: 'http://example.com' })).toMatch(/https/);
    expect(checkInputProblem({ account: vault })).toBeNull();
    expect(checkInputProblem({ account: vault, approvals: [] })).toMatch(/needs input.policy/);
    expect(checkInputProblem({ account: vault, limit: 1000 })).toMatch(/limit/);
  });

  it('fills the policy with account, guard, network and defaults', () => {
    expect(fullPolicy(policy, vault, 'rGuard', 'testnet')).toMatchObject({ kind: 'cappz-outflow-policy/v1', account: vault, guard: 'rGuard', network: 'testnet', windowHours: 24, maxFeeDrops: 1000, maxLedgerAhead: 20 });
  });
});

describe('vault agents: window and setup', () => {
  it('counts validated outflows and live approvals, frees expired unsubmitted ones', () => {
    const appr = (intentHash: string, expiresLedger: number): OutflowApproval => ({ kind: 'cappz-outflow-approval/v1', policyHash: 'p', intentHash, account: vault, destination: desk, asset: 'XRP', amount: '1000000', sequence: 1, expiresLedger, issuedAt: '2026-11-21T00:00:00.000Z' });
    const spent = windowSpent([{ at: 'x', asset: 'XRP', amount: '5' }], [appr('a', 120), appr('b', 90), appr('c', 120)], new Set(['c']), 100);
    expect(spent.map((s) => s.amount)).toEqual(['5', '1000000']); // a is live; b expired; c already counted as validated
  });

  it('reads account_info with or without the top-level signer_lists', () => {
    const row = { SignerQuorum: 6, SignerEntries: [{ SignerEntry: { Account: 'rG', SignerWeight: 5 } }] };
    expect(setupFromAccountInfo({ account_data: { Flags: 1048576 }, signer_lists: [row] }).signerList).toEqual({ quorum: 6, entries: [{ account: 'rG', weight: 5 }] });
    expect(setupFromAccountInfo({ account_data: { Flags: 0, signer_lists: [row] } }).signerList?.quorum).toBe(6);
    expect(setupFromAccountInfo({ account_data: { Flags: 0 } }).signerList).toBeUndefined();
  });
});

describe('vault agents: who may start or change a guard', () => {
  const guard = 'rGuardXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
  const viaGuard = { Account: vault, Signers: [{ Signer: { Account: guard } }, { Signer: { Account: 'rOp' } }] };
  const viaRecovery = { Account: vault, Signers: [{ Signer: { Account: 'rRec1' } }, { Signer: { Account: 'rRec2' } }] };
  it('honours only periods the vault itself paid', () => {
    expect(authorizeGuardJob({ vault, guard, policyHash: 'p1', payment: null, currentPolicyHash: null })).toMatchObject({ ok: false, code: 'not-paid' });
    expect(authorizeGuardJob({ vault, guard, policyHash: 'p1', payment: { Account: desk }, currentPolicyHash: null })).toMatchObject({ ok: false, code: 'not-from-vault' });
    expect(authorizeGuardJob({ vault, guard, policyHash: 'p1', payment: { Account: vault }, currentPolicyHash: null })).toEqual({ ok: true, policyHash: 'p1' });
  });
  it('lets the guard pay a renewal of the same policy, but a policy change only without the guard', () => {
    expect(authorizeGuardJob({ vault, guard, policyHash: 'p1', payment: viaGuard, currentPolicyHash: 'p1' }).ok).toBe(true);
    expect(authorizeGuardJob({ vault, guard, policyHash: 'loose', payment: viaGuard, currentPolicyHash: 'p1' })).toMatchObject({ ok: false, code: 'policy-change-needs-recovery' });
    expect(authorizeGuardJob({ vault, guard, policyHash: 'p2', payment: viaRecovery, currentPolicyHash: 'p1' }).ok).toBe(true);
  });
});
