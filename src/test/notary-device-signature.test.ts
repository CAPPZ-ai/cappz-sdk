import { describe, it, expect } from 'vitest';
import { generateRecoveryPhrase, keyPairFromPhrase } from '../lib/auth/wallet/session';
import { declareKey, revokeKeyDeclaration } from '../lib/identity/keyDeclaration';
import { decodeCbor } from '../lib/identity/cbor';
import { coseKeyToP256, ecdsaDerToRaw, parseAuthenticatorData } from '../lib/identity/webauthn';
import { buildNotaryBatch } from '../lib/crypto/notaryBatch';
import { notaryStatement, signNotaryStatement, signNotaryStatementWithPasskey, verifyNotaryDeviceSignature, webCryptoSigner, type NotaryDeviceSignature } from '../lib/crypto/notaryDeviceSignature';
import { SoftAuthenticator, encodeCbor } from './helpers/softAuthenticator';

const wallet = () => { const k = keyPairFromPhrase(generateRecoveryPhrase()); return { priv: k.privateKey, address: k.address }; };
const RP = 'cappz.ai';
const ORIGINS = ['https://cappz.ai'];
const receipt = { leaf: 'AB'.repeat(32), salt: 'q7Lr3x_PZt0vYd8uKm2N1w', anchor_account: 'rAnchorAccount', timestamp_utc: '2026-10-31T10:00:00.000Z' };

async function enrolPasskey(auth: SoftAuthenticator) {
  const cred = await auth.create({ challenge: new Uint8Array(32), rp: { id: RP, name: 'CAPPZ' }, user: { id: new Uint8Array(8), name: 'u', displayName: 'u' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }] });
  const att = decodeCbor(new Uint8Array((cred.response as AuthenticatorAttestationResponse).attestationObject)) as Map<string, unknown>;
  const authData = parseAuthenticatorData(att.get('authData') as Uint8Array);
  return { credentialId: Buffer.from(new Uint8Array(cred.rawId)).toString('base64url'), publicKey: coseKeyToP256(authData.credential!.publicKey), authData };
}

describe('v15-16-00 strict CBOR and WebAuthn parsing', () => {
  it('decodes what the authenticator produced and refuses malformed input', () => {
    const v = decodeCbor(encodeCbor(new Map<never, never>([[1 as never, 2 as never], [-2 as never, new Uint8Array([9]) as never]]))) as Map<number, unknown>;
    expect(v.get(1)).toBe(2);
    for (const bad of [
      [0x18, 0x05],              // non-shortest integer
      [0x5f, 0x40, 0xff],        // indefinite byte string
      [0xc0, 0x00],              // tag
      [0xf9, 0x00, 0x00],        // half float
      [0xa2, 0x01, 0x01, 0x01, 0x02], // duplicate map key
      [0x42, 0x01],              // truncated bytes
      [0x01, 0x02],              // trailing bytes
    ]) expect(() => decodeCbor(Uint8Array.from(bad)), JSON.stringify(bad)).toThrow(/cbor/);
    let deep = Uint8Array.from([0x00]);
    for (let i = 0; i < 20; i++) deep = Uint8Array.from([0x81, ...deep]);
    expect(() => decodeCbor(deep)).toThrow(/deeply/);
  });

  it('strict DER signatures: non-minimal, negative and trailing encodings are refused', () => {
    const ok = Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02]);
    expect(Array.from(ecdsaDerToRaw(ok).slice(30, 34))).toEqual([0, 1, 0, 0]);
    expect(() => ecdsaDerToRaw(Uint8Array.from([0x30, 0x07, 0x02, 0x02, 0x00, 0x01, 0x02, 0x01, 0x02]))).toThrow(/DER/);
    expect(() => ecdsaDerToRaw(Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x81, 0x02, 0x01, 0x02]))).toThrow(/DER/);
    expect(() => ecdsaDerToRaw(Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02, 0x00]))).toThrow(/DER/);
  });
});

describe('v15-16-00 device-signed notarization receipts', () => {
  it('passkey signature verifies as trusted once the wallet declares the key, and shows user verification', async () => {
    const w = wallet();
    const auth = new SoftAuthenticator();
    const pk = await enrolPasskey(auth);
    const sig = await signNotaryStatementWithPasskey(receipt, { walletAddress: w.address, publicKey: pk.publicKey, credentialId: pk.credentialId, rpId: RP }, auth);
    expect(sig.scheme).toBe('webauthn-es256');

    const undeclared = await verifyNotaryDeviceSignature(receipt, sig, { evidence: { declarations: [] }, origins: ORIGINS });
    expect(undeclared.state).toBe('untrusted-key');
    expect(undeclared.keyTrust?.state).toBe('undeclared');

    const decl = await declareKey(w.priv, w.address, { publicKey: pk.publicKey, algorithm: 'p256', purpose: 'signing' });
    const ok = await verifyNotaryDeviceSignature(receipt, sig, { evidence: { declarations: [decl] }, origins: ORIGINS });
    expect(ok).toMatchObject({ state: 'trusted', userVerified: true });

    const rev = await revokeKeyDeclaration(w.priv, decl, 'device lost');
    expect((await verifyNotaryDeviceSignature(receipt, sig, { evidence: { declarations: [decl], revocations: [rev] }, origins: ORIGINS })).keyTrust?.state).toBe('revoked');
  });

  it('a signature is bound to its receipt, origin, RP and user verification', async () => {
    const w = wallet();
    const auth = new SoftAuthenticator();
    const pk = await enrolPasskey(auth);
    const decl = await declareKey(w.priv, w.address, { publicKey: pk.publicKey, algorithm: 'p256', purpose: 'signing' });
    const ev = { evidence: { declarations: [decl] }, origins: ORIGINS };
    const passkey = { walletAddress: w.address, publicKey: pk.publicKey, credentialId: pk.credentialId, rpId: RP };
    const sig = await signNotaryStatementWithPasskey(receipt, passkey, auth);

    expect((await verifyNotaryDeviceSignature({ ...receipt, leaf: 'CD'.repeat(32) }, sig, ev)).state).toBe('wrong-challenge');
    expect((await verifyNotaryDeviceSignature(receipt, sig, { ...ev, origins: ['https://evil.example'] })).state).toBe('wrong-origin');
    expect((await verifyNotaryDeviceSignature(receipt, { ...sig, rpId: 'evil.example' } as NotaryDeviceSignature, { ...ev, origins: ORIGINS })).state).toBe('wrong-rp');
    const bytes = Buffer.from((sig as { signature: string }).signature, 'base64url'); bytes[bytes.length - 1] ^= 1;
    expect((await verifyNotaryDeviceSignature(receipt, { ...sig, signature: bytes.toString('base64url') } as NotaryDeviceSignature, ev)).state).toMatch(/bad-signature|malformed/);

    auth.opts.userVerified = false;
    const noUv = await signNotaryStatementWithPasskey(receipt, passkey, auth);
    expect((await verifyNotaryDeviceSignature(receipt, noUv, ev)).state).toBe('user-not-verified');
  });

  it('raw P-256 keys (native shells, WebCrypto) sign the statement directly; either point encoding matches the declaration', async () => {
    const w = wallet();
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as CryptoKeyPair;
    const full = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
    const fullHex = Buffer.from(full).toString('hex');
    const compressedHex = Buffer.from([0x02 | (full[64] & 1), ...full.subarray(1, 33)]).toString('hex');
    const decl = await declareKey(w.priv, w.address, { publicKey: compressedHex, algorithm: 'p256', purpose: 'signing' });
    const sig = await signNotaryStatement(receipt, { walletAddress: w.address, publicKey: fullHex, sign: webCryptoSigner(keys.privateKey) });
    expect((await verifyNotaryDeviceSignature(receipt, sig, { evidence: { declarations: [decl] } })).state).toBe('trusted');
    expect((await verifyNotaryDeviceSignature({ ...receipt, timestamp_utc: '2026-10-31T10:00:01.000Z' }, sig, { evidence: { declarations: [decl] } })).state).toBe('bad-signature');
    const hello = await declareKey(w.priv, w.address, { publicKey: compressedHex, algorithm: 'p256', purpose: 'hello' });
    expect((await verifyNotaryDeviceSignature(receipt, sig, { evidence: { declarations: [hello] } })).keyTrust?.state).toBe('wrong-purpose');
  });

  it('a whole batch is signed once: the statement names root and count, and a different count fails', async () => {
    const w = wallet();
    const auth = new SoftAuthenticator();
    const pk = await enrolPasskey(auth);
    const decl = await declareKey(w.priv, w.address, { publicKey: pk.publicKey, algorithm: 'p256', purpose: 'signing' });
    const b = buildNotaryBatch(['AA', 'BB', 'CC'].map((x) => x.repeat(32)));
    const batchStatement = { root: b.root, count: b.count, anchor_account: receipt.anchor_account, timestamp_utc: receipt.timestamp_utc };
    const sig = await signNotaryStatementWithPasskey(batchStatement, { walletAddress: w.address, publicKey: pk.publicKey, credentialId: pk.credentialId, rpId: RP }, auth);
    expect(auth.credentials[0].signCount).toBe(1);
    expect((await verifyNotaryDeviceSignature(batchStatement, sig, { evidence: { declarations: [decl] }, origins: ORIGINS })).state).toBe('trusted');
    expect((await verifyNotaryDeviceSignature({ ...batchStatement, count: 4 }, sig, { evidence: { declarations: [decl] }, origins: ORIGINS })).state).toBe('wrong-challenge');
    expect(() => notaryStatement({ anchor_account: 'r', timestamp_utc: 't' })).toThrow(/root and count/);
  });

  it('batch receipts sign their root and index too', async () => {
    const leaves = ['AA', 'BB', 'CC'].map((x) => x.repeat(32));
    const b = buildNotaryBatch(leaves);
    const one = notaryStatement({ ...receipt, leaf: leaves[1], root: b.root, index: 1 });
    const other = notaryStatement({ ...receipt, leaf: leaves[1], root: b.root, index: 2 });
    expect(one).not.toBe(other);
    expect(one).toContain(b.root);
  });
});
