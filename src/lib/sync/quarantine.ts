/**
 * COPE node crystallized.
 * Node ID: v15-09-00-dmz-quarantine
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * DMZ quarantine (dmz-quarantine.bpmn). Files from senders that do not speak
 * CPZ1 — plain HTTP POST/PUT drops, FTP/FTPS/SFTP pulls — land in a DMZ
 * node's quarantine by content hash. Checks run locally; each is recorded with
 * its result and reason (pass | fail | not-evaluated, never a silent pass).
 * A file is released to internal clients only when every required check
 * passed, or when a listed operator decides; a failed check rejects it.
 * Internal clients fetch released files from the DMZ node (they dial out to
 * it; the DMZ never dials in).
 *
 * State is replayed from the node's signed TX log (edge-txs.jsonl, the same
 * UnsignedEdgeTx → signEdgeTx shape as jobs), never kept as a status map:
 * every state carries the TX that put it there.
 */

import { dmzQuarantineAddress } from '../wallets/paths.ts';
import type { UnsignedEdgeTx } from '../functions/edgeJobs.ts';
import type { EdgeVerdict } from '../identity/edgeVerify.ts';

export const DMZ_PRINCIPLE = "m/44'/144'/100'/principles/cope/v1#local-first";
export const DMZ_QUARANTINE_BPMN = "m/44'/144'/100'/bpmn/substrate/dmz-quarantine";
export const DMZ_EVENT_TYPES = ['ContentQuarantined', 'QuarantineCheckRecorded', 'ContentReleased', 'ContentRejected'] as const;

/** ftps = pulled from a partner server; ftps-push = uploaded to this node's FTPS face (v15-10-00). */
export type QuarantineSourceKind = 'http-drop' | 'ftps' | 'sftp' | 'ftps-push';
export type CheckName = 'hash' | 'size-limit' | 'type-sniff' | 'sender-signature' | 'malware-scan';
export type CheckResult = 'pass' | 'fail' | 'not-evaluated';

export interface QuarantineSource {
  kind: QuarantineSourceKind;
  /** Transport type MDM address (transportTypes.ts) of the carrier it arrived on. */
  transportType?: string;
  /** Who sent it, as far as known: a verified wallet, or the remote it was pulled from (credentials never recorded). */
  sender?: string;
  remote?: string;
  /** Edge verification of the sending request, when it was signed. */
  verdict?: Pick<EdgeVerdict, 'signature' | 'trust' | 'content' | 'walletAddress' | 'keyId'>;
  /** Content-Digest the sender declared (hex), when it declared one. */
  declaredSha256?: string;
}

export interface QuarantinePolicy {
  maxBytes: number;
  /** Checks that must pass before automatic release. */
  required: readonly CheckName[];
  /** Detected types allowed through (type-sniff); empty = any non-executable. */
  allowedTypes?: readonly string[];
  /** Operator wallets whose decisions are accepted. */
  operators: readonly string[];
}

export const DEFAULT_QUARANTINE_POLICY: QuarantinePolicy = { maxBytes: 64 * 1024 * 1024, required: ['hash', 'size-limit', 'type-sniff'], operators: [] };

const tx = (nodeAddress: string, sha256: string, eventType: (typeof DMZ_EVENT_TYPES)[number], payload: Record<string, unknown>, at: number): UnsignedEdgeTx => ({
  txId: `${eventType}-${sha256.slice(0, 16)}-${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  timestamp: new Date(at).toISOString(), eventType, sourceAddress: nodeAddress, targetAddress: dmzQuarantineAddress(nodeAddress, sha256),
  payload: { sha256, ...payload, bpmnPath: DMZ_QUARANTINE_BPMN, governingPrinciple: DMZ_PRINCIPLE },
});

// ─── Type sniffing (magic bytes; no execution, no parsing) ───────

const MAGIC: Array<{ type: string; test: (b: Uint8Array) => boolean }> = [
  { type: 'application/x-executable', test: (b) => (b[0] === 0x4d && b[1] === 0x5a) || (b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) || (b[0] === 0xcf && b[1] === 0xfa && b[2] === 0xed && b[3] === 0xfe) },
  { type: 'application/pdf', test: (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 },
  { type: 'image/png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { type: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'application/zip', test: (b) => b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5) },
  { type: 'application/gzip', test: (b) => b[0] === 0x1f && b[1] === 0x8b },
];

export function sniffType(bytes: Uint8Array): string {
  for (const m of MAGIC) if (bytes.length >= 4 && m.test(bytes)) return m.type;
  const head = bytes.subarray(0, 4096);
  if (head.includes(0)) return 'application/octet-stream';
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(head.length < bytes.length ? head.subarray(0, lastCharBoundary(head)) : head); } catch { return 'application/octet-stream'; }
  const t = text.trimStart();
  if (t.startsWith('<?xml') || t.startsWith('<Document') || /^<[A-Za-z][\w:.-]*[\s>]/.test(t)) return 'application/xml';
  if (t.startsWith('{') || t.startsWith('[')) return 'application/json';
  return 'text/plain';
}

/** Cut a prefix at a UTF-8 character boundary so a truncated multibyte char is not misread as binary. */
function lastCharBoundary(b: Uint8Array): number {
  let i = b.length;
  while (i > 0 && (b[i - 1] & 0xc0) === 0x80) i--;
  return i > 0 && b[i - 1] >= 0xc0 ? i - 1 : b.length;
}

// ─── Intake and checks ────────────────────────────────────────────

export interface IntakeResult { txs: UnsignedEdgeTx[]; sha256: string; decision: 'released' | 'rejected' | 'held'; because: string }

/**
 * Take one file in: record it, run the local checks, and decide by policy.
 * External checks (malware scanners) are passed in as results; without one
 * the check is 'not-evaluated' — which holds the file if policy requires it.
 */
export async function intakeQuarantined(o: {
  nodeAddress: string; bytes: Uint8Array; name: string; declaredType?: string; source: QuarantineSource;
  policy?: QuarantinePolicy; external?: Partial<Record<CheckName, { result: CheckResult; reason: string }>>; now?: number;
}): Promise<IntakeResult> {
  const policy = o.policy ?? DEFAULT_QUARANTINE_POLICY;
  let at = o.now ?? Date.now();
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', o.bytes.slice().buffer)), (b) => b.toString(16).padStart(2, '0')).join('');
  const detected = sniffType(o.bytes);
  const txs: UnsignedEdgeTx[] = [tx(o.nodeAddress, sha256, 'ContentQuarantined', {
    name: o.name.replace(/[^\w.\- ]+/g, '_').slice(0, 200), size: o.bytes.length, declaredType: o.declaredType ?? null, detectedType: detected, source: o.source,
  }, at)];
  const checks: Array<{ check: CheckName; result: CheckResult; reason: string }> = [];
  checks.push(o.source.declaredSha256
    ? (o.source.declaredSha256 === sha256 ? { check: 'hash', result: 'pass', reason: 'matches the Content-Digest the sender declared' } : { check: 'hash', result: 'fail', reason: 'does not match the Content-Digest the sender declared' })
    : { check: 'hash', result: 'pass', reason: 'content-addressed on receipt (sender declared no digest)' });
  checks.push(o.bytes.length <= policy.maxBytes ? { check: 'size-limit', result: 'pass', reason: `${o.bytes.length} ≤ ${policy.maxBytes} bytes` } : { check: 'size-limit', result: 'fail', reason: `${o.bytes.length} > ${policy.maxBytes} bytes` });
  if (detected === 'application/x-executable') checks.push({ check: 'type-sniff', result: 'fail', reason: 'executable content is never released from the DMZ' });
  else if (policy.allowedTypes?.length && !policy.allowedTypes.includes(detected)) checks.push({ check: 'type-sniff', result: 'fail', reason: `${detected} is not an allowed type` });
  else if (o.declaredType && !compatibleType(o.declaredType, detected)) checks.push({ check: 'type-sniff', result: 'fail', reason: `declared ${o.declaredType} but the bytes are ${detected}` });
  else checks.push({ check: 'type-sniff', result: 'pass', reason: `bytes are ${detected}` });
  const v = o.source.verdict;
  const signedOk = v && (v.signature === 'verified' || v.signature === 'mtls');
  checks.push(!v || v.signature === 'unsigned'
    ? { check: 'sender-signature', result: 'not-evaluated', reason: 'legacy sender: the request was not signed' }
    : signedOk && ['declared', 'delegated', 'operator-listed'].includes(v.trust)
      ? { check: 'sender-signature', result: 'pass', reason: `${v.signature}, key ${v.trust}` }
      // A valid signature from a key no wallet vouched for says nothing about the sender: same as unsigned, not worse.
      : signedOk && v.trust === 'undeclared'
        ? { check: 'sender-signature', result: 'not-evaluated', reason: `${v.signature}, but no wallet declared the key` }
        : { check: 'sender-signature', result: 'fail', reason: `${v.signature}, key ${v.trust}` });
  const scan = o.external?.['malware-scan'];
  checks.push(scan ? { check: 'malware-scan', ...scan } : { check: 'malware-scan', result: 'not-evaluated', reason: 'no scanner configured on this node' });
  for (const c of checks) txs.push(tx(o.nodeAddress, sha256, 'QuarantineCheckRecorded', c, ++at));
  // Any failed check rejects, required or not: a failed scan or a bad signature never slips through.
  const failed = checks.find((c) => c.result === 'fail');
  if (failed) {
    txs.push(tx(o.nodeAddress, sha256, 'ContentRejected', { decidedBy: 'policy', because: `${failed.check}: ${failed.reason}` }, ++at));
    return { txs, sha256, decision: 'rejected', because: `${failed.check}: ${failed.reason}` };
  }
  const waiting = policy.required.filter((r) => checks.find((c) => c.check === r)?.result !== 'pass');
  if (waiting.length) return { txs, sha256, decision: 'held', because: `waiting on ${waiting.join(', ')} (not evaluated); an operator decides` };
  txs.push(tx(o.nodeAddress, sha256, 'ContentReleased', { decidedBy: 'policy', because: `every required check passed (${policy.required.join(', ')})` }, ++at));
  return { txs, sha256, decision: 'released', because: 'every required check passed' };
}

function compatibleType(declared: string, detected: string): boolean {
  const d = declared.split(';')[0].trim().toLowerCase();
  if (d === detected || d === 'application/octet-stream') return true;
  if (detected === 'text/plain') return d.startsWith('text/') || d === 'application/csv';
  if (detected === 'application/xml') return d === 'text/xml' || d.endsWith('+xml');
  if (detected === 'application/json') return d.endsWith('+json') || d === 'text/plain';
  if (detected === 'application/zip') return /officedocument|opendocument|\+zip|jar$/.test(d);
  return false;
}

/** An operator decision on a held (or wrongly rejected) file. The operator must be listed in the policy. */
export function operatorDecision(nodeAddress: string, sha256: string, decision: 'release' | 'reject', operator: string, because: string, policy: QuarantinePolicy, now = Date.now()): UnsignedEdgeTx {
  if (!policy.operators.includes(operator)) throw new Error('only a listed DMZ operator decides');
  return tx(nodeAddress, sha256, decision === 'release' ? 'ContentReleased' : 'ContentRejected', { decidedBy: operator, because }, now);
}

// ─── Replay ───────────────────────────────────────────────────────

export type QuarantineState = 'quarantined' | 'held' | 'released' | 'rejected';

export interface QuarantineEntry {
  sha256: string; name: string; size: number; detectedType: string; source: QuarantineSource; receivedAt: string;
  checks: Array<{ check: CheckName; result: CheckResult; reason: string }>;
  state: QuarantineState; because: string; decidedBy?: string; decisionTx?: string;
}

/** Replay the node's TX log. A decision counts only from the policy or a listed operator; a later decision supersedes. */
export function replayQuarantine(txs: readonly UnsignedEdgeTx[], policy: QuarantinePolicy = DEFAULT_QUARANTINE_POLICY): QuarantineEntry[] {
  const out = new Map<string, QuarantineEntry>();
  const sorted = [...txs].filter((t) => (DMZ_EVENT_TYPES as readonly string[]).includes(t.eventType)).sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  for (const t of sorted) {
    const p = t.payload as Record<string, unknown>;
    const sha = String(p.sha256);
    if (t.eventType === 'ContentQuarantined') {
      if (!out.has(sha)) out.set(sha, { sha256: sha, name: String(p.name), size: Number(p.size), detectedType: String(p.detectedType), source: p.source as QuarantineSource, receivedAt: t.timestamp, checks: [], state: 'quarantined', because: t.txId });
      continue;
    }
    const e = out.get(sha);
    if (!e) continue;
    if (t.eventType === 'QuarantineCheckRecorded') {
      e.checks = [...e.checks.filter((c) => c.check !== p.check), { check: p.check as CheckName, result: p.result as CheckResult, reason: String(p.reason) }];
      const required = policy.required.map((r) => e.checks.find((c) => c.check === r));
      if (e.state === 'quarantined' && required.every(Boolean) && required.some((c) => c!.result !== 'pass')) { e.state = 'held'; e.because = t.txId; }
      continue;
    }
    const by = String(p.decidedBy);
    if (by !== 'policy' && !policy.operators.includes(by)) continue; // unlisted decider: not applied
    e.state = t.eventType === 'ContentReleased' ? 'released' : 'rejected';
    e.because = String(p.because); e.decidedBy = by; e.decisionTx = t.txId;
  }
  return [...out.values()];
}
