/**
 * COPE node crystallized. Node ID: v15-27-00-counterparty-check.
 * Provenance: m/44'/144'/100'/principles/cope/v1#marketplace
 *
 * Counterparty check: before paying or funding escrow, read what the ledger
 * and the marketplace say about the other side and answer ok / warn / stop
 * with reasons. Facts come from public sources only (the XRPL account and its
 * history; the marketplace's replayed public log); the rules are here, in the
 * open, and the report is signed so it can be kept as evidence.
 *
 * Trust boundaries stay visible: ledger facts, marketplace history and the
 * verdict are separate fields; a missing fact is "unknown", never "fine".
 */
import { ed25519 } from '@noble/curves/ed25519';
import type { XrplNetwork } from '../xrpl/ledgerCheck';
import { xrplRpc, XrplRpcError } from '../xrpl/xrplRpc';
import type { MarketState } from './replay';
import { OWNER_RESERVE_XRP } from './walletFunding';
import { committedKey } from './rules';
import { assetAvailability, assetLabel, isIssuedAsset, type Currency } from './paymentAssets';

export interface CheckRequest {
  network: XrplNetwork;
  /** The XRPL address that will receive the payment (or a marketplace party id via `party`). */
  address?: string;
  /** A marketplace party id; its profile's XRPL account is checked. */
  party?: string;
  /** What you intend to send, in XRP: checks the payer can afford it (with escrow reserves). */
  amountXrp?: number;
  /** Escrow legs the payment will use (default 1; each holds one owner reserve while open). */
  escrowLegs?: number;
  /** Your own address, to check affordability. */
  payer?: string;
  /** The asset to be paid (paymentAssets code, default XRP). Issued tokens (CAPPZ, USD-tokenZ/1) also check trust lines and the issuer. */
  currency?: Currency;
  /** Amount in that asset (issued tokens; XRP uses amountXrp). */
  amount?: number;
}

/** One side's trust line to an issued token's issuer (null fields = not read). */
export interface TrustLineFacts { present: boolean | null; balance: string | null; limit: string | null; frozen: boolean | null; authorized: boolean | null; error: string | null }
export interface AssetFacts {
  code: Currency; label: string; availability: string; issuer: string | null;
  /** Issuer flags that decide whether the token can move at all, and whether it can be escrowed (trust-line locking). */
  issuerFlags: { globalFreeze: boolean; requireAuth: boolean; allowTrustLineLocking: boolean } | null;
  recipient: TrustLineFacts | null;
  payer: TrustLineFacts | null;
  /** Escrow of this token is possible only when the issuer allows trust-line locking; otherwise it is paid stage by stage. */
  escrowable: boolean | null;
}

export type Level = 'stop' | 'warn' | 'info';
export interface Reason { level: Level; code: string; text: string }

export interface AccountFacts {
  address: string;
  activated: boolean | null;
  balanceXrp: number | null;
  ownedObjects: number | null;
  flags: { requireDestinationTag: boolean; depositAuth: boolean; disallowXrp: boolean; masterDisabled: boolean; globalFreeze: boolean } | null;
  regularKey: string | null;
  firstSeen: string | null;
  lastActive: string | null;
  error: string | null;
}

export interface MarketFacts {
  partyIds: string[];
  name: string | null;
  kind: string | null;
  principal: string | null;
  finished: number;
  disputes: number;
  openDisputes: number;
  averageRating: number | null;
  mandate: null | { active: boolean; perContract: string; perDay: string; usedToday: number; expires: string };
}

export interface CheckReport {
  kind: 'cappz-counterparty-check';
  version: 1;
  network: XrplNetwork;
  checkedAt: string;
  ledgerIndex: number | null;
  subject: { address: string | null; party: string | null };
  verdict: 'ok' | 'warn' | 'stop';
  reasons: Reason[];
  ledger: AccountFacts | null;
  payer: (AccountFacts & { spendableXrp: number | null; needsXrp: number | null }) | null;
  market: MarketFacts | null;
  /** Issued-token checks, when the request names one. */
  asset?: AssetFacts;
  rules: string;
}

const LSF = { requireDest: 0x00020000, requireAuth: 0x00040000, disallowXrp: 0x00080000, disableMaster: 0x00100000, globalFreeze: 0x00400000, depositAuth: 0x01000000, allowTrustLineLocking: 0x40000000 };

/** The trust line `account` holds to `issuer` for `currencyHex` (public reads only; a failed read is an error, not "no line"). */
export async function readTrustLine(network: XrplNetwork, account: string, issuer: string, currencyHex: string, fetcher: typeof fetch = fetch): Promise<TrustLineFacts> {
  try {
    const r = await xrplRpc<{ lines?: Array<{ currency: string; balance: string; limit: string; freeze?: boolean; freeze_peer?: boolean; authorized?: boolean; peer_authorized?: boolean }> }>(network, 'account_lines', { account, peer: issuer, ledger_index: 'validated' }, fetcher);
    const line = (r.lines ?? []).find((l) => l.currency.toUpperCase() === currencyHex.toUpperCase());
    if (!line) return { present: false, balance: null, limit: null, frozen: null, authorized: null, error: null };
    return { present: true, balance: line.balance, limit: line.limit, frozen: !!(line.freeze || line.freeze_peer), authorized: line.peer_authorized ?? line.authorized ?? null, error: null };
  } catch (e) {
    if (e instanceof XrplRpcError && e.code === 'actNotFound') return { present: false, balance: null, limit: null, frozen: null, authorized: null, error: null };
    return { present: null, balance: null, limit: null, frozen: null, authorized: null, error: (e as Error).message };
  }
}

/** Issued-token facts for a payment: issuer flags, the recipient's and payer's trust lines. */
export async function readAssetFacts(network: XrplNetwork, code: Currency, recipient: string | null, payer: string | null, fetcher: typeof fetch = fetch): Promise<AssetFacts> {
  const av = assetAvailability(code, network);
  const base: AssetFacts = { code, label: assetLabel(code), availability: av.state, issuer: av.state === 'available' ? av.token?.issuer ?? null : null, issuerFlags: null, recipient: null, payer: null, escrowable: null };
  if (av.state !== 'available' || !av.token) return base;
  const t = av.token;
  try {
    const r = await xrplRpc<{ account_data: Record<string, unknown> }>(network, 'account_info', { account: t.issuer, ledger_index: 'validated' }, fetcher);
    const f = Number(r.account_data.Flags ?? 0);
    base.issuerFlags = { globalFreeze: !!(f & LSF.globalFreeze), requireAuth: !!(f & LSF.requireAuth), allowTrustLineLocking: !!(f & LSF.allowTrustLineLocking) };
    base.escrowable = base.issuerFlags.allowTrustLineLocking;
  } catch { /* issuer unreadable: flags stay null (unknown, not "fine") */ }
  if (recipient) base.recipient = await readTrustLine(network, recipient, t.issuer, t.currencyHex, fetcher);
  if (payer) base.payer = await readTrustLine(network, payer, t.issuer, t.currencyHex, fetcher);
  return base;
}

/** Rules for an issued-token payment (pure). */
export function judgeAsset(a: AssetFacts, amount: number | undefined): Reason[] {
  const r: Reason[] = [];
  if (a.availability !== 'available') { r.push({ level: 'stop', code: 'asset-unavailable', text: `${a.label} is not offered on this network (${a.availability}).` }); return r; }
  if (!a.issuerFlags) r.push({ level: 'warn', code: 'issuer-unreadable', text: `The ${a.label} issuer could not be read; its freeze and authorization settings are unknown.` });
  else {
    if (a.issuerFlags.globalFreeze) r.push({ level: 'stop', code: 'asset-frozen', text: `The ${a.label} issuer has frozen the token: it cannot move.` });
    if (a.issuerFlags.requireAuth && a.recipient?.present && a.recipient.authorized === false) r.push({ level: 'stop', code: 'line-not-authorized', text: `The issuer requires authorized trust lines and the recipient's is not authorized.` });
    r.push({ level: 'info', code: a.issuerFlags.allowTrustLineLocking ? 'asset-escrowable' : 'asset-staged', text: a.issuerFlags.allowTrustLineLocking ? `${a.label} can be escrowed on the ledger (the issuer allows trust-line locking).` : `${a.label} cannot be escrowed (the issuer does not allow trust-line locking): it is paid stage by stage when each stage is accepted.` });
  }
  if (a.recipient) {
    if (a.recipient.error) r.push({ level: 'warn', code: 'recipient-line-unreadable', text: `The recipient's ${a.label} trust line could not be read (${a.recipient.error}).` });
    else if (a.recipient.present === false) r.push({ level: 'stop', code: 'recipient-no-trust-line', text: `The recipient has no ${a.label} trust line: a payment to it fails until it sets one to ${a.issuer}.` });
    else if (a.recipient.frozen) r.push({ level: 'stop', code: 'recipient-line-frozen', text: `The recipient's ${a.label} trust line is frozen.` });
    else if (amount !== undefined && a.recipient.limit !== null && a.recipient.balance !== null && Number(a.recipient.limit) - Number(a.recipient.balance) < amount) r.push({ level: 'stop', code: 'recipient-limit', text: `The recipient's trust line limit leaves room for ${Number(a.recipient.limit) - Number(a.recipient.balance)} ${a.label}; the payment is ${amount}.` });
  }
  if (a.payer) {
    if (a.payer.error) r.push({ level: 'warn', code: 'payer-line-unreadable', text: `Your ${a.label} trust line could not be read (${a.payer.error}).` });
    else if (a.payer.present === false) r.push({ level: 'stop', code: 'payer-no-trust-line', text: `You hold no ${a.label}: set a trust line to ${a.issuer}, then get ${a.label} into the account (see walletFunding.fundingNeed).` });
    else if (amount !== undefined && a.payer.balance !== null && Number(a.payer.balance) < amount) r.push({ level: 'stop', code: 'payer-short-token', text: `You hold ${a.payer.balance} ${a.label}; the payment is ${amount}.` });
  }
  return r;
}
const DAY = 86_400_000;
/** Accounts younger than this are flagged: most misdirected and throwaway addresses are new. */
export const NEW_ACCOUNT_DAYS = 7;

/** Ledger facts for one address (public reads only). A failed read is reported as an error, not as a clean account. */
export async function readAccountFacts(network: XrplNetwork, address: string, fetcher: typeof fetch = fetch): Promise<AccountFacts & { ledgerIndex: number | null; reserveBase: number; reserveInc: number }> {
  const out: AccountFacts = { address, activated: null, balanceXrp: null, ownedObjects: null, flags: null, regularKey: null, firstSeen: null, lastActive: null, error: null };
  let ledgerIndex: number | null = null; let reserveBase = 1; let reserveInc = OWNER_RESERVE_XRP;
  try {
    const info = await xrplRpc<{ info: { validated_ledger?: { reserve_base_xrp?: number; reserve_inc_xrp?: number; seq?: number } } }>(network, 'server_info', {}, fetcher);
    reserveBase = Number(info.info.validated_ledger?.reserve_base_xrp ?? reserveBase); reserveInc = Number(info.info.validated_ledger?.reserve_inc_xrp ?? reserveInc); ledgerIndex = info.info.validated_ledger?.seq ?? null;
  } catch { /* reserves fall back to the last known values; reported below via error only if account reads fail */ }
  try {
    const r = await xrplRpc<{ account_data: Record<string, unknown>; ledger_index?: number }>(network, 'account_info', { account: address, ledger_index: 'validated' }, fetcher);
    const a = r.account_data; const f = Number(a.Flags ?? 0);
    Object.assign(out, {
      activated: true, balanceXrp: Number(a.Balance) / 1_000_000, ownedObjects: Number(a.OwnerCount ?? 0), regularKey: (a.RegularKey as string) ?? null,
      flags: { requireDestinationTag: !!(f & LSF.requireDest), depositAuth: !!(f & LSF.depositAuth), disallowXrp: !!(f & LSF.disallowXrp), masterDisabled: !!(f & LSF.disableMaster), globalFreeze: !!(f & LSF.globalFreeze) },
    });
    ledgerIndex = r.ledger_index ?? ledgerIndex;
  } catch (e) {
    if (e instanceof XrplRpcError && e.code === 'actNotFound') out.activated = false;
    else out.error = (e as Error).message;
  }
  if (out.activated) {
    const dateOf = (t: Record<string, unknown> | undefined) => { const d = (t?.close_time_iso as string) ?? null; return d; };
    try { const first = await xrplRpc<{ transactions?: Array<Record<string, unknown>> }>(network, 'account_tx', { account: address, limit: 1, forward: true }, fetcher); out.firstSeen = dateOf(first.transactions?.[0]); } catch { /* unknown */ }
    try { const last = await xrplRpc<{ transactions?: Array<Record<string, unknown>> }>(network, 'account_tx', { account: address, limit: 1, forward: false }, fetcher); out.lastActive = dateOf(last.transactions?.[0]); } catch { /* unknown */ }
  }
  return { ...out, ledgerIndex, reserveBase, reserveInc };
}

/** What the marketplace's own history says about the parties behind an address (or one party). */
export function marketFacts(state: MarketState, address: string | null, party: string | null, now: string): MarketFacts | null {
  const ids = party ? [party] : [...state.parties.values()].filter((p) => p.xrplAccount && p.xrplAccount === address).map((p) => p.partyId);
  if (!ids.length) return null;
  const main = state.parties.get(ids[0]) ?? null;
  let finished = 0; let disputes = 0; const ratings: number[] = [];
  for (const id of ids) { const r = state.reputation.get(id); if (r) { finished += r.completed; disputes += r.disputes; ratings.push(...r.ratings); } }
  const openDisputes = state.contracts.filter((c) => ids.includes(c.buyerId) || ids.includes(c.sellerId)).reduce((n, c) => n + c.disputes.filter((d) => !d.resolved).length, 0);
  let mandate: MarketFacts['mandate'] = null;
  if (main?.kind === 'agent') {
    const ms = state.mandates.filter((m) => m.agentPartyId === main.partyId);
    const active = ms.filter((m) => Date.parse(m.limits.expiresAt) > Date.parse(now));
    const m = (active.length ? active : ms).at(-1);
    if (m) mandate = { active: active.length > 0, perContract: `${m.limits.maxPerContract.amount} ${m.limits.maxPerContract.currency}`, perDay: `${m.limits.maxPerDay.amount} ${m.limits.maxPerDay.currency}`, usedToday: state.committedByDay.get(committedKey(main.partyId, now, m.limits.maxPerDay.currency)) ?? 0, expires: m.limits.expiresAt };
  }
  return { partyIds: ids, name: main?.name ?? null, kind: main?.kind ?? null, principal: main?.principal?.partyId ?? main?.principal?.governanceAddress ?? null, finished, disputes, openDisputes, averageRating: ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : null, mandate };
}

/** The rules: pure, so anyone can re-run them on the facts in a report. */
export function judge(req: CheckRequest, ledger: AccountFacts | null, payer: (AccountFacts & { spendableXrp: number | null; needsXrp: number | null }) | null, market: MarketFacts | null, now: string): Reason[] {
  const r: Reason[] = [];
  if (!ledger) r.push({ level: 'stop', code: 'no-address', text: 'No XRPL address to check: the party has no XRPL account on its profile.' });
  else if (ledger.error) r.push({ level: 'warn', code: 'ledger-unreadable', text: `The ledger could not be read (${ledger.error}); nothing about this account is confirmed.` });
  else if (ledger.activated === false) r.push({ level: 'stop', code: 'not-activated', text: `The account is not activated on ${req.network}: payments and escrows to it fail (tecNO_DST).` });
  if (ledger?.flags) {
    if (ledger.flags.depositAuth) r.push({ level: 'stop', code: 'deposit-auth', text: 'The account only accepts payments from senders it pre-authorized (DepositAuth): yours will fail unless it authorized you.' });
    if (ledger.flags.disallowXrp) r.push({ level: 'warn', code: 'disallow-xrp', text: 'The account asks not to receive XRP (DisallowXRP). It is advisory, but it suggests the wrong address.' });
    if (ledger.flags.requireDestinationTag) r.push({ level: 'info', code: 'dest-tag-required', text: 'The account requires a destination tag: include the one you were given, or the payment is refused.' });
    if (ledger.flags.globalFreeze) r.push({ level: 'warn', code: 'global-freeze', text: 'The account has frozen the tokens it issued.' });
    if (ledger.flags.masterDisabled && !ledger.regularKey) r.push({ level: 'warn', code: 'blackholed', text: 'The account cannot sign anything (master key disabled, no regular key): it can receive but never send, refund or finish anything.' });
  }
  if (ledger?.activated && ledger.firstSeen) {
    const days = (Date.parse(now) - Date.parse(ledger.firstSeen)) / DAY;
    if (days < NEW_ACCOUNT_DAYS) r.push({ level: 'warn', code: 'new-account', text: `The account is new (first transaction ${ledger.firstSeen.slice(0, 10)}, ${Math.max(0, Math.floor(days))} days ago).` });
  }
  if (!market) r.push({ level: 'info', code: 'no-market-history', text: 'No marketplace party uses this address on this network: there is no CAPPZ track record to go on.' });
  else {
    if (market.openDisputes > 0) r.push({ level: 'warn', code: 'open-disputes', text: `${market.openDisputes} open dispute(s) on its deals.` });
    if (market.finished > 0 && market.disputes / market.finished > 0.2) r.push({ level: 'warn', code: 'dispute-rate', text: `${market.disputes} dispute(s) over ${market.finished} finished deal(s).` });
    if (market.kind === 'agent' && (!market.mandate || !market.mandate.active)) r.push({ level: 'stop', code: 'agent-no-mandate', text: 'It is an agent party without an active mandate: it cannot form or fund deals on this market.' });
    if (market.finished > 0 && market.disputes === 0) r.push({ level: 'info', code: 'track-record', text: `${market.finished} finished deal(s) with no disputes${market.averageRating ? `, average rating ${market.averageRating}` : ''}.` });
  }
  if (payer) {
    if (payer.activated === false) r.push({ level: 'stop', code: 'payer-not-activated', text: 'Your own account is not activated on this network.' });
    else if (payer.spendableXrp !== null && payer.needsXrp !== null && payer.spendableXrp < payer.needsXrp) r.push({ level: 'stop', code: 'payer-short', text: `You need about ${payer.needsXrp} XRP spendable (amount, escrow reserves, fees); you have ${payer.spendableXrp}.` });
  }
  return r;
}

const verdictOf = (rs: readonly Reason[]): CheckReport['verdict'] => (rs.some((x) => x.level === 'stop') ? 'stop' : rs.some((x) => x.level === 'warn') ? 'warn' : 'ok');

/** Run a check: ledger reads, marketplace facts, rules. */
export async function runCounterpartyCheck(req: CheckRequest, state: MarketState | null, now = new Date().toISOString(), fetcher: typeof fetch = fetch): Promise<CheckReport> {
  const address = req.address ?? (req.party ? state?.parties.get(req.party)?.xrplAccount ?? null : null);
  const acct = address ? await readAccountFacts(req.network, address, fetcher) : null;
  let payer: CheckReport['payer'] = null;
  if (req.payer) {
    const p = await readAccountFacts(req.network, req.payer, fetcher);
    const spendable = p.activated && p.balanceXrp !== null ? Math.round((p.balanceXrp - p.reserveBase - (p.ownedObjects ?? 0) * p.reserveInc) * 1e6) / 1e6 : null;
    const needs = req.amountXrp !== undefined ? Math.round((req.amountXrp + (req.escrowLegs ?? 1) * p.reserveInc + 0.001) * 1e6) / 1e6 : null;
    const { ledgerIndex: _l, reserveBase: _b, reserveInc: _i, ...facts } = p;
    payer = { ...facts, spendableXrp: spendable, needsXrp: needs };
  }
  const market = state ? marketFacts(state, address, req.party ?? null, now) : null;
  const ledger = acct ? (({ ledgerIndex: _l, reserveBase: _b, reserveInc: _i, ...f }) => f)(acct) : null;
  const issued = req.currency && isIssuedAsset(req.currency);
  const asset = issued ? await readAssetFacts(req.network, req.currency!, address, req.payer ?? null, fetcher) : undefined;
  const reasons = [...judge(req, ledger, payer, market, now), ...(asset ? judgeAsset(asset, req.amount) : [])];
  return {
    kind: 'cappz-counterparty-check', version: 1, network: req.network, checkedAt: now, ledgerIndex: acct?.ledgerIndex ?? null,
    subject: { address, party: req.party ?? null }, verdict: verdictOf(reasons), reasons, ledger, payer, market, ...(asset ? { asset } : {}),
    rules: 'https://github.com/CAPPZ-ai/cappz-sdk/blob/main/src/lib/marketplace/counterpartyCheck.ts',
  };
}

/** Canonical JSON (sorted keys, no spaces): what is hashed and signed. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v as Record<string, unknown>).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));

export interface SignedCheck { report: CheckReport; signature: { alg: 'Ed25519'; publicKey: string; value: string } }

/** Sign a report with the service's Ed25519 key (32-byte seed, hex). */
export function signCheck(report: CheckReport, seedHex: string): SignedCheck {
  const seed = unhex(seedHex);
  const msg = new TextEncoder().encode(canonicalJson(report));
  return { report, signature: { alg: 'Ed25519', publicKey: hex(ed25519.getPublicKey(seed)), value: hex(ed25519.sign(msg, seed)) } };
}

/** Verify a signed report, optionally against the expected public key (from the marketplace's discovery document). */
export function verifyCheck(signed: SignedCheck, expectedPublicKey?: string): boolean {
  if (expectedPublicKey && signed.signature.publicKey.toLowerCase() !== expectedPublicKey.toLowerCase()) return false;
  try { return ed25519.verify(unhex(signed.signature.value), new TextEncoder().encode(canonicalJson(signed.report)), unhex(signed.signature.publicKey)); } catch { return false; }
}
