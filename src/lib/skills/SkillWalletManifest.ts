/**
 * SkillWalletManifest — JSON-LD representation of skill metadata
 * as persisted at each MDM wallet address.
 *
 * Follows the TX-as-Triple pattern: minimal on-chain payload,
 * full data struct (JSON-LD) at the wallet address.
 *
 * INVERTED DATA FLOW (v2):
 *   Runtime reads from chainletStorage FIRST (wallet-authoritative).
 *   Falls back to SkillClassification only if wallet is unpopulated.
 *   SkillClassification.ts is the SEED, not the runtime authority.
 *
 * Schema: https://cappz.ai/schema/skill/v1
 */

import { SKILL_CLASSIFICATIONS, type SkillClassificationEntry, type SkillUtilityCode } from './SkillClassification';
import { syncOnAsync } from '../sync/syncOnAsyncAdapter';
import {
  MANIFEST_PIPELINE,
  readPersistedManifest,
  isWalletPopulated,
  type ManifestFormat,
  type ManifestPipelinePayload,
  type PersistedManifestEntry,
} from './SkillManifestPipeline';

// ─── JSON-LD Types ─────────────────────────────────────────────

export interface SkillWalletManifest {
  '@context': 'https://cappz.ai/schema/skill/v1';
  '@type': 'AgentSkill';
  /** MDM address — unique identifier */
  '@id': string;
  /** Human-readable name (from classification) */
  name: string;
  /** Functional description */
  description: string;
  /** Semantic version */
  version: string;
  /** Skill number (internal) */
  skillNumber: number;
  /** Domain classification */
  domain: string;
  /** Subcategory */
  subcategory: string;
  /** Skill utilities (BPMN, validation, schema, pipeline) */
  utilities: SkillUtilityCode[];
  /** BPMN correlation address */
  bpmnCorrelation: string;
  /** API endpoints */
  endpoints: Array<{
    name: string;
    description: string;
    status: string;
  }>;
  /** Optional highlight */
  highlight?: string;
  /** Manifest generation timestamp */
  generatedAt: string;
}

// ─── Builder (seed/fallback only) ─────────────────────────────

/**
 * Build a JSON-LD wallet manifest from a classification entry.
 * Used during bootstrap to seed the wallet store.
 */
export function buildWalletManifest(
  entry: SkillClassificationEntry,
  version = '1.0.0',
): SkillWalletManifest {
  return {
    '@context': 'https://cappz.ai/schema/skill/v1',
    '@type': 'AgentSkill',
    '@id': entry.skillMdmAddress,
    name: entry.name,
    description: entry.description,
    version,
    skillNumber: entry.skillNumber,
    domain: entry.domain,
    subcategory: entry.subcategoryId,
    utilities: entry.utilities ?? [],
    bpmnCorrelation: entry.bpmnCorrelation,
    endpoints: entry.endpoints.map(ep => ({
      name: ep.name,
      description: ep.description,
      status: ep.status,
    })),
    highlight: entry.highlight,
    generatedAt: new Date().toISOString(),
  };
}

// ─── Wallet-Authoritative Read (inverted flow) ────────────────

/**
 * Get a wallet manifest by MDM address.
 * READS FROM WALLET FIRST (chainletStorage), falls back to classification.
 */
export async function getWalletManifestAsync(
  mdmAddress: string,
  version = '1.0.0',
): Promise<SkillWalletManifest | null> {
  // 1. Try wallet-resident manifest (authoritative)
  const persisted = await readPersistedManifest(mdmAddress);
  if (persisted) {
    return persisted.manifest;
  }

  // 2. Fallback: build from classification (seed mode)
  const entry = SKILL_CLASSIFICATIONS.find(s => s.skillMdmAddress === mdmAddress);
  if (!entry) return null;
  return buildWalletManifest(entry, version);
}

/**
 * Synchronous fallback — reads from classification only.
 * Used by legacy callers (AgentSkill.toJsonLd sync path).
 * @deprecated Prefer getWalletManifestAsync for wallet-authoritative reads.
 */
export function getWalletManifest(
  mdmAddress: string,
  version = '1.0.0',
): SkillWalletManifest | null {
  const entry = SKILL_CLASSIFICATIONS.find(s => s.skillMdmAddress === mdmAddress);
  if (!entry) return null;
  return buildWalletManifest(entry, version);
}

// ─── Multi-Format Retrieval ───────────────────────────────────

/**
 * Get a manifest in a specific format from the wallet store.
 * Returns null if not yet persisted.
 */
export async function getManifestAs(
  mdmAddress: string,
  format: ManifestFormat = 'json-ld',
): Promise<{ manifest: SkillWalletManifest; serialized: string; contentHash: string } | null> {
  const persisted = await readPersistedManifest(mdmAddress);
  if (!persisted) return null;

  // If requested format matches stored format, return directly
  if (persisted.format === format) {
    return {
      manifest: persisted.manifest,
      serialized: persisted.serialized,
      contentHash: persisted.contentHash,
    };
  }

  // Otherwise re-persist in requested format via pipeline
  const ticket = await syncOnAsync.submitSync<ManifestPipelinePayload>({
    pipeline: MANIFEST_PIPELINE,
    payload: { address: mdmAddress, format },
    walletAddress: 'system',
  });

  if (ticket.status === 'completed' && ticket.result) {
    const result = ticket.result as PersistedManifestEntry;
    return {
      manifest: result.manifest,
      serialized: result.serialized,
      contentHash: result.contentHash,
    };
  }

  return null;
}

// ─── Persistence (via Sync-on-Async) ──────────────────────────

/**
 * Persist a single skill manifest to its wallet address via sync-on-async.
 * Returns the correlationId (TxID) for audit.
 */
export async function persistManifest(
  mdmAddress: string,
  format: ManifestFormat = 'json-ld',
  version = '1.0.0',
): Promise<string> {
  const ticket = await syncOnAsync.submit<ManifestPipelinePayload>({
    pipeline: MANIFEST_PIPELINE,
    payload: { address: mdmAddress, format, version },
    walletAddress: 'system:bootstrap',
  });
  return ticket.correlationId;
}

/**
 * Bootstrap: persist ALL skill manifests from classification to wallet store.
 * This is the seed operation — classification → wallet.
 * After this, the wallet is the authoritative source.
 */
export async function persistAllManifests(
  format: ManifestFormat = 'json-ld',
  version = '1.0.0',
): Promise<{ total: number; correlationIds: string[] }> {
  // Check if already populated
  const populated = await isWalletPopulated();
  if (populated) {
    console.log('[SkillWalletManifest] Wallet already populated — skipping bootstrap');
    return { total: 0, correlationIds: [] };
  }

  console.log(`[SkillWalletManifest] Bootstrapping ${SKILL_CLASSIFICATIONS.length} manifests to wallet store…`);
  const correlationIds: string[] = [];

  for (const entry of SKILL_CLASSIFICATIONS) {
    const corrId = await persistManifest(entry.skillMdmAddress, format, version);
    correlationIds.push(corrId);
  }

  console.log(
    `[SkillWalletManifest] ✅ Bootstrapped ${correlationIds.length} manifests — wallet is now authoritative`
  );

  return { total: correlationIds.length, correlationIds };
}

/**
 * Build all wallet manifests for bulk export (legacy sync).
 */
export function getAllWalletManifests(version = '1.0.0'): SkillWalletManifest[] {
  return SKILL_CLASSIFICATIONS.map(entry => buildWalletManifest(entry, version));
}
