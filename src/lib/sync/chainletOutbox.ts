/**
 * ChainletOutbox — Offline block queue with connectivity-aware drain.
 *
 * v11-2-014: Local-first cappz-store is the default. XRPL anchoring is an
 * OPT-IN secondary tier gated by AnchorStrategy !== 'off' AND a signer being
 * available. Direct browser writes to Supabase have been removed — server-side
 * escrowed cappz-store handles any cloud durability, propagated back to edges
 * via a2a-push (P6).
 *
 * Drain Strategy (MDM-configurable):
 *   - 'off':        do not anchor; entries stay queued (local-first, default)
 *   - 'individual': one Tx per queued block
 *   - 'batch':      Merkle root batching (≤ MaxBatchSize per XRPL memo)
 */

import { chainletStorage } from './chainletStorage';
import { ChainletStoreParamType, getChainletParam } from './chainletStoreParams';
import { xrplChainletAnchor } from '../xrplChainletAnchor';
import type { SyncBlock } from './chainletSyncAdapter';
import CryptoJS from 'crypto-js';


// ─── Types ────────────────────────────────────────────────────

export interface OutboxEntry {
  block: SyncBlock;
  queuedAt: number;
  retryCount: number;
  lastError?: string;
}

export interface ConnectivityState {
  browserOnline: boolean;
  xrplOnline: boolean;
  lastHeartbeat: number;
  consecutiveFailures: number;
}

type ConnectivityListener = (state: ConnectivityState) => void;

// ─── Outbox Manager ───────────────────────────────────────────

const OUTBOX_KEY_PREFIX = 'chainlet_outbox_';

class ChainletOutboxManager {
  private connectivityState: ConnectivityState = {
    browserOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
    xrplOnline: false,
    lastHeartbeat: 0,
    consecutiveFailures: 0,
  };

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private listeners: ConnectivityListener[] = [];
  private isDraining = false;
  private initialized = false;

  // ─── Initialization ───────────────────────────────────────

  async init(): Promise<void> {
    if (this.initialized) return;

    // Layer 1: Browser online/offline events
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.handleBrowserOnline(true));
      window.addEventListener('offline', () => this.handleBrowserOnline(false));
    }

    // Layer 2: Start XRPL heartbeat
    await this.startHeartbeat();

    // Start flush timer
    this.startFlushTimer();

    this.initialized = true;
    console.log('[ChainletOutbox] Initialized with layered connectivity detection');
  }

  destroy(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', () => this.handleBrowserOnline(true));
      window.removeEventListener('offline', () => this.handleBrowserOnline(false));
    }
    this.initialized = false;
  }

  // ─── Connectivity Detection ─────────────────────────────────

  private handleBrowserOnline(online: boolean): void {
    const prev = this.connectivityState.browserOnline;
    this.connectivityState.browserOnline = online;

    if (!prev && online) {
      console.log('[ChainletOutbox] Browser came online, triggering heartbeat');
      this.checkXrplHeartbeat();
    }

    this.notifyListeners();
  }

  private async startHeartbeat(): Promise<void> {
    const intervalMs = getChainletParam(ChainletStoreParamType.HeartbeatIntervalMs);

    // Initial check
    await this.checkXrplHeartbeat();

    // Periodic heartbeat
    this.heartbeatTimer = setInterval(() => {
      this.checkXrplHeartbeat();
    }, intervalMs);
  }

  private async checkXrplHeartbeat(): Promise<void> {
    // v11-2-014: no Supabase probe. XRPL "online" = strategy enabled AND signer available.
    const strategy = getChainletParam(ChainletStoreParamType.AnchorStrategy);
    if (strategy === 'off' || !this.connectivityState.browserOnline) {
      this.connectivityState.xrplOnline = false;
      this.notifyListeners();
      return;
    }
    const online = xrplChainletAnchor.hasSigner();
    if (online) {
      this.connectivityState.xrplOnline = true;
      this.connectivityState.lastHeartbeat = Date.now();
      this.connectivityState.consecutiveFailures = 0;
    } else {
      this.connectivityState.consecutiveFailures++;
      this.connectivityState.xrplOnline = false;
    }
    this.notifyListeners();
  }

  isOnline(): boolean {
    const strategy = getChainletParam(ChainletStoreParamType.AnchorStrategy);
    if (strategy === 'off') return false; // no anchoring needed
    return this.connectivityState.browserOnline && this.connectivityState.xrplOnline;
  }


  getConnectivityState(): ConnectivityState {
    return { ...this.connectivityState };
  }

  onConnectivityChange(listener: ConnectivityListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx > -1) this.listeners.splice(idx, 1);
    };
  }

  private notifyListeners(): void {
    const state = this.getConnectivityState();
    this.listeners.forEach(l => l(state));

    // Trigger drain if we came online
    if (state.browserOnline && state.xrplOnline && !this.isDraining) {
      this.drainOutbox();
    }
  }

  // ─── Outbox Queue Operations ────────────────────────────────

  async enqueue(block: SyncBlock): Promise<void> {
    const entry: OutboxEntry = {
      block,
      queuedAt: Date.now(),
      retryCount: 0,
    };

    await chainletStorage.setItem(`${OUTBOX_KEY_PREFIX}${block.blockHash}`, entry);
    console.log(`[ChainletOutbox] Queued block ${block.blockHash.slice(0, 12)}…`);
  }

  async dequeue(blockHash: string): Promise<void> {
    await chainletStorage.removeItem(`${OUTBOX_KEY_PREFIX}${blockHash}`);
  }

  async getQueuedBlocks(): Promise<OutboxEntry[]> {
    try {
      const keys = await this.getOutboxKeys();
      const entries: OutboxEntry[] = [];

      for (const key of keys) {
        const entry = await chainletStorage.getItem<OutboxEntry>(key);
        if (entry) entries.push(entry);
      }

      // Sort by queued time (FIFO)
      return entries.sort((a, b) => a.queuedAt - b.queuedAt);
    } catch {
      return [];
    }
  }

  async getQueueLength(): Promise<number> {
    const keys = await this.getOutboxKeys();
    return keys.length;
  }

  private async getOutboxKeys(): Promise<string[]> {
    try {
      const allKeys = await chainletStorage.keys();
      return allKeys.filter(k => k.startsWith(OUTBOX_KEY_PREFIX));
    } catch {
      return [];
    }
  }

  // ─── Outbox Drain ───────────────────────────────────────────

  private startFlushTimer(): void {
    const intervalMs = getChainletParam(ChainletStoreParamType.OutboxFlushInterval);

    this.flushTimer = setInterval(() => {
      if (this.isOnline() && !this.isDraining) {
        this.drainOutbox();
      }
    }, intervalMs);
  }

  async drainOutbox(): Promise<number> {
    if (this.isDraining) return 0;
    if (!this.isOnline()) {
      console.log('[ChainletOutbox] Offline, skipping drain');
      return 0;
    }

    this.isDraining = true;
    let anchored = 0;

    try {
      const entries = await this.getQueuedBlocks();
      if (entries.length === 0) {
        return 0;
      }

      console.log(`[ChainletOutbox] Draining ${entries.length} queued blocks`);

      const strategy = getChainletParam(ChainletStoreParamType.AnchorStrategy);

      if (strategy === 'batch') {
        anchored = await this.drainBatch(entries);
      } else {
        anchored = await this.drainIndividual(entries);
      }

      console.log(`[ChainletOutbox] Drained ${anchored} blocks`);
    } catch (err) {
      console.error('[ChainletOutbox] Drain failed:', err);
    } finally {
      this.isDraining = false;
    }

    return anchored;
  }

  private async drainIndividual(entries: OutboxEntry[]): Promise<number> {
    let anchored = 0;

    for (const entry of entries) {
      try {
        await this.anchorBlock(entry.block);
        await this.dequeue(entry.block.blockHash);
        anchored++;
      } catch (err) {
        console.warn(`[ChainletOutbox] Failed to anchor ${entry.block.blockHash}:`, err);
        entry.retryCount++;
        entry.lastError = String(err);
        await chainletStorage.setItem(`${OUTBOX_KEY_PREFIX}${entry.block.blockHash}`, entry);
      }
    }

    return anchored;
  }

  private async drainBatch(entries: OutboxEntry[]): Promise<number> {
    const maxBatch = getChainletParam(ChainletStoreParamType.MaxBatchSize);
    const batch = entries.slice(0, maxBatch);
    if (batch.length === 0) return 0;

    try {
      const blockHashes = batch.map(e => e.block.blockHash);
      const merkleRoot = this.computeMerkleRoot(blockHashes);
      const notarizedAt = new Date().toISOString();

      const result = await xrplChainletAnchor.anchorBatch({
        merkleRoot,
        blockHashes,
        batchSize: batch.length,
        notarizedAt,
      });

      console.log(`[XRPLChainletAnchor] anchored batch tx=${result.txHash} ledger=${result.ledgerIndex} size=${batch.length}`);

      for (const entry of batch) {
        (entry as OutboxEntry & { xrplTxHash?: string; xrplLedgerIndex?: number }).xrplTxHash = result.txHash;
        (entry as OutboxEntry & { xrplTxHash?: string; xrplLedgerIndex?: number }).xrplLedgerIndex = result.ledgerIndex;
        await this.dequeue(entry.block.blockHash);
      }

      return batch.length;
    } catch (err) {
      console.warn('[ChainletOutbox] Batch anchor failed (will retry):', err);
      // Non-fatal — keep entries in outbox for retry.
      for (const entry of batch) {
        entry.retryCount++;
        entry.lastError = String(err);
        await chainletStorage.setItem(`${OUTBOX_KEY_PREFIX}${entry.block.blockHash}`, entry);
      }
      return 0;
    }
  }

  private async anchorBlock(block: SyncBlock): Promise<void> {
    // Individual-anchor path uses the same XRPL memo shape, singleton batch.
    const merkleRoot = CryptoJS.SHA256(JSON.stringify(block.value)).toString();
    const result = await xrplChainletAnchor.anchorBatch({
      merkleRoot,
      blockHashes: [block.blockHash],
      batchSize: 1,
      notarizedAt: new Date(block.timestamp).toISOString(),
    });
    console.log(`[XRPLChainletAnchor] anchored individual tx=${result.txHash} ledger=${result.ledgerIndex} block=${block.blockHash.slice(0, 12)}…`);
  }


  private computeMerkleRoot(hashes: string[]): string {
    if (hashes.length === 0) return '0'.repeat(64);
    if (hashes.length === 1) return hashes[0];

    const nextLevel: string[] = [];
    for (let i = 0; i < hashes.length; i += 2) {
      const left = hashes[i];
      const right = hashes[i + 1] || left; // Duplicate last if odd
      nextLevel.push(CryptoJS.SHA256(left + right).toString());
    }

    return this.computeMerkleRoot(nextLevel);
  }
}

// ─── Singleton Export ─────────────────────────────────────────

export const chainletOutbox = new ChainletOutboxManager();
