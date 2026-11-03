/**
 * COPE node crystallized. Node ID: v15-28-00-signing-approval.
 * Provenance: m/44'/144'/100'/principles/cope/v1#marketplace
 *
 * Deal-bound signing approval: before a wallet signs an escrow transaction,
 * an independent party (the CAPPZ check service, or anyone running these
 * rules) replays the marketplace's public log and confirms that this exact,
 * unsigned XRPL transaction is what the deal allows right now: the contract
 * and milestone exist and are actionable, the signer is the buyer on the
 * buyer's profile, the destination, amount, condition, hold and memo match
 * the deal's terms, the fee is capped, the transaction expires, and an agent
 * buyer is within its mandate (with co-signature above its threshold).
 *
 * The approval is signed (Ed25519, domain-separated from check reports) over
 * the canonical JSON of the decision, which carries the SHA-256 of the
 * canonical unsigned transaction. A guard in front of the wallet recomputes
 * that hash from the transaction it is about to sign: any field changed after
 * approval, an expired approval, or another key fails verifyApproval. The
 * transaction's own Sequence and LastLedgerSequence make it single-use on the
 * ledger, so a replayed approval can never move money twice.
 *
 * Trust boundaries: the approval says "the public log allowed this at
 * `issuedAt`" and nothing more. The wallet still signs, the ledger still
 * validates, and the marketplace still records settlement only from the
 * validated ledger.
 */
import { ed25519 } from '@noble/curves/ed25519';
import type { XrplNetwork } from '../xrpl/ledgerCheck';
import type { MarketState } from './replay';
import type { ContractView } from './types';
import { checkMandate, milestoneAmounts } from './rules';
import { milestoneEscrowLegs, RIPPLE_EPOCH } from './settlement';
import { HOLD_LIMIT_DAYS } from './stageMath';
import { canonicalJson } from './counterpartyCheck';

export type ApprovalAction = 'fund' | 'release' | 'refund';

export interface SigningIntent {
  network: XrplNetwork;
  contractId: string;
  milestone: number;
  /** The unsigned transaction exactly as the wallet will sign it (autofilled: Fee, Sequence, LastLedgerSequence). */
  tx: Record<string, unknown>;
  /** Agent buyers above their mandate's approval threshold: the granting party that co-signed. */
  coSignedBy?: string;
}

export interface ApprovalReason { code: string; message: string }

export interface SigningApproval {
  v: 1;
  kind: 'cappz-signing-approval';
  network: XrplNetwork;
  contractId: string;
  milestone: number;
  action: ApprovalAction;
  /** SHA-256 (hex) of the canonical unsigned transaction: the one thing this approval covers. */
  txHash: string;
  account: string;
  destination: string | null;
  amountDrops: string | null;
  /** The ledger-side expiry of the transaction itself. */
  lastLedgerSequence: number;
  /** The party acting (the buyer) and, for agents, the mandate decision. */
  actorPartyId: string;
  mandate: string | null;
  coSignedBy: string | null;
  /** The contract's state when approved (lifecycle + why), so a later dispute is visibly after it. */
  contractState: string;
  contractBecause: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

export interface SignedApproval { approval: SigningApproval; signature: { alg: 'Ed25519'; publicKey: string; value: string } }

export type Decision = { approved: true; approval: SigningApproval } | { approved: false; reasons: ApprovalReason[] };

/** How long an approval stays valid (the transaction's LastLedgerSequence usually ends it sooner). */
export const APPROVAL_TTL_MS = 10 * 60 * 1000;
/** The most an approved transaction may pay in network fees (0.01 XRP; ordinary fees are ~12 drops). */
export const MAX_FEE_DROPS = 10_000;
/** Signature domain: an approval signature can never be mistaken for a check-report signature. */
export const APPROVAL_DOMAIN = 'cappz-signing-approval/v1\n';

/** Fields a wallet adds while signing, or that are not part of what was approved. */
const SIGNING_FIELDS = new Set(['SigningPubKey', 'TxnSignature', 'Signers']);
/** The only fields each approved transaction type may carry. Anything else is refused (no hidden flags, tags or paths). */
const ALLOWED: Record<string, readonly string[]> = {
  EscrowCreate: ['TransactionType', 'Account', 'Destination', 'Amount', 'Condition', 'CancelAfter', 'Memos', 'Fee', 'Sequence', 'LastLedgerSequence', 'Flags', 'NetworkID'],
  EscrowFinish: ['TransactionType', 'Account', 'Owner', 'OfferSequence', 'Condition', 'Fulfillment', 'Fee', 'Sequence', 'LastLedgerSequence', 'Flags', 'NetworkID'],
  EscrowCancel: ['TransactionType', 'Account', 'Owner', 'OfferSequence', 'Fee', 'Sequence', 'LastLedgerSequence', 'Flags', 'NetworkID'],
};

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
const fromHexUtf8 = (h: string) => { try { return new TextDecoder().decode(unhex(h)); } catch { return ''; } };

/** The unsigned transaction as approved: signing fields dropped, canonical JSON. */
export function unsignedCanonical(tx: Record<string, unknown>): string {
  return canonicalJson(Object.fromEntries(Object.entries(tx).filter(([k]) => !SIGNING_FIELDS.has(k))));
}

/** SHA-256 (hex) of the canonical unsigned transaction. */
export async function intentHash(tx: Record<string, unknown>): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(unsignedCanonical(tx)))));
}

const memoNames = (tx: Record<string, unknown>, contractId: string, milestone: number): boolean => {
  const memos = Array.isArray(tx.Memos) ? (tx.Memos as Array<{ Memo?: { MemoType?: string; MemoData?: string } }>) : [];
  return memos.some((m) => {
    if (fromHexUtf8(m.Memo?.MemoType ?? '') !== 'cappz-marketplace-monetary') return false;
    try { const d = JSON.parse(fromHexUtf8(m.Memo?.MemoData ?? '')) as { contractId?: string; deliveryIndex?: number }; return d.contractId === contractId && d.deliveryIndex === milestone; } catch { return false; }
  });
};

const isCondition = (c: unknown) => typeof c === 'string' && /^A0258020[0-9A-F]{64}810120$/i.test(c);

/**
 * Decide whether the public log allows `intent.tx` now. Pure: the caller supplies the replayed market and the time.
 * Every reason is returned (not just the first), so a refusal says everything that is wrong.
 */
export async function evaluateSigningIntent(state: MarketState, intent: SigningIntent, now: string, nonce: string = hex(crypto.getRandomValues(new Uint8Array(16)))): Promise<Decision> {
  const r: ApprovalReason[] = [];
  const no = (code: string, message: string) => { r.push({ code, message }); };
  const tx = intent.tx ?? {};
  const type = String(tx.TransactionType ?? '');
  const action: ApprovalAction | null = type === 'EscrowCreate' ? 'fund' : type === 'EscrowFinish' ? 'release' : type === 'EscrowCancel' ? 'refund' : null;
  if (!action) return { approved: false, reasons: [{ code: 'tx-type', message: `Only EscrowCreate, EscrowFinish and EscrowCancel are approved here, not ${type || 'an unknown type'}.` }] };

  const extra = Object.keys(tx).filter((k) => !SIGNING_FIELDS.has(k) && !ALLOWED[type].includes(k));
  if (extra.length) no('tx-extra-fields', `The transaction carries fields a ${type} for this deal never needs: ${extra.join(', ')}.`);
  if (tx.Flags !== undefined && Number(tx.Flags) !== 0 && Number(tx.Flags) !== 0x80000000) no('tx-flags', 'Unexpected transaction flags.');
  const fee = Number(tx.Fee);
  if (!Number.isInteger(fee) || fee <= 0) no('fee-missing', 'Fee must be set (autofill the transaction before asking for approval).');
  else if (fee > MAX_FEE_DROPS) no('fee-cap', `Fee ${fee} drops is above the ${MAX_FEE_DROPS}-drop cap.`);
  const lls = Number(tx.LastLedgerSequence);
  if (!Number.isInteger(lls) || lls <= 0) no('no-expiry', 'LastLedgerSequence must be set so the transaction expires on the ledger.');
  if (!Number.isInteger(Number(tx.Sequence))) no('no-sequence', 'Sequence must be set (autofill the transaction first).');

  const contract: ContractView | undefined = state.contracts.find((x) => x.contractId === intent.contractId);
  if (!contract) return { approved: false, reasons: [...r, { code: 'no-contract', message: `No contract ${intent.contractId} on the ${intent.network} market.` }] };
  if (contract.total.currency !== 'XRP') no('not-xrp', 'This contract is priced in USD; it does not settle by XRPL escrow.');
  const buyer = state.parties.get(contract.buyerId); const seller = state.parties.get(contract.sellerId);
  const buyerAccount = buyer?.xrplAccount ?? null; const sellerAccount = seller?.xrplAccount ?? null;
  if (!buyerAccount) no('buyer-no-account', 'The buyer has no XRPL account on their profile.');
  if (!sellerAccount) no('seller-no-account', 'The seller has no XRPL account on their profile.');
  if (buyerAccount && tx.Account !== buyerAccount) no('not-buyer', `Signed by ${String(tx.Account)}, not the buyer's profile account ${buyerAccount}.`);

  const ms = contract.milestoneStates[intent.milestone];
  if (!ms) return { approved: false, reasons: [...r, { code: 'no-milestone', message: `Contract ${contract.contractId} has no milestone ${intent.milestone}.` }] };
  const current = contract.milestoneStates.find((m) => m.state !== 'released');
  const openDispute = contract.disputes.some((d) => !d.resolved);
  const escrow = contract.ledgerEscrows.find((e) => e.milestone === intent.milestone);
  const settled = contract.ledgerSettlements.some((s) => s.milestone === intent.milestone);

  let destination: string | null = null; let amountDrops: string | null = null;
  let mandateNote: string | null = null; let coSignedBy: string | null = null;

  if (action === 'fund') {
    if (contract.state === 'cancelled' || contract.state === 'completed') no('contract-closed', `The contract is ${contract.state}.`);
    if (openDispute || contract.state === 'disputed') no('disputed', 'The contract has an open dispute; nothing is funded until it is decided.');
    if (!current || current.index !== intent.milestone) no('not-current-stage', `Milestone ${intent.milestone} is not the stage to fund now${current ? ` (stage ${current.index} is)` : ''}.`);
    if (escrow) no('already-funded', `Milestone ${intent.milestone} is already escrowed (${escrow.txHash}).`);
    destination = String(tx.Destination ?? ''); amountDrops = typeof tx.Amount === 'string' ? tx.Amount : null;
    if (amountDrops === null || !/^\d+$/.test(amountDrops)) no('amount-not-xrp', 'Amount must be XRP drops (a string of digits).');
    if (sellerAccount) {
      const legs = milestoneEscrowLegs(contract, intent.milestone, sellerAccount);
      if (!legs.some((l) => l.account === destination && l.drops === amountDrops)) no('leg-mismatch', `No leg of milestone ${intent.milestone} pays ${amountDrops ?? '?'} drops to ${destination || '?'}; the deal's legs are ${legs.map((l) => `${l.drops} → ${l.account} (${l.label})`).join(', ')}.`);
    }
    if (!isCondition(tx.Condition)) no('no-condition', 'The escrow must be locked by a PREIMAGE-SHA-256 condition (32-byte secret).');
    const cancelAfter = Number(tx.CancelAfter);
    const nowRipple = Math.floor(Date.parse(now) / 1000) - RIPPLE_EPOCH;
    if (!Number.isInteger(cancelAfter)) no('no-cancel-after', 'CancelAfter must be set so an unreleased stage returns to the buyer.');
    else if (cancelAfter <= nowRipple) no('cancel-after-past', 'CancelAfter is in the past.');
    else if (cancelAfter > nowRipple + (HOLD_LIMIT_DAYS + 1) * 86_400) no('hold-too-long', `CancelAfter holds the stage longer than the ${HOLD_LIMIT_DAYS}-day limit.`);
    if (!memoNames(tx, contract.contractId, intent.milestone)) no('memo', 'The memo must name this contract and milestone.');
    // Agent buyers: the mandate in force now, for this stage's value.
    if (buyer?.kind === 'agent') {
      const amount = milestoneAmounts(contract.total.amount, contract.milestones)[intent.milestone];
      const today = state.committedByDay.get(`${buyer.partyId}|${now.slice(0, 10)}`) ?? 0;
      const m = checkMandate(state.mandates, buyer.partyId, 'marketplace.escrow.fund', { amount, currency: contract.total.currency }, contract.categoryId, now, today);
      mandateNote = m.reason;
      if (!m.ok) no('mandate', `Agent ${buyer.name}: ${m.reason}`);
      else if (m.needsApproval) {
        const grantors = new Set(state.mandates.filter((x) => x.agentPartyId === buyer.partyId).map((x) => x.grantedBy));
        if (!intent.coSignedBy || !grantors.has(intent.coSignedBy)) no('co-signature', `Agent ${buyer.name}: ${m.reason} — co-signature missing.`);
        else coSignedBy = intent.coSignedBy;
      }
    }
  } else {
    // release (EscrowFinish) / refund (EscrowCancel): an escrow this deal created, not yet settled.
    if (!escrow) no('not-funded', `Milestone ${intent.milestone} has no ledger escrow to ${action}.`);
    if (settled) no('already-settled', `Milestone ${intent.milestone} is already settled on the ledger.`);
    if (buyerAccount && tx.Owner !== buyerAccount) no('owner', 'The escrow owner must be the buyer.');
    const sequences = escrow ? [escrow.sequence, ...escrow.feeEscrows.map((f) => f.sequence)] : [];
    if (!sequences.includes(Number(tx.OfferSequence))) no('offer-sequence', `OfferSequence ${String(tx.OfferSequence)} is not one of this milestone's escrows (${sequences.join(', ') || 'none'}).`);
    if (action === 'release') {
      if (openDispute || ms.state === 'disputed') no('disputed', 'This stage is disputed; an operator decides release or refund.');
      if (ms.state !== 'affirmed') no('not-accepted', `The buyer has not accepted this stage's evidence (state ${ms.state}).`);
      if (escrow && String(tx.Condition ?? '').toUpperCase() !== escrow.condition.toUpperCase()) no('condition', 'Condition is not the one this milestone was escrowed under.');
      if (typeof tx.Fulfillment !== 'string' || !tx.Fulfillment) no('no-fulfillment', 'A release needs the fulfillment (the stage secret).');
    }
  }

  if (r.length) return { approved: false, reasons: r };
  const issuedAt = now;
  return {
    approved: true,
    approval: {
      v: 1, kind: 'cappz-signing-approval', network: intent.network, contractId: contract.contractId, milestone: intent.milestone, action,
      txHash: await intentHash(tx), account: String(tx.Account), destination, amountDrops, lastLedgerSequence: lls,
      actorPartyId: contract.buyerId, mandate: mandateNote, coSignedBy,
      contractState: contract.state, contractBecause: contract.because,
      nonce, issuedAt, expiresAt: new Date(Date.parse(now) + APPROVAL_TTL_MS).toISOString(),
    },
  };
}

/** Sign an approval with the service key (32-byte Ed25519 seed, hex). */
export function signApproval(approval: SigningApproval, seedHex: string): SignedApproval {
  const seed = unhex(seedHex);
  const msg = new TextEncoder().encode(APPROVAL_DOMAIN + canonicalJson(approval));
  return { approval, signature: { alg: 'Ed25519', publicKey: hex(ed25519.getPublicKey(seed)), value: hex(ed25519.sign(msg, seed)) } };
}

/**
 * What a guard checks before letting a wallet sign: the signature (against the published key), the expiry, and that
 * the transaction it holds is exactly the approved one. Returns the problems (empty = sign).
 */
export async function verifyApproval(signed: SignedApproval, tx: Record<string, unknown>, expectedPublicKey: string, now: string = new Date().toISOString()): Promise<string[]> {
  const p: string[] = [];
  if (!signed?.approval || !signed.signature) return ['No approval.'];
  if (signed.signature.publicKey.toLowerCase() !== expectedPublicKey.toLowerCase()) p.push('Signed by a key other than the published one.');
  let ok = false;
  try { ok = ed25519.verify(unhex(signed.signature.value), new TextEncoder().encode(APPROVAL_DOMAIN + canonicalJson(signed.approval)), unhex(signed.signature.publicKey)); } catch { ok = false; }
  if (!ok) p.push('The approval signature does not verify.');
  if (signed.approval.kind !== 'cappz-signing-approval' || signed.approval.v !== 1) p.push('Not a CAPPZ signing approval.');
  if (Date.parse(signed.approval.expiresAt) <= Date.parse(now)) p.push('The approval has expired.');
  if ((await intentHash(tx)) !== signed.approval.txHash) p.push('The transaction differs from the one approved.');
  return p;
}
