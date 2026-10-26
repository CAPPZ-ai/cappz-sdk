/**
 * SkillBuildLog — Clone-scoped build-log for structural versioning.
 *
 * TD-006: Each skill clone maintains a local build-log tracking
 * BPMN versioning, pipeline transforms, schema amendments, etc.
 * Edge learnings are synthesized as federated capabilities.
 *
 * Storage: clone's HD branch at {clonePath}/build-log/
 * Sync: A2A upchain to parent template for aggregation
 */

import type { BuildLogEntry, BuildLogCategory, BuildLogSummary } from './SkillCloneTypes';

export class SkillBuildLog {
  private readonly _entries: BuildLogEntry[] = [];
  private readonly _skillId: string;
  private readonly _walletAddress: string;
  private _versionCounter = 0;

  constructor(skillId: string, walletAddress: string) {
    this._skillId = skillId;
    this._walletAddress = walletAddress;
  }

  /**
   * Log a structural change to this skill clone.
   */
  log(
    category: BuildLogCategory,
    description: string,
    changeSummary: { before?: Record<string, unknown>; after: Record<string, unknown> },
    relatedOperationId?: string,
  ): BuildLogEntry {
    this._versionCounter++;
    const entry: BuildLogEntry = {
      entryId: crypto.randomUUID(),
      category,
      skillId: this._skillId,
      walletAddress: this._walletAddress,
      description,
      changeSummary,
      versionLabel: `1.0.0-clone.${this._versionCounter}`,
      timestamp: new Date().toISOString(),
      syncedToParent: false,
      relatedOperationId,
    };
    this._entries.push(entry);
    return entry;
  }

  /**
   * Mark entries as synced to parent template.
   */
  markSynced(entryIds: string[]): void {
    for (const entry of this._entries) {
      if (entryIds.includes(entry.entryId)) {
        entry.syncedToParent = true;
      }
    }
  }

  /**
   * Get entries not yet synced upchain.
   */
  getUnsyncedEntries(): BuildLogEntry[] {
    return this._entries.filter(e => !e.syncedToParent);
  }

  /**
   * Get all entries, optionally filtered.
   */
  getEntries(filters?: {
    category?: BuildLogCategory;
    since?: string;
  }): BuildLogEntry[] {
    let result = [...this._entries];
    if (filters?.category) result = result.filter(e => e.category === filters.category);
    if (filters?.since) result = result.filter(e => e.timestamp >= filters.since!);
    return result;
  }

  /**
   * Get summary statistics.
   */
  getSummary(): BuildLogSummary {
    const byCategory: Record<string, number> = {};
    for (const entry of this._entries) {
      byCategory[entry.category] = (byCategory[entry.category] || 0) + 1;
    }
    return {
      totalEntries: this._entries.length,
      byCategory,
      unsyncedCount: this._entries.filter(e => !e.syncedToParent).length,
      latestVersion: this._entries.length > 0
        ? this._entries[this._entries.length - 1].versionLabel
        : '1.0.0',
      lastEntryAt: this._entries.length > 0
        ? this._entries[this._entries.length - 1].timestamp
        : undefined,
    };
  }

  /**
   * Extract entries for A2A upchain synthesis to parent template.
   */
  extractForSync(): {
    skillId: string;
    walletAddress: string;
    entries: BuildLogEntry[];
    summary: BuildLogSummary;
  } {
    return {
      skillId: this._skillId,
      walletAddress: this._walletAddress,
      entries: this.getUnsyncedEntries(),
      summary: this.getSummary(),
    };
  }

  /**
   * Clear all entries (on detach).
   */
  clear(): void {
    this._entries.length = 0;
    this._versionCounter = 0;
  }

  /**
   * Log vnext feature goals and design principles for this skill clone.
   */
  logDesignPrinciples(): void {
    this.log('schema-amendment', 'vnext: Edge user custom wallets → skill template conversion with ingested data + AI agent. Viral ecosystem propagation (shared family records, wills, deeds, digital assets, investment vehicle holdings).', {
      after: { feature: 'edge-wallet-to-template', status: 'vnext' },
    });

    this.log('schema-amendment', 'Design Principle (Revenue Capture Pattern): Wallets inherit Royalty Flywheel config TXs on creation. Config is customizable per wallet/skill:Operation. Codex parent (cappz core admin) can add/deprecate baseline config TXs. Per-TX royalty config is an anti-pattern (AP-19).', {
      after: { principle: 'royalty-flywheel-inherited-config', antiPattern: 'AP-19' },
    });

    this.log('schema-amendment', 'AP-19: Per-TX Royalty Config — Embedding royalty configuration in individual transaction payloads. Creates versioning conflicts, bloats TX size, and risks Veritaseum patent infringement. Resolution: Royalty config lives at wallet/skill scope as inherited config TXs, readable at flywheel execution time.', {
      after: { antiPattern: 'AP-19', resolution: 'wallet-scope-inherited-config' },
    });

    this.log('schema-amendment', 'vnext: CappzDataCache<T> — Generic write-through cache component for cappz-localstore (#38.1). Phase 2 candidates: ops-log, CPM registry, revenue service, trusted-address. Eliminates redundant cache plumbing across 5+ modules. Consistent TTL, eviction, subscription/notify pattern, and A2A upchain hooks.', {
      after: { feature: 'cappz-data-cache-generic', status: 'vnext', phase: 2, candidates: ['ops-log', 'cpm-registry', 'revenue-service', 'trusted-address'] },
    });

    this.log('schema-amendment', 'AX-63: Single Storage Stack — All skill state must flow through cappz-middleware → offlineCache → chainletStorage. Raw browser storage APIs (localStorage, sessionStorage) are prohibited in skill/service code. Exceptions: ephemeral session-only state (OAuth redirect, one-time toasts).', {
      after: { axiom: 'AX-63', principle: 'single-storage-stack', status: 'approved' },
    });

    this.log('schema-amendment', 'vnext: mdmTxCache → CappzEventCache<T> (#38.6) — Rename and extract generic event cache from mdmTxCache. Stack hierarchy: cappz-middleware (IDB engine #38 base) → offlineCache (TTL KV #38.1) → chainletStorage (high-level KV #38.1) → CappzEventCache (address-driven TX cache #38.6). Pub/sub event bus built into cappz-middleware.notify() for local UI reactivity. A2A cache callbacks remain for cross-device sync.', {
      after: { feature: 'cappz-event-cache-generic', currentName: 'mdmTxCache', targetName: 'CappzEventCache', skillRef: '#38.6', status: 'vnext' },
    });

    // AX-68: Generic On-Chain Discovery
    this.log('schema-amendment', 'AX-68: Generic On-Chain Discovery — FetchSkillsOnChain(targetHDPath) replaces domain-specific discovery functions. Walks HD subtrees generically, resolves skills, and caches configs. All domain-specific discovery must be factored into this reusable utility (FR-005).', {
      after: { axiom: 'AX-68', principle: 'generic-on-chain-discovery', status: 'approved' },
    });

    // AX-69: Config Cache for Non-Volatile Datasets
    this.log('schema-amendment', 'AX-69: Config Cache for Non-Volatile Datasets — Commonly accessed, non-volatile configurations are cached in chainletStorage on init with 7-day TTL. Agents read from cache (O(1)) rather than re-discovering on every access.', {
      after: { axiom: 'AX-69', principle: 'config-cache-non-volatile', status: 'approved', ttl: '7d' },
    });

    // AX-70: Event-Driven Cache Invalidation
    this.log('schema-amendment', 'AX-70: Event-Driven Cache Invalidation — CreateEventSubscription() listens on cappzMiddleware.notify() (not Supabase realtime). When SkillBindingCreated/SkillBindingDeprecated/ContentAmended events fire, RefreshConfigCache() re-discovers and updates the cache. Zero Supabase dependency.', {
      after: { axiom: 'AX-70', principle: 'event-driven-cache-invalidation', transport: 'cappz-middleware.notify()', status: 'approved' },
    });

    // AP-12 Remediation
    this.log('schema-amendment', 'AP-12 Remediation: Boolean flags (_active, _isReadOnly) replaced with SkillStatusResolver.resolveFromEventTx(). State derived from SkillAttached/SkillDetached and TemplateReadOnlyEnforced/TemplateReadOnlyLifted event TX existence on admin queues.', {
      after: { antiPattern: 'AP-12', resolution: 'SkillStatusResolver.resolveFromEventTx()', replacedFlags: ['_active', '_isReadOnly'] },
    });

    // AP-22: Third-Party Dependency Leakage
    this.log('schema-amendment', 'AP-22: Third-Party Dependency Leakage — Direct supabase.channel() usage in consumer code (mdmTxCache.subscribeToNewBlocks) bypasses cappz-middleware abstraction. Remediated: replaced with CreateEventSubscription(). Supabase remains as Layer 2 background sync inside chainletSync only.', {
      after: { antiPattern: 'AP-22', resolution: 'CreateEventSubscription()', remediated: ['mdmTxCache.subscribeToNewBlocks'] },
    });

    // AX-71: Sovereign TX-Based Audit Trail
    this.log('schema-amendment', 'AX-71: Sovereign TX-Based Audit Trail — Ops-log entries are chainlet TXs via CappzEventCache<T> (Skill #38.6), not volatile KV entries. Browser storage eviction cannot destroy the audit trail. Only agentSkill.purgeOpsLog() can delete entries. CappzEventCache is the generic, address-partitioned event cache replacing raw chainletStorage KV for all stateful caches.', {
      after: { axiom: 'AX-71', principle: 'sovereign-tx-audit-trail', cache: 'CappzEventCache<T>', skillRef: '#38.6', status: 'implemented' },
    });

    // FR-005: Generalized Code Factoring
    this.log('schema-amendment', 'FR-005: Generalized Code Factoring — Domain-specific functions must be factored into reusable utilities before implementation. discoverCanonsByHdWalk → FetchSkillsOnChain, SubscribeToEvents → CreateEventSubscription, per-skill boolean flags → SkillStatusResolver.', {
      after: { principle: 'FR-005', resolution: 'generalized-code-factoring', examples: ['FetchSkillsOnChain', 'CreateEventSubscription', 'SkillStatusResolver'] },
    });

    // vnext: permissionHDAddress — Replace isAdmin boolean flags
    this.log('schema-amendment', 'vnext: Replace isAdmin boolean flags with permissionHDAddress resolution. Components receive an HD address of the MDM admin/user group; permission resolved via active GroupMemberActivated TX existence at that address (AP-12 compliant, AP-21 full TX return). Current sprint deferred — isAdmin boolean retained as interim. Target: PublishContentModeControl, IngestContentModeControl, CodexOpsLogViewer, BiblePortalPage admin gating.', {
      after: { feature: 'permission-hd-address-resolution', antiPatterns: ['AP-12'], status: 'vnext-design-phase', currentInterim: 'isAdmin boolean' },
    });

    // Hanoi Safe-Swap Publish Design
    this.log('schema-amendment', 'Hanoi Tower Safe-Swap Publish: Bidirectional serialization changes (RAW↔ENCRYPTED) at same HD address use non-destructive swap pattern. Steps: READ+verify → TRANSFORM → WRITE backup to tmpAddress → VERIFY backup hash → WRITE transformed to primaryAddress → EMIT Published TX → DELETE tmpAddress. Transient grow-then-shrink storage (not 2x sustained). Work partitioned by book for thread-pool isolation (no cross-book contention). Recovery via recoverSerializationSwap() walks from last known good publish TX. BPMN error boundary reports step number, addresses, hash states to ops-log.', {
      after: { pattern: 'hanoi-safe-swap', directions: ['RAW→ENCRYPTED', 'ENCRYPTED→RAW'], partitioning: 'per-book', recovery: 'recoverSerializationSwap()', status: 'implemented' },
    });

    // Domain 14: EncryptionType
    this.log('schema-amendment', 'Domain 14: EncryptionType — Algorithm selection for ENCRYPTED serialization. AES-256-GCM (symmetric, TLS 1.3 aligned, hdIndex 0) and secp256k1 ECIES (asymmetric, BTC/XRP native curve, hdIndex 1). Key derivation: HKDF-SHA256 from wallet signature + content HD address. No 3DES. GCM provides authenticated encryption (confidentiality + integrity). EncryptedContentPublished TX carries encryptionTypeHDAddress + encryptionTypeCode.', {
      after: { domain: 14, algorithms: ['AES_256_GCM', 'SECP256K1_ECIES'], keyDerivation: 'HKDF-SHA256', status: 'implemented' },
    });

    // Asymmetric Serialization Direction Rules
    this.log('schema-amendment', 'Asymmetric Serialization Direction Rules: Local (Tier-1) allows bidirectional RAW↔ENCRYPTED — content is wallet-resident and private. On-chain (Tier-2) enforces ENCRYPTED→RAW only (declassification). RAW→ENCRYPTED on-chain is DENIED post-publish because cleartext is already immutable on the ledger — encrypting it afterward is pointless. Guard emits ContentPublishDenied with reason RAW_ALREADY_ONCHAIN_ENCRYPT_POINTLESS. UI disables ENCRYPTED option when RawContentPublished TX exists at target address.', {
      after: { rule: 'asymmetric-direction', local: 'bidirectional', onchain: 'ENCRYPTED→RAW only', deniedEvent: 'ContentPublishDenied', status: 'implemented' },
    });
  }

  get size(): number {
    return this._entries.length;
  }
}
