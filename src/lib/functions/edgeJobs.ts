/**
 * COPE node crystallized. Node ID: v15-01-00-edge-jobs
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * Wave C contract shared by packages/cappz-edge-node (Deno) and the browser
 * fallback. No path aliases and no browser- or Deno-only APIs, so both
 * runtimes import this file as is.
 *
 *   Timers   — BPMN timer start events (src/bpmn/substrate/functions/edge-node-jobs.bpmn):
 *              <bpmn:startEvent cappz:function="<fn>"> + <bpmn:timeCycle>R/PT5M</bpmn:timeCycle>.
 *              The schedule lives in the process, the work in the job's handler.
 *   Webhooks — secret-free inbound calls the node turns into signed TXs
 *              (ContentIngested, payload.source = 'webhook'). A webhook that
 *              needs a signing secret stays hosted (secrets-last).
 *
 * v15-01-00 ships the runner with no bound jobs: every timer and webhook in
 * the plan belongs to a state domain moved to vNext (DMS, staking, AI vaults).
 */
import { attrValue } from '../text/textScan.ts';

export interface TimerSchedule {
  /** Function the timer runs (cappz:function on the timer start event). */
  functionName: string;
  eventId: string;
  everyMs: number;
  /** cappz:governingPrinciple on the start event — required. */
  governingPrinciple: string;
}

export interface JobRunResult {
  ok: boolean;
  detail?: string;
  /** TXs the job asks the runner to sign and append. */
  txs?: UnsignedEdgeTx[];
}

export interface EdgeTimerJob {
  functionName: string;
  run(now: Date): Promise<JobRunResult>;
}

export interface EdgeWebhookJob {
  functionName: string;
  /** Path under /hooks/ the node accepts, e.g. 'dms-oracle'. */
  path: string;
  /** Shape check only — reject what the function cannot read. No secret involved. */
  accepts(body: unknown): boolean;
}

export interface UnsignedEdgeTx {
  txId: string;
  timestamp: string;
  eventType: string;
  sourceAddress: string;
  targetAddress: string;
  payload: Record<string, unknown> & { governingPrinciple: string };
}

export interface SignedEdgeTx extends UnsignedEdgeTx {
  txHash: string;
  signature: string;
  signerPublicKey: string;
}

/** Jobs bound in this release (none — see header). Keyed by function name. */
export const EDGE_TIMER_JOBS: Readonly<Record<string, EdgeTimerJob>> = {};
export const EDGE_WEBHOOK_JOBS: Readonly<Record<string, EdgeWebhookJob>> = {};

/** ISO 8601 duration (PnDTnHnMnS, no months/years) → milliseconds; null when unreadable. */
export function isoDurationMs(d: string): number | null {
  const m = d.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!m || d === 'P' || d.endsWith('T')) return null;
  const [, days, h, min, s] = m;
  const ms = ((Number(days ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(min ?? 0)) * 60_000 + Number(s ?? 0) * 1000;
  return ms > 0 ? ms : null;
}

const attr = attrValue;

/**
 * Timer schedules declared in a BPMN document. A timer start event without
 * a function, a principle or a readable repeating cycle is reported, never
 * guessed.
 */
export function parseTimerSchedules(xml: string): { schedules: TimerSchedule[]; rejected: Array<{ eventId: string; reason: string }> } {
  const schedules: TimerSchedule[] = [];
  const rejected: Array<{ eventId: string; reason: string }> = [];
  for (const m of xml.matchAll(/<bpmn:startEvent\b([^>]*)>([\s\S]*?)<\/bpmn:startEvent>/g)) {
    const [, attrs, inner] = m;
    if (!inner.includes('timerEventDefinition')) continue;
    const eventId = attr(attrs, 'id') ?? '?';
    const functionName = attr(attrs, 'cappz:function');
    const governingPrinciple = attr(attrs, 'cappz:governingPrinciple');
    const cycle = inner.match(/<bpmn:timeCycle[^>]*>\s*R\d*\/([^<\s]+)\s*<\/bpmn:timeCycle>/)?.[1];
    const everyMs = cycle ? isoDurationMs(cycle) : null;
    if (!functionName) rejected.push({ eventId, reason: 'no cappz:function' });
    else if (!governingPrinciple) rejected.push({ eventId, reason: 'no cappz:governingPrinciple' });
    else if (!everyMs) rejected.push({ eventId, reason: 'no repeating timeCycle (R/<duration>)' });
    else schedules.push({ functionName, eventId, everyMs, governingPrinciple });
  }
  return { schedules, rejected };
}

/** Which schedules are due. A schedule that never ran is due; an unbound one is skipped with a reason. */
export function dueTimers(
  schedules: readonly TimerSchedule[],
  lastRunAt: Readonly<Record<string, number>>,
  now: number,
  bound: Readonly<Record<string, unknown>> = EDGE_TIMER_JOBS,
): { due: TimerSchedule[]; unbound: string[] } {
  const due: TimerSchedule[] = [];
  const unbound: string[] = [];
  for (const s of schedules) {
    if (!bound[s.functionName]) { unbound.push(s.functionName); continue; }
    const last = lastRunAt[s.eventId];
    if (last === undefined || now - last >= s.everyMs) due.push(s);
  }
  return { due, unbound };
}

/** Canonical JSON with sorted keys — the bytes that are hashed and signed. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

export async function sha256HexOf(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The TX a secret-free webhook becomes. Deterministic txId: a redelivered body is the same TX. */
export async function webhookTx(params: {
  job: EdgeWebhookJob;
  body: unknown;
  receivedAt: string;
  nodeAddress: string;
  targetAddress: string;
  governingPrinciple: string;
}): Promise<UnsignedEdgeTx> {
  const bodyHash = await sha256HexOf(canonicalJson(params.body));
  return {
    txId: `ContentIngested-${(await sha256HexOf(`${params.job.functionName}|${params.job.path}|${bodyHash}`)).slice(0, 32)}`,
    timestamp: params.receivedAt,
    eventType: 'ContentIngested',
    sourceAddress: params.nodeAddress,
    targetAddress: params.targetAddress,
    payload: { source: 'webhook', functionName: params.job.functionName, path: params.job.path, bodyHash, body: params.body as Record<string, unknown>, governingPrinciple: params.governingPrinciple },
  };
}

/** Sign with the node's own Ed25519 key (an operator key, not a third-party secret). */
export async function signEdgeTx(tx: UnsignedEdgeTx, key: { privateKey: CryptoKey; publicKeyHex: string }): Promise<SignedEdgeTx> {
  const txHash = await sha256HexOf(canonicalJson(tx));
  const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', key.privateKey, new TextEncoder().encode(txHash)));
  return { ...tx, txHash, signature: Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join(''), signerPublicKey: key.publicKeyHex };
}

export async function verifyEdgeTx(tx: SignedEdgeTx): Promise<boolean> {
  const { txHash, signature, signerPublicKey, ...unsigned } = tx;
  if ((await sha256HexOf(canonicalJson(unsigned))) !== txHash) return false;
  const hex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));
  const pub = await crypto.subtle.importKey('raw', hex(signerPublicKey), { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify('Ed25519', pub, hex(signature), new TextEncoder().encode(txHash));
}
