/**
 * COPE node crystallized. Node ID: v15-38-00-payee-confirmation.
 * Provenance: m/44'/144'/100'/principles/cope/v1#marketplace
 *
 * Payee confirmation: before a large payment, confirm that the instructions
 * you were given are the ones the payee declared — not just that the
 * address exists. Payment-instruction fraud (a spoofed or hijacked email
 * with "updated wiring instructions", an address poisoned into your
 * history) succeeds because the instructions arrive on a channel the payee
 * never signed. Here they come from the payee instead:
 *
 * 1. Declared: the payee's party publishes the instrument (an XRPL address
 *    and tag, or the salted digest of a bank account — the number itself is
 *    never published) on the market's public log. The mirror binds every
 *    party to its first author, so only the payee's account can declare.
 * 2. Endorsed: the payee's own XRPL wallet (the profile's account) sends a
 *    no-op AccountSet whose memo names the declaration's hash. A hijacked
 *    sign-in alone cannot do that; the ledger timestamps it and nobody can
 *    back-date it. An anchor from the instrument address itself also proves
 *    control of that address.
 * 3. In force after a cooling period (72 hours by default) from the later of
 *    the endorsement and the time the profile took that wallet, so a payee
 *    whose account or wallet is taken over has days, in public, to revoke.
 *    Revoking needs no anchor: stopping a payment is always safe.
 *
 * The check then answers, for one payer, payee and instrument: is it
 * declared by that payee and nobody else, endorsed, past its cooling period,
 * not revoked, superseded or expired; did you pay this payee somewhere else
 * before (changed instructions); does it look like an address you paid but
 * differ (address poisoning); and every counterparty-check fact for an XRPL
 * address. The verdict is ok / warn / stop with reasons; the binding is its
 * own lifecycle state; log facts, ledger facts and your history stay in
 * separate fields. A fact that could not be read is unreadable, never fine.
 */
import { ed25519 } from '@noble/curves/ed25519';
import { isValidClassicAddress } from 'xrpl';
import type { LedgerTx, XrplNetwork } from '../xrpl/ledgerCheck';
import { normalizeTx } from '../xrpl/ledgerCheck';
import { rpcLedgerTx, xrplRpc } from '../xrpl/xrplRpc';
import { marketLedger, type MarketTx, type MarketTxLike } from './ledger';
import { partyAddress, payeeInstructionsAddress } from './MarketplacePaths';
import type { MarketState } from './replay';
import { canonicalJson, runCounterpartyCheck, type CheckReport, type Reason } from './counterpartyCheck';
import type { Currency } from './types';

// ─── Content ──────────────────────────────────────────────────────

export type PayeeInstrument =
  | { kind: 'xrpl'; address: string; destinationTag?: number }
  /** A bank account by salted digest only (bankAccountDigest); `hint` is display text such as "First Bank ••1234". */
  | { kind: 'bank'; salt: string; digest: string; hint: string };

export interface PayeeInstructionsContent {
  instructionsId: string;
  partyId: string;
  /** The market (XRPL network) the declaration is for. */
  network: XrplNetwork;
  instrument: PayeeInstrument;
  /** Display only, never parsed ("Land purchase, Block 12 Lot 3"). */
  purpose?: string;
  validFrom: string;
  /** null = until revoked or superseded (JSON has no Infinity). */
  validUntil: string | null;
  /** Earlier declarations of this party that this one replaces. */
  supersedes?: string[];
}

/** Ledger memo type of an endorsement anchor; its data is `<instructionsId>:<instructionsHash>`. */
export const PAYEE_ANCHOR_MEMO = 'cappz-payee';
export const DEFAULT_COOLING_HOURS = 72;
export const MIN_COOLING_HOURS = 24;
/** A payee party younger than this is flagged: fraudsters register lookalike payees shortly before they strike. */
export const NEW_PAYEE_DAYS = 30;
const HOUR = 3_600_000; const DAY = 24 * HOUR;
const enc = new TextEncoder();
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
const sha256 = async (s: string) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))));

/** The hash an endorsement anchor names: SHA-256 of the canonical JSON of the declaration. */
export const instructionsHash = (c: PayeeInstructionsContent): Promise<string> => sha256(canonicalJson(c));

/** Bank account numbers compared without punctuation or spaces, upper case (IBANs carry letters). */
const normBank = (s: string) => s.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
/**
 * Salted digest of a bank account: what is published and compared, never the number. It resists casual reading, not a
 * determined search of the number space (account numbers are short, and printed on every cheque anyway).
 */
export const bankAccountDigest = (salt: string, routing: string, account: string): Promise<string> => sha256(`cappz-payee-bank|${salt}|${normBank(routing)}|${normBank(account)}`);

/** Problems with a declaration (empty = fine). */
export function instructionsProblems(c: PayeeInstructionsContent): string[] {
  const p: string[] = [];
  if (!/^pi-[0-9a-f]{12}$/.test(c.instructionsId)) p.push('instructionsId is pi- and 12 hex characters.');
  if (!c.partyId) p.push('partyId is required.');
  const i = c.instrument;
  if (i?.kind === 'xrpl') {
    if (!isValidClassicAddress(i.address)) p.push(`${i.address} is not an XRPL classic address.`);
    if (i.destinationTag !== undefined && !(Number.isInteger(i.destinationTag) && i.destinationTag >= 0 && i.destinationTag <= 0xffffffff)) p.push('destinationTag is a whole number from 0 to 4294967295.');
  } else if (i?.kind === 'bank') {
    if (!/^[0-9a-f]{32}$/.test(i.salt)) p.push('A bank instrument carries a 16-byte hex salt.');
    if (!/^[0-9a-f]{64}$/.test(i.digest)) p.push('A bank instrument carries a SHA-256 digest (bankAccountDigest), never the account number.');
    if (!i.hint?.trim() || i.hint.length > 80) p.push('Give the bank account a short hint (up to 80 characters), e.g. "First Bank ••1234".');
    if (/\d{5,}/.test(i.hint ?? '')) p.push('The hint shows at most four digits of the account in a row.');
  } else p.push('instrument is {kind: "xrpl", address, destinationTag?} or {kind: "bank", salt, digest, hint}.');
  if (Number.isNaN(Date.parse(c.validFrom))) p.push('validFrom is an ISO date.');
  if (c.validUntil !== null && (Number.isNaN(Date.parse(c.validUntil)) || Date.parse(c.validUntil) <= Date.parse(c.validFrom))) p.push('validUntil is null (until revoked) or an ISO date after validFrom.');
  if (c.purpose !== undefined && c.purpose.length > 200) p.push('purpose is at most 200 characters.');
  if (c.supersedes !== undefined && (!Array.isArray(c.supersedes) || c.supersedes.length > 16)) p.push('supersedes lists at most 16 earlier declarations.');
  return p;
}

// ─── Writes (the payee's own) ─────────────────────────────────────

const tx = (eventType: MarketTx['eventType'], sourceAddress: string, targetAddress: string, payload: Record<string, unknown>) => marketLedger.create({ eventType, sourceAddress, targetAddress, payload });
export const newInstructionsId = () => `pi-${hex(crypto.getRandomValues(new Uint8Array(6)))}`;
export const newBankSalt = () => hex(crypto.getRandomValues(new Uint8Array(16)));

/** Declare payment instructions as `partyId` (written from the party's own address; the mirror attributes the author). */
export async function buildPayeeInstructions(state: MarketState, partyId: string, content: PayeeInstructionsContent): Promise<{ txs: MarketTx[]; hash: string }> {
  if (!state.parties.has(partyId)) throw new Error('Set up your marketplace profile first.');
  if (content.partyId !== partyId) throw new Error('You can only declare your own payment instructions.');
  const p = instructionsProblems(content);
  if (p.length) throw new Error(p.join(' '));
  return { txs: [await tx('ContentCreated', partyAddress(partyId), payeeInstructionsAddress(partyId, content.instructionsId), { contentClass: 'payee-instructions', instructions: content })], hash: await instructionsHash(content) };
}

/** Record where an endorsement anchor is on the ledger (the check verifies it there; the record is only a pointer). */
export async function buildPayeeAnchor(partyId: string, instructionsId: string, txHash: string): Promise<MarketTx[]> {
  if (!/^[0-9A-Fa-f]{64}$/.test(txHash)) throw new Error('An XRPL transaction hash is 64 hex characters.');
  return [await tx('ContentAmended', partyAddress(partyId), `${payeeInstructionsAddress(partyId, instructionsId)}/anchors/${txHash.slice(0, 16).toUpperCase()}`, { contentClass: 'payee-instructions-anchor', instructionsId, txHash: txHash.toUpperCase() })];
}

/** Revoke a declaration at once (no anchor needed: stopping payments is always safe). */
export async function buildPayeeRevocation(partyId: string, instructionsId: string, reason: string): Promise<MarketTx[]> {
  return [await tx('ContentAmended', partyAddress(partyId), `${payeeInstructionsAddress(partyId, instructionsId)}/revocation`, { contentClass: 'payee-instructions-revoked', instructionsId, reason: reason.slice(0, 200) })];
}

/** The unsigned AccountSet that endorses a declaration: no flags, no reserve, only the network fee. The signer's wallet adds Fee and Sequence. */
export function prepareEndorsement(account: string, instructionsId: string, hash: string): Record<string, unknown> {
  const h = (s: string) => hex(enc.encode(s)).toUpperCase();
  return { TransactionType: 'AccountSet', Account: account, Memos: [{ Memo: { MemoType: h(PAYEE_ANCHOR_MEMO), MemoData: h(`${instructionsId}:${hash}`) } }] };
}

// ─── Replay ───────────────────────────────────────────────────────

export interface DeclarationView {
  content: PayeeInstructionsContent;
  hash: string;
  declaredAt: string;
  /** Anchor transaction hashes the payee recorded (verified on the ledger by the check, never trusted from here). */
  anchorTxs: string[];
  revoked: { at: string; reason: string } | null;
  supersededBy: { instructionsId: string; at: string } | null;
}
export interface PayeeLog {
  partyId: string;
  name: string | null;
  firstSeen: string | null;
  /** The profile's XRPL account over time (each change starts a new cooling period). */
  walletHistory: Array<{ account: string | null; since: string }>;
  declarations: DeclarationView[];
}

const p = <T,>(t: MarketTxLike) => t.payload as unknown as T;
const order = (txs: readonly MarketTxLike[]) => [...txs].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.txId.localeCompare(b.txId));

/** Every party's payment instructions, replayed from the (attributed) public log. Only a party's own entries count. */
export async function resolvePayeeLogs(txs: readonly MarketTxLike[]): Promise<Map<string, PayeeLog>> {
  const logs = new Map<string, PayeeLog>();
  const logOf = (id: string) => { let l = logs.get(id); if (!l) { l = { partyId: id, name: null, firstSeen: null, walletHistory: [], declarations: [] }; logs.set(id, l); } return l; };
  for (const t of order(txs)) {
    if (t.eventType !== 'ContentCreated' && t.eventType !== 'ContentAmended') continue;
    const cls = (t.payload as { contentClass?: string }).contentClass;
    if (cls === 'party') {
      const prof = p<{ profile: { partyId: string; name: string; xrplAccount?: string } }>(t).profile;
      if (!prof?.partyId || t.sourceAddress !== partyAddress(prof.partyId)) continue;
      const l = logOf(prof.partyId); l.name = prof.name; l.firstSeen ??= t.timestamp;
      const acct = prof.xrplAccount ?? null;
      if (l.walletHistory.at(-1)?.account !== acct) l.walletHistory.push({ account: acct, since: t.timestamp });
      continue;
    }
    if (cls !== 'payee-instructions' && cls !== 'payee-instructions-anchor' && cls !== 'payee-instructions-revoked') continue;
    if (cls === 'payee-instructions') {
      const c = p<{ instructions: PayeeInstructionsContent }>(t).instructions;
      if (!c?.partyId || t.sourceAddress !== partyAddress(c.partyId) || instructionsProblems(c).length) continue;
      const l = logOf(c.partyId);
      if (l.declarations.some((d) => d.content.instructionsId === c.instructionsId)) continue; // one declaration per id: never rewritten
      for (const old of c.supersedes ?? []) { const d = l.declarations.find((x) => x.content.instructionsId === old); if (d && !d.supersededBy) d.supersededBy = { instructionsId: c.instructionsId, at: t.timestamp }; }
      l.declarations.push({ content: c, hash: await instructionsHash(c), declaredAt: t.timestamp, anchorTxs: [], revoked: null, supersededBy: null });
      continue;
    }
    const v = p<{ instructionsId: string; txHash?: string; reason?: string }>(t);
    const owner = [...logs.values()].find((l) => t.sourceAddress === partyAddress(l.partyId));
    const d = owner?.declarations.find((x) => x.content.instructionsId === v.instructionsId);
    if (!d) continue;
    if (cls === 'payee-instructions-anchor' && typeof v.txHash === 'string' && /^[0-9A-F]{64}$/.test(v.txHash) && d.anchorTxs.length < 8 && !d.anchorTxs.includes(v.txHash)) d.anchorTxs.push(v.txHash);
    if (cls === 'payee-instructions-revoked' && !d.revoked) d.revoked = { at: t.timestamp, reason: String(v.reason ?? '') };
  }
  return logs;
}

// ─── Ledger facts ─────────────────────────────────────────────────

export interface AnchorFacts {
  txHash: string;
  account: string | null;
  validated: boolean | null;
  result: string | null;
  closeTime: string | null;
  /** The anchor memo's `<instructionsId>:<hash>`, if the transaction carries one. */
  memo: string | null;
  error: string | null;
}

export async function readAnchor(network: XrplNetwork, txHash: string, fetcher: typeof fetch = fetch): Promise<AnchorFacts> {
  try {
    return anchorFactsOf(await rpcLedgerTx(network, txHash, fetcher));
  } catch (e) { return { txHash, account: null, validated: null, result: null, closeTime: null, memo: null, error: (e as Error).message }; }
}
export const anchorFactsOf = (lt: LedgerTx): AnchorFacts => ({ txHash: lt.hash.toUpperCase(), account: lt.account || null, validated: lt.validated, result: lt.result || null, closeTime: lt.closeTime, memo: lt.memos.find((m) => m.type === PAYEE_ANCHOR_MEMO)?.data ?? null, error: null });

export interface PaidBefore { destination: string; destinationTag: number | null; at: string | null; txHash: string }
export interface PayerHistory { account: string; payments: PaidBefore[]; truncated: boolean; error: string | null }

/** The payer's recent outgoing XRP and token payments (public reads; up to `max` transactions). */
export async function readPayerHistory(network: XrplNetwork, account: string, max = 400, fetcher: typeof fetch = fetch): Promise<PayerHistory> {
  const payments: PaidBefore[] = []; let marker: unknown; let seen = 0;
  try {
    do {
      const r = await xrplRpc<{ transactions?: Array<Record<string, unknown>>; marker?: unknown }>(network, 'account_tx', { account, limit: Math.min(200, max - seen), forward: false, ...(marker ? { marker } : {}) }, fetcher);
      for (const e of r.transactions ?? []) {
        seen++;
        const t = (e.tx_json ?? e.tx ?? {}) as Record<string, unknown>;
        const lt = normalizeTx({ ...e, tx_json: t, hash: e.hash ?? t.hash, validated: e.validated ?? true }, network, new Date().toISOString());
        if (lt.type === 'Payment' && lt.account === account && lt.destination && lt.result === 'tesSUCCESS') payments.push({ destination: lt.destination, destinationTag: lt.destinationTag, at: lt.closeTime, txHash: lt.hash });
      }
      marker = r.marker;
    } while (marker && seen < max);
    return { account, payments, truncated: Boolean(marker), error: null };
  } catch (e) { return { account, payments, truncated: false, error: (e as Error).message }; }
}

// ─── The check ────────────────────────────────────────────────────

export type PayeeInstrumentQuery =
  | { kind: 'xrpl'; address: string; destinationTag?: number }
  /** One digest per declared bank instrument, computed on the payer's device with that declaration's salt (the number never leaves it). */
  | { kind: 'bank'; digests: string[] };

export interface PayeeConfirmRequest {
  network: XrplNetwork;
  /** The payee's party id — taken from your contract or an earlier, trusted exchange, never from the message carrying the instructions. */
  payee: string;
  instrument: PayeeInstrumentQuery;
  /** Your own address: your payment history is checked for changed instructions and lookalike addresses. */
  payer?: string;
  amount?: number;
  currency?: Currency;
  /** The deal this pays: the payee must be its seller. */
  contractId?: string;
  /** Hours a new endorsement waits before it is in force (default 72, at least 24). */
  coolingHours?: number;
}

export type BindingState = 'unknown-payee' | 'no-instructions' | 'declared-by-other' | 'not-declared' | 'revoked' | 'superseded' | 'expired' | 'not-yet-valid' | 'unanchored' | 'anchor-unreadable' | 'cooling' | 'confirmed';
export type ControlState = 'address-key' | 'payee-wallet-only' | 'not-applicable';

export interface Binding {
  state: BindingState;
  instructionsId: string | null;
  instructionsHash: string | null;
  declaredAt: string | null;
  /** The validated endorsement from the payee's profile wallet (ledger close time) and that wallet. */
  endorsedAt: string | null;
  endorsedBy: string | null;
  /** XRPL instruments: whether the address itself signed an anchor too. */
  control: ControlState | null;
  /** When the declaration is (or will be) in force: the later of endorsement and the wallet's arrival on the profile, plus the cooling period. */
  inForceFrom: string | null;
  coolingHours: number;
  because: string;
}

export interface PayeeFacts {
  now: string;
  coolingHours: number;
  party: { partyId: string; exists: boolean; name: string | null; firstSeen: string | null; sameName: string[] };
  log: PayeeLog | null;
  /** Declarations by other parties of the same XRPL address and tag. */
  otherDeclarers: string[];
  anchors: AnchorFacts[];
  payer: PayerHistory | null;
  contract: { contractId: string; found: boolean; sellerId: string | null; buyerId: string | null } | null;
  counterparty: Pick<CheckReport, 'verdict' | 'reasons' | 'ledger' | 'payer' | 'asset'> | null;
}

export interface PayeeReport {
  kind: 'cappz-payee-confirmation';
  version: 1;
  network: XrplNetwork;
  checkedAt: string;
  subject: { payee: string; instrument: { kind: 'xrpl'; address: string; destinationTag: number | null } | { kind: 'bank'; hint: string | null; matched: boolean } ; amount: number | null; currency: Currency | null; contractId: string | null };
  verdict: 'ok' | 'warn' | 'stop';
  binding: Binding;
  reasons: Reason[];
  /** What the log says (declarations of this payee), what the ledger says (anchors), what your history says, kept apart. */
  /** Each declaration of the payee: the matched one with its full state; the others by revocation, replacement and expiry only (their anchors are not read). */
  log: { payeeName: string | null; payeeSince: string | null; declarations: Array<{ instructionsId: string; instrument: string; declaredAt: string; state: BindingState | 'not-checked' }>; otherDeclarers: string[] };
  ledger: { anchors: AnchorFacts[] };
  payerHistory: { account: string; paidThisBefore: PaidBefore | null; paidPayeeElsewhere: PaidBefore | null; truncated: boolean; error: string | null } | null;
  counterparty: PayeeFacts['counterparty'];
  advice: string[];
  rules: string;
}

const tagOf = (t: number | null | undefined) => (t === undefined ? null : t);
const sameXrpl = (i: PayeeInstrument, a: string, tag: number | null) => i.kind === 'xrpl' && i.address === a && tagOf(i.destinationTag) === tag;
const describe = (i: PayeeInstrument) => (i.kind === 'xrpl' ? `XRPL ${i.address}${i.destinationTag !== undefined ? ` tag ${i.destinationTag}` : ''}` : `bank ${i.hint}`);
const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Two different addresses that share their first five and last four characters: the shape of an address-poisoning lure. */
export function lookalike(a: string, b: string): boolean {
  return a !== b && a.length > 9 && b.length > 9 && a.slice(0, 5) === b.slice(0, 5) && a.slice(-4) === b.slice(-4);
}

/** The match for the query among the payee's declarations (null = not declared). */
export function matchDeclaration(log: PayeeLog | null, q: PayeeInstrumentQuery): DeclarationView | null {
  const ds = log?.declarations ?? [];
  const hits = q.kind === 'xrpl'
    ? ds.filter((d) => sameXrpl(d.content.instrument, q.address, tagOf(q.destinationTag)))
    : ds.filter((d) => d.content.instrument.kind === 'bank' && q.digests.includes(d.content.instrument.digest));
  // The newest one still standing; otherwise the newest (so its revocation or replacement is what the report says).
  return [...hits].reverse().find((d) => !d.revoked && !d.supersededBy) ?? hits.at(-1) ?? null;
}

/** The profile wallet in effect at `at`, and since when. */
const walletAt = (log: PayeeLog, at: string) => [...log.walletHistory].reverse().find((w) => Date.parse(w.since) <= Date.parse(at)) ?? null;

/** Lifecycle of one declaration given its anchors (pure). */
export function bindingOf(d: DeclarationView, log: PayeeLog, anchors: readonly AnchorFacts[], now: string, coolingHours: number): Binding {
  const base: Binding = { state: 'unanchored', instructionsId: d.content.instructionsId, instructionsHash: d.hash, declaredAt: d.declaredAt, endorsedAt: null, endorsedBy: null, control: d.content.instrument.kind === 'bank' ? 'not-applicable' : null, inForceFrom: null, coolingHours, because: '' };
  if (d.revoked) return { ...base, state: 'revoked', because: `The payee revoked these instructions on ${d.revoked.at.slice(0, 10)}${d.revoked.reason ? `: ${d.revoked.reason}` : ''}.` };
  if (d.supersededBy) return { ...base, state: 'superseded', because: `The payee replaced these instructions with ${d.supersededBy.instructionsId} on ${d.supersededBy.at.slice(0, 10)}.` };
  if (d.content.validUntil !== null && Date.parse(d.content.validUntil) <= Date.parse(now)) return { ...base, state: 'expired', because: `These instructions expired on ${d.content.validUntil.slice(0, 10)}.` };
  const memo = `${d.content.instructionsId}:${d.hash}`;
  const mine = anchors.filter((a) => d.anchorTxs.includes(a.txHash));
  const valid = mine.filter((a) => !a.error && a.validated && a.result === 'tesSUCCESS' && a.memo === memo && a.closeTime);
  const current = log.walletHistory.at(-1) ?? null;
  // Endorsement: from the wallet the profile names now, which it already named when the anchor closed.
  const endorsement = valid.filter((a) => current?.account && a.account === current.account && walletAt(log, a.closeTime!)?.account === current.account).sort((x, y) => x.closeTime!.localeCompare(y.closeTime!))[0];
  const i = d.content.instrument;
  const control: ControlState | null = i.kind === 'bank' ? 'not-applicable' : valid.some((a) => a.account === i.address) ? 'address-key' : 'payee-wallet-only';
  if (!endorsement) {
    if (mine.some((a) => a.error)) return { ...base, control, state: 'anchor-unreadable', because: 'The endorsement could not be read from the ledger just now; nothing is confirmed.' };
    const why = !current?.account ? 'The payee\'s profile names no XRPL wallet to endorse with.'
      : valid.length ? `The anchors are not from the payee's profile wallet ${current.account} (or it was set on the profile after they were made).`
      : mine.length ? 'The recorded anchors are not validated AccountSet transactions naming this declaration\'s hash.'
      : 'The payee declared these instructions but never endorsed them from their wallet.';
    return { ...base, control, state: 'unanchored', because: why };
  }
  const start = Math.max(Date.parse(endorsement.closeTime!), Date.parse(current!.since));
  const inForceFrom = new Date(start + coolingHours * HOUR).toISOString();
  const b = { ...base, control, endorsedAt: endorsement.closeTime, endorsedBy: endorsement.account, inForceFrom };
  if (Date.parse(d.content.validFrom) > Date.parse(now)) return { ...b, state: 'not-yet-valid', because: `These instructions apply from ${d.content.validFrom.slice(0, 10)}.` };
  if (Date.parse(inForceFrom) > Date.parse(now)) return { ...b, state: 'cooling', because: `Endorsed ${endorsement.closeTime!.slice(0, 16).replace('T', ' ')} UTC; in force from ${inForceFrom.slice(0, 16).replace('T', ' ')} UTC after the ${coolingHours}-hour cooling period.` };
  return { ...b, state: 'confirmed', because: `Declared by the payee and endorsed from their wallet ${endorsement.account} on ${endorsement.closeTime!.slice(0, 10)}; in force since ${inForceFrom.slice(0, 10)}.` };
}

const STOP_TEXT: Record<Exclude<BindingState, 'confirmed'>, string> = {
  'unknown-payee': 'There is no such payee on this market. Get the payee id from your contract, not from the message with the instructions.',
  'no-instructions': 'The payee has declared no payment instructions. Ask them to declare and endorse them (cappz-market payee declare), then wait out the cooling period.',
  'declared-by-other': 'These instructions belong to a different party, not the payee you named. This is the shape of payment-instruction fraud.',
  'not-declared': 'The payee never declared these instructions. Treat them as fraudulent until the payee declares them from their own account and wallet.',
  revoked: 'The payee revoked these instructions.',
  superseded: 'The payee replaced these instructions with newer ones.',
  expired: 'These instructions have expired.',
  'not-yet-valid': 'These instructions are not valid yet.',
  unanchored: 'The payee has not endorsed these instructions from their wallet, so a hijacked sign-in alone could have declared them.',
  'anchor-unreadable': 'The endorsement could not be read from the ledger just now.',
  cooling: 'These instructions are new and still in their cooling period: if the payee\'s account was taken over, this is the window in which they revoke.',
};

/** The rules: pure over the facts in a report, so anyone can re-run them and get the same verdict. */
export function judgePayee(req: PayeeConfirmRequest, f: PayeeFacts): { binding: Binding; reasons: Reason[]; match: DeclarationView | null } {
  const r: Reason[] = [];
  const empty: Binding = { state: 'unknown-payee', instructionsId: null, instructionsHash: null, declaredAt: null, endorsedAt: null, endorsedBy: null, control: null, inForceFrom: null, coolingHours: f.coolingHours, because: '' };
  let binding: Binding; let match: DeclarationView | null = null;
  if (!f.party.exists) binding = { ...empty, because: `No party ${req.payee} on the ${req.network} market.` };
  else if (!f.log?.declarations.length) binding = { ...empty, state: 'no-instructions', because: 'The payee has declared no payment instructions on this market.' };
  else {
    match = matchDeclaration(f.log, req.instrument);
    if (!match && f.otherDeclarers.length) binding = { ...empty, state: 'declared-by-other', because: `These instructions were declared by ${f.otherDeclarers.join(', ')}, not by ${req.payee}.` };
    else if (!match) binding = { ...empty, state: 'not-declared', because: `None of the payee's ${f.log.declarations.length} declaration(s) matches these instructions.` };
    else binding = bindingOf(match, f.log, f.anchors, f.now, f.coolingHours);
  }
  if (binding.state !== 'confirmed') r.push({ level: 'stop', code: `payee-${binding.state}`, text: `${STOP_TEXT[binding.state]} ${binding.because}`.trim() });
  else r.push({ level: 'info', code: 'payee-confirmed', text: binding.because });
  if (binding.state === 'confirmed' && binding.control === 'payee-wallet-only') r.push({ level: 'warn', code: 'control-not-proven', text: 'The payee endorsed this address from their own wallet, but the address itself has not signed an anchor. That is normal for an exchange deposit address with the payee\'s tag; otherwise ask the payee to anchor from the address too.' });
  if (match && match.content.instrument.kind === 'bank') r.push({ level: 'info', code: 'bank-holder-unverified', text: 'CAPPZ confirms the payee declared and endorsed this bank account; only the bank can confirm the account holder\'s name. Ask your bank for an account-name check as well.' });
  if (f.otherDeclarers.length && match) r.push({ level: 'warn', code: 'also-declared-by-other', text: `The same address and tag were also declared by ${f.otherDeclarers.join(', ')}.` });
  if (f.party.exists && f.party.firstSeen && (Date.parse(f.now) - Date.parse(f.party.firstSeen)) / DAY < NEW_PAYEE_DAYS) r.push({ level: 'warn', code: 'payee-new', text: `The payee's party is new on this market (since ${f.party.firstSeen.slice(0, 10)}). Make sure it is the party in your contract, not a lookalike.` });
  if (f.party.sameName.length) r.push({ level: 'warn', code: 'payee-name-shared', text: `Other parties use the same name (${f.party.sameName.join(', ')}). Identify the payee by its id from your contract.` });
  const log = f.log;
  if (log && log.walletHistory.length > 1) {
    const last = log.walletHistory.at(-1)!;
    if ((Date.parse(f.now) - Date.parse(last.since)) / HOUR < f.coolingHours) r.push({ level: 'warn', code: 'payee-wallet-changed', text: `The payee changed the XRPL wallet on their profile on ${last.since.slice(0, 10)}; endorsements from it wait out the cooling period from then.` });
  }
  if (f.contract) {
    if (!f.contract.found) r.push({ level: 'stop', code: 'contract-unknown', text: `No contract ${f.contract.contractId} on this market.` });
    else if (f.contract.sellerId !== req.payee) r.push({ level: 'stop', code: 'not-contract-seller', text: `${req.payee} is not the seller on ${f.contract.contractId} (the seller is ${f.contract.sellerId}).` });
    else r.push({ level: 'info', code: 'contract-seller', text: `${req.payee} is the seller on ${f.contract.contractId}.` });
  }
  if (f.payer) {
    if (f.payer.error) r.push({ level: 'warn', code: 'payer-history-unreadable', text: `Your payment history could not be read (${f.payer.error}): changed instructions and lookalike addresses were not checked.` });
    else if (req.instrument.kind === 'xrpl') {
      const q = req.instrument; const tag = tagOf(q.destinationTag);
      const before = f.payer.payments.find((x) => x.destination === q.address && x.destinationTag === tag);
      if (before) r.push({ level: 'info', code: 'paid-before', text: `You paid this address${tag !== null ? ' and tag' : ''} before (${before.at?.slice(0, 10) ?? 'date unknown'}).` });
      const declared = new Set((log?.declarations ?? []).flatMap((d) => (d.content.instrument.kind === 'xrpl' ? [d.content.instrument.address] : [])));
      const elsewhere = f.payer.payments.find((x) => declared.has(x.destination) && !(x.destination === q.address && x.destinationTag === tag));
      if (elsewhere && !before) r.push({ level: 'warn', code: 'instructions-changed', text: `You last paid this payee at ${elsewhere.destination}${elsewhere.destinationTag !== null ? ` tag ${elsewhere.destinationTag}` : ''} (${elsewhere.at?.slice(0, 10) ?? 'date unknown'}); these instructions are different. Confirm the change with the payee on a phone number you already had.` });
      const known = [...new Set([...f.payer.payments.map((x) => x.destination), ...declared])];
      const twin = known.find((a) => lookalike(a, q.address));
      if (twin) r.push({ level: 'stop', code: 'lookalike-address', text: `${q.address} looks like ${twin} (same first five and last four characters) but is a different address: the shape of address poisoning. Copy the address from the payee's declaration, never from your history.` });
    }
  }
  if (f.counterparty) for (const c of f.counterparty.reasons) if (!r.some((x) => x.code === c.code)) r.push(c);
  return { binding, reasons: r, match };
}

const verdictOf = (rs: readonly Reason[]): PayeeReport['verdict'] => (rs.some((x) => x.level === 'stop') ? 'stop' : rs.some((x) => x.level === 'warn') ? 'warn' : 'ok');

/** Fixed advice by verdict: the controls that would have stopped a misdirected payment even when every check passed. */
export function adviceFor(verdict: PayeeReport['verdict'], kind: 'xrpl' | 'bank'): string[] {
  const a = ['Keep this signed report with the payment record.', 'Have a second person approve the payment against this report — one person should never both confirm instructions and release money.'];
  if (verdict === 'stop') return ['Do not pay.', 'Call the payee on a phone number you already had (from the contract or an earlier invoice) — never one in the message that carried the instructions.', ...a.slice(1)];
  if (kind === 'xrpl') a.push('For a large amount, send a small first payment and have the payee confirm the amount back before sending the rest — or pay into a conditional ledger escrow with a CancelAfter, finished only after the payee confirms.');
  else a.push('For a large wire, send a small first transfer and have the payee confirm the amount back before sending the rest.');
  return a;
}

/** Gather the facts (log replay, anchors, payer history, counterparty check) and run the rules. */
export async function runPayeeConfirmation(req: PayeeConfirmRequest, state: MarketState | null, txs: readonly MarketTxLike[], now = new Date().toISOString(), fetcher: typeof fetch = fetch): Promise<PayeeReport> {
  const coolingHours = Math.max(MIN_COOLING_HOURS, Math.round(req.coolingHours ?? DEFAULT_COOLING_HOURS));
  const logs = await resolvePayeeLogs(txs);
  const log = logs.get(req.payee) ?? null;
  const prof = state?.parties.get(req.payee) ?? null;
  const name = prof?.name ?? log?.name ?? null;
  const sameName = name ? [...(state?.parties.values() ?? [])].filter((x) => x.partyId !== req.payee && normName(x.name) === normName(name) && normName(name).length > 0).map((x) => x.partyId) : [];
  const q = req.instrument;
  const otherDeclarers = q.kind === 'xrpl' ? [...logs.values()].filter((l) => l.partyId !== req.payee && l.declarations.some((d) => !d.revoked && sameXrpl(d.content.instrument, q.address, tagOf(q.destinationTag)))).map((l) => l.partyId) : [];
  const match = matchDeclaration(log, q);
  const anchors = match ? await Promise.all(match.anchorTxs.map((h) => readAnchor(req.network, h, fetcher))) : [];
  const payer = req.payer ? await readPayerHistory(req.network, req.payer, 400, fetcher) : null;
  const c = req.contractId ? state?.contracts.find((k) => k.contractId === req.contractId) ?? null : null;
  let counterparty: PayeeFacts['counterparty'] = null;
  if (q.kind === 'xrpl') {
    const cur = req.currency && req.currency !== 'XRP' ? req.currency : undefined;
    const cp = await runCounterpartyCheck({ network: req.network, address: q.address, ...(req.payer ? { payer: req.payer } : {}), ...(req.amount !== undefined ? (cur ? { currency: cur, amount: req.amount } : { amountXrp: req.amount }) : {}) }, state, now, fetcher);
    counterparty = { verdict: cp.verdict, reasons: cp.reasons, ledger: cp.ledger, payer: cp.payer, ...(cp.asset ? { asset: cp.asset } : {}) };
  }
  const facts: PayeeFacts = {
    now, coolingHours, party: { partyId: req.payee, exists: !!prof || !!log?.firstSeen, name, firstSeen: log?.firstSeen ?? null, sameName }, log, otherDeclarers, anchors, payer,
    contract: req.contractId ? { contractId: req.contractId, found: !!c, sellerId: c?.sellerId ?? null, buyerId: c?.buyerId ?? null } : null, counterparty,
  };
  const { binding, reasons } = judgePayee(req, facts);
  const verdict = verdictOf(reasons);
  const tag = q.kind === 'xrpl' ? tagOf(q.destinationTag) : null;
  const paidThisBefore = payer && q.kind === 'xrpl' ? payer.payments.find((x) => x.destination === q.address && x.destinationTag === tag) ?? null : null;
  const declared = new Set((log?.declarations ?? []).flatMap((d) => (d.content.instrument.kind === 'xrpl' ? [d.content.instrument.address] : [])));
  const paidPayeeElsewhere = payer && q.kind === 'xrpl' ? payer.payments.find((x) => declared.has(x.destination) && !(x.destination === q.address && x.destinationTag === tag)) ?? null : null;
  return {
    kind: 'cappz-payee-confirmation', version: 1, network: req.network, checkedAt: now,
    subject: { payee: req.payee, instrument: q.kind === 'xrpl' ? { kind: 'xrpl', address: q.address, destinationTag: tag } : { kind: 'bank', hint: match?.content.instrument.kind === 'bank' ? match.content.instrument.hint : null, matched: !!match }, amount: req.amount ?? null, currency: req.currency ?? (req.amount !== undefined && q.kind === 'xrpl' ? 'XRP' : null), contractId: req.contractId ?? null },
    verdict, binding, reasons,
    log: { payeeName: name, payeeSince: log?.firstSeen ?? null, declarations: (log?.declarations ?? []).map((d) => ({ instructionsId: d.content.instructionsId, instrument: describe(d.content.instrument), declaredAt: d.declaredAt, state: d === match ? binding.state : d.revoked ? 'revoked' : d.supersededBy ? 'superseded' : d.content.validUntil !== null && Date.parse(d.content.validUntil) <= Date.parse(now) ? 'expired' : 'not-checked' })), otherDeclarers },
    ledger: { anchors },
    payerHistory: payer ? { account: payer.account, paidThisBefore, paidPayeeElsewhere, truncated: payer.truncated, error: payer.error } : null,
    counterparty, advice: adviceFor(verdict, q.kind), rules: 'https://github.com/CAPPZ-ai/cappz-sdk/blob/main/src/lib/marketplace/payeeConfirmation.ts',
  };
}

// ─── Signing ──────────────────────────────────────────────────────

/** Its own signature domain: a payee report can never be replayed as a check report, verdict or approval signed by the same key. */
export const PAYEE_DOMAIN = 'cappz-payee-confirmation/v1\n';
export interface SignedPayeeReport { report: PayeeReport; signature: { alg: 'Ed25519'; publicKey: string; value: string } }

export function signPayeeReport(report: PayeeReport, seedHex: string): SignedPayeeReport {
  const seed = unhex(seedHex);
  return { report, signature: { alg: 'Ed25519', publicKey: hex(ed25519.getPublicKey(seed)), value: hex(ed25519.sign(enc.encode(PAYEE_DOMAIN + canonicalJson(report)), seed)) } };
}

export function verifyPayeeReport(signed: SignedPayeeReport, expectedPublicKey?: string): boolean {
  if (expectedPublicKey && signed.signature.publicKey.toLowerCase() !== expectedPublicKey.toLowerCase()) return false;
  try { return ed25519.verify(unhex(signed.signature.value), enc.encode(PAYEE_DOMAIN + canonicalJson(signed.report)), unhex(signed.signature.publicKey)); } catch { return false; }
}
