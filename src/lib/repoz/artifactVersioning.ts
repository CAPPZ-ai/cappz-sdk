/**
 * COPE node crystallized. Node ID: v14-16-10-version-by-default
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Principle: every new artifact is versioned in RepoZ by default.
 * Pure planning: given artifacts (path, kind, hash) and the RepoZ history,
 * emit ContentCreated on first sight, ContentAmended (base = previous head)
 * when the hash changes, nothing when unchanged. Owner roots are derived from
 * the artifact path — platform vs app — with no lookup file (AX-73).
 * Payloads carry hashes and addresses only; bytes never enter the wallet graph.
 */
import { operationalRoot } from '../wallets/paths';
import { repozArtifactAddress } from './paths';

export const VERSION_BY_DEFAULT_PRINCIPLE = "m/44'/144'/100'/principles/cope/v1#version-by-default";
export const PLATFORM_SLUG = 'cappz';
/** BPMN folders that belong to the platform branch, not an app. */
const PLATFORM_BPMN_FOLDERS = new Set(['substrate', 'services', 'cappz', 'notary']);

export type VersionedKind = 'bpmn' | 'source';
export interface VersionableArtifact { path: string; kind: VersionedKind; hash: string; app?: string; bytes?: Uint8Array }
export interface VersionTxPlan {
  txId: string;
  eventType: 'ContentCreated' | 'ContentAmended';
  targetAddress: string;
  ownerRoot: string;
  payload: { artifactId: string; objectType: VersionedKind; kind: VersionedKind; path: string; contentHash: string; parentTxIds: string[]; governingPrinciple: string; contentRef?: unknown };
}
interface HistoryTx { txId: string; eventType: string; targetAddress: string; timestamp?: string; payload?: Record<string, unknown> }

/** Owner slug for an artifact: BPMN by folder (or explicit app), code by top folder. */
export function ownerSlugOf(a: Pick<VersionableArtifact, 'path' | 'kind' | 'app'>): string {
  if (a.kind === 'bpmn') {
    if (a.app && !PLATFORM_BPMN_FOLDERS.has(a.app)) return a.app;
    const rel = a.path.replace(/^\/?src\/bpmn\//, '').split('/');
    return rel.length > 1 && !PLATFORM_BPMN_FOLDERS.has(rel[0]) ? rel[0] : PLATFORM_SLUG;
  }
  const m = a.path.match(/^src\/(?:pages|components|lib)\/(ebb|media|codex)\//);
  return m ? m[1] : PLATFORM_SLUG;
}

export const ownerRootOf = (a: Pick<VersionableArtifact, 'path' | 'kind' | 'app'>) => operationalRoot(ownerSlugOf(a));

export function artifactIdOf(a: Pick<VersionableArtifact, 'path' | 'kind'>): string {
  const rel = a.kind === 'bpmn' ? a.path.replace(/^\/?src\/bpmn\//, '').replace(/\.bpmn$/, '') : a.path.replace(/^\//, '');
  return `${a.kind === 'bpmn' ? 'bpmn' : 'code'}/${rel}`;
}

export const versionTxId = (address: string, hash: string) => `repoz-version:${address}:${hash}`;

export function versionAddressOf(a: VersionableArtifact): string {
  return repozArtifactAddress(ownerRootOf(a), artifactIdOf(a));
}

function headsByAddress(history: readonly HistoryTx[]): Map<string, { txId: string; hash: string }> {
  const out = new Map<string, { txId: string; hash: string }>();
  const sorted = [...history].sort((a, b) => String(a.timestamp ?? '').localeCompare(String(b.timestamp ?? '')));
  for (const tx of sorted) {
    if (tx.eventType !== 'ContentCreated' && tx.eventType !== 'ContentAmended' && tx.eventType !== 'BranchMerged') continue;
    out.set(tx.targetAddress, { txId: tx.txId, hash: String(tx.payload?.contentHash ?? '') });
  }
  return out;
}

export function planArtifactVersionTxs(artifacts: readonly VersionableArtifact[], history: readonly HistoryTx[]): VersionTxPlan[] {
  const heads = headsByAddress(history);
  const out: VersionTxPlan[] = [];
  for (const a of [...artifacts].sort((x, y) => x.path.localeCompare(y.path))) {
    const address = versionAddressOf(a);
    const head = heads.get(address);
    if (head?.hash === a.hash) continue;
    out.push({
      txId: versionTxId(address, a.hash),
      eventType: head ? 'ContentAmended' : 'ContentCreated',
      targetAddress: address,
      ownerRoot: ownerRootOf(a),
      payload: { artifactId: artifactIdOf(a), objectType: a.kind, kind: a.kind, path: a.path, contentHash: a.hash, parentTxIds: head ? [head.txId] : [], governingPrinciple: VERSION_BY_DEFAULT_PRINCIPLE },
    });
  }
  return out;
}

/** Build gate: every artifact's current hash must match its RepoZ head. */
export function checkArtifactsVersioned(artifacts: readonly VersionableArtifact[], history: readonly HistoryTx[]): { ok: boolean; unversioned: string[] } {
  const unversioned = planArtifactVersionTxs(artifacts, history).map((p) => p.payload.path);
  return { ok: unversioned.length === 0, unversioned };
}
