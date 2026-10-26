/**
 * offlineCache — the cappz-store key-value facade (session, profile, kv, …).
 *
 * Stores: session tokens, wallet profile, transactions, appointments,
 * dashboard data, and arbitrary key-value pairs for complete offline capability.
 *
 * v15-03-00 — ported onto cappz-store. Reads and writes go straight to the
 * cappz-store engine (OPFS, or memory where OPFS is missing) through the
 * KvDatabase native API. v15-04-00: the IndexedDB-shaped facade and the idb
 * rollback engine are retired; there is one path.
 *
 * Durability: a write is in memory at once and on disk at the next flush
 * (150 ms, or when the tab hides). Writes that must survive a tab kill
 * await the flush before returning: the `session` and `profile` stores
 * always, `setMany` (correlated batches) always, anything else with
 * `{ durable: true }`.
 */

import { MIDDLEWARE_DB_NAME } from './sync/cappz-middleware';
import { middlewareNotify } from './sync/storeBus';
import { openCappzStore } from './sync/storageEngines/engineSelection';
import type { KvDatabase } from './sync/storageEngines/kvDatabase';

/** The cappz-store database these stores live in (legacy name kept: it is the OPFS directory key). */
export const CAPPZ_STORE_DB = MIDDLEWARE_DB_NAME;

export type StoreName =
  | 'session'       // wallet auth session
  | 'profile'       // user/wallet profile data
  | 'transactions'  // recent chainlet/XRPL transactions
  | 'appointments'  // healthcare appointments
  | 'dashboard'     // dashboard metrics snapshots
  | 'kv';           // generic key-value cache

const STORE_NAMES: StoreName[] = [
  'session', 'profile', 'transactions', 'appointments', 'dashboard', 'kv',
];

/** Stores whose every write awaits the disk before returning. */
const DURABLE_STORES = new Set<StoreName>(['session', 'profile']);

/** Max age defaults (ms) — per store */
const DEFAULT_TTL: Record<StoreName, number> = {
  session: 24 * 60 * 60 * 1000,       // 24 h
  profile: 7 * 24 * 60 * 60 * 1000,   // 7 d
  transactions: 30 * 60 * 1000,        // 30 min
  appointments: 60 * 60 * 1000,        // 1 h
  dashboard: 15 * 60 * 1000,           // 15 min
  kv: Infinity,                         // sovereign chainlet TXs — must never expire
};

interface CacheEntry<T = unknown> {
  key: string;
  value: T;
  cachedAt: number;   // epoch ms
  ttl: number | null; // ms; null means non-expiring across JSON/OPFS serialization
  walletAddress?: string;
}

export interface WriteOptions { ttl?: number | null; walletAddress?: string; durable?: boolean }

const ttlOf = (store: StoreName, ttl: number | null | undefined) => {
  const t = ttl === undefined ? DEFAULT_TTL[store] : ttl;
  return t != null && Number.isFinite(t) ? t : null;
};
const expired = (e: CacheEntry, now = Date.now()) => e.ttl != null && now - e.cachedAt > e.ttl;
const entryOf = <T>(store: StoreName, key: string, value: T, opts: WriteOptions | undefined, now: number): CacheEntry<T> =>
  ({ key, value, cachedAt: now, ttl: ttlOf(store, opts?.ttl), walletAddress: opts?.walletAddress });

/** Store operations on the active engine. */
interface Ops {
  put(store: StoreName, entries: CacheEntry[]): Promise<void>;
  get<T>(store: StoreName, keys: string[]): Promise<Array<CacheEntry<T> | undefined>>;
  all<T>(store: StoreName): Promise<CacheEntry<T>[]>;
  keys(store: StoreName): Promise<string[]>;
  remove(store: StoreName, keys: string[]): Promise<void>;
  clear(store: StoreName): Promise<void>;
  flush(): Promise<void>;
}

const nativeOps = (db: KvDatabase): Ops => ({
  put: (store, entries) => db.write(store, entries.map((e) => [e.key, e])),
  get: (store, keys) => db.readMany(store, keys),
  all: (store) => db.readAll(store),
  keys: (store) => db.keysOf(store),
  remove: (store, keys) => db.remove(store, keys),
  clear: (store) => db.clearStore(store),
  flush: () => db.flush(),
});

let opsPromise: Promise<Ops> | null = null;
const ops = (): Promise<Ops> => (opsPromise ??= openCappzStore().then(nativeOps));

const notify = (store: StoreName, key: string, type: 'write' | 'delete' | 'clear') =>
  // AX-75: pass the HD address (store/key) — not a copy of the value
  middlewareNotify(store, key, type, `${store}/${key}`);

// ─── Public API ────────────────────────────────────────────────

export const offlineCache = {
  /** Put a value into a store. Durable before return for session/profile, or with `durable: true`. */
  async set<T>(store: StoreName, key: string, value: T, opts?: WriteOptions): Promise<void> {
    const o = await ops();
    await o.put(store, [entryOf(store, key, value, opts, Date.now())]);
    if (opts?.durable ?? DURABLE_STORES.has(store)) await o.flush();
    notify(store, key, 'write');
  },

  /**
   * Put many values as ONE batch: all reach disk in the same segment, or
   * none do, and the call returns after the disk write. Callers that must
   * never leave a partial batch (a business record without its journal
   * entry, a batch without its index or chain block) use this.
   */
  async setMany(store: StoreName, rows: Array<{ key: string; value: unknown; ttl?: number | null; walletAddress?: string }>, opts?: { durable?: boolean }): Promise<void> {
    if (rows.length === 0) return;
    const now = Date.now();
    const o = await ops();
    await o.put(store, rows.map((r) => entryOf(store, r.key, r.value, r, now)));
    if (opts?.durable ?? true) await o.flush();
    for (const row of rows) notify(store, row.key, 'write');
  },

  /** Get a value; returns null if missing or expired. */
  async get<T>(store: StoreName, key: string): Promise<T | null> {
    const [entry] = await (await ops()).get<T>(store, [key]);
    if (!entry) return null;
    if (expired(entry)) {
      this.delete(store, key).catch(() => {}); // expired — delete lazily
      return null;
    }
    return entry.value;
  },

  /** Batch get: one engine read for many keys; missing/expired come back null, same order. */
  async getMany<T>(store: StoreName, keys: string[]): Promise<Array<T | null>> {
    if (keys.length === 0) return [];
    const entries = await (await ops()).get<T>(store, keys);
    const now = Date.now();
    return entries.map((e) => (!e || expired(e, now) ? null : e.value));
  },

  /** Every key in a store (expired rows included until purged). */
  async keys(store: StoreName): Promise<string[]> {
    return (await ops()).keys(store);
  },

  /** Delete a single key. */
  async delete(store: StoreName, key: string): Promise<void> {
    const o = await ops();
    await o.remove(store, [key]);
    if (DURABLE_STORES.has(store)) await o.flush(); // a removed session must not come back after a crash
    notify(store, key, 'delete');
  },

  /** Every non-expired entry of a store, with its key and wallet (raw readers such as renotarize). */
  async entries<T>(store: StoreName): Promise<Array<{ key: string; value: T; walletAddress?: string }>> {
    const now = Date.now();
    return (await (await ops()).all<T>(store)).filter((e) => !expired(e, now)).map((e) => ({ key: e.key, value: (e.value ?? (e as { data?: T }).data) as T, walletAddress: e.walletAddress }));
  },

  /** Get all non-expired entries for a wallet. */
  async getByWallet<T>(store: StoreName, walletAddress: string): Promise<T[]> {
    const now = Date.now();
    return (await (await ops()).all<T>(store)).filter((e) => e.walletAddress === walletAddress && !expired(e, now)).map((e) => e.value);
  },

  /** Clear a single store. */
  async clearStore(store: StoreName): Promise<void> {
    const o = await ops();
    await o.clear(store);
    await o.flush();
    middlewareNotify(store, '', 'clear', `${store}/`);
  },

  /** Nuke everything — full logout. */
  async clearAll(): Promise<void> {
    const o = await ops();
    for (const name of STORE_NAMES) await o.clear(name);
    await o.flush();
  },

  /** Purge expired entries across all stores (call periodically). */
  async purgeExpired(): Promise<number> {
    let purged = 0;
    const now = Date.now();
    const o = await ops();
    for (const name of STORE_NAMES) {
      const doomed = (await o.all(name)).filter((e) => expired(e, now)).map((e) => e.key);
      if (doomed.length) { await o.remove(name, doomed); purged += doomed.length; }
    }
    return purged;
  },

  /** Wait until every queued write is on disk. */
  async flush(): Promise<void> {
    await (await ops()).flush();
  },
};

/** Test hook: re-resolve the engine on next use. */
export function __resetOfflineCacheForTests() { opsPromise = null; }

// Auto-purge expired entries every 5 minutes
if (typeof window !== 'undefined') {
  setInterval(() => {
    offlineCache.purgeExpired().catch(() => {});
  }, 5 * 60 * 1000);
}
