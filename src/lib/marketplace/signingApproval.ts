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
 * buyer is within its mandate (with co-signature above its threshold). A
 * subcontract stage is approved only after the parent milestone it serves was
 * released (rules.subcontractGate).
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
import { decode, deriveAddress, verifySignature } from 'xrpl';
import type { XrplNetwork } from '../xrpl/ledgerCheck';
import type { MarketState } from './replay';
import type { ContractView } from './types';
import { checkMandate, committedKey, milestoneAmounts, subcontractGate } from './rules';
import { MAX_CHANNEL_SETTLE_DELAY, MIN_CHANNEL_SETTLE_DELAY, TF_CLOSE, channelCapDrops, contractRail, milestoneEscrowLegs, RIPPLE_EPOCH, stagePaymentLegs, verifyChannelClaim } from './settlement';
import { assetLabel } from './paymentAssets';
import { ledgerAmount } from './ledgerPayments';
import { HOLD_LIMIT_DAYS } from './stageMath';
import { canonicalJson } from './counterpartyCheck';
import { NOT_SIGNED, requestAuthDecision, type RequestAuth, type RequestAuthState, type RequestSignHook } from './agentRequestAuth';

/**
 * fund/release/refund: XRP escrow legs (EscrowCreate/Finish/Cancel). pay: a stage paid directly on the ledger in an
 * issued token (Payment, rail ledger-staged). channel: the buyer opening a metered deal's payment channel
 * (PaymentChannelCreate, rail ledger-channel). claim: a PaymentChannelClaim on that channel — the seller redeeming a
 * buyer-signed claim (optionally closing), or either party closing it.
 */
export type ApprovalAction = 'fund' | 'release' | 'refund' | 'pay' | 'channel' | 'claim';

export interface SigningIntent {
  network: XrplNetwork;
  contractId: string;
  milestone: number;
  /** The unsigned transaction exactly as the wallet will sign it (autofilled: Fee, Sequence, LastLedgerSequence). */
  tx: Record<string, unknown>;
  /** Agent buyers above their mandate's approval threshold: the grantor's signed co-signature of this stage. */
  coSignature?: CoSignature;
  /**
   * v15-31-00: how the request asking for this approval was signed (agentRequestAuth.ts), verified by the service.
   * Recorded in the approval; required to be `verified-bound` only when the buyer's mandate is bound to a key.
   */
  requestAuth?: RequestAuth;
}

// ─── Co-signature: the mandate's grantor signs the stage, with their own XRPL key ───
//
// Above an agent's approval threshold, a person (the party that granted the mandate) must agree. They sign a
// statement naming the network, contract, stage, action, amount and an expiry, as the memo of an AccountSet that
// is signed and never submitted (LastLedgerSequence 1 has long passed, Fee 0): any XRPL wallet can sign it, and
// anyone can check it was the grantor's profile account, by its master key, that agreed — not a name typed in.

export const CO_SIGN_MEMO_TYPE = 'cappz/co-signature';
/** `amountDrops` is the stage's full amount in the asset's smallest units (drops for XRP, micro-units for issued tokens). */
export interface CoSignTerms { network: XrplNetwork; contractId: string; milestone: number; action: 'fund' | 'pay' | 'channel'; amountDrops: string; expiresAt: string }
export interface CoSignature { terms: CoSignTerms; txBlob: string }

export const coSignStatement = (t: CoSignTerms) => ['CAPPZ co-signature v1', `network: ${t.network}`, `contract: ${t.contractId}`, `milestone: ${t.milestone}`, `action: ${t.action}`, `amount-drops: ${t.amountDrops}`, `expires: ${t.expiresAt}`].join('\n');
const utf8Hex = (s: string) => hex(new TextEncoder().encode(s)).toUpperCase();

/** The unsigned AccountSet a grantor signs (and never submits) to co-sign a stage. */
export function coSignTx(account: string, t: CoSignTerms): Record<string, unknown> {
  return { TransactionType: 'AccountSet', Account: account, Fee: '0', Sequence: 0, LastLedgerSequence: 1, Memos: [{ Memo: { MemoType: utf8Hex(CO_SIGN_MEMO_TYPE), MemoData: utf8Hex(coSignStatement(t)) } }] };
}

/** The terms a grantor co-signs for one stage of an agent's deal — the same terms the approval checks (shared by the CLI and the web app). */
export function coSignTermsFor(c: ContractView, milestone: number, sellerAccount: string, network: XrplNetwork, expiresAt: string): CoSignTerms {
  const rail = contractRail(c);
  const action: CoSignTerms['action'] = rail === 'ledger-staged' ? 'pay' : rail === 'ledger-channel' ? 'channel' : 'fund';
  const amountDrops = action === 'channel' ? channelCapDrops(c).toString() : (action === 'pay' ? stagePaymentLegs(c, milestone, sellerAccount).map((l) => l.units) : milestoneEscrowLegs(c, milestone, sellerAccount).map((l) => l.drops)).reduce((n, u) => n + BigInt(u), 0n).toString();
  return { network, contractId: c.contractId, milestone: action === 'channel' ? 0 : milestone, action, amountDrops, expiresAt };
}

/** Problems with a co-signature as `account`'s agreement to `cs.terms` (empty = valid). */
export function verifyCoSignature(cs: CoSignature, account: string, now: string): string[] {
  const p: string[] = [];
  let tx: Record<string, unknown>;
  try { tx = decode(cs.txBlob) as Record<string, unknown>; } catch { return ['Not an XRPL transaction.']; }
  if (tx.TransactionType !== 'AccountSet') p.push('A co-signature is an AccountSet.');
  if (['SetFlag', 'ClearFlag', 'Domain', 'EmailHash', 'MessageKey', 'TransferRate', 'TickSize', 'NFTokenMinter'].some((f) => tx[f] !== undefined)) p.push('A co-signature must not change the account.');
  if (tx.Account !== account) p.push(`Signed by ${String(tx.Account)}, not ${account}.`);
  let derived = ''; try { derived = deriveAddress(String(tx.SigningPubKey ?? '')); } catch { /* below */ }
  if (derived !== account) p.push('Not signed by the account\'s master key.');
  const memos = Array.isArray(tx.Memos) ? (tx.Memos as Array<{ Memo?: { MemoType?: string; MemoData?: string } }>) : [];
  if (!memos.some((m) => m.Memo?.MemoType?.toUpperCase() === utf8Hex(CO_SIGN_MEMO_TYPE) && m.Memo?.MemoData?.toUpperCase() === utf8Hex(coSignStatement(cs.terms)))) p.push('The memo is not the co-signature statement for these terms.');
  let ok = false; try { ok = verifySignature(cs.txBlob); } catch { ok = false; }
  if (!ok) p.push('The signature does not verify.');
  if (!(Date.parse(cs.terms.expiresAt) > Date.parse(now))) p.push('The co-signature has expired.');
  return p;
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
  /** v15-31-00: the request-auth state the service saw (absent on approvals from callers that pass none). */
  requestAuth?: { state: RequestAuthState; partyId: string | null; keyId?: string; because: string };
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
  // No SendMax, Paths, DeliverMin or DestinationTag: a stage payment delivers exactly the leg, directly.
  Payment: ['TransactionType', 'Account', 'Destination', 'Amount', 'Memos', 'Fee', 'Sequence', 'LastLedgerSequence', 'Flags', 'NetworkID'],
  // No DestinationTag or SourceTag: the channel names the deal by its memo; no Expiration (CancelAfter bounds it).
  PaymentChannelCreate: ['TransactionType', 'Account', 'Destination', 'Amount', 'SettleDelay', 'PublicKey', 'CancelAfter', 'Memos', 'Fee', 'Sequence', 'LastLedgerSequence', 'Flags', 'NetworkID'],
  PaymentChannelClaim: ['TransactionType', 'Account', 'Channel', 'Balance', 'Amount', 'Signature', 'PublicKey', 'Fee', 'Sequence', 'LastLedgerSequence', 'Flags', 'NetworkID'],
};
/** Flags each type may carry beyond none/tfFullyCanonicalSig: a claim may close the channel (tfClose); nothing may renew it. */
const EXTRA_FLAGS: Record<string, number> = { PaymentChannelClaim: TF_CLOSE };

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
  const action: ApprovalAction | null = type === 'EscrowCreate' ? 'fund' : type === 'EscrowFinish' ? 'release' : type === 'EscrowCancel' ? 'refund' : type === 'Payment' ? 'pay' : type === 'PaymentChannelCreate' ? 'channel' : type === 'PaymentChannelClaim' ? 'claim' : null;
  if (!action) return { approved: false, reasons: [{ code: 'tx-type', message: `Only EscrowCreate, EscrowFinish, EscrowCancel, stage Payments and payment-channel transactions are approved here, not ${type || 'an unknown type'}.` }] };

  const extra = Object.keys(tx).filter((k) => !SIGNING_FIELDS.has(k) && !ALLOWED[type].includes(k));
  if (extra.length) no('tx-extra-fields', `The transaction carries fields a ${type} for this deal never needs: ${extra.join(', ')}.`);
  if (tx.Flags !== undefined && (Number(tx.Flags) & ~(0x80000000 | (EXTRA_FLAGS[type] ?? 0))) !== 0) no('tx-flags', 'Unexpected transaction flags.');
  const fee = Number(tx.Fee);
  if (!Number.isInteger(fee) || fee <= 0) no('fee-missing', 'Fee must be set (autofill the transaction before asking for approval).');
  else if (fee > MAX_FEE_DROPS) no('fee-cap', `Fee ${fee} drops is above the ${MAX_FEE_DROPS}-drop cap.`);
  const lls = Number(tx.LastLedgerSequence);
  if (!Number.isInteger(lls) || lls <= 0) no('no-expiry', 'LastLedgerSequence must be set so the transaction expires on the ledger.');
  if (!Number.isInteger(Number(tx.Sequence))) no('no-sequence', 'Sequence must be set (autofill the transaction first).');

  const contract: ContractView | undefined = state.contracts.find((x) => x.contractId === intent.contractId);
  if (!contract) return { approved: false, reasons: [...r, { code: 'no-contract', message: `No contract ${intent.contractId} on the ${intent.network} market.` }] };
  const rail = contractRail(contract);
  const channelAction = action === 'channel' || action === 'claim';
  if (action === 'pay' ? rail !== 'ledger-staged' : channelAction ? rail !== 'ledger-channel' : rail !== 'ledger-escrow') no(action === 'pay' ? 'not-staged' : channelAction ? 'not-channel' : 'not-xrp', `This contract is priced in ${assetLabel(contract.total.currency)} and settles on ${rail}; ${action === 'pay' ? 'it is not paid stage by stage on the ledger' : channelAction ? 'it is not a metered deal paid through a ledger channel' : 'it does not settle by XRPL escrow'}.`);
  const buyer = state.parties.get(contract.buyerId); const seller = state.parties.get(contract.sellerId);
  const buyerAccount = buyer?.xrplAccount ?? null; const sellerAccount = seller?.xrplAccount ?? null;
  if (!buyerAccount) no('buyer-no-account', 'The buyer has no XRPL account on their profile.');
  if (!sellerAccount) no('seller-no-account', 'The seller has no XRPL account on their profile.');
  // A claim is signed by the seller (redeeming) or either party (closing); everything else by the buyer.
  if (action === 'claim') { if (tx.Account !== buyerAccount && tx.Account !== sellerAccount) no('not-party', `Signed by ${String(tx.Account)}, neither party's profile account.`); }
  else if (buyerAccount && tx.Account !== buyerAccount) no('not-buyer', `Signed by ${String(tx.Account)}, not the buyer's profile account ${buyerAccount}.`);

  const ms = contract.milestoneStates[intent.milestone];
  if (!ms) return { approved: false, reasons: [...r, { code: 'no-milestone', message: `Contract ${contract.contractId} has no milestone ${intent.milestone}.` }] };
  const current = contract.milestoneStates.find((m) => m.state !== 'released');
  const openDispute = contract.disputes.some((d) => !d.resolved);
  const escrow = contract.ledgerEscrows.find((e) => e.milestone === intent.milestone);
  const settled = contract.ledgerSettlements.some((s) => s.milestone === intent.milestone);

  let destination: string | null = null; let amountDrops: string | null = null;
  let mandateNote: string | null = null; let coSignedBy: string | null = null;

  if (action === 'channel') {
    // Open a metered deal's channel: exactly the cap, to the seller, held at most one billing cycle.
    if (contract.state === 'cancelled' || contract.state === 'completed') no('contract-closed', `The contract is ${contract.state}.`);
    if (openDispute || contract.state === 'disputed') no('disputed', 'The contract has an open dispute; nothing is funded until it is decided.');
    if (intent.milestone !== 0) no('not-current-stage', 'A metered deal has one stage (milestone 0).');
    if (contract.channel) no('already-funded', `The channel is already open (${contract.channel.channelId}).`);
    destination = String(tx.Destination ?? ''); amountDrops = typeof tx.Amount === 'string' ? tx.Amount : null;
    const cap = channelCapDrops(contract).toString();
    if (amountDrops === null || !/^\d+$/.test(amountDrops)) no('amount-not-xrp', 'Amount must be XRP drops (a string of digits): ledger channels carry XRP only.');
    else if (amountDrops !== cap) no('cap-mismatch', `The channel must hold exactly the contract cap, ${cap} drops, not ${amountDrops}.`);
    if (sellerAccount && destination !== sellerAccount) no('destination', `The channel pays ${destination || '?'}, not the seller's profile account ${sellerAccount}.`);
    if (typeof tx.PublicKey !== 'string' || !/^(ED[0-9A-F]{64}|0[23][0-9A-F]{64})$/i.test(tx.PublicKey)) no('public-key', 'PublicKey must be the 33-byte key that will sign claims.');
    const sd = Number(tx.SettleDelay);
    if (!Number.isInteger(sd) || sd < MIN_CHANNEL_SETTLE_DELAY || sd > MAX_CHANNEL_SETTLE_DELAY) no('settle-delay', `SettleDelay must be ${MIN_CHANNEL_SETTLE_DELAY}–${MAX_CHANNEL_SETTLE_DELAY} seconds, so the seller can redeem the last claim before a close.`);
    const cancelAfter = Number(tx.CancelAfter);
    const nowRipple = Math.floor(Date.parse(now) / 1000) - RIPPLE_EPOCH;
    if (!Number.isInteger(cancelAfter)) no('no-cancel-after', 'CancelAfter must be set so an unused remainder returns to the buyer.');
    else if (cancelAfter <= nowRipple) no('cancel-after-past', 'CancelAfter is in the past.');
    else if (cancelAfter > nowRipple + (HOLD_LIMIT_DAYS + 1) * 86_400) no('hold-too-long', `CancelAfter holds the channel longer than the ${HOLD_LIMIT_DAYS}-day limit.`);
    if (!memoNames(tx, contract.contractId, 0)) no('memo', 'The memo must name this contract (stage 0).');
    if (buyer?.kind === 'agent') {
      const today = state.committedByDay.get(committedKey(buyer.partyId, now, contract.total.currency)) ?? 0;
      const m = checkMandate(state.mandates, buyer.partyId, 'marketplace.channel.open', { amount: contract.total.amount, currency: contract.total.currency }, contract.categoryId, now, today);
      mandateNote = m.reason;
      if (!m.ok) no('mandate', `Agent ${buyer.name}: ${m.reason}`);
      else if (m.needsApproval) {
        const grantors = [...new Set(state.mandates.filter((x) => x.agentPartyId === buyer.partyId).map((x) => x.grantedBy))];
        const cs = intent.coSignature;
        if (!cs) no('co-signature', `Agent ${buyer.name}: ${m.reason} — ask ${grantors.join(' or ')} to co-sign this channel (cappz-market cosign ${contract.contractId}).`);
        else {
          const t = cs.terms;
          const termProblems = [t.network !== intent.network && 'network', t.contractId !== contract.contractId && 'contract', t.milestone !== 0 && 'milestone', t.action !== 'channel' && 'action', t.amountDrops !== cap && 'amount'].filter(Boolean);
          const signer = grantors.find((g) => { const acct = state.parties.get(g)?.xrplAccount; return !!acct && verifyCoSignature(cs, acct, now).length === 0; });
          if (termProblems.length) no('co-signature', `The co-signature is for a different ${termProblems.join(', ')}.`);
          else if (!signer) no('co-signature', `The co-signature is not a valid signature by ${grantors.join(' or ')} (their profile XRPL account).`);
          else coSignedBy = signer;
        }
      }
    }
  } else if (action === 'claim') {
    // A claim on this deal's open channel: a redemption (Balance) only by the seller, above what is recorded, within
    // the cap, carrying the buyer's valid claim signature; a close (tfClose) by either party.
    const ch = contract.channel;
    if (!ch) no('not-funded', 'The channel is not open.');
    else if (ch.closed) no('already-settled', 'The channel is already closed.');
    if (ch && String(tx.Channel ?? '').toUpperCase() !== ch.channelId.toUpperCase()) no('channel', 'The claim is for a different channel.');
    const closing = (Number(tx.Flags ?? 0) & TF_CLOSE) !== 0;
    if (tx.Balance === undefined) {
      if (!closing) no('no-balance', 'A claim either redeems a Balance or closes the channel (tfClose).');
      if (tx.Amount !== undefined || tx.Signature !== undefined) no('tx-extra-fields', 'A close carries no Amount or Signature.');
    } else {
      const b = typeof tx.Balance === 'string' && /^\d+$/.test(tx.Balance) ? BigInt(tx.Balance) : null;
      if (sellerAccount && tx.Account !== sellerAccount) no('not-seller', 'Only the seller redeems a claim.');
      if (b === null) no('amount-not-xrp', 'Balance must be XRP drops (a string of digits).');
      else if (ch) {
        if (b <= BigInt(ch.releasedDrops)) no('nothing-new', `Balance ${b} drops is not above the ${ch.releasedDrops} already redeemed.`);
        if (b > BigInt(ch.capDrops)) no('over-cap', `Balance ${b} drops is above the cap of ${ch.capDrops}.`);
        if (tx.Amount !== undefined && String(tx.Amount) !== String(tx.Balance)) no('amount', 'Amount must equal Balance (the claim redeemed).');
        if (typeof tx.PublicKey !== 'string' || tx.PublicKey.toUpperCase() !== ch.publicKey.toUpperCase()) no('public-key', 'PublicKey must be the channel\'s claim key.');
        if (typeof tx.Signature !== 'string' || !verifyChannelClaim(ch.channelId, b, tx.Signature, ch.publicKey)) no('claim-signature', 'The claim signature is not the buyer\'s claim for this Balance on this channel.');
        destination = sellerAccount; amountDrops = (b - BigInt(ch.releasedDrops)).toString();
      }
    }
  } else if (action === 'pay') {
    if (openDispute || contract.state === 'disputed') no('disputed', 'The contract has an open dispute; an operator rules first.');
    if (!current || current.index !== intent.milestone) no('not-current-stage', `Milestone ${intent.milestone} is not the stage to pay now${current ? ` (stage ${current.index} is)` : ''}.`);
    if (ms.state !== 'affirmed') no('not-accepted', `Accept the stage before paying it (state ${ms.state}).`);
    // Subcontracts: paid only after the parent milestone this stage serves was released (one stage exposed at most).
    { const gate = subcontractGate(state.contracts, contract, intent.milestone); if (gate) no('parent-not-released', gate); }
    if (tx.Flags !== undefined && (Number(tx.Flags) & 0x00020000)) no('partial-payment', 'Partial payments are refused: a stage payment delivers the whole leg.');
    destination = String(tx.Destination ?? '');
    const amt = tx.Amount as unknown;
    if (sellerAccount && rail === 'ledger-staged') {
      const legs = stagePaymentLegs(contract, intent.milestone, sellerAccount);
      let want: unknown[] = [];
      try { want = legs.map((l) => ledgerAmount(BigInt(l.units), contract.total.currency, intent.network)); } catch (e) { no('asset-unavailable', (e as Error).message); }
      const i = legs.findIndex((l, k) => l.account === destination && canonicalJson(want[k]) === canonicalJson(amt));
      if (i < 0) no('leg-mismatch', `No leg of milestone ${intent.milestone} pays ${canonicalJson(amt)} to ${destination || '?'}; the deal's legs are ${legs.map((l, k) => `${canonicalJson(want[k])} → ${l.account} (${l.label})`).join(', ')}.`);
      else amountDrops = legs[i].units;
    }
    if (!memoNames(tx, contract.contractId, intent.milestone)) no('memo', 'The memo must name this contract and milestone.');
    if (buyer?.kind === 'agent') {
      const amount = milestoneAmounts(contract.total.amount, contract.milestones)[intent.milestone];
      const today = state.committedByDay.get(committedKey(buyer.partyId, now, contract.total.currency)) ?? 0;
      const m = checkMandate(state.mandates, buyer.partyId, 'marketplace.stage.pay', { amount, currency: contract.total.currency }, contract.categoryId, now, today);
      mandateNote = m.reason;
      if (!m.ok) no('mandate', `Agent ${buyer.name}: ${m.reason}`);
      else if (m.needsApproval) {
        const stageUnits = sellerAccount ? stagePaymentLegs(contract, intent.milestone, sellerAccount).reduce((a, l) => a + BigInt(l.units), 0n).toString() : null;
        const grantors = [...new Set(state.mandates.filter((x) => x.agentPartyId === buyer.partyId).map((x) => x.grantedBy))];
        const cs = intent.coSignature;
        if (!cs) no('co-signature', `Agent ${buyer.name}: ${m.reason} — ask ${grantors.join(' or ')} to co-sign this stage (cappz-market cosign ${contract.contractId}).`);
        else {
          const t = cs.terms;
          const termProblems = [t.network !== intent.network && 'network', t.contractId !== contract.contractId && 'contract', t.milestone !== intent.milestone && 'milestone', t.action !== 'pay' && 'action', t.amountDrops !== stageUnits && 'amount'].filter(Boolean);
          const signer = grantors.find((g) => { const acct = state.parties.get(g)?.xrplAccount; return !!acct && verifyCoSignature(cs, acct, now).length === 0; });
          if (termProblems.length) no('co-signature', `The co-signature is for a different ${termProblems.join(', ')}.`);
          else if (!signer) no('co-signature', `The co-signature is not a valid signature by ${grantors.join(' or ')} (their profile XRPL account).`);
          else coSignedBy = signer;
        }
      }
    }
  } else if (action === 'fund') {
    if (contract.state === 'cancelled' || contract.state === 'completed') no('contract-closed', `The contract is ${contract.state}.`);
    if (openDispute || contract.state === 'disputed') no('disputed', 'The contract has an open dispute; nothing is funded until it is decided.');
    if (!current || current.index !== intent.milestone) no('not-current-stage', `Milestone ${intent.milestone} is not the stage to fund now${current ? ` (stage ${current.index} is)` : ''}.`);
    if (escrow) no('already-funded', `Milestone ${intent.milestone} is already escrowed (${escrow.txHash}).`);
    { const gate = subcontractGate(state.contracts, contract, intent.milestone); if (gate) no('parent-not-released', gate); }
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
      const today = state.committedByDay.get(committedKey(buyer.partyId, now, contract.total.currency)) ?? 0;
      const m = checkMandate(state.mandates, buyer.partyId, 'marketplace.escrow.fund', { amount, currency: contract.total.currency }, contract.categoryId, now, today);
      mandateNote = m.reason;
      if (!m.ok) no('mandate', `Agent ${buyer.name}: ${m.reason}`);
      else if (m.needsApproval) {
        // A real co-signature: signed by a grantor's profile account, for this network, contract, stage, action and the stage's full amount.
        const stageDrops = sellerAccount ? milestoneEscrowLegs(contract, intent.milestone, sellerAccount).reduce((a, l) => a + BigInt(l.drops), 0n).toString() : null;
        const grantors = [...new Set(state.mandates.filter((x) => x.agentPartyId === buyer.partyId).map((x) => x.grantedBy))];
        const cs = intent.coSignature;
        if (!cs) no('co-signature', `Agent ${buyer.name}: ${m.reason} — ask ${grantors.join(' or ')} to co-sign this stage (cappz-market cosign ${contract.contractId}).`);
        else {
          const t = cs.terms;
          const termProblems = [t.network !== intent.network && 'network', t.contractId !== contract.contractId && 'contract', t.milestone !== intent.milestone && 'milestone', t.action !== 'fund' && 'action', t.amountDrops !== stageDrops && 'amount'].filter(Boolean);
          const signer = grantors.find((g) => { const acct = state.parties.get(g)?.xrplAccount; return !!acct && verifyCoSignature(cs, acct, now).length === 0; });
          if (termProblems.length) no('co-signature', `The co-signature is for a different ${termProblems.join(', ')}.`);
          else if (!signer) no('co-signature', `The co-signature is not a valid signature by ${grantors.join(' or ')} (their profile XRPL account): ${grantors.map((g) => { const acct = state.parties.get(g)?.xrplAccount; return acct ? verifyCoSignature(cs, acct, now).join(' ') : `${g} has no XRPL account on their profile`; }).join(' / ')}`);
          else coSignedBy = signer;
        }
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

  // v15-31-00: a buyer whose mandate is bound to a signing key acts only through requests signed by that key.
  const auth = intent.requestAuth ?? NOT_SIGNED;
  // The binding is checked for the party that acts: the seller when it redeems a channel claim, otherwise the buyer.
  const actingParty = action === 'claim' && tx.Account === sellerAccount ? contract.sellerId : contract.buyerId;
  const ra = requestAuthDecision(state, actingParty, auth, now);
  if (ra.decision === 'refuse') no('request-auth', `Agent ${state.parties.get(actingParty)?.name ?? actingParty}: ${ra.reason}. Sign the request with the declared key (cappz-market signs it when its agent key is on this computer).`);

  if (r.length) return { approved: false, reasons: r };
  const issuedAt = now;
  return {
    approved: true,
    approval: {
      v: 1, kind: 'cappz-signing-approval', network: intent.network, contractId: contract.contractId, milestone: intent.milestone, action,
      txHash: await intentHash(tx), account: String(tx.Account), destination, amountDrops, lastLedgerSequence: lls,
      actorPartyId: actingParty, mandate: mandateNote, coSignedBy,
      contractState: contract.state, contractBecause: contract.because,
      nonce, issuedAt, expiresAt: new Date(Date.parse(now) + APPROVAL_TTL_MS).toISOString(),
      ...(intent.requestAuth ? { requestAuth: { state: auth.state, partyId: auth.partyId, ...(auth.keyId ? { keyId: auth.keyId } : {}), because: auth.because } } : {}),
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

/**
 * A SigningDeps.approve hook: before each escrow transaction is signed, ask the approval service to approve these
 * exact bytes and verify the signed answer against the published key. Throws (nothing is signed) on any refusal.
 */
export function approvalHook(opts: { serviceUrl: string; publicKey: string; network: XrplNetwork; contractId: string; milestone: number; coSignature?: CoSignature; onApproved?: (a: SignedApproval) => void; fetcher?: typeof fetch;
  /** v15-31-00: sign the /authorize request (RFC 9421) with the agent's declared key (agentRequestAuth.agentRequestHook). */
  signRequest?: RequestSignHook }): (prepared: Record<string, unknown>) => Promise<void> {
  const f = opts.fetcher ?? fetch;
  return async (prepared) => {
    let res: Response;
    const url = `${opts.serviceUrl.replace(/\/$/, '')}/${opts.network}/authorize`;
    const payload = JSON.stringify({ contractId: opts.contractId, milestone: opts.milestone, tx: prepared, ...(opts.coSignature ? { coSignature: opts.coSignature } : {}) });
    const signed = opts.signRequest ? await opts.signRequest({ method: 'POST', url, body: payload }) : {};
    try {
      res = await f(url, { method: 'POST', headers: { 'content-type': 'application/json', ...signed }, body: payload });
    } catch (e) { throw new Error(`The signing-approval service could not be reached (${(e as Error).message}); nothing was signed.`); }
    const body = (await res.json().catch(() => ({}))) as { approved?: boolean; reasons?: ApprovalReason[]; error?: string } & Partial<SignedApproval>;
    if (!body.approved) throw new Error(`Not approved for signing: ${(body.reasons ?? []).map((r) => r.message).join(' ') || body.error || `HTTP ${res.status}`} Nothing was signed.`);
    const problems = await verifyApproval(body as SignedApproval, prepared, opts.publicKey);
    if (problems.length) throw new Error(`The approval does not cover this transaction: ${problems.join(' ')} Nothing was signed.`);
    opts.onApproved?.(body as SignedApproval);
  };
}
