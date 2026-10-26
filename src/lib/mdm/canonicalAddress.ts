/**
 * COPE node crystallized.
 * Node ID: v12-20-12-path-identities
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * HD addresses are stable identities; versions live in the TX linked list at
 * the address, never in the path. Events recorded before v12-20-12 carry a
 * trailing `/v1` segment — replay reads them under the suffix-free identity.
 * Recorded events are never rewritten (AX-82). The COPE principles anchor is
 * the one address where `/v1` is part of the canonical name.
 *
 * One implementation (v15-12-05): this file. The server functions import it from the
 * public SDK at a pinned commit (supabase/functions/_shared/canonicalAddress.ts).
 */
const PRINCIPLES_ANCHOR = /\/principles\/[^/]+\/v1$/;
const VERSION_SEGMENT = /\/v1(?=\/|$)/g;

export function canonicalAddress(address: string): string {
  if (typeof address !== 'string' || !address.includes('/v1')) return address;
  if (PRINCIPLES_ANCHOR.test(address)) return address;
  if (address.includes('/principles/')) {
    return address.replace(/\/principles\/([^/]+)\/v1(?=\/)/, '/principles/$1/__KEEP__')
      .replace(VERSION_SEGMENT, '').replace('__KEEP__', 'v1');
  }
  return address.replace(VERSION_SEGMENT, '');
}

const ADDRESS_FIELDS = ['walletAddress', 'address', 'targetAddress', 'sourceAddress', 'bpmnAddress', 'parentAddress', 'childAddress', 'fromAddress', 'toAddress'] as const;

/** In-memory view of an event with every address field canonicalized. */
export function canonicalizeAddressFields<T>(entry: T): T {
  if (!entry || typeof entry !== 'object') return entry;
  let out: Record<string, unknown> | null = null;
  for (const f of ADDRESS_FIELDS) {
    const v = (entry as Record<string, unknown>)[f];
    if (typeof v === 'string') {
      const c = canonicalAddress(v);
      if (c !== v) {
        out = out ?? { ...(entry as Record<string, unknown>), recordedAddressFields: {} };
        (out.recordedAddressFields as Record<string, string>)[f] = v;
        out[f] = c;
      }
    }
  }
  return (out ?? entry) as T;
}

/** Restore the exact recorded address values (for hash verification). */
export function recordedAddressFormOf<T>(entry: T): T {
  const e = entry as Record<string, unknown>;
  if (!e || typeof e !== 'object' || !e.recordedAddressFields) return entry;
  const { recordedAddressFields, ...rest } = e;
  return { ...rest, ...(recordedAddressFields as Record<string, string>) } as T;
}
