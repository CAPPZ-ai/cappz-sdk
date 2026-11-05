/**
 * COPE node crystallized. Node ID: v15-31-00-payment-assets.
 * Provenance: m/44'/144'/100'/principles/cope/v1#marketplace
 *
 * One payment namespace. Each asset a deal can be priced in is an MDM account
 * at cappz/config/payment-assets/<id>, and each way an asset settles is a rail
 * at cappz/config/payment-rails/<id> (paths.ts) — the same pattern as the
 * transport types. Ids are CAPPZ-assigned and name no vendor: the stablecoin
 * family is USD-tokenZ (`usd-tokenz`), its members are HD children
 * (`usd-tokenz/1` is RLUSD), and the token's own name, currency code and
 * issuer per network are metadata. Which processor stands behind the card rail
 * is adapter metadata too, so a provider can change without changing an
 * address. Addresses outlive vendors.
 *
 * A Money value carries the asset's `code` — the value already written on
 * the public log for XRP and USD, so earlier deals replay unchanged
 * (permanence); `resolvePaymentAsset` also accepts the id, the address and
 * aliases. Every option is equal: a seller prices a listing or bid in any
 * asset; the deal freezes its asset and rail when it forms, as it freezes the
 * fee terms; fees come from the same schedule, keyed by asset.
 *
 * Availability is a lifecycle state, never a boolean: an asset is offered on
 * a network only when its configuration validates (issuer checksum), and says
 * why it is unavailable elsewhere.
 */
import { isValidClassicAddress } from 'xrpl';
import { paymentAssetAddress, paymentRailAddress } from '../wallets/paths';
import { resolveIssuer } from '../network/networkConfig';
import type { XrplNetwork } from '../xrpl/ledgerCheck';

/** The asset codes a Money value may carry (the value on the public log). */
export type Currency = 'USD' | 'XRP' | 'CAPPZ' | 'USD-tokenZ/1';
export const CURRENCIES: readonly Currency[] = ['USD', 'XRP', 'CAPPZ', 'USD-tokenZ/1'];

export type RailId = 'ledger-escrow' | 'ledger-staged' | 'ledger-channel' | 'card' | 'by-reference';
export type PaymentAssetKind = 'native' | 'issued' | 'fiat';

export interface IssuedToken { currencyHex: string; issuer: string }

export interface PaymentAsset {
  /** Vendor-neutral id; the address segment(s). */
  id: string;
  mdmAddress: string;
  /** What a Money value carries. */
  code: Currency;
  /** Display only — never used to look anything up. */
  label: string;
  kind: PaymentAssetKind;
  /** Family account for numbered members (USD-tokenZ). */
  family: string | null;
  /** Smallest units per whole unit (cents, drops, token micro-units). */
  minor: number;
  /** Fractional digits shown. */
  decimals: number;
  /** Issued tokens: currency code and issuer on a network (null = not issued there). Read when asked, so admin overrides apply. */
  issued?: (network: XrplNetwork) => IssuedToken | null;
  /** Rails that may settle this asset, the default first. */
  rails: readonly RailId[];
  aliases: readonly string[];
  description: string;
}

export interface PaymentRail {
  id: RailId;
  mdmAddress: string;
  label: string;
  /** Who confirms a payment on this rail (separate trust states). */
  confirmedBy: 'ledger' | 'processor' | 'nobody';
  /** Holds on this rail never exceed one billing cycle (days); null = nothing is held. */
  holdLimitDays: number | null;
  /** Hosted adapter that runs the rail, when it needs a third-party secret (secrets-last); metadata, never an address. */
  adapter: { function: string; provider: string } | null;
  description: string;
  aliases: readonly string[];
}

const RLUSD_HEX = '524C555344000000000000000000000000000000';
const CAPPZ_HEX = '434150505A000000000000000000000000000000';

/** CAPPZ issuer per network from the network configuration (admin overrides included); invalid checksums are refused. */
const cappzIssuer = (network: XrplNetwork): IssuedToken | null => {
  let issuer = '';
  try { issuer = resolveIssuer(network); } catch { return null; }
  return { currencyHex: CAPPZ_HEX, issuer };
};

export const PAYMENT_RAILS: readonly PaymentRail[] = [
  { id: 'ledger-escrow', mdmAddress: paymentRailAddress('ledger-escrow'), label: 'Ledger escrow', confirmedBy: 'ledger', holdLimitDays: 30, adapter: null, aliases: ['xrpl-escrow', 'xrpl-testnet'],
    description: 'One escrow per stage leg under one crypto-condition; the buyer reveals the secret to release, the ledger returns an unreleased stage after CancelAfter (≤ 30 days).' },
  { id: 'ledger-staged', mdmAddress: paymentRailAddress('ledger-staged'), label: 'Ledger, stage by stage', confirmedBy: 'ledger', holdLimitDays: null, adapter: null, aliases: ['xrpl-payment'],
    description: 'Each stage is paid directly on the ledger when the buyer accepts it (seller net + fee legs), each Payment checked by delivered amount, currency and issuer. Nothing is held; neither side is more than one stage exposed.' },
  { id: 'ledger-channel', mdmAddress: paymentRailAddress('ledger-channel'), label: 'Ledger payment channel', confirmedBy: 'ledger', holdLimitDays: 30, adapter: null, aliases: ['paychan'],
    description: 'Metered use: the buyer opens a channel capped by the mandate, signs claims as work is used, the seller redeems; the channel expires within one billing cycle.' },
  { id: 'card', mdmAddress: paymentRailAddress('card'), label: 'Card or bank', confirmedBy: 'processor', holdLimitDays: 30, adapter: { function: 'marketplace-payments', provider: 'stripe' }, aliases: ['stripe-card', 'stripe-ach', 'stripe'],
    description: 'USD charged by the payment processor, held up to 30 days and transferred on release; processor-confirmed entries only.' },
  { id: 'by-reference', mdmAddress: paymentRailAddress('by-reference'), label: 'Recorded by reference', confirmedBy: 'nobody', holdLimitDays: 30, adapter: null, aliases: ['usd-reference', 'demo'],
    description: 'A payment made elsewhere and recorded by its reference: shown as recorded, never as validated.' },
];

export const PAYMENT_ASSETS: readonly PaymentAsset[] = [
  { id: 'xrp', mdmAddress: paymentAssetAddress('xrp'), code: 'XRP', label: 'XRP', kind: 'native', family: null, minor: 1_000_000, decimals: 6, rails: ['ledger-escrow', 'ledger-channel'], aliases: ['xrp'],
    description: 'The ledger\'s native asset, escrowed per stage.' },
  { id: 'cappz-token', mdmAddress: paymentAssetAddress('cappz-token'), code: 'CAPPZ', label: 'CAPPZ', kind: 'issued', family: null, minor: 1_000_000, decimals: 6,
    issued: cappzIssuer, rails: ['ledger-staged'], aliases: ['cappz'],
    description: 'The CAPPZ token, paid stage by stage on the ledger (needs a trust line to the issuer).' },
  { id: 'usd-tokenz/1', mdmAddress: paymentAssetAddress('usd-tokenz/1'), code: 'USD-tokenZ/1', label: 'RLUSD', kind: 'issued', family: paymentAssetAddress('usd-tokenz'), minor: 1_000_000, decimals: 2,
    issued: (network) => ({ mainnet: { currencyHex: RLUSD_HEX, issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' }, testnet: { currencyHex: RLUSD_HEX, issuer: 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV' }, devnet: null } as Record<XrplNetwork, IssuedToken | null>)[network],
    rails: ['ledger-staged'], aliases: ['usd-tokenz-1', 'rlusd'],
    description: 'USD-tokenZ member 1: a US-dollar stablecoin issued on the ledger, paid stage by stage (needs a trust line to the issuer). Its issuer does not allow trust-line locking today, so it cannot be escrowed.' },
  { id: 'usd', mdmAddress: paymentAssetAddress('usd'), code: 'USD', label: 'US dollars', kind: 'fiat', family: null, minor: 100, decimals: 2, rails: ['card', 'by-reference'], aliases: ['usd-card'],
    description: 'US dollars by card or bank through the payment processor, or recorded by reference.' },
];

/** The USD-tokenZ family account (members are its HD children). */
export const USD_TOKENZ_FAMILY = paymentAssetAddress('usd-tokenz');

const byKey = new Map<string, PaymentAsset>();
for (const a of PAYMENT_ASSETS) for (const k of [a.code, a.id, a.mdmAddress, ...a.aliases]) byKey.set(k.toLowerCase(), a);
const railByKey = new Map<string, PaymentRail>();
for (const r of PAYMENT_RAILS) for (const k of [r.id, r.mdmAddress, ...r.aliases]) railByKey.set(k.toLowerCase(), r);

/** The asset a code, id, address or alias names (null when unknown). */
export function resolvePaymentAsset(key: string | null | undefined): PaymentAsset | null {
  return key ? byKey.get(String(key).toLowerCase()) ?? null : null;
}
export function paymentAsset(code: Currency): PaymentAsset {
  const a = resolvePaymentAsset(code);
  if (!a) throw new Error(`Unknown payment asset ${code}.`);
  return a;
}
export function resolvePaymentRail(key: string | null | undefined): PaymentRail | null {
  return key ? railByKey.get(String(key).toLowerCase()) ?? null : null;
}
export const isCurrency = (x: unknown): x is Currency => typeof x === 'string' && (CURRENCIES as readonly string[]).includes(x);
/** A code from any accepted spelling (id, alias, address); null when it names no asset. */
export const currencyOf = (key: string | null | undefined): Currency | null => resolvePaymentAsset(key)?.code ?? null;

export const assetLabel = (code: Currency | string): string => resolvePaymentAsset(code)?.label ?? String(code);
export const isLedgerAsset = (code: Currency): boolean => paymentAsset(code).kind !== 'fiat';
export const isIssuedAsset = (code: Currency): boolean => paymentAsset(code).kind === 'issued';
/** The rail a deal in this asset uses when it forms. */
export const defaultRail = (code: Currency): RailId => paymentAsset(code).rails[0];

export type AssetAvailability =
  | { state: 'available'; token: IssuedToken | null }
  | { state: 'not-issued'; reason: string }
  | { state: 'invalid-config'; reason: string };

/** Whether an asset can be used on a network, and why not. */
export function assetAvailability(code: Currency, network: XrplNetwork): AssetAvailability {
  const a = paymentAsset(code);
  if (a.kind !== 'issued') return { state: 'available', token: null };
  const t = a.issued?.(network) ?? null;
  if (!t) return { state: 'not-issued', reason: `${a.label} is not issued on ${network}.` };
  if (!isValidClassicAddress(t.issuer)) return { state: 'invalid-config', reason: `The configured ${a.label} issuer on ${network} (${t.issuer}) fails checksum validation, so ${a.label} is not offered there.` };
  return { state: 'available', token: t };
}

/** The issued token (currency hex + issuer) a ledger payment in `code` must deliver on `network`; throws with the reason. */
export function issuedTokenFor(code: Currency, network: XrplNetwork): IssuedToken {
  const av = assetAvailability(code, network);
  if (av.state !== 'available' || !av.token) throw new Error(av.state === 'available' ? `${assetLabel(code)} is not an issued token.` : av.reason);
  return av.token;
}

/** Assets offered on a network (configuration validates), in registry order. */
export const assetsOn = (network: XrplNetwork): PaymentAsset[] => PAYMENT_ASSETS.filter((a) => assetAvailability(a.code, network).state === 'available');

export const toMinor = (amount: number, code: Currency): number => Math.round(amount * paymentAsset(code).minor);
export const fromMinor = (units: number, code: Currency): number => units / paymentAsset(code).minor;
/** An XRPL issued-currency value string for `units` (no exponent, trailing zeros trimmed). */
export const issuedValue = (units: number | bigint, code: Currency): string => {
  const m = BigInt(paymentAsset(code).minor); const u = BigInt(units);
  const whole = u / m; const frac = (u % m).toString().padStart(String(m).length - 1, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
};
/** Smallest units in an XRPL issued-currency value string (exact decimal parse, no floats). */
export const unitsOfIssuedValue = (value: string, code: Currency): bigint | null => {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim()); if (!m) return null;
  const digits = String(paymentAsset(code).minor).length - 1;
  const frac = (m[2] ?? '').padEnd(digits, '0');
  if (frac.length > digits && /[1-9]/.test(frac.slice(digits))) return null; // more precision than the asset carries
  return BigInt(m[1]) * BigInt(paymentAsset(code).minor) + BigInt(frac.slice(0, digits) || '0');
};

/** Display an amount with its asset (USD as dollars). */
export function formatMoney(amount: number, code: Currency): string {
  const a = paymentAsset(code);
  if (code === 'USD') return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `${amount.toLocaleString('en-US', { maximumFractionDigits: a.decimals })} ${a.label}`;
}

/** The paid-agent kit's TokenSpec (agentKit/paidAgent.ts) for an issued asset on a network: display code, currency hex, issuer. */
export function tokenSpecFor(code: Currency, network: XrplNetwork): { code: string; hex: string; issuer: string } {
  const t = issuedTokenFor(code, network);
  return { code: assetLabel(code), hex: t.currencyHex, issuer: t.issuer };
}
