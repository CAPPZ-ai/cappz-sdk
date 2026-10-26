/**
 * InfraSessionWallet — Infrastructure-as-Wallet base class (AX-77).
 *
 * Every key infrastructure service (cache, ephemeral store, content cache)
 * is hosted in a session wallet with an administrative agent. This base class
 * provides:
 *   - Session wallet creation with unique session ID
 *   - Admin queue for lifecycle TXs
 *   - Audit trail via chainletStorage events
 *   - Governance hooks for agent-level cache administration
 *
 * Bare singletons without admin queues, lifecycle events, or governance
 * violate AP-23 (Ungoverned Infrastructure).
 *
 * HD: m/44'/144'/0'/cappz/sync/infra/{serviceType}/{sessionId}
 */

import { chainletStorage } from './chainletStorage';
import { middlewareNotify } from './cappz-middleware';

// ─── Types ────────────────────────────────────────────────────

export interface InfraLifecycleTx {
  txId: string;
  eventType: string;
  serviceType: string;
  sessionId: string;
  hdAddress: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface InfraSessionWalletConfig {
  serviceType: string;
  domain?: string; // e.g., 'codex', 'wama', 'repoz'
}

// ─── Session Wallet ───────────────────────────────────────────

export class InfraSessionWallet {
  readonly sessionId: string;
  readonly serviceType: string;
  readonly domain: string;
  readonly hdRoot: string;
  private _adminQueue: InfraLifecycleTx[] = [];
  private _createdAt: string;

  constructor(config: InfraSessionWalletConfig) {
    this.sessionId = crypto.randomUUID().slice(0, 12);
    this.serviceType = config.serviceType;
    this.domain = config.domain ?? 'global';
    this.hdRoot = `m/44'/144'/0'/cappz/sync/infra/${this.serviceType}/${this.domain}/${this.sessionId}`;
    this._createdAt = new Date().toISOString();
  }

  // ─── Lifecycle TXs ────────────────────────────────────────

  /**
   * Emit a lifecycle TX to the admin queue and persist to chainletStorage.
   */
  async emitLifecycleTx(eventType: string, metadata?: Record<string, unknown>): Promise<InfraLifecycleTx> {
    const tx: InfraLifecycleTx = {
      txId: crypto.randomUUID(),
      eventType,
      serviceType: this.serviceType,
      sessionId: this.sessionId,
      hdAddress: `${this.hdRoot}/admin/${eventType}`,
      timestamp: new Date().toISOString(),
      metadata,
    };

    this._adminQueue.push(tx);

    // Persist to chainletStorage
    const key = `cappz:infra/${this.serviceType}/${this.sessionId}/${tx.txId}`;
    await chainletStorage.setItem(key, tx);
    middlewareNotify('kv', key, 'write', key);

    return tx;
  }

  /**
   * Emit session creation event.
   */
  async sessionCreated(): Promise<InfraLifecycleTx> {
    return this.emitLifecycleTx(`${this.serviceType}SessionCreated`, {
      domain: this.domain,
      createdAt: this._createdAt,
    });
  }

  /**
   * Emit session ended event.
   */
  async sessionEnded(): Promise<InfraLifecycleTx> {
    return this.emitLifecycleTx(`${this.serviceType}SessionEnded`, {
      domain: this.domain,
      adminQueueLength: this._adminQueue.length,
    });
  }

  // ─── Introspection ───────────────────────────────────────

  get adminQueueLength(): number {
    return this._adminQueue.length;
  }

  get createdAt(): string {
    return this._createdAt;
  }

  getAdminHistory(): InfraLifecycleTx[] {
    return [...this._adminQueue];
  }
}
