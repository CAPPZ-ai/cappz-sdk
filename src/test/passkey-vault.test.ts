import { describe, it, expect } from 'vitest';
import { enrolPasskey, unwrapWithPasskey, wrapWithPasskey } from '../lib/identity/passkeyVault';
import { SoftAuthenticator } from './helpers/softAuthenticator';

const RP = 'cappz.ai';
const user = { rpId: RP, rpName: 'CAPPZ', userId: new Uint8Array([1, 2, 3]), userName: 'wallet-02ab' };
const ADDRESS = '02' + 'ab'.repeat(32);
const secret = () => crypto.getRandomValues(new Uint8Array(32));

describe('v15-16-00 passkey-wrapped wallet keys (WebAuthn PRF)', () => {
  it('enrols a PRF passkey and round-trips a wallet key; nothing stored reveals it', async () => {
    const auth = new SoftAuthenticator();
    const p = await enrolPasskey(auth, user);
    expect(p.prfSupported).toBe(true);
    expect(p.publicKey).toBe(auth.credentials[0].publicKeyHex);
    const key = secret();
    const w = await wrapWithPasskey(key, p, ADDRESS, auth);
    const stored = JSON.stringify(w);
    expect(stored).not.toContain(Buffer.from(key).toString('hex'));
    expect(stored).not.toContain(Buffer.from(key).toString('base64url'));
    const back = await unwrapWithPasskey([w], auth);
    expect(back?.credentialId).toBe(p.credentialId);
    expect(Buffer.from(back!.secret).equals(Buffer.from(key))).toBe(true);
  });

  it('each wrap uses a fresh PRF salt and IV', async () => {
    const auth = new SoftAuthenticator();
    const p = await enrolPasskey(auth, user);
    const key = secret();
    const [a, b] = [await wrapWithPasskey(key, p, ADDRESS, auth), await wrapWithPasskey(key, p, ADDRESS, auth)];
    expect(a.prfSalt).not.toBe(b.prfSalt);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('with several enrolled passkeys, one prompt unlocks with whichever is used', async () => {
    const phone = new SoftAuthenticator();
    const laptop = new SoftAuthenticator();
    const key = secret();
    const wraps = [
      await wrapWithPasskey(key, await enrolPasskey(phone, user), ADDRESS, phone),
      await wrapWithPasskey(key, await enrolPasskey(laptop, user), ADDRESS, laptop),
    ];
    for (const auth of [phone, laptop]) {
      const back = await unwrapWithPasskey(wraps, auth);
      expect(back?.credentialId).toBe(Buffer.from(auth.credentials[0].id).toString('base64url'));
      expect(Buffer.from(back!.secret).equals(Buffer.from(key))).toBe(true);
    }
  });

  it('a tampered record, or one moved to another wallet, does not open', async () => {
    const auth = new SoftAuthenticator();
    const p = await enrolPasskey(auth, user);
    const w = await wrapWithPasskey(secret(), p, ADDRESS, auth);
    const ct = Buffer.from(w.ciphertext, 'base64url'); ct[0] ^= 1;
    expect(await unwrapWithPasskey([{ ...w, ciphertext: ct.toString('base64url') }], auth)).toBeNull();
    expect(await unwrapWithPasskey([{ ...w, context: '03' + 'cd'.repeat(32) }], auth)).toBeNull();
    expect(await unwrapWithPasskey([{ ...w, prfSalt: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url') }], auth)).toBeNull();
  });

  it('refuses clearly where the authenticator has no PRF', async () => {
    const auth = new SoftAuthenticator({ prf: false });
    const p = await enrolPasskey(auth, user);
    expect(p.prfSupported).toBe(false);
    await expect(wrapWithPasskey(secret(), p, ADDRESS, auth)).rejects.toThrow(/PRF/);
    await expect(unwrapWithPasskey([], auth)).rejects.toThrow(/no passkey wraps/);
  });
});
