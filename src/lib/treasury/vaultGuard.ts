/**
 * COPE node crystallized.
 * Node ID: v15-48-00-vault-guard
 * Provenance: m/44'/144'/100'/principles/cope/v1#marketplace
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Vault guard: limits what a stolen key can move out of a pooled XRPL account,
 * with the limit enforced by the ledger itself.
 *
 * The failure it answers: a vault that pays whatever one signing key (or one
 * threshold "aggregate" key) signs. Steal that key, or produce its signature
 * outside the normal signing system, and the whole balance leaves in one
 * transaction to a fresh address. Detection after the fact is too slow: the
 * November 2026 Chainflip drain took under ten minutes from theft to mixer.
 *
 * Three parts:
 *
 * 1. Setup (`guardSetupTransactions`, `checkSignerSetup`): the vault's master
 *    key is disabled and a signer list makes an independent guard co-signer
 *    load-bearing. Weights are chosen so that every operator key together
 *    cannot reach quorum, the guard alone cannot either, the guard plus k
 *    operators can, and (optionally) two of the offline recovery keys can, while
 *    one recovery key plus every operator key cannot. The ledger then refuses
 *    (tefBAD_QUORUM) anything the guard did not sign, including changes to the
 *    signer list itself.
 *
 * 2. Policy (`evaluateOutflow`, `guardCosign`): the guard co-signs a
 *    transaction only if it fits the owner's declared outflow policy: allowed
 *    destinations (and tags), a per-transaction cap and a rolling-window cap
 *    per asset, a capped fee, a short expiry, the account's next sequence (no
 *    tickets, no counter jumps: the out-of-band nonce that gave the Chainflip
 *    signature away is refused before signing), no partial payments, paths or
 *    extra fields, and no key, signer or account-setting changes (those are
 *    governed changes, never routine outflows). Every reason is returned.
 *
 * 3. Reconciliation (`reconcileOutflows`): every validated transaction from the
 *    vault must match an approval the guard recorded. An unmatched one is
 *    `unapproved` — the signal that the setup is not load-bearing or a guard
 *    key leaked — and the report is hashed so an incident record can cite it.
 *
 * Trust boundaries: the guard bounds the loss to what the policy allows in one
 * window; it does not make operator keys safe to leak, and a compromised guard
 * plus k operator keys can still spend within the policy. The window cap is
 * the honest worst case, and it is reported as such (`worstCaseLoss`).
 */
import { Wallet } from 'xrpl';
import { canonicalJson, sha256HexOf } from '../identity/canonical.ts';
import type { XrplNetwork } from '../xrpl/ledgerCheck.ts';

// ── Assets and amounts ────────────────────────────────────────────────────────

/** A ledger amount: XRP in drops (string), or an issued token. */
export type LedgerAmount = string | { currency: string; issuer: string; value: string };

/** 'XRP' or `<currency>/<issuer>`. */
export const assetKey = (a: LedgerAmount): string => (typeof a === 'string' ? 'XRP' : `${a.currency}/${a.issuer}`);

const SCALE = 15n;
/** Exact decimal → integer units: XRP drops as-is, token values scaled by 10^15 (e-notation accepted). */
export function amountUnits(asset: string, value: string): bigint {
  if (asset === 'XRP') {
    if (!/^\d+$/.test(value)) throw new Error(`XRP amounts are whole drops: ${value}`);
    return BigInt(value);
  }
  const m = /^(-?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(value.trim());
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) throw new Error(`not a decimal: ${value}`);
  const digits = (m[2] || '0') + (m[3] ?? '');
  const exp = Number(m[4] ?? 0) - (m[3] ?? '').length + Number(SCALE);
  const n = exp >= 0 ? BigInt(digits) * 10n ** BigInt(exp) : BigInt(digits) / 10n ** BigInt(-exp);
  return m[1] === '-' ? -n : n;
}
const valueOf = (a: LedgerAmount): string => (typeof a === 'string' ? a : a.value);

// ── Policy ───────────────────────────────────────────────────────────────────

export type GuardedType = 'Payment' | 'EscrowCreate';

export interface OutflowPolicy {
  kind: 'cappz-outflow-policy/v1';
  network: XrplNetwork;
  /** The guarded (pooled) account. */
  account: string;
  /** The guard co-signer's account, as it appears in the vault's signer list. */
  guard: string;
  /** Where money may go. An entry with a tag requires exactly that tag. */
  destinations: Array<{ address: string; tag?: number; label: string }>;
  /** Per asset: the largest single outflow and the most in any rolling window (XRP in drops, tokens as decimals). */
  limits: Array<{ asset: string; perTx: string; perWindow: string }>;
  windowHours: number;
  maxFeeDrops: number;
  /** LastLedgerSequence may be at most this many ledgers past the current one (about 4 s each). */
  maxLedgerAhead: number;
  /** Transaction types the guard will co-sign (default Payment only). */
  allowedTypes?: GuardedType[];
}

export const policyHash = (p: OutflowPolicy): Promise<string> => sha256HexOf(canonicalJson(p));

/** Fields each co-signable type may carry. Anything else (Paths, SendMax, DeliverMin, InvoiceID …) is refused. */
const ALLOWED_FIELDS: Record<GuardedType, readonly string[]> = {
  Payment: ['TransactionType', 'Account', 'Destination', 'DestinationTag', 'Amount', 'Memos', 'Fee', 'Sequence', 'LastLedgerSequence', 'Flags', 'NetworkID', 'SourceTag'],
  EscrowCreate: ['TransactionType', 'Account', 'Destination', 'DestinationTag', 'Amount', 'FinishAfter', 'CancelAfter', 'Condition', 'Memos', 'Fee', 'Sequence', 'LastLedgerSequence', 'Flags', 'NetworkID', 'SourceTag'],
};
/** Fields the signer adds; never part of what was approved. */
const SIGNING_FIELDS = new Set(['SigningPubKey', 'TxnSignature', 'Signers']);
/** Changes to who controls the account: never a routine outflow. */
const GOVERNANCE_TYPES = new Set(['SetRegularKey', 'SignerListSet', 'AccountSet', 'AccountDelete', 'DepositPreauth', 'TrustSet', 'TicketCreate', 'DelegateSet']);
const TF_FULLY_CANONICAL = 0x80000000;
const TF_PARTIAL_PAYMENT = 0x00020000;

/**
 * The transaction as approved: its own fields only (signing fields and ledger annotations dropped; API v2's
 * DeliverMax read as Amount; missing Flags read as 0), canonical JSON. The same projection is used when approving
 * and when reconciling a validated transaction, so the two hashes meet.
 */
export function outflowIntent(tx: Record<string, unknown>): string {
  const t: Record<string, unknown> = { ...tx };
  if (t.Amount === undefined && t.DeliverMax !== undefined) t.Amount = t.DeliverMax;
  delete t.DeliverMax;
  if (t.Flags === undefined) t.Flags = 0;
  const allowed = ALLOWED_FIELDS[t.TransactionType as GuardedType];
  const kept = Object.entries(t).filter(([k]) => !SIGNING_FIELDS.has(k) && (allowed ? allowed.includes(k) : /^[A-Z]/.test(k)));
  return canonicalJson(Object.fromEntries(kept));
}
export const outflowIntentHash = (tx: Record<string, unknown>): Promise<string> => sha256HexOf(outflowIntent(tx));

// ── Evaluation ───────────────────────────────────────────────────────────────

export interface Spent { at: string; asset: string; amount: string }
export interface OutflowContext {
  /** The vault's next Sequence (account_info, validated or current). */
  nextSequence: number;
  /** The current ledger index. */
  currentLedger: number;
  /** Outflows already counted: validated ones and approvals not yet expired. */
  spent: Spent[];
}
export interface GuardReason { code: string; message: string }
export interface OutflowApproval {
  kind: 'cappz-outflow-approval/v1';
  policyHash: string;
  intentHash: string;
  account: string;
  destination: string;
  asset: string;
  amount: string;
  sequence: number;
  expiresLedger: number;
  issuedAt: string;
}
export type OutflowDecision = { approved: true; approval: OutflowApproval } | { approved: false; reasons: GuardReason[] };

/** Decide whether the guard may co-sign `tx` now. Pure; every reason is returned. */
export async function evaluateOutflow(policy: OutflowPolicy, ctx: OutflowContext, tx: Record<string, unknown>, now: string): Promise<OutflowDecision> {
  const reasons: GuardReason[] = [];
  const no = (code: string, message: string) => reasons.push({ code, message });
  const type = String(tx.TransactionType ?? '');
  const allowedTypes = policy.allowedTypes ?? ['Payment'];

  if (tx.Account !== policy.account) no('wrong-account', `The transaction is from ${String(tx.Account)}, not the guarded account ${policy.account}.`);
  if (GOVERNANCE_TYPES.has(type)) no('governance-change', `${type} changes who controls the account or what it holds; it is a governed change, never co-signed as an outflow.`);
  else if (!allowedTypes.includes(type as GuardedType)) no('type-not-allowed', `The policy co-signs ${allowedTypes.join(', ')} only, not ${type || 'an untyped transaction'}.`);

  const fields = ALLOWED_FIELDS[type as GuardedType];
  if (fields) {
    const extra = Object.keys(tx).filter((k) => !fields.includes(k) && !SIGNING_FIELDS.has(k) && !(k === 'DeliverMax' && tx.Amount === undefined));
    if (extra.length) no('unexpected-field', `Fields the policy does not allow: ${extra.join(', ')}.`);
  }
  if (tx.TicketSequence !== undefined || tx.Sequence === 0) no('ticket-sequence', 'Tickets let a signature be used out of order; the guard signs only the next sequence.');
  else if (tx.Sequence !== ctx.nextSequence) no('sequence-gap', `Sequence ${String(tx.Sequence)} is not the account's next (${ctx.nextSequence}). A signature made outside the normal counter is refused.`);

  const flags = Number(tx.Flags ?? 0);
  if (flags & TF_PARTIAL_PAYMENT) no('partial-payment', 'Partial payments can deliver less than they name; refused.');
  if ((flags & ~TF_FULLY_CANONICAL & ~TF_PARTIAL_PAYMENT) !== 0) no('unexpected-flags', `Flags ${flags} are not allowed.`);

  const lls = Number(tx.LastLedgerSequence ?? 0);
  if (!lls) no('no-expiry', 'Without LastLedgerSequence a signed transaction stays valid indefinitely.');
  else if (lls > ctx.currentLedger + policy.maxLedgerAhead) no('expiry-too-far', `LastLedgerSequence ${lls} is more than ${policy.maxLedgerAhead} ledgers ahead of ${ctx.currentLedger}.`);
  const fee = Number(tx.Fee ?? NaN);
  if (!Number.isFinite(fee) || fee > policy.maxFeeDrops) no('fee-over-cap', `Fee ${String(tx.Fee)} drops is over the cap of ${policy.maxFeeDrops}.`);

  const dest = String(tx.Destination ?? '');
  const tag = tx.DestinationTag === undefined ? undefined : Number(tx.DestinationTag);
  const listed = policy.destinations.filter((d) => d.address === dest);
  if (!listed.length) no('destination-not-allowed', `${dest || 'No destination'} is not on the policy's destination list.`);
  else if (!listed.some((d) => d.tag === undefined || d.tag === tag)) no('destination-tag', `${dest} is allowed only with tag ${listed.map((d) => d.tag).join(' or ')}.`);

  const amount = (tx.Amount ?? tx.DeliverMax) as LedgerAmount | undefined;
  let asset = '';
  let units = 0n;
  if (amount === undefined) no('no-amount', 'The transaction names no amount.');
  else {
    asset = assetKey(amount);
    const limit = policy.limits.find((l) => l.asset === asset);
    try { units = amountUnits(asset, valueOf(amount)); } catch (e) { no('bad-amount', (e as Error).message); }
    if (units <= 0n) no('bad-amount', 'The amount must be positive.');
    if (!limit) no('asset-not-allowed', `The policy sets no limit for ${asset}, so it is not paid out.`);
    else if (units > 0n) {
      if (units > amountUnits(asset, limit.perTx)) no('over-tx-cap', `${valueOf(amount)} ${asset} is over the per-transaction cap of ${limit.perTx}.`);
      const since = Date.parse(now) - policy.windowHours * 3_600_000;
      const used = ctx.spent.filter((s) => s.asset === asset && Date.parse(s.at) > since).reduce((n, s) => n + amountUnits(asset, s.amount), 0n);
      const cap = amountUnits(asset, limit.perWindow);
      if (used + units > cap) no('over-window-cap', `With ${valueOf(amount)} more, ${asset} outflows in the last ${policy.windowHours} h would exceed ${limit.perWindow} (already ${formatUnits(asset, used)}).`);
    }
  }

  if (reasons.length) return { approved: false, reasons };
  return {
    approved: true,
    approval: {
      kind: 'cappz-outflow-approval/v1', policyHash: await policyHash(policy), intentHash: await outflowIntentHash(tx),
      account: policy.account, destination: dest, asset, amount: valueOf(amount!), sequence: Number(tx.Sequence), expiresLedger: lls, issuedAt: now,
    },
  };
}

const formatUnits = (asset: string, n: bigint): string => {
  if (asset === 'XRP') return n.toString();
  const s = n.toString().padStart(Number(SCALE) + 1, '0');
  return `${s.slice(0, -Number(SCALE))}.${s.slice(-Number(SCALE))}`.replace(/\.?0+$/, '');
};

/**
 * The guard's co-signature: evaluate, and only when approved add the guard's multisignature (tx_blob). The caller
 * records `approval` (append-only) before submitting, so reconciliation can account for the transaction.
 */
export async function guardCosign(policy: OutflowPolicy, ctx: OutflowContext, tx: Record<string, unknown>, guard: Wallet, now: string): Promise<{ decision: OutflowDecision; txBlob?: string }> {
  if (guard.classicAddress !== policy.guard) return { decision: { approved: false, reasons: [{ code: 'not-the-guard', message: `This key is ${guard.classicAddress}, not the policy's guard ${policy.guard}.` }] } };
  const decision = await evaluateOutflow(policy, ctx, tx, now);
  if (!decision.approved) return { decision };
  const signed = guard.sign({ ...tx, SigningPubKey: '' } as Parameters<Wallet['sign']>[0], true);
  return { decision, txBlob: signed.tx_blob };
}

/** The most the policy lets leave in one window, per asset: the honest worst case if a guard and k operators are taken. */
export const worstCaseLoss = (policy: OutflowPolicy): Array<{ asset: string; perWindow: string; windowHours: number }> =>
  policy.limits.map((l) => ({ asset: l.asset, perWindow: l.perWindow, windowHours: policy.windowHours }));

// ── Signer setup ─────────────────────────────────────────────────────────────

export const LSF_DISABLE_MASTER = 0x00100000;
export const ASF_DISABLE_MASTER = 4;

export interface SignerWeights { quorum: number; guard: number; operator: number; recovery: number }

/**
 * Weights for n operators of which k co-sign with the guard: operator 1, recovery n+1, quorum 2n+2, guard 2n+2−k.
 * Then: all operators (n) < quorum; the guard alone < quorum; guard + k operators = quorum; two recovery keys =
 * quorum; one recovery key + every operator (2n+1) < quorum.
 */
export function signerWeights(operators: number, perSpend: number): SignerWeights {
  if (!Number.isInteger(operators) || operators < 1) throw new Error('At least one operator key is needed.');
  if (!Number.isInteger(perSpend) || perSpend < 1 || perSpend > operators) throw new Error(`Operators per spend must be 1..${operators}.`);
  const quorum = 2 * operators + 2;
  return { quorum, guard: quorum - perSpend, operator: 1, recovery: operators + 1 };
}

/**
 * The two transactions that make the guard load-bearing: a SignerListSet with the weights above, then an AccountSet
 * disabling the master key. Submit them in this order, signed by the master key, after checking the list
 * (`checkSignerSetup`) — once the master key is off, only the signer list can act.
 */
export function guardSetupTransactions(account: string, guard: string, operators: string[], opts: { perSpend?: number; recovery?: string[] } = {}): Array<Record<string, unknown>> {
  const recovery = opts.recovery ?? [];
  if (recovery.length === 1) throw new Error('Use no recovery keys or at least two: a single recovery key would be a master key by another name.');
  const all = [guard, ...operators, ...recovery];
  if (new Set(all).size !== all.length || all.includes(account)) throw new Error('The guard, operator and recovery keys must be distinct accounts, none of them the vault.');
  if (all.length > 32) throw new Error('A signer list holds at most 32 entries.');
  const w = signerWeights(operators.length, opts.perSpend ?? 1);
  const entry = (a: string, weight: number) => ({ SignerEntry: { Account: a, SignerWeight: weight } });
  return [
    { TransactionType: 'SignerListSet', Account: account, SignerQuorum: w.quorum, SignerEntries: [entry(guard, w.guard), ...operators.map((o) => entry(o, w.operator)), ...recovery.map((r) => entry(r, w.recovery))] },
    { TransactionType: 'AccountSet', Account: account, SetFlag: ASF_DISABLE_MASTER },
  ];
}

export interface SignerSetup {
  /** account_info Flags. */
  flags: number;
  regularKey?: string;
  signerList?: { quorum: number; entries: Array<{ account: string; weight: number }> };
}
export type SetupState = 'guard-load-bearing' | 'guard-bypassable' | 'not-set-up';
export interface SetupFinding { code: string; blocking: boolean; message: string }

/**
 * Is the guard load-bearing on this account? Blocking findings mean a key other than the guard can move money
 * alone. `recovery` names the offline recovery accounts; every other non-guard entry is treated as online.
 */
export function checkSignerSetup(policy: Pick<OutflowPolicy, 'account' | 'guard'>, setup: SignerSetup, recovery: string[] = []): { state: SetupState; findings: SetupFinding[] } {
  const f: SetupFinding[] = [];
  const add = (code: string, blocking: boolean, message: string) => f.push({ code, blocking, message });
  if (!(setup.flags & LSF_DISABLE_MASTER)) add('master-enabled', true, 'The master key is enabled: whoever holds it can move everything without the guard.');
  if (setup.regularKey) add('regular-key-set', true, `Regular key ${setup.regularKey} can sign alone, bypassing the guard.`);
  const list = setup.signerList;
  if (!list) {
    add('no-signer-list', true, 'No signer list: there is no guard to co-sign.');
    return { state: 'not-set-up', findings: f };
  }
  const q = list.quorum;
  const guard = list.entries.find((e) => e.account === policy.guard);
  const online = list.entries.filter((e) => e.account !== policy.guard && !recovery.includes(e.account));
  const rec = list.entries.filter((e) => recovery.includes(e.account)).map((e) => e.weight).sort((a, b) => b - a);
  const onlineSum = online.reduce((n, e) => n + e.weight, 0);
  if (!guard) add('guard-not-listed', true, `The guard ${policy.guard} is not on the signer list.`);
  if (onlineSum >= q) add('online-keys-reach-quorum', true, `The online keys together weigh ${onlineSum} ≥ quorum ${q}: stealing them is enough, the guard is bypassable.`);
  const single = online.find((e) => e.weight >= q);
  if (single) add('single-key-reaches-quorum', true, `${single.account} alone meets the quorum.`);
  if (rec.length && rec[0] + onlineSum >= q) add('recovery-plus-online-reaches-quorum', true, `One recovery key (${rec[0]}) plus the online keys (${onlineSum}) meets quorum ${q}.`);
  if (guard && guard.weight >= q) add('guard-alone-reaches-quorum', true, 'The guard alone meets the quorum: a stolen guard key could spend without any operator.');
  if (guard && guard.weight + onlineSum < q) add('guard-cannot-spend', false, 'The guard plus every online key cannot reach quorum: routine outflows are impossible.');
  if (rec.reduce((n, w) => n + w, 0) < q) add('no-recovery-path', false, 'The recovery keys cannot reach quorum: losing the guard key would freeze the vault.');
  const blocking = f.some((x) => x.blocking);
  return { state: blocking ? 'guard-bypassable' : 'guard-load-bearing', findings: f };
}

// ── Reconciliation ───────────────────────────────────────────────────────────

export interface ValidatedTx { hash: string; tx: Record<string, unknown>; result: string; closeTime: string; delivered?: LedgerAmount }
export type ReconState = 'matched' | 'unapproved' | 'governance-change' | 'failed';
export interface ReconFinding { hash: string; state: ReconState; type: string; destination?: string; asset?: string; amount?: string; at: string; message: string }
export interface ReconReport { kind: 'cappz-outflow-reconciliation/v1'; account: string; policyHash: string; checked: number; findings: ReconFinding[]; spent: Spent[]; clean: boolean; reportHash: string }

/**
 * Every validated transaction sent by the vault must match an approval the guard recorded (by intent hash).
 * A failed transaction moved nothing but still used a sequence and a fee; it is reported, never dropped.
 */
export async function reconcileOutflows(policy: OutflowPolicy, approvals: OutflowApproval[], txs: ValidatedTx[]): Promise<ReconReport> {
  const approved = new Set(approvals.map((a) => a.intentHash));
  const findings: ReconFinding[] = [];
  const spent: Spent[] = [];
  for (const v of txs) {
    if (v.tx.Account !== policy.account) continue;
    const type = String(v.tx.TransactionType ?? '');
    const amount = (v.delivered ?? v.tx.Amount ?? v.tx.DeliverMax) as LedgerAmount | undefined;
    const base = { hash: v.hash, type, destination: v.tx.Destination as string | undefined, asset: amount ? assetKey(amount) : undefined, amount: amount ? valueOf(amount) : undefined, at: v.closeTime };
    const matched = approved.has(await outflowIntentHash(v.tx));
    if (v.result !== 'tesSUCCESS' && matched) findings.push({ ...base, state: 'failed', message: `${type} failed (${v.result}); it moved nothing but used a sequence.` });
    else if (v.result !== 'tesSUCCESS') findings.push({ ...base, state: 'unapproved', message: `${type} failed (${v.result}) and moved nothing, but it carried a valid signature the guard never approved: the guard is not load-bearing, or a guard key leaked.` });
    else if (matched) {
      findings.push({ ...base, state: 'matched', message: `${type} matches a recorded approval.` });
      if (amount && (type === 'Payment' || type === 'EscrowCreate')) spent.push({ at: v.closeTime, asset: assetKey(amount), amount: valueOf(amount) });
    } else if (GOVERNANCE_TYPES.has(type)) findings.push({ ...base, state: 'governance-change', message: `${type} changed the account's control or settings without a recorded approval; confirm it was a governed change.` });
    else {
      findings.push({ ...base, state: 'unapproved', message: `${type} left the vault without a guard approval: the guard is not load-bearing, or a guard key leaked.` });
      if (amount) spent.push({ at: v.closeTime, asset: assetKey(amount), amount: valueOf(amount) });
    }
  }
  const body = { kind: 'cappz-outflow-reconciliation/v1' as const, account: policy.account, policyHash: await policyHash(policy), checked: findings.length, findings, spent, clean: findings.every((x) => x.state === 'matched' || x.state === 'failed') };
  return { ...body, reportHash: await sha256HexOf(canonicalJson(body)) };
}
