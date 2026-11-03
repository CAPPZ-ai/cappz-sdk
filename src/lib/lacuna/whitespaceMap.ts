/**
 * COPE node crystallized. Node ID: v14-19-00-whitespace-map.
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Shared projection for lacuna whitespace maps (HARVEST atlas, marketplace
 * market discovery). Distances are lacuna's own metric — the weighted mean of
 * per-facet cosine distances (lacuna-core::metric::point_to_entity_distance);
 * the map is classical (Torgerson) MDS of that matrix, so it is deterministic.
 * A projection cannot keep every distance: `fidelity` reports how well it
 * does, and void radii are true facet-space radii scaled to the map.
 */
export type Vectors = Record<string, number[]>;

function cosineDistance(u: number[] | undefined, v: number[] | undefined): number {
  if (!u?.length || !v?.length) return 1;
  let d = 0, nu = 0, nv = 0;
  for (let i = 0; i < Math.min(u.length, v.length); i++) { d += u[i] * v[i]; nu += u[i] ** 2; nv += v[i] ** 2; }
  return nu && nv ? Math.max(0, 1 - d / Math.sqrt(nu * nv)) : 1;
}

/** lacuna-core::metric::point_to_entity_distance with the given facet weights. */
export function facetDistance(a: Vectors, b: Vectors, weights: Record<string, number>): number {
  let w = 0, sum = 0;
  for (const [id, weight] of Object.entries(weights)) { if (weight <= 0 || !a[id] || !b[id]) continue; w += weight; sum += weight * cosineDistance(a[id], b[id]); }
  return w ? sum / w : 1;
}

/** Top-two eigenpairs of a symmetric matrix by power iteration with deflation (deterministic start). */
function topTwo(B: number[][]): Array<{ value: number; vector: number[] }> {
  const n = B.length; const out: Array<{ value: number; vector: number[] }> = [];
  const M = B.map((r) => r.slice());
  for (let k = 0; k < 2; k++) {
    let v = Array.from({ length: n }, (_, i) => Math.sin(i + 1 + k));
    let value = 0;
    for (let it = 0; it < 300; it++) {
      const w = M.map((row) => row.reduce((s, x, j) => s + x * v[j], 0));
      const norm = Math.hypot(...w) || 1;
      v = w.map((x) => x / norm);
      value = v.reduce((s, x, i) => s + x * M[i].reduce((t, y, j) => t + y * v[j], 0), 0);
    }
    out.push({ value, vector: v });
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) M[i][j] -= value * v[i] * v[j];
  }
  return out;
}

/** Classical (Torgerson) MDS into two dimensions. */
export function classicalMds(D: number[][]): Array<[number, number]> {
  const n = D.length;
  if (n < 3) return D.map((_, i) => [i, 0]);
  const D2 = D.map((r) => r.map((d) => d * d));
  const row = D2.map((r) => r.reduce((a, b) => a + b, 0) / n);
  const all = row.reduce((a, b) => a + b, 0) / n;
  const B = D2.map((r, i) => r.map((d, j) => -0.5 * (d - row[i] - row[j] + all)));
  const [e1, e2] = topTwo(B);
  const s1 = Math.sqrt(Math.max(0, e1.value)), s2 = Math.sqrt(Math.max(0, e2.value));
  // Fix sign so the layout does not flip between runs of the same data.
  const sign = (v: number[]) => (v.reduce((a, b) => a + b * Math.abs(b), 0) < 0 ? -1 : 1);
  const g1 = sign(e1.vector), g2 = sign(e2.vector);
  return e1.vector.map((x, i) => [g1 * x * s1, g2 * e2.vector[i] * s2]);
}

function pearson(a: number[], b: number[]): number {
  const n = a.length; if (n < 2) return 1;
  const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : 1;
}

const r4 = (x: number) => Math.round(x * 10000) / 10000;

export interface WhitespaceProjection {
  /** Normalized map coordinates (centered, largest extent 1, aspect preserved), one per input vector. */
  coords: Array<{ x: number; y: number }>;
  /** Converts a facet-space radius to map units. */
  mapRadius(radius: number): number;
  /** Pearson r between facet-space and map distances (1 = perfect). */
  fidelity: number;
}

/** Project anchors and void centers together: one distance matrix, one MDS. */
export function projectWhitespace(vectors: Vectors[], weights: Record<string, number>): WhitespaceProjection {
  const n = vectors.length;
  const D = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) D[i][j] = D[j][i] = facetDistance(vectors[i], vectors[j], weights);
  const xy = classicalMds(D);
  const facet: number[] = [], map: number[] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { facet.push(D[i][j]); map.push(Math.hypot(xy[i][0] - xy[j][0], xy[i][1] - xy[j][1])); }
  // Least-squares map units per facet-distance unit, for scaling void radii.
  const k = facet.reduce((s, d, i) => s + d * map[i], 0) / (facet.reduce((s, d) => s + d * d, 0) || 1);
  const xs = xy.map((p) => p[0]), ys = xy.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) || 1;
  return {
    coords: xy.map((p) => ({ x: r4((p[0] - cx) / span), y: r4((p[1] - cy) / span) })),
    mapRadius: (radius) => r4((radius * k) / span),
    fidelity: Math.round(pearson(facet, map) * 100) / 100,
  };
}
