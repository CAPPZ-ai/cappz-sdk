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
import { contractFeePlan, quoteFees, type FeeQuote } from './fees';
import { holdUntil, stageRecords } from './stageMath';
import { hashes, signPaymentChannelClaim, verifyPaymentChannelClaim } from 'xrpl';
import { FULL_BPS, routeRoyalty } from '../skills/royaltyRouting';
import { milestoneAmounts } from './rules';
import { defaultRail, type RailId } from './paymentAssets';
import { preparePayment } from './ledgerPayments';

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
  if (c.total.currency !== 'XRP') throw new Error('On-ledger escrow is for XRP-priced contracts; issued tokens are paid stage by stage (prepareStagePayments) and USD settles through the payment processor or by reference.');
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

// ─── Staged ledger payments (rail ledger-staged: issued tokens such as CAPPZ and USD-tokenZ) ───

/** The rail a contract settles on: frozen at formation (15.31.0), else the asset's default. */
export const contractRail = (c: Pick<ContractTerms, 'rail' | 'total'>): RailId => c.rail ?? defaultRail(c.total.currency);

export interface StageLeg { role: 'seller' | 'fee'; account: string; label: string; units: string }

/** The direct payments one stage needs: the seller's net, then each fee leg (collection account or DARC recipients). Zero legs are skipped. */
export function stagePaymentLegs(c: Pick<ContractTerms, 'total' | 'milestones' | 'fees'>, milestone: number, sellerAccount: string): StageLeg[] {
  return milestoneEscrowLegs(c, milestone, sellerAccount).map((l) => ({ role: l.role, account: l.account, label: l.label, units: l.drops }));
}

/**
 * The Payments a buyer signs to pay one accepted stage on the ledger (no hold: the seller showed the work first and the
 * buyer accepted it). Each carries the contract's monetary memo, so it is matched to exactly this stage.
 */
export function prepareStagePayments(c: Pick<ContractTerms, 'contractId' | 'total' | 'milestones' | 'fees' | 'rail'>, milestone: number, buyerAccount: string, sellerAccount: string, network: XrplNetwork): Array<StageLeg & { tx: Record<string, unknown> }> {
  if (contractRail(c) !== 'ledger-staged') throw new Error(`This contract settles on ${contractRail(c)}, not stage-by-stage ledger payments.`);
  return stagePaymentLegs(c, milestone, sellerAccount).map((leg) => ({ ...leg, tx: preparePayment(buyerAccount, leg.account, BigInt(leg.units), c.total.currency, network, c.contractId, milestone) }));
}

/** The sequence that identifies an escrow (OfferSequence for EscrowFinish/Cancel): Sequence, or TicketSequence when a ticket was used. */
export const escrowSequenceOf = (lt: LedgerTx): number => Number(lt.fields.Sequence || lt.fields.TicketSequence || 0);

// ─── Payment channels (rail ledger-channel: metered use, XRP only) ───
//
// COPE node crystallized. Node ID: v15-31-00-ledger-channel.
// A metered deal settles through one XRPL payment channel from the buyer to the seller. The buyer opens it for the
// cap (the contract total; the order quantity is the cap in metered units) with CancelAfter at the end of one
// 30-day billing cycle, so the ledger itself returns anything unredeemed. As the service is used the buyer signs
// claims off the ledger — each for the CUMULATIVE amount used so far, in drops — and the seller redeems the latest
// with PaymentChannelClaim. Only the validated ledger counts: an open is recorded from the PaymentChannelCreate (and
// the channel the metadata shows created), a redemption from the channel Balance the metadata shows after the claim,
// and a close only when the metadata shows the channel deleted (its final Balance and Amount say what was paid and
// what returned to the buyer). Ledger channels carry XRP only.

/** Seconds the seller has, after the buyer asks to close, to redeem the last claim (also the default on create). */
export const CHANNEL_SETTLE_DELAY = 3600;
export const MIN_CHANNEL_SETTLE_DELAY = 3600;
export const MAX_CHANNEL_SETTLE_DELAY = 7 * 86_400;
/** PaymentChannelClaim tfClose. */
export const TF_CLOSE = 0x00020000;

/** The channel cap in drops: the contract total (as every total, formed to the cent). */
export const channelCapDrops = (c: Pick<ContractTerms, 'total'>): bigint => BigInt(Math.round(c.total.amount * DROPS_PER_XRP));
/** One metered unit's price in drops. */
export const unitPriceDrops = (c: Pick<ContractTerms, 'pricePerUnit'>): bigint => BigInt(Math.round(c.pricePerUnit.amount * DROPS_PER_XRP));
/** Units a cumulative channel balance pays for (fractional for metered units such as MB). */
export const unitsForDrops = (c: Pick<ContractTerms, 'pricePerUnit'>, drops: bigint): number => { const p = unitPriceDrops(c); return p > 0n ? Math.round((Number(drops) / Number(p)) * 1e6) / 1e6 : 0; };

/** Exact XRP string for a drops amount (what xrpl.js claim signing takes; no floats, no exponent). */
export const xrpOfDrops = (drops: bigint | string): string => {
  const d = BigInt(drops); if (d < 0n) throw new Error('Negative drops.');
  const whole = d / 1_000_000n; const frac = (d % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
};

/**
 * The PaymentChannelCreate that opens a metered deal's channel: buyer → seller, Amount = the cap in drops, SettleDelay,
 * CancelAfter = end of the 30-day hold from `at`, the buyer's claim-signing public key, and the contract's monetary
 * memo (deliveryIndex 0: a metered deal has one stage).
 */
export function prepareChannelCreate(c: Pick<ContractTerms, 'contractId' | 'total' | 'rail'>, buyerAccount: string, sellerAccount: string, publicKeyHex: string, at: string = new Date().toISOString(), settleDelay: number = CHANNEL_SETTLE_DELAY): Record<string, unknown> {
  if (c.total.currency !== 'XRP') throw new Error('Ledger payment channels carry XRP only.');
  if (contractRail(c) !== 'ledger-channel') throw new Error(`This contract settles on ${contractRail(c)}, not a payment channel.`);
  if (!/^(ED[0-9A-F]{64}|0[23][0-9A-F]{64})$/i.test(publicKeyHex)) throw new Error('PublicKey must be a 33-byte XRPL public key (hex).');
  return { TransactionType: 'PaymentChannelCreate', Account: buyerAccount, Destination: sellerAccount, Amount: channelCapDrops(c).toString(), SettleDelay: settleDelay, PublicKey: publicKeyHex.toUpperCase(), CancelAfter: rippleTime(holdUntil(at)), Memos: [buildMemo({ class: 'monetary', contractId: c.contractId, deliveryIndex: 0, currency: 'XRP' })] };
}

/** The seller's PaymentChannelClaim redeeming a buyer-signed claim for cumulative `balanceDrops`; `close` also closes the channel (the remainder returns to the buyer). */
export function prepareChannelClaim(sellerAccount: string, channelId: string, balanceDrops: bigint | string, signatureHex: string, publicKeyHex: string, close = false): Record<string, unknown> {
  const b = BigInt(balanceDrops).toString();
  return { TransactionType: 'PaymentChannelClaim', Account: sellerAccount, Channel: channelId.toUpperCase(), Balance: b, Amount: b, Signature: signatureHex.toUpperCase(), PublicKey: publicKeyHex.toUpperCase(), ...(close ? { Flags: TF_CLOSE } : {}) };
}

/** A close request: the seller's closes at once; the buyer's closes at once only after expiry, otherwise after SettleDelay. */
export function prepareChannelClose(submitter: string, channelId: string): Record<string, unknown> {
  return { TransactionType: 'PaymentChannelClaim', Account: submitter, Channel: channelId.toUpperCase(), Flags: TF_CLOSE };
}

/** The channel a validated PaymentChannelCreate made (Account, Destination, Sequence or TicketSequence). */
export const channelIdOf = (lt: LedgerTx): string => hashes.hashPaymentChannel(lt.account, lt.destination ?? '', escrowSequenceOf(lt)).toUpperCase();

/** What the metadata shows happened to the PayChannel object `channelId` (null when it does not touch it). */
export function payChannelNode(lt: LedgerTx, channelId: string): { kind: 'CreatedNode' | 'ModifiedNode' | 'DeletedNode'; fields: Record<string, unknown> } | null {
  const nodes = (lt.meta?.AffectedNodes as Array<Record<string, Record<string, unknown>>> | undefined) ?? [];
  for (const n of nodes) for (const kind of ['CreatedNode', 'ModifiedNode', 'DeletedNode'] as const) {
    const x = n[kind];
    if (x && x.LedgerEntryType === 'PayChannel' && String(x.LedgerIndex ?? '').toUpperCase() === channelId.toUpperCase()) return { kind, fields: ((kind === 'CreatedNode' ? x.NewFields : x.FinalFields) as Record<string, unknown> | undefined) ?? {} };
  }
  return null;
}

/** What must be true of a validated PaymentChannelCreate for it to open a metered contract's channel. Returns problems (empty = ok). */
export function checkChannelCreate(lt: LedgerTx, expect: { network: XrplNetwork; contractId: string; buyerAccount: string; sellerAccount: string; drops: string }): string[] {
  const p: string[] = [];
  if (lt.network !== expect.network) p.push(`On ${lt.network}; this marketplace settles on ${expect.network}.`);
  if (!lt.validated) p.push('Not in a validated ledger yet.');
  if (lt.result !== 'tesSUCCESS') p.push(`Result ${lt.result || 'unknown'}, not tesSUCCESS.`);
  if (lt.type !== 'PaymentChannelCreate') p.push(`It is a ${lt.type}, not a PaymentChannelCreate.`);
  if (lt.account !== expect.buyerAccount) p.push(`Opened from ${lt.account}, not the buyer's account ${expect.buyerAccount}.`);
  if (lt.destination !== expect.sellerAccount) p.push(`Pays ${lt.destination}, not the seller's account ${expect.sellerAccount}.`);
  if (String(lt.fields.Amount) !== expect.drops) p.push(`Caps the channel at ${String(lt.fields.Amount)} drops; the contract's cap is ${expect.drops}.`);
  if (typeof lt.fields.PublicKey !== 'string' || !lt.fields.PublicKey) p.push('No PublicKey: claims could not be checked.');
  const sd = Number(lt.fields.SettleDelay);
  if (!Number.isInteger(sd) || sd < MIN_CHANNEL_SETTLE_DELAY || sd > MAX_CHANNEL_SETTLE_DELAY) p.push(`SettleDelay ${String(lt.fields.SettleDelay)} s is outside ${MIN_CHANNEL_SETTLE_DELAY}–${MAX_CHANNEL_SETTLE_DELAY} s.`);
  if (!memoFor(lt).some((m) => m.contractId === expect.contractId && m.deliveryIndex === 0)) p.push('Memo does not name this contract.');
  if (lt.meta && !payChannelNode(lt, channelIdOf(lt))) p.push('The metadata shows no channel created at the expected id.');
  return p;
}

/** A validated PaymentChannelClaim on `channelId`, and the channel's Balance (drops) and state the metadata shows after it. */
export function checkChannelClaim(lt: LedgerTx, expect: { network: XrplNetwork; channelId: string; submitter?: string }): { problems: string[]; balanceDrops: bigint | null; deleted: boolean; amountDrops: bigint | null } {
  const p: string[] = [];
  if (lt.network !== expect.network) p.push(`On ${lt.network}; this marketplace settles on ${expect.network}.`);
  if (!lt.validated) p.push('Not in a validated ledger yet.');
  if (lt.result !== 'tesSUCCESS') p.push(`Result ${lt.result || 'unknown'}, not tesSUCCESS.`);
  if (lt.type !== 'PaymentChannelClaim') p.push(`It is a ${lt.type}, not a PaymentChannelClaim.`);
  if (String(lt.fields.Channel ?? '').toUpperCase() !== expect.channelId.toUpperCase()) p.push('Claims on a different channel.');
  if (expect.submitter && lt.account !== expect.submitter) p.push(`Submitted by ${lt.account}, not ${expect.submitter}.`);
  const node = payChannelNode(lt, expect.channelId);
  if (!node) p.push('The metadata does not show this channel changed: nothing was redeemed.');
  const num = (v: unknown) => (typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : null);
  // A channel that never paid anything has no Balance field: zero.
  const balanceDrops = node ? (num(node.fields.Balance) ?? 0n) : null;
  return { problems: p, balanceDrops, deleted: node?.kind === 'DeletedNode', amountDrops: node ? num(node.fields.Amount) : null };
}

/** The buyer signs a claim for the cumulative `drops` used so far (off the ledger; give it to the seller). */
export function signChannelClaim(channelId: string, drops: bigint | string, privateKeyHex: string): string {
  return signPaymentChannelClaim(channelId.toUpperCase(), xrpOfDrops(drops), privateKeyHex).toUpperCase();
}

/** Whether `signatureHex` is the channel key's claim for cumulative `drops` on `channelId`. */
export function verifyChannelClaim(channelId: string, drops: bigint | string, signatureHex: string, publicKeyHex: string): boolean {
  try { return verifyPaymentChannelClaim(channelId.toUpperCase(), xrpOfDrops(drops), signatureHex, publicKeyHex); } catch { return false; }
}

/**
 * The fee on one redemption: the fee on the new cumulative balance minus the fee on the previous one, so the flat and
 * per-record fees fall on the first redemption and the percentage is exact over the whole channel however it is
 * redeemed (the increments telescope). A channel pays only the seller, so the seller pays this from their own
 * account with direct Payments: one to the collection account, or one per DARC recipient (the increment's fee
 * routed by share; summed over redemptions a recipient can differ by a drop from routing the total once).
 */
export function channelFeeQuote(c: Pick<ContractTerms, 'fees'>, priorDrops: bigint, newDrops: bigint): FeeQuote {
  const terms = c.fees ?? null;
  const cum = (d: bigint) => (d <= 0n ? null : quoteFees(terms, { amount: Number(d) / DROPS_PER_XRP, currency: 'XRP' }, { records: stageRecords(0), flat: true }));
  const now = cum(newDrops); const before = cum(priorDrops);
  const feeUnits = (now?.feeUnits ?? 0) - (before?.feeUnits ?? 0);
  const grossUnits = Number(newDrops - priorDrops);
  const lines = (now?.lines ?? []).map((l) => ({ ...l, units: l.units - (before?.lines.find((b) => b.kind === l.kind)?.units ?? 0) })).filter((l) => l.units !== 0);
  const legs = terms && feeUnits > 0 ? routeRoyalty(feeUnits, terms.recipients) : [];
  const payLegs = terms?.collector && feeUnits > 0 ? [{ account: terms.collector.account, label: terms.collector.label, bps: FULL_BPS, units: feeUnits }] : legs;
  return { currency: 'XRP', grossUnits, lines, feeUnits, netUnits: grossUnits - feeUnits, legs, payLegs, unpriced: now?.unpriced ?? [] };
}

/** The fee Payments the seller signs for one redemption (each with the contract's monetary memo, stage 0). */
export function prepareChannelFeePayments(c: Pick<ContractTerms, 'contractId' | 'fees'>, sellerAccount: string, priorDrops: bigint, newDrops: bigint, network: XrplNetwork): Array<{ account: string; label: string; units: number; tx: Record<string, unknown> }> {
  return channelFeeQuote(c, priorDrops, newDrops).payLegs.filter((l) => l.units > 0).map((l) => ({ account: l.account, label: l.label, units: l.units, tx: preparePayment(sellerAccount, l.account, BigInt(l.units), 'XRP', network, c.contractId, 0) }));
}
