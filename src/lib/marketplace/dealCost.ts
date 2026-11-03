/**
 * COPE node crystallized. Node ID: v15-05-00-marketplace-deal-cost.
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * What a deal costs on CAPPZ, from what its contract has written. Each step
 * of a contract is a ledger record (formed, funded, evidence, acceptance,
 * release, reviews, disputes), priced at the published base transaction
 * fee, for transparency. Marketplace fees (percentage, flat, per record) come
 * from the admin fee schedule (fees.ts) and are paid by the seller; the
 * XRPL network fee is paid on the ledger itself and stated, not estimated.
 */
import { BASE_TX_FEE_CENTS } from '../treasury/fees/priceSheet';
import type { ContractView } from './types';

export interface DealCost {
  records: Array<{ label: string; count: number }>;
  total: number;
  usd: number;
  /** Platform cost as a share of the deal value (0..1), when the deal is priced in USD. */
  shareOfDeal: number | null;
}

export function dealCost(c: ContractView): DealCost {
  const evidence = c.milestoneStates.reduce((n, m) => n + m.evidence.length, 0);
  const released = c.milestoneStates.filter((m) => m.state === 'released').length;
  const accepted = c.milestoneStates.filter((m) => m.state === 'affirmed' || m.state === 'released').length;
  const disputes = c.disputes.length + c.disputes.filter((d) => d.resolved).length;
  const records = [
    { label: 'Contract formed', count: 1 },
    { label: 'Escrow funded', count: c.payments.length },
    { label: 'Evidence shown', count: evidence },
    { label: 'Milestones accepted', count: accepted },
    { label: 'Payments released', count: released + c.ledgerSettlements.filter((s) => s.kind === 'refund').length },
    { label: 'Reviews', count: c.reviews.length },
    { label: 'Disputes and rulings', count: disputes },
  ].filter((r) => r.count > 0);
  const total = records.reduce((n, r) => n + r.count, 0);
  const usd = (total * BASE_TX_FEE_CENTS) / 100;
  return { records, total, usd, shareOfDeal: c.total.currency === 'USD' && c.total.amount > 0 ? usd / c.total.amount : null };
}

export const BASE_FEE_LABEL = `${BASE_TX_FEE_CENTS}¢ per ledger record (published base fee)`;
