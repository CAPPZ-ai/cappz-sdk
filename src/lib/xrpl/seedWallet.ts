/**
 * Which account does an XRPL family seed control? xrpl.js 4 read a secp256k1 seed (s…, not sEd…)
 * as Ed25519 when Wallet.fromSeed got no algorithm; xrpl.js 5 infers the type from the seed. Both
 * readings are real key pairs the seed controls, so a wallet recorded under its xrpl-4 address keeps
 * working: given the account it must sign for, use the reading that controls it, and report a
 * legacy match as its own state. Without an account, the seed's own type (xrpl 5) is used.
 *
 * No imports: the caller passes xrpl's Wallet class, so the same file runs in the app, the SDK and
 * the edge functions (supabase/functions/_shared/xrplSeedWallet.ts is a byte-identical copy).
 */
export type SeedDerivation = 'inferred' | 'legacy-ed25519';

export interface SeedWalletClass<W extends { classicAddress: string }> {
  fromSeed(seed: string, opts?: { algorithm?: never }): W;
}

/** The xrpl-4 reading of a secp256k1 seed (as Ed25519), or null when it is the same account. */
export function legacySeedWallet<W extends { classicAddress: string }>(Wallet: SeedWalletClass<W>, seed: string): W | null {
  const inferred = Wallet.fromSeed(seed);
  const legacy = Wallet.fromSeed(seed, { algorithm: 'ed25519' as never });
  return legacy.classicAddress === inferred.classicAddress ? null : legacy;
}

/** The wallet for `account` from `seed`; throws when the seed controls neither reading of it. */
export function walletForAccount<W extends { classicAddress: string }>(Wallet: SeedWalletClass<W>, seed: string, account?: string): { wallet: W; derivation: SeedDerivation } {
  const inferred = Wallet.fromSeed(seed);
  if (!account || inferred.classicAddress === account) return { wallet: inferred, derivation: 'inferred' };
  const legacy = legacySeedWallet(Wallet, seed);
  if (legacy && legacy.classicAddress === account) return { wallet: legacy, derivation: 'legacy-ed25519' };
  throw new Error(`seed does not control ${account}`);
}
