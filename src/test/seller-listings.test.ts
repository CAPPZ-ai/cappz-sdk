/** v15-32-05: a seller's own listings and the one way to change them (web page and cappz-market share it). */
import { describe, expect, it } from 'vitest';
import { DEMO_YOU, seedDemoMarket } from '../lib/marketplace/demo';
import * as M from '../lib/marketplace/model';
import { NO_FEES, buildFeeSchedule } from '../lib/marketplace/fees';
import { inventoryReason, planListingChange, sellerListings } from '../lib/marketplace/sellerListings';
import { partyAddress } from '../lib/marketplace/MarketplacePaths';

const amendListing = (l: Parameters<typeof planListingChange>[0], ch: Parameters<typeof planListingChange>[1]) => planListingChange(l, ch).amend!;

const START = '2026-11-01T12:00:00.000Z';
const ID = 'l-agentco-recon';

describe('seller listings', () => {
  it('lists the seller’s listings with orders formed from each; amendments change only future orders', async () => {
    const r = await seedDemoMarket(START);
    r.apply(await buildFeeSchedule('op', r.as('op', 1).at, { marketplace: NO_FEES, securities: NO_FEES, recipients: [], note: 'fees off' }));
    const o = await M.buildOrder(r.state, r.as(DEMO_YOU), ID, 2); r.apply(o.txs);
    const mine = sellerListings(r.state, 'agentco');
    expect(mine.map((x) => x.listing.listingId)).toContain(ID);
    const row = mine.find((x) => x.listing.listingId === ID)!;
    expect(row).toMatchObject({ state: 'open', orders: { total: 1 }, contractIds: [o.contractId] });
    const before = r.state.contracts.find((c) => c.contractId === o.contractId)!.pricePerUnit.amount;
    const plan = planListingChange(row.listing, { price: 30, available: 10, acceptance: { version: 1, criteria: [{ id: 'fmt', kind: 'media-type', anyOf: ['application/pdf'] }] } });
    r.apply(await M.buildListing(r.state, r.as('agentco'), plan.amend!));
    r.apply(await M.buildInventoryAdjust(r.state, r.as('agentco'), ID, plan.inventoryDelta, inventoryReason(row.listing, 10)));
    const after = r.state.listings.find((l) => l.listingId === ID)!;
    expect(after).toMatchObject({ remaining: 10, pricePerUnit: { amount: 30 } });
    expect(sellerListings(r.state, 'agentco').find((x) => x.listing.listingId === ID)!.acceptance?.criteria[0].id).toBe('fmt');
    expect(r.state.contracts.find((c) => c.contractId === o.contractId)!.pricePerUnit.amount).toBe(before);
  });

  it('refuses what the market would refuse, and never reopens a closed listing', async () => {
    const r = await seedDemoMarket(START);
    const l = r.state.listings.find((x) => x.listingId === ID)!;
    expect(() => amendListing(l, { price: 0 })).toThrow(/Price/);
    expect(() => amendListing(l, { title: ' ' })).toThrow(/title/);
    expect(() => amendListing(l, { endpoint: 'http://x' })).toThrow(/https/);
    expect(() => amendListing(l, { acceptance: { version: 1, criteria: [] } })).toThrow(/Acceptance/);
    r.apply(await M.buildWithdrawListing(r.state, r.as('agentco'), ID));
    const closed = r.state.listings.find((x) => x.listingId === ID)!;
    expect(sellerListings(r.state, 'agentco').find((x) => x.listing.listingId === ID)).toMatchObject({ state: 'closed', closed: { by: 'seller' } });
    expect(() => amendListing(closed, { price: 5 })).toThrow(/closed/);
  });

  it('pauses at 0 and restocks through the inventory journal, never rewriting the listing; only the seller moves inventory', async () => {
    const r = await seedDemoMarket(START);
    const l = r.state.listings.find((x) => x.listingId === ID)!;
    const pause = planListingChange(l, { available: 0 });
    expect(pause.amend).toBeNull();
    r.apply(await M.buildInventoryAdjust(r.state, r.as('agentco'), ID, pause.inventoryDelta, inventoryReason(l, 0)));
    expect(sellerListings(r.state, 'agentco').find((x) => x.listing.listingId === ID)!.state).toBe('sold-out');
    const paused = r.state.listings.find((x) => x.listingId === ID)!;
    const [restock] = await M.buildInventoryAdjust(r.state, r.as('agentco'), ID, planListingChange(paused, { available: 7 }).inventoryDelta, inventoryReason(paused, 7));
    r.apply([{ ...restock, sourceAddress: partyAddress('north-star-grain') }]);
    expect(r.state.listings.find((x) => x.listingId === ID)!.remaining).toBe(0);
    r.apply([restock]);
    expect(r.state.listings.find((x) => x.listingId === ID)).toMatchObject({ remaining: 7, open: true, quantity: l.quantity });
  });
});
