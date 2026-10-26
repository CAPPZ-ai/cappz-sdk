/**
 * COPE node crystallized.
 * Node ID: v15-03-00-edge-node-key
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * The node's Ed25519 key (CAPPZ_NODE_KEY = PKCS8 base64, CAPPZ_NODE_PUB =
 * raw hex). One key signs the node's TX log, its transport hello and its
 * UDP beacons. Declared wallet keys for relay binding live in
 * <CAPPZ_NODE_DATA>/declared-hello-keys.json ({ "<wallet>": ["<hex>", …] }).
 *
 * v15-09-00: a key the wallet revoked (a valid wallet-signed KeyRevocation in
 * <CAPPZ_NODE_DATA>/key-revocations.json) is dropped from that list, so an
 * operator list can no longer keep a revoked key alive.
 */

import { importSigningKey, type SigningKey } from '../../src/lib/sync/helloSignature.ts';
import { withoutRevokedKeys, type KeyRevocation } from '../../src/lib/identity/keyDeclaration.ts';

export async function loadNodeKey(): Promise<(SigningKey & { privateKey: CryptoKey }) | null> {
  const pkcs8 = Deno.env.get('CAPPZ_NODE_KEY');
  const pub = Deno.env.get('CAPPZ_NODE_PUB');
  if (!pkcs8 || !pub) return null;
  return importSigningKey(pkcs8, pub);
}

/** Wallet → declared public keys, re-read on change; null when the operator keeps no list. */
export function declaredKeysFrom(dataDir: string): (walletAddress: string) => Promise<readonly string[] | null> {
  const path = `${dataDir}/declared-hello-keys.json`;
  let cache: { mtime: number; map: Record<string, string[]> } | null = null;
  return async (walletAddress) => {
    try {
      const mtime = (await Deno.stat(path)).mtime?.getTime() ?? 0;
      if (!cache || cache.mtime !== mtime) cache = { mtime, map: JSON.parse(await Deno.readTextFile(path)) };
      const keys = cache.map[walletAddress] ?? [];
      const revocations = await Deno.readTextFile(`${dataDir}/key-revocations.json`).then((t) => JSON.parse(t) as KeyRevocation[]).catch(() => [] as KeyRevocation[]);
      return revocations.length ? withoutRevokedKeys(walletAddress, keys, revocations) : keys;
    } catch {
      return null;
    }
  };
}
