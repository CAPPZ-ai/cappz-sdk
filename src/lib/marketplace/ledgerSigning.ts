/**
 * COPE node crystallized. Node ID: v15-25-00-marketplace-ledger-signing.
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Sign, submit and read back prepared XRPL transactions, one after another,
 * each waiting for validation so sequences never collide. The signer is the
 * party's own wallet — a browser extension, a passkey-bridged account, or a
 * seed held only in the agent's own process (seedSigner). The validated
 * result is read with the same ledger reader every pasted hash goes through.
 */
import { Client, Wallet, type SubmittableTransaction, type Transaction } from 'xrpl';
import { XRPL_ENDPOINTS, fetchLedgerTx, type LedgerTx, type XrplNetwork } from '../xrpl/ledgerCheck';

/** The smallest signer the loop needs. `submitsOnSign` is true for wallets that submit as they sign (Crossmark). */
export interface LedgerSigner {
  address: string;
  submitsOnSign?: boolean;
  /** Network label for error hints (e.g. "Crossmark"). */
  name?: string;
  signTransaction(tx: Transaction): Promise<{ tx_blob: string; hash: string }>;
}

export interface SigningDeps {
  autofill(tx: Record<string, unknown>, network: XrplNetwork): Promise<Record<string, unknown>>;
  submit(blob: string, network: XrplNetwork): Promise<void>;
  read(network: XrplNetwork, hash: string): Promise<LedgerTx>;
  wait(ms: number): Promise<void>;
}

const withClient = async <T>(network: XrplNetwork, f: (c: Client) => Promise<T>): Promise<T> => {
  const c = new Client(XRPL_ENDPOINTS[network]);
  await c.connect();
  try { return await f(c); } finally { await c.disconnect().catch(() => {}); }
};

export const liveSigningDeps: SigningDeps = {
  autofill: (tx, network) => withClient(network, async (c) => (await c.autofill(tx as unknown as SubmittableTransaction)) as unknown as Record<string, unknown>),
  submit: (blob, network) => withClient(network, async (c) => {
    const r = await c.submit(blob);
    const code = (r.result as { engine_result?: string }).engine_result ?? '';
    // tes/ter/tec are accepted for processing (tec still applies the fee); anything else never reaches a ledger.
    if (code && !/^(tes|ter|tec)/.test(code)) throw new Error(`The ledger refused the transaction: ${code} ${(r.result as { engine_result_message?: string }).engine_result_message ?? ''}`.trim());
  }),
  read: fetchLedgerTx,
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** A signer for a seed held in this process only (an agent's own wallet). The seed never leaves the process. */
export function seedSigner(seed: string): LedgerSigner {
  const w = Wallet.fromSeed(seed);
  return { address: w.classicAddress, name: 'seed wallet', async signTransaction(tx) { const s = w.sign(tx as SubmittableTransaction); return { tx_blob: s.tx_blob, hash: s.hash }; } };
}

/** Sign, submit and wait for one transaction to be validated; returns what the ledger shows. */
export async function signAndSubmit(signer: LedgerSigner, tx: Record<string, unknown>, network: XrplNetwork, deps: SigningDeps = liveSigningDeps, timeoutMs = 60_000): Promise<LedgerTx> {
  if (signer.address !== tx.Account) throw new Error(`The connected wallet is ${signer.address}, but this transaction is from ${String(tx.Account)}. Connect that account, or update the XRPL account on your profile.`);
  const prepared = await deps.autofill(tx, network);
  const signed = await signer.signTransaction(prepared as unknown as Transaction);
  if (!signer.submitsOnSign) await deps.submit(signed.tx_blob, network);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const lt = await deps.read(network, signed.hash);
      if (lt.validated) return lt;
    } catch (e) {
      if (!/not found/i.test(e instanceof Error ? e.message : '')) throw e;
    }
    if (Date.now() > deadline) throw new Error(`Submitted ${signed.hash} but it was not validated on ${network} within ${Math.round(timeoutMs / 1000)}s${signer.submitsOnSign && signer.name ? ` — check ${signer.name} is set to ${network}` : ''}. Record the hash later.`);
    await deps.wait(2_000);
  }
}

/** Sign several transactions in order, each validated before the next; stops at the first failure. */
export async function signAndSubmitAll(signer: LedgerSigner, txs: ReadonlyArray<Record<string, unknown>>, network: XrplNetwork, onProgress?: (done: number, lt: LedgerTx) => void, deps: SigningDeps = liveSigningDeps): Promise<LedgerTx[]> {
  const out: LedgerTx[] = [];
  for (const tx of txs) { const lt = await signAndSubmit(signer, tx, network, deps); out.push(lt); onProgress?.(out.length, lt); }
  return out;
}
