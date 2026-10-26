/**
 * COPE node crystallized.
 * Node ID: v15-11-00-evidence-reload
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * Reload key evidence (declarations, revocations) without ever serving a
 * weaker answer than the last good one. Found under load on the edge node:
 * concurrent first requests were handed the empty default while the first
 * read was in flight, which reads as "no revocations" — a revoked key could
 * pass at startup. Rules:
 *   - until the first load completes, every caller waits for it;
 *   - afterwards, callers get the last good copy while a refresh runs
 *     (at most one in flight; a change applies within `freshMs`);
 *   - a failed first load rejects (the gateway answers 503), a failed refresh
 *     keeps the last good copy.
 */
export function createReloader<T>(read: () => Promise<T>, freshMs = 1000, now: () => number = Date.now): () => Promise<T> {
  let checkedAt = 0; let last: T | undefined; let loaded = false; let inflight: Promise<T> | null = null;
  const refresh = () => (inflight ??= read().then((v) => { last = v; loaded = true; return v; }).finally(() => { inflight = null; }));
  return async () => {
    const t = now();
    if (loaded && t - checkedAt < freshMs) return last as T;
    checkedAt = t;
    if (!loaded) return refresh();
    void refresh().catch(() => {});
    return last as T;
  };
}
