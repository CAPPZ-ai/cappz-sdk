/**
 * COPE node crystallized. Node ID: v15-31-00-wallet-funding.
 * Provenance: m/44'/144'/100'/principles/cope/v1#marketplace
 *
 * Bring your own funded wallet. CAPPZ never sells, buys or routes anyone's
 * money onto the ledger: a person or agent arrives with a funded XRPL
 * account. This module says exactly what that account needs for a payment
 * (the stage, the reserves its escrows and trust lines lock, network fees)
 * and how to get it: the faucet on test networks, an exchange withdrawal on
 * mainnet, and a trust line first for issued tokens. Instructions only —
 * no provider is integrated, linked or keyed. (Replaces the on-ramp links of
 * v15-16-00.)
 */
import type { XrplNetwork } from '../xrpl/ledgerCheck';
import { assetAvailability, assetLabel, paymentAsset, type Currency } from './paymentAssets';

/** Account reserve the ledger requires before an account exists (XRP Ledger mainnet, since December 2024; check the current value). */
export const BASE_RESERVE_XRP = 1;
/** Owner reserve each ledger object (an open escrow, a trust line, a payment channel) locks until removed. */
export const OWNER_RESERVE_XRP = 0.2;
const NETWORK_FEES_XRP = 0.001;

/** XRP the buyer needs in their account to fund a stage: the stage, the reserve per escrow leg, network fees. */
export function xrpNeededForStage(stageXrp: number, escrowLegs: number): number {
  // Round up to whole drops; trim float noise first (100.401 × 10⁶ is 100401000.00000001).
  return Math.ceil(Number(((stageXrp + escrowLegs * OWNER_RESERVE_XRP + NETWORK_FEES_XRP) * 1_000_000).toFixed(3))) / 1_000_000;
}

export const TESTNET_FAUCET = 'https://xrpl.org/resources/dev-tools/xrp-faucets';

export interface FundingNeed {
  network: XrplNetwork;
  /** The asset to pay in and how much of it the payer needs. */
  currency: Currency;
  amount: number;
  /** XRP the account must hold besides: the base reserve when it is new, owner reserves, network fees. */
  xrpForReserves: number;
  /** Issued tokens: a trust line to this issuer must exist before anyone can send the token to the account. */
  trustLine: { currencyHex: string; issuer: string } | null;
  steps: string[];
}

/**
 * What a payer needs and how to get it, in plain steps. `accountExists` false adds the base reserve; `ledgerObjects`
 * counts the escrows (or channels) the payment opens. A token not offered on the network says why.
 */
export function fundingNeed(opts: { network: XrplNetwork; currency: Currency; amount: number; accountExists: boolean; hasTrustLine?: boolean; ledgerObjects?: number }): FundingNeed {
  const { network, currency, amount } = opts;
  const a = paymentAsset(currency);
  const objects = (opts.ledgerObjects ?? 0) + (a.kind === 'issued' && !opts.hasTrustLine ? 1 : 0);
  const xrpForReserves = Math.round(((opts.accountExists ? 0 : BASE_RESERVE_XRP) + objects * OWNER_RESERVE_XRP + NETWORK_FEES_XRP) * 1e6) / 1e6;
  const steps: string[] = [];
  let trustLine: FundingNeed['trustLine'] = null;
  if (a.kind === 'fiat') {
    steps.push(`${a.label} are paid by card or bank through the marketplace payment page, or recorded by reference; no ledger wallet is needed for the payment itself.`);
    return { network, currency, amount, xrpForReserves: 0, trustLine, steps };
  }
  const xrpTotal = a.kind === 'native' ? Math.round((amount + xrpForReserves) * 1e6) / 1e6 : xrpForReserves;
  if (network === 'mainnet') {
    steps.push(`Buy at least ${xrpTotal} XRP on an exchange that supports XRP Ledger withdrawals, and withdraw it to your own wallet address (no destination tag is needed when sending to your own wallet).`);
  } else {
    steps.push(`On ${network} there is no real money: fund the account from the ${network} faucet (${TESTNET_FAUCET}) — it sends enough XRP for testing.`);
  }
  if (a.kind === 'issued') {
    const av = assetAvailability(currency, network);
    if (av.state !== 'available' || !av.token) return { network, currency, amount, xrpForReserves, trustLine: null, steps: [av.state === 'available' ? `${a.label} is not an issued token.` : av.reason] };
    trustLine = av.token;
    if (!opts.hasTrustLine) steps.push(`Set a trust line to the ${a.label} issuer ${av.token.issuer} (currency ${av.token.currencyHex}) from your wallet; it locks ${OWNER_RESERVE_XRP} XRP of reserve while it exists.`);
    steps.push(network === 'mainnet'
      ? `Get ${amount} ${a.label} into the account: withdraw it from an exchange that offers ${a.label} withdrawals on the XRP Ledger (choose the XRP Ledger network, not another chain), or receive it from another wallet.`
      : `Get ${amount} test ${a.label} from someone who holds it on ${network}, or from the issuer's test distribution if one is offered.`);
  }
  return { network, currency, amount, xrpForReserves, trustLine, steps };
}

/** One-line summary for a message to the person an agent acts for. */
export function fundingSummary(n: FundingNeed): string {
  return `${n.network}: ${n.amount} ${assetLabel(n.currency)}${n.xrpForReserves ? ` plus ${n.xrpForReserves} XRP for reserves and fees` : ''}. ${n.steps.join(' ')}`;
}

/** tfSetNoRipple: a holder's line never lets other people's payments ripple through the account. */
export const TF_SET_NO_RIPPLE = 0x00020000;

/**
 * The TrustSet that lets `account` hold an issued payment asset (CAPPZ, USD-tokenZ/1), to the issuer in the
 * payment-asset registry for that network — never an issuer a counterparty names. Locks one owner reserve while the
 * line exists; a line with a zero balance can be removed later (limit 0). Throws with the reason when the asset is not
 * offered on the network.
 */
export function prepareTrustSet(account: string, currency: Currency, network: XrplNetwork, limit = '1000000000'): Record<string, unknown> {
  const a = paymentAsset(currency);
  if (a.kind !== 'issued') throw new Error(`${a.label} needs no trust line.`);
  const av = assetAvailability(currency, network);
  if (av.state !== 'available' || !av.token) throw new Error(av.state === 'available' ? `${a.label} has no issuer on ${network}.` : av.reason);
  return { TransactionType: 'TrustSet', Account: account, Flags: TF_SET_NO_RIPPLE, LimitAmount: { currency: av.token.currencyHex, issuer: av.token.issuer, value: limit } };
}
