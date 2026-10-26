/**
 * COPE node crystallized.
 * Node ID: v14-02-00-price-sheets
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Price sheets — every app agent publishes a signed PriceSheetPublished TX to
 * its wallet. The newest effective sheet wins; a new sheet only affects fees
 * charged from its effectiveFrom date. No chargeable process runs without a
 * price-sheet entry (build-checked). Every FeeCharged records the sheet id.
 *
 * AP-12: sheet state is derived by replaying PriceSheetPublished TXs, never
 * stored as a flag. AP-17: wallet paths come from TreasuryPaths.ts.
 */

export type FeeUnit = 'per-call' | 'per-document' | 'per-mb' | 'per-session' | 'per-replica-month' | 'per-month';

export interface PriceSheetEntry {
  /** Business use case, e.g. 'notarization', 'replication'. */
  useCase: string;
  /** Function within the use case, e.g. 'notarize', 'sync-transfer'. */
  function: string;
  /** BPMN process id that evidences the work. */
  process: string;
  unit: FeeUnit;
  /** Retail price in USD cents. */
  retailCents: number;
  /** Enterprise price in USD cents. */
  enterpriseCents: number;
  /** Minimum charge in USD cents (0 = none). */
  minimumCents: number;
  /** Volume tiers: at or above `atQuantity`, unit price drops to `unitCents`. */
  volumeTiers: Array<{ atQuantity: number; unitCents: number }>;
}

export interface PriceSheet {
  /** Stable sheet id recorded on every FeeCharged TX. */
  sheetId: string;
  /** App wallet root that published the sheet. */
  appRoot: string;
  /** ISO date from which the sheet applies. */
  effectiveFrom: string;
  /** ISO timestamp of the PriceSheetPublished TX. */
  publishedAt: string;
  entries: PriceSheetEntry[];
}

/** Flat platform base transaction fee: $0.01 per transaction (absorbs the ~$0.00002 XRP cost). */
export const BASE_TX_FEE_CENTS = 1;

/** Platform subscriptions (USD cents / month). */
export const PLATFORM_SUBSCRIPTION = { retailCents: 2500, enterpriseCents: 10000 } as const;

/** Free monthly allowance for public (unsigned) agent callers. */
export const PUBLIC_FREE_TIER = { notarizationsPerMonth: 10, syncMbPerMonth: 50 } as const;

/**
 * Resolve the effective price sheet: the newest sheet whose effectiveFrom is
 * not in the future at `at`. Returns null when no sheet is effective — callers
 * must treat that as "not chargeable" (build check should have caught it).
 */
export function resolvePriceSheet(sheets: PriceSheet[], at: Date = new Date()): PriceSheet | null {
  const effective = sheets
    .filter((s) => new Date(s.effectiveFrom).getTime() <= at.getTime())
    .sort((a, b) => {
      const d = new Date(b.effectiveFrom).getTime() - new Date(a.effectiveFrom).getTime();
      return d !== 0 ? d : b.publishedAt.localeCompare(a.publishedAt);
    });
  return effective[0] ?? null;
}

export interface FeeQuote {
  entry: PriceSheetEntry;
  quantity: number;
  unitCents: number;
  usageCents: number;
  baseTxFeeCents: number;
  totalCents: number;
  sheetId: string;
}

/**
 * Compute a fee for `quantity` units of a chargeable process. Volume tiers
 * apply to the whole quantity (not progressively). The $0.01 base transaction
 * fee is always added on top.
 */
export function computeFee(
  sheet: PriceSheet,
  match: { useCase: string; function: string; process?: string },
  quantity: number,
  tier: 'retail' | 'enterprise' = 'retail',
): FeeQuote | null {
  const entry = sheet.entries.find(
    (e) =>
      e.useCase === match.useCase &&
      e.function === match.function &&
      (!match.process || e.process === match.process),
  );
  if (!entry || quantity <= 0) return null;
  let unitCents = tier === 'enterprise' ? entry.enterpriseCents : entry.retailCents;
  for (const t of [...entry.volumeTiers].sort((a, b) => b.atQuantity - a.atQuantity)) {
    if (quantity >= t.atQuantity) {
      unitCents = t.unitCents;
      break;
    }
  }
  const usageCents = Math.max(unitCents * quantity, entry.minimumCents);
  return {
    entry,
    quantity,
    unitCents,
    usageCents,
    baseTxFeeCents: BASE_TX_FEE_CENTS,
    totalCents: usageCents + BASE_TX_FEE_CENTS,
    sheetId: sheet.sheetId,
  };
}
