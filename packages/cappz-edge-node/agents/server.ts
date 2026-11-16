/**
 * Paid agents for a CAPPZ edge node (15.43.0), on the SDK's paid-agent kit.
 *
 *   /agents/draw       Fair draw (15.47.0): pay first; the node then signs a commitment to the
 *                      list (its SHA-256) and a draw time, publishes it on its public log, and at
 *                      the draw time picks winners from the hash of the first XRPL ledger closed at
 *                      or after it. Anyone can recompute the winners. One payment; the result is free.
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
 * and, for the draw agent (15.47.0, draw.ts):
 *   GET <base>/log[?from=<seq>]           the public, hash-chained log of every commitment
 *   GET <base>/commitments/<jobId>        one signed commitment (no entries)
 *   GET <base>/draws/<jobId>              a public draw's result (when the buyer asked for public)
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
 *
 * 15.44.0 — the signer is vouched for by a wallet, not by the website's certificate.
 * Before, a buyer learned the signing key from the HTTPS page (a public-CA certificate
 * for a DNS name), so whoever controlled that name could serve another key. With
 * CAPPZ_NODE_KEY_DECLARATIONS (a key-declarations.json; tools/declare-node-key.ts makes
 * it) a wallet's secp256k1 KeyDeclaration names the node key for purpose `signing`:
 *   - every record signs in payload.signerDeclaration (the declaration's hash);
 *   - each result carries the declarations and revocations it needs; verify.mjs checks
 *     the wallet signature offline and prints the wallet's XRPL address;
 *   - GET /agents/key-declarations.json serves the current evidence.
 * The file (and key-revocations.json beside it) is re-read every minute. Set, but with no
 * valid unrevoked declaration of this key: the agents refuse to start or to sign.
 *
 * 15.45.0 — or the payout account declares the key ON THE LEDGER, signed in its own wallet
 * (Xaman or any other; no seed on this machine): the same file then holds an anchor
 * {"v":"xrpl","network","txHash"} that tools/declare-node-key.ts --ledger writes. The
 * agents read the declaration and the account's later revocations from the XRP Ledger
 * (ledgerKeyz.ts; checked every 5 minutes, revocations included) and sign in
 * payload.signerDeclaration = "xrpl:<network>:<hash>", which verify.mjs looks up itself.
 *
 * 15.47.0 — no file needed: the agents find those on-ledger declarations themselves, in the
 * payout account's own history (CAPPZ_KEYZ_ACCOUNT, default CAPPZ_AGENT_PAYTO, on CAPPZ_KEYZ_NETWORK,
 * default mainnet; re-read hourly, so a renewal approved in Xaman is picked up with no copying).
 * Once the account has declared this key, signing pauses whenever no declaration is valid
 * (expired or revoked), as with a file. CAPPZ_KEYZ_DISCOVER=0 turns discovery off.
 */
import {
  createPaidAgent, defineAgentOffer, MAX_AUTO_RETRIES, SCHEDULE_PRESETS, xrplLedgerReader,
  type JobEvent, type JobStore, type PaidAgent, type XrplNetwork,
} from '../../../src/lib/agentKit/paidAgent.ts';
import { signEdgeTx, sha256HexOf } from '../../../src/lib/functions/edgeJobs.ts';
import { loadNodeKey } from '../signingKey.ts';
import { declarationHash, evaluateKey, type KeyDeclaration, type KeyRevocation } from '../../../src/lib/identity/keyDeclaration.ts';
import { deriveAddress } from 'xrpl';
import { anchorRef, checkAnchor, discoverLedgerAnchors, isLedgerAnchor, xrplRpc, type LedgerAnchor } from './ledgerKeyz.ts';
import { DRAW_RULE, drawInputProblem, drawPicks, drawSeed, effectiveDrawAt, entriesHash, findSeedLedger, rpcDrawLedgerReader, type DrawInput } from './draw.ts';
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
const DRAW_PRICE = Number(env('CAPPZ_DRAW_PRICE_XRP', '0.1'));
const DRAW_MAX_DAYS = Number(env('CAPPZ_DRAW_MAX_DAYS', '30'));
const DRAW_MIN_LEAD_MS = Number(env('CAPPZ_DRAW_MIN_LEAD_SECONDS', '120')) * 1000;
const DRAW_MAX_BODY = 3 * 1024 * 1024;
const PRINCIPLE = "m/44'/144'/100'/principles/cope/v1#local-first";
const DAY = 86_400_000;

if (!PAY_TO) { console.error('[agents] CAPPZ_AGENT_PAYTO is not set (the public XRPL address buyers pay)'); Deno.exit(1); }
if (!DATA) { console.error('[agents] CAPPZ_AGENT_DATA is not set (a writable folder for jobs and results, one per network)'); Deno.exit(1); }
const key = await loadNodeKey();
if (!key) { console.error('[agents] needs CAPPZ_NODE_KEY / CAPPZ_NODE_PUB (node.env): receipts are signed with the node key'); Deno.exit(1); }

// ─── Who vouches for the node key: wallet-signed KeyZ declarations (15.44.0) ──

const DECL_PATH = env('CAPPZ_NODE_KEY_DECLARATIONS');
const DISCOVER = env('CAPPZ_KEYZ_DISCOVER', '1') !== '0';
const KEYZ_ACCOUNT = env('CAPPZ_KEYZ_ACCOUNT', PAY_TO)!;
const KEYZ_NETWORK = env('CAPPZ_KEYZ_NETWORK', 'mainnet') as XrplNetwork;
const DISCOVER_EVERY_MS = 60 * 60_000;
/** Declarations of this key found in the payout account's ledger history (15.47.0). */
let discovered: LedgerAnchor[] = [];
let discoveredAt = 0;
async function discover(): Promise<void> {
  if (!DISCOVER || Date.now() - discoveredAt < DISCOVER_EVERY_MS) return;
  try {
    const found = await discoverLedgerAnchors(KEYZ_NETWORK, KEYZ_ACCOUNT, key!.publicKeyHex, 'signing');
    if (found.map((a) => a.txHash).join() !== discovered.map((a) => a.txHash).join()) console.log(`[agents] ${found.length} on-ledger declaration(s) of the node key by ${KEYZ_ACCOUNT} (${KEYZ_NETWORK})`);
    discovered = found; discoveredAt = Date.now();
  } catch (e) { console.warn(`[agents] could not read ${KEYZ_ACCOUNT}'s declarations from the XRP Ledger (${(e as Error).message}); keeping the last answer`); }
}
/** Fail closed when a file is configured, or once the account has declared this key on the ledger. */
const mustBeDeclared = () => !!DECL_PATH || discovered.length > 0;
const REVOKE_PATH = DECL_PATH ? DECL_PATH.replace(/[^\\/]*$/, 'key-revocations.json') : undefined;
/** A wallet-signed declaration (declaration set) or an on-ledger one (anchor set); hash is what records sign in. */
interface Vouch { declaration?: KeyDeclaration; anchor?: LedgerAnchor; hash: string; wallet: string | null; address: string; expiresAt: string }
const LEDGER_RECHECK_MS = 5 * 60_000;
/** Last ledger answer per anchor, so the minute-by-minute reload asks the ledger at most every 5 minutes. */
const ledgerChecks = new Map<string, { at: number; result: Awaited<ReturnType<typeof checkAnchor>> }>();
let vouch: Vouch | null = null;
let revocations: KeyRevocation[] = [];
/** Declarations a result may reference (by hash), kept so a 30-day bundle can carry every one its records name. */
const seenDeclarations = new Map<string, KeyDeclaration>();

async function readEvidence(path: string | undefined, required: boolean): Promise<unknown[]> {
  if (!path) return [];
  try {
    const v = JSON.parse(await Deno.readTextFile(path));
    return Array.isArray(v) ? v : Array.isArray(v?.declarations) ? v.declarations : [v];
  } catch (e) { if (!required && e instanceof Deno.errors.NotFound) return []; throw e; }
}
/** The longest-lived valid, unrevoked declaration of this node key for `signing`; null (with the reason) when there is none. */
async function loadVouch(): Promise<{ vouch: Vouch | null; why: string }> {
  const all = await readEvidence(DECL_PATH, true);
  const decls = all.filter((d): d is KeyDeclaration => (d as KeyDeclaration)?.v === 2);
  const fileAnchors = all.filter(isLedgerAnchor);
  const anchors = [...fileAnchors, ...discovered.filter((d) => !fileAnchors.some((a) => a.txHash.toUpperCase() === d.txHash))];
  const revs = (await readEvidence(REVOKE_PATH, false)) as KeyRevocation[];
  let best: Vouch | null = null;
  let why = `no declaration ${DECL_PATH ? `in ${DECL_PATH} ` : ''}${DISCOVER ? `or on the ${KEYZ_NETWORK} ledger by ${KEYZ_ACCOUNT} ` : ''}names node key ${key!.publicKeyHex.slice(0, 16)}… for signing`;
  for (const a of anchors) {
    const ref = anchorRef(a.network, a.txHash);
    let c = ledgerChecks.get(ref);
    if (!c || Date.now() - c.at > LEDGER_RECHECK_MS) {
      // A ledger that cannot be reached keeps the last answer (if any); with none, the error stops the start.
      try { c = { at: Date.now(), result: await checkAnchor(a, key!.publicKeyHex, 'signing') }; ledgerChecks.set(ref, c); }
      catch (e) { if (!c) throw new Error(`the XRP Ledger (${a.network}) could not be read: ${(e as Error).message}`); console.warn(`[agents] ledger check of ${ref.slice(0, 30)}… failed (${(e as Error).message}); keeping the last answer`); }
    }
    const t = c.result;
    if (t.state !== 'declared') { why = `on-ledger declaration ${a.txHash.slice(0, 16)}… (${a.network}): ${t.because}`; continue; }
    if (best && Date.parse(best.expiresAt) >= Date.parse(t.until)) continue;
    best = { anchor: a, hash: ref, wallet: null, address: t.account, expiresAt: t.until };
  }
  for (const d of decls) {
    if (d.publicKey?.toLowerCase() !== key!.publicKeyHex || d.purpose !== 'signing' || d.algorithm !== 'ed25519') continue;
    const t = await evaluateKey(d.walletAddress, key!.publicKeyHex, 'signing', { declarations: [d], revocations: revs });
    if (t.state !== 'declared') { why = `declaration by ${d.walletAddress.slice(0, 16)}…: ${t.because}`; continue; }
    if (best && Date.parse(best.expiresAt) >= Date.parse(d.expiresAt)) continue;
    best = { declaration: d, hash: await declarationHash(d), wallet: d.walletAddress.toLowerCase(), address: deriveAddress(d.walletAddress.toUpperCase()), expiresAt: d.expiresAt };
  }
  revocations = revs;
  if (best?.declaration) seenDeclarations.set(best.hash, best.declaration);
  return { vouch: best, why };
}
if (DECL_PATH || DISCOVER) {
  await discover();
  const first = await loadVouch();
  if (!first.vouch && DECL_PATH) { console.error(`[agents] CAPPZ_NODE_KEY_DECLARATIONS is set but ${first.why}; not starting (unset it to run without a wallet declaration)`); Deno.exit(1); }
  if (!first.vouch && mustBeDeclared()) console.warn(`[agents] ${first.why}: signing paused until a valid declaration is in place (renew it in Xaman: declare-node-key)`);
  if (!first.vouch && !mustBeDeclared()) console.log(`[agents] no wallet declaration of the node key yet (${first.why}); records are signed undeclared. Declare it once in Xaman: declare-node-key.ps1`);
  vouch = first.vouch;
  if (vouch) console.log(`[agents] node key declared ${vouch.anchor ? `on the XRP Ledger (${vouch.anchor.network}, tx ${vouch.anchor.txHash.slice(0, 16)}…) ` : ''}by wallet ${vouch.address} until ${vouch.expiresAt}${vouch.address === PAY_TO ? ' (the payout account)' : ` (not the payout account ${PAY_TO})`}`);
  setInterval(async () => {
    try {
      await discover();
      const next = await loadVouch();
      if (next.vouch?.hash !== vouch?.hash) console.log(next.vouch ? `[agents] signing declaration now ${next.vouch.hash.slice(0, 16)}… until ${next.vouch.expiresAt}` : `[agents] ${next.why}: signing paused until a valid declaration is in place`);
      vouch = next.vouch;
      if (vouch && Date.parse(vouch.expiresAt) - Date.now() < 14 * DAY) console.warn(`[agents] the node key's declaration expires ${vouch.expiresAt}: renew it (declare-node-key.ps1, or tools/declare-node-key.ts --ledger)`);
    } catch (e) { console.warn(`[agents] declarations unreadable (${(e as Error).message}); keeping the last good declaration`); }
  }, 60_000);
}
/** What a result needs to prove who signed it: the declarations its records name, and the revocations known now. */
const evidenceFor = (hashes: Iterable<unknown>) => {
  const named = [...new Set(hashes)].map(String);
  const declarations = named.map((h) => seenDeclarations.get(h)).filter(Boolean);
  // On-ledger declarations need no copy: verify.mjs reads them (and any revocation) from the ledger by their reference.
  const onLedger = named.filter((h) => h.startsWith('xrpl:'));
  return { ...(declarations.length ? { declarations, revocations } : {}), ...(onLedger.length ? { ledgerDeclarations: onLedger } : {}) };
};

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

const signed = (eventType: string, targetAddress: string, payload: Record<string, unknown>) => {
  // Fail closed: with declarations configured, never sign a record no wallet vouches for right now.
  if (mustBeDeclared() && !vouch) throw new Error('The node key has no valid wallet declaration right now; signing is paused.');
  if (vouch && Date.now() >= Date.parse(vouch.expiresAt)) throw new Error(`The node key's declaration expired ${vouch.expiresAt}; signing is paused until it is renewed.`);
  // `network` is signed in: both instances share the node key, so a free testnet record must never pass for a paid mainnet one.
  return signEdgeTx({ txId: `${eventType}-${crypto.randomUUID()}`, timestamp: new Date().toISOString(), eventType, sourceAddress: POW, targetAddress, payload: { ...payload, network: NETWORK, governingPrinciple: PRINCIPLE, ...(vouch ? { signerDeclaration: vouch.hash } : {}) } }, key);
};

const VERIFY_HOW = `node verify.mjs <this file> <payTo r-address> (${PUBLIC_BASE}/verify.mjs), or verifyEdgeTx(receipt) from @cappz/sdk (src/lib/functions/edgeJobs.ts): recomputes txHash over the canonical TX and checks the Ed25519 signature against signerPublicKey. payload.signerDeclaration names who vouches for that key: the hash of a wallet-signed KeyDeclaration (in declarations), or xrpl:<network>:<tx hash> for a declaration on the XRP Ledger (verify.mjs reads it and any revocation from the ledger).`;

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
    return { receipt, ...evidenceFor([receipt.payload.signerDeclaration]), verify: VERIFY_HOW };
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
    const named = records.map((r) => (r as { payload?: { signerDeclaration?: string } }).payload?.signerDeclaration);
    return { bundle, records, ...evidenceFor([bundle.payload.signerDeclaration, ...named]), verify: VERIFY_HOW };
  },
});

// ─── Agent 3: fair draw (pay first; the signed result is free) ───────────────

const drawStore = await fileJobStore(`${DATA}/draw`);
await Deno.mkdir(`${DATA}/draw/public`, { recursive: true });
const COMMIT_LOG = `${DATA}/draw/commitments.jsonl`;
type Signed = Awaited<ReturnType<typeof signed>>;
/** Every commitment ever signed, oldest first: public, and each names the one before it (a hash chain). */
const commitments: Signed[] = [];
try { for (const l of (await Deno.readTextFile(COMMIT_LOG)).split('\n')) if (l.trim()) commitments.push(JSON.parse(l)); } catch (e) { onlyMissing(e); }
const commitmentOf = (jobId: string) => commitments.find((c) => (c.payload as { jobId?: string }).jobId === jobId) ?? null;
const drawLedger = rpcDrawLedgerReader((method, params) => xrplRpc(NETWORK, method, params));
/** Commitments are appended one at a time, so the chain never forks. */
let commitQueue: Promise<unknown> = Promise.resolve();
function commit(jobId: string, x: DrawInput, entriesSha256: string, count: number, winners: number): Promise<Signed> {
  const run = async () => {
    const existing = commitmentOf(jobId); if (existing) return existing;
    const after = await drawLedger.validated();
    const at = Date.now();
    const drawAt = effectiveDrawAt(x.drawAt, Math.max(at, Date.parse(after.closeTime)), DRAW_MIN_LEAD_MS);
    const prev = commitments.at(-1) ?? null;
    const c = await signed('DrawCommitted', `${POW}/draws/${jobId}`, {
      jobId, rule: DRAW_RULE, label: x.label ?? null, entriesSha256, count, winners, drawAt,
      ...(x.drawAt && x.drawAt !== drawAt ? { drawAtRequested: x.drawAt } : {}),
      afterLedger: after, seq: commitments.length, previousCommitment: prev?.txHash ?? null,
    });
    await Deno.writeTextFile(COMMIT_LOG, JSON.stringify(c) + '\n', { append: true });
    commitments.push(c);
    console.log(`[agents] draw ${jobId} committed: ${count} entries, ${winners} winner(s), draw at ${drawAt}`);
    return c;
  };
  const p = commitQueue.then(run, run); commitQueue = p.catch(() => null); return p;
}
const VERIFY_DRAW = `node verify.mjs <this file> <payTo r-address> (${PUBLIC_BASE}/verify.mjs): checks both signatures, that the commitment came before the draw time, reads the seed ledger and the one before it from public XRPL servers, and recomputes the winners (rule ${DRAW_RULE}, written out in ${PUBLIC_BASE}/draw/SKILL.md). For a list sent only as a hash, add --entries <list.txt or list.json>.`;

const draw = createPaidAgent({
  offer: defineAgentOffer({
    name: 'CAPPZ fair draw',
    description: `Pick winners from a list so nobody can steer the result, not even this node. Pay first; node ${key.publicKeyHex.slice(0, 16)}… then signs a commitment to your list's SHA-256 and a draw time and publishes it on its public log. At the draw time the winners come from the hash of the first XRP Ledger ledger closed at or after it, which nobody knew in advance. Anyone can recompute them.`,
    payTo: PAY_TO, network: NETWORK, currency: 'XRP', price: DRAW_PRICE,
    stages: [
      { label: 'Pay: list locked', kind: 'upfront', share: 1, deliverable: `A signed commitment to the list and draw time, on ${PUBLIC_BASE}/draw/log` },
      { label: 'Draw: signed winners', kind: 'completion', share: 0, deliverable: 'The signed draw: seed ledger, seed and winners, with the commitment (JSON). Nothing more to pay.' },
    ],
  }),
  store: drawStore,
  // Runs once the payment is recorded: commit (once), wait for the draw time, read the seed ledger, draw, sign.
  work: async ({ jobId, input }) => {
    const x = input as DrawInput;
    const entriesSha256 = x.entries ? await entriesHash(x.entries) : x.entriesSha256!.toLowerCase();
    const count = x.entries ? x.entries.length : x.count!;
    const winners = x.winners ?? 1;
    const c = await commit(jobId, x, entriesSha256, count, winners);
    const cp = c.payload as unknown as { drawAt: string; afterLedger: { index: number } };
    while (Date.now() < Date.parse(cp.drawAt)) await sleep(Math.min(DAY, Date.parse(cp.drawAt) - Date.now()));
    let found = await findSeedLedger(drawLedger, cp.drawAt, cp.afterLedger.index);
    for (let i = 0; !found; i++) {
      if (i > 450) throw new Error('No validated ledger reached the draw time within 30 minutes; the draw is retried automatically.');
      await sleep(4000);
      found = await findSeedLedger(drawLedger, cp.drawAt, cp.afterLedger.index);
    }
    const seed = await drawSeed(found.seed.hash, entriesSha256, count, winners);
    const picks = await drawPicks(seed, count, winners);
    const d = await signed('DrawPerformed', `${POW}/draws/${jobId}`, {
      jobId, rule: DRAW_RULE, commitment: c.txHash, label: x.label ?? null, entriesSha256, count, winners, drawAt: cp.drawAt,
      seedLedger: found.seed, previousLedger: { index: found.previous.index, closeTime: found.previous.closeTime }, seed, picks,
      ...(x.entries ? { picked: picks.map((i) => x.entries![i]) } : {}),
    });
    const result = {
      draw: d, commitment: c, ...(x.entries ? { entries: x.entries } : {}),
      winners: picks.map((index, place) => ({ place: place + 1, index, ...(x.entries ? { entry: x.entries[index] } : {}) })),
      ...evidenceFor([d.payload.signerDeclaration, c.payload.signerDeclaration]), verify: VERIFY_DRAW,
      ...(x.public ? { publicUrl: `${PUBLIC_BASE}/draw/draws/${jobId}` } : {}),
    };
    if (x.public) await Deno.writeTextFile(`${DATA}/draw/public/${jobId}.json`, JSON.stringify(result, null, 2));
    console.log(`[agents] draw ${jobId} done: seed ledger ${found.seed.index}, winners ${picks.join(', ')}`);
    return result;
  },
});

// ─── Payment watching ────────────────────────────────────────────────────────
// timestamp: agent.tick(). webhook: its completion work waits for the period, and
// tick() waits for running work, so payments are matched here and work is (re)started
// with agent.work(), which never runs a stage twice at once.

/** For agents whose work waits (webhook: the period; draw: the draw time), which tick() would wait for too. */
async function watchLong(agent: PaidAgent): Promise<void> {
  const open = (await agent.jobs()).filter((j) => j.state !== 'completed' && j.state !== 'cancelled');
  const incoming = new Map<string, Awaited<ReturnType<typeof xrplLedgerReader.incoming>>>();
  for (const j of open) {
    const v = await agent.job(j.jobId);
    if (v?.pay) {
      const to = v.pay.destination;
      if (!incoming.has(to)) incoming.set(to, await xrplLedgerReader.incoming(NETWORK, to));
      for (const t of incoming.get(to)!.filter((t) => t.destinationTag === v.pay!.destinationTag)) {
        const c = await agent.claimPayment(j.jobId, t.hash).catch(() => null);
        if (c?.state === 'paid') break;
      }
    }
    const after = await agent.job(j.jobId);
    // Work already running is not started twice (the kit keeps one per job); a failure is retried up to MAX_AUTO_RETRIES.
    const failures = after?.job.stages.find((s) => s.state === 'failed')?.failures ?? 0;
    if (after?.job.state === 'working') void agent.work(j.jobId);
    else if (after?.job.state === 'failed' && failures < MAX_AUTO_RETRIES) void agent.retry(j.jobId);
  }
}
let ticking = false;
setInterval(async () => {
  if (ticking) return; ticking = true;
  try { await timestamp.tick(); } catch (e) { console.warn('[agents] timestamp tick:', (e as Error).message); }
  try { await watchLong(webhook); } catch (e) { console.warn('[agents] webhook watch:', (e as Error).message); }
  try { await watchLong(draw); } catch (e) { console.warn('[agents] draw watch:', (e as Error).message); }
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
  draw: {
    agent: draw,
    howToUse: `cappz-market hire ${PUBLIC_BASE}/draw --input '{"entries":["ann","bob","cy"],"winners":1,"public":true}' --max ${DRAW_PRICE} — or POST /jobs → pay the one stage → GET ${PUBLIC_BASE}/draw/commitments/<jobId> (share it before the draw) → after drawAt GET /jobs/<id>/stages/1/result (free)`,
    validate: (i) => drawInputProblem(i, Date.now(), DRAW_MAX_DAYS),
  },
};

// ─── Docs: guide (HTML), llms.txt, per-agent SKILL.md, verifier, OpenAPI ──────
// Templates in ./docs, filled with live values and re-read per request (edit without restarting).

const DOCS_DIR = new URL('./docs/', import.meta.url);
const VARS = docVars({
  publicBase: PUBLIC_BASE, network: NETWORK, payTo: PAY_TO, nodePublicKeyHex: key.publicKeyHex,
  timestampPrice: TIMESTAMP_PRICE, webhookPrice: WEBHOOK_PRICE, webhookDays: WEBHOOK_DAYS,
  drawPrice: DRAW_PRICE, drawMaxDays: DRAW_MAX_DAYS, drawMinLeadSeconds: DRAW_MIN_LEAD_MS / 1000,
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
const signerInfo = () => ({ declaredBy: vouch ? { xrplAddress: vouch.address, walletPublicKey: vouch.wallet, declarationHash: vouch.hash, ...(vouch.anchor ? { onLedger: { network: vouch.anchor.network, txHash: vouch.anchor.txHash.toUpperCase() } } : {}), expiresAt: vouch.expiresAt, isPayTo: vouch.address === PAY_TO } : null });
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
      ...agentPaths('draw', {
        type: 'object', description: 'Either entries, or entriesSha256 with count.',
        properties: {
          entries: { type: 'array', minItems: 1, maxItems: 10_000, items: { type: 'string', minLength: 1, maxLength: 200 }, description: 'The list; each entry is one ticket.' },
          entriesSha256: { type: 'string', pattern: '^[0-9a-fA-F]{64}$', description: 'SHA-256 of the UTF-8 JSON array of entries (JSON.stringify), when the list stays private.' },
          count: { type: 'integer', minimum: 1, maximum: 1_000_000 },
          winners: { type: 'integer', minimum: 1, maximum: 1000, default: 1 },
          drawAt: { type: 'string', format: 'date-time', description: `When the draw happens: at most ${DRAW_MAX_DAYS} days ahead; never sooner than ${DRAW_MIN_LEAD_MS / 1000} s after the commitment (the default).` },
          label: { type: 'string', maxLength: 100 },
          public: { type: 'boolean', default: false, description: 'Serve the result (with entries, if sent) at /draw/draws/{jobId}.' },
        },
      }),
      '/draw/log': { get: { summary: 'Every commitment this node signed, oldest first, each naming the one before it (hash chain). No entries.', parameters: [{ name: 'from', in: 'query', schema: { type: 'integer', minimum: 0 } }], responses: { 200: { description: '{ total, from, commitments: [signed DrawCommitted] } (at most 200)' } } } },
      '/draw/commitments/{jobId}': { get: { summary: 'One signed commitment: list SHA-256, count, winners, drawAt, the ledger it followed', parameters: [idParam], responses: { 200: { description: 'Signed DrawCommitted' }, 404: { description: 'No commitment yet (unpaid) or unknown job' } } } },
      '/draw/draws/{jobId}': { get: { summary: 'A public draw\'s result (JSON; a page for browsers)', parameters: [idParam], responses: { 200: { description: 'Result: draw, commitment, winners, entries if sent' }, 404: { description: 'Not public, not drawn yet, or unknown' } } } },
      '/webhook/hooks/{jobId}': {
        get: { summary: 'Endpoint status (active, period, record count; never bodies)', parameters: [idParam], responses: { 200: { description: 'Status' } } },
        post: { summary: 'Deliver a webhook (any content type, ≤ 64 KB); returns the signed record id', parameters: [idParam], requestBody: { content: { '*/*': {} } }, responses: { 200: { description: '{ txId, txHash, receivedAt }' }, 402: { description: 'Deposit not paid' }, 410: { description: 'Period ended' }, 413: { description: 'Body over 64 KB' }, 429: { description: 'Record limit reached' } } },
      },
    },
  };
}

const ROUTE = /^\/agents\/(timestamp|webhook|draw)(\/agent|\/health|\/jobs|\/jobs\/(job-[0-9a-f]{16})(\/payments|\/retry|\/stages\/(\d+)\/result)?|\/hooks\/(job-[0-9a-f]{16}))?\/?$/;

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  if (url.pathname === '/agents') return Response.redirect(`${PUBLIC_BASE}/`, 301);
  if (req.method === 'GET' && url.pathname === '/agents/' && !wantsHtml(req)) {
    return json(200, { node: key!.publicKeyHex, ...signerInfo(), keyDeclarations: `${PUBLIC_BASE}/key-declarations.json`, network: NETWORK, payTo: PAY_TO, docs: docsFor(), agents: Object.keys(AGENTS).map((n) => ({ name: n, url: `${PUBLIC_BASE}/${n}`, price: AGENTS[n].agent.card().price, skill: `${PUBLIC_BASE}/${n}/SKILL.md` })) });
  }
  const docPath = url.pathname.startsWith('/agents/') ? url.pathname.slice('/agents'.length) : '';
  if (req.method === 'GET' && DOC_FILES[docPath]) return doc(docPath);
  if (req.method === 'GET' && url.pathname === '/agents/openapi.json') return json(200, openapi());
  if (req.method === 'GET' && url.pathname === '/agents/key-declarations.json') return json(200, { signerPublicKey: key!.publicKeyHex, ...signerInfo(), declarations: vouch?.declaration ? [vouch.declaration] : [], ledgerDeclarations: vouch?.anchor ? [vouch.hash] : [], revocations });
  if (req.method === 'GET' && url.pathname === '/agents/draw/log') {
    const from = Math.max(0, Math.floor(Number(url.searchParams.get('from') ?? 0)) || 0);
    return json(200, { total: commitments.length, from, rule: DRAW_RULE, commitments: commitments.slice(from, from + 200) });
  }
  const dm = /^\/agents\/draw\/(commitments|draws)\/(job-[0-9a-f]{16})\/?$/.exec(url.pathname);
  if (req.method === 'GET' && dm) {
    if (dm[1] === 'commitments') { const c = commitmentOf(dm[2]); return c ? json(200, c) : json(404, { error: 'No commitment for this job yet: it is signed once the job is paid.' }); }
    // Page and data share the address a host shares; ?json (what the page fetches) always means the data, and Vary keeps caches apart.
    if (wantsHtml(req) && !url.searchParams.has('json')) { const r = await doc('/draw/view'); r.headers.set('vary', 'accept'); return r; }
    try { return new Response(await Deno.readFile(`${DATA}/draw/public/${dm[2]}.json`), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300', vary: 'accept', ...CORS } }); }
    catch (e) { onlyMissing(e); return json(404, { error: 'No public result for this job: not drawn yet, or the buyer did not ask for a public draw.', commitment: commitmentOf(dm[2]) ? `${PUBLIC_BASE}/draw/commitments/${dm[2]}` : null }); }
  }
  const m = ROUTE.exec(url.pathname);
  if (!m) return json(404, { error: 'Not found.', docs: docsFor() });
  const [, name, sub, id, tail, stageN, hookId] = m;
  const a = AGENTS[name];
  // A person opening an agent's URL (e.g. from its marketplace card) lands on the guide.
  if (req.method === 'GET' && (!sub || sub === '/') && wantsHtml(req)) return Response.redirect(`${PUBLIC_BASE}/#try-${name}`, 302);
  if (req.method === 'GET' && (!sub || sub === '/agent' || sub === '/')) return json(200, { ...a.agent.card(), signerPublicKey: key!.publicKeyHex, ...signerInfo(), howToUse: a.howToUse, docs: docsFor(name) });
  if (req.method === 'GET' && sub === '/health') return json(200, { ok: true, network: NETWORK, agent: name, payTo: PAY_TO, price: a.agent.offer.price });
  if (req.method === 'POST' && sub === '/jobs') {
    if (Number(req.headers.get('content-length') ?? 0) > DRAW_MAX_BODY) return json(413, { error: 'Requests are limited to 3 MB: send entriesSha256 and count for big lists.' });
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
