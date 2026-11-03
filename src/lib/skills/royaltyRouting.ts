/**
 * COPE node crystallized. Node ID: v15-14-00-royalty-routing.
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * The routing primitive of the Royalty Flywheel: one fee, in a currency's
 * smallest unit (drops, cents), split across DARC recipients by integer basis
 * points. Exact: the legs always add up to the fee (the remainder from
 * rounding down goes to the largest share), so nothing is lost or invented.
 * Recipients are DARC split rules (validateDARCSplitRules) plus a checksum-
 * valid XRPL classic address each, because the legs settle on the ledger.
 *
 * Pure and deterministic — the marketplace, securities and any composing
 * skill route through the same function the flywheel exposes.
 */
import { isValidClassicAddress } from 'xrpl';
import { validateDARCSplitRules } from '../wallet/chainlet/darcSplitRules';

export interface RoyaltyRecipient {
  /** XRPL classic address that receives this share. */
  account: string;
  label: string;
  /** Share in basis points (1 bp = 0.01%); shares sum to exactly 10,000. */
  bps: number;
}

export interface RoyaltyLeg { account: string; label: string; bps: number; units: number }

export const FULL_BPS = 10_000;

/** Violations for a recipient set (empty = valid). */
export function validateRoyaltyRecipients(recipients: readonly RoyaltyRecipient[]): string[] {
  const violations = validateDARCSplitRules(recipients.map((r) => ({ targetAddress: r.account, splitType: 'percentage' as const, value: r.bps / FULL_BPS, label: r.label })));
  for (const r of recipients) {
    if (!Number.isInteger(r.bps)) violations.push(`${r.label || r.account}: a share is a whole number of basis points.`);
    if (r.account && !isValidClassicAddress(r.account)) violations.push(`${r.label || r.account}: ${r.account} is not a valid XRPL classic address (checksum).`);
    if (!r.label.trim()) violations.push(`${r.account}: give the recipient a label.`);
  }
  const sum = recipients.reduce((n, r) => n + r.bps, 0);
  if (recipients.length && sum !== FULL_BPS) violations.push(`Shares add up to ${(sum / 100).toFixed(2)}%; the whole fee must be routed (100%).`);
  return violations;
}

/** Split `units` (a non-negative integer in the currency's smallest unit) across the recipients, exactly. */
export function routeRoyalty(units: number, recipients: readonly RoyaltyRecipient[]): RoyaltyLeg[] {
  if (!Number.isInteger(units) || units < 0) throw new Error('Route whole smallest units (drops or cents).');
  const violations = validateRoyaltyRecipients(recipients);
  if (violations.length) throw new Error(`Royalty recipients invalid: ${violations.join('; ')}`);
  const legs = recipients.map((r) => ({ account: r.account, label: r.label, bps: r.bps, units: Math.floor((units * r.bps) / FULL_BPS) }));
  const remainder = units - legs.reduce((n, l) => n + l.units, 0);
  // Remainder (at most one unit per recipient) goes to the largest share; first listed wins a tie.
  const largest = legs.reduce((best, l, i) => (l.bps > legs[best].bps ? i : best), 0);
  legs[largest].units += remainder;
  return legs;
}
