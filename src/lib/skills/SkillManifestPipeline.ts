/**
 * SkillManifestPipeline — Sync-on-Async pipeline processor for skill manifests.
 *
 * Registers a `skill-manifest` pipeline on the SyncOnAsync engine.
 * Processor: receives MDM address + optional format →
 *   builds manifest from classification →
 *   persists to chainletStorage at MDM address key →
 *   returns manifest in requested format.
 *
 * The sync-on-async envelope IS the TX-as-Triple:
 *   subject = MDM address
 *   predicate = 'skill-manifest' pipeline
 *   object = correlationId (content hash/TxID)
 *
 * This makes the wallet the authoritative source of truth.
 * SkillClassification.ts becomes the seed, not the runtime authority.
 */

import { syncOnAsync, type PipelineProcessor } from '../sync/syncOnAsyncAdapter';
import { chainletStorage } from '../sync/chainletStorage';
import { SKILL_CLASSIFICATIONS } from './SkillClassification';
import { buildWalletManifest, type SkillWalletManifest } from './SkillWalletManifest';

// ─── Pipeline Constants (resolved from wallet-resident MDM params) ─

import { ChainletStoreParamType, getChainletParam } from '../sync/chainletStoreParams';

export const MANIFEST_PIPELINE = getChainletParam(ChainletStoreParamType.ManifestPipelineName);
export const MANIFEST_KEY_PREFIX = getChainletParam(ChainletStoreParamType.ManifestKeyPrefix);

// ─── Payload / Result Types ───────────────────────────────────

export type ManifestFormat = 'json-ld' | 'json' | 'xml';

export interface ManifestPipelinePayload {
  /** MDM address of the skill */
  address: string;
  /** Desired output format (default: json-ld) */
  format?: ManifestFormat;
  /** Version override */
  version?: string;
}

export interface ManifestPipelineResult {
  address: string;
  format: ManifestFormat;
  manifest: SkillWalletManifest;
  /** Serialized output (JSON-LD string, flat JSON, or XML) */
  serialized: string;
  /** SHA-256 content hash of the serialized manifest */
  contentHash: string;
  persistedAt: string;
}

// ─── Format Serializers ───────────────────────────────────────

function serializeJsonLd(manifest: SkillWalletManifest): string {
  return JSON.stringify(manifest, null, 2);
}

function serializeFlatJson(manifest: SkillWalletManifest): string {
  // Strip JSON-LD decorators for flat JSON consumers
  const { '@context': _ctx, '@type': _type, '@id': _id, ...flat } = manifest;
  return JSON.stringify({ id: _id, type: _type, ...flat }, null, 2);
}

function serializeXml(manifest: SkillWalletManifest): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<AgentSkill xmlns="https://cappz.ai/schema/skill/v1" id="${esc(manifest['@id'])}">`,
    `  <name>${esc(manifest.name)}</name>`,
    `  <description>${esc(manifest.description)}</description>`,
    `  <version>${esc(manifest.version)}</version>`,
    `  <skillNumber>${manifest.skillNumber}</skillNumber>`,
    `  <domain>${esc(manifest.domain)}</domain>`,
    `  <subcategory>${esc(manifest.subcategory)}</subcategory>`,
    `  <bpmnCorrelation>${esc(manifest.bpmnCorrelation)}</bpmnCorrelation>`,
    `  <utilities>`,
    ...manifest.utilities.map(u => `    <utility>${esc(u)}</utility>`),
    `  </utilities>`,
    `  <endpoints>`,
    ...manifest.endpoints.map(ep =>
      `    <endpoint name="${esc(ep.name)}" status="${esc(ep.status)}">${esc(ep.description)}</endpoint>`
    ),
    `  </endpoints>`,
    manifest.highlight ? `  <highlight>${esc(manifest.highlight)}</highlight>` : '',
    `  <generatedAt>${manifest.generatedAt}</generatedAt>`,
    `</AgentSkill>`,
  ].filter(Boolean);
  return lines.join('\n');
}

const SERIALIZERS: Record<ManifestFormat, (m: SkillWalletManifest) => string> = {
  'json-ld': serializeJsonLd,
  'json': serializeFlatJson,
  'xml': serializeXml,
};

// ─── Content Hash ─────────────────────────────────────────────

async function sha256(content: string): Promise<string> {
  const encoded = new TextEncoder().encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ─── Storage Key ──────────────────────────────────────────────

/** Derive the chainletStorage key for a skill manifest */
export function manifestStorageKey(mdmAddress: string): string {
  return `${MANIFEST_KEY_PREFIX}${mdmAddress}`;
}

// ─── Pipeline Processor ───────────────────────────────────────

const manifestProcessor: PipelineProcessor<ManifestPipelinePayload, ManifestPipelineResult> = async (
  correlationId,
  payload,
) => {
  const { address, format = 'json-ld', version = '1.0.0' } = payload;

  // 1. Resolve classification entry
  const entry = SKILL_CLASSIFICATIONS.find(s => s.skillMdmAddress === address);
  if (!entry) {
    throw new Error(`[SkillManifestPipeline] No classification entry for address: ${address}`);
  }

  // 2. Build JSON-LD manifest
  const manifest = buildWalletManifest(entry, version);

  // 3. Serialize to requested format
  const serializer = SERIALIZERS[format];
  const serialized = serializer(manifest);

  // 4. Compute content hash
  const contentHash = await sha256(serialized);

  // 5. Persist to chainletStorage at MDM address key (wallet-resident)
  const storageKey = manifestStorageKey(address);
  await chainletStorage.setItem(storageKey, {
    manifest,
    format,
    serialized,
    contentHash,
    correlationId,
    persistedAt: new Date().toISOString(),
  });

  const result: ManifestPipelineResult = {
    address,
    format,
    manifest,
    serialized,
    contentHash,
    persistedAt: new Date().toISOString(),
  };

  console.log(
    `[SkillManifestPipeline] Persisted #${entry.skillNumber} "${entry.name}" as ${format} (hash: ${contentHash.slice(0, 12)}…) correlationId=${correlationId}`
  );

  return result;
};

// ─── Registration ─────────────────────────────────────────────

/** Register the skill-manifest pipeline on the sync-on-async engine */
export function registerManifestPipeline(): void {
  syncOnAsync.registerPipeline(MANIFEST_PIPELINE, manifestProcessor as PipelineProcessor);
  console.log('[SkillManifestPipeline] Registered pipeline: skill-manifest');
}

// ─── Wallet-Resident Read ─────────────────────────────────────

export interface PersistedManifestEntry {
  manifest: SkillWalletManifest;
  format: ManifestFormat;
  serialized: string;
  contentHash: string;
  correlationId: string;
  persistedAt: string;
}

/** Read a persisted manifest from chainletStorage (wallet-authoritative) */
export async function readPersistedManifest(mdmAddress: string): Promise<PersistedManifestEntry | null> {
  const key = manifestStorageKey(mdmAddress);
  return chainletStorage.getItem<PersistedManifestEntry>(key);
}

/** Check if any manifests are persisted */
export async function isWalletPopulated(): Promise<boolean> {
  const keys = await chainletStorage.keys();
  return keys.some(k => k.startsWith(MANIFEST_KEY_PREFIX));
}

/** Get all persisted manifest keys */
export async function getPersistedManifestKeys(): Promise<string[]> {
  const keys = await chainletStorage.keys();
  return keys.filter(k => k.startsWith(MANIFEST_KEY_PREFIX));
}
