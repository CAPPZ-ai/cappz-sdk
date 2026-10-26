/**
 * Physical store resolution — v12-07.
 *
 * The chainlet address space is HD ("m/44'/144'/…"); the middleware byte store
 * is IndexedDB, whose object stores are a small fixed set created at upgrade
 * time. Passing an HD partition address where an object-store name is expected
 * throws `NotFoundError` and silently kills durability (publish, ops log,
 * event TXs).
 *
 * Rule: HD partitions are *logical* stores. They are always persisted in the
 * generic `kv` object store under a namespaced key. Only names that are real
 * IndexedDB object stores are used as physical stores.
 */

import type { StoreName } from '../offlineCache';

/** Object stores physically created by the middleware on database open. */
export const PHYSICAL_STORES: readonly StoreName[] = [
  'session',
  'profile',
  'transactions',
  'appointments',
  'dashboard',
  'kv',
];

const PHYSICAL_SET = new Set<string>(PHYSICAL_STORES);

/** Namespace prefix for logical (HD-addressed) partitions folded into `kv`. */
export const LOGICAL_PARTITION_PREFIX = 'part';

export interface PhysicalLocation {
  store: StoreName;
  key: string;
}

export function isPhysicalStore(name: string): name is StoreName {
  return PHYSICAL_SET.has(name);
}

/**
 * Map a logical store (which may be an HD partition address) plus a key onto
 * the physical object store and key that actually hold the bytes.
 */
export function resolvePhysicalLocation(logicalStore: string, key: string): PhysicalLocation {
  if (isPhysicalStore(logicalStore)) return { store: logicalStore, key };
  return { store: 'kv', key: `${LOGICAL_PARTITION_PREFIX}::${logicalStore}::${key}` };
}
