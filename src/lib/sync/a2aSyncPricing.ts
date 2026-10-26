/**
 * COPE node crystallized.
 * Node ID: v12-21-07-a2a-sync-pricing
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Bid/ask pricing for A2A sync. Base prices are self-sent config TXs to the
 * wallet's own /admin/in-queue (Tx.Amount = price). Orders derive their price
 * from the latest base (latest wins) and may override with a fixed amount or
 * a ±% of base. Units: flat, per-KB, per-MB. Offerers are paid on-chain via
 * SyncPaymentSettled before a session opens; 0 CAPPZ still writes the record.
 */
import type { A2ASyncEvent } from './a2aSyncEvents';

export type SyncPriceUnit = 'flat' | 'per-KB' | 'per-MB';
export type SyncPriceSide = 'offer' | 'request';
export type SyncPriceAdjustment = { amount: number } | { pct: number };

export interface SyncPrice {
  baseCappz: number;
  baseUnit: SyncPriceUnit;
  adjustment?: SyncPriceAdjustment;
  priceCappz: number;
  unit: SyncPriceUnit;
}

export const DEFAULT_SYNC_PRICE_CAPPZ = 0;
export const BASE_PRICE_EVENT: Record<SyncPriceSide, 'BaseSyncPriceOffered' | 'BasePriceSyncRequested'> = {
  offer: 'BaseSyncPriceOffered',
  request: 'BasePriceSyncRequested',
};

const UNIT_BYTES: Record<Exclude<SyncPriceUnit, 'flat'>, number> = { 'per-KB': 1024, 'per-MB': 1_048_576 };
/** Smallest CAPPZ unit used for rounding payments (6 decimals). */
const PRECISION = 1_000_000;
const roundUp = (value: number) => Math.ceil(value * PRECISION - 1e-9) / PRECISION;

export function isSyncPriceUnit(value: unknown): value is SyncPriceUnit {
  return value === 'flat' || value === 'per-KB' || value === 'per-MB';
}

/** Parse "5", "+10%", "-15%" into an adjustment. */
export function parsePriceAdjustment(raw: unknown): SyncPriceAdjustment | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'number') return Number.isFinite(raw) ? { amount: raw } : undefined;
  if (typeof raw === 'object') {
    const r = raw as { amount?: unknown; pct?: unknown };
    if (typeof r.pct === 'number') return { pct: r.pct };
    if (typeof r.amount === 'number') return { amount: r.amount };
    return undefined;
  }
  const text = String(raw).trim();
  const pct = /^([+-]?\d+(?:\.\d+)?)%$/.exec(text);
  if (pct) return { pct: Number(pct[1]) };
  const amount = Number(text);
  if (!Number.isFinite(amount)) throw new Error(`Invalid price "${text}". Use an amount (5) or a percentage of base (+10%, -15%).`);
  return { amount };
}

export function applyPriceAdjustment(base: number, adjustment?: SyncPriceAdjustment): number {
  if (!adjustment) return Math.max(0, base);
  if ('pct' in adjustment) return Math.max(0, roundUp(base * (1 + adjustment.pct / 100)));
  return Math.max(0, adjustment.amount);
}

/** Latest self-sent base price for a wallet/side (latest wins); defaults to 0 CAPPZ flat. */
export function resolveBaseSyncPrice(events: A2ASyncEvent[], walletAddress: string, side: SyncPriceSide): { amount: number; unit: SyncPriceUnit; txId?: string; timestamp?: string } {
  const type = BASE_PRICE_EVENT[side];
  const latest = events
    .filter((e) => e.eventType === type && String(e.data.walletAddress ?? '') === walletAddress)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.txId.localeCompare(a.txId))[0];
  if (!latest) return { amount: DEFAULT_SYNC_PRICE_CAPPZ, unit: 'flat' };
  const amount = Number(latest.data.amount);
  return { amount: Number.isFinite(amount) ? Math.max(0, amount) : 0, unit: isSyncPriceUnit(latest.data.unit) ? latest.data.unit : 'flat', txId: latest.txId, timestamp: latest.timestamp };
}

export function baseSyncPriceHistory(events: A2ASyncEvent[], walletAddress: string | undefined, side: SyncPriceSide) {
  return events
    .filter((e) => e.eventType === BASE_PRICE_EVENT[side] && (!walletAddress || String(e.data.walletAddress ?? '') === walletAddress))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .map((e) => ({ txId: e.txId, walletAddress: String(e.data.walletAddress ?? ''), amount: Number(e.data.amount) || 0, unit: isSyncPriceUnit(e.data.unit) ? e.data.unit : 'flat' as SyncPriceUnit, timestamp: e.timestamp }));
}

export function priceOrder(base: { amount: number; unit: SyncPriceUnit }, adjustment?: SyncPriceAdjustment, unit?: SyncPriceUnit): SyncPrice {
  return { baseCappz: base.amount, baseUnit: base.unit, adjustment, priceCappz: applyPriceAdjustment(base.amount, adjustment), unit: unit ?? base.unit };
}

/** Total CAPPZ due for a transfer of `bytes` at this price. */
export function priceForBytes(price: Pick<SyncPrice, 'priceCappz' | 'unit'>, bytes: number): number {
  if (price.unit === 'flat') return price.priceCappz;
  return roundUp(price.priceCappz * (Math.max(0, bytes) / UNIT_BYTES[price.unit]));
}

/**
 * Bid >= ask, compared on the total cost for the manifest size so different
 * units still match. Missing prices count as 0 CAPPZ.
 */
export function comparePrices(ask: SyncPrice | undefined, bid: SyncPrice | undefined, manifestBytes: number): { ok: boolean; askTotal: number; bidTotal: number } {
  const askTotal = ask ? priceForBytes(ask, manifestBytes) : 0;
  const bidTotal = bid ? priceForBytes(bid, manifestBytes) : 0;
  return { ok: bidTotal + 1e-9 >= askTotal, askTotal, bidTotal };
}

export function formatSyncPrice(price?: Pick<SyncPrice, 'priceCappz' | 'unit'>): string {
  if (!price) return '0 CAPPZ';
  const n = Number(price.priceCappz.toFixed(6)).toString();
  return price.unit === 'flat' ? `${n} CAPPZ` : `${n} CAPPZ/${price.unit === 'per-KB' ? 'KB' : 'MB'}`;
}

export function formatAdjustment(adjustment?: SyncPriceAdjustment): string {
  if (!adjustment) return 'base';
  if ('pct' in adjustment) return `${adjustment.pct >= 0 ? '+' : ''}${adjustment.pct}% of base`;
  return `fixed ${adjustment.amount}`;
}
