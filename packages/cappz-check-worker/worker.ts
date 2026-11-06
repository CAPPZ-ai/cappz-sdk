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
 *
 * v15-31-00: /authorize verifies the request's RFC 9421 signature against the
 * agent's KeyZ-declared key on its market profile (agentRequestAuth.ts) and
 * records the state in the approval; an agent whose mandate binds a key is
 * approved only on `verified-bound`. It serves a signed A2A agent card
 * (/.well-known/agent-card.json, and per network) and free signed reputation
 * attestations (GET /<net>/reputation/<partyId>). The card, the reports, the
 * approvals and the attestations are all signed by the one report key: it is
 * the key the marketplace discovery document publishes (trust state
 * `published-key`), not a KeyZ-declared key — no wallet declaration names it
 * yet, and the card says so.
 *
 * v15-32-00: three more paid agents on the same worker, each its own card,
 * price and pay-to address (/<net>/evaluate, /<net>/draft, /<net>/scout):
 * the stage evaluator (a signed pass / fail / needs-human verdict on a
 * delivered file against the milestone's agreed acceptance criteria; the
 * file is received in the request, hashed, checked and never stored), the
 * listing drafter (plain words → a checked `cappz-market sell|ask` command)
 * and the subcontract scout (work packages, candidates and ready
 * `subcontract` commands for a contract). Jobs are partitioned per agent in
 * D1. Verdicts are signed by the same key under their own domain. None of
 * them writes to the marketplace log: parties act with cappz-market.
 */
import { isValidClassicAddress } from 'xrpl';
import { createPaidAgent, SCHEDULE_PRESETS, type JobEvent, type JobStore } from '../../src/lib/agentKit/paidAgent';
import { rpcLedgerReader } from '../../src/lib/xrpl/xrplRpc';
import { readAccountFacts, runCounterpartyCheck, signCheck, type CheckRequest } from '../../src/lib/marketplace/counterpartyCheck';
import { evaluateSigningIntent, signApproval } from '../../src/lib/marketplace/signingApproval';
import { createAgentRequestVerifier, type AgentRequestVerifier, type RequestAuth } from '../../src/lib/marketplace/agentRequestAuth';
import { buildAgentCard, signAgentCard, type AgentSkill } from '../../src/lib/marketplace/agentCard';
import { buildReputationAttestation, signReputation } from '../../src/lib/marketplace/reputationAttestation';
import { readBounded } from '../../src/lib/identity/edgeVerify';
import { attributePublicLog, marketPartition, pullPublicLog, type PublicLogPort } from '../../src/lib/marketplace/publicLog';
import { resolveMarket, type MarketState } from '../../src/lib/marketplace/replay';
import { currencyOf } from '../../src/lib/marketplace/paymentAssets';
import { ed25519 } from '@noble/curves/ed25519';
import { evaluationTarget, evaluateDeliverable, signVerdict, deliverableSha256Of, MAX_DELIVERABLE_BYTES, type EvaluationTarget } from '../../src/lib/marketplace/stageEvaluation';
import { acceptanceHash } from '../../src/lib/marketplace/acceptance';
import { normalizeDraft, MAX_DRAFT_TEXT } from '../../src/lib/marketplace/listingDraft';
import { scoutSubcontracts } from '../../src/lib/marketplace/subcontractScout';
import type { ModelEnv, ModelPorts } from './modelPorts';

/**
 * Model ports are registered by the deploy entry (main.ts → modelPorts.ts), so this module, its tests and anyone
 * importing it never load a model client. Unregistered: no model (rules-only evaluator and scout, no drafter).
 */
let portsFactory: (env: ModelEnv) => ModelPorts = (env) => ({ model: env.MODEL || 'claude-haiku-5-5', judge: null, drafter: null, planner: null });
export const registerModelPorts = (factory: (env: ModelEnv) => ModelPorts): void => { portsFactory = factory; };
const modelPorts = (env: ModelEnv): ModelPorts => portsFactory(env);

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
  /** v15-32-00: where the evaluator, drafter and scout are paid (public addresses only). */
  AGENT_PAY_TO_MAINNET?: string;
  AGENT_PAY_TO_TESTNET?: string;
  PRICE_EVALUATE_XRP?: string;
  PRICE_DRAFT_XRP?: string;
  PRICE_SCOUT_XRP?: string;
  /** Largest deliverable the evaluator reads, in bytes (default 512 KB; never above MAX_DELIVERABLE_BYTES). */
  MAX_DELIVERABLE_BYTES?: string;
  /** Model for rubric questions, drafts and scout plans (default claude-haiku-5-5); the key is a secret. */
  MODEL?: string;
  ANTHROPIC_API_KEY?: string;
}

type Net = 'mainnet' | 'testnet';
const NETS: Net[] = ['mainnet', 'testnet'];
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, content-digest, signature, signature-input, cappz-wallet, cappz-party', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
/** The card's version follows the SDK release that ships this worker. */
export const SERVICE_VERSION = '15.32.2';
const json = (code: number, body: unknown) => new Response(JSON.stringify(body, null, 2), { status: code, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS } });
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));

/** The paid-agent JobStore on D1, partitioned by network (and, for the v15-32-00 agents, `<network>:<agent>`); per-job reads only. */
export function d1JobStore(db: D1, network: string): JobStore {
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
  if (!address && !party) throw new Error('Send {"input": {"address": "r…"}} or {"input": {"party": "p-…"}}; optionally "amountXrp", "payer", "escrowLegs", and "currency" + "amount" for CAPPZ or USD-tokenZ/1 (RLUSD).');
  if (address && !isValidClassicAddress(address)) throw new Error(`${address} is not a valid XRPL classic address.`);
  if (i.payer && !isValidClassicAddress(String(i.payer))) throw new Error('payer is not a valid XRPL classic address.');
  const amountXrp = i.amountXrp === undefined ? undefined : Number(i.amountXrp);
  if (amountXrp !== undefined && !(amountXrp >= 0)) throw new Error('amountXrp must be a number of XRP.');
  // 15.31.0: any payment asset (XRP, CAPPZ, USD-tokenZ/1); issued tokens add trust-line and issuer checks.
  const currency = i.currency === undefined ? undefined : currencyOf(String(i.currency));
  if (i.currency !== undefined && !currency) throw new Error('currency must name a payment asset: XRP, CAPPZ, USD-tokenZ/1 (RLUSD) or USD.');
  const amount = i.amount === undefined ? undefined : Number(i.amount);
  if (amount !== undefined && !(amount >= 0)) throw new Error('amount must be a number in the asset.');
  return { network, ...(address ? { address } : {}), ...(party ? { party } : {}), ...(amountXrp !== undefined ? { amountXrp } : {}), ...(i.payer ? { payer: String(i.payer) } : {}), ...(i.escrowLegs ? { escrowLegs: Math.max(1, Math.floor(Number(i.escrowLegs))) } : {}), ...(currency ? { currency } : {}), ...(amount !== undefined ? { amount } : {}) };
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


/* ── v15-32-00: stage evaluator, listing drafter, subcontract scout ───────────────────────────────────── */

export type AgentName = 'evaluate' | 'draft' | 'scout';
export const AGENT_NAMES: AgentName[] = ['evaluate', 'draft', 'scout'];
const agentPayTo = (env: Env, network: Net) => (network === 'mainnet' ? env.AGENT_PAY_TO_MAINNET || env.PAY_TO_MAINNET : env.AGENT_PAY_TO_TESTNET || env.PAY_TO_TESTNET);
export const agentPrice = (env: Env, name: AgentName) => Number((name === 'evaluate' ? env.PRICE_EVALUATE_XRP : name === 'draft' ? env.PRICE_DRAFT_XRP : env.PRICE_SCOUT_XRP) || (name === 'draft' ? '0.02' : '0.05'));
const maxBytes = (env: Env) => Math.min(MAX_DELIVERABLE_BYTES, Number(env.MAX_DELIVERABLE_BYTES || 512_000));
const base64ToBytes = (b64: string) => { const bin = atob(b64.replace(/\s+/g, '')); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };

/** The evaluator's request: the job input (stored) is ids and hashes only; the file travels beside it and is never stored. */
export function evaluateInput(input: unknown): { contractId: string; milestone?: number; acceptance?: unknown } {
  const i = (typeof input === 'object' && input ? input : {}) as Record<string, unknown>;
  if (typeof i.contractId !== 'string' || !/^ct-[A-Za-z0-9-]{1,64}$/.test(i.contractId)) throw new Error('Send {"input": {"contractId": "ct-…", "milestone": 0, "acceptance"?: {…}}, "file": "<base64 of the delivered file>"}.');
  if (i.milestone !== undefined && !(Number.isInteger(i.milestone) && (i.milestone as number) >= 0)) throw new Error('milestone is a stage index (0, 1, …).');
  return { contractId: i.contractId, ...(i.milestone !== undefined ? { milestone: i.milestone as number } : {}), ...(i.acceptance !== undefined ? { acceptance: i.acceptance } : {}) };
}

export function draftInput(input: unknown): { text: string; intent?: 'sell' | 'ask'; region?: string } {
  const i = (typeof input === 'string' ? { text: input } : typeof input === 'object' && input ? input : {}) as Record<string, unknown>;
  const text = typeof i.text === 'string' ? i.text.trim() : '';
  if (!text) throw new Error('Send {"input": {"text": "what you sell or need, in your own words", "intent"?: "sell" | "ask", "region"?: "TX"}}.');
  if (text.length > MAX_DRAFT_TEXT) throw new Error(`Keep the text under ${MAX_DRAFT_TEXT} characters.`);
  if (i.intent !== undefined && i.intent !== 'sell' && i.intent !== 'ask') throw new Error('intent is "sell" or "ask".');
  if (i.region !== undefined && !/^[A-Z]{2}$/.test(String(i.region))) throw new Error('region is a two-letter US state code.');
  return { text, ...(i.intent ? { intent: i.intent as 'sell' | 'ask' } : {}), ...(i.region ? { region: String(i.region) } : {}) };
}

export function scoutInput(input: unknown): { contractId: string; budgetShare?: number; need?: string } {
  const i = (typeof input === 'object' && input ? input : {}) as Record<string, unknown>;
  if (typeof i.contractId !== 'string' || !/^ct-[A-Za-z0-9-]{1,64}$/.test(i.contractId)) throw new Error('Send {"input": {"contractId": "ct-…", "budgetShare"?: 0.5, "need"?: "what you want help with"}}.');
  const b = i.budgetShare === undefined ? undefined : Number(i.budgetShare);
  if (b !== undefined && !(b > 0 && b <= 1)) throw new Error('budgetShare is a fraction of what is left to subcontract, above 0 and at most 1.');
  const need = i.need === undefined ? undefined : String(i.need).slice(0, 500);
  return { contractId: i.contractId, ...(b !== undefined ? { budgetShare: b } : {}), ...(need ? { need } : {}) };
}

const AGENT_TEXT: Record<AgentName, { name: string; description: (env: Env) => string; howToUse: string }> = {
  evaluate: {
    name: 'CAPPZ stage evaluator',
    description: (env) => `Before a stage is accepted or paid: send the delivered file and the contract id. It checks the file is the seller's published evidence (SHA-256), then every acceptance criterion agreed for the milestone — rule criteria by code anyone can re-run, yes/no rubric questions by ${modelPorts(env).judge ? `a model (${modelPorts(env).model}) that must quote the file` : 'a person (no model configured)'} — and returns a signed pass / fail / needs-human verdict. The file is not stored. A named evaluator can then accept with it; the buyer still pays. Rules: github.com/CAPPZ-ai/cappz-sdk/blob/main/src/lib/marketplace/stageEvaluation.ts`,
    howToUse: 'cappz-market evaluate <contract> --file <deliverable> — or POST /jobs {"input": {"contractId": "ct-…"}, "file": "<base64>"} → pay the stage shown → GET /jobs/<id>/stages/0/result',
  },
  draft: {
    name: 'CAPPZ listing drafter',
    description: (env) => `Describe what you sell or need in your own words; get a checked draft and the exact cappz-market sell or ask command, with acceptance criteria when you described the result. Category, unit, kind and region are checked against the catalog; any number not in your text is left out and asked for. Nothing is published. Model: ${modelPorts(env).model}. Rules: github.com/CAPPZ-ai/cappz-sdk/blob/main/src/lib/marketplace/listingDraft.ts`,
    howToUse: 'cappz-market draft "what you sell or need" — or POST /jobs {"input": {"text": "…"}} → pay → GET /jobs/<id>/stages/0/result',
  },
  scout: {
    name: 'CAPPZ subcontract scout',
    description: (env) => `For a contract you sell on: which parts to subcontract, who on the market could do them (search plus replayed reputation, never the buyer or you), and a ready cappz-market subcontract command for each, within what is unreleased and serving open milestones only. Planned by ${modelPorts(env).planner ? `a model (${modelPorts(env).model}), checked by the marketplace rules` : 'the marketplace rules (one package per open milestone)'}. Nothing is formed. Rules: github.com/CAPPZ-ai/cappz-sdk/blob/main/src/lib/marketplace/subcontractScout.ts`,
    howToUse: 'cappz-market scout <contract> — or POST /jobs {"input": {"contractId": "ct-…"}} → pay → GET /jobs/<id>/stages/0/result',
  },
};

/** One of the v15-32-00 paid agents; `evaluate` gets the request's file through `file` (absent on later requests: never stored). */
export function namedAgent(env: Env, network: Net, name: AgentName, file?: { target: EvaluationTarget; bytes: Uint8Array }) {
  const ports = modelPorts(env);
  return createPaidAgent({
    offer: { name: `${AGENT_TEXT[name].name} (${network})`, description: AGENT_TEXT[name].description(env), payTo: agentPayTo(env, network), network, currency: 'XRP', price: agentPrice(env, name), stages: SCHEDULE_PRESETS['on-completion'].stages },
    store: d1JobStore(env.DB, `${network}:${name}`),
    ledger: rpcLedgerReader,
    work: async ({ input }) => {
      const now = new Date().toISOString();
      if (name === 'evaluate') {
        if (!file) throw new Error('The file is not kept between requests: open a new job with the file to evaluate it.');
        const verdict = await evaluateDeliverable(file.target, file.bytes, { network, now, judge: ports.judge });
        return JSON.stringify(signVerdict(verdict, env.CHECK_SIGNING_SEED), null, 2);
      }
      if (name === 'draft') {
        const i = draftInput(input);
        if (!ports.drafter) throw new Error('The listing drafter has no model configured.');
        return JSON.stringify({ kind: 'cappz-listing-draft', model: ports.model, ...normalizeDraft(await ports.drafter.draft(i.text, i), i.text, { now, region: i.region ?? null, ...(i.intent ? { intent: i.intent } : {}) }) }, null, 2);
      }
      const i = scoutInput(input);
      const state = await marketState(env, network, true);
      if (!state) throw new Error('The marketplace log could not be read just now; the scout is retried.');
      const c = state.contracts.find((k) => k.contractId === i.contractId);
      let packages = null; let plannedBy = 'rules'; const extra: string[] = [];
      if (ports.planner && c) {
        try { packages = await ports.planner.plan({ title: c.title, categoryId: c.categoryId, unit: c.unit, quantity: c.quantity, milestones: c.milestoneStates.map((m) => ({ index: m.index, label: c.milestones[m.index].label, open: m.state !== 'released' })), need: i.need ?? null }); plannedBy = ports.model; }
        catch (e) { extra.push(`The model could not plan (${(e as Error).message}); planned by the rules instead.`); }
      }
      const report = scoutSubcontracts(state, i.contractId, { network, now, packages, plannedBy, ...(i.budgetShare !== undefined ? { budgetShare: i.budgetShare } : {}), need: i.need ?? null });
      return JSON.stringify({ kind: 'cappz-subcontract-scout', ...report, notes: [...extra, ...report.notes] }, null, 2);
    },
  });
}

/** Open a job for a named agent after every free check passed (nothing is charged for a request that cannot be done). */
export async function openNamedJob(env: Env, network: Net, name: AgentName, req: Request): Promise<{ code: number; body: unknown }> {
  if (name === 'evaluate') {
    const raw = await readBounded(req, Math.ceil(maxBytes(env) * 1.37) + 64 * 1024);
    if (!raw) return { code: 413, body: { error: `Deliverables up to ${maxBytes(env)} bytes.` } };
    let body: { input?: unknown; file?: unknown } = {};
    try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { throw new Error('Send JSON: {"input": {"contractId": "ct-…"}, "file": "<base64>"}.'); }
    const input = evaluateInput(body.input);
    if (typeof body.file !== 'string' || !body.file) throw new Error('Send the delivered file as base64 in "file" (it is hashed, checked and not stored).');
    let bytes: Uint8Array; try { bytes = base64ToBytes(body.file); } catch { throw new Error('"file" is not valid base64.'); }
    if (bytes.length > maxBytes(env)) return { code: 413, body: { error: `Deliverables up to ${maxBytes(env)} bytes.` } };
    const state = await marketState(env, network, true);
    if (!state) return { code: 503, body: { error: 'The marketplace log could not be read just now; nothing was opened or charged. Retry shortly.' } };
    const target = evaluationTarget(state, { contractId: input.contractId, ...(input.milestone !== undefined ? { milestone: input.milestone } : {}), deliverableSha256: deliverableSha256Of(bytes), ...(input.acceptance !== undefined ? { acceptance: input.acceptance } : {}) });
    const agent = namedAgent(env, network, 'evaluate', { target, bytes });
    const opened = await agent.openJob({ contractId: target.contract.contractId, milestone: target.milestone, deliverableSha256: target.deliverableSha256, criteriaSource: target.source, specSha256: acceptanceHash(target.spec) });
    const done = await agent.work(opened.job.jobId);
    return { code: 201, body: { job: done, pay: (await agent.job(opened.job.jobId))?.pay ?? opened.pay, criteria: target.source, notes: target.notes } };
  }
  const body = (await req.json().catch(() => ({}))) as { input?: unknown };
  if (name === 'draft') { draftInput(body.input); if (!modelPorts(env).drafter) return { code: 503, body: { error: 'The listing drafter has no model configured on this service; nothing was opened or charged.' } }; }
  if (name === 'scout') {
    const i = scoutInput(body.input); const state = await marketState(env, network, true);
    if (!state) return { code: 503, body: { error: 'The marketplace log could not be read just now; nothing was opened or charged. Retry shortly.' } };
    const c = state.contracts.find((k) => k.contractId === i.contractId);
    if (!c) throw new Error(`No contract ${i.contractId} on the ${network} market.`);
    if (c.state === 'completed' || c.state === 'cancelled') throw new Error(`${c.contractId} is ${c.state}; there is nothing left to subcontract.`);
  }
  const agent = namedAgent(env, network, name);
  const opened = await agent.openJob(body.input);
  const done = await agent.work(opened.job.jobId);
  return { code: 201, body: { job: done, pay: (await agent.job(opened.job.jobId))?.pay ?? opened.pay } };
}

/**
 * Deal-bound signing approval (free): replay the public log now (never a cached copy, so a dispute raised a moment
 * ago counts) and approve this exact unsigned escrow transaction, or say why not. Read-only: nothing is stored.
 */
export async function authorize(body: unknown, network: Net, state: MarketState | null, seedHex: string, now = new Date().toISOString(), requestAuth?: RequestAuth) {
  const b = (typeof body === 'object' && body ? body : {}) as Record<string, unknown>;
  const tx = b.tx && typeof b.tx === 'object' ? b.tx as Record<string, unknown> : null;
  const milestone = Number(b.milestone);
  if (!tx || typeof b.contractId !== 'string' || !Number.isInteger(milestone) || milestone < 0) throw new Error('Send {"contractId": "ct-…", "milestone": 0, "tx": {…unsigned, autofilled…}} and, for agents above their threshold, the grantor’s "coSignature".');
  if (!state) return { code: 503, body: { approved: false, reasons: [{ code: 'market-unreadable', message: 'The marketplace log could not be read just now; nothing is approved. Retry shortly.' }] } };
  const d = await evaluateSigningIntent(state, { network, contractId: b.contractId, milestone, tx, ...(b.coSignature && typeof b.coSignature === 'object' ? { coSignature: b.coSignature as never } : {}), ...(requestAuth ? { requestAuth } : {}) }, now);
  return d.approved ? { code: 200, body: { approved: true, ...signApproval(d.approval, seedHex) } } : { code: 200, body: { ...d, ...(requestAuth ? { requestAuth } : {}) } };
}

/** One request verifier (replay cache) per network per isolate. Nonces are per isolate: a replayed /authorize only gets the same approval of the same single-use ledger transaction again. */
const verifiers = new Map<Net, AgentRequestVerifier>();
const verifierFor = (n: Net) => { let v = verifiers.get(n); if (!v) { v = createAgentRequestVerifier(); verifiers.set(n, v); } return v; };

const FREE_SKILLS = (origin: string, nets: readonly Net[]): AgentSkill[] => [
  ...nets.map((n) => ({ id: `signing-approval-${n}`, name: `Deal-bound signing approval (${n})`, description: `Free: POST ${origin}/${n}/authorize {"contractId","milestone","tx"} → a signed approval of that exact unsigned escrow transaction, or the reasons it is refused. Sign the request (RFC 9421) with your declared key; required when your mandate binds one.`, tags: ['free', 'approval', `xrpl-${n}`], inputModes: ['application/json'], outputModes: ['application/json'] })),
  ...nets.map((n) => ({ id: `reputation-${n}`, name: `Reputation attestation (${n})`, description: `Free: GET ${origin}/${n}/reputation/<partyId> → a signed snapshot of the party's ledger facts, marketplace history and standing, kept separate.`, tags: ['free', 'reputation', `xrpl-${n}`], inputModes: ['application/json'], outputModes: ['application/json'] })),
];

/** The signed A2A card: the whole service (top level) or one network's paid check agent. */
export function serviceCard(env: Env, origin: string, network: Net | null) {
  const nets = network ? [network] : NETS;
  const paid = network ? agentFor(env, network).card() : undefined;
  const card = buildAgentCard({
    url: network ? `${origin}/${network}` : origin, version: SERVICE_VERSION, ...(paid ? { paid } : { manifest: { name: 'cappz-check', version: SERVICE_VERSION, network: 'xrpl', operations: [] } }),
    name: network ? undefined : 'CAPPZ check service', description: network ? undefined : 'Counterparty checks, stage evaluations, listing drafts and subcontract scouting (paid, per network); deal-bound signing approvals and reputation attestations (free). Reports, verdicts, approvals and attestations are signed with Ed25519.',
    provider: { organization: 'CAPPZ', url: 'https://cappz.ai' }, documentationUrl: 'https://github.com/CAPPZ-ai/cappz-sdk/tree/main/packages/cappz-check-worker',
    extraSkills: [...(network ? [] : NETS.map((n) => ({ id: `counterparty-check-${n}`, name: `CAPPZ counterparty check (${n})`, description: `Paid per check: ${origin}/${n}/.well-known/agent-card.json describes it.`, tags: ['paid', `xrpl-${n}`] }))),
      ...nets.flatMap((n) => AGENT_NAMES.map((a) => ({ id: `${a}-${n}`, name: `${AGENT_TEXT[a].name} (${n})`, description: `Paid, ${agentPrice(env, a)} XRP per job: ${origin}/${n}/${a}/agent. ${AGENT_TEXT[a].howToUse}`, tags: ['paid', a, `xrpl-${n}`], inputModes: ['application/json'], outputModes: ['application/json'] }))),
      ...FREE_SKILLS(origin, nets)],
    requestSigning: 'optional',
    signingKeyTrust: 'This card, reports, approvals and attestations are signed by the key published in the marketplace discovery document (/.well-known/cappz-market.json, services.counterpartyCheck.publicKey) and at GET /key: trust state published-key. No KeyZ wallet declaration names it yet.',
  });
  return signAgentCard(card, env.CHECK_SIGNING_SEED);
}

const JOB = /^\/(mainnet|testnet)\/jobs\/(job-[0-9a-f]{16})(\/payments|\/retry|\/stages\/(\d+)\/result)?$/;

export default {
  async fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      const publicKey = hex(ed25519.getPublicKey(unhex(env.CHECK_SIGNING_SEED)));
      const wellKnown = /^(?:\/(mainnet|testnet))?\/\.well-known\/agent-card\.json$/.exec(url.pathname);
      if (req.method === 'GET' && wellKnown) return json(200, serviceCard(env, url.origin, (wellKnown[1] as Net | undefined) ?? null));
      const repu = /^\/(mainnet|testnet)\/reputation\/([A-Za-z0-9._-]{1,64})$/.exec(url.pathname);
      if (repu) {
        if (req.method !== 'GET') return json(405, { error: 'GET /<network>/reputation/<partyId>' });
        const network = repu[1] as Net; const state = await marketState(env, network);
        if (!state) return json(503, { error: 'The marketplace log could not be read just now; nothing is attested. Retry shortly.' });
        const acct = state.parties.get(repu[2])?.xrplAccount;
        const ledger = acct ? await readAccountFacts(network, acct).catch((e: Error) => ({ address: acct, activated: null, balanceXrp: null, ownedObjects: null, flags: null, regularKey: null, firstSeen: null, lastActive: null, error: e.message })) : null;
        const { ledgerIndex: _l, reserveBase: _b, reserveInc: _i, ...facts } = (ledger ?? {}) as Record<string, unknown>;
        return json(200, signReputation(buildReputationAttestation(state, repu[2], network, new Date().toISOString(), { ledger: ledger ? facts as never : null }), env.CHECK_SIGNING_SEED));
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/key')) {
        return json(200, { service: 'CAPPZ counterparty check', price: `${env.PRICE_XRP || '0.01'} XRP per check`, networks: Object.fromEntries(NETS.map((n) => [n, `${url.origin}/${n}`])), signature: { alg: 'Ed25519', publicKey }, howToUse: 'cappz-market check <address|party> [--network mainnet] — or POST /<network>/jobs {"input": {"address": "r…"}} → pay the stage shown → GET /<network>/jobs/<id>/stages/0/result', approvals: 'Free: POST /<network>/authorize {"contractId", "milestone", "tx"} → a signed approval of that exact unsigned escrow transaction or token stage payment, or the reasons it is refused. Rules: https://github.com/CAPPZ-ai/cappz-sdk/blob/main/src/lib/marketplace/signingApproval.ts', reputation: 'Free: GET /<network>/reputation/<partyId> → a signed reputation attestation.', agentCard: `${url.origin}/.well-known/agent-card.json`, rules: 'https://github.com/CAPPZ-ai/cappz-sdk/blob/main/src/lib/marketplace/counterpartyCheck.ts',
          agents: Object.fromEntries(AGENT_NAMES.map((a) => [a, { name: AGENT_TEXT[a].name, price: `${agentPrice(env, a)} XRP per job`, networks: Object.fromEntries(NETS.map((n) => [n, `${url.origin}/${n}/${a}`])), howToUse: AGENT_TEXT[a].howToUse }])) });
      }
      // v15-32-00 named agents: /<net>/<agent>[/agent|/health|/jobs|/jobs/<id>[/payments|/retry|/stages/<n>/result]]
      const na = /^\/(mainnet|testnet)\/(evaluate|draft|scout)(\/agent|\/health|\/jobs|\/jobs\/(job-[0-9a-f]{16})(\/payments|\/retry|\/stages\/(\d+)\/result)?)?$/.exec(url.pathname);
      if (na) {
        const network = na[1] as Net; const name = na[2] as AgentName; const sub = na[3]; const id = na[4]; const tail = na[5]; const stageN = na[6];
        const agent = namedAgent(env, network, name);
        if (req.method === 'GET' && (!sub || sub === '/agent')) return json(200, { ...agent.card(), publicKey, model: name === 'evaluate' ? (modelPorts(env).judge?.model ?? null) : modelPorts(env).model, howToUse: AGENT_TEXT[name].howToUse });
        if (req.method === 'GET' && sub === '/health') return json(200, { ok: name !== 'draft' || !!modelPorts(env).drafter, network, agent: name, payTo: agent.offer.payTo, price: agent.offer.price });
        if (req.method === 'POST' && sub === '/jobs') { const r = await openNamedJob(env, network, name, req); return json(r.code, r.body); }
        if (id) {
          if (req.method === 'GET' && !tail) { const j = await agent.job(id); return j ? json(200, j) : json(404, { error: 'Unknown job.' }); }
          if (req.method === 'POST' && tail === '/payments') { const b = (await req.json().catch(() => ({}))) as { txHash?: string }; return json(200, await agent.claimPayment(id, String(b.txHash ?? ''))); }
          if (req.method === 'POST' && tail === '/retry') { const j = await agent.retry(id); if (j && name !== 'evaluate') ctx.waitUntil(agent.work(id)); return json(200, j); }
          if (req.method === 'GET' && stageN !== undefined) {
            const r = await agent.result(id, Number(stageN));
            if (r.state === 'released') return new Response(r.bytes as unknown as BodyInit, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'x-result-sha256': r.hash, ...CORS } });
            if (r.state === 'payment-required') return json(402, { message: 'Ready — pay this stage to receive it.', resultSha256: r.hash, pay: r.pay });
            return json(409, { message: 'Not ready yet.', job: r.job });
          }
        }
        return json(405, { error: 'Method not allowed.' });
      }
      const top = /^\/(mainnet|testnet)(\/agent|\/health|\/jobs|\/authorize)?$/.exec(url.pathname);
      if (top && top[2] === '/authorize') {
        if (req.method !== 'POST') return json(405, { error: 'POST {"contractId", "milestone", "tx"} to get a signing approval.' });
        const network = top[1] as Net;
        // The raw bytes: the signature covers their Content-Digest.
        const bytes = await readBounded(req, 256 * 1024);
        if (!bytes) return json(413, { error: 'Request body over 256 KB.' });
        let body: unknown = {};
        try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { body = {}; }
        const state = await marketState(env, network, true);
        const requestAuth = state ? await verifierFor(network).verify(state, req, bytes) : undefined;
        const r = await authorize(body, network, state, env.CHECK_SIGNING_SEED, new Date().toISOString(), requestAuth);
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
