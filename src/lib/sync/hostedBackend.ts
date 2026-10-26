/**
 * COPE node crystallized.
 * Node ID: v15-12-05-hosted-backend
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * The optional hosted mirror, as a port. Storage is local first (OPFS
 * cappz-store); a hosted table mirror and hosted functions are optional, so
 * the SDK never imports a hosted client. An app that has one registers it:
 *
 *   registerHostedClient('routed', client)  // reads and writes through the app's facade
 *   registerHostedClient('direct', client)  // the raw client, for the sync adapter's mirror
 *
 * With nothing registered, reads answer "no hosted rows" ({ data: [], count: 0 }),
 * writes and function calls answer an error naming the missing backend, and
 * callers keep their local path (the sync adapter queues to its outbox).
 */

export type HostedSlot = 'routed' | 'direct';

export interface HostedResult<T = unknown> { data: T | null; error: { message: string } | null; count?: number | null }

/** The Supabase-shaped subset the SDK uses: from(table) builders and functions.invoke. */
export interface HostedClient {
  // Query builders are chainable and awaitable; their exact type belongs to the client.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
  functions?: { invoke(name: string, options?: { body?: unknown; headers?: Record<string, string> }): Promise<{ data: unknown; error: unknown }> };
}

const clients: Partial<Record<HostedSlot, HostedClient>> = {};

export function registerHostedClient(slot: HostedSlot, client: HostedClient | null): void {
  if (client) clients[slot] = client; else delete clients[slot];
}

export function hasHostedClient(slot: HostedSlot = 'routed'): boolean {
  return !!clients[slot];
}

/** The registered client for a slot ('direct' falls back to 'routed'), or the local-only stand-in. */
export function hostedClient(slot: HostedSlot = 'routed'): HostedClient {
  return clients[slot] ?? (slot === 'direct' ? clients.routed : undefined) ?? LOCAL_ONLY;
}

const NO_BACKEND = { message: 'no hosted backend registered (local-only)' };
const WRITES = new Set(['insert', 'update', 'upsert', 'delete']);

/** A query builder that accepts any chain and resolves like an empty table; writes resolve to an error. */
function localOnlyQuery(): unknown {
  let write = false;
  const result = (): HostedResult => (write ? { data: null, error: NO_BACKEND, count: null } : { data: [], error: null, count: 0 });
  const proxy: unknown = new Proxy(function () { /* chain target */ }, {
    get(_t, prop) {
      if (prop === 'then') return (ok: (r: HostedResult) => unknown, fail?: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, fail);
      if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(write ? result() : { data: null, error: null });
      return (..._args: unknown[]) => { if (typeof prop === 'string' && WRITES.has(prop)) write = true; return proxy; };
    },
  });
  return proxy;
}

const LOCAL_ONLY: HostedClient = {
  from: () => localOnlyQuery(),
  functions: { invoke: async (name) => ({ data: null, error: { message: `${name}: ${NO_BACKEND.message}` } }) },
};
