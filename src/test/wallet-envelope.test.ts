import { describe, it, expect } from 'vitest';
import { generateRecoveryPhrase, keyPairFromPhrase } from '../lib/auth/wallet/session';
import { envelopeRecipients, isWalletEnvelope, openForWallet, openSharedEnvelope, sealForRecipients, sealForWallet, SHARED_ENVELOPE_PREFIX, WALLET_ENVELOPE_PREFIX, walletEncryptionKey } from '../lib/crypto/walletEnvelope';

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

describe('v15-18-00 shared records: one data key, a wrap per party', () => {
  const owner = keyPairFromPhrase(generateRecoveryPhrase());
  const pharmacy = keyPairFromPhrase(generateRecoveryPhrase());
  const patient = keyPairFromPhrase(generateRecoveryPhrase());
  const ctx = `prescription|${owner.address}|rx-1`;

  it('derives a stable P-256 encryption key from the wallet, recoverable from the phrase', async () => {
    const a = await walletEncryptionKey(pharmacy.privateKey);
    const b = await walletEncryptionKey(pharmacy.privateKey.slice());
    expect(a.publicKey).toMatch(/^04[0-9a-f]{128}$/);
    expect(b.publicKey).toBe(a.publicKey);
    expect((await walletEncryptionKey(patient.privateKey)).publicKey).not.toBe(a.publicKey);
    // The JWK is usable by WebCrypto ECDH.
    await crypto.subtle.importKey('jwk', a.privateKey, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  });

  it('the owner and each recipient open it with their own keys; nobody else does', async () => {
    const ph = await walletEncryptionKey(pharmacy.privateKey);
    const pt = await walletEncryptionKey(patient.privateKey);
    const sealed = await sealForRecipients(enc('amoxicillin 500mg'), ctx, {
      ownerPrivateKey: owner.privateKey,
      recipients: [{ id: pharmacy.address, publicKey: ph.publicKey }, { id: patient.address, publicKey: pt.publicKey }],
    });
    expect(sealed.startsWith(SHARED_ENVELOPE_PREFIX)).toBe(true);
    expect(sealed).not.toContain('amoxicillin');
    expect(envelopeRecipients(sealed)).toEqual(['owner', pharmacy.address, patient.address]);
    expect(dec(await openSharedEnvelope(sealed, ctx, { ownerPrivateKey: owner.privateKey }))).toBe('amoxicillin 500mg');
    expect(dec(await openSharedEnvelope(sealed, ctx, { recipientId: pharmacy.address, encryptionPrivateKey: ph.privateKey }))).toBe('amoxicillin 500mg');
    expect(dec(await openSharedEnvelope(sealed, ctx, { recipientId: patient.address, encryptionPrivateKey: pt.privateKey }))).toBe('amoxicillin 500mg');
    // Wrong keys, a wrap that is not yours, another record's context:
    expect(await openSharedEnvelope(sealed, ctx, { ownerPrivateKey: pharmacy.privateKey })).toBeNull();
    expect(await openSharedEnvelope(sealed, ctx, { recipientId: pharmacy.address, encryptionPrivateKey: pt.privateKey })).toBeNull();
    expect(await openSharedEnvelope(sealed, ctx, { recipientId: 'rStranger', encryptionPrivateKey: ph.privateKey })).toBeNull();
    expect(await openSharedEnvelope(sealed, `prescription|${owner.address}|rx-2`, { ownerPrivateKey: owner.privateKey })).toBeNull();
    expect(await openSharedEnvelope(sealed, `prescription|${owner.address}|rx-2`, { recipientId: patient.address, encryptionPrivateKey: pt.privateKey })).toBeNull();
  });

  it('refuses to seal for nobody, and rejects tampering and foreign formats', async () => {
    await expect(sealForRecipients(enc('x'), ctx, { recipients: [] })).rejects.toThrow(/nobody/);
    const sealed = await sealForRecipients(enc('x'), ctx, { ownerPrivateKey: owner.privateKey, recipients: [] });
    const env = JSON.parse(atob(sealed.slice(4).replace(/-/g, '+').replace(/_/g, '/')));
    env.ct = env.ct.slice(0, -2) + (env.ct.endsWith('AA') ? 'AB' : 'AA');
    const tampered = SHARED_ENVELOPE_PREFIX + btoa(JSON.stringify(env)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(await openSharedEnvelope(tampered, ctx, { ownerPrivateKey: owner.privateKey })).toBeNull();
    expect(await openSharedEnvelope('cw1.abc', ctx, { ownerPrivateKey: owner.privateKey })).toBeNull();
    expect(envelopeRecipients('garbage')).toEqual([]);
  });
});
