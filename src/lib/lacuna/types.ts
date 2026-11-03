/**
 * COPE node crystallized. Node ID: v15-25-00-lacuna-types.
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * The lacuna interface (github.com/fastflair/lacuna, crate lacuna-wasm) that
 * discovery code is written against. Hosts load the verified WebAssembly
 * artifact themselves (cappz.ai: src/lib/lacuna/lacunaWasm.ts) and pass it in;
 * discovery degrades to "unavailable" without one.
 */
export type NumericAxis = { kind: 'scalar'; id: string; min: number; max: number } | { kind: 'categorical'; id: string; options: string[] };
export interface LacunaEntity { id: string; name: string; summary: string; tags: string[]; facets: Record<string, string>; vectors: Record<string, number[]>; demand_signal: number; quality_signal: number; metadata: unknown }
export interface LacunaSchema { domain_id: string; title: string; description: string; facets: Array<{ id: string; name: string; description: string; default_weight: number }>; demand_metric_name: string; quality_metric_name: string }
export interface LacunaVoidConfig { top_k?: number; min_radius?: number; min_void_separation?: number; facet_weights?: Record<string, number> | null; anchor_distance_window?: [number, number] }
export interface LacunaVoid {
  void_id: string; rank: number; radius: number; opportunity_score: number; simplex_diversity: number;
  boundary_demand: number; boundary_quality: number; center: Record<string, number[]>;
  boundary_neighbors: Array<{ entity_id: string; name: string; distance: number; simplex_weight: number }>;
}
export type DecodedValue = { kind: 'scalar'; id: string; value: number } | { kind: 'categorical'; id: string; choice: string; weights: number[] };

export interface Lacuna {
  version: string;
  sha256: string;
  call<T>(request: Record<string, unknown>): T;
  findVoids(schema: LacunaSchema, entities: LacunaEntity[], config: LacunaVoidConfig): LacunaVoid[];
  /** Scalar axes take a number, categorical axes the option label. */
  encode(axes: NumericAxis[], values: Array<number | string>): number[];
  decode(axes: NumericAxis[], vector: number[]): DecodedValue[];
  /** lacuna's deterministic text embedding (the one find_voids applies to text facets). Needs lacuna-wasm ≥ 0.3.0. */
  embed(texts: string[]): number[][];
}
