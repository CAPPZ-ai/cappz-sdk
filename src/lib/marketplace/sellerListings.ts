/**
 * COPE node crystallized. Node ID: v15-32-05-seller-listings.
 * Provenance: m/44'/144'/100'/principles/cope/v1#marketplace
 *
 * A seller's own listings, and the one way to change them — shared by the web
 * app's "My listings" page and `cappz-market listings | update | withdraw`, so
 * a person and their agent see and do exactly the same thing.
 *
 * Views are replayed (orders come from contracts whose source is the listing,
 * never from labels). A change is an amendment of the listing (ContentAmended
 * through buildListing, verb marketplace.listing.publish): it applies to
 * orders placed after it; contracts already formed keep their terms.
 */
import type { MarketState, ListingView } from './replay';
import type { ListingContent } from './types';
import { milestonePlanPresets } from './rules';
import { acceptanceProblems, type AcceptanceSpec } from './acceptance';

export interface SellerListing {
  listing: ListingView;
  state: 'open' | 'sold-out' | 'closed';
  /** Who closed it and why, when closed. */
  closed: ListingView['closed'] | null;
  orders: { total: number; inProgress: number; completed: number; disputed: number };
  /** Contracts formed from this listing, newest first. */
  contractIds: string[];
  acceptance: AcceptanceSpec | null;
}

/** The seller's listings, open ones first, each with the orders formed from it. */
export function sellerListings(state: MarketState, partyId: string): SellerListing[] {
  return state.listings.filter((l) => l.sellerId === partyId).map((l) => {
    const cs = state.contracts.filter((c) => c.source.kind === 'listing' && c.source.listingId === l.listingId);
    const delivery = l.milestones?.find((m) => m.delivery) ?? l.milestones?.at(-1);
    return {
      listing: l,
      state: !l.open ? 'closed' as const : l.remaining <= 0 ? 'sold-out' as const : 'open' as const,
      closed: l.closed ?? null,
      orders: { total: cs.length, inProgress: cs.filter((c) => c.state === 'in-progress' || c.state === 'awaiting-funding').length, completed: cs.filter((c) => c.state === 'completed').length, disputed: cs.filter((c) => c.state === 'disputed').length },
      contractIds: cs.map((c) => c.contractId).reverse(),
      acceptance: delivery?.acceptance ?? null,
    };
  }).sort((a, b) => (a.state === 'closed' ? 1 : 0) - (b.state === 'closed' ? 1 : 0) || b.listing.publishedAt.localeCompare(a.listing.publishedAt));
}

/** What a seller may change. `available` is what is left to sell now (quantity is adjusted to reach it). */
export interface ListingChanges {
  title?: string;
  description?: string;
  price?: number;
  available?: number;
  leadDays?: number;
  endpoint?: string | null;
  /** New acceptance criteria for future orders (null removes them). */
  acceptance?: AcceptanceSpec | null;
}

/** The amended listing content; throws a plain refusal for anything the market would refuse. Pure. */
export function amendListing(l: ListingView, ch: ListingChanges): ListingContent {
  if (!l.open) throw new Error('This listing is closed. List it again with sell (a closed listing is never reopened).');
  const { open: _o, remaining: _r, publishedAt: _p, closed: _c, ...content } = l;
  const next: ListingContent = { ...content, attributes: { ...content.attributes } };
  if (ch.title !== undefined) { if (!ch.title.trim()) throw new Error('A title cannot be empty.'); next.title = ch.title.trim(); }
  if (ch.description !== undefined) next.description = ch.description.trim() || next.title;
  if (ch.price !== undefined) { if (!(ch.price > 0)) throw new Error('Price must be more than zero.'); next.pricePerUnit = { ...next.pricePerUnit, amount: ch.price }; }
  if (ch.available !== undefined) {
    if (!(ch.available >= 0) || !Number.isFinite(ch.available)) throw new Error('Available must be zero or more.');
    next.quantity = l.quantity + (ch.available - l.remaining);
    if (!(next.quantity > 0)) throw new Error('More units are already ordered than that leaves; to stop selling, withdraw the listing.');
  }
  if (ch.leadDays !== undefined) { if (!(ch.leadDays >= 0)) throw new Error('Lead days must be zero or more.'); next.leadDays = Math.round(ch.leadDays); }
  if (ch.endpoint !== undefined) {
    if (ch.endpoint === null || ch.endpoint === '') delete next.attributes.endpoint;
    else if (!/^https:\/\//.test(ch.endpoint)) throw new Error('The endpoint must be an https address buyers can reach.');
    else next.attributes.endpoint = ch.endpoint;
  }
  if (ch.acceptance !== undefined) {
    if (next.metered) throw new Error('A metered listing has no stages to accept.');
    if (ch.acceptance === null) next.milestones = next.milestones?.map(({ acceptance: _a, ...m }) => m);
    else {
      const p = acceptanceProblems(ch.acceptance);
      if (p.length) throw new Error(`Acceptance criteria rejected: ${p.join(' ')}`);
      const plan = next.milestones ?? milestonePlanPresets(next.leadDays)['on-delivery'].plan;
      next.milestones = plan.map((m, i) => (m.delivery || i === plan.length - 1 ? { ...m, acceptance: ch.acceptance! } : m));
    }
  }
  return next;
}
