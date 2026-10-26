/**
 * COPE node crystallized.
 * Node ID: v14-02-00-default-price-sheets
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Genesis price sheets for the cappz Notarizer Agent and cappz Replicator
 * Agent. These seed each app wallet's first PriceSheetPublished TX; later
 * sheets supersede them by effectiveFrom (resolvePriceSheet, newest-wins).
 * Prices are owner-confirmed starting prices, not researched quotes.
 */

import type { PriceSheet } from './priceSheet';

export const NOTARIZER_APP_ROOT = "m/44'/144'/0'/cappz/apps/notarizer";
export const REPLICATOR_APP_ROOT = "m/44'/144'/0'/cappz/apps/replicator";

export const NOTARIZER_GENESIS_SHEET: PriceSheet = {
  sheetId: 'notarizer-2026-09-28',
  appRoot: NOTARIZER_APP_ROOT,
  effectiveFrom: '2026-09-28T00:00:00Z',
  publishedAt: '2026-09-28T00:00:00Z',
  entries: [
    {
      useCase: 'notarization',
      function: 'notarize-standard',
      process: 'fees/fee-charging',
      unit: 'per-document',
      retailCents: 50,
      enterpriseCents: 50,
      minimumCents: 0,
      volumeTiers: [{ atQuantity: 100, unitCents: 25 }],
    },
    {
      useCase: 'notarization',
      function: 'notarize-confidential',
      process: 'fees/fee-charging',
      unit: 'per-document',
      retailCents: 100,
      enterpriseCents: 100,
      minimumCents: 0,
      volumeTiers: [{ atQuantity: 100, unitCents: 50 }],
    },
    {
      useCase: 'notarization',
      function: 'notarize-secret',
      process: 'fees/fee-charging',
      unit: 'per-document',
      retailCents: 250,
      enterpriseCents: 250,
      minimumCents: 0,
      volumeTiers: [{ atQuantity: 100, unitCents: 125 }],
    },
    {
      useCase: 'notarization',
      function: 'notarize-top-secret',
      process: 'fees/fee-charging',
      unit: 'per-document',
      retailCents: 500,
      enterpriseCents: 500,
      minimumCents: 0,
      volumeTiers: [{ atQuantity: 100, unitCents: 250 }],
    },
    {
      useCase: 'notarization',
      function: 'verify-proof',
      process: 'fees/fee-charging',
      unit: 'per-call',
      retailCents: 0,
      enterpriseCents: 0,
      minimumCents: 0,
      volumeTiers: [],
    },
  ],
};

export const REPLICATOR_GENESIS_SHEET: PriceSheet = {
  sheetId: 'replicator-2026-09-28',
  appRoot: REPLICATOR_APP_ROOT,
  effectiveFrom: '2026-09-28T00:00:00Z',
  publishedAt: '2026-09-28T00:00:00Z',
  entries: [
    {
      useCase: 'replication',
      function: 'replica-container',
      process: 'fees/fee-charging',
      unit: 'per-replica-month',
      retailCents: 100,
      enterpriseCents: 100,
      minimumCents: 0,
      volumeTiers: [],
    },
    {
      useCase: 'replication',
      function: 'sync-transfer',
      process: 'fees/fee-charging',
      unit: 'per-mb',
      retailCents: 2,
      enterpriseCents: 1,
      minimumCents: 0,
      volumeTiers: [],
    },
    {
      useCase: 'replication',
      function: 'app-subscription',
      process: 'fees/fee-charging',
      unit: 'per-month',
      retailCents: 1000,
      enterpriseCents: 4000,
      minimumCents: 0,
      volumeTiers: [],
    },
  ],
};

export const GENESIS_PRICE_SHEETS: PriceSheet[] = [NOTARIZER_GENESIS_SHEET, REPLICATOR_GENESIS_SHEET];
