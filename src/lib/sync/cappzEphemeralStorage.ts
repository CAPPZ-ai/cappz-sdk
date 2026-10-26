/**
 * cappzEphemeralStorage — Volatile storage with configurable purge directives.
 *
 * Used by Session Agent Skill for session-scoped data that should not persist
 * beyond the configured TTL or session boundary.
 *
 * Purge directives:
 *   - TTL: Auto-expire after N milliseconds
 *   - session-end: Purge when session ends (explicit call or page unload)
 *   - explicit: Only removed via explicit discard() call
 *
 * Replaces offlineCache volatile mode.
 * AX-63: Flows through cappz-middleware stack (in-memory only, no IDB).
 * AX-77: Hosted in a session wallet with admin queue (InfraSessionWallet).
 * HD: m/44'/144'/0'/cappz/storage/ephemeral
 */

import { InfraSessionWallet } from './InfraSessionWallet';

// ─── Types ────────────────────────────────────────────────────

export type PurgeDirective = 'ttl' | 'session-end' | 'explicit';

export interface EphemeralEntry<T = unknown> {
  key: string;
  value: T;
  directive: PurgeDirective;
  createdAt: number;
  ttlMs?: number;
  walletAddress?: string;
}

// ─── Ephemeral Storage ────────────────────────────────────────

class CappzEphemeralStorage {
  private _store = new Map<string, EphemeralEntry>();
  private _purgeInterval: ReturnType<typeof setInterval> | null = null;

  /** AX-77: Session wallet with admin queue */
  readonly wallet: InfraSessionWallet;

  constructor(domain?: string) {
    this.wallet = new InfraSessionWallet({
      serviceType: 'EphemeralStorage',
      domain: domain ?? 'global',
    });

    // Start TTL purge cycle
    if (typeof window !== 'undefined') {
      this._purgeInterval = setInterval(() => this._purgeTTL(), 30_000);

      // Session-end purge on page unload
      window.addEventListener('beforeunload', () => {
        this._purgeSessionEnd();
      });

      // AX-77: Emit session creation
      this.wallet.sessionCreated().catch(() => {});
    }
  }

  // ─── Write ────────────────────────────────────────────────

  /**
   * Store a volatile value with a purge directive.
   */
  set<T = unknown>(
    key: string,
    value: T,
    opts: { directive?: PurgeDirective; ttlMs?: number; walletAddress?: string } = {},
  ): void {
    const entry: EphemeralEntry<T> = {
      key,
      value,
      directive: opts.directive ?? 'session-end',
      createdAt: Date.now(),
      ttlMs: opts.ttlMs,
      walletAddress: opts.walletAddress,
    };
    this._store.set(key, entry as EphemeralEntry);
  }

  // ─── Read ─────────────────────────────────────────────────

  /**
   * Get a volatile value. Returns null if missing or TTL-expired.
   */
  get<T = unknown>(key: string): T | null {
    const entry = this._store.get(key) as EphemeralEntry<T> | undefined;
    if (!entry) return null;

    // Check TTL
    if (entry.directive === 'ttl' && entry.ttlMs) {
      if (Date.now() - entry.createdAt > entry.ttlMs) {
        this._store.delete(key);
        return null;
      }
    }

    return entry.value;
  }

  // ─── Delete ───────────────────────────────────────────────

  /**
   * Explicitly discard a value.
   */
  discard(key: string): boolean {
    return this._store.delete(key);
  }

  /**
   * Discard all entries for a wallet.
   */
  discardByWallet(walletAddress: string): number {
    let count = 0;
    for (const [key, entry] of this._store) {
      if (entry.walletAddress === walletAddress) {
        this._store.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Clear all ephemeral storage.
   */
  clear(): void {
    this._store.clear();
  }

  // ─── Purge ────────────────────────────────────────────────

  /**
   * Purge all session-end entries (called on page unload or explicit session end).
   */
  async endSession(): Promise<void> {
    this._purgeSessionEnd();
    // AX-77: Emit session ended lifecycle TX
    await this.wallet.emitLifecycleTx('EphemeralPurgeSessionEnd', {
      purgedCount: this._store.size,
    });
  }

  private _purgeTTL(): void {
    const now = Date.now();
    for (const [key, entry] of this._store) {
      if (entry.directive === 'ttl' && entry.ttlMs && now - entry.createdAt > entry.ttlMs) {
        this._store.delete(key);
      }
    }
  }

  private _purgeSessionEnd(): void {
    for (const [key, entry] of this._store) {
      if (entry.directive === 'session-end') {
        this._store.delete(key);
      }
    }
  }

  // ─── Introspection ───────────────────────────────────────

  get size(): number {
    return this._store.size;
  }

  keys(): string[] {
    return Array.from(this._store.keys());
  }

  /**
   * Destroy the storage and clean up intervals.
   */
  async destroy(): Promise<void> {
    if (this._purgeInterval) {
      clearInterval(this._purgeInterval);
      this._purgeInterval = null;
    }
    this._store.clear();
    await this.wallet.sessionEnded();
  }
}

// ─── Singleton ────────────────────────────────────────────────

export const cappzEphemeralStorage = new CappzEphemeralStorage();
