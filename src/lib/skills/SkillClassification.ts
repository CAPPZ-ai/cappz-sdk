/**
 * SkillClassification — genesis seed for the notarized skill ontology.
 *
 * AP-12 / AX-73: Runtime status and catalog reads MUST come from the
 * notarized skill graph (`brokerSkillGraph` / `useSkillOntology`), which
 * derives everything from event TXs — NOT from this array. This file is
 * consumed only by:
 *   - `genesisNotarizeSkillOntology()` — one-shot emitter that writes
 *     AgentSkillRegistrationCreated + AgentSkillActivated (and #76
 *     AgentSkillArchived) for every entry below.
 *   - `walkSkillOntology()` — as a seed for name/description/endpoints
 *     until on-chain `SkillMetadataUpdated` overrides land.
 *
 * `skillNumber` is a stable identifier — gaps are expected because
 * retirements are recorded via AgentSkillArchived, not code deletions.
 *
 * MDM Address: m/44'/144'/0'/cappz/agency/skills/classification
 */

import { MDM_SKILLS } from './SkillRegistry';

// ─── Skill Utility Types ───────────────────────────────────────
// Core artifacts every skill may produce → MDM.codex.cappz.refdata.skill[].utility[]

export type SkillUtilityCode = 'bpmn' | 'validation' | 'schema' | 'pipeline';

export interface SkillUtilityDef {
  code: SkillUtilityCode;
  label: string;
  description: string;
  /** MDM address for the utility refdata */
  mdmAddress: string;
  /** Badge color token */
  colorToken: string;
  /** Short badge label */
  badge: string;
}

/** Canonical utility definitions — MDM.codex.cappz.refdata.skill.utility[] */
export const SKILL_UTILITY_DEFS: Record<SkillUtilityCode, SkillUtilityDef> = {
  bpmn: {
    code: 'bpmn',
    label: 'BPMN Process Definition',
    description: 'Agentic workflow contract — executable BPMN 2.0 with HD-addressed tasks and gateways',
    mdmAddress: "m/44'/144'/0'/cappz/codex/refdata/skill/utility/bpmn",
    colorToken: 'success',
    badge: 'BPMN',
  },
  validation: {
    code: 'validation',
    label: 'Validation Rules',
    description: 'TX-as-Triple validation rules — JSONLogic or schema-driven constraints',
    mdmAddress: "m/44'/144'/0'/cappz/codex/refdata/skill/utility/validation",
    colorToken: 'warning',
    badge: 'VAL',
  },
  schema: {
    code: 'schema',
    label: 'Message Schemas',
    description: 'Structured message schemas — XSD, JSON Schema, or FpML product definitions',
    mdmAddress: "m/44'/144'/0'/cappz/codex/refdata/skill/utility/schema",
    colorToken: 'info',
    badge: 'SCH',
  },
  pipeline: {
    code: 'pipeline',
    label: 'Pipeline Config',
    description: 'MessageBox pipeline stage configuration — receive/process/send phase definitions',
    mdmAddress: "m/44'/144'/0'/cappz/codex/refdata/skill/utility/pipeline",
    colorToken: 'primary',
    badge: 'PIPE',
  },
};

// ─── MDM Classification Addresses ──────────────────────────────

export const MDM_CLASSIFICATION = {
  ROOT:           "m/44'/144'/0'/cappz/agency/skills/classification",
  INFRASTRUCTURE: "m/44'/144'/0'/cappz/agency/skills/classification/infrastructure",
  FINANCIAL:      "m/44'/144'/0'/cappz/agency/skills/classification/financial",
  HEALTHCARE:     "m/44'/144'/0'/cappz/agency/skills/classification/healthcare",
  /** Skill utility refdata root */
  UTILITY_ROOT:   "m/44'/144'/0'/cappz/codex/refdata/skill/utility",
} as const;

// ─── Domain Enum ───────────────────────────────────────────────

export type SkillDomain = 'infrastructure' | 'financial' | 'healthcare';

// ─── Endpoint Types ────────────────────────────────────────────

export type EndpointStatus = 'Live' | 'Beta' | 'Planned';

export interface SkillEndpoint {
  name: string;
  description: string;
  status: EndpointStatus;
}

// ─── Subcategory Definitions ───────────────────────────────────

export interface SkillSubcategory {
  id: string;
  label: string;
  mdmAddress: string;
  domain: SkillDomain;
  bpmnProcessAddress: string;
  sortOrder: number;
  iconHint: string;
  colorToken?: string;
}

export interface SkillClassificationEntry {
  /** Skill number (1-64) — internal ordering, NOT displayed in UI */
  skillNumber: number;
  /** Skill MDM address (from MDM_SKILLS) */
  skillMdmAddress: string;
  /** Human-readable functional name (MDM source of truth for UI) */
  name: string;
  /** Functional description (MDM source of truth for UI) */
  description: string;
  /** Lucide icon hint for UI rendering */
  iconHint: string;
  /** Semantic color token */
  colorToken: string;
  /** Background color token */
  bgColorToken: string;
  /** Domain */
  domain: SkillDomain;
  /** Subcategory ID */
  subcategoryId: string;
  /** BPMN process correlation — MDM.agency[cappz].skill[].BPMN[] */
  bpmnCorrelation: string;
  /** Optional: highlight treatment */
  highlight?: 'cfo-suite' | 'core-engine';
  /** Skill utilities — core artifacts this skill produces/requires */
  utilities?: SkillUtilityCode[];
  /** API endpoints exposed by this skill */
  endpoints: SkillEndpoint[];
}

// ─── Infrastructure Subcategories ──────────────────────────────

export const INFRA_SUBCATEGORIES: SkillSubcategory[] = [
  {
    id: 'identity-infosec',
    label: 'Identity & Information Security',
    mdmAddress: `${MDM_CLASSIFICATION.INFRASTRUCTURE}/identity-infosec`,
    domain: 'infrastructure',
    bpmnProcessAddress: "m/44'/144'/0'/cappz/agency/skills/classification/infrastructure/identity-infosec/bpmn",
    sortOrder: 1,
    iconHint: 'Fingerprint',
    colorToken: 'primary',
  },
  {
    id: 'storage',
    label: 'Storage',
    mdmAddress: `${MDM_CLASSIFICATION.INFRASTRUCTURE}/storage`,
    domain: 'infrastructure',
    bpmnProcessAddress: "m/44'/144'/0'/cappz/agency/skills/classification/infrastructure/storage/bpmn",
    sortOrder: 2,
    iconHint: 'Database',
  },
  {
    id: 'metadata-management',
    label: 'Metadata Management',
    mdmAddress: `${MDM_CLASSIFICATION.INFRASTRUCTURE}/metadata-management`,
    domain: 'infrastructure',
    bpmnProcessAddress: "m/44'/144'/0'/cappz/agency/skills/classification/infrastructure/metadata-management/bpmn",
    sortOrder: 3,
    iconHint: 'Network',
  },
  {
    id: 'middleware-messaging',
    label: 'Middleware & Messaging',
    mdmAddress: `${MDM_CLASSIFICATION.INFRASTRUCTURE}/middleware-messaging`,
    domain: 'infrastructure',
    bpmnProcessAddress: "m/44'/144'/0'/cappz/agency/skills/classification/infrastructure/middleware-messaging/bpmn",
    sortOrder: 4,
    iconHint: 'MessageSquare',
  },
  {
    id: 'integration-communications',
    label: 'Integration & Communications',
    mdmAddress: `${MDM_CLASSIFICATION.INFRASTRUCTURE}/integration-communications`,
    domain: 'infrastructure',
    bpmnProcessAddress: "m/44'/144'/0'/cappz/agency/skills/classification/infrastructure/integration-communications/bpmn",
    sortOrder: 5,
    iconHint: 'RefreshCw',
  },
  {
    id: 'uiux',
    label: 'UI/UX',
    mdmAddress: `${MDM_CLASSIFICATION.INFRASTRUCTURE}/uiux`,
    domain: 'infrastructure',
    bpmnProcessAddress: "m/44'/144'/0'/cappz/agency/skills/classification/infrastructure/uiux/bpmn",
    sortOrder: 6,
    iconHint: 'BarChart3',
  },
  {
    id: 'codex-knowledge',
    label: 'Codex & Knowledge',
    mdmAddress: `${MDM_CLASSIFICATION.INFRASTRUCTURE}/codex-knowledge`,
    domain: 'infrastructure',
    bpmnProcessAddress: "m/44'/144'/0'/cappz/agency/skills/classification/infrastructure/codex-knowledge/bpmn",
    sortOrder: 7,
    iconHint: 'BookOpen',
  },
  {
    id: 'operations',
    label: 'Operations',
    mdmAddress: `${MDM_CLASSIFICATION.INFRASTRUCTURE}/operations`,
    domain: 'infrastructure',
    bpmnProcessAddress: "m/44'/144'/0'/cappz/agency/skills/classification/infrastructure/operations/bpmn",
    sortOrder: 8,
    iconHint: 'Activity',
  },
  {
    id: 'communications-scheduling',
    label: 'Communications & Scheduling',
    mdmAddress: `${MDM_CLASSIFICATION.INFRASTRUCTURE}/communications-scheduling`,
    domain: 'infrastructure',
    bpmnProcessAddress: "m/44'/144'/0'/cappz/agency/skills/classification/infrastructure/communications-scheduling/bpmn",
    sortOrder: 9,
    iconHint: 'Calendar',
  },
];

// ─── Financial Subcategories ───────────────────────────────────

export const FINANCIAL_SUBCATEGORIES: SkillSubcategory[] = [
  {
    id: 'standards-codices',
    label: 'Standards & Registry',
    mdmAddress: `${MDM_CLASSIFICATION.FINANCIAL}/standards-codices`,
    domain: 'financial',
    bpmnProcessAddress: "m/44'/144'/0'/cappz/agency/skills/classification/financial/standards-codices/bpmn",
    sortOrder: 1,
    iconHint: 'FileText',
  },
  {
    id: 'protocol-adapters',
    label: 'Protocol Adapters',
    mdmAddress: `${MDM_CLASSIFICATION.FINANCIAL}/protocol-adapters`,
    domain: 'financial',
    bpmnProcessAddress: "m/44'/144'/0'/cappz/agency/skills/classification/financial/protocol-adapters/bpmn",
    sortOrder: 2,
    iconHint: 'ArrowLeftRight',
  },
  {
    id: 'otc-fx-securities',
    label: 'OTC, FX & Securities',
    mdmAddress: `${MDM_CLASSIFICATION.FINANCIAL}/otc-fx-securities`,
    domain: 'financial',
    bpmnProcessAddress: "m/44'/144'/0'/cappz/agency/skills/classification/financial/otc-fx-securities/bpmn",
    sortOrder: 3,
    iconHint: 'Scale',
  },
  {
    id: 'cfo-treasury-suite',
    label: 'CFO Treasury Suite — 7.77¢ on the Dollar',
    mdmAddress: `${MDM_CLASSIFICATION.FINANCIAL}/cfo-treasury-suite`,
    domain: 'financial',
    bpmnProcessAddress: "m/44'/144'/0'/cappz/agency/skills/classification/financial/cfo-treasury-suite/bpmn",
    sortOrder: 4,
    iconHint: 'Landmark',
    colorToken: 'primary',
  },
];

// ─── Healthcare Subcategories ──────────────────────────────────

export const HEALTHCARE_SUBCATEGORIES: SkillSubcategory[] = [
  {
    id: 'clinical-scheduling',
    label: 'Clinical Scheduling',
    mdmAddress: `${MDM_CLASSIFICATION.HEALTHCARE}/clinical-scheduling`,
    domain: 'healthcare',
    bpmnProcessAddress: "m/44'/144'/0'/cappz/agency/skills/classification/healthcare/clinical-scheduling/bpmn",
    sortOrder: 1,
    iconHint: 'CalendarClock',
  },
  {
    id: 'rx-management',
    label: 'Prescription & Rx',
    mdmAddress: `${MDM_CLASSIFICATION.HEALTHCARE}/rx-management`,
    domain: 'healthcare',
    bpmnProcessAddress: "m/44'/144'/0'/cappz/agency/skills/classification/healthcare/rx-management/bpmn",
    sortOrder: 2,
    iconHint: 'Pill',
  },
  {
    id: 'interop-adapters',
    label: 'Interoperability Adapters',
    mdmAddress: `${MDM_CLASSIFICATION.HEALTHCARE}/interop-adapters`,
    domain: 'healthcare',
    bpmnProcessAddress: "m/44'/144'/0'/cappz/agency/skills/classification/healthcare/interop-adapters/bpmn",
    sortOrder: 3,
    iconHint: 'Stethoscope',
  },
  {
    id: 'supply-chain',
    label: 'Supply Chain',
    mdmAddress: `${MDM_CLASSIFICATION.HEALTHCARE}/supply-chain`,
    domain: 'healthcare',
    bpmnProcessAddress: "m/44'/144'/0'/cappz/agency/skills/classification/healthcare/supply-chain/bpmn",
    sortOrder: 4,
    iconHint: 'ShoppingBag',
  },
];

// ─── All Subcategories ─────────────────────────────────────────

export const ALL_SUBCATEGORIES: SkillSubcategory[] = [
  ...INFRA_SUBCATEGORIES,
  ...FINANCIAL_SUBCATEGORIES,
  ...HEALTHCARE_SUBCATEGORIES,
];

// ─── Skill → Classification Mapping ───────────────────────────
// This is the canonical MDM RefData list. The UI reads ONLY this.
// Labels, descriptions, icons, endpoints — all defined here.

export const SKILL_CLASSIFICATIONS: SkillClassificationEntry[] = [
  // ═══ Infrastructure: Identity & Information Security ═══════
  { skillNumber: 2,  skillMdmAddress: MDM_SKILLS.NOTARIZATION,       name: 'Notarization: Provenance & Fidelity', description: 'Blockchain-anchored proof-of-existence with SHA256 + salt', iconHint: 'FileCheck', colorToken: 'primary', bgColorToken: 'primary', domain: 'infrastructure', subcategoryId: 'identity-infosec', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/notarization/bpmn/notarize-verify", utilities: ['bpmn', 'validation', 'schema'], endpoints: [{ name: 'cappz-notarize', description: 'Notarize documents/data on XRPL blockchain', status: 'Live' }] },
  { skillNumber: 3,  skillMdmAddress: MDM_SKILLS.PROVENANCE,         name: 'Verification: Provenance & Fidelity', description: 'Verify document authenticity via txId, hash, or recomputation', iconHint: 'Shield', colorToken: 'primary', bgColorToken: 'primary', domain: 'infrastructure', subcategoryId: 'identity-infosec', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/provenance/bpmn/attest-verify", utilities: ['bpmn', 'validation', 'schema'], endpoints: [{ name: 'cappz-verify', description: 'Verify notarization by txId, hash, or content', status: 'Live' }] },
  { skillNumber: 23, skillMdmAddress: MDM_SKILLS.IDENTITY_REGISTRY,  name: 'Agent Identity Registry', description: 'SHIFT Agent Passport CRUD: register, lookup, upgrade tier, verify, rate limits — API key auth for any framework', iconHint: 'Fingerprint', colorToken: 'primary', bgColorToken: 'primary', domain: 'infrastructure', subcategoryId: 'identity-infosec', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/identity-registry/bpmn/passport-lifecycle", utilities: ['bpmn', 'validation', 'schema'], endpoints: [{ name: 'agent-identity-api', description: 'Register agent passport and receive API key', status: 'Live' }, { name: 'agent-identity-api', description: 'Lookup passport by wallet address', status: 'Live' }, { name: 'agent-identity-api', description: 'Upgrade passport tier (BASIC → VERIFIED → PREMIUM)', status: 'Live' }, { name: 'agent-identity-api', description: 'Verify passport validity and proof hash', status: 'Live' }] },
  { skillNumber: 24, skillMdmAddress: MDM_SKILLS.TRUST_SCORE,        name: 'Trust Score API', description: 'Composite trust score (0-1000) from reputation, stakes, disputes, passport tier, and activity', iconHint: 'BarChart3', colorToken: 'success', bgColorToken: 'success', domain: 'infrastructure', subcategoryId: 'identity-infosec', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/trust-score/bpmn/score-compute", utilities: ['bpmn', 'validation'], endpoints: [{ name: 'trust-score-api', description: 'Query composite trust score with breakdown', status: 'Live' }, { name: 'trust-score-api', description: 'Cached scores with 1-hour TTL', status: 'Live' }] },
  { skillNumber: 25, skillMdmAddress: MDM_SKILLS.PROVENANCE_SERVICE, name: 'Provenance-as-a-Service', description: 'CAD content attribution API with EU AI Act compliance metadata, on-chain notarization, and batch support', iconHint: 'FileCheck', colorToken: 'warning', bgColorToken: 'warning', domain: 'infrastructure', subcategoryId: 'identity-infosec', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/provenance-service/bpmn/cad-attest", utilities: ['bpmn', 'validation', 'schema'], endpoints: [{ name: 'provenance-api', description: 'Attest: create provenance certificate with attribution chain', status: 'Live' }, { name: 'provenance-api', description: 'Verify: validate certificate by ID with on-chain proof', status: 'Live' }, { name: 'provenance-api', description: 'Batch: bulk attestation (up to 50 items)', status: 'Live' }] },
  { skillNumber: 28, skillMdmAddress: MDM_SKILLS.HIBERNATION,        name: 'Hibernation Protocol (COTA Art. IV)', description: 'Automated safety pauses when agent directives conflict with No-Harm — bonded human counsel required to resume', iconHint: 'Shield', colorToken: 'destructive', bgColorToken: 'destructive', domain: 'infrastructure', subcategoryId: 'identity-infosec', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/hibernation/bpmn/cota-art-iv", utilities: ['bpmn', 'validation'], endpoints: [{ name: 'hibernation-api', description: 'Trigger, query, and resume hibernation events', status: 'Live' }] },
  { skillNumber: 45, skillMdmAddress: MDM_SKILLS.ACCESS_CONTROL,     name: 'Access Control', description: 'Scope-pinned permission management — wallet-level authorization with delegation chains', iconHint: 'Lock', colorToken: 'destructive', bgColorToken: 'destructive', domain: 'infrastructure', subcategoryId: 'identity-infosec', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/access-control/bpmn/grant-revoke", utilities: ['bpmn', 'validation', 'schema'], endpoints: [{ name: 'access-control-api', description: 'Grant, revoke, and verify scoped permissions', status: 'Live' }] },
  { skillNumber: 50, skillMdmAddress: MDM_SKILLS.COMPRESS_ENCRYPT,   name: 'Layered Compression & Encryption', description: 'Multi-layer compression and encryption with chunk-level deduplication and geo-distributed storage', iconHint: 'Lock', colorToken: 'destructive', bgColorToken: 'destructive', domain: 'infrastructure', subcategoryId: 'identity-infosec', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/compress-encrypt/bpmn/encrypt-chunk", utilities: ['bpmn', 'pipeline'], endpoints: [{ name: 'compress-encrypt-api', description: 'Compress, encrypt, chunk, and distribute data', status: 'Live' }, { name: 'compress-encrypt-api', description: 'Chunk verification and integrity audit', status: 'Live' }] },

  // ═══ Infrastructure: Storage ═══════════════════════════════
  { skillNumber: 5,  skillMdmAddress: MDM_SKILLS.SUPPLY_CHAIN,       name: 'Decentralized Version Control', description: 'Event-based version control with merkle proofs', iconHint: 'GitBranch', colorToken: 'primary', bgColorToken: 'primary', domain: 'infrastructure', subcategoryId: 'storage', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/supply-chain/bpmn/version-control", utilities: ['bpmn'], endpoints: [{ name: 'repoz-api', description: 'State delta tracking and hash-linked versions', status: 'Live' }] },
  { skillNumber: 8,  skillMdmAddress: MDM_SKILLS.CAPPZ_ACQUIRE,      name: 'RepoZ', description: 'Decentralized repository CRUD with checkout/checkin', iconHint: 'FolderGit', colorToken: 'warning', bgColorToken: 'warning', domain: 'infrastructure', subcategoryId: 'storage', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/cappz-acquire/bpmn/repoz-crud", utilities: ['bpmn'], endpoints: [{ name: 'repoz-api', description: 'Create, checkout, checkin, list repos', status: 'Live' }] },

  // ═══ Infrastructure: Metadata Management ═══════════════════
  { skillNumber: 34, skillMdmAddress: MDM_SKILLS.REFDATA_MGMT,       name: 'RefData Management', description: 'Full CRUD for reference data domains, values, versions, and list memberships — zero cloud footprint', iconHint: 'Database', colorToken: 'primary', bgColorToken: 'primary', domain: 'infrastructure', subcategoryId: 'metadata-management', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/refdata-mgmt/bpmn/crud-lifecycle", utilities: ['bpmn', 'validation', 'schema'], endpoints: [{ name: 'refdata-mgmt-api', description: 'Create/read/update domains, values, versions, memberships', status: 'Live' }, { name: 'refdata-mgmt-api', description: 'Import/export standards with ARC/DARC revenue tracking', status: 'Live' }] },
  { skillNumber: 44, skillMdmAddress: MDM_SKILLS.ONTOLOGY_ENGINE,    name: 'Ontology Engine', description: 'Self-building hierarchical ontology — auto-expanding HD address trees with contextual connectivity', iconHint: 'Network', colorToken: 'primary', bgColorToken: 'primary', domain: 'infrastructure', subcategoryId: 'metadata-management', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/ontology-engine/bpmn/auto-expand", utilities: ['bpmn', 'schema', 'pipeline'], endpoints: [{ name: 'ontology-api', description: 'Create, traverse, and query ontology nodes', status: 'Live' }, { name: 'ontology-api', description: 'Auto-expand on new data with deterministic HD derivation', status: 'Live' }] },
  { skillNumber: 48, skillMdmAddress: MDM_SKILLS.CONTENT_SEARCH,     name: 'Content Index & Search', description: 'Full-text and semantic search across ontology-tagged content with provenance filtering', iconHint: 'ScrollText', colorToken: 'warning', bgColorToken: 'warning', domain: 'infrastructure', subcategoryId: 'metadata-management', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/content-search/bpmn/index-query", utilities: ['bpmn', 'schema'], endpoints: [{ name: 'content-search-api', description: 'Search, filter, and rank content by provenance', status: 'Live' }] },

  // ═══ Infrastructure: Middleware & Messaging ════════════════
  { skillNumber: 35, skillMdmAddress: MDM_SKILLS.VALIDATION_ENGINE,  name: 'Validation Engine', description: 'TX-as-Triple validation — on-chain rules as addresses with JSONLogic for complex nested logic', iconHint: 'Shield', colorToken: 'success', bgColorToken: 'success', domain: 'infrastructure', subcategoryId: 'middleware-messaging', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/validation-engine/bpmn/tx-as-triple", utilities: ['bpmn', 'validation', 'schema'], endpoints: [{ name: 'validation-engine-api', description: 'ValidateDataStructure, ValidateRefData, ValidateCrossField', status: 'Live' }] },
  { skillNumber: 37, skillMdmAddress: MDM_SKILLS.SYNC_ON_ASYNC,      name: 'Sync-on-Async Processing', description: 'Patent-backed correlated sync-on-async pattern (US 7,769,802 / 7,870,187): submit a long-running request with a correlation ID and receive the result via poll or callback. Any transform or workload can ride on top — XSD↔MDM and JSON↔MDM are two example call ops exposed as separate endpoints.', iconHint: 'RefreshCw', colorToken: 'primary', bgColorToken: 'primary', domain: 'infrastructure', subcategoryId: 'middleware-messaging', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/sync-on-async/bpmn/correlate", utilities: ['bpmn', 'schema', 'pipeline'], endpoints: [{ name: 'sync-on-async-api', description: 'Submit async request with correlation ID, poll or callback for result', status: 'Live' }, { name: 'xsd-x-mdm-api', description: 'Example call op — XSD↔MDM schema transform on the sync-on-async substrate', status: 'Live' }, { name: 'json-x-mdm-api', description: 'Example call op — JSON↔MDM schema transform on the sync-on-async substrate', status: 'Live' }] },
  { skillNumber: 38, skillMdmAddress: MDM_SKILLS.MIDDLEWARE,          name: 'CAPPZ Middleware', description: 'Client-side persistence layer — offline-first read-through cache with sync-on-async writeback to Lovable Cloud', iconHint: 'Database', colorToken: 'warning', bgColorToken: 'warning', domain: 'infrastructure', subcategoryId: 'middleware-messaging', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/middleware/bpmn/persist-sync", utilities: ['bpmn', 'validation', 'schema', 'pipeline'], endpoints: [{ name: 'middleware-api', description: 'cappz-store read / write / remove: queue, persist (OPFS), and sync local records; submit routes writes to a storage pipeline', status: 'Live' }, { name: 'middleware-api', description: 'getSession / setSession: offline session management', status: 'Live' }] },
  { skillNumber: 42, skillMdmAddress: MDM_SKILLS.MESSAGEBOX,          name: 'cappz-messagebox', description: 'Pipeline processing engine — parse, validate, extract, transform, deliver with pub-sub routing', iconHint: 'MessageSquare', colorToken: 'info', bgColorToken: 'info', domain: 'infrastructure', subcategoryId: 'middleware-messaging', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/messagebox/bpmn/pub-sub-pipeline", utilities: ['bpmn', 'validation', 'schema', 'pipeline'], endpoints: [{ name: 'messagebox-api', description: 'Submit, route, and track pipeline messages', status: 'Live' }, { name: 'messagebox-api', description: 'Pub-sub subscription management', status: 'Live' }] },
  { skillNumber: 43, skillMdmAddress: MDM_SKILLS.TRANSFORM_ENGINE,   name: 'Transform Engine', description: 'Bidirectional data transformation — XSD↔JSON↔MDM with schema-driven mapping', iconHint: 'RefreshCw', colorToken: 'warning', bgColorToken: 'warning', domain: 'infrastructure', subcategoryId: 'middleware-messaging', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/transform-engine/bpmn/xsd-json-mdm", utilities: ['bpmn', 'schema', 'pipeline'], endpoints: [{ name: 'transform-api', description: 'Execute schema transforms with audit trail', status: 'Live' }] },
  { skillNumber: 51, skillMdmAddress: MDM_SKILLS.BPMN_ENGINE,        name: 'BPMN Execution Engine', description: 'Agentic contract language — BPMN behavioral flows with deterministic execution and constraint enforcement', iconHint: 'Activity', colorToken: 'success', bgColorToken: 'success', domain: 'infrastructure', subcategoryId: 'middleware-messaging', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/bpmn-engine/bpmn/orchestrate", highlight: 'core-engine', utilities: ['bpmn', 'validation', 'schema', 'pipeline'], endpoints: [{ name: 'bpmn-api', description: 'Deploy, execute, and audit BPMN process definitions', status: 'Live' }, { name: 'bpmn-api', description: 'Scope-pinned task routing with compliance gates', status: 'Live' }] },

  // ═══ Infrastructure: Integration & Communications ══════════
  { skillNumber: 4,  skillMdmAddress: MDM_SKILLS.ESCROW,              name: 'A2A Secure Comms', description: 'Agent-to-Agent messaging with integrity hashing', iconHint: 'MessageSquare', colorToken: 'info', bgColorToken: 'info', domain: 'infrastructure', subcategoryId: 'integration-communications', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/escrow/bpmn/a2a-message", utilities: ['bpmn', 'schema'], endpoints: [{ name: 'a2a-message', description: 'Send, verify, and receive A2A messages', status: 'Live' }] },
  { skillNumber: 6,  skillMdmAddress: MDM_SKILLS.CONTEXT_HISTORY,     name: 'Self-Synchronized Content', description: 'Multi-master portable content with conflict resolution', iconHint: 'RefreshCw', colorToken: 'primary', bgColorToken: 'primary', domain: 'infrastructure', subcategoryId: 'integration-communications', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/context-history/bpmn/sync-content", utilities: ['bpmn'], endpoints: [{ name: 'repoz-api', description: 'Version tracking with conflict detection', status: 'Live' }, { name: 'a2a-message', description: 'Peer sync notifications', status: 'Live' }] },
  { skillNumber: 89, skillMdmAddress: MDM_SKILLS.A2A_SYNC_RECEIVER, name: 'A2A Sync Receiver', description: 'Discovers offers, requests data, code, or models, verifies encrypted chunks, and records outcomes', iconHint: 'Download', colorToken: 'success', bgColorToken: 'success', domain: 'infrastructure', subcategoryId: 'integration-communications', bpmnCorrelation: "m/44'/144'/100'/bpmn/substrate/a2a-sync#ReceiverSide", utilities: ['bpmn', 'validation', 'schema', 'pipeline'], endpoints: [{ name: 'sync.request', description: 'Post a typed sync request with routing constraints', status: 'Live' }, { name: 'sync.run', description: 'Verify and apply a matched encrypted transfer', status: 'Live' }] },
  { skillNumber: 90, skillMdmAddress: MDM_SKILLS.A2A_SYNC_TRANSMITTER, name: 'A2A Sync Transmitter', description: 'Advertises content-addressed manifests and delivers authorized encrypted data, code, or model chunks', iconHint: 'Upload', colorToken: 'warning', bgColorToken: 'warning', domain: 'infrastructure', subcategoryId: 'integration-communications', bpmnCorrelation: "m/44'/144'/100'/bpmn/substrate/a2a-sync#TransmitterSide", utilities: ['bpmn', 'validation', 'schema', 'pipeline'], endpoints: [{ name: 'sync.offer', description: 'Post a typed sync offer and capability snapshot', status: 'Live' }, { name: 'sync.withdraw', description: 'Withdraw an owned offer or request', status: 'Live' }] },
  { skillNumber: 91, skillMdmAddress: MDM_SKILLS.A2A_SYNC_TRANSCEIVER, name: 'A2A Sync Transceiver', description: 'Union of Receiver and Transmitter APIs with shared state, transport, and deterministic partner matching', iconHint: 'ArrowLeftRight', colorToken: 'primary', bgColorToken: 'primary', domain: 'infrastructure', subcategoryId: 'integration-communications', bpmnCorrelation: "m/44'/144'/100'/bpmn/substrate/a2a-sync#MatchPartners", utilities: ['bpmn', 'validation', 'schema', 'pipeline'], endpoints: [{ name: 'sync.match', description: 'Rank and match compatible offers and requests', status: 'Live' }, { name: 'sync.run', description: 'Execute the matched encrypted session', status: 'Live' }] },
  { skillNumber: 92, skillMdmAddress: MDM_SKILLS.INQUIRY_FEEDBACK, name: 'Inquiry & Feedback (IFF)', description: 'Users-group wallet conversations scoped to the personal or app wallet, with admin replies', iconHint: 'MessageSquare', colorToken: 'primary', bgColorToken: 'primary', domain: 'infrastructure', subcategoryId: 'integration-communications', bpmnCorrelation: "m/44'/144'/100'/bpmn/substrate/feedback/feedback-processing", utilities: ['bpmn'], endpoints: [{ name: 'feedback', description: 'Open the wallet-scoped inquiry and feedback conversation', status: 'Live' }] },
  { skillNumber: 16, skillMdmAddress: MDM_SKILLS.MCP_PROTOCOL,        name: 'MCP Agent Bridge', description: 'Model Context Protocol server registration and invocation', iconHint: 'Brain', colorToken: 'primary', bgColorToken: 'primary', domain: 'infrastructure', subcategoryId: 'integration-communications', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/mcp-protocol/bpmn/mcp-invoke", utilities: ['bpmn', 'schema'], endpoints: [{ name: 'mcp-register-server', description: 'Register MCP server', status: 'Live' }, { name: 'mcp-execute-call', description: 'Execute MCP calls', status: 'Live' }, { name: 'mcp-list-servers', description: 'List registered servers', status: 'Live' }] },
  { skillNumber: 26, skillMdmAddress: MDM_SKILLS.MCP_PROTOCOL,        name: 'MCP Protocol Server', description: 'MCP-compliant server exposing 9 tools for Anthropic Claude, OpenAI, and any MCP client', iconHint: 'Server', colorToken: 'info', bgColorToken: 'info', domain: 'infrastructure', subcategoryId: 'integration-communications', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/mcp-protocol/bpmn/mcp-server", utilities: ['bpmn', 'schema'], endpoints: [{ name: 'mcp-server', description: 'Streamable HTTP MCP endpoint with 9 tools', status: 'Live' }, { name: 'mcp-server', description: 'Compatible with MCP Inspector for testing', status: 'Live' }] },
  { skillNumber: 40, skillMdmAddress: MDM_SKILLS.GROUP_CHAT,          name: 'Group Chat', description: 'Multi-master shared agent group conversations with conflict resolution and presence', iconHint: 'Users', colorToken: 'success', bgColorToken: 'success', domain: 'infrastructure', subcategoryId: 'integration-communications', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/group-chat/bpmn/multi-master", utilities: ['bpmn', 'schema'], endpoints: [{ name: 'group-chat-api', description: 'Create group, send messages, manage participants', status: 'Live' }, { name: 'group-chat-api', description: 'Multi-master sync with deterministic conflict resolution', status: 'Live' }] },

  // ═══ Infrastructure: UI/UX ═════════════════════════════════
  { skillNumber: 49, skillMdmAddress: MDM_SKILLS.DASHBOARD_UIUX,     name: 'Dashboard UI/UX', description: 'Centralized visualization — message throughput, ontology navigation, clone genealogy, agent panels', iconHint: 'BarChart3', colorToken: 'primary', bgColorToken: 'primary', domain: 'infrastructure', subcategoryId: 'uiux', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/dashboard-uiux/bpmn/render-panels", utilities: ['bpmn'], endpoints: [{ name: 'dashboard-api', description: 'Metrics, graph views, and agent panel rendering', status: 'Live' }] },
  { skillNumber: 58, skillMdmAddress: MDM_SKILLS.GRAPH_VIEWER,       name: 'Graph Viewer', description: 'Universal scope-anchored graph/tree visualization with print-to-PDF and interactive exploration', iconHint: 'Network', colorToken: 'success', bgColorToken: 'success', domain: 'infrastructure', subcategoryId: 'uiux', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/graph-viewer/bpmn/scope-render", utilities: ['bpmn'], endpoints: [{ name: 'graph-viewer-api', description: 'Render ontology, dependency, and genealogy graphs', status: 'Live' }, { name: 'graph-viewer-api', description: 'Export to PDF with scope-filtered views', status: 'Live' }] },

  // ═══ Infrastructure: Codex & Knowledge ═════════════════════
  { skillNumber: 41, skillMdmAddress: MDM_SKILLS.MKF,                 name: 'Metatron Knowledge Factory (MKF)', description: 'Ontology-driven knowledge processing — ingest, classify, correlate, and serve structured knowledge', iconHint: 'Brain', colorToken: 'primary', bgColorToken: 'primary', domain: 'infrastructure', subcategoryId: 'codex-knowledge', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/mkf/bpmn/ingest-pipeline", utilities: ['bpmn', 'validation', 'schema', 'pipeline'], endpoints: [{ name: 'mkf-api', description: 'Ingest content with ontology tagging and provenance', status: 'Live' }, { name: 'mkf-api', description: 'Knowledge graph query and traversal', status: 'Live' }] },
  { skillNumber: 56, skillMdmAddress: MDM_SKILLS.BIBLE,               name: 'Bible Codex (84-Book Canon)', description: 'Ethiopian Orthodox Tewahedo 84-book Canon with HD-addressed book/chapter/verse and resident Metatron agent', iconHint: 'BookOpen', colorToken: 'warning', bgColorToken: 'warning', domain: 'infrastructure', subcategoryId: 'codex-knowledge', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/bible/bpmn/canon-navigate", utilities: ['bpmn', 'schema'], endpoints: [{ name: 'bible-api', description: 'Navigate books, chapters, verses with ontology tags', status: 'Live' }, { name: 'bible-api', description: 'Cross-reference and concordance search', status: 'Live' }] },
  { skillNumber: 57, skillMdmAddress: MDM_SKILLS.CODEX,               name: 'Codex Modeler', description: 'Federated codex management — ConstituentIncluded TX edges, multi-codex interop, Volume creation, cross-skill CorrelationCreated edges, canon governance', iconHint: 'BookOpen', colorToken: 'info', bgColorToken: 'info', domain: 'infrastructure', subcategoryId: 'codex-knowledge', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/codex/bpmn/federate-traverse", utilities: ['bpmn', 'validation', 'schema'], endpoints: [{ name: 'codex-api', description: 'Create, federate, and traverse codex hierarchies', status: 'Live' }, { name: 'codex-api', description: 'ConstituentIncluded edge management', status: 'Live' }, { name: 'codex-api', description: 'Volume creation and constituent assignment', status: 'Live' }] },
  { skillNumber: 81, skillMdmAddress: MDM_SKILLS.NAG_HAMMADI,         name: 'Nag Hammadi Library', description: '52 Gnostic and early Christian tractates across 13 codices — Gospel of Thomas, Gospel of Mary, Apocryphon of John with cross-canon correlation to Ethiopian (Enoch) and KJV', iconHint: 'Scroll', colorToken: 'warning', bgColorToken: 'warning', domain: 'infrastructure', subcategoryId: 'codex-knowledge', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/nag-hammadi/bpmn/gnostic-navigate", utilities: ['bpmn', 'schema'], endpoints: [{ name: 'nag-hammadi-api', description: 'Navigate Nag Hammadi codices and tractates', status: 'Live' }, { name: 'nag-hammadi-api', description: 'Cross-canon correlation with Ethiopian Enoch and KJV', status: 'Live' }] },
  { skillNumber: 82, skillMdmAddress: MDM_SKILLS.CODEX_LIBRARY,       name: 'User Library (UCL)', description: 'On-demand User Codex Library — provisions Library Skill clone under user-wallet agent, composes child codex/canon skills via ConstituentAdded TXs, federates CRA across canon agents', iconHint: 'Library', colorToken: 'primary', bgColorToken: 'primary', domain: 'infrastructure', subcategoryId: 'codex-knowledge', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/codex-library/bpmn/ucl-provision", utilities: ['bpmn', 'validation', 'schema'], endpoints: [{ name: 'library-api', description: 'Provision UCL and add canon skills on demand', status: 'Live' }, { name: 'library-api', description: 'Federate CRA across canon agent correlations', status: 'Live' }, { name: 'library-api', description: 'Volume creation and constituent organization', status: 'Live' }] },
  { skillNumber: 83, skillMdmAddress: MDM_SKILLS.QUMRAN,              name: 'Dead Sea Scrolls (Qumran)', description: '36 major scrolls from 11 caves — Biblical MSS, Sectarian, Liturgical, Parabiblical with HD-addressed scroll/section/fragment hierarchy and cross-canon correlation', iconHint: 'Scroll', colorToken: 'warning', bgColorToken: 'warning', domain: 'infrastructure', subcategoryId: 'codex-knowledge', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/qumran/bpmn/scroll-navigate", utilities: ['bpmn', 'schema'], endpoints: [{ name: 'qumran-api', description: 'Navigate scrolls, sections, and fragments', status: 'Live' }, { name: 'qumran-api', description: 'Cross-canon validation with Ethiopian 1 Enoch and KJV Isaiah', status: 'Live' }] },

  // ═══ Infrastructure: Operations ════════════════════════════
  { skillNumber: 1,  skillMdmAddress: MDM_SKILLS.WALLET_OPS,          name: 'Core Wallet Operations', description: 'Cross-blockchain wallet abstraction with reblocking', iconHint: 'Wallet', colorToken: 'primary', bgColorToken: 'primary', domain: 'infrastructure', subcategoryId: 'operations', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/wallet-ops/bpmn/wallet-lifecycle", utilities: ['bpmn', 'validation'], endpoints: [{ name: 'chainlet-wallet-ops', description: 'Wallet creation, balance, tx history, reblocking', status: 'Live' }, { name: 'cappz-exchange', description: 'XRP ↔ CAPPZ token exchange & balance', status: 'Live' }] },
  { skillNumber: 7,  skillMdmAddress: MDM_SKILLS.ROYALTY_FLYWHEEL,    name: 'Royalty Flywheel Distributions', description: 'Automated multi-level revenue distribution to token holders', iconHint: 'Coins', colorToken: 'warning', bgColorToken: 'warning', domain: 'infrastructure', subcategoryId: 'operations', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/royalty-flywheel/bpmn/distribute", utilities: ['bpmn', 'validation'], endpoints: [{ name: 'royalty-distribution-api', description: 'Revenue events, distributions, balances', status: 'Live' }, { name: 'auto-distribute-royalties', description: 'Batch payout execution', status: 'Live' }] },
  { skillNumber: 9,  skillMdmAddress: MDM_SKILLS.WALLET_COMPOUND,     name: 'Pools & Marketplaces', description: 'Agent pools with dark/opaque/light opacity and federation', iconHint: 'Users', colorToken: 'success', bgColorToken: 'success', domain: 'infrastructure', subcategoryId: 'operations', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/wallet-compound/bpmn/pool-manage", utilities: ['bpmn'], endpoints: [{ name: 'pool-marketplace-api', description: 'Create, list, and manage pools', status: 'Live' }] },
  { skillNumber: 19, skillMdmAddress: MDM_SKILLS.CHAINLET_CREATE,     name: 'Chainlet Operations', description: 'End-to-end chainlet lifecycle: wallet creation, funding, CAPPZ acquisition, notarized reblocking', iconHint: 'Lock', colorToken: 'primary', bgColorToken: 'primary', domain: 'infrastructure', subcategoryId: 'operations', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/chainlet-create/bpmn/chainlet-lifecycle", utilities: ['bpmn', 'validation'], endpoints: [{ name: 'chainlet-wallet-ops', description: 'Create XRP wallet, fund, connect, manage HD-addressed chainlets', status: 'Live' }, { name: 'cappz-exchange', description: 'Acquire CAPPZ tokens from treasury (XRP → CAPPZ)', status: 'Live' }, { name: 'cappz-notarize', description: 'Notarize chainlet reblocks on XRPL mainnet', status: 'Live' }, { name: 'cappz-verify', description: 'Verify chainlet block integrity via hash or txId', status: 'Live' }] },
  { skillNumber: 20, skillMdmAddress: MDM_SKILLS.AGENT_ONBOARDING,    name: 'Agent Account & Onboarding', description: 'Create agent accounts, check funding readiness, purchase XRP & CAPPZ, track onboarding progress', iconHint: 'UserPlus', colorToken: 'success', bgColorToken: 'success', domain: 'infrastructure', subcategoryId: 'operations', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/agent-onboarding/bpmn/6-step-onboard", utilities: ['bpmn', 'validation', 'schema'], endpoints: [{ name: 'agent-account-api', description: 'Create agent account with wallet, API key, and onboarding guide', status: 'Live' }, { name: 'agent-account-api', description: 'Fund-check: XRP balance, trustline, CAPPZ readiness', status: 'Live' }, { name: 'agent-account-api', description: 'Onboarding status: 6-step progress tracker', status: 'Live' }, { name: 'cappz-exchange', description: 'Purchase CAPPZ tokens (XRP → CAPPZ)', status: 'Live' }, { name: 'chainlet-wallet-ops', description: 'Create and fund XRP wallets', status: 'Live' }] },
  { skillNumber: 27, skillMdmAddress: MDM_SKILLS.FEE_TIERS,           name: 'Fee Tiers & Deflationary Model', description: 'Tiered deflationary fee schedules with staking accelerators and volume discounts', iconHint: 'Coins', colorToken: 'warning', bgColorToken: 'warning', domain: 'infrastructure', subcategoryId: 'operations', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/fee-tiers/bpmn/tier-calculate", utilities: ['bpmn', 'validation'], endpoints: [{ name: 'fee-model-api', description: 'Query fee tier, calculate staking discounts', status: 'Live' }] },
  { skillNumber: 29, skillMdmAddress: MDM_SKILLS.MARKET_HEALTH,       name: 'Market Health (MVL Thresholds)', description: 'Minimum Viable Liquidity enforcement, circuit breakers, and market health monitoring', iconHint: 'Activity', colorToken: 'success', bgColorToken: 'success', domain: 'infrastructure', subcategoryId: 'operations', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/market-health/bpmn/mvl-monitor", utilities: ['bpmn', 'validation'], endpoints: [{ name: 'mvl-threshold-api', description: 'Query market health metrics and threshold alerts', status: 'Live' }] },
  { skillNumber: 39, skillMdmAddress: MDM_SKILLS.MIGRATION,           name: 'Migration Engine', description: 'Schema & data migration — version-aware transforms with rollback and audit trail', iconHint: 'RefreshCw', colorToken: 'info', bgColorToken: 'info', domain: 'infrastructure', subcategoryId: 'operations', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/migration/bpmn/migrate-rollback", utilities: ['bpmn', 'validation', 'schema'], endpoints: [{ name: 'migration-api', description: 'Execute, rollback, and audit schema migrations', status: 'Live' }] },
  { skillNumber: 46, skillMdmAddress: MDM_SKILLS.LIFECYCLE_CLONE,     name: 'Lifecycle Clone Admin', description: 'Scoped clone lifecycle — create, configure, audit, and terminate clones with provenance', iconHint: 'GitBranch', colorToken: 'success', bgColorToken: 'success', domain: 'infrastructure', subcategoryId: 'operations', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/lifecycle-clone/bpmn/clone-lifecycle", utilities: ['bpmn', 'validation'], endpoints: [{ name: 'lifecycle-api', description: 'Clone creation, configuration, and audit trail', status: 'Live' }] },
  { skillNumber: 47, skillMdmAddress: MDM_SKILLS.LIFECYCLE_COPY,      name: 'Lifecycle Copy Control', description: 'Content copy lifecycle — version control with Created/Amended/Terminated states', iconHint: 'GitBranch', colorToken: 'info', bgColorToken: 'info', domain: 'infrastructure', subcategoryId: 'operations', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/lifecycle-copy/bpmn/copy-lifecycle", utilities: ['bpmn'], endpoints: [{ name: 'lifecycle-api', description: 'Copy versioning with lifecycle state transitions', status: 'Live' }] },

  // ═══ Financial: Standards & Registry ═════════════════════════
  { skillNumber: 30, skillMdmAddress: MDM_SKILLS.FACTORY_ISO20022,   name: 'ISO 20022 Domain', description: 'HD-addressed ISO 20022 reference data — currency codes, country codes, message types, business areas', iconHint: 'FileText', colorToken: 'info', bgColorToken: 'info', domain: 'financial', subcategoryId: 'standards-codices', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/factory-iso20022/bpmn/schema-resolve", utilities: ['bpmn', 'validation', 'schema'], endpoints: [{ name: 'refdata-domain-api', description: 'Resolve ISO 20022 values via HD address derivation', status: 'Live' }, { name: 'refdata-domain-api', description: 'Validate pain.001, pacs.008, camt.053 structures', status: 'Live' }] },
  { skillNumber: 31, skillMdmAddress: MDM_SKILLS.FACTORY_FIX,        name: 'FIX Protocol Domain', description: 'HD-addressed FIX Protocol reference data — order types, execution types, side codes, time-in-force', iconHint: 'FileText', colorToken: 'primary', bgColorToken: 'primary', domain: 'financial', subcategoryId: 'standards-codices', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/factory-fix/bpmn/tag-resolve", utilities: ['bpmn', 'validation', 'schema'], endpoints: [{ name: 'refdata-domain-api', description: 'Resolve FIX tag values via deterministic addresses', status: 'Live' }] },
  { skillNumber: 32, skillMdmAddress: MDM_SKILLS.FACTORY_FPML,       name: 'FpML / ISDA Domain', description: 'HD-addressed FpML reference data — product types, day count fractions, business centers', iconHint: 'Scale', colorToken: 'destructive', bgColorToken: 'destructive', domain: 'financial', subcategoryId: 'standards-codices', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/factory-fpml/bpmn/product-resolve", utilities: ['bpmn', 'validation', 'schema'], endpoints: [{ name: 'refdata-domain-api', description: 'Resolve ISDA/FpML values with canonical alignment to ISO 20022', status: 'Live' }] },
  { skillNumber: 33, skillMdmAddress: MDM_SKILLS.FACTORY_DERIVED,    name: 'Enterprise Derived Domains', description: 'Non-lossy enterprise extensions (e.g., JPM-IBML of ISDA FpML) — custom HD-addressed internal metadata', iconHint: 'GitBranch', colorToken: 'warning', bgColorToken: 'warning', domain: 'financial', subcategoryId: 'standards-codices', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/factory-derived/bpmn/derive-extend", utilities: ['bpmn', 'schema'], endpoints: [{ name: 'refdata-domain-api', description: 'Create and resolve derived domain values inheriting parent addresses', status: 'Beta' }] },
  { skillNumber: 36, skillMdmAddress: MDM_SKILLS.DOMAIN_REGISTRY,    name: 'Domain Registry', description: 'Global registry of all RefData domains — discovery, subscription lifecycle (Created/Amended/Terminated)', iconHint: 'Network', colorToken: 'info', bgColorToken: 'info', domain: 'financial', subcategoryId: 'standards-codices', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/domain-registry/bpmn/discover-subscribe", utilities: ['bpmn', 'validation', 'schema'], endpoints: [{ name: 'domain-registry-api', description: 'Discover, subscribe, and manage domain lifecycle', status: 'Live' }] },
  { skillNumber: 65, skillMdmAddress: MDM_SKILLS.AL3_DOMAIN,         name: 'ACORD AL3 Insurance Domain', description: 'HD-addressed ACORD AL3 reference data — policy types, claim states, coverage codes, endorsement forms', iconHint: 'Shield', colorToken: 'warning', bgColorToken: 'warning', domain: 'financial', subcategoryId: 'standards-codices', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/al3-domain/bpmn/policy-resolve", utilities: ['bpmn', 'validation', 'schema'], endpoints: [{ name: 'refdata-domain-api', description: 'Resolve ACORD AL3 values via HD address derivation', status: 'Beta' }, { name: 'refdata-domain-api', description: 'Policy type, claim state, and coverage code lookup', status: 'Beta' }] },
  { skillNumber: 66, skillMdmAddress: MDM_SKILLS.MDM_STANDARDS_INGEST, name: 'Core MDM Standards Ingest', description: 'Generic BPMN-driven ingest pipeline for all industry standards — code-list versioning, CodeValueCreated/Deprecated lifecycle, shared by all standard-consuming skills', iconHint: 'Database', colorToken: 'primary', bgColorToken: 'primary', domain: 'infrastructure', subcategoryId: 'metadata-management', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/mdm-standards-ingest/bpmn/ingest-codelist", utilities: ['bpmn', 'validation', 'schema', 'pipeline'], endpoints: [{ name: 'mdm-ingest-api', description: 'Ingest code-list document with versioned lifecycle tracking', status: 'Live' }, { name: 'mdm-ingest-api', description: 'CodeValueCreated/CodeValueDeprecated event TX generation', status: 'Live' }, { name: 'mdm-ingest-api', description: 'Cross-standard value mapping and deduplication', status: 'Live' }] },

  // ═══ Financial: Protocol Adapters ══════════════════════════
  { skillNumber: 14, skillMdmAddress: MDM_SKILLS.SECURITIES,          name: 'Securities Platform', description: 'Reg D/S offerings, blue sky filing management, dividend distribution', iconHint: 'FileText', colorToken: 'info', bgColorToken: 'info', domain: 'financial', subcategoryId: 'protocol-adapters', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/securities/bpmn/validate-message", utilities: ['bpmn', 'validation', 'schema', 'pipeline'], endpoints: [{ name: 'securities-api', description: 'Securities offering CRUD, investor accreditation, blue sky filings', status: 'Live' }] },
  { skillNumber: 15, skillMdmAddress: MDM_SKILLS.PRESCRIPTION,       name: 'OTC Lifecycle', description: 'OTC derivative lifecycle: contracts, margin calls, settlement events', iconHint: 'Scale', colorToken: 'destructive', bgColorToken: 'destructive', domain: 'financial', subcategoryId: 'protocol-adapters', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/prescription/bpmn/otc-lifecycle", utilities: ['bpmn', 'validation', 'schema', 'pipeline'], endpoints: [{ name: 'otc-contract-api', description: 'Create, confirm, margin-call, lifecycle events', status: 'Beta' }] },
  { skillNumber: 52, skillMdmAddress: MDM_SKILLS.SWIFT_ADAPTER,      name: 'SWIFT Middleware Skill', description: 'SWIFT message middleware — MT→MX migration, MT103/202 parsing, MX pacs.008 generation. Transport adapters import as constituents.', iconHint: 'FileText', colorToken: 'info', bgColorToken: 'info', domain: 'financial', subcategoryId: 'protocol-adapters', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/swift-adapter/bpmn/mt-mx-translate", utilities: ['bpmn', 'validation', 'schema', 'pipeline'], endpoints: [{ name: 'swift-adapter-api', description: 'Parse MT messages and generate MX equivalents', status: 'Live' }] },
  { skillNumber: 53, skillMdmAddress: MDM_SKILLS.EDI_ADAPTER,        name: 'EDI Middleware Skill', description: 'EDI document middleware — X12 850/810/856 and EDIFACT ORDERS/INVOIC with HD-addressed mapping. Transport adapters import as constituents.', iconHint: 'FileText', colorToken: 'warning', bgColorToken: 'warning', domain: 'financial', subcategoryId: 'protocol-adapters', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/edi-adapter/bpmn/x12-edifact", utilities: ['bpmn', 'validation', 'schema', 'pipeline'], endpoints: [{ name: 'edi-adapter-api', description: 'Parse, validate, and transform EDI documents', status: 'Live' }] },
  { skillNumber: 55, skillMdmAddress: MDM_SKILLS.ISO20022_ADAPTER,   name: 'ISO 20022 Middleware Skill', description: 'ISO 20022 STP middleware — pain/pacs/camt pipeline with transport adapter constituents (XRP Bridge, SWIFT, SEPA). Format mapping transforms (XSLT/JSON↔XML).', iconHint: 'FileText', colorToken: 'primary', bgColorToken: 'primary', domain: 'financial', subcategoryId: 'protocol-adapters', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/iso20022-adapter/bpmn/stp-pipeline", utilities: ['bpmn', 'validation', 'schema', 'pipeline'], endpoints: [{ name: 'iso20022-stp-api', description: 'STP pipeline: validate → enrich → route → settle', status: 'Live' }, { name: 'iso20022-bridge-api', description: 'XRP Bridge transport adapter — fiat↔XRP with ISO 20022 compliance', status: 'Live' }] },

  // ═══ Financial: OTC, FX & Securities ═══════════════════════
  { skillNumber: 12, skillMdmAddress: MDM_SKILLS.TREASURY_OPS,       name: 'Treasury Operations', description: 'Platform treasury operations and fee management', iconHint: 'Building2', colorToken: 'primary', bgColorToken: 'primary', domain: 'financial', subcategoryId: 'otc-fx-securities', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/treasury-operations/bpmn/treasury-ops", utilities: ['bpmn', 'validation'], endpoints: [{ name: 'cappz-exchange', description: 'Config, quote, execute, balance operations', status: 'Live' }] },
  { skillNumber: 13, skillMdmAddress: MDM_SKILLS.CHAINLET_SYNC,      name: 'Project as Investment Fund', description: 'Tokenized securities offering and share management', iconHint: 'Landmark', colorToken: 'warning', bgColorToken: 'warning', domain: 'financial', subcategoryId: 'otc-fx-securities', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/chainlet-sync/bpmn/fund-manage", utilities: ['bpmn', 'validation', 'schema'], endpoints: [{ name: 'fund-management-api', description: 'Fund creation, share tokenization, distributions', status: 'Beta' }] },
  { skillNumber: 22, skillMdmAddress: MDM_SKILLS.FOA_GOVERNANCE,     name: 'Family Office Agent (FOA)', description: 'Estate guardian: DMS proof-of-life, heir management, auto-distribution, wealth protection', iconHint: 'ShieldCheck', colorToken: 'destructive', bgColorToken: 'destructive', domain: 'financial', subcategoryId: 'otc-fx-securities', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/foa-governance/bpmn/estate-dms", utilities: ['bpmn', 'validation', 'schema'], endpoints: [{ name: 'foa-api', description: 'Create estate with guardian DMS and distribution rules', status: 'Live' }, { name: 'foa-api', description: 'Proof-of-life heartbeat and heir management', status: 'Live' }, { name: 'dms-api', description: "Dead Man's Switch heartbeat and status", status: 'Live' }, { name: 'cappz-notarize', description: 'Notarize estate plans immutably on XRPL', status: 'Live' }] },

  // ═══ Financial: CFO Treasury Suite ═════════════════════════
  { skillNumber: 59, skillMdmAddress: MDM_SKILLS.PORTFOLIO_ADMIN,     name: 'Portfolio Administrator Agent', description: 'Multi-strategy portfolio administration — position management, risk analytics, compliance overlay, rebalancing', iconHint: 'BarChart3', colorToken: 'primary', bgColorToken: 'primary', domain: 'financial', subcategoryId: 'cfo-treasury-suite', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/portfolio-admin/bpmn/position-risk", highlight: 'cfo-suite', utilities: ['bpmn', 'validation', 'schema', 'pipeline'], endpoints: [{ name: 'portfolio-admin-api', description: 'Position snapshots, P&L, risk metrics (VaR, Sharpe)', status: 'Beta' }, { name: 'portfolio-admin-api', description: 'Rebalancing triggers with compliance gates', status: 'Beta' }] },
  { skillNumber: 60, skillMdmAddress: MDM_SKILLS.TREASURER,           name: 'Treasurer Agent', description: 'Cash management, liquidity forecasting, bank account admin, inter-company netting & settlements', iconHint: 'Building2', colorToken: 'warning', bgColorToken: 'warning', domain: 'financial', subcategoryId: 'cfo-treasury-suite', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/treasurer/bpmn/cash-liquidity", highlight: 'cfo-suite', utilities: ['bpmn', 'validation', 'schema', 'pipeline'], endpoints: [{ name: 'treasurer-api', description: 'Cash position, liquidity forecast, bank reconciliation', status: 'Beta' }, { name: 'treasurer-api', description: 'Inter-company netting and settlement execution', status: 'Beta' }] },
  { skillNumber: 61, skillMdmAddress: MDM_SKILLS.FIX_TRADER,          name: 'FIX Trader (Commodities & FX)', description: 'FIX 4.4/5.0 order routing — futures, forwards, FX with best-execution compliance and TCA analytics', iconHint: 'Activity', colorToken: 'success', bgColorToken: 'success', domain: 'financial', subcategoryId: 'cfo-treasury-suite', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/fix-trader/bpmn/order-route", highlight: 'cfo-suite', utilities: ['bpmn', 'validation', 'schema', 'pipeline'], endpoints: [{ name: 'fix-trader-api', description: 'NewOrderSingle, ExecutionReport, OrderCancel routing', status: 'Beta' }, { name: 'fix-trader-api', description: 'Best-execution analysis and TCA reporting', status: 'Beta' }] },
  { skillNumber: 62, skillMdmAddress: MDM_SKILLS.ISDA_FPML_TRADER,    name: 'ISDA FpML Derivatives Trader', description: 'OTC swap lifecycle — tri-party collateral, confirmation matching, ISDA Master Agreement compliance', iconHint: 'Scale', colorToken: 'destructive', bgColorToken: 'destructive', domain: 'financial', subcategoryId: 'cfo-treasury-suite', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/isda-fpml-trader/bpmn/swap-lifecycle", highlight: 'cfo-suite', utilities: ['bpmn', 'validation', 'schema', 'pipeline'], endpoints: [{ name: 'isda-fpml-api', description: 'Trade capture, confirmation, and lifecycle events', status: 'Beta' }, { name: 'isda-fpml-api', description: 'Tri-party collateral management and margin calls', status: 'Beta' }] },
  { skillNumber: 63, skillMdmAddress: MDM_SKILLS.ISO20022_SETTLEMENT, name: 'ISO 20022 Settlement & Payment Agent', description: 'Order-to-cash DVP settlement — pain/pacs/camt lifecycle, on-chain USDT/XRP atomic delivery', iconHint: 'Landmark', colorToken: 'info', bgColorToken: 'info', domain: 'financial', subcategoryId: 'cfo-treasury-suite', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/iso20022-settlement/bpmn/dvp-settle", highlight: 'cfo-suite', utilities: ['bpmn', 'validation', 'schema', 'pipeline'], endpoints: [{ name: 'iso20022-settlement-api', description: 'pain.001 initiation → pacs.008 clearing → camt.053 reporting', status: 'Beta' }, { name: 'iso20022-settlement-api', description: 'DVP atomic settlement on XRPL (USDT/XRP)', status: 'Beta' }] },
  { skillNumber: 64, skillMdmAddress: MDM_SKILLS.TREASURY_PORTFOLIO,  name: 'Treasury Portfolio Manager', description: 'Orchestrator — composes Skills #59-63 into multi-strategy flows: raw materials → energy swaps → cash hedging → DVP settlement', iconHint: 'Coins', colorToken: 'primary', bgColorToken: 'primary', domain: 'financial', subcategoryId: 'cfo-treasury-suite', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/treasury-portfolio/bpmn/multi-strategy", highlight: 'cfo-suite', utilities: ['bpmn', 'validation', 'schema', 'pipeline'], endpoints: [{ name: 'treasury-portfolio-api', description: 'Multi-strategy orchestration with BPMN constraints', status: 'Beta' }, { name: 'treasury-portfolio-api', description: 'End-to-end flow: 7.77¢ on the dollar vs legacy intermediaries', status: 'Beta' }] },

  // ═══ Infrastructure: Communications & Scheduling ════════════
  { skillNumber: 10, skillMdmAddress: MDM_SKILLS.CALENDARING,         name: 'Calendaring Connectivity', description: 'Unified calendar connections and event management', iconHint: 'Calendar', colorToken: 'info', bgColorToken: 'info', domain: 'infrastructure', subcategoryId: 'communications-scheduling', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/calendaring/bpmn/calendar-connect", utilities: ['bpmn', 'schema'], endpoints: [{ name: 'unified-calendar-connect', description: 'Connect external calendars', status: 'Live' }, { name: 'create-calendar-event', description: 'Create calendar events', status: 'Live' }, { name: 'send-calendar-invite', description: 'Send event invitations', status: 'Live' }] },
  { skillNumber: 21, skillMdmAddress: MDM_SKILLS.CALENDARING,         name: 'Calendaring Agent', description: 'AI scheduling agent: find providers, book/reschedule/cancel appointments, check availability', iconHint: 'CalendarClock', colorToken: 'info', bgColorToken: 'info', domain: 'infrastructure', subcategoryId: 'communications-scheduling', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/calendaring/bpmn/agent-schedule", utilities: ['bpmn', 'validation', 'schema'], endpoints: [{ name: 'calendar-agent-api', description: 'Setup agent, schedule, reschedule, cancel appointments', status: 'Live' }, { name: 'smart-schedule-assistant', description: 'Natural language provider search & scheduling', status: 'Live' }, { name: 'create-calendar-event', description: 'Create Google Calendar events with Meet links', status: 'Live' }, { name: 'cappz-exchange', description: 'Acquire CAPPZ for appointment notarization', status: 'Live' }] },

  // ═══ Healthcare: Clinical Scheduling ═══════════════════════
  { skillNumber: 11, skillMdmAddress: MDM_SKILLS.CALENDARING,         name: 'Healthcare Calendaring', description: 'AI appointment scheduling with ICD-10 matching', iconHint: 'Stethoscope', colorToken: 'success', bgColorToken: 'success', domain: 'healthcare', subcategoryId: 'clinical-scheduling', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/calendaring/bpmn/healthcare-schedule", utilities: ['bpmn', 'validation', 'schema', 'pipeline'], endpoints: [{ name: 'smart-schedule-assistant', description: 'AI-powered provider search & scheduling', status: 'Live' }, { name: 'healthcare-book-appointment', description: 'Book appointment with provider', status: 'Live' }, { name: 'ehr-inbound-call', description: 'HIPAA-compliant voice task queue', status: 'Live' }] },

  // ═══ Healthcare: Prescription & Rx ═════════════════════════
  { skillNumber: 17, skillMdmAddress: MDM_SKILLS.PRESCRIPTION,        name: 'Prescription Management', description: 'Rx issuance, verification, fill tracking, fraud alerts', iconHint: 'Pill', colorToken: 'success', bgColorToken: 'success', domain: 'healthcare', subcategoryId: 'rx-management', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/prescription/bpmn/rx-lifecycle", utilities: ['bpmn', 'validation', 'schema'], endpoints: [{ name: 'prescription-api', description: 'Issue, verify, fill, fraud-check', status: 'Beta' }] },

  // ═══ Healthcare: Interoperability Adapters ═════════════════
  { skillNumber: 54, skillMdmAddress: MDM_SKILLS.HL7_ADAPTER,         name: 'HL7 FHIR Middleware Skill', description: 'Healthcare interop middleware — HL7 v2 ADT/ORU and FHIR R4 resource mapping with HIPAA compliance. Transport adapters import as constituents.', iconHint: 'Stethoscope', colorToken: 'success', bgColorToken: 'success', domain: 'healthcare', subcategoryId: 'interop-adapters', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/hl7-adapter/bpmn/fhir-map", utilities: ['bpmn', 'validation', 'schema', 'pipeline'], endpoints: [{ name: 'hl7-adapter-api', description: 'Parse HL7 v2 messages and map to FHIR resources', status: 'Live' }] },

  // ═══ Healthcare: Supply Chain ══════════════════════════════
  { skillNumber: 18, skillMdmAddress: MDM_SKILLS.BTC_SWAP_INIT,       name: 'BTC Tx Bridge', description: 'Bitcoin wallet ops and XRP-BTC atomic swaps via HTLCs', iconHint: 'ArrowLeftRight', colorToken: 'warning', bgColorToken: 'warning', domain: 'healthcare', subcategoryId: 'supply-chain', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/btc-swap-init/bpmn/supply-track", utilities: ['bpmn', 'validation'], endpoints: [{ name: 'btc-bridge-api', description: 'BTC wallet, atomic swap, balance queries', status: 'Beta' }] },

  // ═══ Infrastructure: Operations — Architecture & Governance ═
  { skillNumber: 67, skillMdmAddress: MDM_SKILLS.ARCHITECTURE,         name: 'Architecture & Design Principles', description: 'Pre-flight design vetting, build-log learning, anti-pattern detection — mandatory soul.md import for all agents. Enforces AX-00→AX-24 axioms and PF-01→PF-06 checklist.', iconHint: 'Shield', colorToken: 'destructive', bgColorToken: 'destructive', domain: 'infrastructure', subcategoryId: 'operations', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/architecture/bpmn/pre-flight-vet", utilities: ['bpmn', 'validation'], endpoints: [{ name: 'architecture-api', description: 'Pre-flight vetting, axiom enumeration, checkpoint validation', status: 'Live' }, { name: 'architecture-api', description: 'Build-log learning and anti-pattern detection', status: 'Live' }] },
  { skillNumber: 68, skillMdmAddress: MDM_SKILLS.DATA_SOURCE_ADAPTER,  name: 'Data Source Adapter', description: 'Pull-based golden source lifecycle — scheduled/on-demand/event-driven fetch with session wallet staging and BPMN ingest validation (AX-32, AX-33)', iconHint: 'Download', colorToken: 'info', bgColorToken: 'info', domain: 'infrastructure', subcategoryId: 'integration-communications', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/data-source-adapter/bpmn/pull-stage-validate", utilities: ['bpmn', 'validation', 'schema', 'pipeline'], endpoints: [{ name: 'adapter-api', description: 'Register, configure, and manage golden source adapters', status: 'Live' }, { name: 'adapter-api', description: 'Pull data, stage in session wallet, validate via BPMN ingest', status: 'Live' }, { name: 'adapter-api', description: 'Source refresh link management and delta detection', status: 'Live' }] },

  // ═══ Infrastructure: Operations — Stripe XRP Bridge ═════════
  { skillNumber: 72, skillMdmAddress: MDM_SKILLS.STRIPE_XRP_BRIDGE,    name: 'Stripe XRP Bridge (Transfer Agent)', description: 'Fiat-to-XRP bridge via Stripe — card funding → XRP → CAPPZ with HD receivables delivery and auto-conversion', iconHint: 'CreditCard', colorToken: 'success', bgColorToken: 'success', domain: 'infrastructure', subcategoryId: 'operations', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/stripe-xrp-bridge/bpmn/fiat-bridge", utilities: ['bpmn', 'validation', 'pipeline'], endpoints: [{ name: 'stripe-bridge-api', description: 'Initiate fiat payment intent and generate checkout URL', status: 'Live' }, { name: 'stripe-bridge-api', description: 'Confirm payment, acquire XRP, deliver to receivables address', status: 'Live' }, { name: 'stripe-bridge-api', description: 'Exchange rate query with 60s TTL oracle cache', status: 'Live' }, { name: 'stripe-bridge-api', description: 'Estimate XRP/CAPPZ output with fee breakdown', status: 'Live' }] },

  // ═══ Healthcare: Interoperability Adapters ════════════════
  { skillNumber: 73, skillMdmAddress: MDM_SKILLS.CHARM_ADAPTER,        name: 'Charm Health Adapter', description: 'HIPAA-compliant dual-transport EHR adapter — PDF parse → field map → encrypt → cryptographic shred (AX-25) with zero-PHI residual', iconHint: 'Stethoscope', colorToken: 'success', bgColorToken: 'success', domain: 'healthcare', subcategoryId: 'interop-adapters', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/charm-adapter/bpmn/ehr-migrate", utilities: ['bpmn', 'validation', 'schema', 'pipeline'], endpoints: [{ name: 'charm-adapter-api', description: 'Parse patient PDF and extract demographics', status: 'Live' }, { name: 'charm-adapter-api', description: 'Map fields to Charm schema with duplicate detection', status: 'Live' }, { name: 'charm-adapter-api', description: 'Encrypt and stage patient record for commit', status: 'Live' }, { name: 'charm-adapter-api', description: 'Execute cryptographic shred post-commit (AX-25)', status: 'Live' }] },

  // ═══ Infrastructure: Operations — CID Admin Dashboard ═════════
  { skillNumber: 75, skillMdmAddress: MDM_SKILLS.CID_ADMIN,             name: 'CID Admin Dashboard', description: 'Devnet→Mainnet state diff engine, edge function deprecation tracker, prod release plan generator with BPMN-governed migration workflows', iconHint: 'Shield', colorToken: 'destructive', bgColorToken: 'destructive', domain: 'infrastructure', subcategoryId: 'operations', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/cid-admin/bpmn/dev-to-prod", utilities: ['bpmn', 'validation', 'schema', 'pipeline'], endpoints: [{ name: 'cid-admin-api', description: 'State diff engine — compare HD hashes across networks', status: 'Live' }, { name: 'cid-admin-api', description: 'Edge function migration inventory and status', status: 'Live' }, { name: 'cid-admin-api', description: 'Prod release plan generation with ops-log persistence', status: 'Live' }] },

  // ═══ Infrastructure: Operations — Legacy Archive (CID child skill) ═════════
  { skillNumber: 76, skillMdmAddress: "m/44'/144'/0'/cappz/skills/legacy-archive", name: 'Legacy Server Archive', description: 'Notarized HD-addressed archive of 97 edge functions and 268 DB schemas from the pre-middleware era — immutable provenance chain with resident admin agent', iconHint: 'Archive', colorToken: 'secondary', bgColorToken: 'secondary', domain: 'infrastructure', subcategoryId: 'operations', bpmnCorrelation: "m/44'/144'/50'/bpmn/legacy-archive-notarize", utilities: ['schema', 'validation', 'pipeline'], endpoints: [{ name: 'legacy-archive-api', description: 'Query archived edge function by HD address', status: 'Live' }, { name: 'legacy-archive-api', description: 'CID diff — compare archive against active middleware', status: 'Live' }, { name: 'legacy-archive-api', description: 'Export notarized table schema at HD address', status: 'Live' }] },

  // ═══ Infrastructure: Operations — Sovereign Infrastructure (v6) ═
  { skillNumber: 69, skillMdmAddress: MDM_SKILLS.INCLUDE_PROTOCOL,     name: 'Include Skill Protocol', description: 'Runtime versioned skill binding with edge-load-balanced sibling state transfer (AX-34, PROV-018 patentable)', iconHint: 'Plug', colorToken: 'primary', bgColorToken: 'primary', domain: 'infrastructure', subcategoryId: 'operations', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/include-protocol/bpmn/skill-bind", utilities: ['bpmn', 'validation'], endpoints: [{ name: 'include-protocol-api', description: 'Bind, unbind, and version skills at runtime', status: 'Live' }] },
  { skillNumber: 70, skillMdmAddress: MDM_SKILLS.CLONE_AUTH,            name: 'Clone Auth Protocol', description: 'Authenticated agent initialization — identity hashing, classification NORMAL/MIGRATION/UNAUTHORIZED (AX-35)', iconHint: 'Shield', colorToken: 'destructive', bgColorToken: 'destructive', domain: 'infrastructure', subcategoryId: 'operations', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/clone-auth/bpmn/clone-classify", utilities: ['bpmn', 'validation'], endpoints: [{ name: 'clone-auth-api', description: 'Authenticate and classify agent initialization', status: 'Live' }] },
  { skillNumber: 71, skillMdmAddress: MDM_SKILLS.HD_SIGNAL_ROUTER,      name: 'HD Signal Router', description: 'Direct/broadcast/multicast signal routing using HD wallet tree as network topology (AX-36)', iconHint: 'Radio', colorToken: 'info', bgColorToken: 'info', domain: 'infrastructure', subcategoryId: 'integration-communications', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/hd-signal-router/bpmn/route-signal", utilities: ['bpmn', 'schema'], endpoints: [{ name: 'hd-signal-api', description: 'Route signals via HD address topology', status: 'Live' }] },

  // ═══ Healthcare: Medical Office Operations ══════════════════
  { skillNumber: 74, skillMdmAddress: MDM_SKILLS.MEDICAL_OFFICE_OPS,    name: 'Medical Office Operations', description: 'Clinic workflow automation — patient check-in, referral management, billing reconciliation with EHR integration', iconHint: 'Building2', colorToken: 'success', bgColorToken: 'success', domain: 'healthcare', subcategoryId: 'clinical-scheduling', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/medical-office-ops/bpmn/clinic-workflow", utilities: ['bpmn', 'validation', 'schema'], endpoints: [{ name: 'medical-office-api', description: 'Patient check-in, referral, and billing automation', status: 'Beta' }] },

  // ═══ Infrastructure: Operations — AI & Discovery ═══════════
  { skillNumber: 77, skillMdmAddress: MDM_SKILLS.DUAL_MODE_INFERENCE,   name: 'Dual-Mode AI Inference', description: 'Cloud Gemini + Edge Ollama/LM Studio unified adapter with auto-fallback and offline outbox queuing', iconHint: 'Brain', colorToken: 'primary', bgColorToken: 'primary', domain: 'infrastructure', subcategoryId: 'middleware-messaging', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/dual-mode-inference/bpmn/infer-route", utilities: ['bpmn', 'schema', 'pipeline'], endpoints: [{ name: 'inference-api', description: 'Unified AI inference with cloud/edge auto-fallback', status: 'Live' }] },
  { skillNumber: 78, skillMdmAddress: MDM_SKILLS.DISCOVERY_SERVICE,     name: 'Discovery-as-a-Service', description: 'Scope-pinned reasoning with corpus licensing, novelty detection, prior-art XRPL anchoring, and citation royalty flywheel', iconHint: 'Lightbulb', colorToken: 'warning', bgColorToken: 'warning', domain: 'infrastructure', subcategoryId: 'codex-knowledge', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/discovery-service/bpmn/daas-pipeline", utilities: ['bpmn', 'validation', 'schema'], endpoints: [{ name: 'discovery-api', description: 'Scope-pinned reasoning with novelty detection', status: 'Beta' }] },
  { skillNumber: 79, skillMdmAddress: MDM_SKILLS.DISCOVERY_AGENT,       name: 'Discovery Agent', description: 'BPMN-governed Hypothesize→Simulate→Detect Novelty→Anchor→Notify workflow with dual monetization', iconHint: 'Microscope', colorToken: 'success', bgColorToken: 'success', domain: 'infrastructure', subcategoryId: 'codex-knowledge', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/discovery-agent/bpmn/hypothesize-anchor", utilities: ['bpmn', 'validation', 'schema'], endpoints: [{ name: 'discovery-agent-api', description: 'Execute discovery workflow with XRPL anchoring', status: 'Beta' }] },
  { skillNumber: 80, skillMdmAddress: MDM_SKILLS.CORPUS_LICENSE,        name: 'Corpus License Manager', description: 'Per-clone licensing and version upgrades for pinned ontology corpora — license lifecycle with royalty tracking', iconHint: 'FileCheck', colorToken: 'info', bgColorToken: 'info', domain: 'infrastructure', subcategoryId: 'codex-knowledge', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/corpus-license/bpmn/license-lifecycle", utilities: ['bpmn', 'validation'], endpoints: [{ name: 'corpus-license-api', description: 'License grant, upgrade, and royalty distribution', status: 'Beta' }] },

  // ═══ Infrastructure: Codex & Knowledge — Canon Skills ═══════
  { skillNumber: 84, skillMdmAddress: MDM_SKILLS.PESHITTA,              name: 'Peshitta Canon Skill', description: 'Sovereign Peshitta Bible Canon — Aramaic/Syriac original with English (Lamsa 1933) translation, HD-addressed verse provenance', iconHint: 'BookOpen', colorToken: 'warning', bgColorToken: 'warning', domain: 'infrastructure', subcategoryId: 'codex-knowledge', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/peshitta/bpmn/canon-navigate", utilities: ['bpmn', 'schema'], endpoints: [{ name: 'peshitta-api', description: 'Navigate Peshitta books, chapters, verses', status: 'Planned' }] },
  { skillNumber: 85, skillMdmAddress: MDM_SKILLS.WLC,                   name: 'WLC Canon Skill', description: 'Sovereign Westminster Leningrad Codex — Hebrew original with English (JPS 1917) translation, HD-addressed verse provenance', iconHint: 'BookOpen', colorToken: 'info', bgColorToken: 'info', domain: 'infrastructure', subcategoryId: 'codex-knowledge', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/wlc/bpmn/canon-navigate", utilities: ['bpmn', 'schema'], endpoints: [{ name: 'wlc-api', description: 'Navigate WLC books, chapters, verses', status: 'Planned' }] },
  { skillNumber: 86, skillMdmAddress: MDM_SKILLS.NESTLE_1904,           name: 'Nestle 1904 Canon Skill', description: 'Sovereign Nestle 1904 GNT — Greek original with English (ASV 1901) translation, HD-addressed verse provenance', iconHint: 'BookOpen', colorToken: 'primary', bgColorToken: 'primary', domain: 'infrastructure', subcategoryId: 'codex-knowledge', bpmnCorrelation: "m/44'/144'/0'/cappz/agency/skills/nestle-1904/bpmn/canon-navigate", utilities: ['bpmn', 'schema'], endpoints: [{ name: 'nestle1904-api', description: 'Navigate Nestle 1904 books, chapters, verses', status: 'Planned' }] },

  // ═══ Infrastructure: Operations — Cloneable Wallet Templates (v11-2-023) ═
  { skillNumber: 87, skillMdmAddress: "m/44'/144'/0'/cappz/templates/build", name: 'Build Template', description: 'Cloneable Build template with embedded BuildAgent (AX-95), CPM packaging, build-agent-cycle BPMN. Users clone to run their own versioned code builds and package artifacts.', iconHint: 'Wrench', colorToken: 'primary', bgColorToken: 'primary', domain: 'infrastructure', subcategoryId: 'operations', bpmnCorrelation: "m/44'/144'/0'/cappz/templates/build/bpmn/build-agent-cycle", utilities: ['bpmn', 'validation', 'pipeline'], endpoints: [{ name: 'build-template-api', description: 'Clone Build template into user-owned wallet', status: 'Beta' }, { name: 'build-template-api', description: 'Emit ArtifactGenerated + BuildConstituentIncluded TXs per clone', status: 'Beta' }] },
  { skillNumber: 88, skillMdmAddress: "m/44'/144'/0'/cappz/templates/rbac",  name: 'RBAC Template',  description: 'Cloneable RBAC template with embedded RbacAgent (AX-95), constituency-admission BPMN, role-capability binding. Users clone to create sovereign governance groups with invite/request/approve/revoke verbs — all TX-derived.', iconHint: 'Users', colorToken: 'destructive', bgColorToken: 'destructive', domain: 'infrastructure', subcategoryId: 'identity-infosec', bpmnCorrelation: "m/44'/144'/0'/cappz/templates/rbac/bpmn/constituency-admission", utilities: ['bpmn', 'validation'], endpoints: [{ name: 'rbac-template-api', description: 'Clone RBAC template — creator becomes founding admin via genesis handshake', status: 'Beta' }, { name: 'rbac-template-api', description: 'Invite / request / approve / revoke role constituency', status: 'Beta' }, { name: 'rbac-template-api', description: 'Bind role capability to any user-owned app address (AllAccessGranted)', status: 'Beta' }] },

];

// ─── Query Helpers ─────────────────────────────────────────────

/** Get all subcategories for a domain, sorted */
export function getSubcategoriesForDomain(domain: SkillDomain): SkillSubcategory[] {
  return ALL_SUBCATEGORIES
    .filter(sc => sc.domain === domain)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/** Get all skill classification entries for a subcategory */
export function getSkillsForSubcategory(subcategoryId: string): SkillClassificationEntry[] {
  return SKILL_CLASSIFICATIONS.filter(sc => sc.subcategoryId === subcategoryId);
}

/** Get all skill numbers for a domain */
export function getSkillNumbersForDomain(domain: SkillDomain): number[] {
  return SKILL_CLASSIFICATIONS
    .filter(sc => sc.domain === domain)
    .map(sc => sc.skillNumber);
}

/** Get classification for a specific skill number */
export function getSkillClassification(skillNumber: number): SkillClassificationEntry | undefined {
  return SKILL_CLASSIFICATIONS.find(sc => sc.skillNumber === skillNumber);
}

/** Get skills missing a specific utility */
export function getSkillsMissingUtility(utility: SkillUtilityCode): SkillClassificationEntry[] {
  return SKILL_CLASSIFICATIONS.filter(sc => !sc.utilities?.includes(utility));
}

/** Get utility summary for a skill */
export function getSkillUtilities(skillNumber: number): SkillUtilityCode[] {
  return getSkillClassification(skillNumber)?.utilities ?? [];
}

/** Get domain config for rendering */
export const DOMAIN_CONFIG: Record<SkillDomain, { label: string; iconHint: string; colorToken: string }> = {
  infrastructure: { label: 'Infrastructure', iconHint: 'Server', colorToken: 'primary' },
  financial:      { label: 'Financial — Capital Markets · Banking · Insurance', iconHint: 'Landmark', colorToken: 'warning' },
  healthcare:     { label: 'Healthcare & Rx', iconHint: 'Stethoscope', colorToken: 'success' },
};

/** Ordered domain list for rendering */
export const DOMAIN_ORDER: SkillDomain[] = ['infrastructure', 'financial', 'healthcare'];

/** Total endpoints across all skills */
export function getTotalEndpoints(): number {
  return SKILL_CLASSIFICATIONS.reduce((sum, s) => sum + s.endpoints.length, 0);
}

/** Live count of governed skills — single source of truth for marketing surfaces. */
export const SKILL_COUNT: number = SKILL_CLASSIFICATIONS.length;
