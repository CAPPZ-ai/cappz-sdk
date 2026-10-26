/**
 * cappz-middleware — what remains of the original persistence base layer.
 *
 * v15-04-00: the IndexedDB-shaped API (executeTx, createStore, dropStore,
 * cursor, index, getAll, count, getAllKeys, the migration-status store and
 * the idb rollback engine behind them) is retired. Every store facade
 * (offlineCache, chainletStorage) runs on cappz-store (OPFS, memory where
 * OPFS is missing) through the KvDatabase native API; legacy IndexedDB is
 * read once, archived to a verified wallet blob and imported, never written.
 *
 * Kept here for existing callers:
 *   - the database name (the cappz-store directory key and archive source),
 *   - submit(): route a write to a named storage pipeline (cappzStorage),
 *   - re-exports of the store bus (storeBus.ts).
 */

import { ChainletStoreParamType, getChainletParam } from './chainletStoreParams';

export const MIDDLEWARE_DB_NAME = getChainletParam(ChainletStoreParamType.MiddlewareDbName);

// v15-03-00: the bus lives in storeBus.ts (cappz-store); re-exported so the
// existing subscribers keep their import path.
export { middlewareNotify, middlewareSubscribe, middlewareManagedSubscribe, type MutationType, type MiddlewareListener } from './storeBus';

export const cappzMiddleware = {
  /**
   * Route a write request to a named pipeline/BPMN process — the canonical
   * write entry point for cappz-storage mutations
   * (pipeline: 'cappzStorageBPMN' | 'ingestContentPipeline').
   */
  async submit(params: Parameters<typeof import('./cappzStorage').cappzStorage.submit>[0]) {
    // Lazy import to avoid a circular dependency.
    const { cappzStorage } = await import('./cappzStorage');
    return cappzStorage.submit(params);
  },
};
