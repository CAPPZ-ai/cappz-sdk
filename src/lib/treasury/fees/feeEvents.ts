/**
 * COPE node crystallized.
 * Node ID: v14-02-00-fee-events
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Replayed treasury balances (AP-12: no stored balance numbers). Balances are
 * derived by replaying the fee lifecycle TXs registered in the MDM fees
 * category: FundsDeposited, FeesReserved, AppFunded, FeeCharged,
 * SubscriptionCharged, PriceSheetPublished.
 */

export type FeeEventType =
  | 'FundsDeposited'
  | 'FeesReserved'
  | 'AppFunded'
  | 'FeeCharged'
  | 'SubscriptionCharged'
  | 'PriceSheetPublished';

export interface FeeEvent {
  type: FeeEventType;
  /** USD cents moved or charged. */
  amountCents: number;
  /** Price sheet id recorded on FeeCharged / SubscriptionCharged. */
  sheetId?: string;
  timestamp: string;
}

export interface TreasuryBalance {
  depositedCents: number;
  reservedCents: number;
  fundedToAppsCents: number;
  chargedCents: number;
  /** Spendable = deposited - reserved - funded. */
  spendableCents: number;
}

/** Replay a wallet's fee events into a balance. Latest-wins ordering by timestamp. */
export function replayTreasuryBalance(events: FeeEvent[]): TreasuryBalance {
  const sorted = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  let deposited = 0;
  let reserved = 0;
  let funded = 0;
  let charged = 0;
  for (const e of sorted) {
    switch (e.type) {
      case 'FundsDeposited':
        deposited += e.amountCents;
        break;
      case 'FeesReserved':
        reserved += e.amountCents;
        break;
      case 'AppFunded':
        funded += e.amountCents;
        break;
      case 'FeeCharged':
      case 'SubscriptionCharged':
        charged += e.amountCents;
        break;
      case 'PriceSheetPublished':
        break;
    }
  }
  return {
    depositedCents: deposited,
    reservedCents: reserved,
    fundedToAppsCents: funded,
    chargedCents: charged,
    spendableCents: deposited - reserved - funded,
  };
}

/** True when the app wallet cannot cover a charge — callers show "top up". */
export function insufficientFunds(balance: TreasuryBalance, chargeCents: number): boolean {
  return balance.spendableCents < chargeCents;
}
