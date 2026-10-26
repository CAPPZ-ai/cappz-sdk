/**
 * COPE node crystallized. Node ID: v15-02-00-paid-agent-kit.
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * Paid agent kit: run an agent on your own device and get paid in XRP or
 * CAPPZ, stage by stage. A job's payment schedule is a list of stages —
 * `upfront` (paid before work starts), `milestone` and `completion` (work is
 * done first, its hash is shown, and the output is released once that stage
 * is paid) — so neither side is ever more than one stage exposed.
 *
 * The agent holds only a public address; it never sees a secret key. A
 * payment counts only when the validated ledger shows it delivered (not
 * `Amount`, which a partial payment can exceed) to the right address and
 * destination tag, in the right currency and issuer. Job state is replayed
 * from an append-only event log; the job's terms are copied into its first
 * event, so changing your price later never changes a running job.
 *
 * Runs unchanged in the browser, Node 22+, Bun and Deno: web-standard APIs
 * only, plus `xrpl`. Imports are relative with extensions so the file can be
 * shipped as-is in the downloadable agent.
 */
import { isValidClassicAddress } from 'xrpl';
import { fetchIncomingPayments, fetchLedgerTx, type LedgerTx, type XrplNetwork } from '../xrpl/ledgerCheck.ts';

export type { LedgerTx, XrplNetwork };
export type PayCurrency = 'XRP' | 'CAPPZ';
/** An issued token the agent accepts: currency code (and its 40-hex form) plus the issuer it must come from. */
export interface TokenSpec { code: string; hex: string; issuer: string }
export type StageKind = 'upfront' | 'milestone' | 'completion';

export interface PaymentStage {
  label: string;
  kind: StageKind;
  /** Share of the price paid at this stage; shares sum to 1. */
  share: number;
  /** What the buyer receives or can check at this stage. */
  deliverable?: string;
}

export interface AgentOffer {
  name: string;
  description: string;
  /** Public classic address (r…) that receives payments. Never a secret. */
  payTo: string;
  network: XrplNetwork;
  currency: PayCurrency;
  /** Required when currency is an issued token (CAPPZ). */
  token?: TokenSpec;
  /** Price of one job, in whole XRP or tokens. */
  price: number;
  stages: PaymentStage[];
}

/** A failing stage is retried automatically this many times; after that, `retry(jobId)` runs it again. */
export const MAX_AUTO_RETRIES = 3;

/** Both XRP (drops) and CAPPZ use six decimals. */
export const MICRO = 1_000_000n;

/** Ready-made schedules; a person picks one and can still edit labels and shares. */
export const SCHEDULE_PRESETS: Record<'on-completion' | 'deposit-completion' | 'deposit-milestone-completion', { title: string; text: string; stages: PaymentStage[] }> = {
  'on-completion': {
    title: 'Pay on completion',
    text: 'Best for small, fast jobs. The buyer sees a fingerprint of the result, pays, and receives it.',
    stages: [{ label: 'Completed', kind: 'completion', share: 1, deliverable: 'The finished result' }],
  },
  'deposit-completion': {
    title: 'Deposit + completion',
    text: 'A deposit to start, the rest when the result is ready. Protects your time on bigger jobs.',
    stages: [
      { label: 'Deposit to start', kind: 'upfront', share: 0.3 },
      { label: 'Completed', kind: 'completion', share: 0.7, deliverable: 'The finished result' },
    ],
  },
  'deposit-milestone-completion': {
    title: 'Deposit, milestone, completion',
    text: 'For long jobs: a deposit, a paid first draft the buyer can check, then the final result.',
    stages: [
      { label: 'Deposit to start', kind: 'upfront', share: 0.2 },
      { label: 'First draft', kind: 'milestone', share: 0.3, deliverable: 'A first draft to review' },
      { label: 'Completed', kind: 'completion', share: 0.5, deliverable: 'The finished result' },
    ],
  },
};

// ─── Offer validation and amounts ─────────────────────────────────

/** Everything wrong with an offer, in plain words (empty = valid). */
export function offerProblems(o: AgentOffer): string[] {
  const p: string[] = [];
  if (!o.name?.trim()) p.push('Give your agent a name.');
  if (!isValidClassicAddress(o.payTo ?? '')) p.push('The payment address is not a valid XRPL address (it starts with “r” and is 25–35 characters).');
  if (!(o.price > 0)) p.push('Set a price above zero.');
  if (o.currency !== 'XRP') {
    if (!o.token) p.push(`Payments in ${o.currency} need the token's issuer.`);
    else if (!isValidClassicAddress(o.token.issuer)) p.push('The token issuer is not a valid XRPL address.');
  }
  if (!o.stages?.length) p.push('Add at least one payment stage.');
  else {
    const total = o.stages.reduce((s, x) => s + x.share, 0);
    if (o.stages.some((x) => !(x.share > 0))) p.push('Every stage needs a share above 0%.');
    if (Math.abs(total - 1) > 1e-6) p.push(`Stage shares add up to ${Math.round(total * 1000) / 10}%, not 100%.`);
    if (o.stages.at(-1)!.kind !== 'completion') p.push('The last stage must be the completion.');
    if (o.stages.slice(0, -1).some((x) => x.kind === 'completion')) p.push('Only the last stage can be the completion.');
    const firstWork = o.stages.findIndex((x) => x.kind !== 'upfront');
    if (o.stages.slice(firstWork).some((x) => x.kind === 'upfront')) p.push('Upfront payments come before any work stage.');
    if (o.stages.some((x) => !x.label.trim())) p.push('Give every stage a name.');
    if (o.price > 0 && stageAmountsMicro(o).some((a) => a <= 0n)) p.push('The price is too small to split into these stages.');
  }
  return p;
}

export function defineAgentOffer(o: AgentOffer): AgentOffer {
  const p = offerProblems(o);
  if (p.length) throw new Error(p.join(' '));
  return { ...o, stages: o.stages.map((s) => ({ ...s })) };
}

/** Parse a decimal amount ("12.5", "1e-6") into micro-units, truncating beyond six decimals. */
export function toMicro(value: string | number): bigint {
  let s = String(value).trim().toLowerCase();
  if (!/^-?\d*\.?\d+(e[+-]?\d+)?$/.test(s)) throw new Error(`Not an amount: ${value}`);
  const neg = s.startsWith('-'); if (neg) s = s.slice(1);
  const [mant, exp = '0'] = s.split('e');
  let [int, frac = ''] = mant.split('.');
  let e = Number.parseInt(exp, 10);
  // Move the decimal point by the exponent.
  while (e > 0) { int += frac[0] ?? '0'; frac = frac.slice(1); e--; }
  while (e < 0) { frac = (int.slice(-1) || '0') + frac; int = int.slice(0, -1); e++; }
  const micro = BigInt(int || '0') * MICRO + BigInt((frac + '000000').slice(0, 6));
  return neg ? -micro : micro;
}

export function fromMicro(m: bigint): string {
  const neg = m < 0n; const a = neg ? -m : m;
  const frac = (a % MICRO).toString().padStart(6, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${a / MICRO}${frac ? `.${frac}` : ''}`;
}

function stageAmountsMicro(o: Pick<AgentOffer, 'price' | 'stages'>): bigint[] {
  const total = toMicro(o.price);
  const parts = o.stages.map((s) => (total * BigInt(Math.round(s.share * 1e9))) / 1_000_000_000n);
  parts[parts.length - 1] += total - parts.reduce((a, b) => a + b, 0n);
  return parts;
}

/** What is due at each stage, as decimal strings; rounding goes to the last stage so the parts add up to the price. */
export function stageAmounts(o: Pick<AgentOffer, 'price' | 'stages'>): string[] { return stageAmountsMicro(o).map(fromMicro); }

// ─── Payment requests and checks ──────────────────────────────────

const enc = new TextEncoder();
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
export async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  const b = typeof bytes === 'string' ? enc.encode(bytes) : bytes;
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource))).toLowerCase();
}

/** Destination tag for one stage of one job: reproducible from the job id, so it needs no lookup table. */
export async function destinationTagFor(jobId: string, stage: number): Promise<number> {
  const h = await sha256Hex(`cappz-job|${jobId}|${stage}`);
  return (Number.parseInt(h.slice(0, 8), 16) >>> 0) || 1;
}

export type JobTerms = Pick<AgentOffer, 'payTo' | 'network' | 'currency' | 'token' | 'price' | 'stages'>;

export interface PaymentRequest {
  jobId: string; stage: number; label: string;
  network: XrplNetwork; destination: string; destinationTag: number;
  currency: PayCurrency; issuer: string | null; amount: string;
  /** Unsigned Payment for the buyer's own wallet to complete (it adds Account, Fee, Sequence) and sign. */
  preparedTx: Record<string, unknown>;
  /** One line a person can follow in any XRPL wallet. */
  instructions: string;
}

export async function paymentRequest(terms: JobTerms, jobId: string, stage: number): Promise<PaymentRequest> {
  const s = terms.stages[stage];
  if (!s) throw new Error(`No stage ${stage}.`);
  const amount = stageAmounts(terms)[stage];
  const destinationTag = await destinationTagFor(jobId, stage);
  const Amount = terms.currency === 'XRP' ? String(toMicro(amount)) : { currency: terms.token!.hex, issuer: terms.token!.issuer, value: amount };
  const memo = (t: string, d: string) => ({ Memo: { MemoType: hex(enc.encode(t)), MemoData: hex(enc.encode(d)) } });
  return {
    jobId, stage, label: s.label, network: terms.network, destination: terms.payTo, destinationTag,
    currency: terms.currency, issuer: terms.currency === 'XRP' ? null : terms.token!.issuer, amount,
    preparedTx: { TransactionType: 'Payment', Destination: terms.payTo, DestinationTag: destinationTag, Amount, Memos: [memo('cappz-job', `${jobId}:${stage}`)] },
    instructions: `Send ${amount} ${terms.currency} on XRPL ${terms.network} to ${terms.payTo} with destination tag ${destinationTag}.`,
  };
}

export type PaymentCheckState = 'paid' | 'not-validated' | 'failed' | 'wrong-destination' | 'wrong-tag' | 'wrong-currency' | 'underpaid';
export interface PaymentCheck { state: PaymentCheckState; reason: string; txHash: string; delivered: string | null; checkedAt: string }

/** Check one ledger transaction against one payment request — what the ledger did, not what the transaction asked for. */
export function checkPayment(terms: JobTerms, req: PaymentRequest, lt: LedgerTx): PaymentCheck {
  const base = { txHash: lt.hash, checkedAt: lt.checkedAt };
  const due = toMicro(req.amount);
  if (!lt.validated) return { ...base, state: 'not-validated', reason: 'The transaction is not in a validated ledger yet.', delivered: null };
  if (lt.result !== 'tesSUCCESS') return { ...base, state: 'failed', reason: `The transaction failed on the ledger (${lt.result || 'no result'}).`, delivered: null };
  if (lt.network !== terms.network) return { ...base, state: 'wrong-destination', reason: `The transaction is on ${lt.network}, the job is on ${terms.network}.`, delivered: null };
  if (lt.type !== 'Payment' || lt.destination !== terms.payTo) return { ...base, state: 'wrong-destination', reason: 'The payment did not go to this agent’s address.', delivered: null };
  if (lt.destinationTag !== req.destinationTag) return { ...base, state: 'wrong-tag', reason: `The destination tag is ${lt.destinationTag ?? 'missing'}; this stage needs ${req.destinationTag}.`, delivered: null };
  let got: bigint | null = null;
  if (terms.currency === 'XRP') { if (lt.deliveredDrops !== null) got = BigInt(lt.deliveredDrops); }
  else {
    const d = lt.deliveredIssued; const t = terms.token!;
    if (d && d.issuer === t.issuer && [t.code.toUpperCase(), t.hex.toUpperCase()].includes(d.currency.toUpperCase())) got = toMicro(d.value);
  }
  if (got === null) return { ...base, state: 'wrong-currency', reason: terms.currency === 'XRP' ? 'The payment delivered a token, not XRP.' : `The payment did not deliver ${terms.currency} from the expected issuer.`, delivered: null };
  if (got < due) return { ...base, state: 'underpaid', reason: `Delivered ${fromMicro(got)} ${terms.currency}; this stage needs ${req.amount}.`, delivered: fromMicro(got) };
  return { ...base, state: 'paid', reason: `Delivered ${fromMicro(got)} ${terms.currency} — validated.`, delivered: fromMicro(got) };
}

// ─── Job log and replay ───────────────────────────────────────────

export type JobEvent =
  | { type: 'JobOpened'; jobId: string; at: string; terms: JobTerms; input: unknown }
  | { type: 'StagePaid'; jobId: string; at: string; stage: number; txHash: string; delivered: string }
  | { type: 'StageWorkDelivered'; jobId: string; at: string; stage: number; resultHash: string; bytes: number }
  | { type: 'StageWorkFailed'; jobId: string; at: string; stage: number; reason: string }
  | { type: 'JobCancelled'; jobId: string; at: string; reason: string };

export type StageState = 'locked' | 'awaiting-payment' | 'working' | 'failed' | 'ready-awaiting-payment' | 'released';
export type JobState = 'awaiting-payment' | 'working' | 'failed' | 'ready-awaiting-payment' | 'completed' | 'cancelled';

export interface StageView {
  index: number; label: string; kind: StageKind; amount: string; state: StageState;
  payment: { txHash: string; delivered: string } | null;
  result: { hash: string; bytes: number } | null;
  failure: string | null;
  /** Failed attempts so far; the runner retries automatically up to MAX_AUTO_RETRIES. */
  failures: number;
}
export interface JobView {
  jobId: string; terms: JobTerms; input: unknown; openedAt: string;
  stages: StageView[]; state: JobState;
  /** The event that put the job in this state. */
  because: string;
  nextAction: { by: 'buyer' | 'agent' | null; action: string };
}

/** Replay one job from its events; events of other jobs are ignored. */
export function replayJob(events: readonly JobEvent[], jobId: string): JobView | null {
  const mine = events.filter((e) => e.jobId === jobId);
  const opened = mine.find((e) => e.type === 'JobOpened') as Extract<JobEvent, { type: 'JobOpened' }> | undefined;
  if (!opened) return null;
  const amounts = stageAmounts(opened.terms);
  const stages: StageView[] = opened.terms.stages.map((s, i) => ({ index: i, label: s.label, kind: s.kind, amount: amounts[i], state: 'locked', payment: null, result: null, failure: null, failures: 0 }));
  let because = 'JobOpened';
  for (const e of mine) {
    if (e.type === 'StagePaid' && stages[e.stage] && !stages[e.stage].payment) { stages[e.stage].payment = { txHash: e.txHash, delivered: e.delivered }; because = `StagePaid #${e.stage}`; }
    if (e.type === 'StageWorkDelivered' && stages[e.stage]) { stages[e.stage].result = { hash: e.resultHash, bytes: e.bytes }; stages[e.stage].failure = null; because = `StageWorkDelivered #${e.stage}`; }
    if (e.type === 'StageWorkFailed' && stages[e.stage] && !stages[e.stage].result) { stages[e.stage].failure = e.reason; stages[e.stage].failures++; because = `StageWorkFailed #${e.stage}`; }
  }
  let unlocked = true;
  for (const s of stages) {
    const done = s.kind === 'upfront' ? !!s.payment : !!s.payment && !!s.result;
    s.state = done ? 'released'
      : !unlocked ? 'locked'
      : s.kind === 'upfront' ? 'awaiting-payment'
      : s.result ? 'ready-awaiting-payment'
      : s.failure ? 'failed' : 'working';
    if (!done) unlocked = false;
  }
  const cancelled = mine.find((e) => e.type === 'JobCancelled') as Extract<JobEvent, { type: 'JobCancelled' }> | undefined;
  const current = stages.find((s) => s.state !== 'released');
  const view: JobView = { jobId, terms: opened.terms, input: opened.input, openedAt: opened.at, stages, state: 'completed', because, nextAction: { by: null, action: 'Nothing — the job is complete.' } };
  if (cancelled) return { ...view, state: 'cancelled', because: 'JobCancelled', nextAction: { by: null, action: cancelled.reason } };
  if (!current) return view;
  const pay = `Pay ${current.amount} ${opened.terms.currency} for “${current.label}”.`;
  if (current.state === 'awaiting-payment') return { ...view, state: 'awaiting-payment', nextAction: { by: 'buyer', action: pay } };
  if (current.state === 'ready-awaiting-payment') return { ...view, state: 'ready-awaiting-payment', nextAction: { by: 'buyer', action: `${pay} The result is ready; its fingerprint is ${current.result!.hash.slice(0, 16)}….` } };
  if (current.state === 'failed') return { ...view, state: 'failed', nextAction: { by: 'agent', action: `Retry “${current.label}”: ${current.failure}` } };
  return { ...view, state: 'working', nextAction: { by: 'agent', action: `Working on “${current.label}”.` } };
}

/** Where the job log and results live. The kit ships a memory store; the downloadable agent uses files on your device. */
export interface JobStore {
  append(e: JobEvent): Promise<void>;
  events(): Promise<JobEvent[]>;
  putResult(jobId: string, stage: number, bytes: Uint8Array): Promise<void>;
  getResult(jobId: string, stage: number): Promise<Uint8Array | null>;
}

export function memoryJobStore(): JobStore {
  const log: JobEvent[] = []; const results = new Map<string, Uint8Array>();
  return {
    async append(e) { log.push(e); },
    async events() { return [...log]; },
    async putResult(j, s, b) { results.set(`${j}/${s}`, b); },
    async getResult(j, s) { return results.get(`${j}/${s}`) ?? null; },
  };
}

// ─── The agent runner ─────────────────────────────────────────────

export interface WorkContext { jobId: string; stage: number; label: string; kind: StageKind; input: unknown; /** Outputs of earlier stages, as text. */ previous: string[] }
/** Your agent's work for one stage. Return text, bytes or JSON. Throw to report a failure (the stage can be retried). */
export type StageWork = (ctx: WorkContext) => Promise<string | Uint8Array | Record<string, unknown>>;

export interface LedgerReader { incoming(network: XrplNetwork, account: string): Promise<LedgerTx[]>; tx(network: XrplNetwork, hash: string): Promise<LedgerTx> }
export const xrplLedgerReader: LedgerReader = { incoming: (n, a) => fetchIncomingPayments(n, a), tx: (n, h) => fetchLedgerTx(n, h) };

export interface PaidAgentOptions { offer: AgentOffer; work: StageWork; store?: JobStore; ledger?: LedgerReader; now?: () => string; newJobId?: () => string }

export type ResultAnswer =
  | { state: 'released'; bytes: Uint8Array; hash: string }
  | { state: 'payment-required'; pay: PaymentRequest; hash: string }
  | { state: 'not-ready'; job: JobView };

export function createPaidAgent(opts: PaidAgentOptions) {
  const offer = defineAgentOffer(opts.offer);
  const store = opts.store ?? memoryJobStore();
  const ledger = opts.ledger ?? xrplLedgerReader;
  const now = opts.now ?? (() => new Date().toISOString());
  const newJobId = opts.newJobId ?? (() => `job-${hex(crypto.getRandomValues(new Uint8Array(8))).toLowerCase()}`);
  /** Work in flight per job, so a stage never runs twice at once and a tick can wait for it. */
  const running = new Map<string, Promise<void>>();
  /** Last check per job and stage, for status pages (diagnostic, not part of the log). */
  const lastChecks = new Map<string, PaymentCheck>();

  const view = async (jobId: string) => replayJob(await store.events(), jobId);
  const jobIds = async () => [...new Set((await store.events()).filter((e) => e.type === 'JobOpened').map((e) => e.jobId))];
  const terms: JobTerms = { payTo: offer.payTo, network: offer.network, currency: offer.currency, token: offer.token, price: offer.price, stages: offer.stages };

  /** The stage the buyer should pay now (null when nothing is due yet). */
  async function due(job: JobView): Promise<PaymentRequest | null> {
    const s = job.stages.find((x) => x.state === 'awaiting-payment' || x.state === 'ready-awaiting-payment');
    return s ? paymentRequest(job.terms, job.jobId, s.index) : null;
  }

  async function record(job: JobView, req: PaymentRequest, check: PaymentCheck): Promise<void> {
    lastChecks.set(`${job.jobId}/${req.stage}`, check);
    if (check.state !== 'paid') return;
    const used = (await store.events()).some((e) => e.type === 'StagePaid' && e.txHash === check.txHash);
    if (!used) await store.append({ type: 'StagePaid', jobId: job.jobId, at: now(), stage: req.stage, txHash: check.txHash, delivered: check.delivered! });
  }

  function runWork(job: JobView): Promise<void> {
    const inFlight = running.get(job.jobId);
    if (inFlight) return inFlight;
    const s = job.stages.find((x) => x.state === 'working' || x.state === 'failed');
    if (!s) return Promise.resolve();
    const p = doWork(job, s).finally(() => running.delete(job.jobId));
    running.set(job.jobId, p);
    return p;
  }

  async function doWork(job: JobView, s: StageView): Promise<void> {
    try {
      const previous: string[] = [];
      for (const p of job.stages.slice(0, s.index)) { const b = p.result ? await store.getResult(job.jobId, p.index) : null; previous.push(b ? new TextDecoder().decode(b) : ''); }
      const out = await opts.work({ jobId: job.jobId, stage: s.index, label: s.label, kind: s.kind, input: job.input, previous });
      const bytes = typeof out === 'string' ? enc.encode(out) : out instanceof Uint8Array ? out : enc.encode(JSON.stringify(out, null, 2));
      await store.putResult(job.jobId, s.index, bytes);
      await store.append({ type: 'StageWorkDelivered', jobId: job.jobId, at: now(), stage: s.index, resultHash: await sha256Hex(bytes), bytes: bytes.length });
    } catch (e) {
      await store.append({ type: 'StageWorkFailed', jobId: job.jobId, at: now(), stage: s.index, reason: (e as Error).message || 'Unknown error' });
    }
  }

  return {
    offer,
    /** Public description of the agent: what it does, what it costs, how payment works. Holds nothing secret. */
    card() {
      const amounts = stageAmounts(offer);
      return { name: offer.name, description: offer.description, network: offer.network, payTo: offer.payTo, currency: offer.currency, issuer: offer.token?.issuer ?? null, price: fromMicro(toMicro(offer.price)), stages: offer.stages.map((s, i) => ({ ...s, amount: amounts[i] })) };
    },
    async openJob(input: unknown): Promise<{ job: JobView; pay: PaymentRequest | null }> {
      const jobId = newJobId();
      await store.append({ type: 'JobOpened', jobId, at: now(), terms, input });
      const job = (await view(jobId))!;
      if (job.state === 'working') void runWork(job);
      return { job, pay: await due(job) };
    },
    async job(jobId: string) { const job = await view(jobId); return job ? { job, pay: await due(job), lastCheck: [...lastChecks.entries()].filter(([k]) => k.startsWith(`${jobId}/`)).map(([, v]) => v).at(-1) ?? null } : null; },
    async jobs() { return Promise.all((await jobIds()).map(async (id) => (await view(id))!)); },
    /** The buyer reports a transaction hash; it is checked on the ledger before anything is recorded. */
    async claimPayment(jobId: string, txHash: string): Promise<PaymentCheck> {
      const job = await view(jobId); if (!job) throw new Error('Unknown job.');
      const req = await due(job); if (!req) throw new Error('Nothing is due on this job right now.');
      const check = checkPayment(job.terms, req, await ledger.tx(job.terms.network, txHash));
      await record(job, req, check);
      const after = (await view(jobId))!; if (after.state === 'working') void runWork(after);
      return check;
    },
    async result(jobId: string, stage: number): Promise<ResultAnswer> {
      const job = await view(jobId); if (!job) throw new Error('Unknown job.');
      const s = job.stages[stage]; if (!s || !s.result) return { state: 'not-ready', job };
      if (s.state === 'released') return { state: 'released', bytes: (await store.getResult(jobId, stage))!, hash: s.result.hash };
      return { state: 'payment-required', pay: await paymentRequest(job.terms, jobId, stage), hash: s.result.hash };
    },
    /** Run a failed stage again (after you fixed the cause). */
    async retry(jobId: string) { const j = await view(jobId); if (j?.state === 'failed') await runWork(j); return view(jobId); },
    async cancel(jobId: string, reason: string) { await store.append({ type: 'JobCancelled', jobId, at: now(), reason }); return view(jobId); },
    /** One pass: look on the ledger for payments that are due, then do any work that is now paid for. Call it on a timer. */
    async tick(): Promise<{ paid: number; worked: number }> {
      const open = (await Promise.all((await jobIds()).map(view))).filter((j): j is JobView => !!j && j.state !== 'completed' && j.state !== 'cancelled');
      let paid = 0, worked = 0;
      const waiting = (await Promise.all(open.map(async (j) => [j, await due(j)] as const))).filter(([, r]) => r) as Array<readonly [JobView, PaymentRequest]>;
      if (waiting.length) {
        const incoming = await ledger.incoming(offer.network, offer.payTo);
        for (const [j, req] of waiting) {
          // Every transaction with this stage's tag counts on its own merits: a later stray underpayment never hides an earlier full one.
          const checks = incoming.filter((t) => t.destinationTag === req.destinationTag).map((t) => checkPayment(j.terms, req, t));
          if (!checks.length) continue;
          await record(j, req, checks.find((c) => c.state === 'paid') ?? checks[0]);
          if (lastChecks.get(`${j.jobId}/${req.stage}`)?.state === 'paid') paid++;
        }
      }
      for (const id of open.map((j) => j.jobId)) { await running.get(id); const j = (await view(id))!; const s = j.stages.find((x) => x.state === 'working' || x.state === 'failed'); if (s && s.failures < MAX_AUTO_RETRIES) { await runWork(j); worked++; } }
      return { paid, worked };
    },
  };
}

export type PaidAgent = ReturnType<typeof createPaidAgent>;
