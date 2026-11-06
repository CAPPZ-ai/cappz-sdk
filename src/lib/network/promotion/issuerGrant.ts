/**
 * Issuer grant — what a token issuer and its holders need on a network before
 * the token can move there (15.33.0). The rules come from the operator scripts
 * that set CAPPZ up (setup_trustlines.py, setup_fee_trustlines.py):
 *
 *   1. The issuer sets DefaultRipple (and its domain) BEFORE any holder line
 *      exists, or the issuer's side of each line gets NoRipple and
 *      holder → holder payments fail.
 *   2. Each holder role (treasury, service) opens a line to the issuer.
 *   3. Lines opened before DefaultRipple are repaired: the issuer clears
 *      NoRipple on its side.
 *   4. Fee-collection lines (e.g. treasury → stablecoin issuer) are no-ripple.
 *   5. Every signer keeps the XRP owner reserve for the objects it adds.
 *
 * `planIssuerGrant` is the dry run: it reads ledger state and returns the
 * unsigned transactions, in order, with what is already in place and any
 * reason not to proceed. It signs and submits nothing; seeds never enter.
 */
import { xrplRpc, XrplRpcError } from '../../xrpl/xrplRpc';
import type { XrplNetwork } from '../../xrpl/ledgerCheck';

export const ASF_DEFAULT_RIPPLE = 8;
export const LSF_DEFAULT_RIPPLE = 0x00800000;
/** The account's master key may not sign (only its regular key or signer list can). */
export const LSF_DISABLE_MASTER = 0x00100000;
export const TF_SET_NO_RIPPLE = 0x00020000;
export const TF_CLEAR_NO_RIPPLE = 0x00040000;
/** Fee margin per planned transaction, in drops. */
const FEE_DROPS = 12n;

export interface LedgerLine {
  /** The peer of the line (the issuer, from the holder's side). */
  account: string;
  currency: string;
  limit: string;
  balance?: string;
  no_ripple?: boolean;
  no_ripple_peer?: boolean;
}

export interface LedgerAccountState {
  address: string;
  activated: boolean;
  flags: number;
  /** Hex domain as the ledger stores it. */
  domainHex?: string;
  balanceDrops: bigint;
  ownerCount: number;
  lines: LedgerLine[];
  /** The account's regular key (XRPL SetRegularKey): another key the ledger accepts signatures from. 15.35.0. */
  regularKey?: string;
}

/**
 * Which ledger authority lets `keyAddress` sign for `account` (15.35.0): its own master key
 * (unless disabled), or the regular key the account named. `null` means the ledger would
 * reject the signature (tefBAD_AUTH), so nothing should be asked of the wallet.
 */
export function signingAuthority(account: Pick<LedgerAccountState, 'address' | 'activated' | 'flags' | 'regularKey'>, keyAddress: string): 'master' | 'regular-key' | null {
  if (!account.activated) return null;
  if (keyAddress === account.address) return account.flags & LSF_DISABLE_MASTER ? null : 'master';
  return account.regularKey && account.regularKey === keyAddress ? 'regular-key' : null;
}

export interface IssuerGrantInput {
  currencyHex: string;
  issuer: LedgerAccountState;
  /** Holder roles that must hold the token (treasury, service). */
  holders: Array<{ role: string; state: LedgerAccountState }>;
  holderLimit: string;
  /** ASCII domain the issuer should carry; omitted leaves the domain alone. */
  domain?: string;
  /** No-ripple lines a holder needs to receive fees in other tokens. */
  feeLines?: Array<{ role: string; holder: string; currencyHex: string; issuer: string; label: string; limit: string }>;
  reserve: { baseDrops: bigint; incDrops: bigint };
}

export interface PlannedLedgerTx {
  signerRole: string;
  signer: string;
  label: string;
  /** Unsigned transaction JSON; autofill (Sequence, Fee) happens at signing. */
  tx: Record<string, unknown>;
  addsOwnerObject: boolean;
}

export interface IssuerGrantPlan {
  txs: PlannedLedgerTx[];
  alreadyInPlace: string[];
  problems: string[];
  reserve: Array<{ role: string; address: string; needDrops: bigint; haveDrops: bigint; ok: boolean }>;
  /** Nothing blocks the plan (an empty plan is ok: everything is in place). */
  ok: boolean;
}

const asciiHex = (s: string) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
const same = (a?: string, b?: string) => (a ?? '').toUpperCase() === (b ?? '').toUpperCase();
const lineTo = (s: LedgerAccountState, issuer: string, currencyHex: string) =>
  s.lines.find((l) => l.account === issuer && same(l.currency, currencyHex));

export function planIssuerGrant(input: IssuerGrantInput): IssuerGrantPlan {
  const txs: PlannedLedgerTx[] = [];
  const already: string[] = [];
  const problems: string[] = [];
  const { issuer, currencyHex } = input;

  if (!issuer.activated) problems.push(`Issuer ${issuer.address} is not activated on this network.`);
  for (const h of input.holders) if (!h.state.activated) problems.push(`${h.role} ${h.state.address} is not activated on this network.`);

  // 1) Issuer DefaultRipple (+ domain), before any holder line is created.
  const domainHex = input.domain ? asciiHex(input.domain) : undefined;
  const needsRipple = !(issuer.flags & LSF_DEFAULT_RIPPLE);
  const needsDomain = !!domainHex && !same(issuer.domainHex, domainHex);
  if (needsRipple || needsDomain) {
    txs.push({
      signerRole: 'issuer', signer: issuer.address, addsOwnerObject: false,
      label: `Issuer ${needsRipple ? 'DefaultRipple' : ''}${needsRipple && needsDomain ? ' + ' : ''}${needsDomain ? `domain ${input.domain}` : ''}`,
      tx: {
        TransactionType: 'AccountSet', Account: issuer.address,
        ...(needsRipple ? { SetFlag: ASF_DEFAULT_RIPPLE } : {}),
        ...(needsDomain ? { Domain: domainHex } : {}),
      },
    });
  } else {
    already.push('Issuer DefaultRipple' + (domainHex ? ' + domain' : ''));
  }

  // 2) Holder → issuer lines; 3) repair issuer-side NoRipple on older lines.
  for (const { role, state } of input.holders) {
    const line = lineTo(state, issuer.address, currencyHex);
    if (!line) {
      txs.push({
        signerRole: role, signer: state.address, addsOwnerObject: true,
        label: `${role} → issuer trust line (limit ${input.holderLimit})`,
        tx: { TransactionType: 'TrustSet', Account: state.address, LimitAmount: { currency: currencyHex, issuer: issuer.address, value: input.holderLimit } },
      });
    } else {
      already.push(`${role} → issuer trust line (limit ${line.limit})`);
      if (line.no_ripple_peer) {
        txs.push({
          signerRole: 'issuer', signer: issuer.address, addsOwnerObject: false,
          label: `Issuer clears NoRipple on the ${role} line`,
          tx: { TransactionType: 'TrustSet', Account: issuer.address, Flags: TF_CLEAR_NO_RIPPLE, LimitAmount: { currency: currencyHex, issuer: state.address, value: '0' } },
        });
      }
    }
  }

  // 4) Fee-collection lines, no-ripple.
  for (const f of input.feeLines ?? []) {
    const holder = input.holders.find((h) => h.state.address === f.holder)?.state;
    if (!holder) { problems.push(`Fee line ${f.label}: ${f.holder} is not one of the holders read.`); continue; }
    if (lineTo(holder, f.issuer, f.currencyHex)) { already.push(`${f.role} ${f.label} fee line`); continue; }
    txs.push({
      signerRole: f.role, signer: f.holder, addsOwnerObject: true,
      label: `${f.role} ${f.label} fee line (no-ripple)`,
      tx: { TransactionType: 'TrustSet', Account: f.holder, Flags: TF_SET_NO_RIPPLE, LimitAmount: { currency: f.currencyHex, issuer: f.issuer, value: f.limit } },
    });
  }

  // 5) Owner reserve per signer.
  const accounts = [{ role: 'issuer', state: issuer }, ...input.holders];
  const reserve = accounts.map(({ role, state }) => {
    const mineTxs = txs.filter((t) => t.signer === state.address);
    const added = mineTxs.filter((t) => t.addsOwnerObject).length;
    const needDrops = input.reserve.baseDrops + BigInt(state.ownerCount + added) * input.reserve.incDrops + FEE_DROPS * BigInt(mineTxs.length);
    return { role, address: state.address, needDrops, haveDrops: state.balanceDrops, ok: mineTxs.length === 0 || state.balanceDrops >= needDrops };
  });
  for (const r of reserve) if (!r.ok) problems.push(`${r.role} needs ${r.needDrops} drops for the reserve and fees; it holds ${r.haveDrops}.`);

  return { txs, alreadyInPlace: already, problems, reserve, ok: problems.length === 0 };
}

// ─── Ledger reads (validated ledger, public RPC) ─────────────────

type Fetcher = typeof fetch;

export async function readLedgerAccount(network: XrplNetwork, address: string, fetcher?: Fetcher): Promise<LedgerAccountState> {
  try {
    const info = await xrplRpc<{ account_data: { Flags?: number; Domain?: string; Balance: string; OwnerCount?: number; RegularKey?: string } }>(
      network, 'account_info', { account: address, ledger_index: 'validated' }, fetcher,
    );
    const lines = await xrplRpc<{ lines: LedgerLine[] }>(network, 'account_lines', { account: address, ledger_index: 'validated' }, fetcher);
    const d = info.account_data;
    return {
      address, activated: true, flags: d.Flags ?? 0, domainHex: d.Domain,
      balanceDrops: BigInt(d.Balance), ownerCount: d.OwnerCount ?? 0, lines: lines.lines ?? [],
      ...(d.RegularKey ? { regularKey: d.RegularKey } : {}),
    };
  } catch (e) {
    if (e instanceof XrplRpcError && e.code === 'actNotFound') {
      return { address, activated: false, flags: 0, balanceDrops: 0n, ownerCount: 0, lines: [] };
    }
    throw e;
  }
}

export async function readReserve(network: XrplNetwork, fetcher?: Fetcher): Promise<{ baseDrops: bigint; incDrops: bigint }> {
  const s = await xrplRpc<{ state: { validated_ledger: { reserve_base: number; reserve_inc: number } } }>(network, 'server_state', {}, fetcher);
  return { baseDrops: BigInt(s.state.validated_ledger.reserve_base), incDrops: BigInt(s.state.validated_ledger.reserve_inc) };
}
