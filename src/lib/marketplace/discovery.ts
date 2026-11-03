/**
 * COPE node crystallized. Node ID: v14-19-00-market-discovery.
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Market discovery: lacuna whitespace analysis over what the marketplace
 * already supplies, pulled toward what buyers are asking for.
 *
 *   entities  = live supply (open listings), on four numeric facets:
 *               product (categorical over leaf categories), geography (lat, lon),
 *               economics (log price per unit, log typical order value),
 *               operations (deal kind, lead days)
 *   demand    = unmet open requests near each entity (same category, distance-decayed, value-weighted)
 *   voids     = interior empty regions between valuable supply → decoded into a
 *               business concept (category mix, region, price band, deal kind, lead time)
 *
 * Each concept is then checked against the marketplace's own evidence:
 * the open requests it could serve, the competitors that bound it, and what
 * is available to start it (equipment, inputs, services). A concept is a
 * hypothesis evaluated against marketplace demand — not market research,
 * and not a forecast. Runs in the browser; deterministic for the same data.
 */
import { CATEGORIES, REGIONS, categoryOf, countyOf, leafCategories, placeLabel, placeMiles, rootCategoryOf, type DealKind, type Place } from './catalog';
import geo from './geo/usCounties.json';
import type { MarketState, RequestView } from './replay';
import { projectWhitespace } from '../lacuna/whitespaceMap';
import type { Lacuna, LacunaEntity, LacunaSchema, NumericAxis } from '../lacuna/types';

const KINDS: DealKind[] = ['sale', 'rent', 'service', 'production-contract'];
const LEAVES = leafCategories().map((c) => c.id);
export const DISCOVERY_FACETS: LacunaSchema['facets'] = [
  { id: 'product', name: 'Product', description: 'What is offered (leaf catalog category).', default_weight: 0.4 },
  { id: 'geography', name: 'Geography', description: 'Where it is offered (region centroid).', default_weight: 0.25 },
  { id: 'economics', name: 'Economics', description: 'Price per unit and typical order value (log scale).', default_weight: 0.2 },
  { id: 'operations', name: 'Operations', description: 'Deal kind and lead time.', default_weight: 0.15 },
];
const WEIGHTS = Object.fromEntries(DISCOVERY_FACETS.map((f) => [f.id, f.default_weight]));
const AXES: Record<string, NumericAxis[]> = {
  product: [{ kind: 'categorical', id: 'category', options: LEAVES }],
  geography: [{ kind: 'scalar', id: 'lat', min: 24, max: 50 }, { kind: 'scalar', id: 'lon', min: -125, max: -66 }],
  economics: [{ kind: 'scalar', id: 'logPrice', min: -1, max: 5 }, { kind: 'scalar', id: 'logOrder', min: 1, max: 7 }],
  operations: [{ kind: 'categorical', id: 'kind', options: KINDS }, { kind: 'scalar', id: 'leadDays', min: 0, max: 365 }],
};
export const DISCOVERY_CONFIG = { top_k: 8, min_radius: 0.004, min_void_separation: 0.01, anchor_distance_window: [0.004, 1.0] as [number, number] };
const log10 = (x: number) => Math.log10(Math.max(x, 1e-6));
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

export interface DiscoveryFilters { region?: string; rootCategory?: string; budget?: number }

export interface BusinessConcept {
  id: string; rank: number;
  /** Plain description of the business. */
  title: string;
  categoryMix: Array<{ categoryId: string; label: string; weight: number }>;
  categoryId: string; region: string; county?: string; regionLabel: string; kind: DealKind;
  pricePerUnit: number; typicalOrderValue: number; leadDays: number;
  /** lacuna's own measures. */
  radius: number; opportunityScore: number;
  /** Marketplace evidence. */
  demand: Array<{ requestId: string; title: string; buyerId: string; miles: number | null; value: number | null; quantity: number; unit: string }>;
  addressableValue: number;
  competitors: Array<{ listingId: string; title: string; distance: number; weight: number }>;
  marketScore: number;
  startup: { equipment: Array<{ listingId: string; title: string }>; inputs: Array<{ listingId: string; title: string }>; services: Array<{ listingId: string; title: string }>; steps: string[] };
  x: number; y: number; mapRadius: number;
}

export interface MarketDiscovery {
  engine: 'lacuna-wasm' | 'unavailable'; version: string | null; artifactSha256: string | null; ranAt: string;
  filters: DiscoveryFilters; note: string;
  supply: Array<{ listingId: string; title: string; categoryId: string; region: string; place: string; x: number; y: number; demand: number; gain: number; sellerId: string }>;
  openDemand: Array<{ requestId: string; title: string; categoryId: string; region: string; x: number; y: number; value: number | null }>;
  concepts: BusinessConcept[];
  fidelity: number;
}

function vectorsOf(l: Lacuna, cat: string, place: Place, price: number, order: number, kind: DealKind, lead: number): Record<string, number[]> {
  const r = countyOf(place.county) ?? REGIONS[place.region] ?? { lat: 39, lon: -95 };
  return {
    product: l.encode(AXES.product, [cat]),
    geography: l.encode(AXES.geography, [r.lat, r.lon]),
    economics: l.encode(AXES.economics, [clamp(log10(price), -1, 5), clamp(log10(order), 1, 7)]),
    operations: l.encode(AXES.operations, [kind, clamp(lead, 0, 365)]),
  };
}

const requestValue = (r: RequestView) => (r.maxPricePerUnit ? r.maxPricePerUnit.amount * Math.max(0, r.quantity - r.awardedQuantity) : null);
/** Unmet demand pulling on an offering at (category, region): value-weighted, distance-decayed, same leaf counts fully and same root half. */
function demandNear(state: MarketState, cat: string, place: Place): number {
  let d = 0;
  for (const r of state.requests) {
    if (!r.open) continue;
    const fit = r.categoryId === cat ? 1 : rootCategoryOf(r.categoryId) === rootCategoryOf(cat) ? 0.5 : 0; if (!fit) continue;
    const miles = placeMiles(place, r) ?? 800;
    d += fit * Math.exp(-miles / 600) * (1 + log10(requestValue(r) ?? 1000));
  }
  return d;
}

/** The county whose centroid is nearest to a decoded point (a concept is placed at county resolution). */
function nearestPlace(lat: number, lon: number): Place {
  let best: Place = { region: 'IA' }, bd = Infinity;
  const k = Math.cos((lat * Math.PI) / 180);
  for (const [fips, c] of Object.entries((geo as unknown as { counties: Record<string, [string, string, number, number]> }).counties)) { const d = (c[2] - lat) ** 2 + ((c[3] - lon) * k) ** 2; if (d < bd) { bd = d; best = { region: c[0], county: fips }; } }
  return best;
}

const KIND_WORD: Record<DealKind, string> = { sale: 'supplier', rent: 'rental', service: 'service', 'production-contract': 'contract grower' };

export function runMarketDiscovery(state: MarketState, lacuna: Lacuna | null, ranAt: string, filters: DiscoveryFilters = {}): MarketDiscovery {
  const base = { version: lacuna?.version ?? null, artifactSha256: lacuna?.sha256 ?? null, ranAt, filters, fidelity: 1 };
  const supply = state.listings.filter((l) => l.open && l.remaining > 0 && (!filters.rootCategory || rootCategoryOf(l.categoryId) === filters.rootCategory));
  if (!lacuna) return { ...base, engine: 'unavailable', note: 'lacuna not loaded; market discovery needs the in-browser lacuna module.', supply: [], openDemand: [], concepts: [] };
  if (supply.length < 4) return { ...base, engine: 'lacuna-wasm', note: `Only ${supply.length} open listings match — at least 4 are needed to find whitespace between them.`, supply: [], openDemand: [], concepts: [] };

  const demand = supply.map((l) => demandNear(state, l.categoryId, l));
  const maxD = Math.max(...demand, 1e-9);
  const entities: LacunaEntity[] = supply.map((l, i) => ({
    id: l.listingId, name: l.title, summary: l.categoryId, tags: [l.categoryId, l.kind], facets: {},
    vectors: vectorsOf(lacuna, l.categoryId, l, l.pricePerUnit.amount, l.pricePerUnit.amount * Math.max(1, Math.min(l.quantity, 1000)), l.kind, l.leadDays),
    demand_signal: 1 + 10 * (demand[i] / maxD),
    quality_signal: (state.reputation.get(l.sellerId)?.average ?? 3.5) / 5,
    metadata: null,
  }));
  const schema: LacunaSchema = { domain_id: 'cappz-marketplace', title: 'CAPPZ marketplace supply', description: 'Open listings by product, geography, economics and operations.', facets: DISCOVERY_FACETS, demand_metric_name: 'unmet_demand_nearby', quality_metric_name: 'seller_reputation' };
  const voids = lacuna.findVoids(schema, entities, DISCOVERY_CONFIG);
  const openReqs = state.requests.filter((r) => r.open);
  const reqVectors = openReqs.map((r) => vectorsOf(lacuna, LEAVES.includes(r.categoryId) ? r.categoryId : LEAVES.find((c) => c.startsWith(r.categoryId)) ?? LEAVES[0], r, r.maxPricePerUnit?.amount ?? 10, requestValue(r) ?? 1000, r.contractType === 'production-contract' ? 'production-contract' : 'sale', Math.max(0, Math.round((Date.parse(r.neededBy) - Date.parse(ranAt)) / 86_400_000))));
  const proj = projectWhitespace([...entities.map((e) => e.vectors), ...voids.map((v) => v.center), ...reqVectors], WEIGHTS);
  const at = (i: number) => proj.coords[i];

  const concepts: BusinessConcept[] = voids.map((v, j) => {
    const prod = lacuna.decode(AXES.product, v.center.product)[0];
    const geo = lacuna.decode(AXES.geography, v.center.geography);
    const eco = lacuna.decode(AXES.economics, v.center.economics);
    const ops = lacuna.decode(AXES.operations, v.center.operations);
    const weights = prod.kind === 'categorical' ? prod.weights : [];
    const mix = weights.map((w, i) => ({ categoryId: LEAVES[i], label: categoryOf(LEAVES[i])!.label, weight: Math.round(w * 100) / 100 })).filter((m) => m.weight >= 0.1).sort((a, b) => b.weight - a.weight);
    const categoryId = prod.kind === 'categorical' ? prod.choice : mix[0].categoryId;
    const lat = geo[0].kind === 'scalar' ? geo[0].value : 39, lon = geo[1].kind === 'scalar' ? geo[1].value : -95;
    const place = nearestPlace(lat, lon); const region = place.region;
    const kind = (ops[0].kind === 'categorical' ? ops[0].choice : 'sale') as DealKind;
    const leadDays = Math.round(ops[1].kind === 'scalar' ? ops[1].value : 30);
    const pricePerUnit = Math.round(10 ** (eco[0].kind === 'scalar' ? eco[0].value : 1) * 100) / 100;
    const typicalOrderValue = Math.round(10 ** (eco[1].kind === 'scalar' ? eco[1].value : 3));
    // Demand fit leans on the dominant category; the bridged categories count at half weight.
    const fitOf = (catId: string) => (catId === categoryId ? 1 : 0) + 0.5 * mix.filter((m) => m.categoryId !== categoryId).reduce((t, m) => t + m.weight * (catId === m.categoryId ? 1 : 0), 0) + (catId !== categoryId && rootCategoryOf(catId) === rootCategoryOf(categoryId) ? 0.3 : 0);
    const demandHere = openReqs.map((r) => ({ r, fit: fitOf(r.categoryId), miles: placeMiles(place, r) }))
      .filter((x) => x.fit >= 0.3 && (x.miles === null || x.miles <= (x.r.deliveryRadiusMiles ?? 1200)))
      .sort((a, b) => (requestValue(b.r) ?? 0) * b.fit - (requestValue(a.r) ?? 0) * a.fit)
      .map(({ r, miles }) => ({ requestId: r.requestId, title: r.title, buyerId: r.buyerId, miles, value: requestValue(r), quantity: r.quantity - r.awardedQuantity, unit: r.unit }));
    const addressableValue = Math.round(demandHere.reduce((s, d) => s + (d.value ?? 0), 0));
    const competitors = v.boundary_neighbors.map((b) => ({ listingId: b.entity_id, title: b.name, distance: b.distance, weight: b.simplex_weight }));
    const rootCat = rootCategoryOf(categoryId);
    const pick = (root: string, n = 3) => state.listings.filter((l) => l.open && rootCategoryOf(l.categoryId) === root && (placeMiles(l, place) ?? 9999) <= 1500).slice(0, n).map((l) => ({ listingId: l.listingId, title: l.title }));
    const cat = categoryOf(categoryId)!;
    const bridges = mix.filter((m) => m.categoryId !== categoryId).map((m) => m.label.toLowerCase());
    const title = `${cat.label} ${KIND_WORD[kind]} near ${placeLabel(place)}${bridges.length ? ` (bridging ${bridges.join(' and ')})` : ''}`;
    const steps = [
      `Create your profile as a ${kind === 'service' ? 'service provider' : kind === 'rent' ? 'equipment dealer' : rootCat === 'crops' ? 'farmer' : 'supplier'} in ${REGIONS[region].label}.`,
      demandHere.length ? `Bid on ${demandHere.length} open request${demandHere.length > 1 ? 's' : ''} this concept could serve (${addressableValue ? `up to ${addressableValue.toLocaleString('en-US')} USD` : 'open price'}).` : 'Publish a listing so buyers can find you; there is no open request here yet, which is also a signal.',
      kind === 'production-contract' || rootCat === 'crops' ? 'Offer a production contract: the buyer’s commitment and planting milestones fund your inputs before harvest.' : 'Start with a small listing and adjust price from the first orders.',
      'Line up what you need from the marketplace: equipment, inputs and services below.',
      'Optionally tokenize stored product or equipment as a receipt token to use it as collateral or sell it forward.',
    ];
    return {
      id: v.void_id, rank: v.rank, title, categoryMix: mix, categoryId, region, ...(place.county ? { county: place.county } : {}), regionLabel: placeLabel(place), kind, pricePerUnit, typicalOrderValue, leadDays,
      radius: v.radius, opportunityScore: v.opportunity_score, demand: demandHere.slice(0, 6), addressableValue, competitors,
      marketScore: Math.round(((addressableValue || 1) / (1 + competitors.length)) * (0.5 + v.opportunity_score)),
      startup: { equipment: pick('equipment'), inputs: pick('inputs'), services: pick('services'), steps },
      ...at(entities.length + j), mapRadius: proj.mapRadius(v.radius),
    };
  }).filter((c) => (!filters.region || (placeMiles(c, { region: filters.region }) ?? 9999) <= 600) && (!filters.budget || c.typicalOrderValue <= filters.budget * 2));

  return {
    ...base, engine: 'lacuna-wasm', fidelity: proj.fidelity,
    note: `${voids.length} interior voids among ${supply.length} open listings; ${concepts.length} business concepts after filters, each checked against ${openReqs.length} open requests. Hypotheses evaluated against marketplace demand — not market research.`,
    supply: supply.map((l, i) => ({ listingId: l.listingId, title: l.title, categoryId: l.categoryId, region: l.region, place: placeLabel(l), ...at(i), demand: Math.round(demand[i] * 100) / 100, gain: Math.round((demand[i] / maxD) * 1000) / 1000, sellerId: l.sellerId })),
    openDemand: openReqs.map((r, k) => ({ requestId: r.requestId, title: r.title, categoryId: r.categoryId, region: r.region, ...at(entities.length + voids.length + k), value: requestValue(r) })),
    concepts: concepts.sort((a, b) => b.marketScore - a.marketScore).map((c, i) => ({ ...c, rank: i + 1 })),
  };
}

export const CATEGORY_LABELS = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label]));
