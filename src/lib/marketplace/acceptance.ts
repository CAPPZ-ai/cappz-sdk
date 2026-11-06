/**
 * COPE node crystallized. Node ID: v15-32-00-marketplace-acceptance.
 * Provenance: m/44'/144'/100'/principles/cope/v1#marketplace
 *
 * Acceptance criteria: what a stage's deliverable must satisfy, written as data
 * the parties agree to when the contract forms (a listing's or request's
 * milestone carries them; formation copies them into the contract's terms).
 * The milestone's `evidence` text stays display-only and is never parsed: an
 * evaluator checks only these explicit criteria.
 *
 * Rule criteria are checked by code anyone can re-run (stageEvaluation.ts).
 * A `rubric` criterion is a yes/no question a model may answer; without a
 * judge, or when the model cannot quote the deliverable, it is left to a
 * person (`needs-human`), never guessed.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { canonicalJson } from './counterpartyCheck';

export type MediaClass = 'application/pdf' | 'image/png' | 'image/jpeg' | 'application/zip' | 'application/json' | 'text/plain' | 'text/markdown' | 'text/csv';
export const MEDIA_CLASSES: readonly MediaClass[] = ['application/pdf', 'image/png', 'image/jpeg', 'application/zip', 'application/json', 'text/plain', 'text/markdown', 'text/csv'];

export type AcceptanceCriterion =
  | { id: string; kind: 'media-type'; anyOf: MediaClass[] }
  | { id: string; kind: 'size'; minBytes?: number; maxBytes?: number }
  | { id: string; kind: 'json'; requiredKeys?: string[] }
  | { id: string; kind: 'words'; min?: number; max?: number }
  | { id: string; kind: 'sections'; headings: string[] }
  | { id: string; kind: 'contains'; text: string[]; caseSensitive?: boolean }
  | { id: string; kind: 'excludes'; text: string[]; caseSensitive?: boolean }
  | { id: string; kind: 'rubric'; question: string };

export type CriterionKind = AcceptanceCriterion['kind'];
export const RULE_KINDS: readonly CriterionKind[] = ['media-type', 'size', 'json', 'words', 'sections', 'contains', 'excludes'];

export interface AcceptanceSpec { version: 1; criteria: AcceptanceCriterion[] }

export const MAX_CRITERIA = 20;
const MAX_TEXT = 500;

/** Every reason the spec is unusable (empty = fine). Pure: the same check runs in the engine, the tool and the evaluator. */
export function acceptanceProblems(spec: unknown): string[] {
  const p: string[] = [];
  const s = spec as Partial<AcceptanceSpec> | null;
  if (!s || typeof s !== 'object') return ['Acceptance criteria must be an object: {"version": 1, "criteria": […]}.'];
  if (s.version !== 1) p.push('Acceptance criteria need "version": 1.');
  if (!Array.isArray(s.criteria) || !s.criteria.length) return [...p, 'List at least one criterion in "criteria".'];
  if (s.criteria.length > MAX_CRITERIA) p.push(`At most ${MAX_CRITERIA} criteria.`);
  const ids = new Set<string>();
  const str = (v: unknown) => typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_TEXT;
  const strs = (v: unknown) => Array.isArray(v) && v.length > 0 && v.length <= 20 && v.every(str);
  const nonneg = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isInteger(v) && v >= 0);
  s.criteria.forEach((c, i) => {
    const at = `Criterion ${i + 1}`;
    if (!c || typeof c !== 'object') { p.push(`${at} is not an object.`); return; }
    if (!str(c.id) || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(c.id)) p.push(`${at}: "id" is lowercase letters, digits and dashes (up to 40).`);
    else if (ids.has(c.id)) p.push(`${at}: id "${c.id}" is used twice.`); else ids.add(c.id);
    switch (c.kind) {
      case 'media-type': if (!Array.isArray(c.anyOf) || !c.anyOf.length || !c.anyOf.every((m) => MEDIA_CLASSES.includes(m))) p.push(`${at}: "anyOf" lists media types from ${MEDIA_CLASSES.join(', ')}.`); break;
      case 'size': if (!nonneg(c.minBytes) || !nonneg(c.maxBytes) || (c.minBytes === undefined && c.maxBytes === undefined) || (c.minBytes ?? 0) > (c.maxBytes ?? Infinity)) p.push(`${at}: give "minBytes" and/or "maxBytes" (whole numbers, min ≤ max).`); break;
      case 'json': if (c.requiredKeys !== undefined && !strs(c.requiredKeys)) p.push(`${at}: "requiredKeys" lists key paths such as "summary" or "items.0.id".`); break;
      case 'words': if (!nonneg(c.min) || !nonneg(c.max) || (c.min === undefined && c.max === undefined) || (c.min ?? 0) > (c.max ?? Infinity)) p.push(`${at}: give "min" and/or "max" words (whole numbers, min ≤ max).`); break;
      case 'sections': if (!strs(c.headings)) p.push(`${at}: "headings" lists the section headings the deliverable must have.`); break;
      case 'contains': case 'excludes': if (!strs(c.text)) p.push(`${at}: "text" lists the phrases to look for.`); break;
      case 'rubric': if (!str(c.question)) p.push(`${at}: "question" is one yes/no question about the deliverable (up to ${MAX_TEXT} characters).`); break;
      default: p.push(`${at}: unknown kind "${(c as { kind?: unknown }).kind}". Kinds: ${[...RULE_KINDS, 'rubric'].join(', ')}.`);
    }
  });
  return p;
}

/** The spec, checked; throws with every problem. */
export function parseAcceptance(spec: unknown): AcceptanceSpec {
  const p = acceptanceProblems(spec);
  if (p.length) throw new Error(`Acceptance criteria rejected: ${p.join(' ')}`);
  return spec as AcceptanceSpec;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
/** SHA-256 of the canonical JSON: the id both parties, the evaluator and the verdict cite. */
export const acceptanceHash = (spec: AcceptanceSpec): string => hex(sha256(new TextEncoder().encode(canonicalJson(spec))));

/** Whether the spec needs a model (rubric criteria) — priced and disclosed by the evaluator. */
export const needsJudge = (spec: AcceptanceSpec) => spec.criteria.some((c) => c.kind === 'rubric');
