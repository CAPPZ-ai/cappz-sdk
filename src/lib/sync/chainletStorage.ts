/**
 * ChainletStorage — the async key-value API over cappz-store (the kv store).
 *

 * v15-03-00: backed by cappz-store through offlineCache, which talks to the
 * cappz-store engine directly (no IndexedDB-shaped facade). setItems awaits
 * the disk; setItem queues (≤150 ms, flushed when the tab hides) unless
 * `{ durable: true }`.
 * Provides the same API surface as Web Storage but async, with:
 *   - No 5MB limit (cappz-middleware uses client-side storage internally)
 *   - Wallet-scoping (optional)
 *   - TTL-based expiry
 *   - AES-256 encryption support (via offlineCache layer)
 * 
 * Usage:
 *   import { chainletStorage } from './chainletStorage';
 *   await chainletStorage.setItem('key', { data: true });
 *   const val = await chainletStorage.getItem('key');
 *   await chainletStorage.removeItem('key');
 * 
 * Zustand persist adapter:
 *   import { chainletStorageAdapter } from './chainletStorage';
 *   create(persist(fn, { storage: chainletStorageAdapter }))
 * 
 * Standalone — no Supabase dependency. Pure client cappz-middleware.
 */

import { offlineCache, type StoreName } from '../offlineCache';
import type { AdminQueueTx } from '../wallets/AdminQueue';

// ─── Core Storage API ─────────────────────────────────────────

import { ChainletStoreParamType, getChainletParam } from './chainletStoreParams';

const KV_STORE = getChainletParam(ChainletStoreParamType.KvStoreName) as StoreName;

export const chainletStorage = {
  /**
   * Store a value. Replaces localStorage.setItem().
   */
  async setItem<T = unknown>(key: string, value: T, opts?: { ttl?: number; walletAddress?: string; durable?: boolean }): Promise<void> {
    await offlineCache.set(KV_STORE, key, value, opts);
  },

  /** Store many values in ONE batch — all or nothing, on disk before this returns. */
  async setItems(rows: Array<[key: string, value: unknown]>): Promise<void> {
    await offlineCache.setMany(KV_STORE, rows.map(([key, value]) => ({ key, value })));
  },

  /**
   * Retrieve a value. Returns null if missing or expired.
   * Replaces localStorage.getItem().
   */
  async getItem<T = unknown>(key: string): Promise<T | null> {
    return offlineCache.get<T>(KV_STORE, key);
  },

  /**
   * v12-14-a: Batch retrieve. One store transaction for many keys.
   * Missing/expired keys come back as null in the same order.
   */
  async getItems<T = unknown>(keys: string[]): Promise<Array<T | null>> {
    return offlineCache.getMany<T>(KV_STORE, keys);
  },



  /**
   * Remove a value. Replaces localStorage.removeItem().
   */
  async removeItem(key: string): Promise<void> {
    await offlineCache.delete(KV_STORE, key);
  },

  /**
   * List all keys in the kv store (for scanning/iteration).
   * No localStorage equivalent — bonus for chainlet.
   */
  async keys(): Promise<string[]> {
    try {
      return await offlineCache.keys(KV_STORE);
    } catch {
      return [];
    }
  },

  /**
   * Clear all kv entries. Replaces localStorage.clear().
   */
  async clear(): Promise<void> {
    await offlineCache.clearStore(KV_STORE);
  },

  /** Wait until every queued write is on disk. */
  async flush(): Promise<void> {
    await offlineCache.flush();
  },

  /**
   * Fetch active event TXs from a persisted admin queue at a given address.
   * Reads the TX history from cappz-middleware KV, then applies the
   * DuplicateTxRemediation active-set filter.
   *
   * This is the persistence-layer equivalent of WalletAgent.fetchActiveEventTxs().
   * Use when you have an HD address but not a live AdminQueue instance.
   *
   * @param adminAddress - The admin queue HD address (e.g., m/44'/144'/21'/agent/admin)
   * @returns Active (non-deprecated, non-remediation) TXs
   */
  async fetchActiveEventTxs(adminAddress: string): Promise<AdminQueueTx[]> {
    const key = `adminqueue:${adminAddress}`;
    const stored = await offlineCache.get<{ txHistory: AdminQueueTx[] }>('kv', key);
    if (!stored?.txHistory?.length) return [];

    // Apply same filter logic as getActiveTxs (single source of truth)
    const deprecatedMsgIds = new Set<string>();
    const correlatedOriginalIds = new Set<string>();

    for (const tx of stored.txHistory) {
      if (tx.eventType === 'DuplicateTxDeprecated') {
        if (tx.supersedesTx) deprecatedMsgIds.add(tx.supersedesTx);
        if (tx.orgnlMsgId) correlatedOriginalIds.add(tx.orgnlMsgId);
      }
    }

    return stored.txHistory.filter(tx =>
      !deprecatedMsgIds.has(tx.msgId) &&
      !correlatedOriginalIds.has(tx.msgId) &&
      tx.eventType !== 'DuplicateTxDeprecated' &&
      tx.eventType !== 'DuplicateTxRemediationCompleted'
    );
  },

  /**
   * Get all entries for a wallet address.
   */
  async getByWallet<T = unknown>(walletAddress: string): Promise<T[]> {
    return offlineCache.getByWallet<T>(KV_STORE, walletAddress);
  },

  /**
   * Fetch event TXs whose targetAddress matches the given address or any descendant path.
   * Scans all `cappz:event/*` KV entries and filters by targetAddress prefix.
   * Returns AdminQueueTx-compatible objects sorted newest-first.
   */
  async fetchEventsByTarget(targetAddress: string): Promise<AdminQueueTx[]> {
    try {
      const allKeys = await chainletStorage.keys();
      const eventKeys = allKeys.filter(k => k.startsWith('cappz:event/'));
      if (!eventKeys.length) return [];

      const isTargetMatch = (eventTarget: unknown) => {
        if (typeof eventTarget !== 'string' || !eventTarget) return false;
        return eventTarget === targetAddress || eventTarget.startsWith(`${targetAddress}/`);
      };

      const results: AdminQueueTx[] = [];
      await Promise.all(
        eventKeys.map(async (key) => {
          try {
            const entry = await chainletStorage.getItem<Record<string, unknown>>(key);
            if (!entry || !isTargetMatch(entry.targetAddress)) return;
            results.push({
              msgId: (entry.txId as string) || (entry.msgId as string) || key,
              eventType: (entry.eventType as string) || 'Unknown',
              timestamp: (entry.timestamp as string) || new Date().toISOString(),
              sourceAddress: (entry.sourceAddress as string) || '',
              targetAddress: (entry.targetAddress as string) || '',
              orgnlMsgId: entry.orgnlMsgId as string | undefined,
              supersedesTx: entry.supersedesTx as string | undefined,
              payload: (entry.metadata ?? entry.payload ?? entry) as Record<string, unknown>,
              // Same object under the event-TX field name — readers use either.
              metadata: (entry.metadata ?? entry.payload ?? entry) as Record<string, unknown>,

              txHash: entry.txHash as string | undefined,
            });
          } catch { /* skip unreadable entries */ }
        }),
      );

      return results.sort((a, b) => {
        const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return tb - ta;
      });
    } catch {
      return [];
    }
  },
};

// ─── Zustand Persist Adapter ──────────────────────────────────

/**
 * Drop-in storage adapter for zustand/middleware persist.
 * 
 * Usage:
 *   import { create } from 'zustand';
 *   import { persist } from 'zustand/middleware';
 *   import { chainletStorageAdapter } from './chainletStorage';
 * 
 *   const useMyStore = create(
 *     persist(
 *       (set) => ({ ... }),
 *       { name: 'my-store', storage: chainletStorageAdapter }
 *     )
 *   );
 */
export const chainletStorageAdapter = {
  getItem: async (name: string): Promise<string | null> => {
    const val = await chainletStorage.getItem<string>(name);
    return val;
  },
  setItem: async (name: string, value: string): Promise<void> => {
    await chainletStorage.setItem(name, value);
  },
  removeItem: async (name: string): Promise<void> => {
    await chainletStorage.removeItem(name);
  },
};
