# Post-quantum protection in the CAPPZ SDK

A large enough quantum computer running Shor's algorithm recovers a private key from its public key, for RSA and for every elliptic curve the SDK uses (secp256k1, Ed25519, P-256, X25519). Research keeps lowering the cost: Chevignard, Fouque and Schrottenloher (CRYPTO 2025) estimate about 1,730 logical qubits for RSA-2048, down from about 4,000. No such machine exists yet. Two things matter now:

- **Harvest now, decrypt later.** Encrypted data recorded today can be decrypted once the machine exists. Encryption has to change before then.
- **Forgery later.** Signatures can only be forged once the machine exists. They need a migration path that is in place before then.

Symmetric cryptography (AES-256, SHA-256, HKDF, HMAC) loses only half its bits to a quantum search and stays at 128-bit strength.

## What 16.2.0 changes

### Encryption: hybrid P-256 / X25519 + ML-KEM-768

| Where | Before | 16.2.0 |
|---|---|---|
| Sealed box (`sealTo` / `openWith`, `sealBytesTo` / `openBytesWith`) | ECDH P-256 → AES-256-GCM | P-256 ECDH **and** ML-KEM-768 (FIPS 203) → HKDF-SHA-256 → AES-256-GCM, when the recipient key has an ML-KEM half |
| Box keys (`generateBoxKeyPair`) | P-256 | P-256 + ML-KEM-768 (`{ classic: true }` for P-256 only) |
| Shared wallet records (`sealForRecipients`) | P-256 recipients | P-256 or hybrid recipients (`p256+ml-kem-768` declarations) |
| Peer channel (`openSecureChannel`) | X25519 → HKDF → AES-GCM | X25519 **and** an ML-KEM-768 encapsulation → HKDF, recorded as `channelSuite` on `SyncSessionOpened` |
| Marketplace party keys (`cappz-market`) | P-256 | Upgraded in place on the next run; `profile` publishes the hybrid key |

Both secrets feed the key derivation, bound to the ephemeral key, the KEM ciphertext and the recipient's keys. Recorded ciphertext stays closed unless **both** P-256 and ML-KEM-768 are broken.

Nothing breaks:
- Every box records its scheme, so old boxes still open.
- `upgradeBoxKeyPair` adds the ML-KEM half without changing the P-256 half, so anything sealed to the old key still opens with the upgraded one.
- A recipient that only publishes a P-256 key still gets a classical box.

Mesh devices stay P-256 by default (`provisionMeshDevice({ postQuantum: true })` to opt in). A hybrid box adds the 1,088-byte KEM ciphertext to every message, which matters on BLE and LoRa.

### Do not derive post-quantum secrets from a wallet's private key

A CAPPZ wallet's address **is** its compressed secp256k1 public key, so a quantum computer recovers the private key from public data, along with everything derived from it. 16.2.0 therefore derives post-quantum secrets from the recovery phrase:

- `keyPairFromPhrase` returns `pqSeed`, an HKDF of the BIP-39 seed. The private key is a one-way hash of that seed, so the seed cannot be recovered from the private key.
- `walletEncryptionKey(privateKey, { pqSeed })` is hybrid only when given `pqSeed`. Without it the key is P-256 only.
- `channelKeyFromWalletSecret(secret, pqSeed)` follows the same rule.
- `pqKeyFromSeed(recoverySeed)` derives the ML-DSA anchor below.

Only declare a hybrid encryption key where every unlock path restores `pqSeed`. Otherwise the wallet cannot open what is sealed to it.

Symmetric keys derived from a wallet private key, such as `sealForWallet` (`cw1.`) and session keys, inherit the same weakness for a wallet whose address is public. Moving them to `pqSeed` changes what is stored. That is the next step, and it needs its own migration.

### Key trust: a post-quantum anchor for KeyZ declarations (ML-DSA-65)

Key declarations are signed by the wallet's secp256k1 key, which is the first thing a quantum computer would forge. A wallet can now declare an **anchor**: an ML-DSA-65 key (FIPS 204) with purpose `pq-anchor`. The anchor is signed by the wallet and by the anchor key itself. From then on the wallet is anchored:

- **Co-signatures required.** A declaration counts only if the anchor co-signs it (`pqCosign`). Without that co-signature, `evaluateKey` returns `pq-unsigned`. The co-signature sits outside the classically signed text, so existing declarations are co-signed in place and keep their hash.
- **Revoking the anchor.** Only the anchor's own signature can revoke it. A forged classical revocation is ignored.
- **Rotating the anchor.** A later anchor counts only when the current one endorses it (`declarePqAnchor(..., { rotateFrom })`).
- **Rival anchors.** Two root anchors that do not endorse each other are reported as `pq-conflict` and fail closed. This is how a broken classical key shows up. Issue times are self-asserted, so a verifier can pin the anchor it first saw (`pinnedPqAnchors`).
- **Posture is reported.** `KeyTrust.postQuantum` is `hybrid`, `classical-only` (short Ed25519 delegations) or `unanchored`.

Declare the anchor **now**, while the wallet's classical signature can still be trusted. Derive it from the recovery seed with `pqKeyFromSeed`, or keep it offline.

X.509 certificates stay a projection of declarations, never the trust root. A certificate made from a declaration keeps whatever format its consumer accepts, and CAPPZ verifiers check the declaration and its anchor. Public HTTPS keeps a public-CA certificate. Browsers already negotiate post-quantum TLS key exchange (X25519MLKEM768) where the server supports it.

### XRP Ledger accounts: exposure, rotation, quickSweep

The ledger's own signatures are classical, and that changes only with a ledger amendment. What an account owner controls is how long a key stays exposed. An XRPL address is a hash of a public key, and the public key appears only when the key signs. `keyExposure` (in `@cappz/sdk/marketplace`) reads an account's history and reports:

- **Master key:** `never-signed`, `exposed`, `exposed-disabled` or `unknown` (the history was not read in full; never reported as safe).
- **Regular key:** the same states, plus how many days it has been exposed.
- **Posture:** `unexposed`, `rotating`, `stale-exposure`, `master-exposed`, `multisig` or `unknown`.

Fixes, returned unsigned for the owner's own signer:
- **`rotationTransaction` and `regularKeyFor`.** Move signing to a fresh regular key with SetRegularKey; the address, balances and trust lines stay. Regular keys come from a private root secret by HMAC, one index per rotation, so breaking one reveals neither the root nor the next key.
- **`disableMasterTransaction`.** Turn off an exposed master key, once the regular key has signed successfully.
- **`quickSweepTransaction`.** Move everything above reserve plus a buffer to a vault whose keys never signed. It is refused for a vault that is exposed or whose history was not read in full.

Nesting keys inside keys does not multiply an attacker's work: Shor attacks whichever key is exposed, directly. What helps is:
- keys whose public key was never published;
- short exposure windows;
- several independent signatures (multisig, the Vault Guard);
- hardened derivation (never publish an extended public key).

The CAPPZ edge node sells the check as a paid agent: `key-exposure` (`packages/cappz-edge-node/agents/docs/key-exposure.SKILL.md`).
