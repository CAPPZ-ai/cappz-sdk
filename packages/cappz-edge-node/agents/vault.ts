/**
 * Vault agents for the edge node (15.49.0), on the SDK's Vault Guard (src/lib/treasury/vaultGuard.ts).
 *
 *   vault-check  A signed report on a pooled XRPL account: is a guard co-signer load-bearing (master key,
 *                regular key, signer-list weights), what a stolen key could take under the stated policy,
 *                and — given the guard's approvals — whether every recent outflow was approved. Read-only:
 *                the node holds no key for the account.
 *   vault-guard  The node is the account's guard co-signer for a 30-day period. It co-signs only inside the
 *                owner's outflow policy, signs every decision, reconciles the account's outflows daily (and
 *                POSTs an alert when one was not approved), and ends the period with a signed report.
 *
 * Each vault's guard key is derived from the node's guard secret (CAPPZ_VAULT_GUARD_SECRET, 32 bytes hex):
 * entropy = HMAC-SHA256(secret, "cappz-vault-guard/v1|<network>|<vault>")[0..16], an Ed25519 XRPL key. The
 * same vault always gets the same guard address (renewals keep the signer list), nothing per vault is stored,
 * and rotating the node's receipt key never changes a customer's guard. Back the secret up: losing it freezes
 * routine outflows until the owner's recovery keys replace the guard.
 *
 * Pure apart from the HMAC: tests run it under Node.
 */
import { Wallet, isValidClassicAddress, type ECDSA } from 'xrpl';
import { amountUnits, type OutflowApproval, type OutflowPolicy, type Spent } from '../../../src/lib/treasury/vaultGuard.ts';

export const GUARD_DERIVATION = 'cappz-vault-guard/v1';
export type Net = 'mainnet' | 'testnet' | 'devnet';

const hexToBytes = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));

/** The guard wallet for one vault on one network. */
export async function guardWalletFor(secretHex: string, network: Net, vault: string): Promise<Wallet> {
  if (!/^[0-9a-f]{64}$/i.test(secretHex)) throw new Error('CAPPZ_VAULT_GUARD_SECRET must be 64 hex characters (32 random bytes).');
  const key = await crypto.subtle.importKey('raw', hexToBytes(secretHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${GUARD_DERIVATION}|${network}|${vault}`)));
  return Wallet.fromEntropy(mac.slice(0, 16), { algorithm: 'ed25519' as ECDSA });
}

/** What a buyer sends: the policy without account, guard or network (the node fills those). */
export interface VaultPolicyInput {
  destinations: Array<{ address: string; tag?: number; label: string }>;
  limits: Array<{ asset: string; perTx: string; perWindow: string }>;
  windowHours?: number;
  maxFeeDrops?: number;
  maxLedgerAhead?: number;
}
export interface VaultGuardInput { account: string; policy: VaultPolicyInput; recovery?: string[]; alertUrl?: string; label?: string }
export interface VaultCheckInput { account: string; guard?: string; recovery?: string[]; policy?: VaultPolicyInput; approvals?: OutflowApproval[]; limit?: number }

export const POLICY_DEFAULTS = { windowHours: 24, maxFeeDrops: 1000, maxLedgerAhead: 20 } as const;

export function fullPolicy(p: VaultPolicyInput, account: string, guard: string, network: Net): OutflowPolicy {
  return {
    kind: 'cappz-outflow-policy/v1', network, account, guard,
    destinations: p.destinations.map((d) => ({ address: d.address, ...(d.tag !== undefined ? { tag: d.tag } : {}), label: d.label })),
    limits: p.limits.map((l) => ({ asset: l.asset, perTx: String(l.perTx), perWindow: String(l.perWindow) })),
    windowHours: p.windowHours ?? POLICY_DEFAULTS.windowHours,
    maxFeeDrops: p.maxFeeDrops ?? POLICY_DEFAULTS.maxFeeDrops,
    maxLedgerAhead: p.maxLedgerAhead ?? POLICY_DEFAULTS.maxLedgerAhead,
  };
}

const ASSET = /^(XRP|[A-Z0-9]{3}\/r[1-9A-HJ-NP-Za-km-z]{24,34}|[0-9A-F]{40}\/r[1-9A-HJ-NP-Za-km-z]{24,34})$/;

/** Why a policy cannot be used, or null. Every limit must parse, perTx ≤ perWindow, destinations must be valid. */
export function policyProblem(p: unknown, account: string): string | null {
  const x = p as VaultPolicyInput | undefined;
  if (!x || typeof x !== 'object') return 'input.policy is required: destinations and limits.';
  if (!Array.isArray(x.destinations) || x.destinations.length < 1 || x.destinations.length > 50) return 'policy.destinations: 1 to 50 entries.';
  for (const d of x.destinations) {
    if (!d || typeof d.address !== 'string' || !isValidClassicAddress(d.address)) return `policy.destinations: ${String(d?.address)} is not a valid XRPL classic address.`;
    if (d.address === account) return 'policy.destinations: the vault cannot pay itself.';
    if (d.tag !== undefined && (!Number.isInteger(d.tag) || d.tag < 0 || d.tag > 4294967295)) return `policy.destinations: tag ${String(d.tag)} must be a whole number 0–4294967295.`;
    if (typeof d.label !== 'string' || !d.label.trim() || d.label.length > 80) return 'policy.destinations: each needs a label of at most 80 characters.';
  }
  if (!Array.isArray(x.limits) || x.limits.length < 1 || x.limits.length > 10) return 'policy.limits: 1 to 10 entries, one per asset.';
  const seen = new Set<string>();
  for (const l of x.limits) {
    if (!l || typeof l.asset !== 'string' || !ASSET.test(l.asset)) return `policy.limits: asset ${String(l?.asset)} must be XRP or <currency>/<issuer>.`;
    if (seen.has(l.asset)) return `policy.limits: ${l.asset} appears twice.`;
    seen.add(l.asset);
    let tx: bigint, win: bigint;
    try { tx = amountUnits(l.asset, String(l.perTx)); win = amountUnits(l.asset, String(l.perWindow)); } catch (e) { return `policy.limits: ${l.asset}: ${(e as Error).message}${l.asset === 'XRP' ? ' (XRP limits are in drops: 1 XRP = 1000000)' : ''}`; }
    if (tx <= 0n || win <= 0n) return `policy.limits: ${l.asset} limits must be positive.`;
    if (tx > win) return `policy.limits: ${l.asset} perTx is larger than perWindow.`;
  }
  if (x.windowHours !== undefined && (!Number.isFinite(x.windowHours) || x.windowHours < 1 || x.windowHours > 720)) return 'policy.windowHours: 1 to 720.';
  if (x.maxFeeDrops !== undefined && (!Number.isInteger(x.maxFeeDrops) || x.maxFeeDrops < 10 || x.maxFeeDrops > 100_000)) return 'policy.maxFeeDrops: 10 to 100000.';
  if (x.maxLedgerAhead !== undefined && (!Number.isInteger(x.maxLedgerAhead) || x.maxLedgerAhead < 3 || x.maxLedgerAhead > 1000)) return 'policy.maxLedgerAhead: 3 to 1000.';
  return null;
}

const addrList = (v: unknown, what: string): string | null => {
  if (v === undefined) return null;
  if (!Array.isArray(v) || v.length > 8 || v.some((a) => typeof a !== 'string' || !isValidClassicAddress(a))) return `${what}: up to 8 valid XRPL classic addresses.`;
  return null;
};

export function guardInputProblem(i: unknown): string | null {
  const x = i as VaultGuardInput | undefined;
  if (typeof x?.account !== 'string' || !isValidClassicAddress(x.account)) return 'input.account must be the vault\'s XRPL classic address.';
  const p = policyProblem(x.policy, x.account); if (p) return p;
  const r = addrList(x.recovery, 'input.recovery'); if (r) return r;
  if (x.alertUrl !== undefined) {
    try { const u = new URL(x.alertUrl); if (u.protocol !== 'https:') return 'input.alertUrl must be https.'; } catch { return 'input.alertUrl must be a URL.'; }
  }
  if (x.label !== undefined && (typeof x.label !== 'string' || x.label.length > 100)) return 'input.label, when given, is text of at most 100 characters.';
  return null;
}

export function checkInputProblem(i: unknown): string | null {
  const x = i as VaultCheckInput | undefined;
  if (typeof x?.account !== 'string' || !isValidClassicAddress(x.account)) return 'input.account must be an XRPL classic address.';
  if (x.guard !== undefined && (typeof x.guard !== 'string' || !isValidClassicAddress(x.guard))) return 'input.guard, when given, is an XRPL classic address.';
  const r = addrList(x.recovery, 'input.recovery'); if (r) return r;
  if (x.policy !== undefined) { const p = policyProblem(x.policy, x.account); if (p) return p; }
  if (x.approvals !== undefined && (!Array.isArray(x.approvals) || x.approvals.length > 5000 || x.approvals.some((a) => typeof a?.intentHash !== 'string' || !/^[0-9a-f]{64}$/.test(a.intentHash)))) return 'input.approvals: up to 5000 guard approvals, each with its intentHash.';
  if (x.approvals !== undefined && x.policy === undefined) return 'input.approvals needs input.policy (approvals are matched under a policy).';
  if (x.limit !== undefined && (!Number.isInteger(x.limit) || x.limit < 1 || x.limit > 400)) return 'input.limit: 1 to 400 recent transactions.';
  return null;
}

/**
 * Outflows that count against the window: validated ones (by the ledger's reconciliation) plus approvals that
 * may still be submitted (not past their LastLedgerSequence). An approval that expired unsubmitted frees its room.
 */
export function windowSpent(validatedSpent: Spent[], approvals: OutflowApproval[], validatedIntents: Set<string>, currentLedger: number): Spent[] {
  const pending = approvals.filter((a) => !validatedIntents.has(a.intentHash) && a.expiresLedger >= currentLedger).map((a) => ({ at: a.issuedAt, asset: a.asset, amount: a.amount }));
  return [...validatedSpent, ...pending];
}

/** The ledger's account_info (with signer_lists) → the setup checkSignerSetup reads. */
export function setupFromAccountInfo(r: { account_data?: { Flags?: number; RegularKey?: string; signer_lists?: SignerListRow[] }; signer_lists?: SignerListRow[] }) {
  const list = (r.signer_lists ?? r.account_data?.signer_lists ?? [])[0];
  return {
    flags: Number(r.account_data?.Flags ?? 0),
    regularKey: r.account_data?.RegularKey,
    signerList: list ? { quorum: list.SignerQuorum, entries: list.SignerEntries.map((e) => ({ account: e.SignerEntry.Account, weight: e.SignerEntry.SignerWeight })) } : undefined,
  };
}
interface SignerListRow { SignerQuorum: number; SignerEntries: Array<{ SignerEntry: { Account: string; SignerWeight: number } }> }

/** account_tx rows (API v2) → the reconciler's validated transactions. */
export function validatedFromAccountTx(rows: Array<{ hash?: string; tx_json?: Record<string, unknown>; meta?: { TransactionResult?: string; delivered_amount?: unknown }; close_time_iso?: string }>) {
  return rows.filter((t) => t.tx_json && t.meta).map((t) => ({ hash: String(t.hash), tx: t.tx_json!, result: String(t.meta!.TransactionResult), closeTime: String(t.close_time_iso ?? ''), delivered: t.meta!.delivered_amount as never }));
}

/**
 * Whether a paid guard job may be honoured. Without this, anyone could pay for a job on someone else's vault with a
 * loose policy, and a thief holding operator keys could do the same. Rules:
 *   1. The period must be paid BY THE VAULT (the payment's Account). Under a live guard that payment itself needs the
 *      guard's co-signature, inside the current policy.
 *   2. A policy that differs from the vault's current one is honoured only when its payment was signed WITHOUT the
 *      guard: by the master key before setup, or by the offline recovery keys (operators alone cannot reach quorum).
 *      Renewing the same policy may go through the guard.
 */
export type JobAuth = { ok: true; policyHash: string } | { ok: false; code: 'not-paid' | 'not-from-vault' | 'policy-change-needs-recovery'; message: string };
export function authorizeGuardJob(o: { vault: string; guard: string; policyHash: string; payment: { Account?: unknown; Signers?: unknown } | null; currentPolicyHash: string | null }): JobAuth {
  if (!o.payment) return { ok: false, code: 'not-paid', message: 'The period is not paid yet.' };
  if (o.payment.Account !== o.vault) return { ok: false, code: 'not-from-vault', message: `The period was paid by ${String(o.payment.Account)}, not by the vault ${o.vault}. Pay it from the vault itself, so only its own signers can start or change its guard.` };
  const signers = Array.isArray(o.payment.Signers) ? (o.payment.Signers as Array<{ Signer?: { Account?: string } }>).map((s) => s.Signer?.Account) : [];
  const viaGuard = signers.includes(o.guard);
  if (o.currentPolicyHash && o.currentPolicyHash !== o.policyHash && viaGuard) {
    return { ok: false, code: 'policy-change-needs-recovery', message: 'This job changes the vault\'s policy but its payment was co-signed by the guard. A policy change must be paid with the recovery keys (no guard), so stolen operator keys cannot loosen it.' };
  }
  return { ok: true, policyHash: o.policyHash };
}

/** Key exposure check input (16.2.0): up to 10 accounts, an optional never-signed vault to sweep to, the exposure limit. */
export interface KeyExposureInput { accounts: string[]; vault?: string; bufferXrp?: number; maxExposureDays?: number }

export function keyExposureInputProblem(i: unknown): string | null {
  const x = i as KeyExposureInput | undefined;
  if (!x || !Array.isArray(x.accounts) || x.accounts.length < 1 || x.accounts.length > 10) return 'input.accounts: 1 to 10 XRPL classic addresses.';
  if (x.accounts.some((a) => typeof a !== 'string' || !isValidClassicAddress(a))) return 'input.accounts: each must be an XRPL classic address.';
  if (new Set(x.accounts).size !== x.accounts.length) return 'input.accounts: an address appears twice.';
  if (x.vault !== undefined && (typeof x.vault !== 'string' || !isValidClassicAddress(x.vault))) return 'input.vault, when given, is an XRPL classic address.';
  if (x.vault !== undefined && x.accounts.includes(x.vault)) return 'input.vault must not be one of input.accounts.';
  if (x.bufferXrp !== undefined && (!Number.isFinite(x.bufferXrp) || x.bufferXrp < 0 || x.bufferXrp > 1e9)) return 'input.bufferXrp: the XRP to leave in each account above its reserve (0 or more).';
  if (x.maxExposureDays !== undefined && (!Number.isInteger(x.maxExposureDays) || x.maxExposureDays < 1 || x.maxExposureDays > 3650)) return 'input.maxExposureDays: 1 to 3650.';
  return null;
}
