/**
 * COPE node crystallized. Node ID: v15-31-00-ledger-payments.
 * Provenance: m/44'/144'/100'/principles/cope/v1#marketplace
 *
 * Direct ledger payments in any ledger asset (XRP or an issued token): prepare
 * the Payment, and check what the validated ledger DID — delivered_amount
 * (never Amount: a partial payment can ask for more than arrives), the
 * currency AND issuer, the destination and the memo. One reader for every
 * caller: staged stage payments (rail `ledger-staged`), fee legs and fee
 * distributions, so a token payment is never checked as if it were XRP.
 */
import type { LedgerTx, XrplNetwork } from '../xrpl/ledgerCheck';
import { buildMemo } from './MarketplaceMemoValidator';
import { assetLabel, issuedTokenFor, issuedValue, paymentAsset, unitsOfIssuedValue, type Currency } from './paymentAssets';

/** The XRPL Amount field for `units` of `code` on `network` (drops string, or an issued-currency object). */
export function ledgerAmount(units: number | bigint, code: Currency, network: XrplNetwork): string | { currency: string; issuer: string; value: string } {
  const a = paymentAsset(code);
  if (a.kind === 'fiat') throw new Error(`${a.label} does not settle on the ledger.`);
  if (a.kind === 'native') return String(units);
  const t = issuedTokenFor(code, network);
  return { currency: t.currencyHex, issuer: t.issuer, value: issuedValue(units, code) };
}

/** A direct Payment of `units` of `code`, with the marketplace monetary memo naming `reference` and `index`. No partial-payment flag, no paths. */
export function preparePayment(from: string, to: string, units: number | bigint, code: Currency, network: XrplNetwork, reference: string, index: number): Record<string, unknown> {
  return { TransactionType: 'Payment', Account: from, Destination: to, Amount: ledgerAmount(units, code, network), Memos: [buildMemo({ class: 'monetary', contractId: reference, deliveryIndex: index, currency: code })] };
}

/** Units of `code` the ledger shows delivered (null when it delivered something else: another currency, issuer or XRP). */
export function deliveredUnits(lt: LedgerTx, code: Currency): bigint | null {
  const a = paymentAsset(code);
  if (a.kind === 'native') return lt.deliveredDrops !== null && /^\d+$/.test(lt.deliveredDrops) ? BigInt(lt.deliveredDrops) : null;
  if (a.kind !== 'issued' || !lt.deliveredIssued) return null;
  let t; try { t = issuedTokenFor(code, lt.network); } catch { return null; }
  if (lt.deliveredIssued.issuer !== t.issuer) return null;
  const cur = lt.deliveredIssued.currency.toUpperCase();
  if (cur !== t.currencyHex.toUpperCase()) return null;
  return unitsOfIssuedValue(lt.deliveredIssued.value, code);
}

const memoFor = (lt: LedgerTx) => lt.memos.filter((m) => m.type === 'cappz-marketplace-monetary').map((m) => { try { return JSON.parse(m.data) as { contractId?: string; deliveryIndex?: number }; } catch { return {}; } });

export interface PaymentExpectation { network: XrplNetwork; from: string; to: string; toLabel: string; code: Currency; units: number | bigint; reference: string; index?: number }

/** What must be true of a validated Payment for it to count. Returns problems (empty = ok). */
export function checkLedgerPayment(lt: LedgerTx, e: PaymentExpectation): string[] {
  const p: string[] = [];
  if (lt.network !== e.network) p.push(`On ${lt.network}; this marketplace settles on ${e.network}.`);
  if (!lt.validated) p.push('Not in a validated ledger yet.');
  if (lt.result !== 'tesSUCCESS') p.push(`Result ${lt.result || 'unknown'}, not tesSUCCESS.`);
  if (lt.type !== 'Payment') p.push(`It is a ${lt.type}, not a Payment.`);
  if (lt.account !== e.from) p.push(`Sent from ${lt.account}, not ${e.from}.`);
  if (lt.destination !== e.to) p.push(`Paid to ${lt.destination}, not ${e.toLabel} (${e.to}).`);
  const got = deliveredUnits(lt, e.code);
  const label = assetLabel(e.code);
  if (got === null) p.push(`It did not deliver ${label}${paymentAsset(e.code).kind === 'issued' ? ' from its issuer' : ''}.`);
  else if (got < BigInt(e.units)) p.push(paymentAsset(e.code).kind === 'native' ? `Delivered ${got} drops; ${e.toLabel} is owed ${e.units}.` : `Delivered ${got} units of ${label}; ${e.toLabel} is owed ${e.units}.`);
  if (!memoFor(lt).some((m) => m.contractId === e.reference && (e.index === undefined || m.deliveryIndex === e.index))) p.push(`Memo does not name ${e.reference}${e.index === undefined ? '' : ` and stage ${e.index}`}.`);
  return p;
}
