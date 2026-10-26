/**
 * Legacy IndexedDB engine — v12-23-07.
 *
 * The ONLY module allowed to touch `indexedDB` (guard test enforces this).
 * IndexedDB is legacy and read-only: it is read once for the archive/import
 * into cappz-store. v15-04-00: the rollback write path is retired (archives
 * restore into cappz-store). Durable device storage is OPFS.
 */

const legacyIdbFactory: IDBFactory | null =
  typeof indexedDB !== 'undefined' ? indexedDB : null;

export function legacyIdbAvailable(): boolean {
  return legacyIdbFactory !== null;
}

function openExisting(dbName: string): Promise<IDBDatabase | null> {
  if (!legacyIdbFactory) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = legacyIdbFactory!.open(dbName);
    // If the DB didn't exist, abort creation so we don't leave an empty one.
    req.onupgradeneeded = () => { req.transaction?.abort(); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

/** Read every store of a legacy IndexedDB database into plain arrays. */
export async function dumpLegacyDatabase(dbName: string): Promise<Record<string, unknown[]>> {
  const db = await openExisting(dbName);
  if (!db) return {};
  const out: Record<string, unknown[]> = {};
  try {
    for (const name of Array.from(db.objectStoreNames)) {
      out[name] = await new Promise<unknown[]>((resolve) => {
        try {
          const req = db.transaction(name, 'readonly').objectStore(name).getAll();
          req.onsuccess = () => resolve(req.result ?? []);
          req.onerror = () => resolve([]);
        } catch { resolve([]); }
      });
    }
  } finally {
    db.close();
  }
  return out;
}
