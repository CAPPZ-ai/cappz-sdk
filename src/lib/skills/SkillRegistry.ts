/**
 * SkillRegistry — MDM address → AgentSkill constructor mapping.
 *
 * All CAPPZ Agent Skills are registered by their canonical MDM address.
 * Skill count is driven by AGENT_SKILLS_COUNT in src/config/agentSkills.ts.
 * Resolution returns a new instance ready for configure().
 */

import type { AgentSkill } from './AgentSkill';
import type { SkillManifest } from './SkillTypes';

type SkillFactory = () => AgentSkill;

const SKILL_REGISTRY = new Map<string, SkillFactory>();

// ─── MDM Address Constants ─────────────────────────────────────
// Canonical HD addresses for all CAPPZ Agent Skills.
// Keys are stable internal identifiers — functional names/labels
// live in SkillClassification (the MDM source of truth for UI).

export const MDM_SKILLS = {
  WALLET_OPS:          "m/44'/144'/0'/cappz/skills/wallet-ops",
  NOTARIZATION:        "m/44'/144'/0'/cappz/skills/notarization",
  ESCROW:              "m/44'/144'/0'/cappz/skills/escrow",
  SUPPLY_CHAIN:        "m/44'/144'/0'/cappz/skills/supply-chain",
  PROVENANCE:          "m/44'/144'/0'/cappz/skills/provenance",
  CONTEXT_HISTORY:     "m/44'/144'/0'/cappz/skills/context-history",
  ROYALTY_FLYWHEEL:    "m/44'/144'/0'/cappz/skills/royalty-flywheel",
  WALLET_TRUSTLINE:    "m/44'/144'/0'/cappz/skills/wallet-trustline",
  CAPPZ_ACQUIRE:       "m/44'/144'/0'/cappz/skills/cappz-acquire",
  WALLET_COMPOUND:     "m/44'/144'/0'/cappz/skills/wallet-compound",
  CHAINLET_CREATE:     "m/44'/144'/0'/cappz/skills/chainlet-create",
  TREASURY_OPS:        "m/44'/144'/0'/cappz/skills/treasury-operations",
  CHAINLET_SYNC:       "m/44'/144'/0'/cappz/skills/chainlet-sync",
  STORAGE_AGENT:       "m/44'/144'/0'/cappz/skills/storage-agent",
  SECURITIES:          "m/44'/144'/0'/cappz/skills/securities",
  PRESCRIPTION:        "m/44'/144'/0'/cappz/skills/prescription",
  BTC_SWAP_INIT:       "m/44'/144'/0'/cappz/skills/btc-swap-init",
  BTC_SWAP_EXECUTE:    "m/44'/144'/0'/cappz/skills/btc-swap-execute",
  BTC_SWAP_SETTLE:     "m/44'/144'/0'/cappz/skills/btc-swap-settle",
  AGENT_ONBOARDING:    "m/44'/144'/0'/cappz/skills/agent-onboarding",
  CALENDARING:         "m/44'/144'/0'/cappz/skills/calendaring",
  FOA_GOVERNANCE:      "m/44'/144'/0'/cappz/skills/foa-governance",
  IDENTITY_REGISTRY:   "m/44'/144'/0'/cappz/skills/identity-registry",
  TRUST_SCORE:         "m/44'/144'/0'/cappz/skills/trust-score",
  PROVENANCE_SERVICE:  "m/44'/144'/0'/cappz/skills/provenance-service",
  MCP_PROTOCOL:        "m/44'/144'/0'/cappz/skills/mcp-protocol",
  FEE_TIERS:           "m/44'/144'/0'/cappz/skills/fee-tiers",
  HIBERNATION:         "m/44'/144'/0'/cappz/skills/hibernation",
  MARKET_HEALTH:       "m/44'/144'/0'/cappz/skills/market-health",
  FACTORY_ISO20022:    "m/44'/144'/0'/cappz/skills/factory-iso20022",
  FACTORY_FIX:         "m/44'/144'/0'/cappz/skills/factory-fix",
  FACTORY_FPML:        "m/44'/144'/0'/cappz/skills/factory-fpml",
  FACTORY_DERIVED:     "m/44'/144'/0'/cappz/skills/factory-derived",
  REFDATA_MGMT:        "m/44'/144'/0'/cappz/skills/refdata-mgmt",
  VALIDATION_ENGINE:   "m/44'/144'/0'/cappz/skills/validation-engine",
  DOMAIN_REGISTRY:     "m/44'/144'/0'/cappz/skills/domain-registry",
  UIUX:                "m/44'/144'/0'/cappz/skills/uiux",
  VOICE_WEBSPEECH:     "m/44'/144'/0'/cappz/skills/voice/webspeech",
  VOICE_WHISPER:       "m/44'/144'/0'/cappz/skills/voice/whisper-kokoro",
  VOICE_CHATTERBOX:    "m/44'/144'/0'/cappz/skills/voice/chatterbox",
  FACTORY_GENERIC:     "m/44'/144'/0'/cappz/skills/factory-generic",
  XSD_X_MDM:           "m/44'/144'/0'/cappz/skills/xsd-x-mdm",
  JSON_X_MDM:          "m/44'/144'/0'/cappz/skills/json-x-mdm",
  SYNC_ON_ASYNC:       "m/44'/144'/0'/cappz/skills/sync-on-async",
  MIDDLEWARE:           "m/44'/144'/0'/cappz/skills/middleware",
  MIGRATION:           "m/44'/144'/0'/cappz/skills/migration",
  GROUP_CHAT:          "m/44'/144'/0'/cappz/skills/group-chat",
  MKF:                 "m/44'/144'/0'/cappz/skills/mkf",
  MESSAGEBOX:          "m/44'/144'/0'/cappz/skills/messagebox",
  TRANSFORM_ENGINE:    "m/44'/144'/0'/cappz/skills/transform-engine",
  ONTOLOGY_ENGINE:     "m/44'/144'/0'/cappz/skills/ontology-engine",
  ACCESS_CONTROL:      "m/44'/144'/0'/cappz/skills/access-control",
  LIFECYCLE_CLONE:     "m/44'/144'/0'/cappz/skills/lifecycle-clone",
  LIFECYCLE_COPY:      "m/44'/144'/0'/cappz/skills/lifecycle-copy",
  CONTENT_SEARCH:      "m/44'/144'/0'/cappz/skills/content-search",
  DASHBOARD_UIUX:      "m/44'/144'/0'/cappz/skills/dashboard-uiux",
  COMPRESS_ENCRYPT:    "m/44'/144'/0'/cappz/skills/compress-encrypt",
  BPMN_ENGINE:         "m/44'/144'/0'/cappz/skills/bpmn-engine",
  SWIFT_ADAPTER:       "m/44'/144'/0'/cappz/skills/swift-adapter",
  EDI_ADAPTER:         "m/44'/144'/0'/cappz/skills/edi-adapter",
  HL7_ADAPTER:         "m/44'/144'/0'/cappz/skills/hl7-adapter",
  ISO20022_ADAPTER:    "m/44'/144'/0'/cappz/skills/iso20022-adapter",
  BIBLE:               "m/44'/144'/0'/cappz/skills/bible",
  CODEX:               "m/44'/144'/0'/cappz/skills/codex",
  GRAPH_VIEWER:        "m/44'/144'/0'/cappz/skills/graph-viewer",
  PORTFOLIO_ADMIN:     "m/44'/144'/0'/cappz/skills/portfolio-admin",
  TREASURER:           "m/44'/144'/0'/cappz/skills/treasurer",
  FIX_TRADER:          "m/44'/144'/0'/cappz/skills/fix-trader",
  ISDA_FPML_TRADER:    "m/44'/144'/0'/cappz/skills/isda-fpml-trader",
  ISO20022_SETTLEMENT: "m/44'/144'/0'/cappz/skills/iso20022-settlement",
  TREASURY_PORTFOLIO:  "m/44'/144'/0'/cappz/skills/treasury-portfolio",
  AL3_DOMAIN:          "m/44'/144'/0'/cappz/skills/al3-domain",
  MDM_STANDARDS_INGEST:"m/44'/144'/0'/cappz/skills/mdm-standards-ingest",
  ARCHITECTURE:        "m/44'/144'/0'/cappz/skills/architecture",
  DATA_SOURCE_ADAPTER: "m/44'/144'/0'/cappz/skills/data-source-adapter",
  INCLUDE_PROTOCOL:    "m/44'/144'/0'/cappz/skills/include-protocol",
  CLONE_AUTH:           "m/44'/144'/0'/cappz/skills/clone-auth",
  HD_SIGNAL_ROUTER:    "m/44'/144'/0'/cappz/skills/hd-signal-router",
  STRIPE_XRP_BRIDGE:   "m/44'/144'/0'/cappz/skills/stripe-xrp-bridge",
  CHARM_ADAPTER:       "m/44'/144'/0'/cappz/skills/charm-adapter",
  MEDICAL_OFFICE_OPS:  "m/44'/144'/0'/cappz/skills/medical-office-ops",
  CID_ADMIN:           "m/44'/144'/0'/cappz/skills/cid-admin",
  LEGACY_ARCHIVE:      "m/44'/144'/0'/cappz/skills/legacy-archive",
  CID_ARTIFACT:        "m/44'/144'/0'/cappz/skills/cid-artifact",
  RAP_ADAPTER:         "m/44'/144'/0'/cappz/skills/rap-adapter",
  DISCOVERY_AGENT:     "m/44'/144'/0'/cappz/skills/discovery-agent",
  NAG_HAMMADI:         "m/44'/144'/0'/cappz/skills/nag-hammadi",
  CORPUS_LICENSE:      "m/44'/144'/0'/cappz/skills/corpus-license",
  MEDICAL_OFFICE_OPS_2:"m/44'/144'/0'/cappz/skills/medical-office-ops-2",
  CODEX_LIBRARY:       "m/44'/144'/0'/cappz/skills/codex-library",
  QUMRAN:              "m/44'/144'/0'/cappz/skills/qumran",
  PESHITTA:            "m/44'/144'/0'/cappz/skills/peshitta",
  WLC:                 "m/44'/144'/0'/cappz/skills/wlc",
  NESTLE_1904:         "m/44'/144'/0'/cappz/skills/nestle-1904",
  DUAL_MODE_INFERENCE: "m/44'/144'/0'/cappz/skills/dual-mode-inference",
  DISCOVERY_SERVICE:   "m/44'/144'/0'/cappz/skills/discovery-service",
  VULGATE:             "m/44'/144'/0'/cappz/skills/vulgate",
  KJV:                 "m/44'/144'/0'/cappz/skills/kjv",
  BUILD_LOG:           "m/44'/144'/0'/cappz/skills/build-log",
  A2A_SYNC_RECEIVER:   "m/44'/144'/0'/cappz/skills/a2a-sync-receiver",
  A2A_SYNC_TRANSMITTER:"m/44'/144'/0'/cappz/skills/a2a-sync-transmitter",
  A2A_SYNC_TRANSCEIVER:"m/44'/144'/0'/cappz/skills/a2a-sync-transceiver",
  INQUIRY_FEEDBACK: "m/44'/144'/0'/cappz/skills/inquiry-feedback",
} as const;


// ─── MDM Skill Aliases (Non-Breaking Rename) ──────────────────
// Correct functional names → existing MDM_SKILLS keys.
// Old names continue to work. New code should use the alias.

export const MDM_SKILL_ALIASES = {
  // Functional name → existing key reference
  CORE_WALLET:           MDM_SKILLS.WALLET_OPS,
  A2A_SECURE_COMMS:      MDM_SKILLS.ESCROW,
  VERSION_CONTROL:       MDM_SKILLS.SUPPLY_CHAIN,
  SELF_SYNC_CONTENT:     MDM_SKILLS.CONTEXT_HISTORY,
  REPOZ:                 MDM_SKILLS.CAPPZ_ACQUIRE,
  POOLS_MARKETPLACE:     MDM_SKILLS.WALLET_COMPOUND,
  PROJECT_AS_FUND:       MDM_SKILLS.CHAINLET_SYNC,
  BTC_TX_BRIDGE:         MDM_SKILLS.BTC_SWAP_INIT,
  OTC_LIFECYCLE:         MDM_SKILLS.PRESCRIPTION,
  RX_MANAGEMENT:         MDM_SKILLS.PRESCRIPTION,
  KNOWLEDGE_FACTORY:     MDM_SKILLS.MKF,
  BIBLE_CODEX:           MDM_SKILLS.BIBLE,
  CODEX_ORCHESTRATOR:    MDM_SKILLS.CODEX,
  USER_LIBRARY:          MDM_SKILLS.CODEX_LIBRARY,
  PRINCIPLES:            MDM_SKILLS.ARCHITECTURE,
} as const;


/**
 * Resolve an MDM address with deprecation warning for old names.
 * Use in dev mode to guide migration to canonical aliases.
 */
export function resolveWithAlias(aliasOrAddress: string): string {
  const aliasEntries = Object.entries(MDM_SKILL_ALIASES) as [string, string][];
  const found = aliasEntries.find(([, addr]) => addr === aliasOrAddress);
  if (found && (import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
    // Only warn if the caller used an old MDM_SKILLS key name
    const mdmEntries = Object.entries(MDM_SKILLS) as [string, string][];
    const oldKey = mdmEntries.find(([, addr]) => addr === aliasOrAddress);
    if (oldKey && found[0] !== oldKey[0]) {
      console.debug(`[MDM Alias] Consider using MDM_SKILL_ALIASES.${found[0]} instead of MDM_SKILLS.${oldKey[0]}`);
    }
  }
  return aliasOrAddress;
}

// ─── Bible Codex Identity Predicate ───────────────────────────
// AP-22: skills are identified by HD address, never by ordinal numbers.
// Re-export of the canonical Bible Codex template MDM root for use as
// the single source-of-truth identity check across UCL/library code.

export const BIBLE_CODEX_TEMPLATE_MDM = MDM_SKILLS.BIBLE;

/**
 * isBibleCodexCanon — Single identity predicate for the Bible Codex.
 * A canon entry IS the Bible Codex iff its `clonedFrom` (or
 * `skillMdmAddress`) matches the canonical template MDM root.
 *
 * Never use `skillNumber === 56` for identity decisions — display only.
 */
export function isBibleCodexCanon(c: {
  clonedFrom?: string;
  skillMdmAddress?: string;
}): boolean {
  return (
    c.clonedFrom === BIBLE_CODEX_TEMPLATE_MDM ||
    c.skillMdmAddress === BIBLE_CODEX_TEMPLATE_MDM
  );
}

/** Default skills attached to every new WalletAgent */
export const DEFAULT_SKILLS: string[] = [
  MDM_SKILLS.WALLET_OPS,
  MDM_SKILLS.NOTARIZATION,
  MDM_SKILLS.ROYALTY_FLYWHEEL,
  MDM_SKILLS.CONTEXT_HISTORY,
  MDM_SKILLS.PROVENANCE,
  MDM_SKILLS.IDENTITY_REGISTRY,
  MDM_SKILLS.UIUX,
  MDM_SKILLS.VOICE_WEBSPEECH,
  MDM_SKILLS.BPMN_ENGINE,
  MDM_SKILLS.MESSAGEBOX,
  MDM_SKILLS.MIDDLEWARE,
  MDM_SKILLS.GRAPH_VIEWER,
  MDM_SKILLS.ARCHITECTURE,
  MDM_SKILLS.INCLUDE_PROTOCOL,
  MDM_SKILLS.CLONE_AUTH,
  MDM_SKILLS.HD_SIGNAL_ROUTER,
  MDM_SKILLS.STRIPE_XRP_BRIDGE,
  MDM_SKILLS.RAP_ADAPTER,
];

// ─── Registration ──────────────────────────────────────────────

export function registerSkill(mdmAddress: string, factory: SkillFactory): void {
  SKILL_REGISTRY.set(mdmAddress, factory);
}

/** Return every MDM address currently registered in-process. */
export function getRegisteredSkillAddresses(): string[] {
  return Array.from(SKILL_REGISTRY.keys());
}

// ─── Resolution ────────────────────────────────────────────────

export function resolveSkill(mdmAddress: string): AgentSkill | null {
  const factory = SKILL_REGISTRY.get(mdmAddress);
  if (!factory) return null;
  return factory();
}

/**
 * List all registered skills with their manifests.
 */
export function listAvailableSkills(): SkillManifest[] {
  const manifests: SkillManifest[] = [];
  for (const [, factory] of SKILL_REGISTRY) {
    try {
      const skill = factory();
      manifests.push(skill.getManifest());
    } catch {
      // Skip skills that fail to instantiate
    }
  }
  return manifests;
}

/**
 * Check if a skill is registered.
 */
export function isSkillRegistered(mdmAddress: string): boolean {
  return SKILL_REGISTRY.has(mdmAddress);
}

/**
 * Get count of registered skills.
 */
export function getRegisteredSkillCount(): number {
  return SKILL_REGISTRY.size;
}
