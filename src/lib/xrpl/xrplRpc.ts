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

/** Public JSON-RPC endpoints (the same ledgers as XRPL_ENDPOINTS, over HTTPS). */
export const XRPL_RPC_ENDPOINTS: Record<XrplNetwork, string> = {
  mainnet: 'https://xrplcluster.com/',
  testnet: 'https://s.altnet.rippletest.net:51234/',
  devnet: 'https://s.devnet.rippletest.net:51234/',
};

export class XrplRpcError extends Error {
  constructor(message: string, readonly code: string | null) { super(message); }
}

/** One JSON-RPC call; ledger errors (e.g. actNotFound) come back as XrplRpcError with their code. */
export async function xrplRpc<T = Record<string, unknown>>(network: XrplNetwork, method: string, params: Record<string, unknown>, fetcher: typeof fetch = fetch): Promise<T> {
  const res = await fetcher(XRPL_RPC_ENDPOINTS[network], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params: [{ api_version: 2, ...params }] }) });
  if (!res.ok) throw new XrplRpcError(`XRPL ${network} answered HTTP ${res.status}`, null);
  const body = (await res.json()) as { result?: Record<string, unknown> & { error?: string; error_message?: string; status?: string } };
  const r = body.result ?? {};
  if (r.error) throw new XrplRpcError(`XRPL ${method}: ${r.error_message ?? r.error}`, r.error);
  return r as T;
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
