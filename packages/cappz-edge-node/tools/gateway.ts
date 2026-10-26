/**
 * COPE node crystallized.
 * Node ID: v15-11-00-standalone-gateway
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * Just KeyZ Gate (the verify gateway), without the rest of the edge node — the lowest-
 * friction way to put CAPPZ verification in front of an existing route.
 *
 *   deno run -A packages/cappz-edge-node/tools/gateway.ts --port 41446 --data ./node-data \
 *     --upstream http://127.0.0.1:8080 [--shadow] [--require-bound] [--reuse-port]
 *
 * --shadow: the upstream (your legacy-verified route) stays authoritative and
 * the gateway records its verdicts beside it (GET /cappz/verify/shadow).
 * Without it: proxy mode, verified requests only. Evidence files as the node
 * (key-declarations.json, key-revocations.json, key-delegations.json in --data).
 */
import { serveVerifyGateway } from '../verifyGateway.ts';

const flag = (n: string, d?: string) => { const i = Deno.args.indexOf(`--${n}`); return i >= 0 ? Deno.args[i + 1] : d; };
const upstream = flag('upstream');
if (upstream) Deno.env.set('CAPPZ_VERIFY_UPSTREAM', upstream);
if (Deno.args.includes('--shadow')) Deno.env.set('CAPPZ_VERIFY_SHADOW', '1');
if (Deno.args.includes('--require-bound')) Deno.env.set('CAPPZ_VERIFY_REQUIRE_BOUND', '1');
if (Deno.args.includes('--reuse-port')) Deno.env.set('CAPPZ_VERIFY_REUSE_PORT', '1');
const data = flag('data', './node-data')!;
await Deno.mkdir(data, { recursive: true });
await serveVerifyGateway(Number(flag('port', '41446')), data);
