/**
 * COPE node crystallized. Node ID: v15-32-00-stage-evaluation.
 * Provenance: m/44'/144'/100'/principles/cope/v1#marketplace
 *
 * Stage evaluation: does a delivered file meet the acceptance criteria agreed
 * for its milestone? The evaluator (the contract's named `evaluatorId`, or
 * anyone a party hires for a second opinion) receives the file directly from a
 * party — never from the public log, which holds only its SHA-256 — and answers
 * a signed verdict: pass / fail / needs-human, criterion by criterion.
 *
 * Trust boundaries kept apart in the verdict:
 *  - `evidence`: the file's hash against the seller's MilestoneEvidenced hash
 *    on the public log (a fact anyone can recompute);
 *  - `criteria.source`: `contract` (frozen in the terms both sides agreed) or
 *    `requester` (supplied by whoever hired the evaluator — a second opinion,
 *    not an agreed standard);
 *  - per result `judgedBy`: `rule` (code anyone can re-run) or `model` (a
 *    rubric answer, which counts as a pass only when its quote is found
 *    verbatim in the deliverable).
 *
 * A verdict is advice and evidence. It moves no money: a named evaluator may
 * then `accept` (MilestoneAffirmed, citing the verdict); the buyer still pays.
 */
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2.js';
import type { XrplNetwork } from '../xrpl/ledgerCheck';
import type { MarketState } from './replay';
import type { ContractView, MilestoneState } from './types';
import { canonicalJson } from './counterpartyCheck';
import { verdictAddress } from './MarketplacePaths';
import { acceptanceHash, parseAcceptance, type AcceptanceCriterion, type AcceptanceSpec, type MediaClass } from './acceptance';

export const VERDICT_DOMAIN = 'cappz-stage-verdict/v1\n';
export const VERDICT_RULES = 'https://github.com/CAPPZ-ai/cappz-sdk/blob/main/src/lib/marketplace/stageEvaluation.ts';
/** Above this many characters the rubric is not sent to a model (cost and attention); rule criteria still run. */
export const DEFAULT_MAX_JUDGE_CHARS = 40_000;
/** Largest deliverable the hosted evaluator accepts (bytes). */
export const MAX_DELIVERABLE_BYTES = 1_000_000;

export type CriterionState = 'pass' | 'fail' | 'needs-human';
export interface CriterionResult { id: string; kind: AcceptanceCriterion['kind']; state: CriterionState; judgedBy: 'rule' | 'model' | 'none'; detail: string; quote?: string }
export type VerdictState = 'pass' | 'fail' | 'needs-human';

export interface StageVerdict {
  kind: 'cappz-stage-verdict';
  version: 1;
  network: XrplNetwork;
  address: string;
  contractId: string;
  milestone: number;
  milestoneLabel: string;
  deliverableSha256: string;
  media: MediaClass | 'unknown';
  evidence: { evidenceSha256: string | null; matched: boolean; milestoneState: MilestoneState };
  criteria: { source: 'contract' | 'requester'; specSha256: string; spec: AcceptanceSpec };
  results: CriterionResult[];
  verdict: { state: VerdictState; failedBy: 'rule' | 'model' | null; reasons: string[] };
  /** The model that answered rubric criteria, for transparency (null when none ran). */
  judge: string | null;
  evaluatedAt: string;
  rules: string;
}
export interface SignedVerdict { verdict: StageVerdict; signature: { alg: 'Ed25519'; publicKey: string; value: string } }

export interface RubricAnswer { id: string; answer: 'yes' | 'no' | 'unsure'; quote: string; reason: string }
/** A model port: answers yes/no questions about a text, quoting it. The worker supplies one; the library never calls a vendor. */
export interface RubricJudge { model: string; answer(req: { text: string; questions: Array<{ id: string; question: string }> }): Promise<RubricAnswer[]> }

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
export const deliverableSha256Of = (bytes: Uint8Array) => hex(sha256(bytes));

/** What the file is, from its bytes (never from a name or a claimed type), and its text when it is UTF-8 text. */
export function detectMedia(bytes: Uint8Array): { media: MediaClass | 'unknown'; text: string | null } {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return { media: 'application/pdf', text: null };
  if (starts(0x89, 0x50, 0x4e, 0x47)) return { media: 'image/png', text: null };
  if (starts(0xff, 0xd8, 0xff)) return { media: 'image/jpeg', text: null };
  if (starts(0x50, 0x4b, 0x03, 0x04)) return { media: 'application/zip', text: null };
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { media: 'unknown', text: null }; }
  if (text.includes('\u0000')) return { media: 'unknown', text: null };
  const t = text.trim();
  if ((t.startsWith('{') || t.startsWith('[')) && (() => { try { JSON.parse(t); return true; } catch { return false; } })()) return { media: 'application/json', text };
  return { media: /^#{1,6}\s/m.test(text) ? 'text/markdown' : 'text/plain', text };
}

/** Text media satisfy each other's text classes: Markdown and CSV are plain text with conventions. */
const mediaMatches = (got: MediaClass | 'unknown', want: MediaClass) => got === want || (['text/plain', 'text/markdown', 'text/csv'].includes(want) && ['text/plain', 'text/markdown'].includes(got));
const words = (t: string) => (t.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
const norm = (s: string, cs = false) => { const x = s.replace(/\s+/g, ' ').trim(); return cs ? x : x.toLowerCase(); };
const headingsOf = (t: string) => t.split(/\r?\n/).map((l) => l.replace(/^\s*#{1,6}\s*/, '').replace(/[:：]\s*$/, '').trim()).filter(Boolean).map((l) => norm(l));
function keyPath(v: unknown, path: string): boolean {
  let cur: unknown = v;
  for (const k of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(k in (cur as Record<string, unknown>))) return false;
    cur = (cur as Record<string, unknown>)[k];
  }
  return true;
}

export interface EvaluationTarget { contract: ContractView; milestone: number; spec: AcceptanceSpec; source: 'contract' | 'requester'; evidenceSha256: string; deliverableSha256: string }

/**
 * Everything that must hold before anyone is charged: the contract and milestone exist, the seller published
 * evidence for it, the file is that evidence (hash match), and there are criteria — the contract's when it has them
 * (a requester's criteria are then ignored, and said so), else the requester's. Throws a plain refusal otherwise.
 */
export function evaluationTarget(state: MarketState, req: { contractId: string; milestone?: number; deliverableSha256: string; acceptance?: unknown }): EvaluationTarget & { notes: string[] } {
  const c = state.contracts.find((k) => k.contractId === req.contractId);
  if (!c) throw new Error(`No contract ${req.contractId} on this market.`);
  const n = req.milestone ?? c.milestoneStates.find((m) => m.state === 'evidenced')?.index;
  if (n === undefined) throw new Error(`${c.contractId} has no stage with new evidence to evaluate. The seller delivers first (cappz-market deliver).`);
  const ms = c.milestoneStates[n];
  if (!ms) throw new Error(`${c.contractId} has no milestone ${n}.`);
  const ev = ms.evidence[ms.evidence.length - 1];
  if (!ev) throw new Error(`“${c.milestones[n].label}” has no evidence yet. The seller delivers first (cappz-market deliver).`);
  if (!/^[0-9a-f]{64}$/.test(req.deliverableSha256)) throw new Error('deliverableSha256 must be the file’s SHA-256 (hex).');
  if (ev.hash !== req.deliverableSha256) throw new Error(`This file is not the evidence the seller published for “${c.milestones[n].label}” (log ${ev.hash.slice(0, 12)}…, file ${req.deliverableSha256.slice(0, 12)}…). Nothing was evaluated or charged.`);
  const notes: string[] = [];
  const agreed = c.milestones[n].acceptance;
  if (agreed) {
    if (req.acceptance !== undefined) notes.push('The contract carries agreed acceptance criteria for this milestone; the criteria you sent were not used.');
    return { contract: c, milestone: n, spec: parseAcceptance(agreed), source: 'contract', evidenceSha256: ev.hash, deliverableSha256: req.deliverableSha256, notes };
  }
  if (req.acceptance === undefined) throw new Error(`“${c.milestones[n].label}” has no agreed acceptance criteria. Send your own ("acceptance": {"version": 1, "criteria": […]}): the verdict then says they came from you, not from the contract.`);
  return { contract: c, milestone: n, spec: parseAcceptance(req.acceptance), source: 'requester', evidenceSha256: ev.hash, deliverableSha256: req.deliverableSha256, notes };
}

/** Rule criteria over the bytes; rubric criteria through the judge when one is given and the text fits. */
export async function evaluateDeliverable(t: EvaluationTarget, bytes: Uint8Array, o: { network: XrplNetwork; now?: string; judge?: RubricJudge | null; maxJudgeChars?: number }): Promise<StageVerdict> {
  if (deliverableSha256Of(bytes) !== t.deliverableSha256) throw new Error('The bytes do not match deliverableSha256.');
  const { media, text } = detectMedia(bytes);
  const results: CriterionResult[] = [];
  const noText = (c: AcceptanceCriterion): CriterionResult => ({ id: c.id, kind: c.kind, state: 'needs-human', judgedBy: 'none', detail: `The deliverable is ${media}, not text this evaluator can read; a person checks this criterion.` });
  for (const c of t.spec.criteria) {
    switch (c.kind) {
      case 'media-type': { const ok = c.anyOf.some((m) => mediaMatches(media, m)); results.push({ id: c.id, kind: c.kind, state: ok ? 'pass' : 'fail', judgedBy: 'rule', detail: `Detected ${media}; wanted ${c.anyOf.join(' or ')}.` }); break; }
      case 'size': { const ok = bytes.length >= (c.minBytes ?? 0) && bytes.length <= (c.maxBytes ?? Infinity); results.push({ id: c.id, kind: c.kind, state: ok ? 'pass' : 'fail', judgedBy: 'rule', detail: `${bytes.length} bytes; wanted ${c.minBytes ?? 0}–${c.maxBytes ?? '∞'}.` }); break; }
      case 'json': {
        if (media !== 'application/json' || text === null) { results.push({ id: c.id, kind: c.kind, state: 'fail', judgedBy: 'rule', detail: `Not valid JSON (detected ${media}).` }); break; }
        const v = JSON.parse(text.trim()) as unknown; const missing = (c.requiredKeys ?? []).filter((k) => !keyPath(v, k));
        results.push({ id: c.id, kind: c.kind, state: missing.length ? 'fail' : 'pass', judgedBy: 'rule', detail: missing.length ? `Missing keys: ${missing.join(', ')}.` : `Valid JSON${c.requiredKeys?.length ? ` with ${c.requiredKeys.join(', ')}` : ''}.` }); break;
      }
      case 'words': { if (text === null) { results.push(noText(c)); break; } const w = words(text); const ok = w >= (c.min ?? 0) && w <= (c.max ?? Infinity); results.push({ id: c.id, kind: c.kind, state: ok ? 'pass' : 'fail', judgedBy: 'rule', detail: `${w} words; wanted ${c.min ?? 0}–${c.max ?? '∞'}.` }); break; }
      case 'sections': { if (text === null) { results.push(noText(c)); break; } const hs = new Set(headingsOf(text)); const missing = c.headings.filter((h) => !hs.has(norm(h))); results.push({ id: c.id, kind: c.kind, state: missing.length ? 'fail' : 'pass', judgedBy: 'rule', detail: missing.length ? `Missing sections: ${missing.join(', ')}.` : `All ${c.headings.length} sections present.` }); break; }
      case 'contains': case 'excludes': {
        if (text === null) { results.push(noText(c)); break; }
        const hay = norm(text, c.caseSensitive); const found = c.text.filter((x) => hay.includes(norm(x, c.caseSensitive)));
        const ok = c.kind === 'contains' ? found.length === c.text.length : found.length === 0;
        results.push({ id: c.id, kind: c.kind, state: ok ? 'pass' : 'fail', judgedBy: 'rule', detail: c.kind === 'contains' ? (ok ? 'All phrases found.' : `Not found: ${c.text.filter((x) => !found.includes(x)).join('; ')}.`) : (ok ? 'None of the phrases found.' : `Found: ${found.join('; ')}.`) }); break;
      }
      case 'rubric': results.push({ id: c.id, kind: c.kind, state: 'needs-human', judgedBy: 'none', detail: 'Not judged yet.' }); break;
    }
  }
  // Rubric questions: one model call for all of them, only on readable text that fits.
  const rubric = t.spec.criteria.filter((c): c is Extract<AcceptanceCriterion, { kind: 'rubric' }> => c.kind === 'rubric');
  let judgeName: string | null = null;
  if (rubric.length) {
    const max = o.maxJudgeChars ?? DEFAULT_MAX_JUDGE_CHARS;
    const why = text === null ? `The deliverable is ${media}, not text a model can read here; a person answers these questions.`
      : !o.judge ? 'No model is configured for rubric questions; a person answers them.'
      : text.length > max ? `The deliverable has ${text.length} characters, over the ${max} sent to a model; a person answers these questions.` : null;
    if (why) for (const c of rubric) Object.assign(results.find((r) => r.id === c.id)!, { detail: why });
    else {
      judgeName = o.judge!.model;
      let answers: RubricAnswer[] = [];
      try { answers = await o.judge!.answer({ text: text!, questions: rubric.map((c) => ({ id: c.id, question: c.question })) }); }
      catch (e) { for (const c of rubric) Object.assign(results.find((r) => r.id === c.id)!, { detail: `The model could not answer (${(e as Error).message}); a person answers this question.` }); }
      const hay = norm(text!);
      for (const c of rubric) {
        const a = answers.find((x) => x.id === c.id); const r = results.find((x) => x.id === c.id)!;
        if (!a) continue;
        const quoted = !!a.quote?.trim() && hay.includes(norm(a.quote));
        if (a.answer === 'yes' && quoted) Object.assign(r, { state: 'pass', judgedBy: 'model', detail: a.reason, quote: a.quote });
        else if (a.answer === 'no') Object.assign(r, { state: 'fail', judgedBy: 'model', detail: a.reason, ...(quoted ? { quote: a.quote } : {}) });
        else Object.assign(r, { state: 'needs-human', judgedBy: 'model', detail: a.answer === 'yes' ? `The model said yes but its quote is not in the deliverable, so it does not count: ${a.reason}` : `The model was unsure: ${a.reason}` });
      }
    }
  }
  const ruleFail = results.filter((r) => r.state === 'fail' && r.judgedBy === 'rule');
  const modelFail = results.filter((r) => r.state === 'fail' && r.judgedBy === 'model');
  const open = results.filter((r) => r.state === 'needs-human');
  const state: VerdictState = ruleFail.length || modelFail.length ? 'fail' : open.length ? 'needs-human' : 'pass';
  const reasons = state === 'pass' ? [`All ${results.length} criteria met.`] : [...ruleFail, ...modelFail, ...open].map((r) => `${r.id}: ${r.detail}`);
  return {
    kind: 'cappz-stage-verdict', version: 1, network: o.network, address: verdictAddress(t.contract.contractId, t.milestone, t.deliverableSha256),
    contractId: t.contract.contractId, milestone: t.milestone, milestoneLabel: t.contract.milestones[t.milestone].label, deliverableSha256: t.deliverableSha256, media,
    evidence: { evidenceSha256: t.evidenceSha256, matched: t.evidenceSha256 === t.deliverableSha256, milestoneState: t.contract.milestoneStates[t.milestone].state },
    criteria: { source: t.source, specSha256: acceptanceHash(t.spec), spec: t.spec },
    results, verdict: { state, failedBy: ruleFail.length ? 'rule' : modelFail.length ? 'model' : null, reasons }, judge: judgeName,
    evaluatedAt: o.now ?? new Date().toISOString(), rules: VERDICT_RULES,
  };
}

/** Signed under its own domain, so a verdict can never be replayed as a check report or a signing approval made with the same key. */
export function signVerdict(verdict: StageVerdict, seedHex: string): SignedVerdict {
  const seed = unhex(seedHex);
  return { verdict, signature: { alg: 'Ed25519', publicKey: hex(ed25519.getPublicKey(seed)), value: hex(ed25519.sign(new TextEncoder().encode(VERDICT_DOMAIN + canonicalJson(verdict)), seed)) } };
}

export function verifyVerdict(signed: SignedVerdict, expectedPublicKey?: string): boolean {
  if (expectedPublicKey && signed.signature.publicKey.toLowerCase() !== expectedPublicKey.toLowerCase()) return false;
  try { return ed25519.verify(unhex(signed.signature.value), new TextEncoder().encode(VERDICT_DOMAIN + canonicalJson(signed.verdict)), unhex(signed.signature.publicKey)); } catch { return false; }
}

/** SHA-256 of the signed verdict's canonical JSON: what an evaluator's MilestoneAffirmed cites. */
export const verdictSha256 = (signed: SignedVerdict) => deliverableSha256Of(new TextEncoder().encode(canonicalJson(signed)));

/**
 * Whether a named evaluator may accept the stage on this verdict: signed by the expected key, a pass, on the agreed
 * criteria (a requester's own criteria are a second opinion, not the agreed standard), for the evidence that is
 * still the stage's latest, and the stage is still waiting for acceptance.
 */
export function verdictSupportsAcceptance(state: MarketState, signed: SignedVerdict, expectedPublicKey: string): { ok: boolean; because: string } {
  const v = signed.verdict;
  if (!verifyVerdict(signed, expectedPublicKey)) return { ok: false, because: 'The verdict’s signature does not match the evaluator service’s published key.' };
  if (v.verdict.state !== 'pass') return { ok: false, because: `The verdict is ${v.verdict.state}: ${v.verdict.reasons.join(' ')}` };
  if (v.criteria.source !== 'contract') return { ok: false, because: 'The verdict used criteria the requester supplied, not criteria agreed in the contract; accept by your own review instead.' };
  const c = state.contracts.find((k) => k.contractId === v.contractId);
  const ms = c?.milestoneStates[v.milestone];
  if (!c || !ms) return { ok: false, because: 'The contract or milestone is not on this market.' };
  if (ms.state !== 'evidenced') return { ok: false, because: `“${c.milestones[v.milestone].label}” is ${ms.state}, not waiting for acceptance.` };
  if (ms.evidence[ms.evidence.length - 1]?.hash !== v.deliverableSha256) return { ok: false, because: 'The seller has published newer evidence since this verdict; evaluate the new file.' };
  if (!c.milestones[v.milestone].acceptance || acceptanceHash(c.milestones[v.milestone].acceptance!) !== v.criteria.specSha256) return { ok: false, because: 'The verdict’s criteria are not the contract’s agreed criteria.' };
  return { ok: true, because: `Signed pass on the contract’s agreed criteria for the current evidence of “${c.milestones[v.milestone].label}”.` };
}
