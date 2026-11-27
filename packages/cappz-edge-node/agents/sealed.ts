/**
 * Sealed store for the edge node (16.5.0), on the SDK's sealed shared storage (src/lib/sealed/sealedStore.ts).
 *
 *   A box is a storage space for a fixed set of writer wallets with a quota in whole gigabytes, rented in
 *   periods of CAPPZ_SEALED_DAYS (default 30). The job that opens it pays for the first period; a job with
 *   {"renews": <boxId>} pays for the next one (it starts when the current one ends, or at payment if that is
 *   later) and may change the quota. After the last period the box is read-only for CAPPZ_SEALED_GRACE_DAYS
 *   (default 7), then its bytes are deleted; its signed records and receipts stay.
 *
 *   The node stores only what writers send: ciphertext, sealed on their machines. It checks each write
 *   record's wallet signature and writer, the bytes' SHA-256 and size, the quota, and that the record names
 *   the object's current version (so an object never forks), and signs a receipt.
 *
 *   Capacity: the node never sells more than CAPPZ_SEALED_MAX_GB (default 50) at once — quotas of boxes
 *   that are active or in grace, plus jobs opened in the last hour and not yet paid.
 *
 * Pure: no I/O, so tests run it under Node.
 */
import { OBJECT_ID, WALLET, recordProblem, type BoxState, type SealedRecord } from '../../../src/lib/sealed/sealedStore.ts';

export const GB = 1024 ** 3;
const DAY = 86_400_000;
export const BOX_ID = /^job-[0-9a-f]{16}$/;

export interface SealedSettings { days: number; graceDays: number; maxGb: number; maxBoxGb: number; maxObjectBytes: number; maxWriters: number }

export type SealedOpenInput = { gb: number; writers: string[]; label?: string };
export type SealedRenewInput = { renews: string; gb?: number };
export type SealedInput = SealedOpenInput | SealedRenewInput;

export const isRenewal = (x: SealedInput): x is SealedRenewInput => typeof (x as SealedRenewInput).renews === 'string';

/** What is wrong with a job's input (null when it can be opened). Boxes are checked by the caller (boxProblem). */
export function sealedInputProblem(input: unknown, s: SealedSettings): string | null {
  const x = input as Record<string, unknown> | null;
  if (!x || typeof x !== 'object') return 'Send {"gb": <whole gigabytes>, "writers": ["<wallet address>", …]} to open a box, or {"renews": "<boxId>"} to renew one.';
  const gbOk = (g: unknown) => Number.isInteger(g) && (g as number) >= 1 && (g as number) <= s.maxBoxGb;
  if ('renews' in x) {
    if (typeof x.renews !== 'string' || !BOX_ID.test(x.renews)) return 'input.renews must be a box id (the job id that opened it, job-<16 hex>).';
    if (x.gb !== undefined && !gbOk(x.gb)) return `input.gb, when given, is a whole number of gigabytes from 1 to ${s.maxBoxGb}.`;
    if (Object.keys(x).some((k) => k !== 'renews' && k !== 'gb')) return 'A renewal takes only renews and gb.';
    return null;
  }
  if (!gbOk(x.gb)) return `input.gb must be a whole number of gigabytes from 1 to ${s.maxBoxGb}.`;
  if (!Array.isArray(x.writers) || x.writers.length < 1 || x.writers.length > s.maxWriters) return `input.writers must list 1 to ${s.maxWriters} wallet addresses (compressed secp256k1 public keys, hex) that may write to the box.`;
  if (x.writers.some((w) => typeof w !== 'string' || !WALLET.test(w.toLowerCase()))) return 'Each writer is a wallet address: 66 hex characters starting 02 or 03.';
  if (new Set((x.writers as string[]).map((w) => w.toLowerCase())).size !== x.writers.length) return 'input.writers lists a wallet twice.';
  if (x.label !== undefined && (typeof x.label !== 'string' || x.label.length > 100)) return 'input.label, when given, is text of at most 100 characters.';
  if (Object.keys(x).some((k) => !['gb', 'writers', 'label'].includes(k))) return 'Opening a box takes only gb, writers and label.';
  return null;
}

/** A job as the box replay needs it: when its payment was recorded (null while unpaid). */
export interface SealedJob { jobId: string; input: SealedInput; openedAt: string; paidAt: string | null; cancelled: boolean }

export interface Box {
  boxId: string;
  writers: string[];
  label: string | null;
  quotaBytes: number;
  /** Paid periods in order, each [start, end) in ms. */
  periods: Array<{ jobId: string; start: number; end: number; gb: number }>;
  state: 'unpaid' | 'active' | 'grace' | 'expired';
  periodEnd: number | null;
  graceEnd: number | null;
}

/**
 * Boxes from the jobs, replayed in payment order. A renewal applies only to a box that exists and is not
 * past its grace when the renewal is paid; one that arrives later is listed in `orphans` (the payment is
 * refunded by hand: the node never extends a deleted box).
 */
export function replayBoxes(jobs: readonly SealedJob[], now: number, s: Pick<SealedSettings, 'days' | 'graceDays'>): { boxes: Map<string, Box>; orphans: SealedJob[] } {
  const boxes = new Map<string, Box>();
  const orphans: SealedJob[] = [];
  const period = s.days * DAY, grace = s.graceDays * DAY;
  for (const j of jobs) if (!isRenewal(j.input) && !j.cancelled) {
    boxes.set(j.jobId, { boxId: j.jobId, writers: j.input.writers.map((w) => w.toLowerCase()), label: j.input.label ?? null, quotaBytes: j.input.gb * GB, periods: [], state: 'unpaid', periodEnd: null, graceEnd: null });
  }
  const paid = jobs.filter((j) => j.paidAt && !j.cancelled).sort((a, b) => a.paidAt!.localeCompare(b.paidAt!) || a.jobId.localeCompare(b.jobId));
  for (const j of paid) {
    const at = Date.parse(j.paidAt!);
    const boxId = isRenewal(j.input) ? j.input.renews : j.jobId;
    const box = boxes.get(boxId);
    const last = box?.periods.at(-1);
    if (!box || (isRenewal(j.input) && (!last || at >= last.end + grace))) { orphans.push(j); continue; }
    const gb = isRenewal(j.input) ? (j.input.gb ?? box.quotaBytes / GB) : j.input.gb;
    const start = last ? Math.max(at, last.end) : at;
    box.periods.push({ jobId: j.jobId, start, end: start + period, gb });
    box.quotaBytes = gb * GB;
  }
  for (const box of boxes.values()) {
    const last = box.periods.at(-1);
    if (!last) continue;
    box.periodEnd = last.end;
    box.graceEnd = last.end + grace;
    box.state = now < last.end ? 'active' : now < last.end + grace ? 'grace' : 'expired';
  }
  return { boxes, orphans };
}

/** Bytes promised now: quotas of active and grace boxes, plus opening jobs from the last hour still unpaid. */
export function reservedBytes(boxes: Map<string, Box>, jobs: readonly SealedJob[], now: number): number {
  let total = 0;
  for (const b of boxes.values()) if (b.state === 'active' || b.state === 'grace') total += b.quotaBytes;
  for (const j of jobs) {
    if (j.paidAt || j.cancelled || now - Date.parse(j.openedAt) > 3_600_000) continue;
    if (isRenewal(j.input)) { const b = boxes.get(j.input.renews); if (b && j.input.gb) total += Math.max(0, j.input.gb * GB - b.quotaBytes); }
    else total += j.input.gb * GB;
  }
  return total;
}

/** Can this job be opened now, against the boxes and the node's capacity? */
export function boxProblem(x: SealedInput, boxes: Map<string, Box>, jobs: readonly SealedJob[], now: number, s: SealedSettings, used: (boxId: string) => number): string | null {
  const reserved = reservedBytes(boxes, jobs, now);
  if (isRenewal(x)) {
    const b = boxes.get(x.renews);
    if (!b) return 'No box with that id on this node.';
    if (b.state === 'unpaid') return 'That box has not been paid for yet: pay its opening job first.';
    if (b.state === 'expired') return 'That box is past its grace period and its bytes are deleted: open a new box.';
    if (x.gb !== undefined && x.gb * GB < used(b.boxId)) return `The box already holds ${(used(b.boxId) / GB).toFixed(2)} GB: purge versions first or keep a larger quota.`;
    const extra = x.gb !== undefined ? Math.max(0, x.gb * GB - b.quotaBytes) : 0;
    if (reserved + extra > s.maxGb * GB) return `This node has ${((s.maxGb * GB - reserved) / GB).toFixed(1)} GB left to sell; renew with a smaller quota or keep the current one.`;
    return null;
  }
  if (reserved + x.gb * GB > s.maxGb * GB) return `This node has ${Math.max(0, (s.maxGb * GB - reserved) / GB).toFixed(1)} GB left to sell (it offers ${s.maxGb} GB in all).`;
  return null;
}

/** Can this write be accepted into the box now? `state` is the box's replayed records. */
export async function writeProblem(record: unknown, bytes: { length: number; sha256: string }, box: Box | undefined, state: BoxState, now: number, s: Pick<SealedSettings, 'maxObjectBytes'>, skewMs: number): Promise<{ code: number; error: string } | null> {
  const r = record as SealedRecord;
  const bad = await recordProblem(r);
  if (bad) return { code: 422, error: bad };
  if (r.kind !== 'write') return { code: 422, error: 'This endpoint takes write records; purges go to /purges.' };
  if (!box || box.boxId !== r.boxId) return { code: 404, error: 'No box with that id on this node.' };
  if (box.state !== 'active') return { code: box.state === 'unpaid' ? 402 : 410, error: box.state === 'unpaid' ? 'Pay the box first.' : 'This box is not in a paid period: renew it to write again (reads keep working during the grace period).' };
  if (!box.writers.includes(r.writer)) return { code: 403, error: 'The record\'s writer is not one of this box\'s writers.' };
  if (Math.abs(now - Date.parse(r.writtenAt)) > skewMs) return { code: 422, error: 'The record was signed more than 10 minutes from this node\'s clock: sign it again now.' };
  if (!OBJECT_ID.test(r.objectId)) return { code: 422, error: 'Malformed objectId.' };
  if (bytes.length !== r.size) return { code: 422, error: `The record says ${r.size} bytes; ${bytes.length} arrived.` };
  if (bytes.sha256 !== r.sha256) return { code: 422, error: 'The bytes do not match the record\'s SHA-256.' };
  if (r.size > s.maxObjectBytes) return { code: 413, error: `Objects are limited to ${Math.floor(s.maxObjectBytes / 1024 ** 2)} MB: split larger files into parts.` };
  const h = state.objects.get(r.objectId);
  const head = h?.heads.length === 1 ? h.heads[0].writeId : null;
  if ((h ? head : null) !== r.parent) return { code: 409, error: h ? `The record must name the current version ${head} as its parent.` : 'A new object\'s first version names no parent.' };
  if (state.usedBytes + r.size > box.quotaBytes) return { code: 507, error: `The box's quota is ${(box.quotaBytes / GB).toFixed(0)} GB and it holds ${(state.usedBytes / GB).toFixed(2)} GB: purge versions or renew with a larger quota.` };
  return null;
}

/** Can this purge be accepted? A box in grace may still purge (it frees bytes, adds none). */
export async function purgeProblem(record: unknown, box: Box | undefined, state: BoxState, now: number, skewMs: number): Promise<{ code: number; error: string } | null> {
  const r = record as SealedRecord;
  const bad = await recordProblem(r);
  if (bad) return { code: 422, error: bad };
  if (r.kind !== 'purge') return { code: 422, error: 'This endpoint takes purge records.' };
  if (!box || box.boxId !== r.boxId) return { code: 404, error: 'No box with that id on this node.' };
  if (box.state !== 'active' && box.state !== 'grace') return { code: 410, error: 'This box holds no bytes any more.' };
  if (!box.writers.includes(r.writer)) return { code: 403, error: 'The record\'s writer is not one of this box\'s writers.' };
  if (Math.abs(now - Date.parse(r.writtenAt)) > skewMs) return { code: 422, error: 'The record was signed more than 10 minutes from this node\'s clock: sign it again now.' };
  const target = [...state.objects.values()].flatMap((o) => o.versions).find((v) => v.writeId === r.writeId);
  if (!target) return { code: 404, error: 'This box holds no such version.' };
  if (target.purged) return { code: 409, error: 'That version is already purged.' };
  return null;
}
