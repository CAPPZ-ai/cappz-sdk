/**
 * COPE node crystallized.
 * Node ID: v15-03-00-store-bus
 * Provenance: m/44'/144'/100'/principles/cope/v1
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * cappz-store event bus (AX-70, AX-75, AX-76), moved out of the deprecated
 * cappz-middleware so the bus no longer depends on the IndexedDB facade.
 * Every write/delete/clear through offlineCache or chainletStorage fires
 * notify(); cappz-middleware re-exports these names for existing callers.
 *
 * AX-75: notifications carry the HD address where content is stored, not a
 * copy. AX-76: Tier 1 (address only) and Tier 2 (managed fetch).
 */

export type MutationType = 'write' | 'delete' | 'clear';

/** Tier 1 listener — resolves content itself from the HD address. */
export type MiddlewareListener = (store: string, key: string, type: MutationType, hdAddress: string) => void;

const listeners: Set<MiddlewareListener> = new Set();

/** Fire a notification to all subscribed listeners (AX-75). */
export function middlewareNotify(store: string, key: string, type: MutationType, hdAddress?: string): void {
  const resolvedAddress = hdAddress ?? key; // Default: key IS the address
  for (const listener of listeners) {
    try {
      listener(store, key, type, resolvedAddress);
    } catch (err) {
      console.warn('[cappz-store] Listener error:', err);
    }
  }
}

/** Tier 1: subscribe to all store mutations. Returns unsubscribe teardown. */
export function middlewareSubscribe(listener: MiddlewareListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Tier 2: managed subscription (AX-76). The bus fetches content at the HD
 * address, pushes it to cappzEphemeralStorage, then calls the subscriber.
 */
export function middlewareManagedSubscribe(
  filter: { store?: string; keyPrefix?: string },
  onContent: (key: string, content: unknown, hdAddress: string) => void,
): () => void {
  const listener: MiddlewareListener = async (store, key, type, hdAddress) => {
    if (type === 'clear') return;
    if (filter.store && store !== filter.store) return;
    if (filter.keyPrefix && !key.startsWith(filter.keyPrefix)) return;
    if (type === 'delete') {
      onContent(key, null, hdAddress);
      return;
    }
    try {
      const { chainletStorage } = await import('./chainletStorage');
      const content = await chainletStorage.getItem(hdAddress);
      const { cappzEphemeralStorage } = await import('./cappzEphemeralStorage');
      cappzEphemeralStorage.set(`managed:${hdAddress}`, content, { directive: 'ttl', ttlMs: 60_000 });
      onContent(key, content, hdAddress);
    } catch (err) {
      console.warn('[cappz-store] Managed fetch failed for', hdAddress, err);
    }
  };
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
