/**
 * paths.ts — Centralized HD path constants and builders (AP-17 / AX-59).
 *
 * SINGLE SOURCE OF TRUTH for all non-Bible HD paths in the codebase.
 * Bible Codex paths live in `src/lib/bible/BibleCodexPaths.ts` (legacy
 * domain-specific module retained for backward compatibility).
 *
 * Rule: outside this module (and the per-wallet definition files in
 * `src/lib/wallets/*-wallet.ts`, `industry.ts`, `ip-wallet.ts`,
 * `calendaring.ts`, `build-log-wallet.ts`, `architecture-wallet.ts`,
 * `cappz-overview-wallet.ts`, `legacy-server-v5-archive-wallet.ts`),
 * functional code MUST NOT contain raw `m/44'/...` string literals.
 * An ESLint rule (`no-restricted-syntax` for HD path Literals) enforces
 * this in `eslint.config.js`.
 *
 * Display-only labels (registry tables, doc strings, BPMN comments,
 * MetatronPage label arrays, DownloadsPage tag chips) are exempt.
 */

// ─── BIP-44 Coin Type ────────────────────────────────────────────

/** XRPL BIP-44 coin type (SLIP-0044 #144) */
export const COIN_TYPE_XRPL = 144;

/** Root prefix for all XRPL HD wallets */
export const XRPL_ROOT = `m/44'/${COIN_TYPE_XRPL}'`;

// ─── Wallet Account Indices (BIP-44 account level) ───────────────

/**
 * Canonical BIP-44 account indices for each top-level wallet.
 * These mirror `rootPath` in the corresponding `src/lib/wallets/*.ts`
 * files; changing one without the other is a bug.
 */
export const WALLET_ACCOUNT = {
  /** Heaven (substrate / GodHead) — m/44'/144'/0' */
  HEAVEN: 0,
  /** Void (substrate / Hell) — m/44'/144'/1' */
  VOID: 1,
  /** Fallen (substrate / Adversaries) — m/44'/144'/2' */
  FALLEN: 2,
  /** Timeline (substrate / Aeons) — m/44'/144'/3' */
  TIMELINE: 3,
  /** ISO 20022 — m/44'/144'/20' */
  ISO20022: 20,
  /** FpML / ISDA — m/44'/144'/21' */
  FPML: 21,
  /** FIX Protocol — m/44'/144'/22' */
  FIX: 22,
  /** ACORD AL3 (Insurance) — m/44'/144'/23' */
  AL3: 23,
  /** HL7 / FHIR (Healthcare) — m/44'/144'/24' */
  HL7: 24,
  /** Custom enterprise-derived — m/44'/144'/25' */
  CUSTOM: 25,
  /** Universal Calendaring — m/44'/144'/26' */
  CALENDARING: 26,
  /** IP Management — m/44'/144'/30' */
  IP: 30,
  /** Architecture — m/44'/144'/40' */
  ARCHITECTURE: 40,
  /** Build log — m/44'/144'/41' */
  BUILD_LOG: 41,
  /** CAPPZ overview — m/44'/144'/42' */
  CAPPZ_OVERVIEW: 42,
  /** CAPPZ Metatron platform agent — m/44'/144'/43' (v11-13) */
  METATRON: 43,
  /** Legacy server v5 archive — m/44'/144'/50' */
  LEGACY_V5_ARCHIVE: 50,
  /** RepoZ source and artifact versions — m/44'/144'/100' */
  REPOZ: 100,
  /** Reserved fallback for unknown domains — m/44'/144'/99' */
  UNASSIGNED: 99,
} as const;

export type WalletAccountKey = keyof typeof WALLET_ACCOUNT;

// ─── Root Path Builder ───────────────────────────────────────────

/** Build a canonical wallet root path for a BIP-44 account index. */
export function walletRoot(accountIndex: number): string {
  return `${XRPL_ROOT}/${accountIndex}'`;
}

// ─── Pre-derived Wallet Root Paths ───────────────────────────────

/**
 * Pre-derived roots for every named wallet account.
 * Prefer these constants over calling `walletRoot()` at usage sites
 * — they enable static analysis and grep-ability.
 */
export const WALLET_ROOTS = {
  HEAVEN: walletRoot(WALLET_ACCOUNT.HEAVEN),
  VOID: walletRoot(WALLET_ACCOUNT.VOID),
  FALLEN: walletRoot(WALLET_ACCOUNT.FALLEN),
  TIMELINE: walletRoot(WALLET_ACCOUNT.TIMELINE),
  ISO20022: walletRoot(WALLET_ACCOUNT.ISO20022),
  FPML: walletRoot(WALLET_ACCOUNT.FPML),
  FIX: walletRoot(WALLET_ACCOUNT.FIX),
  AL3: walletRoot(WALLET_ACCOUNT.AL3),
  HL7: walletRoot(WALLET_ACCOUNT.HL7),
  CUSTOM: walletRoot(WALLET_ACCOUNT.CUSTOM),
  CALENDARING: walletRoot(WALLET_ACCOUNT.CALENDARING),
  IP: walletRoot(WALLET_ACCOUNT.IP),
  ARCHITECTURE: walletRoot(WALLET_ACCOUNT.ARCHITECTURE),
  BUILD_LOG: walletRoot(WALLET_ACCOUNT.BUILD_LOG),
  CAPPZ_OVERVIEW: walletRoot(WALLET_ACCOUNT.CAPPZ_OVERVIEW),
  METATRON: walletRoot(WALLET_ACCOUNT.METATRON),
  LEGACY_V5_ARCHIVE: walletRoot(WALLET_ACCOUNT.LEGACY_V5_ARCHIVE),
  REPOZ: walletRoot(WALLET_ACCOUNT.REPOZ),
  UNASSIGNED: walletRoot(WALLET_ACCOUNT.UNASSIGNED),
} as const;

// ─── Domain → Wallet Root Mapping ────────────────────────────────

/**
 * Industry domain identifier → wallet root.
 * Replaces ad-hoc `DOMAIN_ROOTS` maps duplicated in `agent-context.ts`,
 * `wallet-agent.ts`, etc. Single source of truth for domain resolution.
 */
export const DOMAIN_ROOTS: Record<string, string> = {
  FpML: WALLET_ROOTS.FPML,
  ISO20022: WALLET_ROOTS.ISO20022,
  FIX: WALLET_ROOTS.FIX,
  AL3: WALLET_ROOTS.AL3,
  HL7: WALLET_ROOTS.HL7,
  Custom: WALLET_ROOTS.CUSTOM,
  MDM: WALLET_ROOTS.HEAVEN,
};

/** Resolve a domain to its wallet root, falling back to UNASSIGNED. */
export function domainRoot(domain: string): string {
  return DOMAIN_ROOTS[domain] ?? WALLET_ROOTS.UNASSIGNED;
}

// ─── Heaven Wallet Sub-Path Builders ─────────────────────────────

/** Build a path under the Heaven (cappz) namespace. */
export function cappzPath(...segments: string[]): string {
  return [WALLET_ROOTS.HEAVEN, 'cappz', ...segments].join('/');
}

// ─── Slash-Address Security Roots ────────────────────────────────

/** Build a governed slash-address under /Security. */
export function securityPath(...segments: string[]): string {
  return ['/Security', ...segments].join('/');
}

export const SECURITY_ROOTS = {
  ROOT: securityPath(),
  USERS: securityPath('Users'),
  ROLES: securityPath('Roles'),
  BPMN: securityPath('BPMN'),
  ROLE_ADMIN: securityPath('Roles', 'Admin'),
  /** v11-2-023 — codex-steward role for bible-codex governance. */
  ROLE_CODEX_STEWARD: securityPath('Roles', 'CodexSteward'),
} as const;

// ─── Wallet Template Roots (v11-2-023 / Part E) ──────────────────

/** Root under which cloneable wallet templates live. */
export const TEMPLATE_ROOT = cappzPath('templates');
export const TEMPLATE_PATHS = {
  BUILD: `${TEMPLATE_ROOT}/build`,
  RBAC: `${TEMPLATE_ROOT}/rbac`,
} as const;

/** User-scoped clone paths under a template family. */
export function templateClonePath(family: 'build' | 'rbac', userIndex: number | string, slug: string): string {
  return `${WALLET_ROOTS.HEAVEN}/users/${String(userIndex)}/${family}/${slug}`;
}

// ─── Wallet Tiers (v12-08) ───────────────────────────────────────
//
// PTW (Prime Template Wallet)  — admin-only content, immutable to users.
// POW (Prime Operational Wallet) — what the UI binds to; holds the shared
//   agent and the Public Session; canon content is a by-ref copy of the PTW.
// User wallet — owned clone derived under the user's own account root.

/** Root under which Prime Operational Wallets live. */
export const OPERATIONAL_ROOT = cappzPath('operational');

/** Prime Operational Wallet root for a template slug (e.g. 'bible-codex'). */
export function operationalRoot(slug: string): string {
  return `${OPERATIONAL_ROOT}/${slug}`;
}

/** Notarizer app wallet tiers. Receipts are indexed in POW/UAW event logs. */
export const NOTARIZER_APP_SLUG = 'notarizer';
export const NOTARIZER_PTW_ROOT = cappzPath('templates', NOTARIZER_APP_SLUG);
export const NOTARIZER_POW_ROOT = operationalRoot(NOTARIZER_APP_SLUG);

/** Replicator app POW; the sync market's default arbiter is a POW account (v15-04-00). */
export const REPLICATOR_APP_SLUG = 'replicator';
export const REPLICATOR_POW_ROOT = operationalRoot(REPLICATOR_APP_SLUG);
export const SYNC_MARKET_ARBITER = `${REPLICATOR_POW_ROOT}/sync-market/arbiter`;

/** One user's Notarizer application wallet beneath the canonical UPT account. */
export function notarizerUawRoot(userIndex: number | string): string {
  return userInstanceRoot(userIndex, NOTARIZER_APP_SLUG);
}

// ─── Account-level groups (v12-20-05-groups) ─────────────────────
//
// Every entity is an account (HEWN, app PTW/PTO, UAW, PAW, agent). Each
// account owns two group sub-accounts; membership changes only through
// GroupMemberAdded / GroupMemberRemoved. Mirrors
// supabase/functions/_shared/adminSubstrate.ts.

export type GroupAccountKind = 'administrators' | 'members';

/** HEWN account root — the platform account. */
export const HEWN_ACCOUNT_ROOT = WALLET_ROOTS.HEAVEN;

/** A group sub-account of any account. */
export function accountGroupPath(accountRoot: string, kind: GroupAccountKind): string {
  return `${accountRoot}/security/groups/${kind}`;
}

/** Platform Account Wallet — a person's account; their login lives here. */
export function pawRoot(userIndex: number | string): string {
  return `${WALLET_ROOTS.HEAVEN}/users/${String(userIndex)}`;
}

/**
 * Normalize any address to its account: group sub-accounts resolve to their
 * owner, derived signing addresses (`…/<change>/<index>`) to the account.
 */
const GROUP_MARKER = '/security/groups/';

export function accountOf(address: string): string {
  const g = address.indexOf(GROUP_MARKER);
  if (g >= 0) {
    // Guard: only a well-formed single-segment group suffix normalizes;
    // a doubled or malformed path is returned unchanged (v12-21-12).
    const groupSegment = address.slice(g + GROUP_MARKER.length);
    if (groupSegment && !groupSegment.includes('/') && !groupSegment.includes(GROUP_MARKER)) {
      return address.slice(0, g);
    }
    return address;
  }
  const m = address.match(/^(.*)\/\d+\/\d+$/);
  return m ? m[1] : address;
}

/** App-level group inside an app operational wallet (PTO/POW). */
export function appGroupPath(slug: string, group: GroupAccountKind): string {
  return accountGroupPath(operationalRoot(slug), group);
}

/** v12-20-04-admin — admin app (PTW → POW on cappz.ai, embedded admin agent). */
export const ADMIN_APP_SLUG = 'cappz-admin';

/** A login account's security principal under /Security/Users. */
export function securityUserAddress(email: string): string {
  return securityPath('Users', email.trim().toLowerCase());
}

/** The user's own account wallet root — parent of everything the user owns. */
export function userAccountRoot(userIndex: number | string): string {
  return `${WALLET_ROOTS.HEAVEN}/users/${String(userIndex)}`;
}

/** A template instance owned by the user, derived under their account root. */
export function userInstanceRoot(userIndex: number | string, slug: string): string {
  return `${userAccountRoot(userIndex)}/${slug}`;
}

/** The user's alias identity address (pseudonymous attribution). */
export function userAliasAddress(userIndex: number | string): string {
  return `${userAccountRoot(userIndex)}/identity/alias`;
}

/** v14-05-00: alias address of any wallet (copy, app, device) — one fixed slot, no hunting. */
export function walletAliasAddress(walletRoot: string): string {
  return `${walletRoot}/identity/alias`;
}

/** v15-09-00: one identity claim (salted digest, encrypted value) in a wallet's identity subtree. */
export function identityClaimAddress(walletRoot: string, claimType: string, claimId: string): string {
  return `${walletRoot}/identity/claims/${claimType}/${claimId}`;
}

/** v15-09-00: an issuer's attestation over claim digests, filed in the subject's identity subtree. */
export function identityAttestationAddress(walletRoot: string, attestationId: string): string {
  return `${walletRoot}/identity/attestations/${attestationId}`;
}

/** v15-09-00: one disclosure exchange (request, answer) between a verifier and this wallet. */
export function identityDisclosureAddress(walletRoot: string, requestId: string): string {
  return `${walletRoot}/identity/disclosures/${requestId}`;
}

/** v15-09-00: one key the wallet declared (hello, tls, signing, encryption), and its revocation. */
export function keyDeclarationAddress(walletRoot: string, keyId: string): string {
  return `${walletRoot}/identity/keys/${keyId}`;
}

/** Root of a Replicator demo/replica copy wallet. */
export function replicaCopyRoot(copyId: string): string {
  return `m/44'/144'/0'/cappz/apps/replicator/copies/${copyId}`;
}

/** v14-06-00: Replicator Network root — all copies/clones of one wallet lineage. */
export function replicatorNetworkRoot(walletRoot: string): string {
  return `${walletRoot}/replicator/network`;
}

/**
 * v15-05-00: one device of one copy in a Replicator network — the internal
 * address its endpoint record (CopyEndpointRegistered) is written at. Every
 * copy holds the whole member table, like a NetBIOS name table.
 */
export function copyDeviceAddress(networkRoot: string, copyId: string, deviceId: string): string {
  return `${networkRoot}/members/${copyId}/devices/${deviceId}`;
}

/** v14-06-00: durable peer-to-peer channel inside a network (id = sorted party pair). */
export function channelAddress(networkRoot: string, channelId: string): string {
  return `${networkRoot}/channels/${channelId}`;
}

/** v14-06-00: one flow (session) inside a channel. */
export function channelSessionAddress(channelAddr: string, sessionId: string): string {
  return `${channelAddr}/sessions/${sessionId}`;
}

// ─── v11-13 — platform agent slugs ───────────────────────────────

/** Slug of the platform-wide CAPPZ Metatron agent (PTW + POW). */
export const CAPPZ_METATRON_SLUG = 'cappz-metatron';

/** Slug of the per-user site-level wallet (primary operational wallet). */
export const CAPPZ_USER_SLUG = 'cappz-user';

/**
 * The user's library zone — the replayed catalog of every user application
 * wallet they own. Lives inside the cappz-user wallet.
 */
export function userLibraryAddress(userIndex: number | string): string {
  return `${userInstanceRoot(userIndex, CAPPZ_USER_SLUG)}/library`;
}

/** The App Template Wallet a user instance is registered against. */
export function appTemplateRoot(slug: string): string {
  return `${TEMPLATE_ROOT}/${slug}`;
}

/** Build a config sub-path under cappz. */
export function cappzConfigPath(...segments: string[]): string {
  return cappzPath('config', ...segments);
}

/** v15-09-00: MDM account of one transport type (src/lib/sync/transportTypes.ts). */
export function transportTypeAddress(typeId: string): string {
  return cappzConfigPath('transports', typeId);
}

/** v15-09-00: one configured carrier of a Replicator channel, cross-referencing its transport type. */
export function channelTransportAddress(channelAddr: string, transportId: string): string {
  return `${channelAddr}/transports/${transportId}`;
}

/** v15-09-00: one file held in a DMZ node's quarantine, by content hash (src/lib/sync/quarantine.ts). */
export function dmzQuarantineAddress(nodeRoot: string, sha256: string): string {
  return `${nodeRoot}/dmz/quarantine/${sha256}`;
}

/** Build a skill sub-path under cappz. */
export function cappzSkillPath(skillName: string, ...segments: string[]): string {
  return cappzPath('skills', skillName, ...segments);
}

/** Build a CID sub-path under cappz (e.g. release plans, page registries). */
export function cappzCidPath(...segments: string[]): string {
  return cappzPath('cid', ...segments);
}

/** Build a refdata sub-path under cappz. */
export function cappzRefdataPath(...segments: string[]): string {
  return cappzPath('refdata', ...segments);
}

// ─── User-Scoped Path Builder ────────────────────────────────────

/**
 * Build a user-scoped sub-path under any wallet root.
 * Used for clones, agent admin queues, user codex libraries, etc.
 */
export function userScopedPath(rootPath: string, userIndex: number | string, ...segments: string[]): string {
  return [rootPath, 'users', String(userIndex), ...segments].join('/');
}

// ─── Operational Status Addresses (cappz/WalletAgent) ────────────

const WALLET_AGENT_BASE = cappzPath('WalletAgent');

export const MDM_OPERATIONAL_STATUS = {
  SANDBOX: `${WALLET_AGENT_BASE}/OperationalStatus/Sandbox`,
  OPERATIONAL: `${WALLET_AGENT_BASE}/OperationalStatus/Operational`,
  HIBERNATED: `${WALLET_AGENT_BASE}/OperationalStatus/Hibernated`,
} as const;

export type OperationalStatusAddress = typeof MDM_OPERATIONAL_STATUS[keyof typeof MDM_OPERATIONAL_STATUS];

// ─── Sync-on-Async Config Addresses ──────────────────────────────

const SYNC_ON_ASYNC_BASE = cappzConfigPath('sync-on-async');

export const SYNC_ON_ASYNC_CONFIG = {
  SESSION_TIMEOUT: `${SYNC_ON_ASYNC_BASE}/session-timeout`,
  MAX_POLL_WAIT: `${SYNC_ON_ASYNC_BASE}/max-poll-wait`,
  POLL_INTERVAL: `${SYNC_ON_ASYNC_BASE}/poll-interval`,
  ENVELOPE_STORE: `${SYNC_ON_ASYNC_BASE}/envelope-store`,
  ENVELOPE_TTL: `${SYNC_ON_ASYNC_BASE}/envelope-ttl`,
} as const;

// ─── Chainlet Store Config Roots ─────────────────────────────────

export const CHAINLET_STORE_CONFIG_ROOT = cappzConfigPath('chainlet-store');
export const EVENT_TYPE_MDM_ROOT = cappzConfigPath('event-types');

// ─── Middleware / Wallet-Ops Skill Addresses ─────────────────────

export const MIDDLEWARE_SKILL_MDM = cappzSkillPath('middleware');
export const MIGRATION_STATUS_MDM = cappzSkillPath('wallet-ops', 'migration-status');
export const STANDARDS_INGEST_SKILL_ADDRESS = cappzSkillPath('mdm-standards-ingest');

// ─── 3C Comms Channel Root ───────────────────────────────────────

export const COMMS_3C_BASE_PATH = `${WALLET_ROOTS.HEAVEN}/3c`;

// ─── Release Plan Roots ──────────────────────────────────────────

export const RELEASE_PLAN_ROOT = cappzCidPath('release-plans');
export const CAPPZ_NAMESPACE_ROOT = cappzPath();

// ─── BIP-44 Address Path Builder (account/change/index) ──────────

/**
 * Build a standard BIP-44 receive/change address under an account root.
 * e.g. `bip44Address(WALLET_ROOTS.HEAVEN, 0, 0)` → `m/44'/144'/0'/0/0`.
 */
export function bip44Address(accountRoot: string, change: number, index: number): string {
  return `${accountRoot}/${change}/${index}`;
}

// ─── HEWN (Head Entropy Wallet Notary) ───────────────────────────

/**
 * HEWN root — the operator's head entropy notary account.
 * The seed is never stored (Zero-Storage Secrets); only addresses and
 * signatures are persisted.
 */
export const HEWN_ROOT = WALLET_ROOTS.HEAVEN;

/** HEWN admin account address — signer of platform delegation grants. */
export const HEWN_ADMIN_ADDRESS = bip44Address(HEWN_ROOT, 0, 0);

/** Agent-owned session descendants; IDs never encode display labels. */
export function agentSessionPath(parent: string, ...parts: string[]): string { return `${parent}/${parts.join("/")}`; }
