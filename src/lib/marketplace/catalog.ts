/**
 * COPE node crystallized. Node ID: v14-19-00-marketplace-catalog.
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * The marketplace catalog ontology (PTW content). Every listing and request
 * points at a category by id (an explicit signal — labels are display only).
 * The tree is open-ended on purpose: "anything someone might want" is a
 * category plus a free description, so a crop nobody grows yet is just a
 * request in `crops/specialty` with a new variety name.
 */
export type DealKind = 'sale' | 'rent' | 'service' | 'production-contract';

export interface Category {
  id: string;
  label: string;
  parent: string | null;
  /** Units offered in this category, first is the default. */
  units: string[];
  kinds: DealKind[];
  /** Spec fields a wizard asks for (free text, stored as attributes). */
  specFields: Array<{ key: string; label: string; placeholder?: string }>;
  /** Typical days from commitment to delivery when something must be produced (planting to harvest), for feasibility checks. */
  typicalLeadDays?: [number, number];
  /** Example items, shown as wizard suggestions. */
  examples: string[];
  /** Whether a receipt token can represent an item in this category. */
  tokenizable?: boolean;
}

const c = (id: string, label: string, parent: string | null, rest: Partial<Category>): Category => ({ id, label, parent, units: ['each'], kinds: ['sale'], specFields: [], examples: [], ...rest });

export const CATEGORIES: Category[] = [
  c('crops', 'Crops & produce', null, { units: ['lb', 'kg', 'bu', 'ton'], kinds: ['sale', 'production-contract'] }),
  c('crops/grains', 'Grains & oilseeds', 'crops', { units: ['bu', 'ton', 'lb'], kinds: ['sale', 'production-contract'], typicalLeadDays: [100, 160], examples: ['Yellow corn #2', 'Food-grade soybeans', 'Hard red winter wheat', 'Malting barley'], specFields: [{ key: 'grade', label: 'Grade / quality', placeholder: 'e.g. #2 yellow, ≤15% moisture' }, { key: 'variety', label: 'Variety' }], tokenizable: true }),
  c('crops/specialty', 'Herbs, flowers & specialty crops', 'crops', { units: ['lb', 'kg', 'stems', 'bunches'], kinds: ['sale', 'production-contract'], typicalLeadDays: [60, 200], examples: ['Dried lavender (Lavandula angustifolia)', 'Fresh holy basil', 'Saffron crocus', 'Heirloom dahlias', 'Edible flowers mix', 'Hops'], specFields: [{ key: 'variety', label: 'Species / variety', placeholder: 'e.g. Lavandula × intermedia Grosso' }, { key: 'form', label: 'Form', placeholder: 'fresh, dried, oil, seed' }, { key: 'certification', label: 'Certification', placeholder: 'organic, GAP, none' }], tokenizable: true }),
  c('crops/produce', 'Fruits & vegetables', 'crops', { units: ['lb', 'kg', 'cases'], kinds: ['sale', 'production-contract'], typicalLeadDays: [50, 150], examples: ['Heirloom tomatoes', 'Sweet corn', 'Microgreens'], specFields: [{ key: 'variety', label: 'Variety' }, { key: 'pack', label: 'Pack / case size' }] }),
  c('crops/livestock', 'Livestock & animal products', 'crops', { units: ['head', 'lb', 'dozen'], kinds: ['sale', 'production-contract'], typicalLeadDays: [30, 400], examples: ['Pasture-raised eggs', 'Grass-fed beef', 'Honey'], specFields: [{ key: 'breed', label: 'Breed / type' }] }),
  c('inputs', 'Seed, fertilizer & inputs', null, { units: ['bag', 'ton', 'gal', 'lb'], kinds: ['sale'], examples: ['Seed corn', 'Lavender plugs', 'Compost', 'Biological inoculant'], specFields: [{ key: 'product', label: 'Product / brand' }] }),
  c('equipment', 'Equipment', null, { units: ['each', 'day', 'acre'], kinds: ['sale', 'rent'], examples: ['Tractor 100 hp', 'Combine', 'Planter 16-row', 'Sprayer', 'Drip irrigation kit', 'Flower dryer', 'Essential-oil still'], specFields: [{ key: 'make', label: 'Make / model' }, { key: 'year', label: 'Year' }, { key: 'hours', label: 'Hours' }], tokenizable: true }),
  c('services', 'Services & custom hire', null, { units: ['acre', 'hour', 'job', 'mile'], kinds: ['service'], examples: ['Custom planting', 'Custom harvesting', 'Spraying', 'Trucking', 'Grain storage', 'Agronomy advice', 'Plant disease diagnosis', 'Drying & processing'], specFields: [{ key: 'scope', label: 'Scope of work' }, { key: 'equipment', label: 'Equipment used' }] }),
  c('land', 'Land & storage', null, { units: ['acre-year', 'bu-month', 'sq ft-month'], kinds: ['rent'], examples: ['Cropland lease', 'Bin space', 'Cold storage'], specFields: [{ key: 'location', label: 'Location detail' }], tokenizable: true }),
  c('digital', 'Data & knowledge', null, { units: ['license', 'query', 'month'], kinds: ['sale', 'service'], examples: ['Plant knowledge graph', 'Yield dataset', 'Agronomy course'], specFields: [{ key: 'format', label: 'Format / access' }] }),
  c('relay', 'Relay nodes & replication', null, { units: ['month', 'MB', 'copy-month'], kinds: ['service'], examples: ['Relay node carriage for copies behind firewalls', 'Replica hosting', 'Always-on edge node'], specFields: [{ key: 'endpoint', label: 'Relay URL', placeholder: 'https://relay.example.com/cpz1' }, { key: 'carriers', label: 'Connections', placeholder: 'WebTransport, WebSocket, HTTPS' }, { key: 'ask', label: 'Ask', placeholder: 'e.g. 0.02 CAPPZ per MB' }] }),
  c('agents', 'AI agents & automation', null, { units: ['job', 'task', 'hour', 'month'], kinds: ['service'], examples: ['Document summaries', 'Translation', 'Product descriptions', 'Data cleanup', 'Code review', 'Research briefs'], specFields: [{ key: 'runtime', label: 'Runs on', placeholder: 'My own computer, local model' }, { key: 'endpoint', label: 'Agent address (URL)', placeholder: 'https://…' }, { key: 'payment', label: 'Payment', placeholder: 'XRP or CAPPZ, by stage' }] }),
  c('goods', 'Any other goods', null, { units: ['each', 'lb', 'kg', 'case'], kinds: ['sale', 'rent', 'production-contract'], examples: ['Handmade goods', 'Packaging', 'Anything else'], specFields: [{ key: 'details', label: 'Details' }] }),
];

const byId = new Map(CATEGORIES.map((x) => [x.id, x]));
export const categoryOf = (id: string): Category | undefined => byId.get(id);
export const rootCategoryOf = (id: string): string => { let cur = byId.get(id); while (cur?.parent) cur = byId.get(cur.parent); return cur?.id ?? id; };
export const leafCategories = (): Category[] => CATEGORIES.filter((x) => !CATEGORIES.some((y) => y.parent === x.id));

import geo from './geo/usCounties.json';

/**
 * Geography is coarse on purpose — state, or county — so the public ledger
 * never carries an address. Centroids come from the U.S. Census Bureau 2024
 * Gazetteer (public domain): county internal points, and land-area-weighted
 * state centroids. Distances are great-circle miles between centroids.
 */
const STATE_NAMES: Record<string, string> = {'AL': 'Alabama', 'AK': 'Alaska', 'AZ': 'Arizona', 'AR': 'Arkansas', 'CA': 'California', 'CO': 'Colorado', 'CT': 'Connecticut', 'DE': 'Delaware', 'DC': 'District of Columbia', 'FL': 'Florida', 'GA': 'Georgia', 'HI': 'Hawaii', 'ID': 'Idaho', 'IL': 'Illinois', 'IN': 'Indiana', 'IA': 'Iowa', 'KS': 'Kansas', 'KY': 'Kentucky', 'LA': 'Louisiana', 'ME': 'Maine', 'MD': 'Maryland', 'MA': 'Massachusetts', 'MI': 'Michigan', 'MN': 'Minnesota', 'MS': 'Mississippi', 'MO': 'Missouri', 'MT': 'Montana', 'NE': 'Nebraska', 'NV': 'Nevada', 'NH': 'New Hampshire', 'NJ': 'New Jersey', 'NM': 'New Mexico', 'NY': 'New York', 'NC': 'North Carolina', 'ND': 'North Dakota', 'OH': 'Ohio', 'OK': 'Oklahoma', 'OR': 'Oregon', 'PA': 'Pennsylvania', 'PR': 'Puerto Rico', 'RI': 'Rhode Island', 'SC': 'South Carolina', 'SD': 'South Dakota', 'TN': 'Tennessee', 'TX': 'Texas', 'UT': 'Utah', 'VT': 'Vermont', 'VA': 'Virginia', 'WA': 'Washington', 'WV': 'West Virginia', 'WI': 'Wisconsin', 'WY': 'Wyoming'};
const GEO = geo as unknown as { counties: Record<string, [string, string, number, number]>; states: Record<string, [number, number]> };

export const REGIONS: Record<string, { label: string; lat: number; lon: number }> = Object.fromEntries(
  Object.entries(GEO.states).filter(([k]) => STATE_NAMES[k]).map(([k, [lat, lon]]) => [k, { label: STATE_NAMES[k], lat, lon }]),
);

export interface County { fips: string; state: string; name: string; lat: number; lon: number }
export const countyOf = (fips: string | undefined | null): County | null => { const c = fips ? GEO.counties[fips] : undefined; return c ? { fips: fips!, state: c[0], name: c[1], lat: c[2], lon: c[3] } : null; };
export const countiesIn = (state: string): County[] => Object.entries(GEO.counties).filter(([, c]) => c[0] === state).map(([fips, c]) => ({ fips, state: c[0], name: c[1], lat: c[2], lon: c[3] })).sort((a, b) => a.name.localeCompare(b.name));

export interface Place { region: string; county?: string }
const pointOf = (p: Place): { lat: number; lon: number } | null => { const c = countyOf(p.county); if (c && c.state === p.region) return c; return REGIONS[p.region] ?? null; };
export const placeLabel = (p: Place) => { const c = countyOf(p.county); return c && c.state === p.region ? `${c.name}, ${p.region}` : REGIONS[p.region]?.label ?? p.region; };

function miles(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180, R = 3958.8;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/** Miles between two places — county centroids when both have a county, else state centroids; null when unknown (matching treats unknown as "ask"). */
export function placeMiles(a: Place, b: Place): number | null { const p = pointOf(a), q = pointOf(b); return p && q ? miles(p, q) : null; }

/** Great-circle distance between state centroids, miles. */
export function regionMiles(a: string, b: string): number | null { return placeMiles({ region: a }, { region: b }); }
