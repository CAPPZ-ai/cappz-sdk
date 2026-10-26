/** Edge and legacy (v15-09-00, v15-10-00): verification at the reverse proxy, DMZ quarantine, legacy drop / FTPS / LDAP faces, FTP client plan. */
export { createVerifyGateway, signRequest, requestSigner, signContentHash, contentDigestHeader, checkContentDigest, signatureBase, SIGNED_COMPONENTS } from '../lib/identity/edgeVerify';
export type { VerifyGateway, GatewayOptions, EvidenceSource, EdgeVerdict, SignatureState, ContentState, AnchorState, GatewayTrust } from '../lib/identity/edgeVerify';
export { intakeQuarantined, operatorDecision, replayQuarantine, sniffType, DEFAULT_QUARANTINE_POLICY, DMZ_EVENT_TYPES } from '../lib/sync/quarantine';
export type { QuarantinePolicy, QuarantineEntry, QuarantineSource, QuarantineState, CheckName, CheckResult } from '../lib/sync/quarantine';
export { createLegacyGateway, memoryQuarantineStore } from '../lib/sync/transports/legacyGateway';
export type { QuarantineStore, LegacyGatewayOptions } from '../lib/sync/transports/legacyGateway';
export { checkSource, curlPlan, parseListing, planPull, recordableRemote } from '../lib/sync/transports/legacyPull';
export type { LegacyPullSource } from '../lib/sync/transports/legacyPull';
export { createFtpSession, safeFtpName } from '../lib/sync/transports/ftpServer';
export type { FtpAccount, FtpIo, FtpSessionOptions } from '../lib/sync/transports/ftpServer';
export { answerLdap, ldapClient, directoryEntries, splitMessages } from '../lib/sync/ldapDirectory';
export { projectDirectory, UNPLACED_PARENT } from '../lib/sync/directoryView';
export type { DirectoryRow, OntologyEdgeLike } from '../lib/sync/directoryView';
// v15-11-00 — retire a legacy verifier on evidence: shadow comparison with a retire gate; hardening helpers.
export { createShadowComparison, readLegacyVerdict, denialReason, quantile, DEFAULT_RETIRE_POLICY } from '../lib/identity/shadowCompare';
export type { ShadowReport, ShadowState, RetirePolicy, LegacyVerdict, Agreement, CostAssumptions } from '../lib/identity/shadowCompare';
export { readBounded, isDeclarationShape } from '../lib/identity/edgeVerify';
export { createReloader } from '../lib/identity/evidenceReload';
