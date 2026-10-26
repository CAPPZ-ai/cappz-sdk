/** Identity and trust (v15-09-00, v15-10-00): identity vault, SD-JWT VC, did:key, key declarations, X.509 projection. */
// Holder / issuer / verifier: claims as salted digests + ciphertext, attestations, sealed nonce-bound disclosure.
export { recordClaim, revokeClaim, openClaim, recordBiometricBinding, attestClaims, selfAttest, revokeAttestation, revokedAttestationIds, requestDisclosure, answerDisclosure, declineDisclosure, verifyDisclosure, replayIdentity, IDENTITY_EVENT_TYPES } from '../lib/identity/identityVault';
export type { IdentityTx, ClaimData, AttestationData, DisclosureRequestData, DisclosedData, DisclosureVerdict, IdentityView, ClaimState, DisclosureState } from '../lib/identity/identityVault';
// Standard formats: IETF SD-JWT (VC shape), JOSE ES256K, did:key.
export { makeDisclosure, decodeDisclosure, issueSdJwt, presentSdJwt, verifyPresentation, signJwt, verifyJwt, attestationIdOf, SD_JWT_VC_TYP, CAPPZ_IDENTITY_VCT } from '../lib/identity/sdJwt';
export type { EvidenceLevel, PresentationState, PresentationResult } from '../lib/identity/sdJwt';
export { didKeyFor, parseDidKey } from '../lib/identity/didKey';
// Trust without a CA: wallet-signed declarations, replayed revocations, short delegations.
export { declareKey, verifyKeyDeclaration, revokeKeyDeclaration, verifyKeyRevocation, delegateKey, verifyKeyDelegation, evaluateKey, declaredKeysFor, withoutRevokedKeys, asKeyDeclaration, declarationHash, KEY_DECLARATION_TTL_MS, KEY_DELEGATION_MAX_TTL_MS } from '../lib/identity/keyDeclaration';
export type { KeyDeclaration, KeyRevocation, KeyDelegation, KeyPurpose, KeyAlgorithm, KeyTrust, KeyTrustState, KeyEvidence } from '../lib/identity/keyDeclaration';
// X.509 as a projection of a declaration (mTLS, QUIC, WebTransport, enterprise clients).
export { issueSelfSignedCertificate, parseCertificate, verifySelfSignature, certificateBindings, toPem, fromPem, KEYDECL_URI_PREFIX } from '../lib/identity/x509';
export type { CertificateRequest, IssuedCertificate, ParsedCertificate } from '../lib/identity/x509';
// The whole flow, end to end, in one call (the tutorial runs it in the browser).
export { runIdentityTrustDemo } from '../lib/identity/identityTrustDemo';
export type { DemoStep, DemoReport } from '../lib/identity/identityTrustDemo';
// What a holder, issuer or verifier needs alongside: wallet keys (memory only) and sealing keys / content keys.
export { keyPairFromPhrase, generateRecoveryPhrase } from '../lib/auth/wallet/session';
export type { WalletKeyPair } from '../lib/auth/wallet/session';
export { generateBoxKeyPair, newContentKey, sealTo, openWith } from '../lib/crypto/sealedBox';
// v15-11-00 — CAPPZ key declarations vs X.509, measured (revocation window, CPU per check, cost per million, tradeoffs).
export { runTrustComparison, exposureRows, buildPki, signCrl, verifyX509, TRADEOFFS, DEFAULT_COMPARISON_ASSUMPTIONS, ASSUMPTION_LABELS } from '../lib/identity/trustComparison';
export type { ComparisonReport, ComparisonAssumptions, ExposureRow, LatencyRow, CostRow, Tradeoff, X509Verdict } from '../lib/identity/trustComparison';
export { issueCertificate, verifySignedBy } from '../lib/identity/x509';
