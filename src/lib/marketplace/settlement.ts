/**
 * COPE node crystallized. Node ID: v15-00-01-marketplace-settlement.
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * On-ledger settlement for XRP-priced contracts. Each milestone is an XRPL
 * escrow (EscrowCreate) from the buyer to the seller, locked by a
 * PREIMAGE-SHA-256 crypto-condition whose secret only the buyer holds (sealed
 * in the buyer's own wallet). Accepting a milestone means revealing that
 * secret: anyone can then submit EscrowFinish and the ledger pays the seller.
 * Unreleased escrows return to the buyer after CancelAfter. The app prepares
 * transactions and checks the validated ledger; it never holds keys.
 *
 * Fees (v15-14-00): when the contract carries fee terms, each milestone is
 * escrowed in legs under the SAME condition — the seller's net, and the fee:
 * one leg to the ARC collection account (or one per DARC recipient when the
 * schedule names no collector). Revealing the secret finishes them all, so
 * the ledger, not the app, guarantees the seller never receives the fee part
 * and the recipients receive exactly their share.
 *
 * The settlement network is a governed policy (SettlementRailDeclared by a
 * site administrator); it is testnet until an administrator declares mainnet
 * with the acknowledgement recorded on the transaction.
 */
import { buildMemo } from './MarketplaceMemoValidator';
import type { LedgerTx, XrplNetwork } from '../xrpl/ledgerCheck';
import type { MarketTxLike } from './ledger';
import type { ContractTerms } from './types';
import { contractFeePlan } from './fees';
import { holdUntil } from './stageMath';
import { milestoneAmounts } from './rules';

export const DROPS_PER_XRP = 1_000_000;
export const RIPPLE_EPOCH = 946_684_800;
/** Kept for callers of the pre-v15-16-00 API: escrows now cancel at the end of the 30-day hold (stageMath.HOLD_LIMIT_DAYS). */
export const CANCEL_GRACE_DAYS = 30;

export interface SettlementPolicy { network: XrplNetwork; declaredBy: string | null; at: string | null; acknowledgement: string | null }
export const MAINNET_ACKNOWLEDGEMENT = 'I confirm that legal and compliance review has approved real-value settlement on XRPL mainnet for this marketplace, and that participants are informed that XRP payments are irreversible.';

/** The settlement policy of the market on `network` (one market per network; nothing to declare). */
export function settlementPolicyFor(network: XrplNetwork): SettlementPolicy {
  return { network, declaredBy: null, at: null, acknowledgement: null };
}

/**
 * Legacy (before SDK 15.25.0, one market whose network an administrator declared): latest SettlementRailDeclared
 * wins. Markets are now one per network — use settlementPolicyFor(network).
 */
export function resolveSettlementPolicy(txs: readonly MarketTxLike[]): SettlementPolicy {
  const last = [...txs].filter((t) => t.eventType === 'SettlementRailDeclared').sort((a, b) => a.timestamp.localeCompare(b.timestamp)).at(-1);
  if (!last) return { network: 'testnet', declaredBy: null, at: null, acknowledgement: null };
  const p = last.payload as unknown as { network: XrplNetwork; by: string; acknowledgement?: string };
  return { network: p.network, declaredBy: p.by, at: last.timestamp, acknowledgement: p.acknowledgement ?? null };
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
const unhex = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));

/** A fresh 32-byte escrow secret (the preimage). */
export function newEscrowSecret(): string { return hex(crypto.getRandomValues(new Uint8Array(32))); }

const byte = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
/** PREIMAGE-SHA-256 condition as XRPL expects: A0 25 80 20 <sha256(preimage)> 81 01 <cost = preimage length>. */
export async function conditionFor(preimageHex: string): Promise<string> {
  const pre = unhex(preimageHex);
  if (pre.length > 127) throw new Error('Preimage too long.');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', pre));
  return `A0258020${hex(digest)}8101${byte(pre.length)}`;
}
/** The matching fulfillment: A0 <len+2> 80 <len> <preimage>. */
export function fulfillmentFor(preimageHex: string): string {
  const len = preimageHex.length / 2;
  if (len > 125) throw new Error('Preimage too long.');
  return `A0${byte(len + 2)}80${byte(len)}${preimageHex.toUpperCase()}`;
}

const rippleTime = (iso: string) => Math.floor(Date.parse(iso) / 1000) - RIPPLE_EPOCH;

export interface EscrowLeg { role: 'seller' | 'fee'; account: string; label: string; drops: string }
export interface PreparedEscrow extends EscrowLeg { milestone: number; tx: Record<string, unknown>; condition: string }

/** The escrow legs a milestone needs: the seller's net, then one per fee recipient (zero-drop legs are skipped). */
export function milestoneEscrowLegs(c: Pick<ContractTerms, 'total' | 'milestones' | 'fees'>, milestone: number, sellerAccount: string): EscrowLeg[] {
  const q = contractFeePlan(c).milestones[milestone];
  return [{ role: 'seller' as const, account: sellerAccount, label: 'Seller', drops: String(q.netUnits) }, ...q.payLegs.map((l) => ({ role: 'fee' as const, account: l.account, label: l.label, drops: String(l.units) }))].filter((l) => BigInt(l.drops) > 0n);
}

/**
 * EscrowCreates per milestone — one per leg, all under the milestone's own condition — with the contract's monetary
 * memo. CancelAfter is the end of the 30-day hold from `at` (funding time): an unreleased stage returns to the buyer
 * then, enforced by the ledger. Fund one stage at a time (prepareStageEscrows).
 */
export async function prepareMilestoneEscrows(c: ContractTerms, amounts: number[], buyerAccount: string, sellerAccount: string, secrets: string[], at: string = new Date().toISOString()): Promise<PreparedEscrow[]> {
  if (c.total.currency !== 'XRP') throw new Error('On-ledger escrow is for XRP-priced contracts; USD contracts settle off-ledger by reference.');
  if (secrets.length !== c.milestones.length) throw new Error('One secret per milestone.');
  if (amounts.length !== c.milestones.length) throw new Error('One amount per milestone.');
  const perMilestone = await Promise.all(c.milestones.map(async (_m, i) => {
    const condition = await conditionFor(secrets[i]);
    const cancelAt = holdUntil(at);
    return milestoneEscrowLegs(c, i, sellerAccount).map((leg) => ({ ...leg, milestone: i, condition, tx: { TransactionType: 'EscrowCreate', Account: buyerAccount, Destination: leg.account, Amount: leg.drops, Condition: condition, CancelAfter: rippleTime(cancelAt), Memos: [buildMemo({ class: 'monetary', contractId: c.contractId, deliveryIndex: i, currency: 'XRP' })] } }));
  }));
  return perMilestone.flat();
}

/** The current stage's escrow legs only (later stages are prepared when this one completes). */
export async function prepareStageEscrows(c: ContractTerms, milestone: number, buyerAccount: string, sellerAccount: string, secret: string, at: string = new Date().toISOString()): Promise<PreparedEscrow[]> {
  const all = await prepareMilestoneEscrows(c, milestoneAmounts(c.total.amount, c.milestones), buyerAccount, sellerAccount, c.milestones.map(() => secret), at);
  return all.filter((p) => p.milestone === milestone);
}

/** CancelAfter of an EscrowCreate as an ISO time (null when absent). */
export const cancelAfterOf = (lt: LedgerTx): string | null => (typeof lt.fields.CancelAfter === 'number' ? new Date((lt.fields.CancelAfter + RIPPLE_EPOCH) * 1000).toISOString() : null);

export function prepareEscrowCancel(submitter: string, owner: string, offerSequence: number): Record<string, unknown> {
  return { TransactionType: 'EscrowCancel', Account: submitter, Owner: owner, OfferSequence: offerSequence };
}

export function prepareEscrowFinish(submitter: string, owner: string, offerSequence: number, condition: string, preimageHex: string): Record<string, unknown> {
  return { TransactionType: 'EscrowFinish', Account: submitter, Owner: owner, OfferSequence: offerSequence, Condition: condition, Fulfillment: fulfillmentFor(preimageHex) };
}

const memoFor = (lt: LedgerTx) => lt.memos.filter((m) => m.type === 'cappz-marketplace-monetary').map((m) => { try { return JSON.parse(m.data) as { contractId?: string; deliveryIndex?: number }; } catch { return {}; } });

/** What must be true of a validated EscrowCreate for it to fund milestone `milestone` of contract `c`. Returns problems (empty = ok). */
export function checkEscrowCreate(lt: LedgerTx, expect: { network: XrplNetwork; contractId: string; milestone: number; buyerAccount: string; sellerAccount: string; drops: string; condition?: string }): string[] {
  const p: string[] = [];
  if (lt.network !== expect.network) p.push(`On ${lt.network}; this marketplace settles on ${expect.network}.`);
  if (!lt.validated) p.push('Not in a validated ledger yet.');
  if (lt.result !== 'tesSUCCESS') p.push(`Result ${lt.result || 'unknown'}, not tesSUCCESS.`);
  if (lt.type !== 'EscrowCreate') p.push(`It is a ${lt.type}, not an EscrowCreate.`);
  if (lt.account !== expect.buyerAccount) p.push(`Sent from ${lt.account}, not the buyer's account ${expect.buyerAccount}.`);
  if (lt.destination !== expect.sellerAccount) p.push(`Escrows to ${lt.destination}, not the seller's account ${expect.sellerAccount}.`);
  if (String(lt.fields.Amount) !== expect.drops) p.push(`Escrows ${lt.fields.Amount} drops; the milestone needs ${expect.drops}.`);
  if (!lt.fields.Condition) p.push('No crypto-condition: anyone could not release it safely.');
  else if (expect.condition && String(lt.fields.Condition).toUpperCase() !== expect.condition.toUpperCase()) p.push('Condition does not match the one prepared for this milestone.');
  if (!memoFor(lt).some((m) => m.contractId === expect.contractId && m.deliveryIndex === expect.milestone)) p.push('Memo does not name this contract and milestone.');
  return p;
}

/** A validated EscrowFinish (release to seller) or EscrowCancel (return to buyer) for the escrow created by `owner` at `offerSequence`. */
export function checkEscrowFinish(lt: LedgerTx, expect: { network: XrplNetwork; owner: string; offerSequence: number; type?: 'EscrowFinish' | 'EscrowCancel' }): string[] {
  const type = expect.type ?? 'EscrowFinish';
  const p: string[] = [];
  if (lt.network !== expect.network) p.push(`On ${lt.network}; this marketplace settles on ${expect.network}.`);
  if (!lt.validated) p.push('Not in a validated ledger yet.');
  if (lt.result !== 'tesSUCCESS') p.push(`Result ${lt.result || 'unknown'}, not tesSUCCESS.`);
  if (lt.type !== type) p.push(`It is a ${lt.type}, not an ${type}.`);
  if (String(lt.fields.Owner) !== expect.owner) p.push('Finishes an escrow owned by someone else.');
  if (Number(lt.fields.OfferSequence) !== expect.offerSequence) p.push('Finishes a different escrow (OfferSequence).');
  return p;
}

/** The sequence that identifies an escrow (OfferSequence for EscrowFinish/Cancel): Sequence, or TicketSequence when a ticket was used. */
export const escrowSequenceOf = (lt: LedgerTx): number => Number(lt.fields.Sequence || lt.fields.TicketSequence || 0);
