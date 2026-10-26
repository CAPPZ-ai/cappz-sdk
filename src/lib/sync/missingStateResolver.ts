/**
 * COPE node crystallized.
 * Node ID: v12-21-00-missing-state-resolver
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Each copy sees every lifecycle header (Created / Amended / Removed …)
 * even when it lacks the data. Comparing the headers seen with the TxIds
 * held locally gives the exact missing list. Order comes from the
 * prevEvent linked list, never from timestamps. Two children of the same
 * prev at one address is a fork — reported, never merged.
 */

import type { LifecycleHeader, MissingItem } from './a2aSyncEvents';

export interface SyncFork {
  address: string;
  prevTxId: string | null;
  branchTxIds: string[];
}

export interface MissingStateReport {
  missing: MissingItem[];
  forks: SyncFork[];
  /** Headers whose prev is unknown to this copy (chain gap before them). */
  orphans: LifecycleHeader[];
}

/** Walk one address genesis-first along prevEvent links. */
export function orderAddressChain(headers: LifecycleHeader[]): {
  ordered: LifecycleHeader[];
  forks: SyncFork[];
  orphans: LifecycleHeader[];
} {
  const byTx = new Map(headers.map((h) => [h.txId, h]));
  const children = new Map<string | null, LifecycleHeader[]>();
  for (const h of byTx.values()) {
    const key = h.prevTxId && byTx.has(h.prevTxId) ? h.prevTxId : h.prevTxId === null ? null : `__orphan:${h.prevTxId}`;
    const list = children.get(key) ?? [];
    list.push(h);
    children.set(key, list);
  }
  const forks: SyncFork[] = [];
  const ordered: LifecycleHeader[] = [];
  const address = headers[0]?.address ?? '';
  const walk = (key: string | null) => {
    const kids = (children.get(key) ?? []).slice().sort((a, b) => a.txId.localeCompare(b.txId));
    if (kids.length > 1) forks.push({ address, prevTxId: key, branchTxIds: kids.map((k) => k.txId) });
    for (const k of kids) {
      ordered.push(k);
      walk(k.txId);
    }
  };
  walk(null);
  const orphans: LifecycleHeader[] = [];
  for (const [key, kids] of children) {
    if (typeof key === 'string' && key.startsWith('__orphan:')) {
      for (const k of kids) {
        orphans.push(k);
        ordered.push(k);
        walk(k.txId);
      }
    }
  }
  return { ordered, forks, orphans };
}

export function resolveMissingState(
  seen: LifecycleHeader[],
  localTxIds: ReadonlySet<string>,
): MissingStateReport {
  const byAddress = new Map<string, LifecycleHeader[]>();
  for (const h of seen) {
    const list = byAddress.get(h.address) ?? [];
    list.push(h);
    byAddress.set(h.address, list);
  }
  const missing: MissingItem[] = [];
  const forks: SyncFork[] = [];
  const orphans: LifecycleHeader[] = [];
  for (const address of [...byAddress.keys()].sort()) {
    const chain = orderAddressChain(byAddress.get(address)!);
    forks.push(...chain.forks);
    orphans.push(...chain.orphans);
    for (const h of chain.ordered) {
      if (localTxIds.has(h.txId)) continue;
      missing.push({
        address: h.address,
        txId: h.txId,
        prevTxId: h.prevTxId,
        eventType: h.eventType,
        objectType: h.objectType,
        contentHash: h.contentHash,
      });
    }
  }
  return { missing, forks, orphans };
}
