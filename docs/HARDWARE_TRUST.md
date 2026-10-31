# Hardware-backed keys and notarization

15.16.0 puts CAPPZ keys in the secure hardware devices already have, and makes notarization cheaper to anchor and easier to trust. Four pieces:

| | What | Module |
|---|---|---|
| 1 | Wallet keys wrapped by a passkey | `src/lib/identity/passkeyVault.ts` |
| 2 | Notarization receipts signed by an enrolled device | `src/lib/crypto/notaryDeviceSignature.ts` |
| 3 | Batch notarization: many files, one ledger anchor | `src/lib/crypto/notaryBatch.ts` |
| 4 | Attestation: proof that a passkey lives in a vendor's secure hardware | `src/lib/identity/webauthnAttestation.ts` |

Signature verification on native kernels (secp256k1 and Ed25519) is covered in [NATIVE_KERNELS.md](NATIVE_KERNELS.md#signature-verification-15160).

## Where the hardware is, and how an app reaches it

Secure hardware protects **keys**. It does not make hashing or verification faster or safer: those work on public data, and the secure world runs the same CPU instructions with extra switching cost. Apps cannot issue Secure Monitor Calls or load code into TrustZone; Qualcomm's secure world only runs code signed by the device maker. The supported routes:

| Platform | Route | Keys |
|---|---|---|
| Any browser | WebAuthn passkeys; the PRF extension for hardware-derived secrets | P-256 |
| Android | Keystore, in the TEE (on Qualcomm, TrustZone) or a StrongBox secure element | P-256; Ed25519 from Android 13 |
| iPhone, iPad, Mac | Secure Enclave via CryptoKit | P-256 |
| Windows | TPM, through Windows Hello | P-256, RSA |

XRPL signs with secp256k1 or Ed25519 only. That is why the hardware key does not sign ledger transactions directly: it unlocks the wallet key (1) and signs CAPPZ's own records (2).

## 1. Passkey-wrapped wallet keys

```ts
import { enrolPasskey, wrapWithPasskey, unwrapWithPasskey } from '@cappz/sdk/lib/identity/passkeyVault';
import { browserWebAuthn } from '@cappz/sdk/lib/identity/webauthn';

const webauthn = browserWebAuthn()!;
const passkey = await enrolPasskey(webauthn, { rpId: 'cappz.ai', rpName: 'CAPPZ', userId, userName: walletAddress });
if (!passkey.prfSupported) { /* keep the passcode vault on this device */ }
const wrap = await wrapWithPasskey(walletPrivateKey, passkey, walletAddress, webauthn); // store `wrap`
// later, one fingerprint / face / PIN prompt:
const opened = await unwrapWithPasskey([wrap], webauthn); // { secret, credentialId } | null
```

- The authenticator computes the PRF output with a secret that never leaves it, and only after user verification. HKDF-SHA-256 turns it into a non-extractable AES-256-GCM key; the wallet address and credential are bound as associated data, so a record moved to another wallet does not open.
- Stored: credential id, a random 32-byte PRF salt, IV and ciphertext. No server holds anything that decrypts it.
- Several passkeys (phone, laptop) can wrap the same key; `unwrapWithPasskey` asks once for whichever is present (`evalByCredential`).
- `enrolPasskey` reports `prfSupported`. Where the browser or authenticator lacks PRF, keep the passcode vault.

## 2. Device-signed notarization receipts

A receipt already proves which wallet anchored a leaf. A device signature adds which enrolled device made it and, with a passkey, that a person unlocked it.

- `notaryStatement(receipt)` is the canonical text signed: leaf, salt, anchoring account, timestamp, plus root and index for batch receipts.
- `signNotaryStatementWithPasskey` signs through WebAuthn with the statement hash as the challenge (`webauthn-es256`). `signNotaryStatement` takes any P-256 signer (`p256`): a native shell's Secure Enclave or StrongBox key, or a non-extractable WebCrypto key (software-protected, not hardware).
- The wallet vouches for the device key with a KeyZ declaration: purpose `signing`, algorithm `p256`. Either point encoding (compressed or not) matches.
- `verifyNotaryDeviceSignature` works offline and returns a state: `trusted`, `untrusted-key` (with the KeyZ answer: `undeclared`, `revoked`, `expired`, `wrong-purpose`), `bad-signature`, or the passkey failure (`wrong-origin`, `wrong-challenge`, `wrong-rp`, `user-not-verified`). Pass the web origins a passkey may sign from.

## 3. Batch notarization

One ledger transaction anchors a whole batch:

- `buildNotaryBatch(leaves)` returns the root and one inclusion proof per leaf. The tree is RFC 9162 (Certificate Transparency v2): leaf node SHA-256(0x00 ‖ leaf), inner node SHA-256(0x01 ‖ left ‖ right), split at the largest power of two, never duplicating a node. The reference used in tests reproduces the certificate-transparency vectors.
- The anchor is an XRPL transaction with memo type `cappz.notary.batch.v1` carrying `{ version: 'cappz-notary-batch-1.0', alg, tree: 'rfc9162', root, count }`, and `InvoiceID` = root.
- Each file's receipt carries its leaf, salt, `index`, `count` and `path`.
- `verifyClient({ txId, expectedLeaf, inclusion })` reads the anchor and checks the proof. The anchor must state `count`: inside one subtree an RFC 9162 path does not commit to the tree size (index 6 of 13 and of 14 share a path), so the size is bound by the anchor, as a CT signed tree head binds it. An anchor without a count verifies nothing.

Cost: one transaction (and one fee) per batch instead of per file. Building the root and every proof for 1,000 files took 43 ms; verifying all 1,000 proofs took 51 ms.

## 4. Attestation

`verifyRegistration(response, expectations)` checks a passkey registration, WebAuthn Level 3 §8, for the formats `none`, `packed` (full and self), `apple`, `android-key` and `tpm`. It returns two separate answers:

- `check`: the statement is `valid`, or what failed (`bad-signature`, `nonce-mismatch`, `key-mismatch`, `aaguid-mismatch`, `bad-certificate`, client-data and flag failures).
- `trust`: `chain` (ends at a pinned root), `unanchored` (consistent, no known root), `self` (signed by the credential key only) or `none` (no attestation).

Require `trust === 'chain'` where hardware proof matters. Synced passkeys (iCloud Keychain, Google Password Manager) usually send `none`: they are still hardware-backed on each device, but nothing proves it to a verifier.

Pinned roots (`src/lib/identity/attestationRoots.ts`) were fetched on 2026-10-31 from the vendors' own endpoints and cross-checked against an independent copy:

- Apple WebAuthn Root CA (`apple.com/certificateauthority`)
- Google hardware attestation roots (`android.googleapis.com/attestation/root`)

TPM vendor and FIDO metadata roots are not shipped. Pass them in `roots.tpm` or `roots.packed` for those chains to anchor. A trust anchor is a name and a public key (RFC 5280 §6.1.1), so a chain ending at a reissued certificate of a pinned root key anchors. Every certificate in the presented chain must still be valid at the given time.

Tested on 11 captured registrations from real authenticators (SimpleWebAuthn's suite, MIT):

| Capture | Result |
|---|---|
| Apple (Face ID / Touch ID) | valid, `chain` to the Apple root |
| Android Keystore, Pixel 8a (2025) | valid, `chain` to a Google root, TEE or StrongBox |
| Android Keystore, older device (chain ends at the 2016 copy of Google's RSA root) | valid, `chain` (same root key) |
| Android Keystore with an unknown root | never `chain` |
| Windows Hello TPM: RSA and ECC keys, SHA-1 and SHA-256 | valid, `unanchored` (no TPM roots shipped) |
| Chrome virtual authenticator (packed) | valid, `unanchored` |

Every capture is also checked against a different challenge, origin, flipped signature and altered authenticator data; all are refused.

Deno's WebCrypto does not verify ECDSA P-384 with SHA-256, which Apple's intermediate certificate uses. Apple chains therefore anchor in browsers and Node but not on Deno.

## 5. Data keys wrapped by a wallet (15.17.0)

`src/lib/crypto/walletEnvelope.ts` encrypts records so that only a wallet opens them:

- **Per-record data key.** `sealForWallet(bytes, walletPrivateKey, context)` gives each record a fresh random 256-bit data key, encrypts the record with it (AES-256-GCM), and wraps that key (AES-256-GCM) under a key derived from the wallet's private key with HKDF-SHA-256.
- **Format.** `cw1.` + base64(kekIv ‖ wrapped data key ‖ dataIv ‖ ciphertext).
- **Context binding.** `context` (purpose, wallet, scope) is both the HKDF info and the associated data of both encryptions, so a record cannot be opened as another purpose's record or under another wallet.
- **Nothing else to store.** The wrapped key travels with the record, and the recovery phrase recovers every record on any device. Wrapping per record also leaves room to grant one record to another wallet by wrapping its data key again.

This replaces keys derived from public values: an address, an address and an HD path string, an address and a file hash. Anyone could compute those. Tests confirm that a key derived from the address, another wallet, another purpose or scope, and any changed byte all fail to open a record.

## Building blocks

- `cbor.ts`: a strict CBOR decoder. It refuses indefinite lengths, tags, floats, duplicate keys, non-shortest encodings, nesting deeper than 16, and truncated or trailing input.
- `webauthn.ts`: the WebAuthn port (replaceable in tests and native shells), authenticator data, COSE keys, strict DER signatures, and assertion verification (type, challenge, origin allowlist, RP ID, UP / UV flags, ES256).
- `x509Chain.ts`: DER with high tag numbers, certificate extensions, ECDSA P-256 / P-384 / P-521, RSA PKCS#1 v1.5 and Ed25519 signatures, and path validation. SHA-1 certificate signatures are refused.
- `src/test/helpers/softAuthenticator.ts`: a software authenticator for tests. It uses real P-256 keys, real authenticator data and attestation objects, and computes PRF as the spec defines it.
