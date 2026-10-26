import { describe, it, expect } from 'vitest';
import { createPublicKey, verify as nodeVerify } from 'node:crypto';
import * as secp from '@noble/secp256k1';
import { generateRecoveryPhrase, keyPairFromPhrase } from '../lib/auth/wallet/session';
import { generateBoxKeyPair, newContentKey } from '../lib/crypto/sealedBox';
import { answerDisclosure, attestClaims, declineDisclosure, openClaim, recordBiometricBinding, recordClaim, replayIdentity, requestDisclosure, revokeAttestation, revokeClaim, selfAttest, verifyDisclosure, IDENTITY_EVENT_TYPES, type IdentityTx } from '../lib/identity/identityVault';
import { makeDisclosure, issueSdJwt, presentSdJwt, verifyPresentation, signJwt } from '../lib/identity/sdJwt';
import { didKeyFor } from '../lib/identity/didKey';
import { fromBase64Url } from '../lib/identity/canonical';
import { getEventTxRegistryEntry } from '../lib/skills/core/MDMEventTxRegistry';
import { userAccountRoot } from '../lib/wallets/paths';

const w = () => keyPairFromPhrase(generateRecoveryPhrase());
const root = userAccountRoot(7);

describe('v15-09-00 identity vault', () => {
  it('a claim TX carries only a salted digest and ciphertext; the holder can open it', async () => {
    const key = await newContentKey();
    const t = await recordClaim(root, 'birthdate', '1990-01-01', key);
    expect(t.eventType).toBe('IdentityClaimRecorded');
    expect(t.address).toBe(`${root}/identity/claims/birthdate/${t.data.claimId}`);
    expect(JSON.stringify(t)).not.toContain('1990');
    const enc = await openClaim(t.data, key);
    expect(JSON.parse(new TextDecoder().decode(fromBase64Url(enc)))[2]).toBe('1990-01-01');
  });

  it('holder → issuer → verifier: request, selective disclosure sealed to the verifier, verified with the issuer level', async () => {
    const holder = w(); const issuer = w(); const verifier = w();
    const key = await newContentKey();
    const name = await recordClaim(root, 'name', 'Ada Lovelace', key);
    const dob = await recordClaim(root, 'birthdate', '1815-12-10', key);
    const doc = await recordClaim(root, 'passportNumber', 'X1234567', key);
    const binding = await recordBiometricBinding(root, new Uint8Array([1, 2, 3, 4]));
    expect(JSON.stringify(binding.data)).not.toContain('01020304');
    const disclosures = await Promise.all([name, dob, doc].map((c) => openClaim(c.data, key)));
    const att = await attestClaims({ issuerPrivateKey: issuer.privateKey, issuerAddress: issuer.address, subjectRoot: root, subjectAddress: holder.address, disclosures, level: 'IAL2', method: 'document+webauthn-liveness', bindingTxId: binding.txId });
    const box = await generateBoxKeyPair();
    const req = requestDisclosure({ holderRoot: root, verifierAddress: verifier.address, holderAddress: holder.address, claimTypes: ['name', 'birthdate'], purpose: 'age check', verifierBoxKey: box.publicKey });
    // Disclosing a claim that was not asked for is refused.
    await expect(answerDisclosure({ holderRoot: root, holderPrivateKey: holder.privateKey, request: req, attestationJwt: att.data.jwt, disclosures })).rejects.toThrow(/not requested/);
    const ans = await answerDisclosure({ holderRoot: root, holderPrivateKey: holder.privateKey, request: req, attestationJwt: att.data.jwt, disclosures: disclosures.slice(0, 2) });
    expect(JSON.stringify(ans)).not.toContain('Ada');
    const v = await verifyDisclosure(ans, req, box.privateKey, [att]);
    expect(v).toEqual(expect.objectContaining({ state: 'verified', holderMatches: true, anchor: 'unchecked', claims: { name: 'Ada Lovelace', birthdate: '1815-12-10' } }));
    expect(v.evidence).toEqual({ level: 'IAL2', method: 'document+webauthn-liveness', bindingTxId: binding.txId });
    expect(v.claims).not.toHaveProperty('passportNumber');
    // The issuer revokes: the same presentation now reads revoked.
    const rev = await revokeAttestation(issuer.privateKey, issuer.address, root, att.data.attestationId, 'document reported stolen');
    expect((await verifyDisclosure(ans, req, box.privateKey, [att, rev])).state).toBe('revoked');
    // A revocation signed by someone else is ignored.
    const fake = { ...(await revokeAttestation(verifier.privateKey, verifier.address, root, att.data.attestationId, 'x')), data: { ...(await revokeAttestation(verifier.privateKey, verifier.address, root, att.data.attestationId, 'x')).data, issuerAddress: issuer.address } };
    expect((await verifyDisclosure(ans, req, box.privateKey, [att, fake])).state).toBe('verified');
  });

  it('presentations are bound to nonce and audience, and to the holder key', async () => {
    const holder = w(); const issuer = w(); const thief = w();
    const d = await makeDisclosure('name', 'Ada');
    const jwt = await issueSdJwt({ issuerPrivateKey: issuer.privateKey, issuerAddress: issuer.address, subjectAddress: holder.address, digests: [d.digest], evidence: { level: 'IAL1', method: 'email' } });
    const p = await presentSdJwt(jwt, [d.encoded], holder.privateKey, 'aud-1', 'n-1');
    expect((await verifyPresentation(p, { aud: 'aud-1', nonce: 'n-1' })).state).toBe('verified');
    expect((await verifyPresentation(p, { aud: 'aud-1', nonce: 'n-2' })).state).toBe('nonce-mismatch');
    expect((await verifyPresentation(p, { aud: 'aud-2', nonce: 'n-1' })).state).toBe('nonce-mismatch');
    expect((await verifyPresentation(await presentSdJwt(jwt, [d.encoded], thief.privateKey, 'aud-1', 'n-1'), { aud: 'aud-1', nonce: 'n-1' })).state).toBe('bad-key-binding');
    const other = await makeDisclosure('name', 'Mallory');
    expect((await verifyPresentation(await presentSdJwt(jwt, [other.encoded], holder.privateKey, 'aud-1', 'n-1'), { aud: 'aud-1', nonce: 'n-1' })).state).toBe('digest-mismatch');
    const tampered = p.replace(/^([^.]+)\.([^.]+)/, (_m, h, b) => `${h}.${b}x`);
    expect((await verifyPresentation(tampered, { aud: 'aud-1', nonce: 'n-1' })).state).toMatch(/bad-issuer-signature|malformed/);
  });

  it('self-asserted claims verify as self-asserted, never as verified', async () => {
    const holder = w(); const key = await newContentKey();
    const c = await recordClaim(root, 'email', 'ada@example.com', key);
    const enc = await openClaim(c.data, key);
    const att = await selfAttest({ holderPrivateKey: holder.privateKey, holderAddress: holder.address, holderRoot: root, disclosures: [enc] });
    const p = await presentSdJwt(att.data.jwt, [enc], holder.privateKey, 'a', 'n');
    expect((await verifyPresentation(p, { aud: 'a', nonce: 'n' })).state).toBe('self-asserted');
  });

  it('ES256K JWS is standard: Node verifies the issuer signature with the wallet key', async () => {
    const k = w();
    const jwt = await signJwt({ typ: 'JWT' }, { hello: 'world' }, k.privateKey);
    const [h, b, s] = jwt.split('.');
    const pt = secp.Point.fromBytes(k.publicKey).toBytes(false);
    const pub = createPublicKey({ key: { kty: 'EC', crv: 'secp256k1', x: Buffer.from(pt.slice(1, 33)).toString('base64url'), y: Buffer.from(pt.slice(33)).toString('base64url') }, format: 'jwk' });
    expect(nodeVerify('sha256', Buffer.from(`${h}.${b}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256K' });
    expect(didKeyFor('secp256k1', k.address)).toMatch(/^did:key:zQ3s/);
  });

  it('replay: amendments apply only to the version they name; revocation is a state; replies answer only held requests', async () => {
    const key = await newContentKey(); const box = await generateBoxKeyPair(); const a = w(); const b = w();
    const c1 = await recordClaim(root, 'address', 'Old Street 1', key);
    const c2 = await recordClaim(root, 'address', 'New Street 2', key, { claimId: c1.data.claimId, txId: c1.txId });
    const stray = await recordClaim(root, 'address', 'Stray', key, { claimId: c1.data.claimId, txId: 'not-the-head' });
    const req = requestDisclosure({ holderRoot: root, verifierAddress: a.address, holderAddress: b.address, claimTypes: ['address'], purpose: 'delivery', verifierBoxKey: box.publicKey });
    const no = declineDisclosure(root, req, 'not now');
    const orphan = declineDisclosure(root, { ...req, data: { ...req.data, requestId: 'unknown' } }, 'x');
    let view = await replayIdentity([c1, c2, stray, req, no, orphan] as unknown as IdentityTx[]);
    expect(view.claims).toHaveLength(1);
    expect(view.claims[0]).toEqual(expect.objectContaining({ state: 'amended', txId: c2.txId }));
    expect(view.disclosures).toEqual([expect.objectContaining({ requestId: req.data.requestId, state: 'declined', because: no.txId })]);
    const r = revokeClaim(root, c2.data, 'moved');
    view = await replayIdentity([c1, c2, r] as unknown as IdentityTx[]);
    expect(view.claims[0].state).toBe('revoked');
  });

  it('every identity event is MDM-declared', () => {
    for (const e of IDENTITY_EVENT_TYPES) expect(getEventTxRegistryEntry(e), e).toBeTruthy();
    for (const e of ['KeyDeclared', 'KeyDeclarationRevoked', 'KeyDelegated']) expect(getEventTxRegistryEntry(e), e).toBeTruthy();
  });
});
