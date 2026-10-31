import { describe, it, expect } from 'vitest';
import { generateRecoveryPhrase, keyPairFromPhrase } from '../lib/auth/wallet/session';
import { isWalletEnvelope, openForWallet, sealForWallet, WALLET_ENVELOPE_PREFIX } from '../lib/crypto/walletEnvelope';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);

describe('v15-17-00 data keys wrapped by a wallet', () => {
  const phrase = generateRecoveryPhrase();
  const wallet = keyPairFromPhrase(phrase);
  const ctx = `agent-context|${wallet.address}|session-1`;

  it('round-trips with the wallet key, and the recovery phrase alone recovers it on another device', async () => {
    const sealed = await sealForWallet(enc('calendar tokens'), wallet.privateKey, ctx);
    expect(isWalletEnvelope(sealed)).toBe(true);
    expect(sealed.startsWith(WALLET_ENVELOPE_PREFIX)).toBe(true);
    expect(dec(await openForWallet(sealed, keyPairFromPhrase(phrase).privateKey, ctx))).toBe('calendar tokens');
  });

  it('nothing public opens it: not the address, not another wallet, not another purpose or scope', async () => {
    const sealed = await sealForWallet(enc('secret'), wallet.privateKey, ctx);
    const other = keyPairFromPhrase(generateRecoveryPhrase());
    expect(await openForWallet(sealed, other.privateKey, ctx)).toBeNull();
    expect(await openForWallet(sealed, wallet.privateKey, `calendar|${wallet.address}|session-1`)).toBeNull();
    expect(await openForWallet(sealed, wallet.privateKey, `agent-context|${wallet.address}|session-2`)).toBeNull();
    // An "attacker key" built from the public address is just another wrong key.
    const fromAddress = new Uint8Array(await crypto.subtle.digest('SHA-256', enc(wallet.address)));
    expect(await openForWallet(sealed, fromAddress, ctx)).toBeNull();
  });

  it('every record has its own data key; tampering with either layer fails', async () => {
    const a = await sealForWallet(enc('same'), wallet.privateKey, ctx);
    const b = await sealForWallet(enc('same'), wallet.privateKey, ctx);
    expect(a).not.toBe(b);
    for (const at of [5, 30, 65, 90]) {
      const raw = Buffer.from(a.slice(WALLET_ENVELOPE_PREFIX.length), 'base64'); raw[at] ^= 1;
      expect(await openForWallet(WALLET_ENVELOPE_PREFIX + raw.toString('base64'), wallet.privateKey, ctx), `byte ${at}`).toBeNull();
    }
    expect(await openForWallet('U2FsdGVkX1legacy', wallet.privateKey, ctx)).toBeNull();
    expect(dec(await openForWallet(await sealForWallet(new Uint8Array(0), wallet.privateKey, ctx), wallet.privateKey, ctx))).toBe('');
  });
});
