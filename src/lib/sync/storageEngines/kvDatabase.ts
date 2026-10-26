/**
 * KvDatabase — the cappz-store database over a KvBackend (v12-23-07).
 *
 * Named stores of rows keyed by `key`, held in memory and persisted by the
 * backend (OPFS segments and shards, or memory). The native API (read /
 * write / remove / keysOf …) marks only the keys a write changed; `flush()`
 * makes it durable.
 *
 * v15-04-00: the IndexedDB-shaped request/transaction/cursor facade that
 * kept old cappz-middleware callers running is retired with them.
 */

import type { KvBackend } from './kvBackends';

const clone = <T>(v: T): T => {
  try { return typeof structuredClone === 'function' ? structuredClone(v) : v; } catch { return v; }
};

export class KvDatabase {
  private stores = new Map<string, Map<string, unknown>>();
  private loading = new Map<string, Promise<void>>();

  constructor(readonly name: string, private backend: KvBackend) {}

  async ensureLoaded(names: string[]): Promise<void> {
    const extra = await this.backend.listStores();
    await Promise.all([...new Set([...names, ...extra])].map((n) => this.loadStore(n)));
  }

  private loadStore(name: string): Promise<void> {
    let p = this.loading.get(name);
    if (!p) {
      p = this.backend.load(name).then((loaded) => {
        const current = this.stores.get(name);
        if (!current) { this.stores.set(name, loaded); return; }
        // Transactions can create the hot map while OPFS is loading. Keep
        // newer writes, but restore every persisted key not yet in that map.
        for (const [key, value] of loaded) if (!current.has(key)) current.set(key, value);
      });
      this.loading.set(name, p);
    }
    return p;
  }

  /** Synchronous map access; unknown stores start empty (loaded lazily). */
  map(name: string): Map<string, unknown> {
    let m = this.stores.get(name);
    if (!m) { m = new Map(); this.stores.set(name, m); void this.loadStore(name); }
    return m;
  }

  /** Bulk import (archive → engine). */
  importRows(name: string, rows: unknown[]): number {
    const m = this.map(name);
    let n = 0;
    for (const r of rows) {
      const k = (r as { key?: unknown })?.key;
      if (k === undefined) continue;
      m.set(String(k), r); n += 1;
    }
    this.backend.persist(name, m, 'all');
    return n;
  }

  snapshot(): Record<string, unknown[]> {
    const out: Record<string, unknown[]> = {};
    for (const [n, m] of this.stores) out[n] = [...m.values()];
    return out;
  }

  flush() { return this.backend.flush(); }

  /** Mark changed keys (or 'all') for the next flush; the backend writes only what changed. */
  touch(name: string, changed: Iterable<string> | 'all' = 'all') { this.backend.persist(name, this.map(name), changed); }

  // ─── cappz-store native API ───────────────────────────────────────────────
  /** Resolves once a store's persisted rows are in memory (reads never see a half-loaded store). */
  ready(name: string): Promise<void> { this.map(name); return this.loadStore(name); }

  async read<T = unknown>(name: string, key: string): Promise<T | undefined> {
    await this.ready(name);
    return clone(this.map(name).get(key)) as T | undefined;
  }

  async readMany<T = unknown>(name: string, keys: string[]): Promise<Array<T | undefined>> {
    await this.ready(name);
    const m = this.map(name);
    return keys.map((k) => clone(m.get(k)) as T | undefined);
  }

  /** Every row, in key order. */
  async readAll<T = unknown>(name: string): Promise<T[]> {
    await this.ready(name);
    const m = this.map(name);
    return [...m.keys()].sort().map((k) => clone(m.get(k)) as T);
  }

  async keysOf(name: string): Promise<string[]> {
    await this.ready(name);
    return [...this.map(name).keys()].sort();
  }

  /** Write rows together: one dirty batch, so they reach disk in the same segment. */
  async write(name: string, rows: Array<[key: string, value: unknown]>): Promise<void> {
    await this.ready(name);
    const m = this.map(name);
    for (const [k, v] of rows) m.set(k, clone(v));
    this.touch(name, rows.map(([k]) => k));
  }

  async remove(name: string, keys: string[]): Promise<void> {
    await this.ready(name);
    const m = this.map(name);
    for (const k of keys) m.delete(k);
    this.touch(name, keys);
  }

  async clearStore(name: string): Promise<void> {
    await this.ready(name);
    this.map(name).clear();
    this.touch(name, 'all');
  }
}
