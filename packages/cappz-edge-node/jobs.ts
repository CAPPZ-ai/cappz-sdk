/**
 * COPE node crystallized.
 * Node ID: v15-01-00-edge-node-jobs
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * Wave C runner: BPMN timers and secret-free inbound webhooks on the edge
 * node. The schedule is read from src/bpmn/substrate/functions/edge-node-jobs.bpmn;
 * the work comes from the jobs bound in src/lib/functions/edgeJobs.ts.
 * Every TX the node writes is signed with the node's own Ed25519 key
 * (CAPPZ_NODE_KEY = PKCS8 base64, CAPPZ_NODE_PUB = raw hex) and appended to
 * <CAPPZ_NODE_DATA>/edge-txs.jsonl, deduplicated by txId; browsers and peers
 * pull them from GET /txs. Without a key the node accepts no webhook and
 * runs no job — it never writes an unsigned TX.
 */

import { loadNodeKey } from './nodeKey.ts';
import {
  EDGE_TIMER_JOBS,
  EDGE_WEBHOOK_JOBS,
  dueTimers,
  parseTimerSchedules,
  signEdgeTx,
  webhookTx,
  type SignedEdgeTx,
} from '../../src/lib/functions/edgeJobs.ts';

const GOVERNING_PRINCIPLE = "m/44'/144'/100'/principles/cope/v1#local-first";

export interface JobRunnerOptions {
  port: number;
  nodeAddress: string;
  dataDir: string;
  bpmnPath: string;
  tickMs?: number;
}

export async function serveJobs(opts: JobRunnerOptions): Promise<void> {
  const key = await loadNodeKey();
  const logPath = `${opts.dataDir}/edge-txs.jsonl`;
  await Deno.mkdir(opts.dataDir, { recursive: true });
  const known = new Map<string, SignedEdgeTx>();
  try {
    for (const line of (await Deno.readTextFile(logPath)).split('\n')) if (line.trim()) { const t = JSON.parse(line) as SignedEdgeTx; known.set(t.txId, t); }
  } catch { /* first start */ }

  const append = async (tx: SignedEdgeTx) => {
    if (known.has(tx.txId)) return false;
    await Deno.writeTextFile(logPath, JSON.stringify(tx) + '\n', { append: true });
    known.set(tx.txId, tx);
    return true;
  };

  const { schedules, rejected } = parseTimerSchedules(await Deno.readTextFile(opts.bpmnPath));
  for (const r of rejected) console.log(`[edge-node] timer ${r.eventId} ignored: ${r.reason}`);
  if (!key) console.log('[edge-node] jobs off: needs CAPPZ_NODE_KEY / CAPPZ_NODE_PUB (the node signs every TX it writes)');
  console.log(`[edge-node] jobs :${opts.port}  ${schedules.length} timer(s), ${Object.keys(EDGE_WEBHOOK_JOBS).length} webhook(s) bound`);

  const lastRunAt: Record<string, number> = {};
  if (key) {
    setInterval(async () => {
      const { due, unbound } = dueTimers(schedules, lastRunAt, Date.now());
      for (const name of unbound) console.log(`[edge-node] timer for ${name} has no bound job`);
      for (const s of due) {
        lastRunAt[s.eventId] = Date.now();
        try {
          const r = await EDGE_TIMER_JOBS[s.functionName].run(new Date());
          for (const tx of r.txs ?? []) await append(await signEdgeTx(tx, key));
          console.log(`[edge-node] ${s.functionName}: ${r.ok ? 'ok' : 'failed'}${r.detail ? ` — ${r.detail}` : ''}`);
        } catch (e) {
          console.log(`[edge-node] ${s.functionName} threw: ${e instanceof Error ? e.message : e}`);
        }
      }
    }, opts.tickMs ?? 30_000);
  }

  Deno.serve({ port: opts.port }, async (req) => {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/txs') {
      const since = url.searchParams.get('since') ?? '';
      return Response.json([...known.values()].filter((t) => t.timestamp > since));
    }
    const hook = url.pathname.match(/^\/hooks\/([a-z0-9-]+)$/)?.[1];
    if (req.method === 'POST' && hook) {
      const job = Object.values(EDGE_WEBHOOK_JOBS).find((j) => j.path === hook);
      if (!job) return Response.json({ error: `no webhook bound at ${hook}` }, { status: 404 });
      if (!key) return Response.json({ error: 'this node has no signing key; nothing is accepted unsigned' }, { status: 503 });
      const body = await req.json().catch(() => undefined);
      if (!job.accepts(body)) return Response.json({ error: 'body not accepted' }, { status: 422 });
      const tx = await signEdgeTx(await webhookTx({ job, body, receivedAt: new Date().toISOString(), nodeAddress: opts.nodeAddress, targetAddress: `${opts.nodeAddress}/hooks/${hook}`, governingPrinciple: GOVERNING_PRINCIPLE }), key);
      const fresh = await append(tx);
      return Response.json({ txId: tx.txId, txHash: tx.txHash, duplicate: !fresh });
    }
    return new Response('cappz edge node jobs — POST /hooks/<path>, GET /txs', { status: 404 });
  });
}
