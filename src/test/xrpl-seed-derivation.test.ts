// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { Wallet } from 'xrpl';

describe('XRPL seed derivation', () => {
  it('Wallet.fromSeed derives the address a seed was generated for, for both key types', () => {
    // xrpl 4 read a secp256k1 family seed (s…, not sEd…) as Ed25519 when no algorithm was given and
    // returned an address nobody funded; xrpl 5 infers the type from the seed. Bring-your-own wallets
    // from exchanges and Xaman are often secp256k1, so this must hold without an explicit algorithm.
    for (const algorithm of ['ed25519', 'ecdsa-secp256k1'] as const) {
      const generated = Wallet.generate(algorithm as never);
      expect(Wallet.fromSeed(generated.seed!).classicAddress).toBe(generated.classicAddress);
      expect(Wallet.fromSecret(generated.seed!).classicAddress).toBe(generated.classicAddress);
    }
    expect(Wallet.generate().seed!.startsWith('sEd')).toBe(true); // the default stays Ed25519
  });
});
