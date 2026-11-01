/**
 * COPE node crystallized. Node ID: v15-23-01-xrp-topup
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * XRP top-ups paid from the person's own XRPL wallet. An approved proposal
 * becomes a payment request — the app's receiving address, a destination tag
 * reproducible from the proposal id, the amount in drops and an unsigned
 * Payment the person's wallet completes and signs. The top-up is recorded
 * (AppFunded with the ledger hash) only when a validated ledger shows the
 * payment delivered: delivered_amount, never Amount (partial-payment exploit).
 */
import type { LedgerTx, XrplNetwork } from '../../xrpl/ledgerCheck.ts';
import { formatMinor } from './money.ts';

export interface XrpTopUpRequest {
  proposalId: string;
  network: XrplNetwork;
  destination: string;
  destinationTag: number;
  drops: number;
  /** Unsigned Payment for the person's wallet to complete (Account, Fee, Sequence) and sign. */
  preparedTx: Record<string, unknown>;
  instructions: string;
}

const enc = new TextEncoder();
const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();

/** Destination tag for a proposal: reproducible from its id, never 0. */
export async function topUpDestinationTag(proposalId: string): Promise<number> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`cappz-topup|${proposalId}`)));
  return ((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0 || 1;
}

export async function xrpTopUpRequest(p: { proposalId: string; network: XrplNetwork; payTo: string; drops: number }): Promise<XrpTopUpRequest> {
  if (!Number.isSafeInteger(p.drops) || p.drops <= 0) throw new Error('Top-up amount must be a positive number of drops');
  const destinationTag = await topUpDestinationTag(p.proposalId);
  const memo = { Memo: { MemoType: hexOf(enc.encode('cappz-topup')), MemoData: hexOf(enc.encode(p.proposalId)) } };
  return {
    proposalId: p.proposalId, network: p.network, destination: p.payTo, destinationTag, drops: p.drops,
    preparedTx: { TransactionType: 'Payment', Destination: p.payTo, DestinationTag: destinationTag, Amount: String(p.drops), Memos: [memo] },
    instructions: `Send ${formatMinor(p.drops, 'XRP')} on XRPL ${p.network} to ${p.payTo} with destination tag ${destinationTag}.`,
  };
}

export type XrpTopUpCheck =
  | { ok: true; txHash: string; deliveredDrops: number }
  | { ok: false; reason: 'not-validated' | 'failed' | 'wrong-network' | 'wrong-destination' | 'wrong-tag' | 'not-xrp' | 'underpaid'; detail: string };

/** Does this ledger transaction pay this request? */
export function checkXrpTopUp(req: XrpTopUpRequest, lt: LedgerTx): XrpTopUpCheck {
  if (!lt.validated) return { ok: false, reason: 'not-validated', detail: 'Not in a validated ledger yet.' };
  if (lt.result !== 'tesSUCCESS') return { ok: false, reason: 'failed', detail: `The payment failed on the ledger (${lt.result || 'no result'}).` };
  if (lt.network !== req.network) return { ok: false, reason: 'wrong-network', detail: `The payment is on ${lt.network}; this top-up is on ${req.network}.` };
  if (lt.type !== 'Payment' || lt.destination !== req.destination) return { ok: false, reason: 'wrong-destination', detail: 'The payment did not go to the app’s address.' };
  if (lt.destinationTag !== req.destinationTag) return { ok: false, reason: 'wrong-tag', detail: `Destination tag ${lt.destinationTag ?? 'missing'}; this top-up needs ${req.destinationTag}.` };
  if (lt.deliveredDrops === null) return { ok: false, reason: 'not-xrp', detail: 'The payment delivered a token, not XRP.' };
  const got = Number(lt.deliveredDrops);
  if (!(got >= req.drops)) return { ok: false, reason: 'underpaid', detail: `Delivered ${formatMinor(got, 'XRP')}; the top-up is ${formatMinor(req.drops, 'XRP')}.` };
  return { ok: true, txHash: lt.hash, deliveredDrops: got };
}
