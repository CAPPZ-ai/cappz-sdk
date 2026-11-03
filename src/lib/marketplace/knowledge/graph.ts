/**
 * COPE node crystallized. Node ID: v15-00-01-knowledge-graph.
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Knowledge graphs sold on the marketplace — format `phyto-graph/v1`
 * (ported from the cappz-marketplace Phytognosis module, unchanged on the
 * wire so external pipelines keep working). Three explicitly separated layers:
 *   taxonomy  — the hierarchy (closed vocabulary, single `broader` parent)
 *   property  — reified property/context nodes (a claim + the context it holds in)
 *   instance  — observed things and events, typed against the taxonomy
 * The bundle is authored outside CAPPZ; this module defines, validates,
 * serializes to wallet leaves with a Merkle root, and verifies. Leaves live
 * under the selling listing: listings/{id}/graph/{layer}/{node}.
 */
import { listingAddress } from '../MarketplacePaths';

/** Bundle types — `phyto-graph/v1`.
 *
 * Three explicitly separated layers:
 *   taxonomy  — the hierarchy (closed vocabulary, single `broader` parent)
 *   property  — reified property/context nodes (a claim + the context it holds in)
 *   instance  — observed things and events, typed against the taxonomy
 *
 * The bundle is authored OUTSIDE this project. This module only defines,
 * validates, serializes and verifies it.
 */

export const BUNDLE_VERSION = 'phyto-graph/v1' as const;

export type NodeLayer = 'taxonomy' | 'property' | 'instance';

export type NodeClass =
  // taxonomy
  | 'taxon'
  // property/context
  | 'property'
  | 'measurement'
  // instance
  | 'plant'
  | 'observation'
  | 'treatment'
  | 'substance'
  | 'environment';

export type EdgeKind =
  | 'broader'          // taxonomy child → parent (taxonomy layer only)
  | 'instance-of'      // instance → taxon
  | 'has-property'     // instance|taxon → property
  | 'symptom-of'       // observation/taxon → disease taxon
  | 'caused-by'        // taxon → cause taxon
  | 'treated-by'       // taxon → treatment taxon
  | 'contraindicates'  // treatment → treatment/condition
  | 'requires'         // treatment → substance
  | 'observed-on'      // observation → plant
  | 'applied-to'       // treatment event → plant
  | 'derived-from';    // provenance link between nodes

/** Context keys are open, but these are the reserved, indexed ones. */
export interface NodeContext {
  cultivar?: string;
  species?: string;
  growthStage?: string;
  medium?: string;
  climateZone?: string;
  season?: string;
  method?: string;
  /** Free-form additional context; participates in the leaf hash. */
  [k: string]: string | number | boolean | undefined;
}

export interface Provenance {
  source: string;
  method: 'human' | 'pipeline' | 'model' | 'import';
  confidence: number; // 0..1
  observedAt?: string; // ISO
  modelId?: string;
}

export interface PhytoNode {
  /** Stable, namespaced id, e.g. `taxon:disease/fungal/powdery-mildew`. */
  id: string;
  layer: NodeLayer;
  class: NodeClass;
  label: string;
  /** Body text shown in the reader; may be long. */
  body?: string;
  props: Record<string, string | number | boolean>;
  context: NodeContext;
  provenance: Provenance;
}

export interface PhytoEdge {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  weight?: number;
  context: NodeContext;
  provenance: Provenance;
}

export interface BundleManifest {
  version: typeof BUNDLE_VERSION;
  graphId: string;
  graphVersion: string;
  title: string;
  description: string;
  /** Embedding models used by the authoring pipeline, if any. */
  modelIds: string[];
  publisher: string;
  createdAt: string;
  /** Merkle root over sorted leaf hashes. Filled by the serializer. */
  merkleRoot?: string;
  nodeCount?: number;
  edgeCount?: number;
}

export interface PhytoBundle {
  manifest: BundleManifest;
  nodes: PhytoNode[];
  edges: PhytoEdge[];
}

/** A wallet-leaf payload — the exact bytes CAPPZ would anchor. */
export interface WalletLeaf {
  hdPath: string;
  /** Canonical JSON of the node/edge. */
  payload: string;
  leafHash: string;
  kind: 'node' | 'edge' | 'manifest';
  refId: string;
}

export interface ValidationIssue {
  code:
    | 'schema'
    | 'duplicate-id'
    | 'dangling-ref'
    | 'taxonomy-cycle'
    | 'layer-violation'
    | 'bad-confidence';
  message: string;
  at?: string;
}


// ─── HD paths: under the listing that sells the graph (AX-59 via MarketplacePaths) ──

export function slugSegment(raw: string): string {
  return raw.normalize('NFKD').replace(/[^a-zA-Z0-9/_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}
const LAYER_DIR = { taxonomy: 'taxonomy', property: 'properties', instance: 'instances' } as const;
export const graphRoot = (listingId: string) => `${listingAddress(listingId)}/graph`;
export const nodeHdPath = (listingId: string, node: PhytoNode) => `${graphRoot(listingId)}/${LAYER_DIR[node.layer]}/${slugSegment(node.id)}`;
export const edgeHdPath = (listingId: string, edge: PhytoEdge) => `${graphRoot(listingId)}/edges/${slugSegment(edge.id)}`;
export const manifestHdPath = (listingId: string) => `${graphRoot(listingId)}/manifest`;
export const ciphertextHdPath = (listingId: string) => `${graphRoot(listingId)}/ciphertext`;

// ─── Validation ───────────────────────────────────────────────────

const ID_RE = /^[a-z][a-z0-9-]*:[A-Za-z0-9._/-]+$/;

export function validateBundle(bundle: PhytoBundle): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const push = (code: ValidationIssue['code'], message: string, at?: string) =>
    issues.push({ code, message, at });

  if (!bundle?.manifest) {
    push('schema', 'manifest missing');
    return issues;
  }
  if (bundle.manifest.version !== BUNDLE_VERSION) {
    push('schema', `unsupported version ${bundle.manifest.version}; expected ${BUNDLE_VERSION}`);
  }
  if (!bundle.manifest.graphId) push('schema', 'manifest.graphId required');
  if (!bundle.manifest.graphVersion) push('schema', 'manifest.graphVersion required');
  if (!Array.isArray(bundle.nodes) || !Array.isArray(bundle.edges)) {
    push('schema', 'nodes and edges must be arrays');
    return issues;
  }

  const ids = new Set<string>();
  for (const n of bundle.nodes) {
    if (!n.id || !ID_RE.test(n.id)) push('schema', `invalid node id "${n.id}"`, n.id);
    if (ids.has(n.id)) push('duplicate-id', `duplicate node id ${n.id}`, n.id);
    ids.add(n.id);
    if (!n.label) push('schema', `node ${n.id} missing label`, n.id);
    if (!n.layer || !['taxonomy', 'property', 'instance'].includes(n.layer)) {
      push('schema', `node ${n.id} has invalid layer`, n.id);
    }
    if (n.layer === 'taxonomy' && n.class !== 'taxon') {
      push('layer-violation', `taxonomy node ${n.id} must be class "taxon"`, n.id);
    }
    const c = n.provenance?.confidence;
    if (typeof c !== 'number' || c < 0 || c > 1) {
      push('bad-confidence', `node ${n.id} confidence must be 0..1`, n.id);
    }
  }

  const edgeIds = new Set<string>();
  const nodeById = new Map(bundle.nodes.map((n) => [n.id, n] as const));
  for (const e of bundle.edges) {
    if (!e.id) push('schema', 'edge missing id');
    if (edgeIds.has(e.id)) push('duplicate-id', `duplicate edge id ${e.id}`, e.id);
    edgeIds.add(e.id);
    if (!nodeById.has(e.from)) push('dangling-ref', `edge ${e.id} from unknown node ${e.from}`, e.id);
    if (!nodeById.has(e.to)) push('dangling-ref', `edge ${e.id} to unknown node ${e.to}`, e.id);
    if (e.kind === 'broader') {
      const from = nodeById.get(e.from);
      const to = nodeById.get(e.to);
      if (from && from.layer !== 'taxonomy') {
        push('layer-violation', `broader edge ${e.id} must originate in taxonomy`, e.id);
      }
      if (to && to.layer !== 'taxonomy') {
        push('layer-violation', `broader edge ${e.id} must target taxonomy`, e.id);
      }
    }
    const c = e.provenance?.confidence;
    if (typeof c !== 'number' || c < 0 || c > 1) {
      push('bad-confidence', `edge ${e.id} confidence must be 0..1`, e.id);
    }
  }

  // Single-parent + acyclic taxonomy.
  const parent = new Map<string, string>();
  for (const e of bundle.edges.filter((x) => x.kind === 'broader')) {
    if (parent.has(e.from)) {
      push('taxonomy-cycle', `taxon ${e.from} has more than one broader parent`, e.id);
    }
    parent.set(e.from, e.to);
  }
  for (const start of parent.keys()) {
    const seen = new Set<string>([start]);
    let cur = parent.get(start);
    while (cur) {
      if (seen.has(cur)) {
        push('taxonomy-cycle', `taxonomy cycle through ${cur}`, cur);
        break;
      }
      seen.add(cur);
      cur = parent.get(cur);
    }
  }

  return issues;
}

export function isValid(issues: ValidationIssue[]): boolean {
  return issues.length === 0;
}

// ─── Leaves and Merkle root ───────────────────────────────────────

const enc = new TextEncoder();

export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('non-finite number');
  return JSON.stringify(value ?? null);
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === 'string' ? enc.encode(input) : input;
  const buf = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** leafHash = sha256(hdPath + '\n' + canonicalPayload) */
export async function leafHash(hdPath: string, payload: string): Promise<string> {
  return sha256Hex(`${hdPath}\n${payload}`);
}

export async function nodeLeaf(listingId: string, node: PhytoNode): Promise<WalletLeaf> {
  const hdPath = nodeHdPath(listingId, node);
  const payload = canonicalize(node);
  return { hdPath, payload, leafHash: await leafHash(hdPath, payload), kind: 'node', refId: node.id };
}

export async function edgeLeaf(listingId: string, edge: PhytoEdge): Promise<WalletLeaf> {
  const hdPath = edgeHdPath(listingId, edge);
  const payload = canonicalize(edge);
  return { hdPath, payload, leafHash: await leafHash(hdPath, payload), kind: 'edge', refId: edge.id };
}

/**
 * Merkle root over sorted leaf hashes. Duplicated last node on odd levels
 * (Bitcoin-style), which keeps the implementation trivially portable.
 */
export async function merkleRoot(leafHashes: string[]): Promise<string> {
  if (leafHashes.length === 0) return sha256Hex('phyto-graph/empty');
  let level = [...leafHashes].sort();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = level[i + 1] ?? a;
      next.push(await sha256Hex(`${a}${b}`));
    }
    level = next;
  }
  return level[0];
}

export interface SerializedBundle {
  graphId: string;
  leaves: WalletLeaf[];
  manifestLeaf: WalletLeaf;
  merkleRoot: string;
}

/** Serialize an entire bundle into wallet leaves + manifest leaf. */
export async function serializeBundle(bundle: PhytoBundle, listingId: string): Promise<SerializedBundle> {
  const graphId = bundle.manifest.graphId;
  const leaves: WalletLeaf[] = [];
  for (const n of bundle.nodes) leaves.push(await nodeLeaf(listingId, n));
  for (const e of bundle.edges) leaves.push(await edgeLeaf(listingId, e));

  const root = await merkleRoot(leaves.map((l) => l.leafHash));
  const manifest = {
    ...bundle.manifest,
    merkleRoot: root,
    nodeCount: bundle.nodes.length,
    edgeCount: bundle.edges.length,
  };
  const hdPath = manifestHdPath(listingId);
  const payload = canonicalize(manifest);
  const manifestLeaf: WalletLeaf = {
    hdPath,
    payload,
    leafHash: await leafHash(hdPath, payload),
    kind: 'manifest',
    refId: graphId,
  };
  return { graphId, leaves, manifestLeaf, merkleRoot: root };
}

/** Re-derive the root from stored leaves and compare against the manifest. */
export async function verifyLeaves(
  leaves: Pick<WalletLeaf, 'hdPath' | 'payload' | 'leafHash'>[],
  expectedRoot: string
): Promise<{ ok: boolean; badLeaves: string[]; derivedRoot: string }> {
  const badLeaves: string[] = [];
  for (const l of leaves) {
    const h = await leafHash(l.hdPath, l.payload);
    if (h !== l.leafHash) badLeaves.push(l.hdPath);
  }
  const derivedRoot = await merkleRoot(leaves.map((l) => l.leafHash));
  return { ok: badLeaves.length === 0 && derivedRoot === expectedRoot, badLeaves, derivedRoot };
}
