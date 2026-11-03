/**
 * COPE node crystallized. Node ID: v14-19-00-marketplace-matching.
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Deterministic buyer ↔ supplier matching. Every score is a weighted sum of
 * named components with a plain-language reason for each, so a person (or
 * an agent) can see why a supplier was suggested. Category identity comes
 * from catalog ids, geography from region codes — never from parsing text.
 */
import { categoryOf, placeMiles, rootCategoryOf, type Place } from './catalog';
import type { ListingView, MarketState, RequestView } from './replay';
import type { PartyProfile } from './types';

export interface Match { kind: 'listing' | 'party' | 'request'; id: string; partyId: string; title: string; score: number; reasons: string[] }

const W = { category: 0.35, distance: 0.2, quantity: 0.15, price: 0.15, timing: 0.1, reputation: 0.05 };
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

function categoryFit(a: string, b: string): number { return a === b ? 1 : rootCategoryOf(a) === rootCategoryOf(b) ? 0.5 : 0; }
function distanceFit(a: Place, b: Place, radius: number | null): { fit: number; miles: number | null } {
  const miles = placeMiles(a, b);
  if (miles === null) return { fit: 0.3, miles };
  if (radius !== null && miles > radius) return { fit: 0, miles };
  return { fit: Math.max(0, 1 - miles / Math.max(radius ?? 1500, 1)), miles };
}
const repFit = (state: MarketState, partyId: string) => { const r = state.reputation.get(partyId); return r?.average ? r.average / 5 : 0.6; };

/** Who could fill this request: open listings first, then parties able to produce it (including new plantings). */
export function matchSuppliers(state: MarketState, r: RequestView, now: string, limit = 8): Match[] {
  const out: Match[] = [];
  const need = r.quantity - r.awardedQuantity;
  const daysLeft = days(now, r.neededBy);
  for (const l of state.listings) {
    if (!l.open || l.remaining <= 0 || l.sellerId === r.buyerId) continue;
    const cat = categoryFit(l.categoryId, r.categoryId); if (!cat) continue;
    const d = distanceFit(l, r, r.deliveryRadiusMiles); if (!d.fit && r.deliveryRadiusMiles !== null) continue;
    const qty = l.unit === r.unit ? Math.min(1, l.remaining / need) : 0.3;
    const price = !r.maxPricePerUnit || l.unit !== r.unit || l.pricePerUnit.currency !== r.maxPricePerUnit.currency ? 0.6 : l.pricePerUnit.amount <= r.maxPricePerUnit.amount ? 1 : Math.max(0, 1 - (l.pricePerUnit.amount - r.maxPricePerUnit.amount) / r.maxPricePerUnit.amount);
    const timing = l.leadDays <= daysLeft ? 1 : 0;
    const score = W.category * cat + W.distance * d.fit + W.quantity * qty + W.price * price + W.timing * timing + W.reputation * repFit(state, l.sellerId);
    out.push({ kind: 'listing', id: l.listingId, partyId: l.sellerId, title: l.title, score, reasons: [
      cat === 1 ? 'Same category' : 'Related category', d.miles === null ? 'Distance unknown' : `${d.miles} mi away`,
      l.unit === r.unit ? `${l.remaining} ${l.unit} available (need ${need})` : `Sold in ${l.unit}, you asked in ${r.unit}`,
      price === 1 ? 'Within your price' : price === 0.6 ? 'Price not comparable — ask' : 'Above your price',
      timing ? `Ready in ${l.leadDays} days` : `Needs ${l.leadDays} days; you need it in ${daysLeft}`,
    ] });
  }
  const listed = new Set(out.map((m) => m.partyId));
  const lead = categoryOf(r.categoryId)?.typicalLeadDays;
  for (const p of state.parties.values()) {
    if (p.partyId === r.buyerId || listed.has(p.partyId)) continue;
    const cat = Math.max(0, ...p.capabilities.categories.map((c) => categoryFit(c, r.categoryId)));
    const canGrow = r.allowNewPlanting && p.capabilities.canPlantNew && rootCategoryOf(r.categoryId) === 'crops';
    if (!cat && !canGrow) continue;
    const d = distanceFit(p, r, r.deliveryRadiusMiles); if (!d.fit && r.deliveryRadiusMiles !== null) continue;
    const timing = !lead ? 0.6 : daysLeft >= lead[0] ? 1 : 0;
    const score = W.category * (cat || 0.4) + W.distance * d.fit + W.quantity * 0.5 + W.price * 0.6 + W.timing * timing + W.reputation * repFit(state, p.partyId);
    out.push({ kind: 'party', id: p.partyId, partyId: p.partyId, title: p.name, score, reasons: [
      cat === 1 ? 'Already supplies this' : cat ? 'Supplies related products' : 'Can plant a new crop', d.miles === null ? 'Distance unknown' : `${d.miles} mi away`,
      p.capabilities.acres ? `${p.capabilities.acres} acres` : 'Capacity not stated',
      !lead ? 'No growing window needed' : timing ? `Time to grow (${lead[0]}–${lead[1]} days typical)` : `Too little time to grow (${daysLeft} days; ${lead[0]}+ typical)`,
    ] });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit).map((m) => ({ ...m, score: Math.round(m.score * 100) / 100 }));
}

/** Which open requests a supplier could fill — the seller's "find demand" view. */
export function matchDemand(state: MarketState, supplier: PartyProfile, listings: ListingView[], now: string, limit = 8): Match[] {
  const out: Match[] = [];
  for (const r of state.requests) {
    if (!r.open || r.buyerId === supplier.partyId) continue;
    const own = listings.filter((l) => l.sellerId === supplier.partyId && l.open);
    const cat = Math.max(0, ...supplier.capabilities.categories.map((c) => categoryFit(c, r.categoryId)), ...own.map((l) => categoryFit(l.categoryId, r.categoryId)));
    const canGrow = r.allowNewPlanting && supplier.capabilities.canPlantNew && rootCategoryOf(r.categoryId) === 'crops';
    if (!cat && !canGrow) continue;
    const d = distanceFit(supplier, r, r.deliveryRadiusMiles); if (!d.fit && r.deliveryRadiusMiles !== null) continue;
    const value = r.maxPricePerUnit ? r.maxPricePerUnit.amount * (r.quantity - r.awardedQuantity) : null;
    const competing = r.offers.filter((o) => !o.withdrawn).length;
    const score = W.category * (cat || 0.4) + W.distance * d.fit + 0.25 * (1 / (1 + competing)) + 0.15 * (days(now, r.neededBy) > 0 ? 1 : 0);
    out.push({ kind: 'request', id: r.requestId, partyId: r.buyerId, title: r.title, score: Math.round(score * 100) / 100, reasons: [
      cat === 1 ? 'You supply this' : cat ? 'Related to what you supply' : 'New planting welcome', d.miles === null ? 'Distance unknown' : `${d.miles} mi away`,
      value ? `Up to ${value.toLocaleString('en-US')} ${r.maxPricePerUnit!.currency}` : 'Open price', `${competing} bid${competing === 1 ? '' : 's'} so far`, `Needed by ${r.neededBy}`,
    ] });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
