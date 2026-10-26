import { describe, it, expect } from 'vitest';
import { generateRecoveryPhrase, keyPairFromPhrase } from '../lib/auth/wallet/session';
import { declareHelloKey } from '../lib/sync/helloKeyDeclaration';
import { generateSigningKey } from '../lib/sync/helloSignature';
import { asKeyDeclaration, declarationHash, declareKey, declaredKeysFor, delegateKey, evaluateKey, revokeKeyDeclaration, verifyKeyDeclaration, verifyKeyDelegation, verifyKeyRevocation, withoutRevokedKeys, KEY_DELEGATION_MAX_TTL_MS } from '../lib/identity/keyDeclaration';

const wallet = () => { const k = keyPairFromPhrase(generateRecoveryPhrase()); return { priv: k.privateKey, address: k.address }; };

describe('v15-09-00 key declarations', () => {
  it('a v1 hello declaration still verifies and reads as purpose hello / ed25519', async () => {
    const w = wallet(); const dev = await generateSigningKey();
    const v1 = await declareHelloKey(w.priv, w.address, dev.publicKeyHex);
    expect(await verifyKeyDeclaration(v1)).toBe('valid');
    expect(asKeyDeclaration(v1)).toEqual(expect.objectContaining({ v: 2, purpose: 'hello', algorithm: 'ed25519', publicKey: dev.publicKeyHex }));
    expect((await evaluateKey(w.address, dev.publicKeyHex, 'hello', { declarations: [v1] })).state).toBe('declared');
  });

  it('purposes are not interchangeable; another wallet cannot declare for this one', async () => {
    const w = wallet(); const other = wallet(); const dev = await generateSigningKey();
    const tls = await declareKey(w.priv, w.address, { publicKey: dev.publicKeyHex, algorithm: 'ed25519', purpose: 'tls' });
    expect((await evaluateKey(w.address, dev.publicKeyHex, 'hello', { declarations: [tls] })).state).toBe('wrong-purpose');
    const forged = { ...(await declareKey(other.priv, other.address, { publicKey: dev.publicKeyHex, algorithm: 'ed25519', purpose: 'hello' })), walletAddress: w.address };
    expect(await verifyKeyDeclaration(forged)).toBe('bad-signature');
    expect((await evaluateKey(w.address, dev.publicKeyHex, 'hello', { declarations: [forged] })).state).toBe('bad-signature');
  });

  it('a revocation by the wallet withdraws the key before expiry; a revocation by anyone else is ignored', async () => {
    const w = wallet(); const other = wallet(); const dev = await generateSigningKey();
    const d = await declareKey(w.priv, w.address, { publicKey: dev.publicKeyHex, algorithm: 'ed25519', purpose: 'hello' });
    const r = await revokeKeyDeclaration(w.priv, d, 'device lost');
    expect(await verifyKeyRevocation(r)).toBe('valid');
    expect(r.declarationHash).toBe(await declarationHash(d));
    expect((await evaluateKey(w.address, dev.publicKeyHex, 'hello', { declarations: [d], revocations: [r] })).state).toBe('revoked');
    const fake = { ...(await revokeKeyDeclaration(other.priv, d, 'grief')), walletAddress: w.address };
    expect((await evaluateKey(w.address, dev.publicKeyHex, 'hello', { declarations: [d], revocations: [fake] })).state).toBe('declared');
    expect(await declaredKeysFor(w.address, 'hello', { declarations: [d], revocations: [r] })).toEqual([]);
    expect(await withoutRevokedKeys(w.address, [dev.publicKeyHex, 'aa'], [r, fake])).toEqual(['aa']);
  });

  it('expired and not-yet-valid declarations are reported as such', async () => {
    const w = wallet(); const dev = await generateSigningKey();
    const d = await declareKey(w.priv, w.address, { publicKey: dev.publicKeyHex, algorithm: 'ed25519', purpose: 'hello' }, 1000, Date.now() - 10_000);
    expect((await evaluateKey(w.address, dev.publicKeyHex, 'hello', { declarations: [d] })).state).toBe('expired');
    const later = await declareKey(w.priv, w.address, { publicKey: dev.publicKeyHex, algorithm: 'ed25519', purpose: 'hello' }, 1000, Date.now() + 3600_000);
    expect(await verifyKeyDeclaration(later)).toBe('not-yet-valid');
  });

  it('a declared node key delegates a short-lived TLS key: wallet → node → tls verifies offline', async () => {
    const w = wallet(); const node = await generateSigningKey(); const tlsKey = '04' + 'ab'.repeat(64);
    const d = await declareKey(w.priv, w.address, { publicKey: node.publicKeyHex, algorithm: 'ed25519', purpose: 'hello' });
    const dl = await delegateKey(node, w.address, { publicKey: tlsKey, algorithm: 'p256', purpose: 'tls' }, 30 * 24 * 3600_000);
    expect(Date.parse(dl.expiresAt) - Date.parse(dl.issuedAt)).toBe(KEY_DELEGATION_MAX_TTL_MS);
    expect(await verifyKeyDelegation(dl)).toBe('valid');
    expect((await evaluateKey(w.address, tlsKey, 'tls', { declarations: [d], delegations: [dl] })).state).toBe('delegated');
    expect((await evaluateKey(w.address, tlsKey, 'signing', { declarations: [d], delegations: [dl] })).state).toBe('wrong-purpose');
    // Revoking the node key ends the delegation too.
    const r = await revokeKeyDeclaration(w.priv, d, 'node retired');
    expect((await evaluateKey(w.address, tlsKey, 'tls', { declarations: [d], revocations: [r], delegations: [dl] })).state).toBe('revoked');
    // An undeclared key cannot delegate.
    const stray = await generateSigningKey();
    const bad = await delegateKey(stray, w.address, { publicKey: tlsKey, algorithm: 'p256', purpose: 'tls' });
    expect((await evaluateKey(w.address, tlsKey, 'tls', { declarations: [d], delegations: [bad] })).state).toBe('undeclared');
  });
});
