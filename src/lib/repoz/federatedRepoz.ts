/**
 * Wallet-native, multi-master RepoZ.
 *
 * State is an immutable event graph in the shared RepoZ POW partition. Content
 * bytes remain in the owning wallet; this graph stores hashes and references.
 * Amend is default-deny and requires a verified wallet-signed AmendGranted TX
 * from the owning app's Administrators group.
 */
import { CappzEventCache, type CappzEventCacheEntry } from '../sync/CappzEventCache';
import { canonicalizeEvent, createNotarizedEvent, type EventCustodyStatus } from '../mdm/eventCustody';
import { bootstrapCopeSubstrate, principlesChainlet, sha256Hex, type PrincipleRecord } from '../governance/PrinciplesChainlet';
import { appendWalletTierTxs, createWalletTierTx } from '../wallets/walletTierEvents';
import { originatePrimeOperationalWallet } from '../wallets/primeOperationalWallet';
import { typeWallet } from '../wallets/walletTierTyping';
import {
  REPOZ_EVENT_ROOT,
  REPOZ_POW_ROOT,
  REPOZ_PTW_ROOT,
  REPOZ_SKILL_ROOT,
  repozAdministratorsGroup,
  repozArtifactAddress,
  repozBranchRoot,
  repozBuildRoot,
} from './paths';

export type RepoZObjectType = 'document' | 'media' | 'function' | 'schema' | 'bpmn' | 'ui' | 'source' | 'artifact';
export type RepoZEventType =
  | 'ContentCreated'
  | 'ContentAmended'
  | 'ContentAmendPlanned'
  | 'ContentAmendPlanCancelled'
  | 'ConstituentIncluded'
  | 'ConstituentRemoved'
  | 'AmendGranted'
  | 'AmendRevoked'
  | 'ConflictDetected'
  | 'BranchMerged'
  | 'DependencyCreated'
  | 'BuildConstituentIncluded'
  | 'BuildManifestCreated'
  | 'BuildAmended'
  | 'BuildRequested'
  | 'DependencyIncluded'
  | 'ReadGranted'
  | 'ReadRevoked'
  | 'RepoZSynchronizationRequested'
  | 'RepoZSynchronizationCompleted'
  // v14-16-02: same version stored differently — deliberately NOT a ContentAmended subclass.
  | 'ContentCompressed'
  | 'ContentPurged'
  | 'ContentArchived'
  | 'ReplicantCreated'
  | 'ArchiveCreated'
  | 'GrantRequested'
  | 'GrantRejected'
  | 'ContentExported'
  | 'ContentMirrored'
  | 'NextSequenced'
  | 'PreviousSequenced'
  // v14-16-15: version retention.
  | 'ContentRestored'
  | 'RemediationRequested';

export interface RepoZTx extends CappzEventCacheEntry {
  eventType: RepoZEventType;
  sourceAddress: string;
  targetAddress: string;
  payload: Record<string, unknown> & { governingPrinciple: string };
  eventMdmAddress: string;
  eventRegistrationTxId: string;
  custodyStatus: EventCustodyStatus;
  txHash: string;
}

export interface RepoZContentInput {
  appRoot: string;
  artifactId: string;
  objectType: RepoZObjectType;
  contentHash: string;
  contentAddress: string;
  actorAddress: string;
  signature: string;
  baseHeads?: string[];
  /** Optimistic concurrency: the version (tx id) this check-in changes. Required on amend. */
  baseVersionTxId?: string;
  message?: string;
}

/** Generic events plus derived subclasses; a subclass names its generic parent so generic replay still works. */
export const REPOZ_EVENT_PARENT: Partial<Record<RepoZEventType, RepoZEventType>> = {
  BuildAmended: 'ContentAmended',
  BuildManifestCreated: 'ContentCreated',
  ArchiveCreated: 'ReplicantCreated',
};

export interface RepoZArtifactState {
  artifactId: string;
  appRoot: string;
  objectType: RepoZObjectType;
  heads: RepoZTx[];
  history: RepoZTx[];
  conflict: boolean;
}

const cache = new CappzEventCache<RepoZTx>(REPOZ_EVENT_ROOT, 'cappz:repoz:federated:');

async function assertPrinciple(): Promise<PrincipleRecord> {
  const principle = await bootstrapCopeSubstrate();
  const verified = await principlesChainlet.verifyPrincipleHash(principle.path, principle.contentHash);
  if (!verified) throw new Error('RepoZ principle verification failed.');
  return principle;
}

async function createTx(params: {
  txId: string;
  eventType: RepoZEventType;
  sourceAddress: string;
  targetAddress: string;
  payload?: Record<string, unknown>;
}): Promise<RepoZTx> {
  const principle = await assertPrinciple();
  const event = await createNotarizedEvent({
    ...params,
    governingPrinciple: principle.path,
    emitterDomain: 'federated-repoz',
    enforcement: 'refuse',
  });
  return { ...event, eventType: params.eventType };
}

function latestPermission(txs: RepoZTx[], appRoot: string, actorAddress: string): RepoZTx | null {
  return txs
    .filter((tx) =>
      (tx.eventType === 'AmendGranted' || tx.eventType === 'AmendRevoked') &&
      tx.sourceAddress === repozAdministratorsGroup(appRoot) &&
      tx.targetAddress === actorAddress &&
      tx.payload.scopeRoot === repozBranchRoot(appRoot),
    )
    .at(-1) ?? null;
}

function requireAmend(txs: RepoZTx[], appRoot: string, actorAddress: string): RepoZTx {
  const permission = latestPermission(txs, appRoot, actorAddress);
  if (!permission || permission.eventType !== 'AmendGranted' || permission.payload.signatureVerified !== true) {
    throw new Error(`RepoZ amend denied for ${actorAddress}: no active wallet-verified app-branch grant.`);
  }
  return permission;
}

export async function originateFederatedRepoZ(): Promise<void> {
  await assertPrinciple();
  await typeWallet({ walletRoot: REPOZ_PTW_ROOT, tier: 'PTW', attribution: { slug: 'cappz-repoz', contentRoot: REPOZ_SKILL_ROOT } });
  await originatePrimeOperationalWallet({
    slug: 'cappz-repoz',
    templateRoot: REPOZ_PTW_ROOT,
    constituentAddresses: [REPOZ_SKILL_ROOT],
    replicaLabel: 'shared-auto-sync',
    purpose: 'redundancy',
  });
}

export async function includeRepoZSkill(appRoot: string): Promise<RepoZTx> {
  await assertPrinciple();
  await cache.refresh();
  const targetAddress = repozBranchRoot(appRoot);
  const txId = `repoz-skill-included:${await sha256Hex(`${appRoot}|${REPOZ_SKILL_ROOT}`)}`;
  const existing = cache.getCached().find((tx) => tx.txId === txId);
  if (existing) return existing;
  const tx = await createTx({
    txId,
    eventType: 'ConstituentIncluded',
    sourceAddress: REPOZ_SKILL_ROOT,
    targetAddress,
    payload: { constituentAddress: REPOZ_SKILL_ROOT, linkage: 'by-ref', sharedPow: REPOZ_POW_ROOT, privateNamespace: `${targetAddress}/_local` },
  });
  await cache.append(tx, { requireDurable: true });
  await appendWalletTierTxs([await createWalletTierTx({
    txId: `${txId}:wallet-tier`,
    eventType: 'ConstituentIncluded',
    sourceAddress: REPOZ_SKILL_ROOT,
    targetAddress,
    payload: { constituentAddress: REPOZ_SKILL_ROOT, linkage: 'by-ref', sharedPow: REPOZ_POW_ROOT },
  })]);
  return tx;
}

export function resolveRepoZArtifact(txs: RepoZTx[], appRoot: string, artifactId: string): RepoZArtifactState | null {
  const address = repozArtifactAddress(appRoot, artifactId);
  const history = txs.filter((tx) => (tx.eventType === 'ContentCreated' || tx.eventType === 'ContentAmended' || tx.eventType === 'BranchMerged') && tx.targetAddress === address);
  if (!history.length) return null;
  const parentIds = new Set(history.flatMap((tx) => Array.isArray(tx.payload.parentTxIds) ? tx.payload.parentTxIds.map(String) : []));
  const heads = history.filter((tx) => !parentIds.has(tx.txId));
  return { artifactId, appRoot, objectType: String(history[0].payload.objectType ?? 'artifact') as RepoZObjectType, heads, history, conflict: heads.length > 1 };
}

export async function createRepoZContent(input: RepoZContentInput): Promise<RepoZTx> {
  await assertPrinciple();
  const txs = await cache.refresh();
  requireAmend(txs, input.appRoot, input.actorAddress);
  const existing = resolveRepoZArtifact(txs, input.appRoot, input.artifactId);
  if (existing) throw new Error('RepoZ artifact already exists; amend its current head.');
  const tx = await createTx({
    txId: `repoz-content-created:${input.contentHash}`,
    eventType: 'ContentCreated',
    sourceAddress: input.actorAddress,
    targetAddress: repozArtifactAddress(input.appRoot, input.artifactId),
    payload: { artifactId: input.artifactId, objectType: input.objectType, contentHash: input.contentHash, contentAddress: input.contentAddress, signature: input.signature, parentTxIds: [] },
  });
  await cache.append(tx, { requireDurable: true });
  return tx;
}

export async function amendRepoZContent(input: RepoZContentInput): Promise<{ tx: RepoZTx; conflict: boolean }> {
  await assertPrinciple();
  const txs = await cache.refresh();
  requireAmend(txs, input.appRoot, input.actorAddress);
  const current = resolveRepoZArtifact(txs, input.appRoot, input.artifactId);
  if (!current) throw new Error('RepoZ artifact does not exist; create it first.');
  if (!input.baseVersionTxId && !input.baseHeads?.length) throw new Error('RepoZ check-in must reference the version it changes (baseVersionTxId).');
  const requestedParents = input.baseHeads ?? [input.baseVersionTxId as string];
  const currentHeads = current.heads.map((head) => head.txId);
  const diverged = currentHeads.some((head) => !requestedParents.includes(head));
  const tx = await createTx({
    txId: `repoz-content-amended:${crypto.randomUUID()}`,
    eventType: 'ContentAmended',
    sourceAddress: input.actorAddress,
    targetAddress: repozArtifactAddress(input.appRoot, input.artifactId),
    payload: { artifactId: input.artifactId, objectType: input.objectType, contentHash: input.contentHash, contentAddress: input.contentAddress, signature: input.signature, parentTxIds: requestedParents, currentHeads, message: input.message ?? '' },
  });
  const entries = [tx];
  if (diverged) entries.push(await createTx({
    txId: `repoz-conflict-detected:${crypto.randomUUID()}`,
    eventType: 'ConflictDetected',
    sourceAddress: input.actorAddress,
    targetAddress: repozArtifactAddress(input.appRoot, input.artifactId),
    payload: { artifactId: input.artifactId, proposedTxId: tx.txId, parentTxIds: requestedParents, currentHeads },
  }));
  await cache.appendMany(entries, { requireDurable: true });
  return { tx, conflict: diverged };
}

export async function mergeRepoZHeads(input: RepoZContentInput & { parentHeads: string[] }): Promise<RepoZTx> {
  if (new Set(input.parentHeads).size < 2) throw new Error('A RepoZ merge requires at least two distinct parent heads.');
  const txs = await cache.refresh();
  requireAmend(txs, input.appRoot, input.actorAddress);
  const tx = await createTx({
    txId: `repoz-branch-merged:${crypto.randomUUID()}`,
    eventType: 'BranchMerged',
    sourceAddress: input.actorAddress,
    targetAddress: repozArtifactAddress(input.appRoot, input.artifactId),
    payload: { artifactId: input.artifactId, objectType: input.objectType, contentHash: input.contentHash, contentAddress: input.contentAddress, signature: input.signature, parentTxIds: [...new Set(input.parentHeads)], message: input.message ?? 'Signed multi-master merge' },
  });
  await cache.append(tx, { requireDurable: true });
  return tx;
}

export async function createRepoZBuildManifest(params: {
  appRoot: string;
  buildVersion: string;
  actorAddress: string;
  signature: string;
  constituents: Array<{ artifactId: string; contentHash: string; txId: string }>;
}): Promise<RepoZTx[]> {
  const txs = await cache.refresh();
  requireAmend(txs, params.appRoot, params.actorAddress);
  const buildRoot = repozBuildRoot(params.appRoot, params.buildVersion);
  const entries = await Promise.all(params.constituents.map((item) => createTx({
    txId: `repoz-build-constituent:${params.buildVersion}:${item.contentHash}`,
    eventType: 'BuildConstituentIncluded',
    sourceAddress: repozArtifactAddress(params.appRoot, item.artifactId),
    targetAddress: buildRoot,
    payload: { ...item, buildVersion: params.buildVersion, signature: params.signature },
  })));
  const manifestHash = await sha256Hex(canonicalizeEvent(params.constituents));
  const prior = resolveBuildHead(txs, params.appRoot, params.buildVersion);
  entries.push(await createTx({
    txId: `repoz-build-${prior ? 'amended' : 'manifest'}:${params.buildVersion}:${manifestHash}`,
    eventType: prior ? 'BuildAmended' : 'BuildManifestCreated',
    sourceAddress: params.actorAddress,
    targetAddress: buildRoot,
    payload: { buildVersion: params.buildVersion, manifestHash, constituentCount: params.constituents.length, signature: params.signature, parentTxIds: prior ? [prior.txId] : [] },
  }));
  await cache.appendMany(entries, { requireDurable: true });
  return entries;
}

/**
 * v14-16-10 — version-by-default writer. The build agent (sole writer, like
 * BindBPMNFunctionsOnchain) records hash-only ContentCreated/ContentAmended
 * from planArtifactVersionTxs. Idempotent: txIds are address+hash, so a
 * replanned batch skips what already landed. Batched for large backfills.
 */
export async function appendArtifactVersions(
  plans: ReadonlyArray<{ txId: string; eventType: RepoZEventType; targetAddress: string; sourceAddress?: string; payload: Record<string, unknown> }>,
  actorAddress: string,
  onProgress?: (done: number, total: number) => void,
  batchSize = 50,
): Promise<number> {
  const known = new Set((await cache.refresh()).map((t) => t.txId));
  const todo = plans.filter((p) => !known.has(p.txId));
  let done = 0;
  onProgress?.(0, todo.length);
  for (let i = 0; i < todo.length; i += batchSize) {
    const entries = await Promise.all(todo.slice(i, i + batchSize).map((p) => createTx({ txId: p.txId, eventType: p.eventType, targetAddress: p.targetAddress, payload: p.payload, sourceAddress: p.sourceAddress ?? actorAddress })));
    await cache.appendMany(entries, { requireDurable: true });
    done += entries.length;
    onProgress?.(done, todo.length);
  }
  return done;
}

export async function refreshRepoZTxs(): Promise<RepoZTx[]> { return cache.refresh(); }
export function getRepoZTxs(): RepoZTx[] { return cache.getCached(); }

/**
 * Latest build record for a version. Legacy rebuilds wrote several
 * BuildManifestCreated TXs; the earliest is the creation, later ones read as amendments.
 */
export function resolveBuildHead(txs: RepoZTx[], appRoot: string, buildVersion: string): RepoZTx | null {
  const root = repozBuildRoot(appRoot, buildVersion);
  const builds = txs
    .filter((tx) => (tx.eventType === 'BuildManifestCreated' || tx.eventType === 'BuildAmended') && tx.targetAddress === root)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.txId.localeCompare(b.txId));
  return builds.at(-1) ?? null;
}

export interface RepoZAmendPlan { txId: string; author: string; baseVersionTxId: string; note: string; expiresAt: string }

/** Advisory soft locks: open ContentAmendPlanned intents, never exclusive. */
export function resolveAmendPlans(txs: RepoZTx[], appRoot: string, artifactId: string, now = new Date()): RepoZAmendPlan[] {
  const address = repozArtifactAddress(appRoot, artifactId);
  const scoped = txs.filter((tx) => tx.targetAddress === address);
  const closed = new Set(scoped.filter((tx) => tx.eventType === 'ContentAmendPlanCancelled').map((tx) => String(tx.payload.planTxId)));
  return scoped
    .filter((tx) => tx.eventType === 'ContentAmendPlanned' && !closed.has(tx.txId))
    .filter((tx) => !scoped.some((a) => a.eventType === 'ContentAmended' && a.sourceAddress === tx.sourceAddress && a.timestamp > tx.timestamp))
    .filter((tx) => String(tx.payload.expiresAt ?? '') > now.toISOString())
    .map((tx) => ({ txId: tx.txId, author: tx.sourceAddress, baseVersionTxId: String(tx.payload.baseVersionTxId ?? ''), note: String(tx.payload.note ?? ''), expiresAt: String(tx.payload.expiresAt) }));
}

/** Signal intent to amend (soft lock without guarantees). */
export async function planRepoZAmend(input: { appRoot: string; artifactId: string; actorAddress: string; baseVersionTxId: string; note?: string; ttlMinutes?: number }): Promise<RepoZTx> {
  const txs = await cache.refresh();
  requireAmend(txs, input.appRoot, input.actorAddress);
  const tx = await createTx({
    txId: `repoz-amend-planned:${crypto.randomUUID()}`,
    eventType: 'ContentAmendPlanned',
    sourceAddress: input.actorAddress,
    targetAddress: repozArtifactAddress(input.appRoot, input.artifactId),
    payload: { artifactId: input.artifactId, baseVersionTxId: input.baseVersionTxId, note: input.note ?? '', expiresAt: new Date(Date.now() + (input.ttlMinutes ?? 120) * 60000).toISOString(), exclusive: false },
  });
  await cache.append(tx, { requireDurable: true });
  return tx;
}

export type RepoZReader = { isPlatformAdmin: boolean; isAppAdmin: boolean };

/** Code is admin-read only; everyone else sees path, hash and version metadata. */
export function redactRepoZArtifact(state: RepoZArtifactState, reader: RepoZReader): RepoZArtifactState {
  const code = state.objectType === 'source' || state.objectType === 'function';
  if (!code || reader.isPlatformAdmin || reader.isAppAdmin) return state;
  const strip = (tx: RepoZTx): RepoZTx => ({ ...tx, payload: { ...tx.payload, contentAddress: undefined, redacted: true } });
  return { ...state, heads: state.heads.map(strip), history: state.history.map(strip) };
}

/** Public read: latest ReadGranted/ReadRevoked from the grantor to the artifact (or an ancestor folder). Default deny. */
export function resolvePublicRead(txs: RepoZTx[], grantor: string, artifactAddress: string): boolean {
  const latest = txs
    .filter((tx) => (tx.eventType === 'ReadGranted' || tx.eventType === 'ReadRevoked') && tx.sourceAddress === grantor &&
      (artifactAddress === tx.targetAddress || artifactAddress.startsWith(`${tx.targetAddress}/`)))
    .sort((a, b) => b.targetAddress.length - a.targetAddress.length || b.timestamp.localeCompare(a.timestamp))[0];
  return latest?.eventType === 'ReadGranted';
}
