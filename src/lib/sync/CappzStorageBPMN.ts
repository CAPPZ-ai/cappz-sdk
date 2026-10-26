/**
 * CappzStorageBPMN — BPMN pipeline engine for cappz-storage writes.
 *
 * Pluggable pipeline components:
 *   PolicyCheck → Notify → Persist → Fork
 *
 * Each pipeline is a named sequence of components.
 * Components receive HD addresses and read from ContentCache — no data passed along.
 *
 * AX-57: BPMN-First — all writes gated through BPMN processes.
 * AX-42: BPMN/Blockchain TX Graph Integration.
 * AX-75: Notify passes childHdAddress — not content copies.
 * HD: m/44'/144'/0'/cappz/storage/bpmn
 */

import { chainletStorage } from './chainletStorage';
import { middlewareNotify } from './cappz-middleware';
import type { ContentHashPrint } from './CappzContentCache';
import type { SubmitMode } from './cappzStorage';

// ─── Types ────────────────────────────────────────────────────

export type CappzStoragePipeline = 'cappzStorageBPMN' | 'ingestContentPipeline';

export interface PipelineContext {
  parentHdAddress: string;
  childHdAddress: string;
  content: unknown;
  contentHash: string;
  txId: string;
  correlationId: string;
  mode: SubmitMode;
  sourceHashPrint?: ContentHashPrint;
  forkFrom?: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export type PipelineComponent = (ctx: PipelineContext) => Promise<void>;

interface PipelineDefinition {
  name: string;
  components: PipelineComponent[];
}

// ─── Built-in Pipeline Components ─────────────────────────────

/**
 * PolicyCheck — Validates the write operation against configured policies.
 * Extensible: add custom policy checks via registerComponent().
 */
const PolicyCheck: PipelineComponent = async (ctx) => {
  // Enforce sourceHashPrint for mutations
  if ((ctx.mode === 'amend' || ctx.mode === 'replace') && !ctx.sourceHashPrint) {
    throw new Error(`[PolicyCheck] sourceHashPrint required for ${ctx.mode} at ${ctx.childHdAddress}`);
  }
  // Future: wallet-level policies, rate limits, quota checks
};

/**
 * Notify — Emits notifications for pipeline events (AX-75).
 * Passes childHdAddress — subscribers resolve content from the address.
 */
const Notify: PipelineComponent = async (ctx) => {
  console.log(`[CappzStorageBPMN] ${ctx.mode} at ${ctx.childHdAddress} (corr: ${ctx.correlationId})`);
  // AX-75: Pass HD address, not content copy
  middlewareNotify('cappz-storage', ctx.childHdAddress, 'write', ctx.childHdAddress);
};

/**
 * Persist — Durable persistence to cappz-chainlet-storage and cappz-content-storage.
 * Writes TX event and content blob to their respective storage layers.
 */
const Persist: PipelineComponent = async (ctx) => {
  // Persist TX event (cappz-chainlet-storage)
  const eventKey = `cappz:event/${ctx.txId}`;
  await chainletStorage.setItem(eventKey, {
    txId: ctx.txId,
    eventType: _modeToEventType(ctx.mode),
    sourceAddress: ctx.parentHdAddress,
    targetAddress: ctx.childHdAddress,
    contentHash: ctx.contentHash,
    correlationId: ctx.correlationId,
    timestamp: ctx.timestamp,
    forkFrom: ctx.forkFrom,
    metadata: ctx.metadata,
  });

  // Persist content (cappz-content-storage)
  const contentKey = `cappz:content/${ctx.childHdAddress}`;
  await chainletStorage.setItem(contentKey, {
    hdAddress: ctx.childHdAddress,
    content: ctx.content,
    contentHash: ctx.contentHash,
    state: 'CONFIRMED',
    dirty: false,
    lastFetchedAt: ctx.timestamp,
    sourceTxId: ctx.txId,
  });

  // AX-75: Notify with HD addresses for both event and content
  middlewareNotify('kv', eventKey, 'write', eventKey);
  middlewareNotify('kv', contentKey, 'write', contentKey);
};

/**
 * Fork — Handles fork-specific logic (creates ContentForked TX linking back to source).
 */
const ForkHandler: PipelineComponent = async (ctx) => {
  if (ctx.mode !== 'fork' || !ctx.forkFrom) return;

  const forkTxKey = `cappz:event/fork-${ctx.txId}`;
  await chainletStorage.setItem(forkTxKey, {
    txId: `fork-${ctx.txId}`,
    eventType: 'ContentForked',
    sourceAddress: ctx.forkFrom,
    targetAddress: ctx.childHdAddress,
    contentHash: ctx.contentHash,
    correlationId: ctx.correlationId,
    timestamp: ctx.timestamp,
    metadata: { originalTxId: ctx.sourceHashPrint?.txId },
  });
  middlewareNotify('kv', forkTxKey, 'write', forkTxKey);
};

// ─── Event Type Mapping ────────────────────────────────────────

function _modeToEventType(mode: SubmitMode): string {
  switch (mode) {
    case 'create': return 'ContentCreated';
    case 'amend': return 'ContentAmended';
    case 'replace': return 'ContentReplaced';
    case 'fork': return 'ContentForked';
    default: return 'ContentCreated';
  }
}

// ─── Pipeline Registry ────────────────────────────────────────

const _pipelines = new Map<string, PipelineDefinition>();

// Register built-in pipelines
_pipelines.set('cappzStorageBPMN', {
  name: 'cappzStorageBPMN',
  components: [PolicyCheck, Notify, Persist, ForkHandler],
});

_pipelines.set('ingestContentPipeline', {
  name: 'ingestContentPipeline',
  components: [PolicyCheck, Persist],
});

// ─── Public API ───────────────────────────────────────────────

export const cappzStorageBPMN = {
  /**
   * Execute a named pipeline with the given context.
   */
  async execute(pipelineName: string, ctx: PipelineContext): Promise<void> {
    const pipeline = _pipelines.get(pipelineName);
    if (!pipeline) {
      throw new Error(`[CappzStorageBPMN] Unknown pipeline: ${pipelineName}`);
    }

    for (const component of pipeline.components) {
      await component(ctx);
    }
  },

  /**
   * Register a custom pipeline.
   */
  registerPipeline(name: string, components: PipelineComponent[]): void {
    _pipelines.set(name, { name, components });
  },

  /**
   * Add a component to an existing pipeline.
   */
  addComponent(pipelineName: string, component: PipelineComponent, position?: 'before' | 'after', relativeTo?: string): void {
    const pipeline = _pipelines.get(pipelineName);
    if (!pipeline) {
      throw new Error(`[CappzStorageBPMN] Unknown pipeline: ${pipelineName}`);
    }
    // Simple append for now; positional insertion can be enhanced
    pipeline.components.push(component);
  },

  /**
   * List registered pipeline names.
   */
  listPipelines(): string[] {
    return Array.from(_pipelines.keys());
  },
};
