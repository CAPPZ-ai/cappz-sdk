import { describe, it, expect } from 'vitest';
import { generateRecoveryPhrase, keyPairFromPhrase } from '../lib/auth/wallet/session';
import {
  boxPublicKeyHex, generateBoxKeyPair, HYBRID_BOX_SCHEME, CLASSIC_BOX_SCHEME, isHybridBoxKey, openBytesWith, openWith, sealBytesTo, sealTo, upgradeBoxKeyPair, type SealedBox,
} from '../lib/crypto/sealedBox';
import { openSharedEnvelope, sealForRecipients, walletEncryptionKey } from '../lib/crypto/walletEnvelope';
import { channelKemAccept, channelKemOffer, channelKeyFromWalletSecret, generateChannelKeyPair, openSecureChannel } from '../lib/sync/a2aSecureChannel';
import {
  declareKey, declarePqAnchor, declarationHash, evaluateKey, generatePqKey, pqAnchorState, pqCosign, pqKeyFromSeed, revokeKeyDeclaration,
} from '../lib/identity/keyDeclaration';
import { isDeclarationShape } from '../lib/identity/edgeVerify';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);

describe('v16-02-00 hybrid sealed box (P-256 + ML-KEM-768)', () => {
  it('new box keys are hybrid and seal hybrid; the classical option still seals classically', async () => {
    const pq = await generateBoxKeyPair();
    expect(isHybridBoxKey(pq.publicKey)).toBe(true);
    const box = await sealTo(pq.publicKey, { secret: 'escrow fulfillment' });
    expect(box.scheme).toBe(HYBRID_BOX_SCHEME);
    expect(await openWith<{ secret: string }>(pq.privateKey, box)).toEqual({ secret: 'escrow fulfillment' });
    const classic = await generateBoxKeyPair({ classic: true });
    const old = await sealTo(classic.publicKey, 'x');
    expect(old.scheme).toBe(CLASSIC_BOX_SCHEME);
    expect(await openWith(classic.privateKey, old)).toBe('x');
  });

  it('an upgraded key keeps its P-256 half: boxes sealed before the upgrade still open, new ones are hybrid', async () => {
    const classic = await generateBoxKeyPair({ classic: true });
    const before = await sealTo(classic.publicKey, 'sealed in 2025');
    const up = upgradeBoxKeyPair(classic);
    expect(up.upgraded).toBe(true);
    expect(upgradeBoxKeyPair(up).upgraded).toBe(false);
    expect(await openWith(up.privateKey, before)).toBe('sealed in 2025');
    const after = await sealTo(up.publicKey, 'sealed now');
    expect(after.scheme).toBe(HYBRID_BOX_SCHEME);
    expect(await openWith(up.privateKey, after)).toBe('sealed now');
    // The P-256 private key alone (what a quantum attacker could recover) does not open the hybrid box.
    await expect(openWith(classic.privateKey, after)).rejects.toThrow(/no ML-KEM-768 half/);
  });

  it('a swapped KEM ciphertext or another recipient key does not open', async () => {
    const a = await generateBoxKeyPair(); const b = await generateBoxKeyPair();
    const box = await sealTo(a.publicKey, 'for a') as Extract<SealedBox, { scheme: typeof HYBRID_BOX_SCHEME }>;
    await expect(openWith(b.privateKey, box)).rejects.toThrow();
    const other = await sealTo(a.publicKey, 'other') as Extract<SealedBox, { scheme: typeof HYBRID_BOX_SCHEME }>;
    await expect(openWith(a.privateKey, { ...box, kemCipherText: other.kemCipherText })).rejects.toThrow();
  });

  it('compact boxes seal to a declared hybrid key (point ‖ ML-KEM key) and to a plain P-256 point', async () => {
    const pq = await generateBoxKeyPair();
    const k = boxPublicKeyHex(pq.publicKey);
    expect(k.algorithm).toBe('p256+ml-kem-768');
    expect(k.publicKey).toHaveLength(2498);
    const box = await sealBytesTo(k.publicKey, enc('mesh body'));
    expect(box.scheme).toBe(HYBRID_BOX_SCHEME);
    expect(dec(await openBytesWith(pq.privateKey, box))).toBe('mesh body');
    const classic = await generateBoxKeyPair({ classic: true });
    const c = boxPublicKeyHex(classic.publicKey);
    expect(c.algorithm).toBe('p256');
    expect(dec(await openBytesWith(classic.privateKey, await sealBytesTo(c.publicKey, enc('lora'))))).toBe('lora');
  });

  it('the wallet encryption key is hybrid only from the recovery seed, recoverable; records shared to the old P-256 key still open', async () => {
    const phrase = generateRecoveryPhrase();
    const w = keyPairFromPhrase(phrase);
    const pq = await walletEncryptionKey(w.privateKey, { pqSeed: w.pqSeed });
    expect(pq.algorithm).toBe('p256+ml-kem-768');
    const again = keyPairFromPhrase(phrase);
    expect((await walletEncryptionKey(again.privateKey, { pqSeed: again.pqSeed })).publicKey).toBe(pq.publicKey);
    // The private key alone (what a quantum computer recovers from the address) yields only the P-256 key.
    const classic = await walletEncryptionKey(w.privateKey);
    expect(classic.algorithm).toBe('p256');
    expect(pq.publicKey.startsWith(classic.publicKey)).toBe(true);
    const ctx = 'rx|owner|1';
    const oldRecord = await sealForRecipients(enc('old'), ctx, { recipients: [{ id: w.address, publicKey: classic.publicKey }] });
    const newRecord = await sealForRecipients(enc('new'), ctx, { recipients: [{ id: w.address, publicKey: pq.publicKey }] });
    expect(dec(await openSharedEnvelope(oldRecord, ctx, { recipientId: w.address, encryptionPrivateKey: pq.privateKey }))).toBe('old');
    expect(dec(await openSharedEnvelope(newRecord, ctx, { recipientId: w.address, encryptionPrivateKey: pq.privateKey }))).toBe('new');
    expect(await openSharedEnvelope(newRecord, ctx, { recipientId: w.address, encryptionPrivateKey: classic.privateKey })).toBeNull();
  });
});

describe('v16-02-00 hybrid peer channel (X25519 + ML-KEM-768)', () => {
  it('both sides derive the same keys, the suite is recorded, and a different KEM secret cannot read frames', async () => {
    const a = generateChannelKeyPair(); const b = generateChannelKeyPair();
    const offer = channelKemOffer(b.kem!.publicKey);
    const ca = await openSecureChannel({ sessionId: 's1', mine: a, peerPublicKey: b.publicKey, pq: offer });
    const cb = await openSecureChannel({ sessionId: 's1', mine: b, peerPublicKey: a.publicKey, pq: { cipherText: offer.cipherText, sharedSecret: channelKemAccept(b, offer.cipherText) } });
    expect(ca.suite).toBe('x25519+ml-kem-768');
    expect(await cb.open(await ca.seal({ hi: 1 }))).toEqual({ hi: 1 });
    // A classical-only peer (what breaking X25519 alone would give) derives other keys.
    const classical = await openSecureChannel({ sessionId: 's1', mine: b, peerPublicKey: a.publicKey });
    expect(classical.suite).toBe('x25519');
    await expect(classical.open(await ca.seal({ hi: 2 }))).rejects.toThrow();
  });

  it('wallet-derived channel keys carry a deterministic ML-KEM key only from the recovery seed', async () => {
    const secret = crypto.getRandomValues(new Uint8Array(32)); const pqSeed = crypto.getRandomValues(new Uint8Array(32));
    const k1 = await channelKeyFromWalletSecret(secret, pqSeed); const k2 = await channelKeyFromWalletSecret(secret, pqSeed);
    expect(k1.kem!.publicKey).toEqual(k2.kem!.publicKey);
    expect((await channelKeyFromWalletSecret(secret)).kem).toBeUndefined();
  });
});

describe('v16-02-00 post-quantum anchor for key declarations (ML-DSA-65)', () => {
  const wallet = () => keyPairFromPhrase(generateRecoveryPhrase());
  const edKey = '11'.repeat(32);

  it('an unanchored wallet keeps working classically, and says so', async () => {
    const w = wallet();
    const d = await declareKey(w.privateKey, w.address, { publicKey: edKey, algorithm: 'ed25519', purpose: 'signing' });
    const t = await evaluateKey(w.address, edKey, 'signing', { declarations: [d] });
    expect(t.state).toBe('declared');
    expect(t.postQuantum).toBe('unanchored');
  });

  it('once anchored, a declaration needs the anchor co-signature; co-signing in place keeps its hash', async () => {
    const w = wallet(); const pqk = generatePqKey();
    const anchor = await declarePqAnchor(w.privateKey, w.address, pqk);
    const d = await declareKey(w.privateKey, w.address, { publicKey: edKey, algorithm: 'ed25519', purpose: 'signing' });
    // What someone who forged the wallet's secp256k1 signature could produce: refused.
    expect((await evaluateKey(w.address, edKey, 'signing', { declarations: [anchor, d] })).state).toBe('pq-unsigned');
    const signed = await pqCosign(d, anchor, pqk);
    expect(await declarationHash(signed)).toBe(await declarationHash(d));
    const t = await evaluateKey(w.address, edKey, 'signing', { declarations: [anchor, signed] });
    expect(t.state).toBe('declared');
    expect(t.postQuantum).toBe('hybrid');
  });

  it('a forged classical revocation cannot unanchor the wallet; the anchor revoking itself can', async () => {
    const w = wallet(); const pqk = generatePqKey();
    const anchor = await declarePqAnchor(w.privateKey, w.address, pqk);
    const forged = await revokeKeyDeclaration(w.privateKey, anchor, 'attacker');
    expect((await pqAnchorState(w.address, { declarations: [anchor], revocations: [forged] })).state).toBe('anchored');
    const real = await pqCosign(forged, anchor, pqk);
    expect((await pqAnchorState(w.address, { declarations: [anchor], revocations: [real] })).state).toBe('unanchored');
    // Someone else's ML-DSA key cannot stand in for the anchor's.
    const other = generatePqKey();
    const fake = { ...forged, pq: { anchor: real.pq!.anchor, signature: (await pqCosign(forged, { ...anchor, publicKey: other.publicKey }, other)).pq!.signature } };
    expect((await pqAnchorState(w.address, { declarations: [anchor], revocations: [fake] })).state).toBe('anchored');
  });

  it('a rival anchor nothing endorses is a conflict; rotation through endorsement is not; a pin resolves it', async () => {
    const w = wallet(); const k1 = generatePqKey(); const k2 = generatePqKey(); const evil = generatePqKey();
    const a1 = await declarePqAnchor(w.privateKey, w.address, k1);
    const a2 = await declarePqAnchor(w.privateKey, w.address, k2, { rotateFrom: { anchor: a1, key: k1 }, now: Date.now() + 1000 });
    const rot = await pqAnchorState(w.address, { declarations: [a1, a2] }, Date.now() + 2000);
    expect(rot.state).toBe('anchored');
    if (rot.state === 'anchored') expect(rot.current).toBe(await declarationHash(a2));
    const rival = await declarePqAnchor(w.privateKey, w.address, evil, { now: Date.now() - 86_400_000 });
    expect((await pqAnchorState(w.address, { declarations: [a1, a2, rival] }, Date.now() + 2000)).state).toBe('conflict');
    const d = await pqCosign(await declareKey(w.privateKey, w.address, { publicKey: edKey, algorithm: 'ed25519', purpose: 'signing' }), a2, k2);
    expect((await evaluateKey(w.address, edKey, 'signing', { declarations: [a1, a2, rival, d] }, Date.now() + 2000)).state).toBe('pq-conflict');
    const pinned = await evaluateKey(w.address, edKey, 'signing', { declarations: [a1, a2, rival, d], pinnedPqAnchors: { [w.address]: await declarationHash(a1) } }, Date.now() + 2000);
    expect(pinned.state).toBe('declared');
  });

  it('the anchor key comes from the recovery seed, deterministically', async () => {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    expect((await pqKeyFromSeed(seed)).publicKey).toBe((await pqKeyFromSeed(seed)).publicKey);
    expect((await pqKeyFromSeed(seed, 'other')).publicKey).not.toBe((await pqKeyFromSeed(seed)).publicKey);
  });

  it('the edge node accepts the shape of anchors, co-signed and hybrid encryption declarations', async () => {
    const w = wallet(); const pqk = generatePqKey();
    const anchor = await declarePqAnchor(w.privateKey, w.address, pqk);
    expect(isDeclarationShape(anchor)).toBe(true);
    const box = boxPublicKeyHex((await generateBoxKeyPair()).publicKey);
    const encDecl = await pqCosign(await declareKey(w.privateKey, w.address, { publicKey: box.publicKey, algorithm: box.algorithm, purpose: 'encryption' }), anchor, pqk);
    expect(isDeclarationShape(encDecl)).toBe(true);
    expect(isDeclarationShape({ ...encDecl, pq: { anchor: 'x', signature: 'zz' } })).toBe(false);
  });
});
