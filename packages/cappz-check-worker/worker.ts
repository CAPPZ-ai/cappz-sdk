/**
 * COPE node crystallized. Node ID: v15-27-00-cappz-check-worker.
 * Provenance: m/44'/144'/100'/principles/cope/v1#marketplace
 *
 * CAPPZ counterparty check as a paid agent on a Cloudflare Worker (free plan):
 * the paid-agent protocol (POST /jobs → pay → GET result), one agent per
 * network under /testnet and /mainnet, jobs in D1, ledger reads over HTTPS,
 * marketplace history from the public log, reports signed with Ed25519.
 * It holds the treasury's public address only — never a seed — and the
 * report-signing key as a Worker secret.
 *
 * It also answers deal-bound signing approvals for free (POST /<net>/authorize):
 * the same key signs them under a separate domain (signingApproval.ts).
 */
import { isValidClassicAddress } from 'xrpl';
import { createPaidAgent, SCHEDULE_PRESETS, type JobEvent, type JobStore } from '../../src/lib/agentKit/paidAgent';
import { rpcLedgerReader } from '../../src/lib/xrpl/xrplRpc';
import { runCounterpartyCheck, signCheck, type CheckRequest } from '../../src/lib/marketplace/counterpartyCheck';
import { evaluateSigningIntent, signApproval } from '../../src/lib/marketplace/signingApproval';
import { attributePublicLog, marketPartition, pullPublicLog, type PublicLogPort } from '../../src/lib/marketplace/publicLog';
import { resolveMarket, type MarketState } from '../../src/lib/marketplace/replay';
import { ed25519 } from '@noble/curves/ed25519';

interface D1Result<T> { results: T[] }
interface D1Stmt { bind(...v: unknown[]): D1Stmt; all<T>(): Promise<D1Result<T>>; first<T>(): Promise<T | null>; run(): Promise<unknown> }
interface D1 { prepare(sql: string): D1Stmt }
interface Ctx { waitUntil(p: Promise<unknown>): void }
export interface Env {
  DB: D1;
  /** 32-byte Ed25519 seed (hex) that signs reports — a Worker secret. */
  CHECK_SIGNING_SEED: string;
  MIRROR_URL: string;
  MIRROR_KEY: string;
  PAY_TO_MAINNET: string;
  PAY_TO_TESTNET: string;
  PRICE_XRP: string;
}

type Net = 'mainnet' | 'testnet';
const NETS: Net[] = ['mainnet', 'testnet'];
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
const json = (code: number, body: unknown) => new Response(JSON.stringify(body, null, 2), { status: code, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS } });
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));

/** The paid-agent JobStore on D1, partitioned by network; per-job reads only. */
export function d1JobStore(db: D1, network: Net): JobStore {
  const rows = async (sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).all<{ body: string }>()).results.map((r) => JSON.parse(r.body) as JobEvent);
  return {
    async append(e) { await db.prepare('INSERT INTO events (network, job_id, type, tx_hash, body) VALUES (?, ?, ?, ?, ?)').bind(network, e.jobId, e.type, 'txHash' in e ? e.txHash : null, JSON.stringify(e)).run(); },
    events: () => rows('SELECT body FROM events WHERE network = ? ORDER BY seq', network),
    eventsFor: (jobId) => rows('SELECT body FROM events WHERE network = ? AND job_id = ? ORDER BY seq', network, jobId),
    async paymentUsed(txHash) { return !!(await db.prepare("SELECT 1 AS x FROM events WHERE network = ? AND type = 'StagePaid' AND tx_hash = ? LIMIT 1").bind(network, txHash).first()); },
    async putResult(jobId, stage, bytes) { await db.prepare('INSERT OR REPLACE INTO results (network, job_id, stage, bytes) VALUES (?, ?, ?, ?)').bind(network, jobId, stage, bytes).run(); },
    async getResult(jobId, stage) { const r = await db.prepare('SELECT bytes FROM results WHERE network = ? AND job_id = ? AND stage = ?').bind(network, jobId, stage).first<{ bytes: ArrayBuffer | number[] }>(); return r ? new Uint8Array(r.bytes as ArrayBuffer) : null; },
  };
}

/** The marketplace's public log for one network, replayed; cached for a minute per isolate. */
const cache = new Map<Net, { at: number; state: MarketState }>();
async function marketState(env: Env, network: Net, fresh = false): Promise<MarketState | null> {
  const hit = cache.get(network);
  if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.state;
  const partition = marketPartition(network);
  const port: PublicLogPort = {
    insert: async () => ({ error: { message: 'read-only' } }),
    async select(since, limit) {
      const q = new URLSearchParams({ select: 'metadata,created_at', query_hash: `eq.${partition}`, chainlet_id: 'is.null', order: 'created_at.asc', limit: String(limit) });
      if (since) q.append('created_at', `gte.${since}`);
      const res = await fetch(`${env.MIRROR_URL}/rest/v1/chainlet_blocks?${q}`, { headers: { apikey: env.MIRROR_KEY, authorization: `Bearer ${env.MIRROR_KEY}` } });
      return res.ok ? { data: await res.json(), error: null } : { data: null, error: { message: String(res.status) } };
    },
  };
  try {
    const state = resolveMarket(attributePublicLog(await pullPublicLog(port, null)).accepted);
    cache.set(network, { at: Date.now(), state });
    return state;
  } catch { return null; }
}

/** Validate a job's input before anything is opened. */
export function checkInput(input: unknown, network: Net): CheckRequest {
  const i = (typeof input === 'object' && input ? input : {}) as Record<string, unknown>;
  const address = i.address ? String(i.address) : undefined; const party = i.party ? String(i.party) : undefined;
  if (!address && !party) throw new Error('Send {"input": {"address": "r…"}} or {"input": {"party": "p-…"}}; optionally "amountXrp", "payer" and "escrowLegs".');
  if (address && !isValidClassicAddress(address)) throw new Error(`${address} is not a valid XRPL classic address.`);
  if (i.payer && !isValidClassicAddress(String(i.payer))) throw new Error('payer is not a valid XRPL classic address.');
  const amountXrp = i.amountXrp === undefined ? undefined : Number(i.amountXrp);
  if (amountXrp !== undefined && !(amountXrp >= 0)) throw new Error('amountXrp must be a number of XRP.');
  return { network, ...(address ? { address } : {}), ...(party ? { party } : {}), ...(amountXrp !== undefined ? { amountXrp } : {}), ...(i.payer ? { payer: String(i.payer) } : {}), ...(i.escrowLegs ? { escrowLegs: Math.max(1, Math.floor(Number(i.escrowLegs))) } : {}) };
}

function agentFor(env: Env, network: Net) {
  return createPaidAgent({
    offer: {
      name: `CAPPZ counterparty check (${network})`,
      description: 'Before you pay or fund escrow: can this XRPL address receive (activated, DepositAuth, destination tag), how old and active is it, what is its CAPPZ marketplace record (finished deals, disputes, mandate), and can you afford it. Verdict ok / warn / stop with reasons, signed (Ed25519) so you can keep it as evidence. Rules: github.com/CAPPZ-ai/cappz-sdk/blob/main/src/lib/marketplace/counterpartyCheck.ts',
      payTo: network === 'mainnet' ? env.PAY_TO_MAINNET : env.PAY_TO_TESTNET, network, currency: 'XRP', price: Number(env.PRICE_XRP || '0.01'),
      stages: SCHEDULE_PRESETS['on-completion'].stages,
    },
    store: d1JobStore(env.DB, network),
    ledger: rpcLedgerReader,
    work: async ({ input }) => {
      const report = await runCounterpartyCheck(checkInput(input, network), await marketState(env, network));
      // Never charge for a report that could not read the ledger: fail the stage (it is retried) instead of delivering it.
      const unreadable = report.ledger?.error ?? report.payer?.error;
      if (unreadable) throw new Error(`The ledger could not be read just now (${unreadable}); the check is retried, nothing is charged.`);
      return JSON.stringify(signCheck(report, env.CHECK_SIGNING_SEED), null, 2);
    },
  });
}

/**
 * Deal-bound signing approval (free): replay the public log now (never a cached copy, so a dispute raised a moment
 * ago counts) and approve this exact unsigned escrow transaction, or say why not. Read-only: nothing is stored.
 */
export async function authorize(body: unknown, network: Net, state: MarketState | null, seedHex: string, now = new Date().toISOString()) {
  const b = (typeof body === 'object' && body ? body : {}) as Record<string, unknown>;
  const tx = b.tx && typeof b.tx === 'object' ? b.tx as Record<string, unknown> : null;
  const milestone = Number(b.milestone);
  if (!tx || typeof b.contractId !== 'string' || !Number.isInteger(milestone) || milestone < 0) throw new Error('Send {"contractId": "ct-…", "milestone": 0, "tx": {…unsigned, autofilled…}} and, for agents above their threshold, "coSignedBy".');
  if (!state) return { code: 503, body: { approved: false, reasons: [{ code: 'market-unreadable', message: 'The marketplace log could not be read just now; nothing is approved. Retry shortly.' }] } };
  const d = await evaluateSigningIntent(state, { network, contractId: b.contractId, milestone, tx, ...(typeof b.coSignedBy === 'string' ? { coSignedBy: b.coSignedBy } : {}) }, now);
  return d.approved ? { code: 200, body: { approved: true, ...signApproval(d.approval, seedHex) } } : { code: 200, body: d };
}

const JOB = /^\/(mainnet|testnet)\/jobs\/(job-[0-9a-f]{16})(\/payments|\/retry|\/stages\/(\d+)\/result)?$/;

export default {
  async fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      const publicKey = hex(ed25519.getPublicKey(unhex(env.CHECK_SIGNING_SEED)));
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/key')) {
        return json(200, { service: 'CAPPZ counterparty check', price: `${env.PRICE_XRP || '0.01'} XRP per check`, networks: Object.fromEntries(NETS.map((n) => [n, `${url.origin}/${n}`])), signature: { alg: 'Ed25519', publicKey }, howToUse: 'cappz-market check <address|party> [--network mainnet] — or POST /<network>/jobs {"input": {"address": "r…"}} → pay the stage shown → GET /<network>/jobs/<id>/stages/0/result', approvals: 'Free: POST /<network>/authorize {"contractId", "milestone", "tx"} → a signed approval of that exact unsigned escrow transaction, or the reasons it is refused. Rules: https://github.com/CAPPZ-ai/cappz-sdk/blob/main/src/lib/marketplace/signingApproval.ts', rules: 'https://github.com/CAPPZ-ai/cappz-sdk/blob/main/src/lib/marketplace/counterpartyCheck.ts' });
      }
      const top = /^\/(mainnet|testnet)(\/agent|\/health|\/jobs|\/authorize)?$/.exec(url.pathname);
      if (top && top[2] === '/authorize') {
        if (req.method !== 'POST') return json(405, { error: 'POST {"contractId", "milestone", "tx"} to get a signing approval.' });
        const network = top[1] as Net;
        const r = await authorize(await req.json().catch(() => ({})), network, await marketState(env, network, true), env.CHECK_SIGNING_SEED);
        return json(r.code, r.body);
      }
      if (top) {
        const network = top[1] as Net; const agent = agentFor(env, network);
        if (req.method === 'GET' && (!top[2] || top[2] === '/agent')) return json(200, { ...agent.card(), publicKey, howToUse: 'POST /jobs {"input": {"address": "r…"}} → pay the stage shown → GET /jobs/<id>/stages/0/result' });
        if (req.method === 'GET' && top[2] === '/health') return json(200, { ok: true, network, payTo: agent.offer.payTo });
        if (req.method === 'POST' && top[2] === '/jobs') {
          const body = (await req.json().catch(() => ({}))) as { input?: unknown };
          checkInput(body.input, network);
          const opened = await agent.openJob(body.input);
          const done = await agent.work(opened.job.jobId); // checks take a second or two: answer with the result's hash ready
          return json(201, { job: done, pay: (await agent.job(opened.job.jobId))?.pay ?? opened.pay });
        }
      }
      const m = JOB.exec(url.pathname);
      if (!m) return json(404, { error: 'Not found. GET / for how to use this service.' });
      const [, net, id, sub, stage] = m; const agent = agentFor(env, net as Net);
      if (req.method === 'GET' && !sub) { const j = await agent.job(id); return j ? json(200, j) : json(404, { error: 'Unknown job.' }); }
      if (req.method === 'POST' && sub === '/payments') { const b = (await req.json().catch(() => ({}))) as { txHash?: string }; return json(200, await agent.claimPayment(id, String(b.txHash ?? ''))); }
      if (req.method === 'POST' && sub === '/retry') { const j = await agent.retry(id); if (j) ctx.waitUntil(agent.work(id)); return json(200, j); }
      if (req.method === 'GET' && stage !== undefined) {
        const r = await agent.result(id, Number(stage));
        if (r.state === 'released') return new Response(r.bytes as unknown as BodyInit, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'x-result-sha256': r.hash, ...CORS } });
        if (r.state === 'payment-required') return json(402, { message: 'Ready — pay this stage to receive it.', resultSha256: r.hash, pay: r.pay });
        return json(409, { message: 'Not ready yet.', job: r.job });
      }
      return json(405, { error: 'Method not allowed.' });
    } catch (e) { return json(400, { error: (e as Error).message }); }
  },
};
