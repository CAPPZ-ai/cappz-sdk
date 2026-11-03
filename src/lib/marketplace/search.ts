/**
 * COPE node crystallized. Node ID: v15-00-01-marketplace-search.
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Local marketplace search: BM25 over listings, requests, parties and tokens,
 * with light stemming, an agricultural synonym table, catalog-category
 * expansion (a query that names a category or one of its examples matches
 * everything in it), and typo tolerance (character trigrams, then a bounded
 * edit distance with transpositions). Runs in the
 * browser over the replayed market — no index service, nothing leaves the
 * device. It is lexical with domain knowledge, not a neural embedding; every
 * hit says which terms matched.
 */
import { CATEGORIES, categoryOf, placeLabel } from './catalog';
import type { MarketState } from './replay';

export type SearchKind = 'listing' | 'request' | 'party' | 'token';
export interface SearchHit { kind: SearchKind; id: string; title: string; score: number; matched: string[]; categoryId?: string }

const STOP = new Set('a an and the of for to in on at by with from or per my our your i we need want looking buy sell some any'.split(' '));
/** Each group is one meaning; any member finds the others. */
const SYNONYMS: string[][] = [
  ['corn', 'maize'], ['soybean', 'soy', 'soya'], ['holy basil', 'tulsi', 'ocimum tenuiflorum'], ['lavender', 'lavandula', 'grosso'],
  ['chamomile', 'camomile', 'matricaria'], ['saffron', 'crocus sativus'], ['hops', 'humulus'], ['dahlia', 'dahlias'], ['peony', 'peonies', 'paeonia'],
  ['edible flower', 'edible flowers', 'viola', 'nasturtium', 'borage'], ['microgreen', 'microgreens', 'shoots'], ['tomato', 'tomatoes', 'heirloom'],
  ['wheat', 'hrs', 'hard red'], ['barley', 'malting'], ['sorghum', 'milo'], ['hay', 'forage', 'alfalfa'],
  ['tractor', 'utility tractor'], ['combine', 'harvester', 'combining'], ['planter', 'seeder', 'drill'], ['sprayer', 'spraying', 'spray'],
  ['transplanter', 'transplanting', 'plug planter'], ['dryer', 'drying', 'dehydrator'], ['still', 'distillation', 'distilling', 'essential oil'],
  ['custom hire', 'custom work', 'contract work', 'custom'], ['trucking', 'hauling', 'freight'], ['storage', 'bin', 'bins', 'warehouse', 'cold storage'],
  ['lease', 'rent', 'rental', 'renting'], ['seed', 'seeds', 'plugs', 'transplants', 'starts'], ['fertilizer', 'compost', 'manure', 'inputs'],
  ['diagnosis', 'disease', 'blight', 'pest', 'scouting', 'agronomy'], ['organic', 'omri', 'certified organic'], ['drone', 'uav'], ['egg', 'eggs'], ['honey', 'apiary', 'bees'],
];

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s-]/g, ' ');
export function stem(w: string): string {
  if (w.length <= 3) return w;
  for (const [suf, rep] of [['ies', 'y'], ['sses', 'ss'], ['ing', ''], ['ed', ''], ['es', ''], ['s', '']] as const) if (w.endsWith(suf) && w.length - suf.length >= 3) return w.slice(0, -suf.length) + rep;
  return w;
}
export const tokens = (s: string): string[] => norm(s).split(/[\s-]+/).filter((w) => w && !STOP.has(w)).map(stem);

const SYN_INDEX = new Map<string, Set<string>>();
for (const group of SYNONYMS) { const toks = new Set(group.flatMap(tokens)); for (const t of toks) SYN_INDEX.set(t, new Set([...(SYN_INDEX.get(t) ?? []), ...toks])); }

function trigrams(w: string): Set<string> { const p = `  ${w} `; const out = new Set<string>(); for (let i = 0; i < p.length - 2; i++) out.add(p.slice(i, i + 3)); return out; }
const trigramSim = (a: string, b: string) => { const A = trigrams(a), B = trigrams(b); let n = 0; for (const t of A) if (B.has(t)) n++; return n / (A.size + B.size - n); };

/** Optimal-string-alignment distance (edits + adjacent transpositions), stopping early beyond `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}

interface Doc { kind: SearchKind; id: string; title: string; categoryId?: string; fields: Array<{ toks: string[]; weight: number }> }

function documents(state: MarketState): Doc[] {
  const cat = (id: string) => { const c = categoryOf(id); const parent = c?.parent ? categoryOf(c.parent) : null; return tokens(`${c?.label ?? ''} ${parent?.label ?? ''} ${(c?.examples ?? []).join(' ')}`); };
  return [
    ...state.listings.filter((l) => l.open).map((l) => ({ kind: 'listing' as const, id: l.listingId, title: l.title, categoryId: l.categoryId, fields: [{ toks: tokens(l.title), weight: 3 }, { toks: tokens(Object.values(l.attributes).join(' ')), weight: 2 }, { toks: tokens(l.description), weight: 1 }, { toks: cat(l.categoryId), weight: 0.6 }, { toks: tokens(`${placeLabel(l)} ${l.kind}`), weight: 0.8 }] })),
    ...state.requests.filter((r) => r.open).map((r) => ({ kind: 'request' as const, id: r.requestId, title: r.title, categoryId: r.categoryId, fields: [{ toks: tokens(r.title), weight: 3 }, { toks: tokens(Object.values(r.attributes).join(' ')), weight: 2 }, { toks: tokens(r.description), weight: 1 }, { toks: cat(r.categoryId), weight: 0.6 }, { toks: tokens(placeLabel(r)), weight: 0.8 }] })),
    ...[...state.parties.values()].map((p) => ({ kind: 'party' as const, id: p.partyId, title: p.name, fields: [{ toks: tokens(p.name), weight: 3 }, { toks: tokens(`${p.about} ${p.roles.join(' ')} ${(p.capabilities.equipment ?? []).join(' ')}`), weight: 1 }, { toks: p.capabilities.categories.flatMap(cat), weight: 0.6 }, { toks: tokens(placeLabel(p)), weight: 0.8 }] })),
    ...state.tokens.map((t) => ({ kind: 'token' as const, id: t.content.tokenId, title: t.content.name, categoryId: t.content.categoryId, fields: [{ toks: tokens(t.content.name), weight: 3 }, { toks: tokens(t.content.description), weight: 1 }, { toks: cat(t.content.categoryId), weight: 0.6 }] })),
  ];
}

/** Expand a query into weighted terms: the term (1), its synonyms (0.8), close spellings found in the corpus (0.6 × similarity). */
function expand(query: string, vocab: Set<string>): Map<string, { weight: number; from: string }> {
  const out = new Map<string, { weight: number; from: string }>();
  const put = (t: string, w: number, from: string) => { const cur = out.get(t); if (!cur || cur.weight < w) out.set(t, { weight: w, from }); };
  const q = tokens(query);
  // Multi-word synonyms ("holy basil") are matched on the normalized query string as well.
  const nq = ` ${norm(query)} `;
  for (const group of SYNONYMS) if (group.some((g) => nq.includes(` ${norm(g)} `))) for (const t of group.flatMap(tokens)) put(t, 0.8, group[0]);
  for (const t of q) {
    put(t, 1, t);
    for (const s of SYN_INDEX.get(t) ?? []) if (s !== t) put(s, 0.8, t);
    if (!vocab.has(t) && t.length >= 4) for (const v of vocab) {
      const sim = trigramSim(t, v);
      if (sim >= 0.45) { put(v, 0.6 * sim, `${t}≈${v}`); continue; }
      // Transposed or dropped letters ("combnie") defeat trigrams on short words; allow 1 edit (2 from 7 letters) with the same first letter.
      const max = t.length >= 7 ? 2 : 1;
      if (v[0] === t[0] && v.length >= 4) { const d = editDistance(t, v, max); if (d <= max) put(v, 0.6 * (1 - d / Math.max(t.length, v.length)), `${t}≈${v}`); }
    }
  }
  return out;
}

export function searchMarket(state: MarketState, query: string, opts: { kinds?: SearchKind[]; limit?: number } = {}): SearchHit[] {
  if (!query.trim()) return [];
  const docs = documents(state).filter((d) => !opts.kinds || opts.kinds.includes(d.kind));
  const vocab = new Set(docs.flatMap((d) => d.fields.flatMap((f) => f.toks)));
  const terms = expand(query, vocab);
  // Categories named by the query (label or an example) boost their items.
  const qn = norm(query);
  const namedCats = new Set(CATEGORIES.filter((c) => qn.includes(norm(c.label)) || c.examples.some((e) => norm(e).split(/\s+/).some((w) => w.length > 3 && qn.includes(w)))).map((c) => c.id));
  const N = docs.length || 1;
  const lens = docs.map((d) => d.fields.reduce((s, f) => s + f.toks.length, 0));
  const avg = lens.reduce((a, b) => a + b, 0) / N || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d.fields.flatMap((f) => f.toks))) df.set(t, (df.get(t) ?? 0) + 1);
  const k1 = 1.2, b = 0.75;
  const hits: SearchHit[] = [];
  docs.forEach((d, i) => {
    let score = 0; const matched = new Set<string>();
    for (const [t, { weight, from }] of terms) {
      const n = df.get(t); if (!n) continue;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      let tf = 0; for (const f of d.fields) tf += f.weight * f.toks.filter((x) => x === t).length;
      if (!tf) continue;
      score += weight * idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * lens[i]) / avg)));
      matched.add(from === t ? t : `${from}→${t}`);
    }
    if (d.categoryId && [...namedCats].some((c) => d.categoryId === c || d.categoryId!.startsWith(`${c}/`))) { score += 0.5; matched.add(`category:${d.categoryId}`); }
    if (score > 0) hits.push({ kind: d.kind, id: d.id, title: d.title, score: Math.round(score * 100) / 100, matched: [...matched], ...(d.categoryId ? { categoryId: d.categoryId } : {}) });
  });
  return hits.sort((a, b2) => b2.score - a.score).slice(0, opts.limit ?? 50);
}
