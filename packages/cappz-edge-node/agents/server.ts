/**
 * Paid agents for a CAPPZ edge node (15.43.0), on the SDK's paid-agent kit.
 *
 *   /agents/timestamp  Signed timestamp: a SHA-256 in, a receipt signed with the
 *                      node key out (verifyEdgeTx checks it). Pay on completion.
 *   /agents/webhook    Signed webhook receiver: an endpoint for CAPPZ_WEBHOOK_DAYS
 *                      (default 30) that turns each POST into a signed record; the
 *                      signed bundle is the deliverable. 30% deposit, 70% at the end.
 *
 * Each agent serves the paid-agent protocol `cappz-market hire` speaks:
 *   GET  <base>/agent | /health
 *   POST <base>/jobs {"input": …}
 *   GET  <base>/jobs/<id>
 *   POST <base>/jobs/<id>/payments {"txHash"}   POST <base>/jobs/<id>/retry
 *   GET  <base>/jobs/<id>/stages/<n>/result     (402 until that stage is paid)
 * plus, for the webhook agent:
 *   POST <base>/hooks/<jobId>   GET <base>/hooks/<jobId> (status, no content)
 *
 * Docs (docs.ts; templates in ./docs): GET /agents/ (guide for people; JSON for
 * agents), /agents/llms.txt, /agents/<agent>/SKILL.md, /agents/openapi.json,
 * /agents/verify.mjs. A browser opening an agent's URL lands on its try-it form.
 *
 * Run one instance per network (testnet validates a flow with free test XRP; mainnet
 * is real XRP) behind a TLS proxy; README.md has the Windows launcher and Caddy config.
 * Every signed record carries payload.network: both instances share the node key, so
 * a free testnet record must never pass for a paid mainnet one.
 * Listens on 127.0.0.1 only. Holds only the public payout address; the node key
 * (CAPPZ_NODE_KEY / CAPPZ_NODE_PUB, as for main.ts) signs receipts and records.
 */
import {
  createPaidAgent, defineAgentOffer, SCHEDULE_PRESETS, xrplLedgerReader,
  type JobEvent, type JobStore, type PaidAgent, type XrplNetwork,
} from '../../../src/lib/agentKit/paidAgent.ts';
import { signEdgeTx, sha256HexOf } from '../../../src/lib/functions/edgeJobs.ts';
import { loadNodeKey } from '../signingKey.ts';
import { DOC_FILES, docVars, renderDoc, WEBHOOK_DEPOSIT_SHARE } from './docs.ts';

const env = (k: string, d?: string) => Deno.env.get(k)?.trim() || d;
const PAY_TO = env('CAPPZ_AGENT_PAYTO')!;
const NETWORK = (env('CAPPZ_AGENT_NETWORK', 'testnet')) as XrplNetwork;
const PORT = Number(env('CAPPZ_AGENT_PORT', '41460'));
const PUBLIC_BASE = env('CAPPZ_AGENT_PUBLIC_BASE', `http://127.0.0.1:${PORT}/agents`)!.replace(/\/+$/, '');
const POW = env('CAPPZ_POW', PAY_TO)!;
const DATA = env('CAPPZ_AGENT_DATA');
const TIMESTAMP_PRICE = Number(env('CAPPZ_TIMESTAMP_PRICE_XRP', '0.05'));
const WEBHOOK_PRICE = Number(env('CAPPZ_WEBHOOK_PRICE_XRP', '2'));
const WEBHOOK_DAYS = Number(env('CAPPZ_WEBHOOK_DAYS', '30'));
const WEBHOOK_MAX_BODY = 64 * 1024;
const WEBHOOK_MAX_RECORDS = 10_000;
const PRINCIPLE = "m/44'/144'/100'/principles/cope/v1#local-first";
const DAY = 86_400_000;

if (!PAY_TO) { console.error('[agents] CAPPZ_AGENT_PAYTO is not set (the public XRPL address buyers pay)'); Deno.exit(1); }
if (!DATA) { console.error('[agents] CAPPZ_AGENT_DATA is not set (a writable folder for jobs and results, one per network)'); Deno.exit(1); }
const key = await loadNodeKey();
if (!key) { console.error('[agents] needs CAPPZ_NODE_KEY / CAPPZ_NODE_PUB (node.env): receipts are signed with the node key'); Deno.exit(1); }

// ─── Durable job store: one append-only log per agent, results as files ──────

/** A missing file is a fresh start; any other read error (a denied --allow-read, a broken disk) must stop the agent, never pass for "no jobs". */
const onlyMissing = (e: unknown): void => { if (!(e instanceof Deno.errors.NotFound)) throw e; };

async function fileJobStore(dir: string): Promise<JobStore> {
  await Deno.mkdir(`${dir}/results`, { recursive: true });
  const logPath = `${dir}/jobs.jsonl`;
  const log: JobEvent[] = [];
  try { for (const l of (await Deno.readTextFile(logPath)).split('\n')) if (l.trim()) log.push(JSON.parse(l)); } catch (e) { onlyMissing(e); /* first start */ }
  return {
    async append(e) { await Deno.writeTextFile(logPath, JSON.stringify(e) + '\n', { append: true }); log.push(e); },
    async events() { return [...log]; },
    async eventsFor(jobId) { return log.filter((e) => e.jobId === jobId); },
    async paymentUsed(txHash) { return log.some((e) => e.type === 'StagePaid' && e.txHash === txHash); },
    async putResult(j, s, b) { await Deno.writeFile(`${dir}/results/${j}-${s}`, b); },
    async getResult(j, s) { try { return await Deno.readFile(`${dir}/results/${j}-${s}`); } catch (e) { onlyMissing(e); return null; } },
  };
}

const signed = (eventType: string, targetAddress: string, payload: Record<string, unknown>) =>
  // `network` is signed in: both instances share the node key, so a free testnet record must never pass for a paid mainnet one.
  signEdgeTx({ txId: `${eventType}-${crypto.randomUUID()}`, timestamp: new Date().toISOString(), eventType, sourceAddress: POW, targetAddress, payload: { ...payload, network: NETWORK, governingPrinciple: PRINCIPLE } }, key);

const VERIFY_HOW = 'verifyEdgeTx(receipt) from @cappz/sdk (src/lib/functions/edgeJobs.ts): recomputes txHash over the canonical TX and checks the Ed25519 signature against signerPublicKey.';

// ─── Agent 1: signed timestamp (pay on completion) ───────────────────────────

const tsStore = await fileJobStore(`${DATA}/timestamp`);
const timestamp = createPaidAgent({
  offer: defineAgentOffer({
    name: 'CAPPZ signed timestamp',
    description: `Send a SHA-256 of any file; receive a receipt signed by CAPPZ edge node ${key.publicKeyHex.slice(0, 16)}… stating that this hash was presented at this time. The file never leaves your computer. Pay on completion: you see the receipt's fingerprint first.`,
    payTo: PAY_TO, network: NETWORK, currency: 'XRP', price: TIMESTAMP_PRICE,
    stages: SCHEDULE_PRESETS['on-completion'].stages.map((s) => ({ ...s, deliverable: 'Signed timestamp receipt (JSON)' })),
  }),
  store: tsStore,
  work: async ({ jobId, input }) => {
    const { sha256, note } = input as { sha256: string; note?: string };
    const receipt = await signed('HashTimestamped', `${POW}/timestamps/${sha256.toLowerCase()}`, { sha256: sha256.toLowerCase(), note: note ?? null, jobId });
    await Deno.writeTextFile(`${DATA}/timestamp/receipts.jsonl`, JSON.stringify(receipt) + '\n', { append: true });
    return { receipt, verify: VERIFY_HOW };
  },
});

// ─── Agent 2: signed webhook receiver (deposit 30%, 70% at period end) ───────

const whStore = await fileJobStore(`${DATA}/webhook`);
const hookFile = (jobId: string) => `${DATA}/webhook/hooks-${jobId}.jsonl`;
/** The period starts when the deposit is recorded and lasts WEBHOOK_DAYS. */
async function period(jobId: string): Promise<{ start: number; end: number } | null> {
  const paid = (await whStore.eventsFor!(jobId)).find((e) => e.type === 'StagePaid' && e.stage === 0);
  if (!paid) return null;
  const start = Date.parse(paid.at);
  return { start, end: start + WEBHOOK_DAYS * DAY };
}
async function hookRecords(jobId: string): Promise<unknown[]> {
  try { return (await Deno.readTextFile(hookFile(jobId))).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)); } catch (e) { onlyMissing(e); return []; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const webhook = createPaidAgent({
  offer: defineAgentOffer({
    name: 'CAPPZ signed webhook receiver',
    description: `A webhook endpoint for ${WEBHOOK_DAYS} days on a CAPPZ edge node. Every POST becomes a record signed by node ${key.publicKeyHex.slice(0, 16)}… (time received, body and its SHA-256). At the end you receive the signed bundle of all records. 30% deposit opens the endpoint; 70% when the period ends and the bundle is ready.`,
    payTo: PAY_TO, network: NETWORK, currency: 'XRP', price: WEBHOOK_PRICE,
    stages: [
      { label: 'Deposit: endpoint opens', kind: 'upfront', share: WEBHOOK_DEPOSIT_SHARE, deliverable: `POST ${PUBLIC_BASE}/webhook/hooks/<jobId> accepts records for ${WEBHOOK_DAYS} days` },
      { label: 'Period ended: signed bundle', kind: 'completion', share: 1 - WEBHOOK_DEPOSIT_SHARE, deliverable: 'Every record received, each signed, in one signed bundle (JSON)' },
    ],
  }),
  store: whStore,
  // Runs once the deposit is recorded; waits for the period to end (in day-long sleeps; setTimeout caps near 24.8 days).
  work: async ({ jobId, input }) => {
    const p = await period(jobId);
    if (!p) throw new Error('The deposit is not recorded yet.');
    while (Date.now() < p.end) await sleep(Math.min(DAY, p.end - Date.now()));
    const records = await hookRecords(jobId);
    const bundle = await signed('WebhookPeriodClosed', `${POW}/hooks/${jobId}`, {
      jobId, label: (input as { label?: string })?.label ?? null,
      periodStart: new Date(p.start).toISOString(), periodEnd: new Date(p.end).toISOString(),
      count: records.length, recordsSha256: await sha256HexOf(JSON.stringify(records)),
    });
    return { bundle, records, verify: VERIFY_HOW };
  },
});

// ─── Payment watching ────────────────────────────────────────────────────────
// timestamp: agent.tick(). webhook: its completion work waits for the period, and
// tick() waits for running work, so payments are matched here and work is (re)started
// with agent.work(), which never runs a stage twice at once.

async function watchWebhook(): Promise<void> {
  const open = (await webhook.jobs()).filter((j) => j.state !== 'completed' && j.state !== 'cancelled');
  const incoming = new Map<string, Awaited<ReturnType<typeof xrplLedgerReader.incoming>>>();
  for (const j of open) {
    const v = await webhook.job(j.jobId);
    if (v?.pay) {
      const to = v.pay.destination;
      if (!incoming.has(to)) incoming.set(to, await xrplLedgerReader.incoming(NETWORK, to));
      for (const t of incoming.get(to)!.filter((t) => t.destinationTag === v.pay!.destinationTag)) {
        const c = await webhook.claimPayment(j.jobId, t.hash).catch(() => null);
        if (c?.state === 'paid') break;
      }
    }
    const after = await webhook.job(j.jobId);
    if (after?.job.state === 'working') void webhook.work(j.jobId);
  }
}
let ticking = false;
setInterval(async () => {
  if (ticking) return; ticking = true;
  try { await timestamp.tick(); } catch (e) { console.warn('[agents] timestamp tick:', (e as Error).message); }
  try { await watchWebhook(); } catch (e) { console.warn('[agents] webhook watch:', (e as Error).message); }
  ticking = false;
}, 15_000);

// ─── HTTP ────────────────────────────────────────────────────────────────────

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
const json = (code: number, body: unknown) => new Response(JSON.stringify(body, null, 2), { status: code, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS } });
const AGENTS: Record<string, { agent: PaidAgent; howToUse: string; validate: (input: unknown) => string | null }> = {
  timestamp: {
    agent: timestamp,
    howToUse: `cappz-market hire ${PUBLIC_BASE}/timestamp --input '{"sha256":"<64 hex>","note":"optional"}' --max ${TIMESTAMP_PRICE} — or POST /jobs {"input":{"sha256":"…"}} → pay the stage shown → GET /jobs/<id>/stages/0/result`,
    validate: (i) => {
      const x = i as { sha256?: unknown; note?: unknown };
      if (typeof x?.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(x.sha256)) return 'input.sha256 must be a SHA-256 in hex (64 characters).';
      if (x.note !== undefined && (typeof x.note !== 'string' || x.note.length > 200)) return 'input.note, when given, is text of at most 200 characters.';
      return null;
    },
  },
  webhook: {
    agent: webhook,
    howToUse: `cappz-market hire ${PUBLIC_BASE}/webhook --input '{"label":"my source"}' --max ${WEBHOOK_PRICE} — pay the deposit, then POST JSON or text (≤ 64 KB) to ${PUBLIC_BASE}/webhook/hooks/<jobId>; after ${WEBHOOK_DAYS} days pay the rest and GET /jobs/<id>/stages/1/result`,
    validate: (i) => {
      const x = i as { label?: unknown } | null | undefined;
      if (x?.label !== undefined && (typeof x.label !== 'string' || x.label.length > 100)) return 'input.label, when given, is text of at most 100 characters.';
      return null;
    },
  },
};

// ─── Docs: guide (HTML), llms.txt, per-agent SKILL.md, verifier, OpenAPI ──────
// Templates in ./docs, filled with live values and re-read per request (edit without restarting).

const DOCS_DIR = new URL('./docs/', import.meta.url);
const VARS = docVars({
  publicBase: PUBLIC_BASE, network: NETWORK, payTo: PAY_TO, nodePublicKeyHex: key.publicKeyHex,
  timestampPrice: TIMESTAMP_PRICE, webhookPrice: WEBHOOK_PRICE, webhookDays: WEBHOOK_DAYS,
  peerBase: env('CAPPZ_AGENT_PEER_BASE', '')!.replace(/\/+$/, ''),
});
async function doc(path: string): Promise<Response> {
  const d = DOC_FILES[path];
  const text = renderDoc(await Deno.readTextFile(new URL(d.file, DOCS_DIR)), VARS);
  return new Response(text, { headers: { 'content-type': d.type, 'cache-control': 'public, max-age=300', ...CORS } });
}
const docsFor = (name?: string) => ({
  guide: `${PUBLIC_BASE}/${name ? `#try-${name}` : ''}`, llms: `${PUBLIC_BASE}/llms.txt`, openapi: `${PUBLIC_BASE}/openapi.json`,
  ...(name ? { skill: `${PUBLIC_BASE}/${name}/SKILL.md` } : { skills: Object.keys(AGENTS).map((n) => `${PUBLIC_BASE}/${n}/SKILL.md`) }),
  verifier: `${PUBLIC_BASE}/verify.mjs`,
});
const wantsHtml = (req: Request) => (req.headers.get('accept') ?? '').includes('text/html');

function openapi(): unknown {
  const job = { type: 'object', description: 'Job view: job (id, state, stages) and pay (the next stage due: amount, destination, destinationTag, preparedTx).' };
  const pay = { description: 'Payment required: { message, resultSha256, pay: { amount, currency, destination, destinationTag, preparedTx } }' };
  const idParam = { name: 'jobId', in: 'path', required: true, schema: { type: 'string', pattern: '^job-[0-9a-f]{16}$' } };
  const agentPaths = (name: string, input: unknown) => ({
    [`/${name}/agent`]: { get: { summary: `Agent card: price, stages, payTo, network, signer`, responses: { 200: { description: 'Card' } } } },
    [`/${name}/jobs`]: { post: { summary: 'Open a job', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['input'], properties: { input } } } } }, responses: { 200: { description: 'Opened', content: { 'application/json': { schema: job } } }, 422: { description: 'Bad input' } } } },
    [`/${name}/jobs/{jobId}`]: { get: { summary: 'Job state', parameters: [idParam], responses: { 200: { description: 'Job', content: { 'application/json': { schema: job } } } } } },
    [`/${name}/jobs/{jobId}/payments`]: { post: { summary: 'Report a payment (optional: payments are matched automatically within ~15 s)', parameters: [idParam], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['txHash'], properties: { txHash: { type: 'string' } } } } } }, responses: { 200: { description: 'Recorded' }, 409: { description: 'Not a validated payment of this stage, or already used' } } } },
    [`/${name}/jobs/{jobId}/retry`]: { post: { summary: 'Retry failed work (paid stages stay paid)', parameters: [idParam], responses: { 200: { description: 'Job' } } } },
    [`/${name}/jobs/{jobId}/stages/{n}/result`]: { get: { summary: 'Stage result: 402 until paid, then the bytes (header x-result-sha256)', parameters: [idParam, { name: 'n', in: 'path', required: true, schema: { type: 'integer', minimum: 0 } }], responses: { 200: { description: 'Result JSON (signed)' }, 402: pay, 409: { description: 'Not ready yet' } } } },
  });
  return {
    openapi: '3.1.0',
    info: { title: `CAPPZ paid agents (${new URL(PUBLIC_BASE).host}, ${NETWORK})`, version: '1.0.0', description: `Pay-per-job agents paid in XRP on the XRP Ledger (${NETWORK}) to ${PAY_TO}. Results are signed with Ed25519 key ${key!.publicKeyHex}. No auth: pay each stage with its destinationTag. Guide: ${PUBLIC_BASE}/  llms.txt: ${PUBLIC_BASE}/llms.txt` },
    servers: [{ url: PUBLIC_BASE }],
    paths: {
      ...agentPaths('timestamp', { type: 'object', required: ['sha256'], properties: { sha256: { type: 'string', pattern: '^[0-9a-fA-F]{64}$' }, note: { type: 'string', maxLength: 200 } } }),
      ...agentPaths('webhook', { type: 'object', properties: { label: { type: 'string', maxLength: 100 } } }),
      '/webhook/hooks/{jobId}': {
        get: { summary: 'Endpoint status (active, period, record count; never bodies)', parameters: [idParam], responses: { 200: { description: 'Status' } } },
        post: { summary: 'Deliver a webhook (any content type, ≤ 64 KB); returns the signed record id', parameters: [idParam], requestBody: { content: { '*/*': {} } }, responses: { 200: { description: '{ txId, txHash, receivedAt }' }, 402: { description: 'Deposit not paid' }, 410: { description: 'Period ended' }, 413: { description: 'Body over 64 KB' }, 429: { description: 'Record limit reached' } } },
      },
    },
  };
}

const ROUTE = /^\/agents\/(timestamp|webhook)(\/agent|\/health|\/jobs|\/jobs\/(job-[0-9a-f]{16})(\/payments|\/retry|\/stages\/(\d+)\/result)?|\/hooks\/(job-[0-9a-f]{16}))?\/?$/;

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  if (url.pathname === '/agents') return Response.redirect(`${PUBLIC_BASE}/`, 301);
  if (req.method === 'GET' && url.pathname === '/agents/' && !wantsHtml(req)) {
    return json(200, { node: key!.publicKeyHex, network: NETWORK, payTo: PAY_TO, docs: docsFor(), agents: Object.keys(AGENTS).map((n) => ({ name: n, url: `${PUBLIC_BASE}/${n}`, price: AGENTS[n].agent.card().price, skill: `${PUBLIC_BASE}/${n}/SKILL.md` })) });
  }
  const docPath = url.pathname.startsWith('/agents/') ? url.pathname.slice('/agents'.length) : '';
  if (req.method === 'GET' && DOC_FILES[docPath]) return doc(docPath);
  if (req.method === 'GET' && url.pathname === '/agents/openapi.json') return json(200, openapi());
  const m = ROUTE.exec(url.pathname);
  if (!m) return json(404, { error: 'Not found.', docs: docsFor() });
  const [, name, sub, id, tail, stageN, hookId] = m;
  const a = AGENTS[name];
  // A person opening an agent's URL (e.g. from its marketplace card) lands on the guide.
  if (req.method === 'GET' && (!sub || sub === '/') && wantsHtml(req)) return Response.redirect(`${PUBLIC_BASE}/#try-${name}`, 302);
  if (req.method === 'GET' && (!sub || sub === '/agent' || sub === '/')) return json(200, { ...a.agent.card(), signerPublicKey: key!.publicKeyHex, howToUse: a.howToUse, docs: docsFor(name) });
  if (req.method === 'GET' && sub === '/health') return json(200, { ok: true, network: NETWORK, agent: name, payTo: PAY_TO, price: a.agent.offer.price });
  if (req.method === 'POST' && sub === '/jobs') {
    const body = await req.json().catch(() => null) as { input?: unknown } | null;
    const problem = a.validate(body?.input);
    if (problem) return json(422, { error: problem });
    return json(200, await a.agent.openJob(body?.input ?? {}));
  }
  if (id) {
    const known = await a.agent.job(id);
    if (!known) return json(404, { error: 'Unknown job.' });
    if (req.method === 'GET' && !tail) return json(200, known);
    if (req.method === 'POST' && tail === '/payments') {
      const b = await req.json().catch(() => ({})) as { txHash?: string };
      try { return json(200, await a.agent.claimPayment(id, String(b.txHash ?? ''))); } catch (e) { return json(409, { error: (e as Error).message }); }
    }
    if (req.method === 'POST' && tail === '/retry') return json(200, await a.agent.retry(id));
    if (req.method === 'GET' && stageN !== undefined) {
      const r = await a.agent.result(id, Number(stageN));
      if (r.state === 'released') return new Response(r.bytes as unknown as BodyInit, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'x-result-sha256': r.hash, ...CORS } });
      if (r.state === 'payment-required') return json(402, { message: 'Ready — pay this stage to receive it.', resultSha256: r.hash, pay: r.pay });
      return json(409, { message: 'Not ready yet.', job: r.job });
    }
  }
  if (name === 'webhook' && hookId) {
    const v = await webhook.job(hookId);
    if (!v) return json(404, { error: 'Unknown job.' });
    const p = await period(hookId);
    const active = !!p && Date.now() < p.end && v.job.state !== 'cancelled';
    const count = (await hookRecords(hookId)).length;
    if (req.method === 'GET') return json(200, { jobId: hookId, active, periodStart: p ? new Date(p.start).toISOString() : null, periodEnd: p ? new Date(p.end).toISOString() : null, records: count });
    if (req.method === 'POST') {
      if (!active) return json(p ? 410 : 402, { error: p ? 'The period has ended.' : 'Pay the deposit to open this endpoint.', pay: v.pay ?? null });
      if (count >= WEBHOOK_MAX_RECORDS) return json(429, { error: `This endpoint holds at most ${WEBHOOK_MAX_RECORDS} records per period.` });
      const raw = new Uint8Array(await req.arrayBuffer());
      if (raw.length > WEBHOOK_MAX_BODY) return json(413, { error: 'Bodies are limited to 64 KB.' });
      const text = new TextDecoder().decode(raw);
      let body: unknown = text; try { body = JSON.parse(text); } catch { /* keep text */ }
      const record = await signed('WebhookReceived', `${POW}/hooks/${hookId}`, { jobId: hookId, contentType: req.headers.get('content-type'), bodySha256: await sha256HexOf(text), body });
      await Deno.writeTextFile(hookFile(hookId), JSON.stringify(record) + '\n', { append: true });
      return json(200, { txId: record.txId, txHash: record.txHash, receivedAt: record.timestamp });
    }
  }
  return json(405, { error: 'Method not allowed.' });
}

Deno.serve({ port: PORT, hostname: '127.0.0.1', onListen: ({ hostname, port }) => console.log(`[agents] ${NETWORK}  payTo ${PAY_TO}  listening on ${hostname}:${port}  public ${PUBLIC_BASE}`) }, (req) =>
  handle(req).catch((e) => { console.error('[agents]', e); return json(500, { error: 'Internal error.' }); }));
