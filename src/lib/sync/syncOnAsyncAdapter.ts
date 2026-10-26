/**
 * SyncOnAsyncAdapter — Correlated Synchronous-on-Asynchronous Processing
 * 
 * Inspired by:
 *   US Patent 7,769,802 — "Systems and methods that employ correlated 
 *                           synchronous-on-asynchronous processing"
 *   US Patent 7,870,187 — "Transport agnostic pull mode messaging service"
 *   BizTalk Server Submit() / SubmitSync() pattern
 * 
 * Architecture (Tx-First Correlation):
 *   submit(request)      → Persists envelope to chainlet FIRST, blockHash=TxID=correlationId
 *   submitSync(request)  → sync-on-async. Waits up to sessionTimeout for result.
 *                          If timeout, returns correlationId (TxID) for pull-mode retrieval.
 *   fetchAsyncResponse() → pull-mode retrieval by TxID (patent 7870187).
 * 
 * Transport Agnostic:
 *   Pluggable adapters (chainlet, cloud, A2A) — adapter interface decouples
 *   the submission pipeline from the transport/storage layer.
 * 
 * Guaranteed Delivery:
 *   TxID=correlationId ensures request is persisted before acknowledgment.
 *   If caller loses connection, response retrieval by TxID upon reconnection.
 * 
 * Standalone — wallet devs import this module directly:
 *   import { syncOnAsync } from './syncOnAsyncAdapter';
 */

import { chainletSync } from './chainletSyncAdapter';
import { chainletStorage } from './chainletStorage';
import { dispatchCallbackNotification } from './callbackNotificationTransport';

// ─── MDM Address Mapping (SyncOnAsyncParamType) ───────────────

/**
 * MDM parameter types for Sync-on-Async configuration.
 * Maps to HD addresses under m/44'/144'/0'/cappz/config/sync-on-async/*
 */
import { SYNC_ON_ASYNC_CONFIG } from '../wallets/paths';

export const SyncOnAsyncParamType = SYNC_ON_ASYNC_CONFIG;

export type SyncOnAsyncParamKey = keyof typeof SyncOnAsyncParamType;

// ─── MDM Defaults (resolved at runtime) ───────────────────────

const MDM_DEFAULTS: Record<SyncOnAsyncParamKey, number | string> = {
  SESSION_TIMEOUT: 30_000,
  MAX_POLL_WAIT: 120_000,
  POLL_INTERVAL: 500,
  ENVELOPE_STORE: 'kv',
  ENVELOPE_TTL: 86_400_000, // 24h
};

/** Resolve MDM param — future: read from chainlet config store */
function getMdmParam<K extends SyncOnAsyncParamKey>(key: K): typeof MDM_DEFAULTS[K] {
  // TODO: Resolve from chainlet storage by SyncOnAsyncParamType[key]
  return MDM_DEFAULTS[key];
}

// ─── Types ────────────────────────────────────────────────────

export type SubmissionStatus =
  | 'persisted'       // Input durably stored, processing not yet started
  | 'processing'      // Async pipeline in flight
  | 'completed'       // Result available
  | 'failed'          // Terminal failure
  | 'expired';        // TTL exceeded, tombstoned

export interface SubmissionRequest<T = unknown> {
  /** Caller-supplied idempotency key (legacy — TxID now provides dedup) */
  messageId?: string;
  /** Payload to process */
  payload: T;
  /** Processing pipeline identifier (maps to adapter/skill) */
  pipeline: string;
  /** Wallet address of the submitter */
  walletAddress: string;
  /** Optional session timeout override (ms). Default from MDM */
  sessionTimeout?: number;
  /**
   * Callback address for response-ready notification.
   * The processing service notifies this address ONLY if fetchAsyncResponse()
   * has not already retrieved the response.
   * 
   * Supported URI schemes:
   *   a2a://<agentId>/<pipeline>    → A2A sovereign notification (GibberLink-compatible)
   *   queue://<wallet>/<channel>    → Cloud queue for DR/scale-out agents
   *   https://example.com/callback  → Legacy HTTP webhook
   */
  callbackAddress?: string;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

export interface CorrelationTicket {
  /** Unique correlation ID = TxID (blockHash from chainlet persist) */
  correlationId: string;
  /** Legacy messageId (for backward compat) */
  messageId: string;
  /** Status at time of return */
  status: SubmissionStatus;
  /** ISO timestamp of persistence */
  persistedAt: string;
  /** If completed synchronously, the result */
  result?: unknown;
  /** If failed, error detail */
  error?: string;
}

export interface AsyncResponse<R = unknown> {
  correlationId: string;
  messageId: string;
  status: SubmissionStatus;
  result: R | null;
  error: string | null;
  completedAt: string | null;
  /** Number of poll attempts (for client telemetry) */
  pollCount: number;
}

/** Pluggable processor — wallet devs register these per pipeline */
export type PipelineProcessor<T = unknown, R = unknown> = (
  correlationId: string,
  payload: T,
  metadata?: Record<string, unknown>,
) => Promise<R>;

// ─── Internal Envelope ────────────────────────────────────────

interface SubmissionEnvelope<T = unknown> {
  /** TxID = blockHash = correlationId */
  correlationId: string;
  messageId: string;
  pipeline: string;
  walletAddress: string;
  payload: T;
  metadata?: Record<string, unknown>;
  /** Callback address for response-ready notification */
  callbackAddress?: string;
  status: SubmissionStatus;
  persistedAt: string;
  completedAt: string | null;
  result: unknown | null;
  error: string | null;
  pollCount: number;
}

// ─── AsyncResponseFetched Event TX ────────────────────────────

/**
 * Event TX emitted when a response is retrieved — NO FLAGS.
 * Both postResponse (completion) and fetchAsyncResponse() paths
 * emit this TX. Notification dispatcher gates on TX existence.
 *
 * HD address: {correlationId}.events/AsyncResponseFetched
 */
const ASYNC_RESPONSE_FETCHED_EVENT = 'AsyncResponseFetched';

interface AsyncResponseFetchedTx {
  type: typeof ASYNC_RESPONSE_FETCHED_EVENT;
  correlationId: string;
  messageId: string;
  pipeline: string;
  retrievedBy: 'postResponse' | 'fetchAsyncResponse';
  retrievedAt: string;
}

/**
 * Emit AsyncResponseFetched event TX to the correlation's event address.
 * This replaces the boolean flag — the existence of this TX is the gate.
 */
async function emitAsyncResponseFetchedTx(
  correlationId: string,
  messageId: string,
  pipeline: string,
  retrievedBy: 'postResponse' | 'fetchAsyncResponse',
): Promise<string> {
  const eventTx: AsyncResponseFetchedTx = {
    type: ASYNC_RESPONSE_FETCHED_EVENT,
    correlationId,
    messageId,
    pipeline,
    retrievedBy,
    retrievedAt: new Date().toISOString(),
  };

  const eventKey = `${correlationId}.events/${ASYNC_RESPONSE_FETCHED_EVENT}`;
  const txId = await chainletSync.set(SOA_STORE, eventKey, eventTx);
  console.log(`[SyncOnAsync] Emitted ${ASYNC_RESPONSE_FETCHED_EVENT} TX (${retrievedBy}) for ${correlationId}`);
  return txId;
}

/**
 * Check whether AsyncResponseFetched event TX exists for a correlation.
 * This is the notification gate — replaces the boolean flag check.
 */
async function hasAsyncResponseBeenFetched(correlationId: string): Promise<boolean> {
  const eventKey = `${correlationId}.events/${ASYNC_RESPONSE_FETCHED_EVENT}`;
  const tx = await chainletStorage.getItem<AsyncResponseFetchedTx>(eventKey);
  return tx !== null && tx !== undefined;
}

// ─── Constants (resolved from wallet-resident MDM params) ─────

import { ChainletStoreParamType, getChainletParam } from './chainletStoreParams';

const SOA_STORE = getChainletParam(ChainletStoreParamType.KvStoreName);

// ─── Sync-on-Async Manager ───────────────────────────────────

class SyncOnAsyncManager {
  private processors = new Map<string, PipelineProcessor>();

  /**
   * Register a processing pipeline.
   * Wallet devs call this to wire their domain logic.
   */
  registerPipeline<T = unknown, R = unknown>(
    pipeline: string,
    processor: PipelineProcessor<T, R>,
  ): void {
    this.processors.set(pipeline, processor as PipelineProcessor);
  }

  /**
   * Unregister a pipeline.
   */
  unregisterPipeline(pipeline: string): void {
    this.processors.delete(pipeline);
  }

  // ─── Submit (fire-and-forget async, Tx-first) ───────────────

  /**
   * Async submission — persists to chainlet FIRST, blockHash=TxID=correlationId.
   * 
   * Tx-First Pattern:
   *   1. Create envelope with placeholder correlationId
   *   2. Persist to chainlet → returns blockHash (TxID)
   *   3. TxID becomes the correlationId (guaranteed unique, dedup built-in)
   *   4. Fire async processing
   */
  async submit<T = unknown>(request: SubmissionRequest<T>): Promise<CorrelationTicket> {
    const messageId = request.messageId ?? crypto.randomUUID();
    const persistedAt = new Date().toISOString();

    // ── Build envelope (correlationId set after persist) ──
    const envelope: SubmissionEnvelope<T> = {
      correlationId: '', // Set after persist
      messageId,
      pipeline: request.pipeline,
      walletAddress: request.walletAddress,
      payload: request.payload,
      metadata: request.metadata,
      callbackAddress: request.callbackAddress,
      status: 'persisted',
      persistedAt,
      completedAt: null,
      result: null,
      error: null,
      pollCount: 0,
    };

    // ── Tx-First: persist envelope, blockHash=correlationId ──
    const txId = await chainletSync.set(SOA_STORE, messageId, envelope);
    envelope.correlationId = txId;

    // Update envelope with actual correlationId
    await chainletStorage.setItem(txId, envelope);

    // ── Fire async processing (non-blocking) ──
    this.processAsync(txId, request.pipeline, request.payload, request.metadata)
      .catch(err => {
        console.warn(`[SyncOnAsync] Pipeline "${request.pipeline}" error:`, err);
      });

    return {
      correlationId: txId,
      messageId,
      status: 'persisted',
      persistedAt,
    };
  }

  // ─── SubmitSync (BizTalk pattern, Tx-first) ──────────────────

  /**
   * Synchronous-on-asynchronous submission with Tx-first correlation.
   * 
   * Waits up to sessionTimeout for the async pipeline to complete:
   *   - If completed in time → returns result inline (appears synchronous)
   *   - If timeout → returns TxID as correlationId (client polls via fetchAsyncResponse)
   * 
   * Patent 7769802: "results can be correlated with the request, aggregated,
   * and returned such that it appears to the requester that the request was
   * synchronously serviced."
   */
  async submitSync<T = unknown, R = unknown>(
    request: SubmissionRequest<T>,
  ): Promise<CorrelationTicket> {
    const timeout = request.sessionTimeout ?? (getMdmParam('SESSION_TIMEOUT') as number);
    const messageId = request.messageId ?? crypto.randomUUID();
    const persistedAt = new Date().toISOString();

    // ── Build envelope (correlationId set after persist) ──
    const envelope: SubmissionEnvelope<T> = {
      correlationId: '',
      messageId,
      pipeline: request.pipeline,
      walletAddress: request.walletAddress,
      payload: request.payload,
      metadata: request.metadata,
      callbackAddress: request.callbackAddress,
      status: 'persisted',
      persistedAt,
      completedAt: null,
      result: null,
      error: null,
      pollCount: 0,
    };

    // ── Tx-First: persist envelope, blockHash=correlationId ──
    const txId = await chainletSync.set(SOA_STORE, messageId, envelope);
    envelope.correlationId = txId;

    // Update with actual correlationId
    await chainletStorage.setItem(txId, envelope);

    // ── Race: processing vs timeout ──
    const processingPromise = this.processAsync<T, R>(
      txId, request.pipeline, request.payload, request.metadata,
    );

    const timeoutPromise = new Promise<'timeout'>(resolve =>
      setTimeout(() => resolve('timeout'), timeout),
    );

    const raceResult = await Promise.race([processingPromise, timeoutPromise]);

    if (raceResult === 'timeout') {
      // Patent 7769802 §timeout path: return TxID for pull-mode retrieval
      console.log(`[SyncOnAsync] Timeout on "${request.pipeline}" — client should poll correlationId=${txId}`);
      return {
        correlationId: txId,
        messageId,
        status: 'processing',
        persistedAt,
      };
    }

    // Completed within session timeout — return synchronous result
    const updated = await this.getEnvelope(txId);
    return {
      correlationId: txId,
      messageId,
      status: updated?.status ?? 'completed',
      persistedAt,
      result: updated?.result ?? raceResult,
      error: updated?.error ?? undefined,
    };
  }

  // ─── FetchAsyncResponse (pull-mode, patent 7870187) ─────────

  /**
   * Pull-mode retrieval — client polls with TxID (correlationId).
   * 
   * Patent 7870187: "Clients may specify themselves as the recipients
   * of the pulled messages" — the TxID acts as the pull address.
   * 
   * @param correlationId - The TxID returned from submit/submitSync
   * @param maxWaitMs - Optional: block up to this duration (long-poll). 0 = instant check.
   */
  async fetchAsyncResponse<R = unknown>(
    correlationId: string,
    maxWaitMs = 0,
  ): Promise<AsyncResponse<R>> {
    const start = Date.now();
    const maxPollWait = getMdmParam('MAX_POLL_WAIT') as number;
    const pollInterval = getMdmParam('POLL_INTERVAL') as number;
    const deadline = Math.min(maxWaitMs, maxPollWait);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const envelope = await this.getEnvelope(correlationId);

      if (!envelope) {
        return {
          correlationId,
          messageId: '',
          status: 'expired',
          result: null,
          error: 'TxID not found or expired',
          completedAt: null,
          pollCount: 0,
        };
      }

      // Increment poll count telemetry
      envelope.pollCount++;
      await chainletStorage.setItem(correlationId, envelope);

      if (envelope.status === 'completed' || envelope.status === 'failed') {
        // Emit AsyncResponseFetched event TX — gates notification suppression
        emitAsyncResponseFetchedTx(
          correlationId,
          envelope.messageId,
          envelope.pipeline,
          'fetchAsyncResponse',
        ).catch(err => console.warn('[SyncOnAsync] Failed to emit AsyncResponseFetched TX:', err));

        return {
          correlationId,
          messageId: envelope.messageId,
          status: envelope.status,
          result: envelope.result as R | null,
          error: envelope.error,
          completedAt: envelope.completedAt,
          pollCount: envelope.pollCount,
        };
      }

      // Long-poll: wait and retry
      const elapsed = Date.now() - start;
      if (elapsed >= deadline) {
        return {
          correlationId,
          messageId: envelope.messageId,
          status: envelope.status,
          result: null,
          error: null,
          completedAt: null,
          pollCount: envelope.pollCount,
        };
      }

      await new Promise(r => setTimeout(r, pollInterval));
    }
  }

  // ─── List pending submissions for a wallet ──────────────────

  async listPending(walletAddress: string): Promise<CorrelationTicket[]> {
    // Scan kv store for envelopes owned by this wallet (TxID keys are 64-char hashes)
    const keys = await chainletStorage.keys();
    const tickets: CorrelationTicket[] = [];

    for (const key of keys) {
      // TxID format: 64-char hex hash
      if (key.length !== 64) continue;
      const envelope = await chainletStorage.getItem<SubmissionEnvelope>(key);
      if (!envelope) continue;
      if (envelope.walletAddress !== walletAddress) continue;
      if (envelope.status === 'persisted' || envelope.status === 'processing') {
        tickets.push({
          correlationId: envelope.correlationId,
          messageId: envelope.messageId,
          status: envelope.status,
          persistedAt: envelope.persistedAt,
        });
      }
    }

    return tickets;
  }

  // ─── Internals ──────────────────────────────────────────────

  private async processAsync<T = unknown, R = unknown>(
    correlationId: string,
    pipeline: string,
    payload: T,
    metadata?: Record<string, unknown>,
  ): Promise<R | void> {
    const processor = this.processors.get(pipeline);
    if (!processor) {
      await this.updateStatus(correlationId, 'failed', null, `No processor registered for pipeline "${pipeline}"`);
      return;
    }

    await this.updateStatus(correlationId, 'processing');

    try {
      const result = await processor(correlationId, payload, metadata);
      await this.updateStatus(correlationId, 'completed', result);
      return result as R;
    } catch (err: any) {
      const errorMsg = err?.message ?? String(err);
      await this.updateStatus(correlationId, 'failed', null, errorMsg);
      throw err;
    }
  }

  private async updateStatus(
    correlationId: string,
    status: SubmissionStatus,
    result?: unknown,
    error?: string,
  ): Promise<void> {
    const envelope = await this.getEnvelope(correlationId);
    if (!envelope) return;

    envelope.status = status;
    if (result !== undefined) envelope.result = result;
    if (error !== undefined) envelope.error = error;
    if (status === 'completed' || status === 'failed') {
      envelope.completedAt = new Date().toISOString();
    }

    await chainletStorage.setItem(correlationId, envelope);

    // ── Callback notification: fire only on terminal status with a callbackAddress ──
    if ((status === 'completed' || status === 'failed') && envelope.callbackAddress) {
      // Gate: check if AsyncResponseFetched event TX already exists
      // If fetchAsyncResponse() already retrieved the result, the TX exists → suppress
      hasAsyncResponseBeenFetched(correlationId).then(async (alreadyRetrieved) => {
        if (alreadyRetrieved) {
          console.log(`[SyncOnAsync] Callback suppressed — AsyncResponseFetched TX exists for ${correlationId}`);
          return;
        }

        // No prior retrieval — dispatch notification
        const result = await dispatchCallbackNotification(
          envelope.callbackAddress!,
          {
            correlationId,
            messageId: envelope.messageId,
            status,
            completedAt: envelope.completedAt ?? new Date().toISOString(),
            pipeline: envelope.pipeline,
          },
        );

        if (result.sent) {
          console.log(`[SyncOnAsync] Callback notification sent via ${result.transport} for ${correlationId}`);
        } else {
          console.log(`[SyncOnAsync] Callback dispatch failed: ${result.reason}`);
        }

        // Emit AsyncResponseFetched event TX AFTER dispatch
        // This gates any future duplicate notifications
        await emitAsyncResponseFetchedTx(
          correlationId,
          envelope.messageId,
          envelope.pipeline,
          'postResponse',
        );
      }).catch(err => {
        console.warn(`[SyncOnAsync] Callback notification failed:`, err);
      });
    }
  }

  private async getEnvelope(correlationId: string): Promise<SubmissionEnvelope | null> {
    // TxID is used directly as key (no prefix needed)
    return chainletStorage.getItem<SubmissionEnvelope>(correlationId);
  }
}

// ─── Singleton Export ─────────────────────────────────────────

export const syncOnAsync = new SyncOnAsyncManager();
