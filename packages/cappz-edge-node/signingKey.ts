/**
 * COPE node crystallized.
 * Node ID: v15-41-00-edge-node-signing-key
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * The node's Ed25519 key from the environment (CAPPZ_NODE_KEY = PKCS8 base64,
 * CAPPZ_NODE_PUB = raw hex), imported with WebCrypto only. No imports, so the
 * timers-only node (timers.ts) loads no npm package to sign its ticks.
 * nodeKey.ts re-exports this for the full node.
 */

export interface NodeSigningKey {
  publicKeyHex: string;
  privateKey: CryptoKey;
}

export async function loadNodeKey(): Promise<NodeSigningKey | null> {
  const pkcs8 = Deno.env.get('CAPPZ_NODE_KEY');
  const pub = Deno.env.get('CAPPZ_NODE_PUB');
  if (!pkcs8 || !pub) return null;
  if (!/^[0-9a-f]{64}$/i.test(pub)) throw new Error('CAPPZ_NODE_PUB must be 64 hex characters (raw Ed25519 public key)');
  const der = Uint8Array.from(atob(pkcs8), (c) => c.charCodeAt(0));
  const privateKey = await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign']);
  return { privateKey, publicKeyHex: pub.toLowerCase() };
}

/** A file: URL as a path this OS can open (URL.pathname gives "/C:/…" on Windows). */
export function pathFromFileUrl(url: URL): string {
  const p = decodeURIComponent(url.pathname);
  return Deno.build.os === 'windows' ? p.replace(/^\/([A-Za-z]:)/, '$1').replaceAll('/', '\\') : p;
}
