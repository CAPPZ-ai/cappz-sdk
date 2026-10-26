/**
 * FetchSkillsOnChain — Generic HD-walk skill discovery utility.
 *
 * Iterates child paths under a target HD path, resolves skills via SkillRegistry,
 * calls fetchSkillConfig() on each, and caches results in chainletStorage.
 *
 * AX-68: Generic On-Chain Discovery
 * AX-69: Config Cache for Non-Volatile Datasets
 *
 * HD: m/44'/144'/0'/cappz/skills/fetch-on-chain
 */

import { chainletStorage } from '../sync/chainletStorage';
import { middlewareNotify } from '../sync/cappz-middleware';
import { CANON_ROOTS, BIBLE_CODEX_ROOT, CODEX_CONFIG_PREFIX } from '../bible/BibleCodexPaths';
import type { CanonRegistryEntry } from '../codex/CanonRegistry';

/** 7-day TTL for config cache entries (AX-69) */
const CONFIG_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Mapping: CanonKey → MDM_SKILLS key for skill resolution */
const CANON_TO_MDM: Record<string, string> = {
  ethiopian:  "m/44'/144'/0'/cappz/skills/bible",
  kjv:        "m/44'/144'/0'/cappz/skills/bible",
  peshitta:   "m/44'/144'/0'/cappz/skills/peshitta",
  wlc:        "m/44'/144'/0'/cappz/skills/wlc",
  nestle1904: "m/44'/144'/0'/cappz/skills/nestle-1904",
  qumran:     "m/44'/144'/0'/cappz/skills/qumran",
  nagHammadi: "m/44'/144'/0'/cappz/skills/nag-hammadi",
  geneva:     "m/44'/144'/0'/cappz/skills/geneva",
  vulgate:    "m/44'/144'/0'/cappz/skills/vulgate",
};

/**
 * Generic HD-walk discovery. Resolves skills under a target HD path,
 * calls fetchSkillConfig(), and caches results in chainletStorage.
 *
 * @param targetHDPath - Root HD path to walk (e.g., BIBLE_CODEX_ROOT)
 * @returns Array of discovered CanonRegistryEntry configs
 */
export async function FetchSkillsOnChain(
  targetHDPath: string,
): Promise<CanonRegistryEntry[]> {
  const { resolveSkill } = await import('./SkillRegistry');
  const { CANON_REGISTRY } = await import('../codex/CanonRegistry');

  const results: CanonRegistryEntry[] = [];
  const discoveredKeys: string[] = [];

  // Determine which canon roots fall under the target HD path
  const canonEntries = Object.entries(CANON_ROOTS).filter(([, root]) =>
    root.startsWith(targetHDPath) || targetHDPath.startsWith(root)
  );

  for (const [canonKey, hdRoot] of canonEntries) {
    const mdmAddress = CANON_TO_MDM[canonKey];
    if (!mdmAddress) continue;

    let entry: CanonRegistryEntry | null = null;

    // Try resolving via skill's fetchSkillConfig()
    try {
      const skill = resolveSkill(mdmAddress);
      if (skill && typeof (skill as any).fetchSkillConfig === 'function') {
        const config = (skill as any).fetchSkillConfig();
        if (config) {
          const configs = Array.isArray(config) ? config : [config];
          for (const c of configs) {
            if (c.hdRoot === hdRoot) {
              entry = c;
              break;
            }
          }
        }
      }
    } catch {
      // Skill not registered or failed — fall back to seed
    }

    // Fallback to static seed registry
    if (!entry) {
      entry = CANON_REGISTRY.find(r => r.hdRoot === hdRoot) ?? null;
    }

    if (entry) {
      // Cache to chainletStorage with TTL — content-addressed dedup so
      // an unchanged config never re-writes or re-notifies the bus.
      const cacheKey = `${CODEX_CONFIG_PREFIX}${canonKey}`;
      const contentJson = JSON.stringify(entry);
      const existingRaw = chainletStorage.getItem(cacheKey);
      let existingContentJson: string | null = null;
      if (existingRaw) {
        try {
          const parsed = typeof existingRaw === 'string' ? JSON.parse(existingRaw) : existingRaw;
          const { _cachedAt: _a, _ttl: _t, ...bare } = parsed ?? {};
          existingContentJson = JSON.stringify(bare);
        } catch {
          existingContentJson = null;
        }
      }
      if (existingContentJson !== contentJson) {
        const cached = { ...entry, _cachedAt: new Date().toISOString(), _ttl: CONFIG_CACHE_TTL_MS };
        chainletStorage.setItem(cacheKey, JSON.stringify(cached));
        // AX-75: Pass the HD address (cacheKey) — not a copy of the content
        middlewareNotify('kv', cacheKey, 'write', cacheKey);
      }

      results.push(entry);
      discoveredKeys.push(canonKey);
    }
  }

  // Write index — only when the sorted key list actually changed.
  const indexKey = `${CODEX_CONFIG_PREFIX}__index__`;
  const sortedKeys = [...discoveredKeys].sort();
  let existingKeysJson: string | null = null;
  const existingIndexRaw = chainletStorage.getItem(indexKey);
  if (existingIndexRaw) {
    try {
      const parsed = typeof existingIndexRaw === 'string' ? JSON.parse(existingIndexRaw) : existingIndexRaw;
      if (Array.isArray(parsed?.keys)) {
        existingKeysJson = JSON.stringify([...parsed.keys].sort());
      }
    } catch {
      existingKeysJson = null;
    }
  }
  const nextKeysJson = JSON.stringify(sortedKeys);
  if (existingKeysJson !== nextKeysJson) {
    chainletStorage.setItem(indexKey, JSON.stringify({
      keys: discoveredKeys,
      discoveredAt: new Date().toISOString(),
      source: targetHDPath,
    }));
    middlewareNotify('kv', indexKey, 'write', indexKey);
  }

  console.log(`[FetchSkillsOnChain] Discovered ${results.length} configs under ${targetHDPath}`);
  return results;
}
