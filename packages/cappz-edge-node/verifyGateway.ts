/**
 * COPE node crystallized.
 * Node ID: v15-09-00-edge-node-verify-gateway
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * --verify <port> (default 41446): KeyZ Gate, the edge verification gateway
 * (src/lib/identity/edgeVerify.ts) next to nginx/Caddy. Bind it to loopback
 * (CAPPZ_VERIFY_HOST, default 127.0.0.1): it trusts X-Original-* and
 * X-SSL-Client-Cert only because nginx is the one setting them.
 *
 *   # auth_request: verify, then nginx forwards to the app as before
 *   location = /_cappz_verify {
 *     internal;
 *     proxy_pass http://127.0.0.1:41446/cappz/verify;
 *     proxy_pass_request_body off;
 *     proxy_set_header Content-Length "";
 *     proxy_set_header X-Original-URI $request_uri;
 *     proxy_set_header X-Original-Method $request_method;
 *     proxy_set_header X-Original-Host $host;
 *     proxy_set_header X-SSL-Client-Cert $ssl_client_escaped_cert;   # mTLS clients
 *   }
 *   location /api/ {
 *     auth_request /_cappz_verify;
 *     auth_request_set $cappz_trust $upstream_http_cappz_verified_trust;
 *     proxy_set_header Cappz-Verified-Trust $cappz_trust;
 *     proxy_pass http://app;   # the app checks the body against Content-Digest
 *   }
 *   # mTLS with wallet-projected client certificates (self-signed, no CA):
 *   #   ssl_verify_client optional_no_ca;
 *
 * Proxy mode instead of auth_request: CAPPZ_VERIFY_UPSTREAM=http://app:8080
 * — the gateway reads the body, checks it against the signed Content-Digest
 * and forwards with Cappz-Verified-* headers (client-sent ones are stripped).
 *
 * CAPPZ_VERIFY_REQUIRE_BOUND=1 refuses keys no wallet declared.
 *
 * v15-11-00 shadow mode (CAPPZ_VERIFY_SHADOW=1 with CAPPZ_VERIFY_UPSTREAM =
 * the legacy-verified route, e.g. a PHP app): the route stays authoritative;
 * the gateway records its verdict next to the route's X-Legacy-Verdict and
 * both latencies. GET /cappz/verify/shadow answers the report with the retire
 * gate; counters persist in <CAPPZ_NODE_DATA>/shadow-compare.json every 30 s.
 * Cost inputs (assumptions, same instance for both): CAPPZ_COST_USD_PER_HOUR,
 * CAPPZ_COST_VCPUS, CAPPZ_COST_LABEL. Gate: CAPPZ_SHADOW_MIN_REQUESTS,
 * CAPPZ_SHADOW_MIN_DAYS, CAPPZ_SHADOW_MIN_DENIALS.
 * CAPPZ_VERIFY_REUSE_PORT=1 lets several gateway processes share the port (one per core;
 * verification has no shared state except the replay cache, which is per process — so
 * run replay-sensitive routes behind one process or with sticky connections).
 * GET /.well-known/cappz/tls-delegation serves this node's TLS delegation.
 */

import { createVerifyGateway } from '../../src/lib/identity/edgeVerify.ts';
import { createShadowComparison, DEFAULT_RETIRE_POLICY, type ShadowState } from '../../src/lib/identity/shadowCompare.ts';
import { fileEvidence } from './evidence.ts';

function shadowFor(dataDir: string) {
  if (Deno.env.get('CAPPZ_VERIFY_SHADOW') !== '1') return undefined;
  const path = `${dataDir}/shadow-compare.json`;
  let state: ShadowState | undefined;
  try { state = JSON.parse(Deno.readTextFileSync(path)); } catch { /* first run */ }
  const num = (k: string, d: number) => { const v = Deno.env.get(k); return v !== undefined && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d; }; // 0 is a valid setting
  const compare = createShadowComparison({ state, policy: { ...DEFAULT_RETIRE_POLICY, minRequests: num('CAPPZ_SHADOW_MIN_REQUESTS', DEFAULT_RETIRE_POLICY.minRequests), minDays: num('CAPPZ_SHADOW_MIN_DAYS', DEFAULT_RETIRE_POLICY.minDays), minDenials: num('CAPPZ_SHADOW_MIN_DENIALS', DEFAULT_RETIRE_POLICY.minDenials) } });
  // Atomic: write a temporary file, then rename, so a crash mid-write never leaves half a report.
  setInterval(() => { Deno.writeTextFile(`${path}.tmp`, JSON.stringify(compare.state())).then(() => Deno.rename(`${path}.tmp`, path)).catch((e) => console.warn('[edge-node] shadow state not saved:', e?.message ?? e)); }, 30_000);
  return { compare, cost: { instanceUsdPerHour: num('CAPPZ_COST_USD_PER_HOUR', 0.034), vcpus: num('CAPPZ_COST_VCPUS', 2), label: Deno.env.get('CAPPZ_COST_LABEL') ?? 'assumption: set CAPPZ_COST_USD_PER_HOUR to your instance price' } };
}

let shadowSingleton: ReturnType<typeof shadowFor> | null = null;

export function verifyGatewayFor(dataDir: string) {
  shadowSingleton ??= shadowFor(dataDir);
  return createVerifyGateway({
    shadow: shadowSingleton,
    evidence: fileEvidence(dataDir),
    requireBound: Deno.env.get('CAPPZ_VERIFY_REQUIRE_BOUND') === '1',
    upstream: Deno.env.get('CAPPZ_VERIFY_UPSTREAM') || undefined,
    maxBodyBytes: Number(Deno.env.get('CAPPZ_VERIFY_MAX_BODY') ?? '') || undefined,
    denyMultipart: Deno.env.get('CAPPZ_VERIFY_DENY_MULTIPART') === '1',
    maxAgeSec: Number(Deno.env.get('CAPPZ_VERIFY_MAX_AGE_SEC') ?? '') || undefined,
  });
}

export async function serveVerifyGateway(port: number, dataDir: string): Promise<void> {
  const gw = verifyGatewayFor(dataDir);
  const hostname = Deno.env.get('CAPPZ_VERIFY_HOST') ?? '127.0.0.1';
  console.log(`[edge-node] KeyZ Gate ${hostname}:${port}  (auth_request /cappz/verify, content /cappz/verify/content${Deno.env.get('CAPPZ_VERIFY_UPSTREAM') ? `, ${Deno.env.get('CAPPZ_VERIFY_SHADOW') === '1' ? 'SHADOW of' : 'proxy →'} ${Deno.env.get('CAPPZ_VERIFY_UPSTREAM')}` : ''})`);
  // CAPPZ_VERIFY_REUSE_PORT=1 (Linux): run one gateway process per core on the same port; the kernel spreads connections.
  Deno.serve({ port, hostname, reusePort: Deno.env.get('CAPPZ_VERIFY_REUSE_PORT') === '1' }, async (req) => {
    if (new URL(req.url).pathname === '/.well-known/cappz/tls-delegation') {
      try { return new Response(await Deno.readTextFile(`${dataDir}/tls-delegation.json`), { headers: { 'content-type': 'application/json' } }); } catch { return Response.json({ error: 'this node uses operator TLS files (no delegation)' }, { status: 404 }); }
    }
    return gw.handle(req);
  });
}
