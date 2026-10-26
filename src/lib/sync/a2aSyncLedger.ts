/**
 * COPE node crystallized.
 * Node ID: v12-21-00-a2a-sync-ledger
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Durable A2A sync ledger + in-process copy registry.
 * Events land in cappz-store (chainletStorage) under `cappz:a2a/ledger/…`
 * and notify the middleware bus. Only signals are written — never payloads.
 */

import { chainletStorage } from './chainletStorage';
import { middlewareNotify } from './cappz-middleware';
import type { A2ASyncEvent } from './a2aSyncEvents';
import {
  A2ASyncEngine,
  directTransport,
  relayTransport,
  storeForwardTransport,
  type BlobStore,
  type SyncCopy,
  type SyncEventLedger,
} from './a2aSyncEngine';

const LEDGER_PREFIX = 'cappz:a2a/ledger/';

export const chainletSyncLedger: SyncEventLedger = {
  async append(event: A2ASyncEvent) {
    const key = `${LEDGER_PREFIX}${event.timestamp}/${event.txId}`;
    await chainletStorage.setItem(key, event);
    middlewareNotify('kv', key, 'write', key);
  },
  async appendMany(events: A2ASyncEvent[]) {
    const rows = events.map((event) => [`${LEDGER_PREFIX}${event.timestamp}/${event.txId}`, event] as [string, unknown]);
    await chainletStorage.setItems(rows);
    for (const [key] of rows) middlewareNotify('kv', key, 'write', key);
  },
  async list() {
    const keys = (await chainletStorage.keys()).filter((k) => k.startsWith(LEDGER_PREFIX)).sort();
    const rows = await chainletStorage.getItems<A2ASyncEvent>(keys);
    return rows.filter((r): r is A2ASyncEvent => Boolean(r));
  },
};

/** Encrypted blobs parked for an offline source; TTL-bound, shredded on delivery. */
export const chainletBlobStore: BlobStore = {
  put: (k, v, ttl) => chainletStorage.setItem(k, v, { ttl }),
  get: (k) => chainletStorage.getItem<string>(k),
  delete: (k) => chainletStorage.removeItem(k),
};

/** Copies reachable from this runtime, keyed by copyId. */
const copies = new Map<string, SyncCopy>();

export function registerSyncCopy(copy: SyncCopy): () => void {
  copies.set(copy.copyId, copy);
  return () => copies.delete(copy.copyId);
}

export function listSyncCopies(walletAddress?: string): SyncCopy[] {
  return [...copies.values()].filter((c) => !walletAddress || c.walletAddress === walletAddress);
}

export function getSyncCopy(copyId: string): SyncCopy | undefined {
  return copies.get(copyId);
}

let engine: A2ASyncEngine | null = null;
export function getA2ASyncEngine(): A2ASyncEngine {
  if (!engine) {
    engine = new A2ASyncEngine({
      ledger: chainletSyncLedger,
      transports: [directTransport(), relayTransport(() => false), storeForwardTransport(chainletBlobStore)],
    });
  }
  return engine;
}
