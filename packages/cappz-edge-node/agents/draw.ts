/**
 * Fair draw (15.47.0): winners picked from a list by the hash of an XRP Ledger ledger
 * that did not exist when the list was locked. Pure apart from the ledger reader passed
 * in, so tests (and docs/verify.mjs, which repeats it without dependencies) agree.
 *
 * Rule cappz-draw/v1:
 *   entriesSha256 = sha256(UTF-8 of JSON.stringify(entries))   entries: the list as given, in order
 *   seed ledger   = the first validated ledger whose close time is at or after drawAt
 *                   (its close time ≥ drawAt, the ledger before it closed earlier)
 *   seed          = sha256("cappz-draw/v1|<seed ledger hash, upper hex>|<entriesSha256>|<count>|<winners>")
 *   stream        = sha256(seed bytes ‖ uint32 BE counter) for counter 0, 1, …, read as uint32 BE words
 *   uniform(n)    = next word w with w < 2^32 − (2^32 mod n), then w mod n (rejection: no bias)
 *   picks         = partial Fisher–Yates over 0…count−1: for i in 0…winners−1, j = i + uniform(count − i),
 *                   swap positions i and j, pick position i. Picks are 0-based entry indices, first drawn first.
 *
 * Nothing in the seed depends on the commitment, the job or the node: the same list for the same ledger
 * always draws the same winners, so committing the same list twice cannot buy a second chance. A different
 * list (even reordered) is a different commitment, and every commitment is on the node's public log.
 */

export const DRAW_RULE = 'cappz-draw/v1';
export const MAX_INLINE_ENTRIES = 10_000;
export const MAX_ENTRY_CHARS = 200;
export const MAX_HASHED_COUNT = 1_000_000;
export const MAX_WINNERS = 1_000;

const enc = new TextEncoder();
const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b as unknown as ArrayBuffer));

/** The list's fingerprint: SHA-256 of its JSON array, exactly as given (order and spelling count). */
export async function entriesHash(entries: readonly string[]): Promise<string> {
  return toHex(await sha256(enc.encode(JSON.stringify(entries))));
}

/** A text list → entries: one per line, each trimmed, blank lines dropped (the same rule the guide page and verify.mjs use). */
export function entriesFromText(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

export async function drawSeed(seedLedgerHash: string, entriesSha256: string, count: number, winners: number): Promise<string> {
  return toHex(await sha256(enc.encode(`${DRAW_RULE}|${seedLedgerHash.toUpperCase()}|${entriesSha256.toLowerCase()}|${count}|${winners}`)));
}

/** Winners as 0-based indices into the list, first drawn first. */
export async function drawPicks(seedHex: string, count: number, winners: number): Promise<number[]> {
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(winners) || winners < 1 || winners > count) throw new Error('winners must be a whole number from 1 to the number of entries');
  const seed = fromHex(seedHex);
  let counter = 0; let words: number[] = [];
  const nextWord = async () => {
    if (!words.length) {
      const block = new Uint8Array(seed.length + 4); block.set(seed);
      new DataView(block.buffer).setUint32(seed.length, counter++, false);
      const d = new DataView((await sha256(block)).buffer);
      words = Array.from({ length: 8 }, (_, i) => d.getUint32(i * 4, false));
    }
    return words.shift()!;
  };
  const uniform = async (n: number) => {
    const limit = 2 ** 32 - (2 ** 32 % n);
    for (;;) { const w = await nextWord(); if (w < limit) return w % n; }
  };
  const swapped = new Map<number, number>(); const at = (i: number) => swapped.get(i) ?? i;
  const picks: number[] = [];
  for (let i = 0; i < winners; i++) {
    const j = i + await uniform(count - i);
    const a = at(i), b = at(j);
    swapped.set(i, b); swapped.set(j, a);
    picks.push(b);
  }
  return picks;
}

// ─── Finding the seed ledger ─────────────────────────────────────────────────

export interface LedgerHeader { index: number; hash: string; closeTime: string }
export interface DrawLedgerReader {
  /** The latest validated ledger. */
  validated(): Promise<LedgerHeader>;
  /** A validated ledger by index. */
  byIndex(index: number): Promise<LedgerHeader>;
}

/**
 * The first validated ledger whose close time is ≥ drawAt, with the ledger before it.
 * `after` must have closed before drawAt (the commitment records it). Null while no
 * validated ledger has reached drawAt yet. Binary search: about 20 reads for a month.
 */
export async function findSeedLedger(reader: DrawLedgerReader, drawAt: string, after: number): Promise<{ seed: LedgerHeader; previous: LedgerHeader } | null> {
  const t = Date.parse(drawAt);
  const top = await reader.validated();
  if (Date.parse(top.closeTime) < t) return null;
  let lo = after, hi = top.index; // invariant: close(lo) < t ≤ close(hi)
  const low = await reader.byIndex(lo);
  if (!(Date.parse(low.closeTime) < t)) throw new Error(`ledger ${after} closed at ${low.closeTime}, not before the draw time ${drawAt}`);
  let hiHeader = top;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const m = await reader.byIndex(mid);
    if (Date.parse(m.closeTime) < t) lo = mid; else { hi = mid; hiHeader = m; }
  }
  const previous = lo === after ? low : await reader.byIndex(lo);
  return { seed: hiHeader, previous };
}

// ─── Input ───────────────────────────────────────────────────────────────────

export interface DrawInput {
  /** The list itself (each entry is one ticket; list a name twice for two tickets). */
  entries?: string[];
  /** Or only its fingerprint and size: the list stays private until you reveal it. */
  entriesSha256?: string;
  count?: number;
  winners?: number;
  /** ISO time the draw happens at (≤ maxDays ahead). Default, and earliest: the commitment plus the minimum lead. */
  drawAt?: string;
  label?: string;
  /** Serve the result (with the entries, if given) at a public link anyone can check. */
  public?: boolean;
}

/** What is wrong with a draw request, in plain words (null = fine). */
export function drawInputProblem(i: unknown, now: number, maxDays: number): string | null {
  const x = i as DrawInput | null;
  if (!x || typeof x !== 'object' || Array.isArray(x)) return 'input must be an object: {"entries":[…],"winners":1} or {"entriesSha256":"…","count":…,"winners":1}.';
  const hasList = x.entries !== undefined, hasHash = x.entriesSha256 !== undefined;
  if (hasList === hasHash) return 'Give either input.entries (the list) or input.entriesSha256 with input.count (its fingerprint and size), not both.';
  let count: number;
  if (hasList) {
    if (!Array.isArray(x.entries) || !x.entries.length || x.entries.length > MAX_INLINE_ENTRIES) return `input.entries must be a list of 1 to ${MAX_INLINE_ENTRIES} entries (for more, send entriesSha256 and count).`;
    if (x.entries.some((e) => typeof e !== 'string' || !e.length || e.length > MAX_ENTRY_CHARS)) return `Each entry is text of 1 to ${MAX_ENTRY_CHARS} characters.`;
    if (x.count !== undefined && x.count !== x.entries.length) return 'input.count, when given with entries, must equal the number of entries.';
    count = x.entries.length;
  } else {
    if (typeof x.entriesSha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(x.entriesSha256)) return 'input.entriesSha256 must be a SHA-256 in hex (64 characters) of the JSON array of entries.';
    if (!Number.isInteger(x.count) || x.count! < 1 || x.count! > MAX_HASHED_COUNT) return `input.count (how many entries the list has) must be a whole number from 1 to ${MAX_HASHED_COUNT}.`;
    count = x.count!;
  }
  const winners = x.winners ?? 1;
  if (!Number.isInteger(winners) || winners < 1 || winners > Math.min(count, MAX_WINNERS)) return `input.winners must be a whole number from 1 to ${Math.min(count, MAX_WINNERS)}.`;
  if (x.drawAt !== undefined) {
    const t = typeof x.drawAt === 'string' ? Date.parse(x.drawAt) : NaN;
    if (!Number.isFinite(t)) return 'input.drawAt must be an ISO time, e.g. 2026-12-01T20:00:00Z.';
    if (t > now + maxDays * 86_400_000) return `input.drawAt can be at most ${maxDays} days ahead.`;
  }
  if (x.label !== undefined && (typeof x.label !== 'string' || x.label.length > 100)) return 'input.label, when given, is text of at most 100 characters.';
  if (x.public !== undefined && typeof x.public !== 'boolean') return 'input.public, when given, is true or false.';
  return null;
}

/** The draw time a commitment signs: the requested time, but never sooner than minLeadMs after the commitment. */
export function effectiveDrawAt(requested: string | undefined, committedAt: number, minLeadMs: number): string {
  const earliest = committedAt + minLeadMs;
  const t = requested ? Date.parse(requested) : earliest;
  return new Date(Math.max(t, earliest)).toISOString();
}

// ─── Reading ledgers over JSON-RPC ───────────────────────────────────────────

type DrawRpc = (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
const RIPPLE_EPOCH = 946_684_800;

/** A ledger reader on rippled's `ledger` method; only validated ledgers count. */
export function rpcDrawLedgerReader(rpc: DrawRpc): DrawLedgerReader {
  const read = async (ledger_index: number | 'validated'): Promise<LedgerHeader> => {
    const r = await rpc('ledger', { ledger_index, transactions: false, expand: false });
    const l = r.ledger as { ledger_index?: string | number; ledger_hash?: string; hash?: string; close_time?: number; close_time_iso?: string } | undefined;
    if (r.validated !== true || !l) throw new Error(`ledger ${ledger_index} is not validated yet`);
    const hash = String(l.ledger_hash ?? l.hash ?? '').toUpperCase();
    const closeTime = l.close_time_iso ? new Date(l.close_time_iso).toISOString() : typeof l.close_time === 'number' ? new Date((l.close_time + RIPPLE_EPOCH) * 1000).toISOString() : '';
    if (!/^[0-9A-F]{64}$/.test(hash) || !closeTime) throw new Error(`ledger ${ledger_index}: unexpected answer`);
    return { index: Number(l.ledger_index), hash, closeTime };
  };
  return { validated: () => read('validated'), byIndex: (i) => read(i) };
}
