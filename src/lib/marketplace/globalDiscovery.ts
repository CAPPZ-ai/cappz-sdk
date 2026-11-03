/**
 * COPE node crystallized. Node ID: v15-00-01-global-market-discovery.
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Global market discovery: lacuna whitespace analysis over the world's
 * existing offerings in a space someone cares about ("3D printing + pets"),
 * not only the CAPPZ marketplace. One world, one economy.
 *
 *   1. Corpus — existing products, services and businesses in the space:
 *        · agent research (the marketplace agent's model lists real offerings
 *          with problem, mechanism, customer, business model and its evidence) —
 *          labelled agent-reported: a starting map to verify, never a fact;
 *        · matching CAPPZ marketplace listings — verified, they are on the ledger.
 *   2. lacuna — four text facets embedded with lacuna's deterministic embedding;
 *      find_interior_voids finds empty regions bounded by existing offerings,
 *      weighted toward high-demand, mature neighbors.
 *   3. Concepts — each void is drafted as a business from its boundary
 *      neighbors (facet bridge: one neighbor's mechanism for another's
 *      customer with a third's model), then optionally named and explained by
 *      the agent. A concept is a hypothesis; validate with customers first.
 *   4. Start-up support — what the CAPPZ marketplace already offers toward it
 *      (equipment, inputs, services, buyers asking) and the first steps.
 *
 * Deterministic for the same corpus. Runs in the browser; the only hosted
 * call is the agent's model, and the run works without it on marketplace data.
 */
import { projectWhitespace } from '../lacuna/whitespaceMap';
import type { Lacuna, LacunaEntity, LacunaSchema } from '../lacuna/types';
import { searchMarket } from './search';
import type { MarketState } from './replay';

export const GLOBAL_FACETS: LacunaSchema['facets'] = [
  { id: 'problem', name: 'Problem', description: 'The need, job or pain the offering addresses.', default_weight: 0.3 },
  { id: 'mechanism', name: 'Mechanism', description: 'How it works: technology, process, materials.', default_weight: 0.3 },
  { id: 'customer', name: 'Customer', description: 'Who buys and uses it, and where.', default_weight: 0.2 },
  { id: 'model', name: 'Business model', description: 'Channel, pricing and how it makes money.', default_weight: 0.2 },
];
const WEIGHTS = Object.fromEntries(GLOBAL_FACETS.map((f) => [f.id, f.default_weight]));
export const GLOBAL_CONFIG = { top_k: 8, min_radius: 0.02, min_void_separation: 0.03 };
const FACET_IDS = GLOBAL_FACETS.map((f) => f.id) as Array<'problem' | 'mechanism' | 'customer' | 'model'>;

export interface Offering {
  id: string; name: string; kind: 'product' | 'service' | 'business';
  problem: string; mechanism: string; customer: string; model: string;
  geography: string; priceBand: string;
  /** 1–10 relative demand / traction as reported. */
  demand: number;
  /** 0–1 maturity / quality as reported. */
  maturity: number;
  /** What backs the entry: a source or "general knowledge". */
  evidence: string;
  source: 'agent-reported' | 'cappz-marketplace';
}

export interface GlobalConcept {
  id: string; rank: number; title: string; summary: string;
  /** Facet bridge: which neighbor anchors which facet. */
  bridge: Record<'problem' | 'mechanism' | 'customer' | 'model', { from: string; text: string }>;
  neighbors: Array<{ id: string; name: string; distance: number; weight: number }>;
  radius: number; opportunityScore: number; boundaryDemand: number;
  whyNow: string; risks: string[]; firstCustomers: string; validate: string[];
  /** "lacuna" when drafted only from the facet bridge; "agent" when the agent named and explained it. */
  writtenBy: 'lacuna' | 'agent';
  marketplace: { listings: Array<{ id: string; title: string }>; requests: Array<{ id: string; title: string }> };
  x: number; y: number; mapRadius: number;
}

export interface GlobalDiscovery {
  scope: 'global'; interests: string; ranAt: string;
  engine: 'lacuna-wasm' | 'unavailable'; version: string | null; artifactSha256: string | null;
  corpus: Array<Offering & { x: number; y: number }>;
  concepts: GlobalConcept[];
  fidelity: number; note: string;
  sources: { agentReported: number; marketplace: number; agentModel: string | null };
}

/** The structured research request sent to the agent's model. */
export function corpusPrompt(interests: string, region: string | null): string {
  return `List 24 to 36 EXISTING, real offerings worldwide${region ? ` (with attention to ${region})` : ''} in this space: "${interests}". Include products, services and businesses across price points, customers and business models — incumbents and niche players. Only include things you believe exist; say how you know in "evidence" (a company or product name, a known source, or "general knowledge").
Return ONLY a JSON array, no prose. Each item:
{"name": string, "kind": "product"|"service"|"business", "problem": string, "mechanism": string, "customer": string, "model": string, "geography": string, "priceBand": string, "demand": number 1-10, "maturity": number 0-1, "evidence": string}`;
}

const clampN = (x: unknown, lo: number, hi: number, d: number) => { const n = Number(x); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const str = (x: unknown, max = 240) => (typeof x === 'string' ? x.trim().slice(0, max) : '');
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

/** Parse the model's answer: the first JSON array in it; every item validated; incomplete items dropped, duplicates merged. */
export function parseCorpus(text: string): Offering[] {
  const start = text.indexOf('['), end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let raw: unknown;
  try { raw = JSON.parse(text.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>(); const out: Offering[] = [];
  for (const r of raw as Array<Record<string, unknown>>) {
    const name = str(r.name, 120); const id = slug(name);
    const o = { problem: str(r.problem), mechanism: str(r.mechanism), customer: str(r.customer), model: str(r.model) };
    if (!name || !id || seen.has(id) || FACET_IDS.some((f) => !o[f])) continue;
    seen.add(id);
    const kind = r.kind === 'service' || r.kind === 'business' ? r.kind : 'product';
    out.push({ id: `g-${id}`, name, kind, ...o, geography: str(r.geography, 80) || 'global', priceBand: str(r.priceBand, 60), demand: clampN(r.demand, 1, 10, 5), maturity: clampN(r.maturity, 0, 1, 0.5), evidence: str(r.evidence, 200) || 'general knowledge', source: 'agent-reported' });
  }
  return out;
}

/** CAPPZ marketplace listings in the space, as verified offerings. */
export function marketplaceOfferings(state: MarketState, interests: string): Offering[] {
  const hits = searchMarket(state, interests, { kinds: ['listing'], limit: 20 });
  return hits.map((h) => { const l = state.listings.find((x) => x.listingId === h.id)!; return {
    id: `m-${l.listingId}`, name: l.title, kind: l.kind === 'service' ? 'service' as const : 'product' as const,
    problem: `${l.title}. ${l.description}`, mechanism: Object.values(l.attributes).join(', ') || l.description, customer: `buyers in ${l.region}`, model: `${l.kind} at ${l.pricePerUnit.amount} ${l.pricePerUnit.currency}/${l.unit}`,
    geography: l.region, priceBand: `${l.pricePerUnit.amount} ${l.pricePerUnit.currency}/${l.unit}`, demand: 5, maturity: (state.reputation.get(l.sellerId)?.average ?? 3.5) / 5, evidence: `CAPPZ marketplace listing ${l.listingId}`, source: 'cappz-marketplace' as const,
  }; });
}

/** Draft a concept from the void's boundary: each facet from the neighbor that anchors it most. */
function bridgeOf(neighbors: Array<{ id: string; weight: number }>, byId: Map<string, Offering>): GlobalConcept['bridge'] {
  const ordered = [...neighbors].sort((a, b) => b.weight - a.weight).map((n) => byId.get(n.id)!).filter(Boolean);
  const pick = (i: number) => ordered[i % ordered.length];
  return {
    mechanism: { from: pick(0).name, text: pick(0).mechanism },
    customer: { from: pick(1).name, text: pick(1).customer },
    problem: { from: pick(ordered.length > 2 ? 2 : 0).name, text: pick(ordered.length > 2 ? 2 : 0).problem },
    model: { from: pick(1).name, text: pick(1).model },
  };
}

export interface ConceptWriter { (prompt: string): Promise<string> }

export function conceptPrompt(interests: string, drafts: Array<{ id: string; bridge: GlobalConcept['bridge']; neighbors: string[] }>): string {
  return `These are empty regions ("whitespace") that lacuna found between existing offerings in "${interests}". For each, write a concrete new business that would sit in that gap — combining the bridged facets — without copying any neighbor.
${JSON.stringify(drafts)}
Return ONLY a JSON array, one item per input in the same order: {"id": string, "title": string (≤ 70 chars), "summary": string (2 sentences), "whyNow": string, "risks": [string, string], "firstCustomers": string, "validate": [string, string, string] (cheapest tests before spending money)}`;
}

export async function runGlobalDiscovery(params: { state: MarketState; lacuna: Lacuna | null; interests: string; region: string | null; ranAt: string; research: ConceptWriter | null; modelLabel?: string | null }): Promise<GlobalDiscovery> {
  const { state, lacuna, interests, region, ranAt, research } = params;
  const base = { scope: 'global' as const, interests, ranAt, version: lacuna?.version ?? null, artifactSha256: lacuna?.sha256 ?? null, fidelity: 1 };
  let reported: Offering[] = []; let researchError: string | null = null;
  if (research) { try { reported = parseCorpus(await research(corpusPrompt(interests, region))); } catch (e) { researchError = e instanceof Error ? e.message : 'agent research failed'; } }
  const verified = marketplaceOfferings(state, interests);
  const corpus = [...reported, ...verified];
  const sources = { agentReported: reported.length, marketplace: verified.length, agentModel: research ? params.modelLabel ?? 'agent model' : null };
  if (!lacuna) return { ...base, engine: 'unavailable', corpus: [], concepts: [], sources, note: 'lacuna not loaded; global discovery needs the in-browser lacuna module.' };
  if (corpus.length < 6) return { ...base, engine: 'lacuna-wasm', corpus: [], concepts: [], sources, note: `Only ${corpus.length} offerings in this space${researchError ? ` (agent research: ${researchError})` : !research ? ' (the agent model is not available, so only marketplace listings were used)' : ''} — at least 6 are needed to find whitespace. Try broader interests, or ask again.` };

  const entities: LacunaEntity[] = corpus.map((o) => ({ id: o.id, name: o.name, summary: o.problem, tags: [o.kind, o.source], facets: { problem: o.problem, mechanism: o.mechanism, customer: o.customer, model: o.model }, vectors: {}, demand_signal: o.demand, quality_signal: Math.max(0.1, o.maturity), metadata: null }));
  const schema: LacunaSchema = { domain_id: `global-${slug(interests)}`, title: `Global market: ${interests}`, description: 'Existing offerings worldwide in this space.', facets: GLOBAL_FACETS, demand_metric_name: 'reported_demand', quality_metric_name: 'reported_maturity' };
  const voids = lacuna.findVoids(schema, entities, GLOBAL_CONFIG);
  // Same embedding find_voids used, so entities and void centers share one map.
  const vecs = corpus.map((o) => { const e = lacuna.embed(FACET_IDS.map((f) => o[f])); return Object.fromEntries(FACET_IDS.map((f, i) => [f, e[i]])); });
  const proj = projectWhitespace([...vecs, ...voids.map((v) => v.center)], WEIGHTS);
  const byId = new Map(corpus.map((o) => [o.id, o]));

  const drafts = voids.map((v) => ({ v, bridge: bridgeOf(v.boundary_neighbors.map((b) => ({ id: b.entity_id, weight: b.simplex_weight })), byId) }));
  let written: Array<Record<string, unknown>> = [];
  if (research && drafts.length) {
    try {
      const text = await research(conceptPrompt(interests, drafts.map((d) => ({ id: d.v.void_id, bridge: d.bridge, neighbors: d.v.boundary_neighbors.map((b) => b.name) }))));
      const s = text.indexOf('['), e = text.lastIndexOf(']');
      if (s >= 0 && e > s) written = JSON.parse(text.slice(s, e + 1)) as Array<Record<string, unknown>>;
    } catch { written = []; }
  }
  const concepts: GlobalConcept[] = drafts.map(({ v, bridge }, j) => {
    const w = written.find((x) => x?.id === v.void_id);
    const terms = `${interests} ${bridge.mechanism.text} ${bridge.customer.text}`;
    const listings = searchMarket(state, terms, { kinds: ['listing'], limit: 4 }).map((h) => ({ id: h.id, title: h.title }));
    const requests = searchMarket(state, terms, { kinds: ['request'], limit: 4 }).map((h) => ({ id: h.id, title: h.title }));
    return {
      id: v.void_id, rank: v.rank,
      title: str(w?.title, 90) || `New offering between ${v.boundary_neighbors.slice(0, 2).map((b) => b.name).join(' and ')}`,
      summary: str(w?.summary, 400) || `Combine ${bridge.mechanism.from}'s approach (${bridge.mechanism.text}) with ${bridge.customer.from}'s customers (${bridge.customer.text}), addressing ${bridge.problem.text.toLowerCase()} with a ${bridge.model.text.toLowerCase()} model.`,
      bridge, neighbors: v.boundary_neighbors.map((b) => ({ id: b.entity_id, name: b.name, distance: b.distance, weight: b.simplex_weight })),
      radius: v.radius, opportunityScore: v.opportunity_score, boundaryDemand: v.boundary_demand,
      whyNow: str(w?.whyNow, 300) || 'Not assessed — the agent model was not available. Look for what changed recently in cost, technology or regulation for these neighbors.',
      risks: Array.isArray(w?.risks) ? (w!.risks as unknown[]).map((x) => str(x, 200)).filter(Boolean).slice(0, 4) : ['Unverified gap — the neighbors are reported, not measured.', 'Incumbents may already serve it through channels not listed.'],
      firstCustomers: str(w?.firstCustomers, 300) || `People who buy from ${v.boundary_neighbors.map((b) => b.name).slice(0, 2).join(' or ')} today.`,
      validate: Array.isArray(w?.validate) ? (w!.validate as unknown[]).map((x) => str(x, 200)).filter(Boolean).slice(0, 5) : ['Talk to ten people who buy from the neighbors; ask what is missing.', 'Put up a landing page or a CAPPZ marketplace listing and measure interest before building.', 'Make one prototype or deliver the service once by hand.'],
      writtenBy: w ? 'agent' : 'lacuna', marketplace: { listings, requests },
      ...proj.coords[corpus.length + j], mapRadius: proj.mapRadius(v.radius),
    };
  });

  return {
    ...base, engine: 'lacuna-wasm', fidelity: proj.fidelity, sources,
    corpus: corpus.map((o, i) => ({ ...o, ...proj.coords[i] })),
    concepts,
    note: `${voids.length} whitespace regions among ${corpus.length} existing offerings (${reported.length} agent-reported, ${verified.length} on the CAPPZ marketplace). Agent-reported offerings are a starting map to verify, not facts; concepts are hypotheses to test with customers.${researchError ? ` Agent research failed: ${researchError}.` : ''}`,
  };
}
