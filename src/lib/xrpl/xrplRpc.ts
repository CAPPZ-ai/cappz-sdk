/**
 * COPE node crystallized. Node ID: v15-27-00-xrpl-json-rpc.
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * XRPL reads over plain HTTPS JSON-RPC (fetch only, no WebSocket client), so
 * they run in edge workers, browsers, Node, Deno and Bun alike. Transactions
 * are normalized by the same reader every other check uses (normalizeTx), so
 * a payment is judged identically whichever transport fetched it.
 */
import { normalizeTx, type LedgerTx, type XrplNetwork } from './ledgerCheck';

/**
 * Public JSON-RPC endpoints per network, tried in order. Edge workers share outbound IPs, so one public server can
 * rate-limit a whole platform's traffic; a refused or rate-limited call moves on to the next server.
 */
export const XRPL_RPC_SERVERS: Record<XrplNetwork, readonly string[]> = {
  mainnet: ['https://s1.ripple.com:51234/', 'https://s2.ripple.com:51234/', 'https://xrplcluster.com/'],
  testnet: ['https://s.altnet.rippletest.net:51234/', 'https://testnet.xrpl-labs.com/'],
  devnet: ['https://s.devnet.rippletest.net:51234/'],
};
/** The first server per network (kept for callers that want one URL). */
export const XRPL_RPC_ENDPOINTS: Record<XrplNetwork, string> = { mainnet: XRPL_RPC_SERVERS.mainnet[0], testnet: XRPL_RPC_SERVERS.testnet[0], devnet: XRPL_RPC_SERVERS.devnet[0] };

/** Errors that mean "this server, not now" (try the next one), as opposed to an answer about the ledger. */
const RETRYABLE = /rate limit|slowDown|tooBusy|noNetwork|noCurrent|noClosed|amendmentBlocked|failedToForward/i;

export class XrplRpcError extends Error {
  constructor(message: string, readonly code: string | null) { super(message); }
}

/** One JSON-RPC call, trying each public server in turn; ledger answers (e.g. actNotFound, txnNotFound) come back as XrplRpcError with their code. */
export async function xrplRpc<T = Record<string, unknown>>(network: XrplNetwork, method: string, params: Record<string, unknown>, fetcher: typeof fetch = fetch): Promise<T> {
  let last: Error | null = null;
  for (const url of XRPL_RPC_SERVERS[network]) {
    try {
      const res = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params: [{ api_version: 2, ...params }] }) });
      if (!res.ok) { last = new XrplRpcError(`XRPL ${network} (${new URL(url).host}) answered HTTP ${res.status}`, null); continue; }
      const body = (await res.json()) as { result?: Record<string, unknown> & { error?: string; error_message?: string } };
      const r = body.result ?? {};
      if (r.error) {
        const err = new XrplRpcError(`XRPL ${method}: ${r.error_message ?? r.error}`, r.error);
        if (RETRYABLE.test(`${r.error} ${r.error_message ?? ''}`)) { last = err; continue; }
        throw err;
      }
      return r as T;
    } catch (e) {
      if (e instanceof XrplRpcError && e.code && !RETRYABLE.test(`${e.code} ${e.message}`)) throw e;
      last = e as Error;
    }
  }
  throw last ?? new XrplRpcError(`XRPL ${network}: no server answered`, null);
}

/** A validated (or not yet validated) transaction by hash, normalized. */
export async function rpcLedgerTx(network: XrplNetwork, hash: string, fetcher: typeof fetch = fetch): Promise<LedgerTx> {
  const r = await xrplRpc(network, 'tx', { transaction: hash, binary: false }, fetcher);
  return normalizeTx(r, network, new Date().toISOString());
}

/** Recent payments into `account`, newest first, normalized. */
export async function rpcIncomingPayments(network: XrplNetwork, account: string, limit = 50, fetcher: typeof fetch = fetch): Promise<LedgerTx[]> {
  const r = await xrplRpc<{ transactions?: Array<Record<string, unknown>> }>(network, 'account_tx', { account, limit, forward: false }, fetcher);
  const at = new Date().toISOString();
  return (r.transactions ?? [])
    .map((e) => { const t = (e.tx_json ?? e.tx ?? {}) as Record<string, unknown>; return normalizeTx({ ...e, tx_json: t, hash: e.hash ?? t.hash }, network, at); })
    .filter((t) => t.type === 'Payment' && t.destination === account);
}

/** The paid-agent kit's LedgerReader over JSON-RPC (for hosts without WebSockets). */
export const rpcLedgerReader = {
  incoming: (n: XrplNetwork, a: string) => rpcIncomingPayments(n, a),
  tx: (n: XrplNetwork, h: string) => rpcLedgerTx(n, h),
};
