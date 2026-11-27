/**
 * @cappz/sdk/sealed — sealed shared storage (16.5.0): a group of wallets shares objects only its members can
 * open; hosts (e.g. a CAPPZ edge node's sealed-store agent) keep ciphertext only. Also the key pieces a member
 * needs: its wallet's encryption key, the declaration that publishes it, and revocation.
 */
export * from '../lib/sealed/sealedStore';
export { walletEncryptionKey, type EnvelopeRecipient } from '../lib/crypto/walletEnvelope';
export { declareKey, revokeKeyDeclaration, evaluateKey, type KeyDeclaration, type KeyRevocation, type KeyEvidence } from '../lib/identity/keyDeclaration';
