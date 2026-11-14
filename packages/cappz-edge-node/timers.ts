/**
 * COPE node crystallized.
 * Node ID: v15-41-00-edge-node-timers
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * Timers-only edge node: runs the BPMN timers in CAPPZ_JOBS_BPMN and nothing
 * else. No peer, relay, gateway or directory listener, and no npm package in
 * its module graph (signingKey.ts + jobs.ts + edgeJobs.ts use WebCrypto only).
 * The jobs HTTP server (GET /txs, POST /hooks/<path>) binds 127.0.0.1 unless
 * CAPPZ_JOBS_HOST says otherwise. Ticks need outbound HTTPS only.
 *
 *   deno run --cached-only --no-config --allow-net --allow-read --allow-write --allow-env timers.ts [--jobs 41444]
 *
 * Exits non-zero when there is no node key or the schedule cannot be read, so a
 * supervisor (systemd Restart=always, run.ps1) shows the failure instead of an idle node.
 *
 * subscription-watch (CAPPZ_FUNDING_CONFIG) needs the XRPL client, which this
 * entry does not load; run main.ts --jobs for it.
 */

import { loadNodeKey } from './signingKey.ts';
import { serveJobs } from './jobs.ts';

const i = Deno.args.indexOf('--jobs');
const port = i >= 0 ? Number(Deno.args[i + 1]) : 41444;
const hostname = Deno.env.get('CAPPZ_JOBS_HOST') ?? '127.0.0.1';
const bpmnPath = Deno.env.get('CAPPZ_JOBS_BPMN');
const dataDir = Deno.env.get('CAPPZ_NODE_DATA') ?? './cappz-node-data';
const powAddress = Deno.env.get('CAPPZ_POW') ?? 'unset-pow';

const fail = (msg: string): never => {
  console.error(`[edge-node] ${msg}`);
  Deno.exit(1);
};

if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`--jobs needs a port number, got ${Deno.args[i + 1]}`);
if (!bpmnPath) fail('CAPPZ_JOBS_BPMN must name the timer schedule (edge-node-jobs.bpmn)');
const key = await loadNodeKey().catch((e) => fail(`node key: ${e instanceof Error ? e.message : e}`));
if (!key) fail('needs CAPPZ_NODE_KEY / CAPPZ_NODE_PUB: the node signs every tick');
if (Deno.env.get('CAPPZ_FUNDING_CONFIG')) console.warn('[edge-node] CAPPZ_FUNDING_CONFIG is ignored by timers.ts; run main.ts --jobs for subscription-watch');

console.log(`[edge-node] timers only  POW ${powAddress}  key ${key!.publicKeyHex.slice(0, 16)}…`);
await serveJobs({ port, hostname, nodeAddress: powAddress, dataDir, bpmnPath: bpmnPath! })
  .catch((e) => fail(`jobs :${port} did not start: ${e instanceof Error ? e.message : e}`));
