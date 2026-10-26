/**
 * COPE node crystallized.
 * Node ID: v15-09-00-edge-node-tls-identity
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * TLS material for QUIC and WebTransport. Backwards compatible first:
 * operator PEM files (CAPPZ_TLS_CERT / CAPPZ_TLS_KEY) win, as before.
 *
 * CAPPZ_TLS_AUTO=1 (no files): the node generates a P-256 key in memory at
 * boot and a self-signed certificate valid 13 days (inside the WebTransport
 * 14-day limit, so browsers can pin its hash). The node's declared Ed25519
 * key delegates the TLS key (KeyDelegated): wallet → node key → TLS key
 * verifies offline. The certificate SAN carries the wallet's did:key
 * (CAPPZ_WALLET_ADDRESS, the wallet that declared the node key) and the
 * delegation hash; the delegation itself is written to
 * <CAPPZ_NODE_DATA>/tls-delegation.json and served by the verify gateway.
 * Nothing secret touches disk.
 *
 * v15-10-00 rotation without restart (rotateTls): auto certificates are
 * replaced every CAPPZ_TLS_ROTATE_DAYS (default 6) — the next certificate's
 * hash is offered alongside the current one for CAPPZ_TLS_OVERLAP_MIN
 * (default 10) before the switch, so a browser holding a fresh offer always
 * finds a matching certificate; listeners then stop and listen again on the
 * same endpoint (verified on Deno 2.5: the endpoint takes a new listener with
 * the new certificate, and a dialler pinning the old one is refused).
 * Operator PEM files are re-read when they change on disk (certbot renewals).
 *
 * Public browser HTTPS stays on nginx/Caddy with a public-CA certificate.
 */

import { issueSelfSignedCertificate, KEYDECL_URI_PREFIX } from '../../src/lib/identity/x509.ts';
import { delegateKey, KEY_DELEGATION_MAX_TTL_MS, type KeyDelegation } from '../../src/lib/identity/keyDeclaration.ts';
import { didKeyFor } from '../../src/lib/identity/didKey.ts';
import { canonicalJson, sha256HexOf, toHex } from '../../src/lib/identity/canonical.ts';
import type { SigningKey } from '../../src/lib/sync/helloSignature.ts';

export interface TlsMaterial { cert: string; key: string; source: 'files' | 'auto'; sha256?: string; delegation?: KeyDelegation; notAfter?: string }

async function autoMaterial(nodeKey: SigningKey, dataDir: string, write = true): Promise<TlsMaterial> {
  const wallet = Deno.env.get('CAPPZ_WALLET_ADDRESS') ?? '';
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const raw = toHex(new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey)));
  const delegation = await delegateKey(nodeKey, wallet, { publicKey: raw, algorithm: 'p256', purpose: 'tls' });
  const delegationHash = await sha256HexOf(canonicalJson(delegation));
  const dns = (Deno.env.get('CAPPZ_TLS_DNS') ?? 'localhost').split(',').map((s) => s.trim()).filter(Boolean);
  const notAfter = new Date(Date.now() + KEY_DELEGATION_MAX_TTL_MS - 60_000);
  const issued = await issueSelfSignedCertificate({
    keyPair, algorithm: 'p256', commonName: dns[0] ?? 'cappz-edge-node', organization: 'CAPPZ edge node',
    dnsNames: dns, ipAddresses: ['127.0.0.1', '::1'],
    uris: [...(/^0[23][0-9a-f]{64}$/i.test(wallet) ? [didKeyFor('secp256k1', wallet)] : []), `${KEYDECL_URI_PREFIX}${delegationHash}`],
    notAfter,
  });
  if (write) await Deno.writeTextFile(`${dataDir}/tls-delegation.json`, JSON.stringify({ delegation, delegationHash, certificateSha256: issued.sha256, certificate: issued.pem }, null, 2));
  return { cert: issued.pem, key: issued.keyPem!, source: 'auto', sha256: issued.sha256, delegation, notAfter: notAfter.toISOString() };
}

async function pemSha256(pem: string): Promise<string> {
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', der)));
}

/** Live TLS: the material in use now, the hashes to offer (current + next during an overlap), and rotation listeners. */
export interface TlsHandle {
  current(): TlsMaterial;
  /** Offered WebTransport hashes; the same array object is updated in place (relay offers read it each time). */
  readonly offeredHashes: string[];
  onRotate(fn: (next: TlsMaterial) => void | Promise<void>, label?: string): void;
}

export function rotateTls(first: TlsMaterial, nodeKey: SigningKey | null, dataDir: string): TlsHandle {
  let now = first;
  const offeredHashes: string[] = first.sha256 ? [first.sha256] : [];
  const listeners: Array<{ fn: (next: TlsMaterial) => void | Promise<void>; label: string }> = [];
  const swap = async (next: TlsMaterial, why: string) => {
    now = next;
    for (const { fn, label } of listeners) { try { await fn(next); } catch (err) { console.warn(`[edge-node] tls rotation of ${label} failed:`, err instanceof Error ? err.message : err); } }
    offeredHashes.splice(0, offeredHashes.length, ...(next.sha256 ? [next.sha256] : []));
    console.log(`[edge-node] tls rotated (${why}): ${next.sha256?.slice(0, 16) ?? 'operator files'}…${next.notAfter ? ` until ${next.notAfter}` : ''}`);
  };
  if (first.source === 'auto' && nodeKey) {
    const every = (Number(Deno.env.get('CAPPZ_TLS_ROTATE_DAYS') ?? '') || 6) * 86400_000;
    const overlap = (Number(Deno.env.get('CAPPZ_TLS_OVERLAP_MIN') ?? '') || 10) * 60_000;
    const cycle = () => setTimeout(async () => {
      try {
        const next = await autoMaterial(nodeKey, dataDir, false);
        offeredHashes.push(next.sha256!); // offer both before switching
        setTimeout(async () => {
          await Deno.writeTextFile(`${dataDir}/tls-delegation.json`, JSON.stringify({ delegation: next.delegation, certificateSha256: next.sha256, certificate: next.cert }, null, 2));
          await swap(next, 'scheduled');
          cycle();
        }, overlap);
      } catch (err) { console.warn('[edge-node] tls rotation failed, keeping the current certificate:', err instanceof Error ? err.message : err); cycle(); }
    }, Math.max(60_000, every - overlap));
    cycle();
  } else if (first.source === 'files') {
    const certPath = Deno.env.get('CAPPZ_TLS_CERT')!; const keyPath = Deno.env.get('CAPPZ_TLS_KEY')!;
    let last = '';
    setInterval(async () => {
      try {
        const st = await Deno.stat(certPath); const sk = await Deno.stat(keyPath);
        const stamp = `${st.mtime?.getTime()}|${sk.mtime?.getTime()}`;
        if (!last) { last = stamp; return; }
        if (stamp === last) return;
        last = stamp;
        const cert = await Deno.readTextFile(certPath);
        await swap({ cert, key: await Deno.readTextFile(keyPath), source: 'files', sha256: await pemSha256(cert) }, 'certificate files changed');
      } catch (err) { console.warn('[edge-node] tls files unreadable, keeping the current certificate:', err instanceof Error ? err.message : err); }
    }, 60_000);
  }
  return { current: () => now, offeredHashes, onRotate: (fn, label = 'a listener') => { listeners.push({ fn, label }); } };
}

export async function resolveTls(nodeKey: SigningKey | null, dataDir: string): Promise<TlsMaterial | null> {
  const certPath = Deno.env.get('CAPPZ_TLS_CERT'); const keyPath = Deno.env.get('CAPPZ_TLS_KEY');
  if (certPath && keyPath) return { cert: await Deno.readTextFile(certPath), key: await Deno.readTextFile(keyPath), source: 'files' };
  if (Deno.env.get('CAPPZ_TLS_AUTO') !== '1') return null;
  if (!nodeKey) { console.log('[edge-node] tls auto off: needs CAPPZ_NODE_KEY / CAPPZ_NODE_PUB (the node key delegates the TLS key)'); return null; }
  const m = await autoMaterial(nodeKey, dataDir);
  if (!Deno.env.get('CAPPZ_WALLET_ADDRESS')) console.log('[edge-node] tls auto: CAPPZ_WALLET_ADDRESS unset — the certificate names no wallet, peers see it as undeclared');
  console.log(`[edge-node] tls auto: P-256 cert ${m.sha256!.slice(0, 16)}… until ${m.notAfter} (delegated by the node key)`);
  return m;
}
