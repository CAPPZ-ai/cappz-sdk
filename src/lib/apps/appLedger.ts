/**
 * COPE node crystallized. Node ID: v14-19-00-app-ledger.
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * One event log per app wallet, on the chainlet substrate (CappzEventCache at
 * the app POW's event-log address). Every TX is a notarized event of an
 * MDM-declared type (undeclared types are refused, not recorded); state is
 * replayed from TXs by the app's pure resolvers (AP-12), never stored as
 * flags. Batches commit all-or-nothing, so a stage lands whole or not at all.
 */
import { CappzEventCache, type CappzEventCacheEntry } from '../sync/CappzEventCache';
import { createNotarizedEvent, type EventCustodyStatus } from '../mdm/eventCustody';
import { sha256Hex } from '../governance/PrinciplesChainlet';

export interface AppTx<E extends string> extends CappzEventCacheEntry {
  eventType: E;
  sourceAddress: string;
  targetAddress: string;
  payload: Record<string, unknown> & { governingPrinciple: string };
  eventMdmAddress: string;
  eventRegistrationTxId: string;
  custodyStatus: EventCustodyStatus;
  txHash: string;
}

/** Minimal shape pure resolvers replay (tests and in-memory demos build these directly). */
export type AppTxLike<E extends string = string> = Pick<AppTx<E>, 'txId' | 'eventType' | 'sourceAddress' | 'targetAddress' | 'payload' | 'timestamp'>;

export interface AppLedger<E extends string> {
  create(params: { eventType: E; sourceAddress: string; targetAddress: string; payload: Record<string, unknown>; txId?: string }): Promise<AppTx<E>>;
  append(txs: AppTx<E>[]): Promise<AppTx<E>[]>;
  emit(params: { eventType: E; sourceAddress: string; targetAddress: string; payload: Record<string, unknown>; txId?: string }): Promise<AppTx<E>>;
  refresh(): Promise<AppTx<E>[]>;
  /** Shared ledgers: publish entries this device holds that the public copy lacks; 0 otherwise. */
  shareExisting(): Promise<number>;
  get(): AppTx<E>[];
  subscribe(fn: (txs: AppTx<E>[]) => void): () => void;
}

/**
 * 15.39.0 — `shared: true` for an admin-governed ledger: every append is published to the
 * log's public copy first (sharedEventLog.ts) and every device merges it on refresh.
 */
export function createAppLedger<E extends string>(params: { eventLog: string; cachePrefix: string; emitterDomain: string; governingPrinciple: string; shared?: boolean }): AppLedger<E> {
  const cache = new CappzEventCache<AppTx<E>>(params.eventLog, params.cachePrefix, { shared: params.shared });
  const create: AppLedger<E>['create'] = async (p) => {
    const txId = p.txId ?? `${p.eventType}-${(await sha256Hex(`${p.targetAddress}|${JSON.stringify(p.payload)}|${crypto.randomUUID()}`)).slice(0, 32)}`;
    const event = await createNotarizedEvent({
      txId, eventType: p.eventType, sourceAddress: p.sourceAddress, targetAddress: p.targetAddress, payload: p.payload,
      governingPrinciple: params.governingPrinciple, emitterDomain: params.emitterDomain, enforcement: 'refuse',
    });
    return { ...event, eventType: p.eventType } as AppTx<E>;
  };
  const append: AppLedger<E>['append'] = async (txs) => {
    const known = new Set(cache.getCached().map((t) => t.txId));
    const fresh = txs.filter((t) => !known.has(t.txId));
    if (fresh.length) await cache.appendMany(fresh, { requireDurable: true, share: params.shared });
    return cache.getCached();
  };
  return {
    create, append,
    emit: async (p) => { const tx = await create(p); await append([tx]); return tx; },
    refresh: () => cache.refresh(),
    get: () => cache.getCached(),
    subscribe: (fn) => cache.subscribe(fn),
    shareExisting: () => cache.shareExisting(() => true),
  };
}
