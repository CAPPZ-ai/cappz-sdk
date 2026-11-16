/**
 * On-ledger KeyZ declarations (15.45.0): the payout account vouches for the node key
 * with an XRPL transaction it signs in its own wallet (Xaman, or any wallet), so the
 * account's secret never leaves that wallet and nothing has to be typed on the node.
 *
 * The transaction is an AccountSet that changes nothing on the account (no flags, no
 * fields) and carries one memo:
 *   MemoType   "cappz/keyz"   MemoFormat "application/json"
 *   MemoData   {"v":1,"op":"declare","key":"<node Ed25519 key, 64 hex>","alg":"ed25519",
 *               "purposes":["signing"],"until":"<ISO, ≤ 90 days after the ledger close>","n":"<nonce>"}
 * Withdrawing it is another such transaction:
 *   MemoData   {"v":1,"op":"revoke","tx":"<declaration hash>"}   or   {"v":1,"op":"revoke","key":"<node key>"}
 *
 * Valid when the declaration is validated with tesSUCCESS on the network it names, the
 * memo names the key and purpose, the record falls inside [ledger close − 5 min, until),
 * and no validated, successful revocation by the same account follows it (a revocation
 * withdraws the declaration for every record, whenever signed: a leaked key can backdate).
 * The ledger has already checked that the account authorized the transaction (master key,
 * regular key or multisign), so any account type works, Ed25519 ones included.
 *
 * A record names its declaration as payload.signerDeclaration = "xrpl:<network>:<hash>".
 * docs/verify.mjs repeats these rules without dependencies; keep the two in step.
 */
import { normalizeTx, type LedgerTx, type XrplNetwork } from '../../../src/lib/xrpl/ledgerCheck.ts';

export const KEYZ_MEMO_TYPE = 'cappz/keyz';
export const MAX_LEDGER_DECLARATION_DAYS = 90;
const DAY = 86_400_000;
const SKEW = 5 * 60_000;

/** Public JSON-RPC endpoints (override with CAPPZ_XRPL_RPC_MAINNET / _TESTNET / _DEVNET). */
export const XRPL_RPC: Record<XrplNetwork, string[]> = {
  mainnet: ['https://xrplcluster.com/', 'https://s1.ripple.com:51234/'],
  testnet: ['https://s.altnet.rippletest.net:51234/'],
  devnet: ['https://s.devnet.rippletest.net:51234/'],
};
export const XAMAN_NETWORK: Record<XrplNetwork, string> = { mainnet: 'MAINNET', testnet: 'TESTNET', devnet: 'DEVNET' };

export type KeyzMemo =
  | { v: 1; op: 'declare'; key: string; alg: 'ed25519'; purposes: string[]; until: string; n?: string }
  | { v: 1; op: 'revoke'; tx?: string; key?: string };

/** What key-declarations.json stores for an on-ledger declaration (the ledger holds the rest). */
export interface LedgerAnchor { v: 'xrpl'; network: XrplNetwork; txHash: string; account?: string; key?: string; until?: string }
export const isLedgerAnchor = (x: unknown): x is LedgerAnchor =>
  !!x && (x as LedgerAnchor).v === 'xrpl' && ['mainnet', 'testnet', 'devnet'].includes((x as LedgerAnchor).network) && /^[0-9A-F]{64}$/i.test((x as LedgerAnchor).txHash ?? '');
export const anchorRef = (network: XrplNetwork, hash: string) => `xrpl:${network}:${hash.toUpperCase()}`;
export function parseAnchorRef(ref: unknown): { network: XrplNetwork; txHash: string } | null {
  const m = /^xrpl:(mainnet|testnet|devnet):([0-9A-F]{64})$/i.exec(String(ref ?? ''));
  return m ? { network: m[1].toLowerCase() as XrplNetwork, txHash: m[2].toUpperCase() } : null;
}

const utf8Hex = (s: string) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();

/** The unsigned AccountSet that carries a memo (Fee, Sequence and LastLedgerSequence are filled by the wallet). */
export function keyzTransaction(account: string, memo: KeyzMemo): Record<string, unknown> {
  return {
    TransactionType: 'AccountSet', Account: account,
    Memos: [{ Memo: { MemoType: utf8Hex(KEYZ_MEMO_TYPE), MemoFormat: utf8Hex('application/json'), MemoData: utf8Hex(JSON.stringify(memo)) } }],
  };
}

export function declarationMemo(nodeKey: string, purposes: string[], days: number, now = Date.now()): KeyzMemo {
  if (!/^[0-9a-f]{64}$/i.test(nodeKey)) throw new Error('The node key is 64 hex characters (CAPPZ_NODE_PUB).');
  if (!(days > 0 && days <= MAX_LEDGER_DECLARATION_DAYS)) throw new Error(`A declaration lasts 1–${MAX_LEDGER_DECLARATION_DAYS} days.`);
  return { v: 1, op: 'declare', key: nodeKey.toLowerCase(), alg: 'ed25519', purposes, until: new Date(now + days * DAY).toISOString().replace(/\.\d{3}Z$/, 'Z'), n: crypto.randomUUID().slice(0, 8) };
}

/** The CAPPZ KeyZ memo of a transaction, or null. */
export function keyzMemoOf(tx: Pick<LedgerTx, 'memos'>): KeyzMemo | null {
  for (const m of tx.memos ?? []) {
    if (m.type !== KEYZ_MEMO_TYPE) continue;
    try {
      const v = JSON.parse(m.data);
      if (v?.v !== 1) continue;
      if (v.op === 'declare' && /^[0-9a-f]{64}$/.test(v.key) && v.alg === 'ed25519' && Array.isArray(v.purposes) && typeof v.until === 'string') return v;
      if (v.op === 'revoke' && (/^[0-9A-F]{64}$/i.test(v.tx ?? '') || /^[0-9a-f]{64}$/.test(v.key ?? ''))) return v;
    } catch { /* not ours */ }
  }
  return null;
}

export type LedgerKeyState =
  | { state: 'declared'; account: string; until: string; declaredAt: string; ledgerIndex: number | null; purposes: string[]; because: string }
  | { state: 'revoked'; account: string; revokedIn: string; revokedAt: string | null; because: string }
  | { state: 'expired' | 'invalid' | 'not-yet'; because: string };

/**
 * Is `nodeKey` declared for `purpose` by declaration `decl`, at time `at`, given the
 * account's later transactions `after` (any order; only its validated, successful
 * KeyZ revocations count)?
 */
export function evaluateLedgerDeclaration(decl: LedgerTx, after: LedgerTx[], nodeKey: string, purpose: string, at = Date.now()): LedgerKeyState {
  if (!decl.validated) return { state: 'invalid', because: 'the declaration is not in a validated ledger' };
  if (decl.result !== 'tesSUCCESS') return { state: 'invalid', because: `the declaration failed on the ledger (${decl.result || 'no result'})` };
  if (decl.type !== 'AccountSet') return { state: 'invalid', because: `a declaration is an AccountSet, not ${decl.type}` };
  const memo = keyzMemoOf(decl);
  if (!memo || memo.op !== 'declare') return { state: 'invalid', because: 'the transaction carries no cappz/keyz declaration memo' };
  if (memo.key !== nodeKey.toLowerCase()) return { state: 'invalid', because: 'the declaration names another key' };
  if (!memo.purposes.includes(purpose)) return { state: 'invalid', because: `the declaration is not for ${purpose}` };
  const declaredAt = Date.parse(decl.closeTime ?? '');
  const until = Date.parse(memo.until);
  if (!Number.isFinite(declaredAt) || !Number.isFinite(until)) return { state: 'invalid', because: 'the declaration has no readable time' };
  if (until - declaredAt > (MAX_LEDGER_DECLARATION_DAYS + 1) * DAY) return { state: 'invalid', because: `the declaration claims more than ${MAX_LEDGER_DECLARATION_DAYS} days` };
  for (const t of after) {
    if (!t.validated || t.result !== 'tesSUCCESS' || t.account !== decl.account) continue;
    if (decl.ledgerIndex !== null && t.ledgerIndex !== null && t.ledgerIndex < decl.ledgerIndex) continue;
    const r = keyzMemoOf(t);
    if (r?.op !== 'revoke' || t.hash.toUpperCase() === decl.hash.toUpperCase()) continue;
    if (r.tx?.toUpperCase() === decl.hash.toUpperCase() || r.key === memo.key) {
      return { state: 'revoked', account: decl.account, revokedIn: t.hash, revokedAt: t.closeTime, because: `the account revoked it in ${t.hash.slice(0, 16)}… (${t.closeTime ?? 'time unknown'})` };
    }
  }
  if (at < declaredAt - SKEW) return { state: 'not-yet', because: `before the declaration (${decl.closeTime})` };
  if (at >= until) return { state: 'expired', because: `expired ${memo.until}` };
  return { state: 'declared', account: decl.account, until: memo.until, declaredAt: decl.closeTime!, ledgerIndex: decl.ledgerIndex, purposes: memo.purposes, because: `declared by ${decl.account} in ledger ${decl.ledgerIndex} until ${memo.until}` };
}

// ─── Ledger reads over JSON-RPC (fetch only; Deno, Node 20+, browsers) ─────────

export type Rpc = (network: XrplNetwork, method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;

const rpcUrls = (network: XrplNetwork): string[] => {
  const own = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get(`CAPPZ_XRPL_RPC_${network.toUpperCase()}`)
    ?? (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env?.[`CAPPZ_XRPL_RPC_${network.toUpperCase()}`];
  return own ? [own] : XRPL_RPC[network];
};

/** One JSON-RPC call, trying each endpoint; rippled errors (txnNotFound, actNotFound…) are thrown with their code. */
export const xrplRpc: Rpc = async (network, method, params) => {
  let last: unknown;
  for (const url of rpcUrls(network)) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params: [params] }), signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`${url} answered ${res.status}`);
      const result = (await res.json()).result as Record<string, unknown>;
      if (result?.status === 'error') { const e = new Error(String(result.error_message ?? result.error)); (e as Error & { code?: unknown }).code = result.error; throw e; }
      return result;
    } catch (e) { last = e; if ((e as { code?: unknown }).code) throw e; }
  }
  throw last instanceof Error ? last : new Error('XRPL unreachable');
};

export async function ledgerTx(network: XrplNetwork, hash: string, rpc: Rpc = xrplRpc): Promise<LedgerTx | null> {
  try { return normalizeTx(await rpc(network, 'tx', { transaction: hash.toUpperCase() }), network, new Date().toISOString()); }
  catch (e) { if ((e as { code?: unknown }).code === 'txnNotFound') return null; throw e; }
}

const entryTx = (e: Record<string, unknown>, network: XrplNetwork, at: string): LedgerTx => {
  const t = (e.tx_json ?? e.tx ?? {}) as Record<string, unknown>;
  return normalizeTx({ ...e, tx_json: t, hash: e.hash ?? t.hash, validated: e.validated ?? true, ledger_index: e.ledger_index ?? t.ledger_index }, network, at);
};

/** The account's validated transactions from ledger `minLedger` on, oldest first (up to `max`). */
export async function accountTxSince(network: XrplNetwork, account: string, minLedger: number, rpc: Rpc = xrplRpc, max = 2000): Promise<LedgerTx[]> {
  const out: LedgerTx[] = []; let marker: unknown; const at = new Date().toISOString();
  do {
    const r = await rpc(network, 'account_tx', { account, ledger_index_min: minLedger, ledger_index_max: -1, forward: true, limit: 200, ...(marker ? { marker } : {}) });
    for (const e of (r.transactions as Record<string, unknown>[] | undefined) ?? []) if (e.validated !== false) out.push(entryTx(e, network, at));
    marker = r.marker;
  } while (marker && out.length < max);
  return out;
}

/** The account's newest validated transactions (newest first). */
export async function recentAccountTx(network: XrplNetwork, account: string, rpc: Rpc = xrplRpc, limit = 30): Promise<LedgerTx[]> {
  const r = await rpc(network, 'account_tx', { account, ledger_index_min: -1, ledger_index_max: -1, forward: false, limit });
  const at = new Date().toISOString();
  return ((r.transactions as Record<string, unknown>[] | undefined) ?? []).filter((e) => e.validated !== false).map((e) => entryTx(e, network, at));
}

/** Check one anchor against the ledger now: the declaration and every later revocation by its account. */
export async function checkAnchor(anchor: { network: XrplNetwork; txHash: string }, nodeKey: string, purpose: string, rpc: Rpc = xrplRpc, at = Date.now()): Promise<LedgerKeyState & { tx?: LedgerTx }> {
  const decl = await ledgerTx(anchor.network, anchor.txHash, rpc);
  if (!decl) return { state: 'invalid', because: `transaction ${anchor.txHash.slice(0, 16)}… is not on ${anchor.network}` };
  const later = decl.validated && decl.ledgerIndex !== null ? await accountTxSince(anchor.network, decl.account, decl.ledgerIndex, rpc) : [];
  return { ...evaluateLedgerDeclaration(decl, later, nodeKey, purpose, at), tx: decl };
}

/**
 * 15.47.0 — find the declarations of `nodeKey` that `account` made on the ledger, so a node
 * needs no anchor file: the payout account's own transactions are the evidence. Reads the
 * account's history newest first back to `days` (default 92, past the 90-day limit) or `maxTx`
 * transactions, keeps validated, successful AccountSets from the account whose memo declares
 * this key for `purpose`, and returns them as anchors, newest first. Revocations and expiry are
 * judged later by checkAnchor, as for an anchor from a file.
 */
export async function discoverLedgerAnchors(network: XrplNetwork, account: string, nodeKey: string, purpose = 'signing', rpc: Rpc = xrplRpc, opts: { days?: number; maxTx?: number; now?: number } = {}): Promise<LedgerAnchor[]> {
  const since = (opts.now ?? Date.now()) - (opts.days ?? 92) * DAY; const maxTx = opts.maxTx ?? 2000;
  const found: LedgerAnchor[] = []; let marker: unknown; let seen = 0; const at = new Date().toISOString();
  for (;;) {
    let r: Record<string, unknown>;
    try { r = await rpc(network, 'account_tx', { account, ledger_index_min: -1, ledger_index_max: -1, forward: false, limit: 200, ...(marker ? { marker } : {}) }); }
    catch (e) { if ((e as { code?: unknown }).code === 'actNotFound') return []; throw e; }
    let older = false;
    for (const e of (r.transactions as Record<string, unknown>[] | undefined) ?? []) {
      if (e.validated === false) continue;
      seen++;
      const t = entryTx(e, network, at);
      if (t.closeTime && Date.parse(t.closeTime) < since) { older = true; break; }
      if (t.type !== 'AccountSet' || t.account !== account || t.result !== 'tesSUCCESS') continue;
      const m = keyzMemoOf(t);
      if (m?.op === 'declare' && m.key === nodeKey.toLowerCase() && m.purposes.includes(purpose)) found.push({ v: 'xrpl', network, txHash: t.hash.toUpperCase(), account, key: m.key, until: m.until });
    }
    marker = r.marker;
    if (older || !marker || seen >= maxTx) return found;
  }
}
