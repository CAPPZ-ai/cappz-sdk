/**
 * The identity flow with @cappz/sdk/identity — holder, issuer and verifier in one script.
 *   npx tsx identity-flow.ts      (Node 20+, Deno or Bun; runs in a browser too)
 */
import {
  keyPairFromPhrase, generateRecoveryPhrase, generateBoxKeyPair, newContentKey,
  recordClaim, openClaim, attestClaims, requestDisclosure, answerDisclosure, verifyDisclosure, runIdentityTrustDemo,
} from '@cappz/sdk/identity';

const holder = keyPairFromPhrase(generateRecoveryPhrase());
const issuer = keyPairFromPhrase(generateRecoveryPhrase());
const verifier = keyPairFromPhrase(generateRecoveryPhrase());
const root = "m/44'/144'/0'/users/me";
const contentKey = await newContentKey();              // in an app: the account's content key

// 1 · Holder keeps claims in the wallet: salted digests + ciphertext.
const claims = await Promise.all([['name', 'Ada Lovelace'], ['birthdate', '1815-12-10']].map(([t, v]) => recordClaim(root, t, v, contentKey)));
const disclosures = await Promise.all(claims.map((c) => openClaim(c.data, contentKey)));

// 2 · Issuer vouches once (SD-JWT VC, ES256K, did:key), at an evidence level.
const att = await attestClaims({ issuerPrivateKey: issuer.privateKey, issuerAddress: issuer.address, subjectRoot: root, subjectAddress: holder.address, disclosures, level: 'IAL2', method: 'document check' });

// 3 · Verifier asks; holder answers with only what was asked, sealed and nonce-bound.
const box = await generateBoxKeyPair();
const req = requestDisclosure({ holderRoot: root, verifierAddress: verifier.address, holderAddress: holder.address, claimTypes: ['birthdate'], purpose: 'age check', verifierBoxKey: box.publicKey });
const answer = await answerDisclosure({ holderRoot: root, holderPrivateKey: holder.privateKey, request: req, attestationJwt: att.data.jwt, disclosures: [disclosures[1]] });

// 4 · Verifier checks offline: state, level, claims — anchor reported separately.
console.log(await verifyDisclosure(answer, req, box.privateKey, [att]));

// Or run every step (including the refusals) and print the report:
const report = await runIdentityTrustDemo();
console.log(report.steps.map((s) => `${s.ok ? 'PASS' : 'FAIL'} ${s.title}: ${s.got}`).join('\n'));
