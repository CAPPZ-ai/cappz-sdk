/**
 * Storage engine selection + IndexedDB archive — v12-23-07.
 *
 * Engine choice is resolved from StorageEngineSelected events, latest wins
 * (AP-12: no boolean flags). The event log lives in OPFS next to the data
 * (`/cappz-store/_engine-events.json`), never in IndexedDB.
 *
 * Archive-first retirement:
 *   1. IdbArchiveSealed   — every legacy store serialized into one
 *      sha256-verified wallet blob `/wallets/idb-archive-v{n}.cappz`.
 *   2. IdbArchiveImported — the archive copied into the OPFS engine.
 *   3. Restore            — IdbArchiveRestored: an archive's rows that are
 *      missing from cappz-store are imported back (v15-04-00: into
 *      cappz-store, not IndexedDB — the idb engine is retired; a
 *      StorageEngineSelected{idb} from before resolves to the default).
 * Archives are never auto-pruned (AX-82).
 */

import { readWalletBlob, writeWalletBlob, listWalletBlobs, type WalletBlobRef } from '../../wallet-blob/WalletBlobStore';
import { opfsAvailable, opfsReadText, opfsWriteText, createMemoryBackend, createOpfsBackend } from './kvBackends';
import { dumpLegacyDatabase, legacyIdbAvailable } from './legacyIdb';
import { KvDatabase } from './kvDatabase';
import { signStorageEvidence } from './storageEvidence';
import { ChainletStoreParamType, getChainletParam } from '../chainletStoreParams';

/** 'idb' only appears in events written before v15-04-00; it never resolves. */
export type StorageEngineKind = 'opfs' | 'memory' | 'idb';
export type ActiveEngineKind = Exclude<StorageEngineKind, 'idb'>;

export type StorageEngineEvent =
  | { eventType: 'StorageEngineSelected'; engine: StorageEngineKind; reason: string; timestamp: string }
  | { eventType: 'IdbArchiveSealed'; ref: WalletBlobRef; stores: Record<string, number>; bytes: number; timestamp: string }
  | { eventType: 'IdbArchiveImported'; version: number; rows: number; timestamp: string; dbName?: string }
  | { eventType: 'IdbArchiveRestored'; version: number; rows: number; timestamp: string };

const EVENTS_FILE = '_engine-events.json';
const ARCHIVE_SLUG = 'idb-archive';
let memoryEvents: StorageEngineEvent[] = [];

export async function readEngineEvents(): Promise<StorageEngineEvent[]> {
  if (!opfsAvailable()) return memoryEvents;
  const text = await opfsReadText(EVENTS_FILE);
  try { return text ? (JSON.parse(text) as StorageEngineEvent[]) : []; } catch { return []; }
}

export async function appendEngineEvent(ev: StorageEngineEvent): Promise<void> {
  const events = [...(await readEngineEvents()), ev];
  if (opfsAvailable()) await opfsWriteText(EVENTS_FILE, JSON.stringify(events));
  else memoryEvents = events;
  // Evidence is only signed while the owner is actively unlocked. OPFS remains
  // the local recovery source; this does not imply a public ledger anchor.
  try { await signStorageEvidence(ev); } catch (error) { console.warn('[cappz-store] wallet evidence deferred', error); }
}

/** Default when no StorageEngineSelected event exists. */
export function defaultEngine(): ActiveEngineKind {
  return opfsAvailable() ? 'opfs' : 'memory';
}

/** Latest selection wins; a legacy idb selection (rollback before v15-04-00) resolves to the default. */
export function resolveEngine(events: StorageEngineEvent[]): ActiveEngineKind {
  const sel = events.filter((e) => e.eventType === 'StorageEngineSelected').at(-1) as
    | Extract<StorageEngineEvent, { eventType: 'StorageEngineSelected' }> | undefined;
  return !sel || sel.engine === 'idb' || (sel.engine === 'opfs' && !opfsAvailable()) ? defaultEngine() : sel.engine;
}

let resolvedEngine: Promise<ActiveEngineKind> | null = null;
/** Active engine, resolved once per page from StorageEngineSelected events. */
export function resolveActiveEngine(): Promise<ActiveEngineKind> {
  if (!resolvedEngine) resolvedEngine = readEngineEvents().then(resolveEngine).catch(() => 'memory' as const);
  return resolvedEngine;
}

export async function selectStorageEngine(engine: ActiveEngineKind, reason: string): Promise<void> {
  await appendEngineEvent({ eventType: 'StorageEngineSelected', engine, reason, timestamp: new Date().toISOString() });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength); copy.set(bytes);
  const d = await crypto.subtle.digest('SHA-256', copy.buffer);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function listArchives(events: StorageEngineEvent[]) {
  return events.filter((e) => e.eventType === 'IdbArchiveSealed') as Extract<StorageEngineEvent, { eventType: 'IdbArchiveSealed' }>[];
}

/** Snapshot every legacy IndexedDB store into a verified wallet blob. */
export async function sealIdbArchive(dbName: string): Promise<Extract<StorageEngineEvent, { eventType: 'IdbArchiveSealed' }> | null> {
  const dump = await dumpLegacyDatabase(dbName);
  if (Object.keys(dump).length === 0) return null;
  const bytes = new TextEncoder().encode(JSON.stringify({ dbName, sealedAt: new Date().toISOString(), stores: dump }));
  const existing = listArchives(await readEngineEvents());
  const onDisk = (await listWalletBlobs()).filter((n) => n.startsWith(`${ARCHIVE_SLUG}-v`)).length;
  const version = Math.max(existing.length, onDisk) + 1;
  const ref: WalletBlobRef = { slug: ARCHIVE_SLUG, version, sha256: await sha256Hex(bytes) };
  const ok = await writeWalletBlob(ref, bytes);
  if (!ok) throw new Error('IdbArchiveSealed failed: could not write archive blob');
  const stores = Object.fromEntries(Object.entries(dump).map(([k, v]) => [k, v.length]));
  const ev = { eventType: 'IdbArchiveSealed' as const, ref, stores, bytes: bytes.byteLength, timestamp: new Date().toISOString() };
  await appendEngineEvent(ev);
  return ev;
}

export async function readArchive(ref: WalletBlobRef): Promise<{ dbName: string; stores: Record<string, unknown[]> } | null> {
  const bytes = await readWalletBlob(ref); // sha256-verified
  if (!bytes) return null;
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function verifyArchive(ref: WalletBlobRef): Promise<boolean> {
  return (await readWalletBlob(ref)) !== null;
}

/**
 * Restore an archive into cappz-store: rows the store no longer holds come
 * back; rows it still holds keep their current (newer) value. Returns how
 * many came back and how many were already present.
 */
export async function restoreIdbArchive(ref: WalletBlobRef): Promise<{ restored: number; present: number }> {
  const archive = await readArchive(ref);
  if (!archive) throw new Error('Archive failed hash verification or is missing');
  const db = await openCappzStore();
  let restored = 0; let present = 0;
  for (const [store, list] of Object.entries(archive.stores)) {
    await db.ready(store);
    const fresh = list.filter((r) => !db.map(store).has(String((r as { key?: unknown }).key)));
    present += list.length - fresh.length;
    restored += db.importRows(store, fresh);
  }
  await db.flush();
  await appendEngineEvent({ eventType: 'IdbArchiveRestored', version: ref.version, rows: restored, timestamp: new Date().toISOString() });
  return { restored, present };
}

// ─── Engine boot ───────────────────────────────────────────────────────────

let kvDbPromise: Promise<KvDatabase> | null = null;
let activeKind: StorageEngineKind | null = null;

export function activeEngineKind(): StorageEngineKind | null { return activeKind; }

/** Await the physical OPFS write for security-sensitive device records. */
export async function flushActiveKvEngine(): Promise<void> {
  if (activeKind === 'opfs' && kvDbPromise) await (await kvDbPromise).flush();
}

/** The cappz-store database every store facade (offlineCache, chainletStorage, session) writes to. */
export async function openCappzStore(): Promise<KvDatabase> {
  return openKvEngine(getChainletParam(ChainletStoreParamType.MiddlewareDbName), getChainletParam(ChainletStoreParamType.RequiredStores), await resolveActiveEngine());
}

/** Legacy databases imported into the engine on first OPFS boot (archive first, never deleted). */
export function legacyDatabaseNames(primary: string): string[] {
  return [primary, getChainletParam(ChainletStoreParamType.LegacyDbName)];
}

/**
 * Open the active non-IDB engine. On the first OPFS boot, each legacy
 * IndexedDB database (cappz-middleware, and the older cappz-chainlet-cache
 * that was never imported before v15-03-00) is archived and imported before
 * any reads happen.
 */
export function openKvEngine(dbName: string, requiredStores: string[], kind: 'opfs' | 'memory'): Promise<KvDatabase> {
  if (kvDbPromise) return kvDbPromise;
  activeKind = kind;
  kvDbPromise = (async () => {
    const db = new KvDatabase(dbName, kind === 'opfs' ? createOpfsBackend() : createMemoryBackend());
    await db.ensureLoaded(requiredStores);
    if (kind === 'opfs' && legacyIdbAvailable()) {
      const events = await readEngineEvents();
      // Events before v15-03-00 carry no dbName: they imported the primary database.
      const imported = new Set(events.filter((e) => e.eventType === 'IdbArchiveImported').map((e) => (e as { dbName?: string }).dbName ?? dbName));
      for (const legacyName of legacyDatabaseNames(dbName)) {
        if (imported.has(legacyName)) continue;
        try {
          const sealed = await sealIdbArchive(legacyName);
          let rows = 0;
          if (sealed) {
            const archive = await readArchive(sealed.ref);
            for (const [store, list] of Object.entries(archive?.stores ?? {})) {
              await db.ready(store);
              // Don't overwrite rows already written to OPFS (or by a newer database).
              const fresh = list.filter((r) => !db.map(store).has(String((r as { key?: unknown }).key)));
              rows += db.importRows(store, fresh);
            }
            await db.flush();
          }
          await appendEngineEvent({ eventType: 'IdbArchiveImported', version: sealed?.ref.version ?? 0, rows, dbName: legacyName, timestamp: new Date().toISOString() });
        } catch (err) {
          console.warn(`[cappz-store] IndexedDB archive/import of ${legacyName} failed; legacy data left untouched`, err);
        }
      }
    }
    return db;
  })();
  return kvDbPromise;
}

/** Test hook. */
export function __resetEngineForTests() { kvDbPromise = null; activeKind = null; memoryEvents = []; resolvedEngine = null; }
