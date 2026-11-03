/**
 * COPE node crystallized. Node ID: v15-16-00-marketplace-on-ramp.
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Option 2 for buyers without XRP: buy it with a card or bank account from an
 * on-ramp (Ramp, MoonPay) straight into the buyer's own XRPL account, then
 * fund the stage's escrow as usual. The provider does the identity checks and
 * holds nothing for us; CAPPZ never touches the money. Links only — the
 * provider's hosted page quotes the price and fees.
 */
import type { XrplNetwork } from '../xrpl/ledgerCheck';

/** Owner reserve each open escrow locks until it settles (XRP Ledger mainnet, as of late 2024; check the current value). */
export const OWNER_RESERVE_XRP = 0.2;
const NETWORK_FEES_XRP = 0.001;

/** XRP the buyer needs in their account to fund a stage: the stage, the reserve per escrow leg, network fees. */
export function xrpNeededForStage(stageXrp: number, escrowLegs: number): number {
  // Round up to whole drops; trim float noise first (100.401 × 10⁶ is 100401000.00000001).
  return Math.ceil(Number(((stageXrp + escrowLegs * OWNER_RESERVE_XRP + NETWORK_FEES_XRP) * 1_000_000).toFixed(3))) / 1_000_000;
}

export interface OnRampLink { provider: 'Ramp' | 'MoonPay'; url: string }

/** Provider links that deliver `xrp` to `account`; empty off mainnet (on-ramps deliver real XRP only) and for providers whose host key the caller does not pass. */
export function onRampLinks(account: string, xrp: number, network: XrplNetwork, keys: { ramp?: string; moonpay?: string } = {}): OnRampLink[] {
  if (network !== 'mainnet') return [];
  const out: OnRampLink[] = [];
  if (keys.ramp) out.push({ provider: 'Ramp', url: `https://app.ramp.network/?${new URLSearchParams({ hostApiKey: keys.ramp, swapAsset: 'XRP_XRP', userAddress: account, swapAmount: String(Math.round(xrp * 1_000_000)) })}` });
  if (keys.moonpay) out.push({ provider: 'MoonPay', url: `https://buy.moonpay.com/?${new URLSearchParams({ apiKey: keys.moonpay, currencyCode: 'xrp', walletAddress: account, quoteCurrencyAmount: String(xrp) })}` });
  return out;
}

export const TESTNET_FAUCET = 'https://xrpl.org/resources/dev-tools/xrp-faucets';
