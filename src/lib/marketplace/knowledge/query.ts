/**
 * COPE node crystallized. Node ID: v15-00-01-knowledge-query.
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Query a purchased knowledge graph locally (the buyer decrypted it in the
 * browser; nothing is sent anywhere): search, neighborhood walk, taxonomy
 * path, and a deterministic diagnosis that follows symptom-of → caused-by /
 * treated-by edges weighted by their stated confidence and context. The
 * diagnosis reports what the graph says and how sure the graph is — it is
 * not an agronomist's judgment, and every candidate cites its edges.
 */
import { tokens } from '../search';
import type { NodeContext, PhytoBundle, PhytoEdge, PhytoNode } from './graph';

export interface GraphIndex { bundle: PhytoBundle; byId: Map<string, PhytoNode>; out: Map<string, PhytoEdge[]>; inc: Map<string, PhytoEdge[]> }

export function indexGraph(bundle: PhytoBundle): GraphIndex {
  const byId = new Map(bundle.nodes.map((n) => [n.id, n]));
  const out = new Map<string, PhytoEdge[]>(); const inc = new Map<string, PhytoEdge[]>();
  for (const e of bundle.edges) { (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e); (inc.get(e.to) ?? inc.set(e.to, []).get(e.to)!).push(e); }
  return { bundle, byId, out, inc };
}

/** Text search over labels, bodies, props and context; ranked by token overlap (label counts most). */
export function searchGraph(g: GraphIndex, query: string, limit = 12): Array<{ node: PhytoNode; score: number }> {
  const q = new Set(tokens(query)); if (!q.size) return [];
  return g.bundle.nodes.map((node) => {
    const label = tokens(node.label), body = tokens(`${node.body ?? ''} ${Object.values(node.props).join(' ')} ${Object.values(node.context).join(' ')} ${node.id.replace(/[:/]/g, ' ')}`);
    const score = 3 * label.filter((t) => q.has(t)).length + body.filter((t) => q.has(t)).length;
    return { node, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Nodes and edges within `depth` hops of `nodeId` (both directions). */
export function walk(g: GraphIndex, nodeId: string, depth = 1): { nodes: PhytoNode[]; edges: PhytoEdge[] } {
  const seen = new Set([nodeId]); const edges = new Map<string, PhytoEdge>(); let frontier = [nodeId];
  for (let d = 0; d < Math.min(depth, 3); d++) {
    const next: string[] = [];
    for (const id of frontier) for (const e of [...(g.out.get(id) ?? []), ...(g.inc.get(id) ?? [])]) { edges.set(e.id, e); for (const n of [e.from, e.to]) if (!seen.has(n)) { seen.add(n); next.push(n); } }
    frontier = next;
  }
  return { nodes: [...seen].map((id) => g.byId.get(id)!).filter(Boolean), edges: [...edges.values()] };
}

/** The taxonomy chain from a node to its root (`broader` edges). */
export function taxonomyPath(g: GraphIndex, nodeId: string): PhytoNode[] {
  const path: PhytoNode[] = []; let cur: string | undefined = nodeId; const seen = new Set<string>();
  while (cur && !seen.has(cur)) { seen.add(cur); const n = g.byId.get(cur); if (n) path.push(n); cur = (g.out.get(cur) ?? []).find((e) => e.kind === 'broader')?.to; }
  return path;
}

export interface DiagnosisCandidate {
  condition: PhytoNode; score: number;
  /** The symptom-of edges that support it. */
  evidence: Array<{ symptom: PhytoNode; edge: PhytoEdge }>;
  causes: PhytoNode[];
  treatments: Array<{ treatment: PhytoNode; confidence: number; cautions: PhytoNode[]; requires: PhytoNode[] }>;
  contextMatch: number;
}

const contextFit = (want: NodeContext, have: NodeContext) => { const keys = Object.keys(want).filter((k) => want[k] !== undefined && want[k] !== ''); if (!keys.length) return 1; const hit = keys.filter((k) => have[k] === undefined || String(have[k]).toLowerCase() === String(want[k]).toLowerCase()).length; return 0.5 + 0.5 * (hit / keys.length); };

/**
 * Diagnose from observed symptoms (free text, matched to symptom taxa) and the
 * grower's context. score = Σ over matched symptoms of edge confidence × edge
 * weight × context fit, normalized by the number of symptoms reported.
 */
export function diagnose(g: GraphIndex, symptoms: string[], context: NodeContext = {}): { matchedSymptoms: PhytoNode[]; candidates: DiagnosisCandidate[] } {
  const symptomTaxa = g.bundle.nodes.filter((n) => n.layer === 'taxonomy' && n.id.startsWith('taxon:symptom'));
  const matched = new Map<string, PhytoNode>();
  for (const s of symptoms) {
    const q = new Set(tokens(s));
    const best = symptomTaxa.map((n) => ({ n, hit: tokens(`${n.label} ${n.id.replace(/[:/]/g, ' ')} ${n.body ?? ''}`).filter((t) => q.has(t)).length })).filter((x) => x.hit > 0).sort((a, b) => b.hit - a.hit)[0];
    if (best) matched.set(best.n.id, best.n);
  }
  const byCondition = new Map<string, DiagnosisCandidate>();
  for (const sym of matched.values()) {
    for (const e of g.out.get(sym.id) ?? []) {
      if (e.kind !== 'symptom-of') continue;
      const condition = g.byId.get(e.to); if (!condition) continue;
      const fit = contextFit(context, { ...condition.context, ...e.context });
      const c = byCondition.get(condition.id) ?? { condition, score: 0, evidence: [], causes: [], treatments: [], contextMatch: fit };
      c.score += e.provenance.confidence * (e.weight ?? 1) * fit; c.evidence.push({ symptom: sym, edge: e }); c.contextMatch = Math.min(c.contextMatch, fit);
      byCondition.set(condition.id, c);
    }
  }
  for (const c of byCondition.values()) {
    const out = g.out.get(c.condition.id) ?? [];
    c.causes = out.filter((e) => e.kind === 'caused-by').map((e) => g.byId.get(e.to)!).filter(Boolean);
    c.treatments = out.filter((e) => e.kind === 'treated-by').map((e) => { const t = g.byId.get(e.to)!; const cautions = [...(g.out.get(e.to) ?? [])].filter((x) => x.kind === 'contraindicates' || x.kind === 'has-property').map((x) => g.byId.get(x.to)!).filter(Boolean); const requires = (g.out.get(e.to) ?? []).filter((x) => x.kind === 'requires').map((x) => g.byId.get(x.to)!).filter(Boolean); return { treatment: t, confidence: e.provenance.confidence, cautions, requires }; }).filter((x) => x.treatment).sort((a, b) => b.confidence - a.confidence);
    c.score = Math.round((c.score / Math.max(1, symptoms.length)) * 1000) / 1000;
  }
  return { matchedSymptoms: [...matched.values()], candidates: [...byCondition.values()].sort((a, b) => b.score - a.score) };
}
