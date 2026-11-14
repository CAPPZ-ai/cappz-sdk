/**
 * COPE node crystallized.
 * Node ID: v15-40-00-constraint-adapter-graph
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Apache TinkerPop (Gremlin, GraphSON 3.0) for constraint checks: device
 * twins and IoT platforms that keep devices, sensors and setpoints as graph
 * vertices and edges (JanusGraph, Neptune, Cosmos DB Gremlin, any Gremlin
 * Server).
 *
 *   Guard  — a Gremlin Server request with op "bytecode" is a structured
 *            traversal, so its writes can be checked: V(<literal ids>) …
 *            property([cardinality,] key, literal) becomes point writes.
 *            Everything that cannot be resolved statically is never guessed:
 *              - a governed property set on vertices not selected by literal
 *                id (V().has('type','oven').property('setpoint', 400) — a bulk
 *                write) is malformed: refused;
 *              - scripts (op "eval"), lambdas, drop(), addV/addE/mergeV/mergeE,
 *                io(), call() and traversal-valued properties are privileged.
 *   Observe — GraphSON vertices (with VertexProperty meta-properties for the
 *            time) become observations through an explicit
 *            (vertex id, property key) → point map.
 *   Draft  — a device graph's explicit structure drafts an envelope: point
 *            vertices by their declared label, units and limits from named
 *            properties, `agreement` from redundancy edges and `response`
 *            from control edges. Numbers come only from the graph; what is
 *            missing is listed as needed, never invented. Labels are the
 *            graph's declared schema, chosen by the operator's mapping — no
 *            name is parsed for meaning.
 */

import type { PointValue } from '../authority.ts';
import type { Constraint, ConstraintPoint, PointKind } from '../envelope.ts';
import type { Observation } from '../reconcile.ts';
import type { WriteDecode } from './common.ts';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const MAX_DEPTH = 64; const MAX_STEPS = 1000;

/** GraphSON 3 typed value → plain JS (lists, maps, numbers, dates); vertices/edges keep their shape. */
export function fromGraphSON(v: Json, depth = 0): unknown {
  if (depth > MAX_DEPTH) throw new Error('GraphSON nested too deeply');
  if (Array.isArray(v)) return v.map((x) => fromGraphSON(x, depth + 1));
  if (!v || typeof v !== 'object') return v;
  const t = v['@type']; const val = v['@value'];
  if (typeof t !== 'string') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fromGraphSON(x, depth + 1)]));
  switch (t) {
    case 'g:Int32': case 'g:Int64': case 'g:Float': case 'g:Double': case 'gx:Int16': case 'gx:Byte': { const n = typeof val === 'string' ? Number(val) : val; return typeof n === 'number' ? n : NaN; }
    case 'g:Date': case 'g:Timestamp': return { $date: Number(val) };
    case 'g:List': case 'g:Set': return Array.isArray(val) ? val.map((x) => fromGraphSON(x, depth + 1)) : [];
    case 'g:Map': { const out: Record<string, unknown> = {}; if (Array.isArray(val)) for (let i = 0; i + 1 < val.length; i += 2) out[String(fromGraphSON(val[i], depth + 1))] = fromGraphSON(val[i + 1], depth + 1); return out; }
    case 'g:UUID': return String(val);
    case 'g:T': case 'g:Cardinality': case 'g:Direction': case 'g:Order': case 'g:Pop': case 'g:Scope': case 'g:Column': case 'g:Operator': case 'g:Merge': return { $enum: t, value: val };
    default: return { $type: t, value: val === undefined ? undefined : fromGraphSON(val as Json, depth + 1) };
  }
}

const isEnum = (x: unknown, type?: string): x is { $enum: string; value: unknown } => !!x && typeof x === 'object' && '$enum' in x && (!type || (x as { $enum: string }).$enum === type);
const isTyped = (x: unknown, type: string) => !!x && typeof x === 'object' && (x as { $type?: string }).$type === type;
const literal = (x: unknown): x is PointValue => (typeof x === 'number' && Number.isFinite(x)) || typeof x === 'boolean' || typeof x === 'string';

export interface GraphPointMap { vertexId: string; key: string; point: string }

const MUTATING_PRIVILEGED = new Set(['addV', 'addE', 'drop', 'mergeV', 'mergeE', 'io', 'call', 'sideEffect', 'program', 'write']);
const SAFE_FILTERS = new Set(['has', 'hasLabel', 'hasId', 'hasNot', 'limit', 'range', 'fold', 'unfold', 'iterate', 'none', 'id', 'values', 'valueMap', 'elementMap', 'count', 'identity', 'as', 'select', 'toList', 'next']);

/** Decide a Gremlin Server request message (GraphSON 3). */
export function decodeGremlinRequest(message: unknown, map: readonly GraphPointMap[]): WriteDecode {
  if (!message || typeof message !== 'object') return { kind: 'malformed', because: 'not a request message' };
  const m = message as { op?: unknown; args?: { gremlin?: unknown } };
  if (m.op === 'authentication') return { kind: 'read' };
  if (m.op === 'eval') return { kind: 'privileged', what: 'a Gremlin script (op eval) cannot be checked: send bytecode' };
  if (m.op !== 'bytecode') return { kind: 'privileged', what: `op ${String(m.op)}` };
  let bc: unknown;
  try { bc = fromGraphSON(m.args?.gremlin as Json); } catch (e) { return { kind: 'malformed', because: (e as Error).message }; }
  if (!isTyped(bc, 'g:Bytecode')) return { kind: 'malformed', because: 'args.gremlin is not g:Bytecode' };
  return decodeBytecode((bc as { value: { step?: unknown[]; source?: unknown[] } }).value, map);
}

function containsLambda(x: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return true;
  if (isTyped(x, 'g:Lambda')) return true;
  if (Array.isArray(x)) return x.some((y) => containsLambda(y, depth + 1));
  if (x && typeof x === 'object') return Object.values(x).some((y) => containsLambda(y, depth + 1));
  return false;
}

export function decodeBytecode(bc: { step?: unknown[]; source?: unknown[] }, map: readonly GraphPointMap[]): WriteDecode {
  const steps = (bc.step ?? []) as unknown[][]; const sources = (bc.source ?? []) as unknown[][];
  if (!Array.isArray(steps) || steps.length > MAX_STEPS) return { kind: 'malformed', because: 'too many steps' };
  if (containsLambda(steps) || containsLambda(sources)) return { kind: 'privileged', what: 'a lambda cannot be checked' };
  for (const s of sources) if (Array.isArray(s) && (s[0] === 'withComputer' || s[0] === 'withRemote')) return { kind: 'privileged', what: `source step ${String(s[0])}` };
  const governedKeys = new Set(map.map((x) => x.key));
  let selected: string[] | null = null; // literal vertex ids, or null when the selection is not literal
  let onVertex = true;
  const writes: Array<{ point: string; value: PointValue }> = []; const unmapped: string[] = [];
  for (const [i, s] of steps.entries()) {
    if (!Array.isArray(s) || typeof s[0] !== 'string') return { kind: 'malformed', because: `step ${i} is not [name, ...args]` };
    const [name, ...args] = s as [string, ...unknown[]];
    if (args.some((a) => isTyped(a, 'g:Bytecode'))) {
      // nested traversals: allowed only inside filters; a nested traversal that writes is refused
      const nested = args.filter((a) => isTyped(a, 'g:Bytecode')).map((a) => decodeBytecode((a as { value: { step?: unknown[] } }).value, map));
      if (name === 'property') return { kind: 'privileged', what: 'a property value computed by a traversal cannot be checked' };
      if (nested.some((n) => n.kind !== 'read')) return { kind: 'privileged', what: `a nested traversal in ${name}() writes` };
    }
    if (MUTATING_PRIVILEGED.has(name)) return { kind: 'privileged', what: `${name}() changes the graph's structure` };
    if (name === 'V') {
      if (i !== 0) { selected = null; onVertex = true; continue; } // mid-traversal V(): not literal
      selected = args.length && args.every((a) => typeof a === 'string' || typeof a === 'number') ? args.map(String) : null;
      continue;
    }
    if (name === 'E' || name === 'outE' || name === 'inE' || name === 'bothE') { onVertex = false; selected = null; continue; }
    if (['out', 'in', 'both', 'outV', 'inV', 'bothV', 'otherV', 'repeat', 'union', 'coalesce', 'choose', 'local', 'flatMap', 'map', 'where', 'filter', 'not', 'and', 'or', 'optional', 'dedup', 'order', 'sample', 'tail', 'aggregate', 'group', 'groupCount', 'path', 'project', 'by', 'constant', 'inject', 'math', 'is', 'emit', 'until', 'times', 'cap', 'store', 'barrier'].includes(name)) { if (['out', 'in', 'both', 'outV', 'inV', 'bothV', 'otherV', 'repeat', 'union', 'coalesce', 'choose', 'flatMap', 'map', 'inject', 'constant'].includes(name)) { selected = null; onVertex = name !== 'map'; } continue; }
    if (name === 'property') {
      let a = args; if (isEnum(a[0], 'g:Cardinality')) a = a.slice(1);
      const [k, v, ...meta] = a;
      const key = isEnum(k, 'g:T') ? `T.${String(k.value)}` : typeof k === 'string' ? k : null;
      if (key === null) return { kind: 'malformed', because: 'property key is not a literal' };
      if (key.startsWith('T.')) return { kind: 'privileged', what: `setting ${key} changes element identity` };
      if (!literal(v)) return { kind: 'malformed', because: `property ${key}: value is not a literal` };
      if (meta.length % 2) return { kind: 'malformed', because: 'meta-properties come in key/value pairs' };
      if (!onVertex) { if (governedKeys.has(key)) return { kind: 'malformed', because: `governed key ${key} set on an edge` }; unmapped.push(`edge.${key}`); continue; }
      if (selected === null) {
        if (governedKeys.has(key)) return { kind: 'malformed', because: `governed property ${key} set on vertices not selected by literal id — a bulk write cannot be checked` };
        unmapped.push(`*.${key}`); continue;
      }
      for (const id of selected) {
        const hit = map.find((x) => x.vertexId === id && x.key === key);
        if (hit) writes.push({ point: hit.point, value: v }); else unmapped.push(`${id}.${key}`);
      }
      continue;
    }
    if (SAFE_FILTERS.has(name) || name === 'properties' || name === 'label' || name === 'key' || name === 'value') { if (name === 'properties') onVertex = false; continue; }
    return { kind: 'privileged', what: `step ${name}() is not on the checked list` };
  }
  return writes.length || unmapped.length ? { kind: 'write', writes, unmapped } : { kind: 'read' };
}

// ── Observations ──

/** GraphSON vertices (g:Vertex, or plain {id, properties}) → observations; the time from a meta-property (default "ts") or receivedAt. */
export function observationsFromGraph(vertices: unknown, map: readonly GraphPointMap[], o: { timeKey?: string; receivedAt?: number; source?: string } = {}): { observations: Observation[]; unmapped: string[] } {
  const list = fromGraphSON(vertices as Json); const out: Observation[] = []; const unmapped = new Set<string>();
  const arr = Array.isArray(list) ? list : [list];
  for (const raw of arr) {
    const vx = isTyped(raw, 'g:Vertex') ? (raw as { value: Record<string, unknown> }).value : (raw as Record<string, unknown>);
    if (!vx || typeof vx !== 'object') continue;
    const id = String(vx.id); const props = (vx.properties ?? {}) as Record<string, unknown[]>;
    for (const [key, vps] of Object.entries(props)) {
      const hit = map.find((x) => x.vertexId === id && x.key === key);
      if (!hit) { unmapped.add(`${id}.${key}`); continue; }
      for (const vp of Array.isArray(vps) ? vps : [vps]) {
        const p = isTyped(vp, 'g:VertexProperty') ? (vp as { value: Record<string, unknown> }).value : (vp as Record<string, unknown>);
        const value = p && typeof p === 'object' && 'value' in p ? p.value : vp;
        if (!literal(value)) continue;
        const meta = (p && typeof p === 'object' ? p.properties : undefined) as Record<string, unknown> | undefined;
        const t = meta?.[o.timeKey ?? 'ts']; const at = t && typeof t === 'object' && '$date' in t ? (t as { $date: number }).$date : typeof t === 'number' ? t : typeof t === 'string' ? Date.parse(t) : o.receivedAt ?? Date.now();
        out.push({ at: Number.isFinite(at) ? at : o.receivedAt ?? Date.now(), point: hit.point, value, source: o.source ?? `graph:${id}` });
      }
    }
  }
  return { observations: out, unmapped: [...unmapped].sort() };
}

// ── Drafting an envelope from a device graph ──

export interface GraphDraftMapping {
  /** Vertex label → point kind (only these vertices become points). */
  pointLabels: Record<string, PointKind>;
  /** Property keys on point vertices. */
  keys?: { unit?: string; min?: string; max?: string; maxStep?: string; maxGapMs?: string };
  /** Edge label meaning two points measure the same quantity (→ agreement); its tolerance property. */
  redundancy?: { label: string; toleranceKey?: string };
  /** Edge label from a setpoint/command to the value it drives (→ response); its window and deadband properties. */
  control?: { label: string; withinMsKey?: string; deadbandKey?: string };
}

export interface GraphDraft { points: ConstraintPoint[]; constraints: Constraint[]; needs: string[] }

export function draftEnvelopeFromGraph(graph: { vertices: unknown; edges: unknown }, m: GraphDraftMapping): GraphDraft {
  const vs = (fromGraphSON(graph.vertices as Json) as unknown[]).map((x) => (isTyped(x, 'g:Vertex') ? (x as { value: Record<string, unknown> }).value : (x as Record<string, unknown>)));
  const es = (fromGraphSON(graph.edges as Json) as unknown[]).map((x) => (isTyped(x, 'g:Edge') ? (x as { value: Record<string, unknown> }).value : (x as Record<string, unknown>)));
  const prop = (el: Record<string, unknown>, key?: string): unknown => {
    if (!key) return undefined; const p = (el.properties as Record<string, unknown> | undefined)?.[key];
    const first = Array.isArray(p) ? p[0] : p;
    const inner = isTyped(first, 'g:VertexProperty') || isTyped(first, 'g:Property') ? (first as { value: Record<string, unknown> }).value : first;
    return inner && typeof inner === 'object' && 'value' in inner ? (inner as { value: unknown }).value : inner;
  };
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
  const k = m.keys ?? {};
  const points: ConstraintPoint[] = []; const constraints: Constraint[] = []; const needs: string[] = [];
  const unitOf = new Map<string, string>();
  for (const v of vs) {
    const kind = m.pointLabels[String(v.label)]; if (!kind) continue;
    const id = String(v.id); const unit = prop(v, k.unit);
    if (typeof unit !== 'string') { needs.push(`point ${id}: unit (property ${k.unit ?? '<unit key not mapped>'})`); continue; }
    unitOf.set(id, unit);
    const gap = num(prop(v, k.maxGapMs));
    points.push({ id, kind, unit, ...(gap ? { maxGapMs: gap } : {}), ...(kind === 'setpoint' || kind === 'command' ? { failMode: 'hold-last-good' as const } : {}) });
    const lo = num(prop(v, k.min)); const hi = num(prop(v, k.max));
    if (lo !== undefined || hi !== undefined) constraints.push({ id: `${id}/range`, kind: 'range', points: [id], unit, ...(lo !== undefined ? { min: lo } : {}), ...(hi !== undefined ? { max: hi } : {}) });
    else needs.push(`point ${id}: limits (properties ${k.min ?? '?'} / ${k.max ?? '?'})`);
    const step = num(prop(v, k.maxStep));
    if (step !== undefined && kind !== 'measurement') constraints.push({ id: `${id}/step`, kind: 'rate', points: [id], unit, maxStep: step });
  }
  const known = new Set(points.map((p) => p.id));
  for (const e of es) {
    const label = String(e.label); const a = String(e.outV); const b = String(e.inV);
    if (m.redundancy && label === m.redundancy.label) {
      if (!known.has(a) || !known.has(b)) { needs.push(`redundancy ${a}–${b}: both ends must be point vertices`); continue; }
      const tol = num(prop(e, m.redundancy.toleranceKey));
      if (tol === undefined) { needs.push(`redundancy ${a}–${b}: tolerance (edge property ${m.redundancy.toleranceKey ?? '?'})`); continue; }
      constraints.push({ id: `${a}~${b}/agree`, kind: 'agreement', points: [a, b], unit: unitOf.get(a)!, tolerance: tol });
    }
    if (m.control && label === m.control.label) {
      if (!known.has(a) || !known.has(b)) { needs.push(`control ${a}→${b}: both ends must be point vertices`); continue; }
      const within = num(prop(e, m.control.withinMsKey)); const dead = num(prop(e, m.control.deadbandKey));
      if (within === undefined || dead === undefined) { needs.push(`control ${a}→${b}: response window and deadband (edge properties ${m.control.withinMsKey ?? '?'} / ${m.control.deadbandKey ?? '?'})`); continue; }
      constraints.push({ id: `${a}->${b}/response`, kind: 'response', points: [a, b], unit: unitOf.get(b)!, withinMs: within, deadband: dead });
    }
  }
  // agreement merges: several redundancy edges among the same group become one constraint per edge (explicit, verifiable)
  return { points, constraints, needs };
}
