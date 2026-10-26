/**
 * AgentSkill — Abstract base class for composable agent skills.
 *
 * Skills compose WalletAgent instances — they do NOT derive from WalletAgent.
 * Factory-initialized from MDM addresses:
 *   retval = AgentSkill(MDM.FetchAddress(CAPPZ_NOTARIZATION)).Configure(walletAgent)
 *
 * Every skill participates in the agent's lifecycle:
 *   onSave, onLoad, onConfig, onDetach
 *
 * Each skill auto-creates an admin queue at {configurationAddress}/admin with an
 * "AdminQueueCreated" event TX. This enables 3-tier intercommunication:
 *   Wallet.admin ←→ Agent.admin ←→ Skill.admin
 *
 * Each skill records its MDM dependency via an MDMBindingCreated transaction
 * emitted from the skill's configuration address.
 */

import type { SkillSaveContext, SkillReceipt, ConfigTx, SkillManifest } from './SkillTypes';
import { isSkillRegistered, resolveSkill } from './SkillRegistry';
import { getWalletManifest } from './SkillWalletManifest';

// ─── Constituent Status Lifecycle ────────────────────────────────
// Lifecycle events (AP-12 compliant — derived from event TX existence):
//   ConstituentPlanned → ConstituentRegistered → ConstituentIngestInitiated
//     → ConstituentIngestCompleted → ConstituentActivated

export type ConstituentStatus =
  | 'ConstituentPlanned'
  | 'ConstituentRegistered'
  | 'ConstituentIngestInitiated'
  | 'ConstituentIngestCompleted'
  | 'ConstituentIngestFailed'
  | 'ConstituentIngestSuspended'
  | 'ConstituentIngestResumed'
  | 'ConstituentActivated';

export interface StatusResult {
  id: string;
  hdPath: string;
  status: ConstituentStatus;
  skillRegistered: boolean;
  contentIngested: boolean;
  itemCount: number;
  detailCount: number;
  ingestedAt: string | null;
  resolvedAt: string;
}

export interface ContentProbeResult {
  ingested: boolean;
  inProgress: boolean;
  itemCount: number;
  detailCount: number;
  ingestedAt: string | null;
}
import type { SkillCloneProvenance, CloneTier } from './SkillCloneTypes';
import { SkillBuildLog } from './SkillBuildLog';
import { AdminQueue, type AdminQueueTx } from '../wallets/AdminQueue';

/** The architecture skill as an agent uses it: pre-flight vetting and the build-iteration log. */
export interface ArchitectureVetter {
  runPreFlight(context: { featureDescription: string; proposedHdAddress?: string; existingSkillsSearched?: string[] }): { passed: boolean; notes: string[] };
  logBuildIteration(entry: { id: string; feature: string; iteration: number; status: 'success' | 'failed' | 'partial'; violatedAxioms: string[]; resolution?: string }): void;
}
let loadArchitecture: (() => Promise<ArchitectureVetter>) | null = null;
/** The platform registers its architecture skill (lazy, to avoid circular imports). */
export function registerArchitectureSkill(loader: (() => Promise<ArchitectureVetter>) | null): void { loadArchitecture = loader; }

// Forward reference to avoid circular import
export interface IWalletAgentRef {
  readonly name: string;
  readonly domain: string;
  readonly domainRoot: string;
  readonly walletAddress: string;
  /** Agent's admin queue for intercommunication */
  readonly adminQueue?: AdminQueue;
}

export abstract class AgentSkill {
  /** Unique skill identifier (e.g., 'cappz:notarization') */
  abstract readonly skillId: string;

  /** HD address for this skill's configuration TXs */
  abstract readonly configurationAddress: string;

  /** MDM address that defines this skill */
  abstract readonly mdmAddress: string;

  /** Semantic version */
  abstract readonly version: string;

  /** Reference to the agent this skill is attached to */
  protected agent: IWalletAgentRef | null = null;

  /** Whether this skill is currently active */
  private _active = false;

  /** Admin queue — auto-created on configure() */
  private _adminQueue: AdminQueue | null = null;

  /** TD-003+005: Clone provenance — links this clone to its parent template */
  protected _cloneProvenance: SkillCloneProvenance | null = null;

  /** TD-006: Clone-scoped build-log for structural versioning */
  protected _buildLog: SkillBuildLog | null = null;

  /** TD-003: Whether this instance is a read-only template copy */
  protected _isReadOnly = false;

  get isActive(): boolean {
    return this._active;
  }

  /** Admin queue accessor */
  get adminQueue(): AdminQueue | null {
    return this._adminQueue;
  }

  /** TD-003+005: Clone provenance accessor */
  get cloneProvenance(): SkillCloneProvenance | null {
    return this._cloneProvenance;
  }

  /** TD-006: Build log accessor */
  get buildLog(): SkillBuildLog | null {
    return this._buildLog;
  }

  /** TD-003: Read-only check — enforced on template copies */
  get isReadOnly(): boolean {
    return this._isReadOnly;
  }

  // ─── Architecture Enforcement (AX-22) ──────────────────────

  /**
   * Architecture pre-flight vetting — inherited by ALL agents.
   * The architecture skill is the platform's own (it reads the platform build log), so the
   * platform registers it (registerArchitectureSkill); without it the pre-flight is skipped.
   * Every agent can call this.vetDesign() before any implementation.
   */
  protected async vetDesign(context: {
    featureDescription: string;
    proposedHdAddress?: string;
    existingSkillsSearched?: string[];
  }): Promise<{ passed: boolean; notes: string[] }> {
    try {
      if (!loadArchitecture) return { passed: true, notes: ['Architecture skill not available — skipping pre-flight'] };
      const arch = await loadArchitecture();
      const result = arch.runPreFlight(context);
      if (!result.passed) {
        console.warn(`[${this.skillId ?? 'agent'}] Pre-flight FAILED:`, result.notes);
      }
      return { passed: result.passed, notes: result.notes };
    } catch {
      return { passed: true, notes: ['Architecture skill not available — skipping pre-flight'] };
    }
  }

  /**
   * Log a build iteration to the architecture skill's session log.
   * Available to ALL agents for automatic learning.
   */
  protected async logIteration(entry: {
    id: string;
    feature: string;
    iteration: number;
    status: 'success' | 'failed' | 'partial';
    violatedAxioms: string[];
    resolution?: string;
  }): Promise<void> {
    try {
      if (!loadArchitecture) return;
      (await loadArchitecture()).logBuildIteration(entry);
    } catch {
      // Architecture skill unavailable — silent
    }
  }

  // ─── Factory ───────────────────────────────────────────────

  /**
   * Resolve an MDM address to a concrete skill instance.
   * Delegates to SkillRegistry.
   */
  static create(mdmAddress: string): AgentSkill | null {
    return resolveSkill(mdmAddress);
  }

  // ─── Lifecycle ─────────────────────────────────────────────

  /**
   * Self-configure: bind to agent, create admin queue with AdminQueueCreated,
   * emit SkillAttached to agent's admin queue, emit MDMBindingCreated.
   * Returns `this` for chaining.
   */
  configure(agent: IWalletAgentRef): this {
    this.agent = agent;
    this._active = true;

    // Auto-create admin queue at {configurationAddress}/admin
    const skillAdminAddress = `${this.configurationAddress}/admin`;
    const parentAdminAddress = agent.adminQueue?.adminAddress;

    this._adminQueue = new AdminQueue({
      adminAddress: skillAdminAddress,
      ownerType: 'skill',
      ownerId: this.skillId,
      parentAdminAddress,
    });

    // Fire-and-forget initialization (admin queue + attach notification + clone TX)
    this._initializeAdminQueue(agent).then(() => {
      // TD-003+005: If this is a clone, emit SkillCloneCreated TX
      if (this._cloneProvenance) {
        return this._emitSkillCloneCreatedTx();
      }
    }).catch(err =>
      console.warn(`[${this.skillId}] Admin queue init failed:`, err)
    );

    return this;
  }

  /**
   * Initialize admin queue and notify agent.
   */
  private async _initializeAdminQueue(agent: IWalletAgentRef): Promise<void> {
    if (!this._adminQueue) return;

    // 1. AdminQueueCreated on this skill's admin queue
    await this._adminQueue.initialize();

    // 2. Emit SkillAttached to agent's admin queue (intercommunication)
    if (agent.adminQueue) {
      await this._adminQueue.postTo(agent.adminQueue, 'SkillAttached', {
        skillId: this.skillId,
        mdmAddress: this.mdmAddress,
        version: this.version,
        configurationAddress: this.configurationAddress,
      });
    }
  }

  /**
   * Called on every agent save(). Perform skill-specific processing.
   */
  abstract onSave(context: SkillSaveContext): Promise<SkillReceipt>;

  /**
   * Called when agent loads/initializes. Restore skill state.
   */
  abstract onLoad(): Promise<void>;

  /**
   * Called when skill is detached from agent. Cleanup.
   * Emits SkillDetached to agent's admin queue.
   */
  abstract onDetach(): Promise<void>;

  /**
   * Emit SkillDetached to agent admin queue during detach.
   */
  protected async emitDetachEvent(): Promise<void> {
    if (this._adminQueue && this.agent?.adminQueue) {
      await this._adminQueue.postTo(this.agent.adminQueue, 'SkillDetached', {
        skillId: this.skillId,
        detachedAt: new Date().toISOString(),
      });
    }
  }

  /**
   * Called when agent configuration changes.
   */
  async onConfig(_key: string, _value: unknown): Promise<void> {
    // Default no-op — subclasses override
  }

  // ─── Config TX Emission ────────────────────────────────────

  /**
   * Emit a configuration TX from this skill's configurationAddress.
   */
  async emitSkillConfigTx(
    eventType: string,
    payload?: Record<string, unknown>,
  ): Promise<ConfigTx> {
    const tx: ConfigTx = {
      eventType,
      sourceAddress: this.configurationAddress,
      payload: payload ?? {},
      timestamp: new Date().toISOString(),
    };

    // Persist through the durable pipeline (cache + chainlet block + outbox)
    try {
      const { agentSkillCache } = await import('./AgentSkillCache');
      await agentSkillCache.persistAndRefresh({
        txId: crypto.randomUUID(),
        timestamp: tx.timestamp,
        eventType,
        sourceAddress: this.configurationAddress,
        targetAddress: (payload?.targetAddress as string) ?? '',
        payload: payload ?? {},
      });
    } catch (err) {
      console.warn(`[${this.skillId}] ConfigTx persist failed for ${eventType}, cached locally`, err);
    }

    console.log(`[${this.skillId}] ConfigTx: ${eventType}`, tx);
    return tx;
  }

  /**
   * Emit MDMBindingCreated TX linking this skill instance to its MDM code list.
   */
  async emitMDMBinding(mdmCodeListAddress: string): Promise<ConfigTx> {
    return this.emitSkillConfigTx('MDMBindingCreated', {
      mdmAddress: this.mdmAddress,
      codeListAddress: mdmCodeListAddress,
      skillId: this.skillId,
      version: this.version,
      boundAt: new Date().toISOString(),
    });
  }

  // ─── Manifest ──────────────────────────────────────────────

  /**
   * Return the skill's manifest for registry listing.
   */
  abstract getManifest(): SkillManifest;

  // ─── Deactivation ─────────────────────────────────────────

  /**
   * Deactivate skill without detaching (pause).
   * Emits SkillPaused to own admin queue.
   */
  deactivate(): void {
    this._active = false;
    if (this._adminQueue) {
      this._adminQueue.emit('SkillPaused', {
        skillId: this.skillId,
        pausedAt: new Date().toISOString(),
      }).catch(() => {});
    }
  }

  /**
   * Reactivate a paused skill.
   * Emits SkillResumed to own admin queue.
   */
  activate(): void {
    this._active = true;
    if (this._adminQueue) {
      this._adminQueue.emit('SkillResumed', {
        skillId: this.skillId,
        resumedAt: new Date().toISOString(),
      }).catch(() => {});
    }
  }

  // ─── v5.0+TD-003+005+006: Clone with Provenance & Build-Log ──

  /**
   * Clone this skill for a user-scoped agent instance.
   * TD-003+005: Records parent template provenance + emits SkillCloneCreated TX.
   * TD-006: Initializes clone-scoped build-log.
   * TD-003: Read-only template copies enforce write-block.
   *
   * @param walletAddress - The cloning user's wallet
   * @param tier - Clone tier: 'user-clone' | 'embedded-skill-clone' | 'template-copy'
   */
  clone(walletAddress?: string, tier: CloneTier = 'user-clone'): AgentSkill | null {
    const cloned = resolveSkill(this.mdmAddress) as AgentSkill | null;
    if (!cloned) return null;

    const wallet = walletAddress ?? this.agent?.walletAddress ?? 'unknown';

    // TD-003+005: Set clone provenance linking to parent template
    cloned._cloneProvenance = {
      parentTemplateMdmAddress: this.mdmAddress,
      parentTemplateVersion: this.version,
      parentTemplateId: this._cloneProvenance?.parentTemplateId ?? this.skillId,
      clonedAt: new Date().toISOString(),
      clonedByWallet: wallet,
      isReadOnly: tier === 'template-copy',
      upgradeStatus: 'current',
    };

    // TD-003: Enforce read-only on template copies (belt-and-suspenders)
    if (tier === 'template-copy') {
      cloned._isReadOnly = true;
    }

    // TD-006: Initialize clone-scoped build-log
    cloned._buildLog = new SkillBuildLog(cloned.skillId, wallet);

    // Log initial clone entry in build-log
    cloned._buildLog.log('skill-config', `Cloned from ${this.skillId} v${this.version}`, {
      after: {
        parentMdmAddress: this.mdmAddress,
        parentVersion: this.version,
        tier,
        clonedAt: cloned._cloneProvenance.clonedAt,
      },
    });

    console.log(`[${this.skillId}] Cloned → ${tier} for ${wallet}`);
    return cloned;
  }

  /**
   * Emit SkillCloneCreated TX to clone's admin queue after configure().
   * Called automatically when a cloned skill is configured on an agent.
   */
  private async _emitSkillCloneCreatedTx(): Promise<void> {
    if (!this._cloneProvenance || !this._adminQueue) return;

    await this._adminQueue.emit('SkillCloneCreated' as any, {
      parentTemplateMdmAddress: this._cloneProvenance.parentTemplateMdmAddress,
      parentTemplateVersion: this._cloneProvenance.parentTemplateVersion,
      parentTemplateId: this._cloneProvenance.parentTemplateId,
      cloneTier: this._cloneProvenance.isReadOnly ? 'template-copy' : 'user-clone',
      clonedAt: this._cloneProvenance.clonedAt,
      clonedByWallet: this._cloneProvenance.clonedByWallet,
      isReadOnly: this._cloneProvenance.isReadOnly,
    } as Record<string, unknown>);
  }

  /**
   * TD-003: Guard — throws if this is a read-only template copy.
   * Call at the top of any mutating operation.
   */
  protected enforceWritable(): void {
    if (this._isReadOnly) {
      throw new Error(
        `[${this.skillId}] Write blocked — this is a read-only template copy. ` +
        `Upgrade or switch to a user-clone to make changes.`
      );
    }
  }

  /**
   * TD-005: Check if an upgrade is available from the parent template.
   * Compares cloneProvenance.parentTemplateVersion to current registry version.
   */
  checkUpgradeAvailable(): { available: boolean; currentVersion: string; latestVersion?: string } {
    if (!this._cloneProvenance) {
      return { available: false, currentVersion: this.version };
    }
    const latest = resolveSkill(this._cloneProvenance.parentTemplateMdmAddress) as AgentSkill | null;
    if (!latest) return { available: false, currentVersion: this.version };

    const latestVersion = latest.version;
    const available = latestVersion !== this._cloneProvenance.parentTemplateVersion;
    if (available) {
      this._cloneProvenance.upgradeStatus = 'upgrade-available';
      this._cloneProvenance.latestParentVersion = latestVersion;
    }
    this._cloneProvenance.lastUpgradeCheck = new Date().toISOString();
    return { available, currentVersion: this._cloneProvenance.parentTemplateVersion, latestVersion };
  }

  // ─── JSON-LD Manifest ──────────────────────────────────────

  /**
   * Generate a JSON-LD wallet manifest for this skill instance.
   * Reads from chainletStorage FIRST (wallet-authoritative),
   * falls back to classification if wallet is unpopulated.
   * @deprecated Sync version — prefer toJsonLdAsync() for wallet-first reads.
   */
  toJsonLd(): import('./SkillWalletManifest').SkillWalletManifest | null {
    return getWalletManifest(this.mdmAddress, this.version);
  }

  /**
   * Async wallet-authoritative JSON-LD manifest read.
   * Reads from chainletStorage first, falls back to classification.
   */
  async toJsonLdAsync(): Promise<import('./SkillWalletManifest').SkillWalletManifest | null> {
    const { getWalletManifestAsync } = await import('./SkillWalletManifest');
    return getWalletManifestAsync(this.mdmAddress, this.version);
  }

  // ─── Constituent Status (Generic) ────────────────────────────

  /** 30-second instance-level status cache */
  private _statusCache: StatusResult | null = null;
  private _statusCacheTime = 0;
  private static readonly STATUS_CACHE_TTL = 30_000;

  /**
   * Override in domain skills to report ingestion state.
   * Default: no content probe (null → status derived from registration only).
   */
  protected async contentProbe(): Promise<ContentProbeResult | null> {
    return null;
  }

  /**
   * Derive this skill's ConstituentStatus from event TX existence.
   * Checks skill registration + contentProbe() hook.
   * Cached for 30 seconds per instance.
   */
  async getStatus(): Promise<StatusResult> {
    const now = Date.now();
    if (this._statusCache && now - this._statusCacheTime < AgentSkill.STATUS_CACHE_TTL) {
      return this._statusCache;
    }

    const skillRegistered = isSkillRegistered(this.mdmAddress);
    const probe = await this.contentProbe();

    let status: ConstituentStatus;
    let contentIngested = false;
    let itemCount = 0;
    let detailCount = 0;
    let ingestedAt: string | null = null;

    if (probe) {
      contentIngested = probe.ingested;
      itemCount = probe.itemCount;
      detailCount = probe.detailCount;
      ingestedAt = probe.ingestedAt;
    }

    if (skillRegistered && contentIngested) {
      status = 'ConstituentActivated';
    } else if (skillRegistered && probe?.inProgress) {
      status = 'ConstituentIngestInitiated';
    } else if (skillRegistered) {
      status = 'ConstituentRegistered';
    } else {
      status = 'ConstituentPlanned';
    }

    const result: StatusResult = {
      id: this.skillId,
      hdPath: this.configurationAddress,
      status,
      skillRegistered,
      contentIngested,
      itemCount,
      detailCount,
      ingestedAt,
      resolvedAt: new Date().toISOString(),
    };

    this._statusCache = result;
    this._statusCacheTime = now;
    return result;
  }

  /**
   * Invalidate this skill's cached status.
   * Call after ingest or registration changes.
   */
  invalidateStatusCache(): void {
    this._statusCache = null;
    this._statusCacheTime = 0;
  }

  // ─── Standard Ingest/Analyze Interface (AX-41) ─────────────

  /**
   * IngestContent — Standard interface for canon constituent ingestion.
   * Wraps ingest-skill-state-bpmn → ingest-skill-state-canon-bpmn.
   * Override in domain skills to provide content-type specific logic.
   */
  async IngestContent(): Promise<import('./SkillTypes').SkillReceipt> {
    throw new Error(`[${this.skillId}] IngestContent not implemented — override in domain skill`);
  }

  /**
   * AnalyzeContent — Standard interface for cross-canon analysis.
   * Wraps skill-state-analysis-bpmn → skill-state-analysis-canon-bpmn.
   * Produces correlation/equivalency TXs against targetHdAddress.
   */
  async AnalyzeContent(_targetHdAddress: string): Promise<import('./SkillTypes').SkillReceipt> {
    throw new Error(`[${this.skillId}] AnalyzeContent not implemented — override in domain skill`);
  }

  // ─── MKF: IngestKnowledge ─────────────────────────────────

  /**
   * Ingest knowledge content into this skill's HD content tree.
   * Acquires content from source, stores raw, notarizes BEFORE parsing.
   * Emits ContentIngested events per document.
   *
   * Supports: HTTP, FTP, file browse (multi-select), folder crawl,
   * copy-paste text/URL, attachment upload.
   *
   * Pipeline: Acquire → Store Raw → Notarize → Return (parsing is downstream)
   */
  async ingestKnowledge(
    source: import('./IngestKnowledge').IngestionSource,
    startDocIndex = 0,
    network: 'testnet' | 'devnet' | 'mainnet' = 'testnet',
  ): Promise<import('./IngestKnowledge').IngestionBatchResult> {
    if (!this.agent) throw new Error(`[${this.skillId}] Skill not configured — call configure(agent) first`);
    if (!this._active) throw new Error(`[${this.skillId}] Skill is paused — activate before ingesting`);

    const { ingestKnowledge } = await import('./IngestKnowledge');
    const result = await ingestKnowledge(
      source,
      this.agent.walletAddress,
      startDocIndex,
      network,
    );

    // Emit ContentIngested events to skill's admin queue
    if (this._adminQueue) {
      for (const event of result.events) {
        await this._adminQueue.emit('ContentIngested' as any, { ...event } as Record<string, unknown>).catch(() => {});
      }
    }

    console.log(`[${this.skillId}] Ingested ${result.succeeded.length}/${result.totalDocuments} documents (batch: ${result.batchId})`);
    return result;
  }
}
