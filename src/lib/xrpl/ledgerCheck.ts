/**
 * COPE node crystallized. Node ID: v15-00-01-xrpl-ledger-check.
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Read one transaction from the XRP Ledger and normalize it, so callers check
 * what the ledger actually did. Handles API v1 (`result.*`) and v2
 * (`result.tx_json`) shapes; reports `delivered_amount` from the metadata —
 * never `Amount`, which a partial payment can exceed; decodes memos with
 * web-standard APIs so it runs in the browser. A check is only as fresh as
 * its `checkedAt`; anyone can re-run it from the hash.
 */
import { Client } from 'xrpl';

export type XrplNetwork = 'mainnet' | 'testnet' | 'devnet';
export const XRPL_ENDPOINTS: Record<XrplNetwork, string> = {
  mainnet: 'wss://xrplcluster.com',
  testnet: 'wss://s.altnet.rippletest.net:51233',
  devnet: 'wss://s.devnet.rippletest.net:51233',
};

export interface LedgerTx {
  hash: string; network: XrplNetwork; validated: boolean; result: string; ledgerIndex: number | null;
  type: string; account: string; destination: string | null;
  /** Delivered XRP in drops (from meta.delivered_amount); null for non-XRP or non-payment deliveries. */
  deliveredDrops: string | null;
  /** Delivered issued token (from meta.delivered_amount); null for XRP or non-payment deliveries. */
  deliveredIssued: { currency: string; issuer: string; value: string } | null;
  destinationTag: number | null;
  /** The raw transaction fields (Amount, Condition, OfferSequence, Owner, Fulfillment, Memos, …). */
  fields: Record<string, unknown>;
  memos: Array<{ type: string; data: string }>;
  closeTime: string | null; checkedAt: string;
}

export const hexToUtf8 = (hex: string): string => {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) return '';
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return ''; }
};

/** Normalize a `tx` response (exported for tests and offline replay). */
export function normalizeTx(result: Record<string, unknown>, network: XrplNetwork, checkedAt: string): LedgerTx {
  const tx = (result.tx_json as Record<string, unknown> | undefined) ?? result;
  const meta = (result.meta ?? result.metaData) as Record<string, unknown> | undefined;
  const delivered = meta?.delivered_amount ?? meta?.DeliveredAmount;
  const memos = ((tx.Memos as Array<{ Memo?: { MemoType?: string; MemoData?: string } }> | undefined) ?? []).map((m) => ({ type: hexToUtf8(m.Memo?.MemoType ?? ''), data: hexToUtf8(m.Memo?.MemoData ?? '') }));
  const date = (tx.date ?? result.close_time_iso ?? result.date) as number | string | undefined;
  return {
    hash: String(result.hash ?? tx.hash ?? ''), network, validated: result.validated === true,
    result: String(meta?.TransactionResult ?? ''), ledgerIndex: typeof result.ledger_index === 'number' ? result.ledger_index : typeof tx.ledger_index === 'number' ? (tx.ledger_index as number) : null,
    type: String(tx.TransactionType ?? ''), account: String(tx.Account ?? ''), destination: typeof tx.Destination === 'string' ? tx.Destination : null,
    deliveredDrops: typeof delivered === 'string' ? delivered : null,
    deliveredIssued: delivered && typeof delivered === 'object' && 'issuer' in delivered ? { currency: String((delivered as Record<string, unknown>).currency), issuer: String((delivered as Record<string, unknown>).issuer), value: String((delivered as Record<string, unknown>).value) } : null,
    destinationTag: typeof tx.DestinationTag === 'number' ? tx.DestinationTag : null,
    fields: tx, memos, closeTime: typeof date === 'number' ? new Date((date + 946684800) * 1000).toISOString() : typeof date === 'string' ? date : null, checkedAt,
  };
}

export async function fetchLedgerTx(network: XrplNetwork, hash: string): Promise<LedgerTx> {
  if (!/^[0-9A-Fa-f]{64}$/.test(hash)) throw new Error('An XRPL transaction hash is 64 hex characters.');
  const client = new Client(XRPL_ENDPOINTS[network]);
  await client.connect();
  try {
    const res = await client.request({ command: 'tx', transaction: hash } as never) as { result: Record<string, unknown> };
    return normalizeTx(res.result, network, new Date().toISOString());
  } catch (e) {
    const err = e as { data?: { error?: string }; message?: string };
    throw new Error(err.data?.error === 'txnNotFound' ? 'Transaction not found on this network.' : `XRPL lookup failed: ${err.message ?? 'unknown error'}`);
  } finally { await client.disconnect().catch(() => {}); }
}

/** Recent payments received by an account, newest first, normalized like `fetchLedgerTx` (API v1 and v2 `account_tx` shapes). */
export async function fetchIncomingPayments(network: XrplNetwork, account: string, limit = 50): Promise<LedgerTx[]> {
  const client = new Client(XRPL_ENDPOINTS[network]);
  await client.connect();
  try {
    const res = await client.request({ command: 'account_tx', account, limit, forward: false } as never) as { result: { transactions?: Array<Record<string, unknown>> } };
    const at = new Date().toISOString();
    return (res.result.transactions ?? [])
      .map((e) => { const t = (e.tx_json ?? e.tx ?? {}) as Record<string, unknown>; return normalizeTx({ ...e, tx_json: t, hash: e.hash ?? t.hash }, network, at); })
      .filter((t) => t.type === 'Payment' && t.destination === account);
  } catch (e) {
    const err = e as { data?: { error?: string }; message?: string };
    throw new Error(err.data?.error === 'actNotFound' ? 'This account is not activated on this network yet.' : `XRPL lookup failed: ${err.message ?? 'unknown error'}`);
  } finally { await client.disconnect().catch(() => {}); }
}

/** Whether an account exists (is activated) on a network, and the trust lines it holds — for setup checks. */
export async function fetchAccountSummary(network: XrplNetwork, account: string): Promise<{ activated: boolean; xrpDrops: string | null; lines: Array<{ currency: string; issuer: string; balance: string }> }> {
  const client = new Client(XRPL_ENDPOINTS[network]);
  await client.connect();
  try {
    let info: { result: { account_data?: { Balance?: string } } };
    try { info = await client.request({ command: 'account_info', account, ledger_index: 'validated' } as never) as typeof info; }
    catch (e) { if ((e as { data?: { error?: string } }).data?.error === 'actNotFound') return { activated: false, xrpDrops: null, lines: [] }; throw e; }
    const lines = await client.request({ command: 'account_lines', account, ledger_index: 'validated' } as never) as { result: { lines?: Array<{ currency: string; account: string; balance: string }> } };
    return { activated: true, xrpDrops: info.result.account_data?.Balance ?? null, lines: (lines.result.lines ?? []).map((l) => ({ currency: l.currency, issuer: l.account, balance: l.balance })) };
  } finally { await client.disconnect().catch(() => {}); }
}

/**
 * v15-06-00 — an account's validated transactions, newest first, following
 * `marker` pages up to `max` (both API v1 `tx` and v2 `tx_json` shapes, so
 * date and hash are never lost). Reports whether more history exists.
 */
export async function fetchAccountTransactions(network: XrplNetwork, account: string, max = 1000): Promise<{ txs: LedgerTx[]; truncated: boolean; activated: boolean }> {
  const client = new Client(XRPL_ENDPOINTS[network]);
  await client.connect();
  try {
    const txs: LedgerTx[] = [];
    let marker: unknown;
    const at = new Date().toISOString();
    do {
      let res: { result: { transactions?: Array<Record<string, unknown>>; marker?: unknown } };
      try {
        res = await client.request({ command: 'account_tx', account, limit: Math.min(200, max - txs.length), forward: false, ledger_index_min: -1, ledger_index_max: -1, ...(marker ? { marker } : {}) } as never) as typeof res;
      } catch (e) {
        if ((e as { data?: { error?: string } }).data?.error === 'actNotFound') return { txs: [], truncated: false, activated: false };
        throw e;
      }
      for (const e of res.result.transactions ?? []) {
        if (e.validated === false) continue;
        const t = (e.tx_json ?? e.tx ?? {}) as Record<string, unknown>;
        txs.push(normalizeTx({ ...e, tx_json: t, hash: e.hash ?? t.hash, validated: e.validated ?? true, ledger_index: e.ledger_index ?? t.ledger_index }, network, at));
      }
      marker = res.result.marker;
    } while (marker && txs.length < max);
    return { txs, truncated: Boolean(marker), activated: true };
  } finally { await client.disconnect().catch(() => {}); }
}

/**
 * v15-06-00 — what an issuer owes, per currency (`gateway_balances`): the
 * ledger's own total of issued tokens, excluding the listed hot wallets'
 * holdings from `obligations` and reporting them in `balances`.
 */
export async function fetchGatewayBalances(network: XrplNetwork, issuer: string, hotwallets: string[] = []): Promise<{ activated: boolean; obligations: Record<string, string>; hotBalances: Record<string, Array<{ currency: string; value: string }>> }> {
  const client = new Client(XRPL_ENDPOINTS[network]);
  await client.connect();
  try {
    const res = await client.request({ command: 'gateway_balances', account: issuer, ledger_index: 'validated', strict: true, ...(hotwallets.length ? { hotwallet: hotwallets } : {}) } as never) as { result: { obligations?: Record<string, string>; balances?: Record<string, Array<{ currency: string; value: string }>> } };
    return { activated: true, obligations: res.result.obligations ?? {}, hotBalances: res.result.balances ?? {} };
  } catch (e) {
    if ((e as { data?: { error?: string } }).data?.error === 'actNotFound') return { activated: false, obligations: {}, hotBalances: {} };
    throw e;
  } finally { await client.disconnect().catch(() => {}); }
}
