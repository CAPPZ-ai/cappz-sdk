/**
 * COPE node crystallized.
 * Node ID: v15-09-00-edge-node-evidence
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * Key evidence the node verifies against, from files in <CAPPZ_NODE_DATA>
 * (re-read on change, replicated or copied there by the operator — never
 * fetched per request):
 *   key-declarations.json   [KeyDeclaration | HelloKeyDeclaration, …] (wallet-signed)
 *   key-revocations.json    [KeyRevocation, …]                          (wallet-signed)
 *   key-delegations.json    [KeyDelegation, …]                          (signed by a declared key)
 *   declared-hello-keys.json { "<wallet>": ["<hex>", …] }               (legacy operator list, v15-03-00)
 * Every signed record is checked when used. v15-11-00: a file that fails to
 * parse keeps its last good copy; with none, verification fails closed (503)
 * rather than reading it as empty. Replace these files atomically (write a
 * temporary file, then rename).
 */

import type { KeyEvidence, KeyRevocation } from '../../src/lib/identity/keyDeclaration.ts';
import type { EvidenceSource } from '../../src/lib/identity/edgeVerify.ts';
import { createReloader } from '../../src/lib/identity/evidenceReload.ts';

function cachedJson<T>(path: string, fallback: T): () => Promise<T> {
  let cache: { mtime: number; value: T } | null = null;
  // v15-11-00: stat at most once a second (a stat per request was 0.19 ms of every check); a changed
  // file — a new revocation — is picked up within a second.
  // createReloader: callers wait for the first load (never the empty default), then get the last good copy.
  return createReloader(read, 1000);
  async function read(): Promise<T> {
    try {
      const mtime = (await Deno.stat(path)).mtime?.getTime() ?? 0;
      if (!cache || cache.mtime !== mtime) cache = { mtime, value: JSON.parse(await Deno.readTextFile(path)) as T };
      return cache.value;
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return fallback; // no file: no entries of that kind
      // Unreadable (half-written, corrupt): keep the last good copy; with none, fail closed — never "empty",
      // which for revocations would accept every revoked key again.
      if (cache) { console.warn(`[edge-node] ${path} unreadable (${err instanceof Error ? err.message : err}); keeping the last good copy`); return cache.value; }
      throw new Error(`${path} unreadable and no good copy held`);
    }
  }
}

/** Group a loaded array by wallet once per file version (the loader returns the same array until the file changes). */
function byWallet<T extends { walletAddress?: unknown }>(load: () => Promise<readonly T[]>): (wallet: string) => Promise<T[]> {
  let src: readonly T[] | null = null; let index = new Map<string, T[]>();
  return async (wallet) => {
    const arr = await load();
    if (arr !== src) {
      src = arr; index = new Map();
      for (const x of Array.isArray(arr) ? arr : []) {
        if (!x || typeof x !== 'object' || typeof x.walletAddress !== 'string') continue; // junk entries never reach a verifier
        const list = index.get(x.walletAddress) ?? []; list.push(x); index.set(x.walletAddress, list);
      }
    }
    return [...(index.get(wallet) ?? [])];
  };
}

export function fileEvidence(dataDir: string): EvidenceSource & { revocations(): Promise<KeyRevocation[]> } {
  const declarations = cachedJson<KeyEvidence['declarations']>(`${dataDir}/key-declarations.json`, []);
  const revocations = cachedJson<KeyRevocation[]>(`${dataDir}/key-revocations.json`, []);
  const delegations = cachedJson<NonNullable<KeyEvidence['delegations']>>(`${dataDir}/key-delegations.json`, []);
  const operator = cachedJson<Record<string, string[]> | null>(`${dataDir}/declared-hello-keys.json`, null);
  const self = cachedJson<{ delegation?: NonNullable<KeyEvidence['delegations']>[number] }>(`${dataDir}/tls-delegation.json`, {});
  // Indexed per wallet once per file version: a request looks at its own wallet's few entries, not the whole file.
  const declFor = byWallet(declarations); const revFor = byWallet(revocations); const delFor = byWallet(delegations);
  return {
    async evidenceFor(walletAddress) {
      const own = (await self()).delegation;
      return {
        declarations: await declFor(walletAddress),
        revocations: await revFor(walletAddress),
        delegations: [...(await delFor(walletAddress)), ...(own && own.walletAddress === walletAddress ? [own] : [])],
      };
    },
    async operatorKeysFor(walletAddress) {
      const map = await operator();
      return map ? (Object.hasOwn(map, walletAddress) && Array.isArray(map[walletAddress]) ? map[walletAddress] : []) : null;
    },
    revocations,
  };
}
