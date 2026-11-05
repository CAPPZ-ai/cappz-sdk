/**
 * COPE node crystallized. Node ID: v14-19-00-marketplace-xrpl.
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * XRPL testnet transactions for the marketplace, PREPARED here and signed and
 * submitted by the party's own wallet (the app never holds keys). Payment
 * legs follow the two-leg model of MarketplaceMemoValidator: the monetary leg
 * carries the amount in `Amount`; the commodity leg is a 1-drop carrier whose
 * memo states class, quantity, unit and SKU address. Receipt tokens are XRPL
 * Multi-Purpose Tokens (MPTokenIssuanceCreate). A submitted transaction is
 * recorded back by reference (PaymentConfirmed) — it is not shown as
 * validated until checked on-ledger.
 */
import { assertValidPreparedTx, buildMemo } from './MarketplaceMemoValidator';
import { skuAddress } from './MarketplacePaths';
import type { ContractTerms, TokenContent } from './types';

export const MARKETPLACE_XRPL_NETWORK = 'testnet' as const;
const DROPS_PER_XRP = 1_000_000;

export function prepareMonetaryLeg(c: ContractTerms, milestone: number, amount: number, from: string, to: string): Record<string, unknown> | null {
  if (c.total.currency !== 'XRP') return null; // USD legs settle off-ledger and are recorded by reference
  const tx = { TransactionType: 'Payment', Account: from, Destination: to, Amount: String(Math.round(amount * DROPS_PER_XRP)), Memos: [buildMemo({ class: 'monetary', contractId: c.contractId, deliveryIndex: milestone, currency: 'XRP' })] };
  assertValidPreparedTx(tx);
  return tx;
}

export function prepareCommodityLeg(c: ContractTerms, milestone: number, from: string, to: string): Record<string, unknown> {
  // A subcontract has no listing or request of its own: its SKU is the child contract.
  const sourceId = c.source.kind === 'request' ? c.source.requestId : c.source.kind === 'listing' ? c.source.listingId : c.contractId;
  const tx = { TransactionType: 'Payment', Account: from, Destination: to, Amount: '1', Memos: [buildMemo({ class: 'commodity', contractId: c.contractId, deliveryIndex: milestone, qty: c.quantity, unit: c.unit, skuHdAddress: skuAddress(sourceId) })] };
  assertValidPreparedTx(tx);
  return tx;
}

const toHex = (s: string) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
/** tfMPTCanTransfer | tfMPTCanEscrow | tfMPTCanTrade (receipts must move with the goods). */
const MPT_FLAGS = 0x20 | 0x08 | 0x10;

export function prepareTokenIssuance(t: Pick<TokenContent, 'tokenId' | 'name' | 'assetKind' | 'redeemsFor' | 'supply' | 'categoryId'>, issuerAccount: string): Record<string, unknown> {
  const metadata = JSON.stringify({ t: t.name, k: t.assetKind, r: `${t.redeemsFor.quantity} ${t.redeemsFor.unit}`, c: t.categoryId, id: t.tokenId });
  return { TransactionType: 'MPTokenIssuanceCreate', Account: issuerAccount, AssetScale: 0, MaximumAmount: String(t.supply), Flags: MPT_FLAGS, MPTokenMetadata: toHex(metadata) };
}
