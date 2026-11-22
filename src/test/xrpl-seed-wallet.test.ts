// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { Wallet } from 'xrpl';
import { legacySeedWallet, walletForAccount } from '../lib/xrpl/seedWallet';

// A random secp256k1 test seed (never funded); RECORDED_XRPL4 is what xrpl 4.7.0 derived from it
// with Wallet.fromSeed and no algorithm.
const SECP_SEED = 'snzA2gHmUe8evjht28beEjYDCV4wB';
const XRPL4_ADDRESS = Wallet.fromSeed(SECP_SEED, { algorithm: 'ed25519' as never }).classicAddress;

describe('walletForAccount — a seed keeps signing for the account it was recorded under', () => {
  it('a secp256k1 seed: the inferred account, and the xrpl-4 account reported as legacy', () => {
    const inferred = Wallet.fromSeed(SECP_SEED);
    expect(inferred.classicAddress).not.toBe(XRPL4_ADDRESS);
    expect(walletForAccount(Wallet, SECP_SEED, inferred.classicAddress)).toMatchObject({ derivation: 'inferred' });
    const legacy = walletForAccount(Wallet, SECP_SEED, XRPL4_ADDRESS);
    expect(legacy.derivation).toBe('legacy-ed25519');
    expect(legacy.wallet.classicAddress).toBe(XRPL4_ADDRESS);
    expect(legacySeedWallet(Wallet, SECP_SEED)?.classicAddress).toBe(XRPL4_ADDRESS);
    expect(walletForAccount(Wallet, SECP_SEED).wallet.classicAddress).toBe(inferred.classicAddress);
  });

  it('an Ed25519 seed has one reading, and a seed never signs for an account it does not control', () => {
    const ed = Wallet.generate();
    expect(legacySeedWallet(Wallet, ed.seed!)).toBeNull();
    expect(walletForAccount(Wallet, ed.seed!, ed.classicAddress)).toMatchObject({ derivation: 'inferred' });
    expect(() => walletForAccount(Wallet, ed.seed!, Wallet.generate().classicAddress)).toThrow(/does not control/);
    expect(() => walletForAccount(Wallet, SECP_SEED, ed.classicAddress)).toThrow(/does not control/);
  });

  it('the legacy reading is what xrpl 4 returned', () => {
    // Recorded with xrpl 4.7.0: Wallet.fromSeed(SECP_SEED).classicAddress.
    expect(XRPL4_ADDRESS).toBe(RECORDED_XRPL4);
  });
});

const RECORDED_XRPL4 = 'rPWdk7PQ6p2rME7bkH5QAcGPiUYeDmHFZU';
