/** v15-32-04: who may close or change a listing — its seller, or a marketplace operator with a recorded reason. */
import { describe, expect, it } from 'vitest';
import { seedDemoMarket } from '../lib/marketplace/demo';
import * as M from '../lib/marketplace/model';
import { operatorAddress, partyAddress } from '../lib/marketplace/MarketplacePaths';

const START = '2026-11-01T12:00:00.000Z';
const LISTING = 'l-agentco-recon';

describe('withdrawing listings', () => {
  it('the seller closes their own listing', async () => {
    const r = await seedDemoMarket(START);
    r.apply(await M.buildWithdrawListing(r.state, r.as('agentco'), LISTING));
    expect(r.state.listings.find((l) => l.listingId === LISTING)).toMatchObject({ open: false, closed: { by: 'seller' } });
  });

  it('an operator closes any listing, with the reason recorded; a party address cannot pose as one', async () => {
    const r = await seedDemoMarket(START);
    await expect(M.buildOperatorWithdrawListing(r.state, partyAddress('north-star-grain'), LISTING, 'spam')).rejects.toThrow(/Only a marketplace operator/);
    await expect(M.buildOperatorWithdrawListing(r.state, operatorAddress('demo-admin'), LISTING, '  ')).rejects.toThrow(/Say why/);
    r.apply(await M.buildOperatorWithdrawListing(r.state, operatorAddress('demo-admin'), LISTING, 'Test listing; flow validated'));
    const l = r.state.listings.find((x) => x.listingId === LISTING)!;
    expect(l).toMatchObject({ open: false, closed: { by: 'operator', operator: operatorAddress('demo-admin'), reason: 'Test listing; flow validated' } });
    await expect(M.buildOperatorWithdrawListing(r.state, operatorAddress('demo-admin'), LISTING, 'again')).rejects.toThrow(/already closed/);
  });

  it('replay ignores a withdrawal or an amendment written by another party', async () => {
    const r = await seedDemoMarket(START);
    const [w] = await M.buildWithdrawListing(r.state, r.as('agentco'), LISTING);
    r.apply([{ ...w, sourceAddress: partyAddress('north-star-grain') }]);
    expect(r.state.listings.find((l) => l.listingId === LISTING)!.open).toBe(true);
    const l = r.state.listings.find((x) => x.listingId === LISTING)!;
    const [amend] = await M.buildListing(r.state, r.as('agentco'), { ...l, title: 'Hijacked', pricePerUnit: { amount: 1, currency: l.pricePerUnit.currency } });
    r.apply([{ ...amend, sourceAddress: partyAddress('north-star-grain') }]);
    const forged = { ...amend, sourceAddress: partyAddress('north-star-grain'), payload: { ...amend.payload, listing: { ...l, sellerId: 'north-star-grain', title: 'Hijacked' } } };
    r.apply([forged]);
    expect(r.state.listings.find((x) => x.listingId === LISTING)).toMatchObject({ title: l.title, sellerId: 'agentco' });
  });
});
