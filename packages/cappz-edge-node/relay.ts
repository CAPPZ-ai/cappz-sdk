/**
 * COPE node crystallized.
 * Node ID: v15-03-00-edge-node-relay
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * HTTPS relay for copies behind firewalls (replica-connect.bpmn). Put it
 * behind the operator's reverse proxy, which terminates TLS on 443:
 *
 *   location /cpz1/ {
 *     proxy_pass http://127.0.0.1:41445/cpz1/;
 *     proxy_http_version 1.1;          # keep-alive upstream
 *     proxy_set_header Connection "";
 *     proxy_buffering off;             # chunked frames flow as written
 *     proxy_read_timeout 3600s;
 *   }
 *
 * The ticket travels in the Authorization header, so default access logs
 * never record it.
 *
 * Ask price: CAPPZ_RELAY_ASK (CAPPZ, default 0) per CAPPZ_RELAY_ASK_UNIT
 * (flat | per-KB | per-MB, default per-MB). Hellos are Ed25519-verified.
 * CAPPZ_RELAY_REQUIRE_BOUND=1 carries only keys listed for the wallet in
 * <CAPPZ_NODE_DATA>/declared-hello-keys.json. CAPPZ_RELAY_MAX_TICKETS and
 * CAPPZ_RELAY_MAX_TICKETS_PER_WALLET cap open tickets (10000 / 8).
 * Decisions and tunnel records go to <CAPPZ_NODE_DATA>/relay-txs.jsonl.
 *
 * v15-04-00 — socket carriers above the HTTPS floor:
 *   WebSocket     GET /cpz1/ws (Upgrade). Behind nginx add
 *                 `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`
 *                 on a `location /cpz1/ws` block. CAPPZ_RELAY_PUBLIC_URL
 *                 (https://relay.example.com/cpz1) names the public URL.
 *   WebTransport  HTTP/3 over QUIC on UDP <port> (the same number as the TCP
 *                 relay port), when the node has CAPPZ_TLS_CERT/CAPPZ_TLS_KEY
 *                 and runs with --unstable-net. CAPPZ_RELAY_WT_URL names it
 *                 (default https://localhost:<port>/cpz1/wt). For a
 *                 self-signed ECDSA cert (≤ 14 days, dev only) set
 *                 CAPPZ_RELAY_WT_SELF_SIGNED=1 and the offer carries its hash.
 * The ticket is sent in the first frame on both, never in the URL.
 *
 * v15-09-00: TLS material comes from tlsIdentity.ts (operator files as
 * before, or CAPPZ_TLS_AUTO=1 in-memory P-256 delegated by the node key). An
 * auto certificate is ≤ 13 days ECDSA P-256, so its hash is always offered.
 */

import { createHttpsRelay, type RelayPolicy } from '../../src/lib/sync/transports/httpsRelay.ts';
import type { EndpointRecord } from '../../src/lib/sync/endpointDirectory.ts';
import { webSocketDuplex } from '../../src/lib/sync/transports/socketDuplex.ts';
import type { SyncPriceUnit } from '../../src/lib/sync/a2aSyncPricing.ts';
import { declaredKeysFrom } from './nodeKey.ts';
import type { TlsHandle } from './tlsIdentity.ts';

/** True when the node can serve WebTransport (TLS material + QUIC API present). */
export function webTransportPossible(tls: TlsHandle | null): boolean {
  // deno-lint-ignore no-explicit-any
  const D = Deno as any;
  return Boolean(tls && typeof D.QuicEndpoint === 'function' && typeof D.upgradeWebTransport === 'function');
}

export async function serveRelay(port: number, nodeAddress: string, dataDir: string, endpointRecord?: () => EndpointRecord | null, tls: TlsHandle | null = null): Promise<void> {
  const amount = Number(Deno.env.get('CAPPZ_RELAY_ASK') ?? '0') || 0;
  const unit = (Deno.env.get('CAPPZ_RELAY_ASK_UNIT') ?? 'per-MB') as SyncPriceUnit;
  await Deno.mkdir(dataDir, { recursive: true });
  const logPath = `${dataDir}/relay-txs.jsonl`;
  const wt = await webTransportConfig(port, tls);
  const relay = createHttpsRelay({
    socketRungs: { wss: true, ...(wt ? { webtransport: wt.offer } : {}) },
    publicUrl: Deno.env.get('CAPPZ_RELAY_PUBLIC_URL') || undefined,
    // v15-05-00: the node answers for itself — its member-table record rides every offer.
    endpointRecord: endpointRecord ?? undefined,
    nodeAddress,
    ask: { baseCappz: amount, baseUnit: unit, priceCappz: amount, unit },
    requireBoundKey: Deno.env.get('CAPPZ_RELAY_REQUIRE_BOUND') === '1',
    declaredKeys: declaredKeysFrom(dataDir),
    maxTickets: Number(Deno.env.get('CAPPZ_RELAY_MAX_TICKETS') ?? '') || undefined,
    maxTicketsPerWallet: Number(Deno.env.get('CAPPZ_RELAY_MAX_TICKETS_PER_WALLET') ?? '') || undefined,
    allowOrigin: Deno.env.get('CAPPZ_RELAY_ORIGIN') ?? '*',
    record: (event) => Deno.writeTextFile(logPath, JSON.stringify(event) + '\n', { append: true }),
  });
  console.log(`[edge-node] relay :${port}/cpz1  ask ${amount} CAPPZ ${unit}  rungs ${wt ? 'webtransport, ' : ''}wss, https-stream, https-poll`);
  if (!wt) console.log('[edge-node] relay webtransport off: needs TLS (CAPPZ_TLS_CERT/CAPPZ_TLS_KEY or CAPPZ_TLS_AUTO=1) and --unstable-net');
  Deno.serve({ port }, (req) => {
    // v15-10-00: the node's current TLS certificate, for QUIC diallers to pin (dialQuic caCerts). Public material only.
    if (new URL(req.url).pathname.replace(/\/+$/, '').endsWith('/cpz1/tls')) {
      if (!tls) return Response.json({ error: 'this node serves no TLS' }, { status: 404 });
      const c = tls.current();
      return Response.json({ certificate: c.cert, sha256: c.sha256 ?? null, offeredHashes: tls.offeredHashes, delegation: c.delegation ?? null, notAfter: c.notAfter ?? null }, { headers: { 'cache-control': 'no-store' } });
    }
    if (new URL(req.url).pathname.replace(/\/+$/, '').endsWith('/ws')) {
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('websocket only', { status: 426 });
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.addEventListener('open', () => { void relay.attach(webSocketDuplex(socket), 'wss'); }, { once: true });
      return response;
    }
    return relay.handle(req);
  });
  if (wt) void serveWebTransport(port, tls!, relay);
}

async function webTransportConfig(port: number, tls: TlsHandle | null): Promise<{ offer: NonNullable<NonNullable<RelayPolicy['socketRungs']>['webtransport']> } | null> {
  if (!webTransportPossible(tls)) return null;
  const url = Deno.env.get('CAPPZ_RELAY_WT_URL') ?? `https://localhost:${port}/cpz1/wt`;
  const cur = tls!.current();
  if (cur.source === 'files' && Deno.env.get('CAPPZ_RELAY_WT_SELF_SIGNED') === '1' && !tls!.offeredHashes.length) {
    const der = Uint8Array.from(atob(cur.cert.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', der));
    tls!.offeredHashes.push(Array.from(d, (b) => b.toString(16).padStart(2, '0')).join(''));
  }
  // The handle's array is updated in place on rotation (current + next during the overlap), so every offer is current.
  const pin = cur.source === 'auto' || Deno.env.get('CAPPZ_RELAY_WT_SELF_SIGNED') === '1';
  return { offer: { url, ...(pin ? { certificateHashes: tls!.offeredHashes } : {}) } };
}

/** WebTransport (HTTP/3 over QUIC, UDP <port>): each session's bidirectional streams are carriers. */
async function serveWebTransport(port: number, tls: TlsHandle, relay: ReturnType<typeof createHttpsRelay>): Promise<void> {
  // deno-lint-ignore no-explicit-any
  const D = Deno as any;
  // '::' listens dual-stack: browsers resolve localhost to ::1 first, and QUIC has no IPv4 fallback.
  const endpoint = new D.QuicEndpoint({ hostname: '::', port });
  const listen = () => endpoint.listen({ cert: tls.current().cert, key: tls.current().key, alpnProtocols: ['h3'] });
  let listener = listen();
  tls.onRotate(() => { listener.stop(); listener = listen(); }, 'webtransport'); // stop, then listen again: the order verified on Deno 2.5
  console.log(`[edge-node] relay webtransport udp :${port}/cpz1/wt`);
  for (;;) {
    let conn;
    try { conn = await listener.accept(); } catch { continue; } // stopped for a rotation
    (async () => {
      const wt = await D.upgradeWebTransport(conn);
      await wt.ready;
      for await (const stream of wt.incomingBidirectionalStreams) {
        void relay.attach({ readable: stream.readable, writable: stream.writable, close: () => { try { wt.close(); } catch { /* closed */ } } }, 'webtransport');
      }
    })().catch((err) => console.warn('[edge-node] webtransport session ended:', err?.message ?? err));
  }
}
