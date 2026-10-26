/**
 * CanonRegistry — Single Source of Truth for all Bible Codex canon configurations.
 *
 * Every canon/constituent that appears in the Bible Codex must be registered here.
 * Consumer modules (BiblePortalPage, BibleCodexDataAdapter, SourceContentGenerationBPMN,
 * CodexLibraryTemplate) should derive their canon lists from this registry rather than
 * maintaining independent hard-coded arrays.
 *
 * Adding a new canon requires ONE entry here; all downstream consumers pick it up
 * automatically (or with a simple registry import).
 *
 * Lifecycle: Superseded registry snapshots are tracked via ContentDeprecated /
 * ContentAmended TX pairs — old versions are never hard-deleted.
 *
 * HD Root: m/44'/144'/0'/bible-codex/_meta/canon-registry
 * Version: 1.0.0 (initial — consolidates scattered config from BiblePortalPage,
 *          SourceContentGenerationBPMN, CodexLibraryTemplate)
 */

import { CANON_ROOTS } from '../bible/BibleCodexPaths';
import { BIBLE_CODEX_ROOT, CODEX_CONFIG_PREFIX } from '../bible/BibleCodexPaths';
import { chainletStorage } from '../sync/chainletStorage';

// ─── Canon Registration Entry ─────────────────────────────────

export interface CanonRegistryEntry {
  /** Constituent ID used in BiblePortalPage card grid (e.g. 'vulgate') */
  constituentId: string;
  /** Navigator tab ID used by BibleCodexDataAdapter (e.g. 'vulgate') */
  navId: string;
  /** Storage identity used in CanonCorpusIngestor (e.g. 'vulgate-latin') */
  storageId: string;
  /** HD root path from BibleCodexPaths */
  hdRoot: string;
  /** Human-readable label */
  label: string;
  /** Current lifecycle status */
  status: 'active' | 'planned' | 'deprecated';
  /** Primary / resident language */
  defaultLanguage: string;
  /** All available languages */
  languages: string[];
  /** Whether this canon is mandatory (cannot be unbound) */
  mandatory: boolean;
  /** Source-generation BPMN process ID (if defined) */
  sourceGenBPMN?: string;
}

// ─── The Registry ─────────────────────────────────────────────

export const CANON_REGISTRY: CanonRegistryEntry[] = [
  {
    constituentId: 'ethiopian-canon',
    navId: 'ethiopian',
    storageId: 'ethiopian-geez',
    hdRoot: CANON_ROOTS.ethiopian,
    label: 'Ethiopian Orthodox Tewahedo Canon',
    status: 'active',
    defaultLanguage: 'english',
    languages: ['geez', 'english'],
    mandatory: true,
    sourceGenBPMN: 'mkf:source-content-gen:ethiopian',
  },
  {
    constituentId: 'kjv-correlation',
    navId: 'kjv',
    storageId: 'kjv-english',
    hdRoot: CANON_ROOTS.kjv,
    label: 'King James Version',
    status: 'active',
    defaultLanguage: 'english',
    languages: ['english'],
    mandatory: true,
    sourceGenBPMN: 'mkf:source-content-gen:kjv',
  },
  {
    constituentId: 'peshitta',
    navId: 'peshitta',
    storageId: 'peshitta-syriac',
    hdRoot: CANON_ROOTS.peshitta,
    label: 'Peshitta (Syriac)',
    status: 'planned',
    defaultLanguage: 'syriac',
    languages: ['syriac', 'english'],
    mandatory: false,
    sourceGenBPMN: 'mkf:source-content-gen:peshitta',
  },
  {
    constituentId: 'wlc',
    navId: 'wlc',
    storageId: 'wlc-hebrew',
    hdRoot: CANON_ROOTS.wlc,
    label: 'Westminster Leningrad Codex',
    status: 'planned',
    defaultLanguage: 'hebrew',
    languages: ['hebrew', 'english'],
    mandatory: false,
    sourceGenBPMN: 'mkf:source-content-gen:wlc',
  },
  {
    constituentId: 'nestle-1904',
    navId: 'nestle-1904',
    storageId: 'nestle1904-greek',
    hdRoot: CANON_ROOTS.nestle1904,
    label: 'Nestle 1904 Greek New Testament',
    status: 'planned',
    defaultLanguage: 'greek',
    languages: ['greek', 'english'],
    mandatory: false,
    sourceGenBPMN: 'mkf:source-content-gen:nestle-1904',
  },
  {
    constituentId: 'dead-sea-scrolls',
    navId: 'qumran',
    storageId: 'qumran-hebrew',
    hdRoot: CANON_ROOTS.qumran,
    label: 'Dead Sea Scrolls (Qumran)',
    status: 'active',
    defaultLanguage: 'hebrew',
    languages: ['hebrew', 'english'],
    mandatory: false,
  },
  {
    constituentId: 'nag-hammadi',
    navId: 'nag-hammadi',
    storageId: 'nag-hammadi-coptic',
    hdRoot: CANON_ROOTS.nagHammadi,
    label: 'Nag Hammadi Library',
    status: 'active',
    defaultLanguage: 'coptic',
    languages: ['coptic', 'english'],
    mandatory: false,
  },
  {
    constituentId: 'vulgate',
    navId: 'vulgate',
    storageId: 'vulgate-latin',
    hdRoot: CANON_ROOTS.vulgate,
    label: 'Latin Vulgate (Clementine, 1592)',
    status: 'active',
    defaultLanguage: 'latin',
    languages: ['latin'],
    mandatory: false,
    sourceGenBPMN: 'mkf:source-content-gen:vulgate',
  },
];

// ─── Helpers ──────────────────────────────────────────────────

/** Get a registry entry by constituent ID */
export function getCanonByConstituentId(id: string): CanonRegistryEntry | undefined {
  return CANON_REGISTRY.find(c => c.constituentId === id);
}

/** Get a registry entry by nav ID */
export function getCanonByNavId(navId: string): CanonRegistryEntry | undefined {
  return CANON_REGISTRY.find(c => c.navId === navId);
}

/** Build the constituent-to-navId mapping from the registry */
export function buildConstituentToNavIdMap(): Record<string, string> {
  return Object.fromEntries(CANON_REGISTRY.map(c => [c.constituentId, c.navId]));
}

/** Get mandatory canon constituent IDs */
export function getMandatoryCanonIds(): string[] {
  return CANON_REGISTRY.filter(c => c.mandatory).map(c => c.constituentId);
}

/** Get default bound canon constituent IDs (all registered) */
export function getDefaultBoundCanonIds(): string[] {
  return CANON_REGISTRY.map(c => c.constituentId);
}

/** Get all active canons */
export function getActiveCanons(): CanonRegistryEntry[] {
  return CANON_REGISTRY.filter(c => c.status === 'active');
}

/** Get all registered canon nav IDs */
export function getAllNavIds(): string[] {
  return CANON_REGISTRY.map(c => c.navId);
}

// ─── Lifecycle / Amendment Tracking ───────────────────────────

export interface CanonRegistryAmendment {
  version: string;
  timestamp: string;
  action: 'ContentAmended' | 'ContentDeprecated';
  description: string;
  affectedCanons: string[];
}

/** Amendment history for the canon registry */
export const CANON_REGISTRY_AMENDMENTS: CanonRegistryAmendment[] = [
  {
    version: '1.0.0',
    timestamp: '2026-04-12T00:00:00Z',
    action: 'ContentAmended',
    description: 'Initial registry — consolidated from scattered config in BiblePortalPage, SourceContentGenerationBPMN, CodexLibraryTemplate. Added Vulgate as active canon.',
    affectedCanons: ['vulgate'],
  },
  {
    version: '1.1.0',
    timestamp: '2026-04-12T12:00:00Z',
    action: 'ContentAmended',
    description: 'Dynamic config cache via FetchSkillsOnChain + RefreshConfigCache. Static CANON_REGISTRY becomes seed/fallback. CreateEventSubscription for ongoing invalidation (AX-68, AX-69, AX-70).',
    affectedCanons: ['*'],
  },
];

// ─── Dynamic Config Cache (AX-69, AX-70) ─────────────────────

/**
 * RefreshConfigCache — Discover all canon configs via FetchSkillsOnChain
 * and cache them in chainletStorage. Called on boot and on event-driven invalidation.
 */
let _refreshInflight: Promise<void> | null = null;
let _lastRefreshAt = 0;
const REFRESH_COOLDOWN_MS = 250;

export async function RefreshConfigCache(): Promise<void> {
  // Single-flight: coalesce concurrent callers; cooldown guards back-to-back.
  if (_refreshInflight) return _refreshInflight;
  if (Date.now() - _lastRefreshAt < REFRESH_COOLDOWN_MS) return;

  _refreshInflight = (async () => {
    try {
      const { FetchSkillsOnChain } = await import('../skills/FetchSkillsOnChain');
      await FetchSkillsOnChain(BIBLE_CODEX_ROOT);
      console.log('[CanonRegistry] RefreshConfigCache complete');
    } catch (err) {
      console.warn('[CanonRegistry] RefreshConfigCache failed, using static seed:', err);
    } finally {
      _lastRefreshAt = Date.now();
      _refreshInflight = null;
    }
  })();
  return _refreshInflight;
}

/**
 * Get a single canon config from cache, falling back to static seed.
 */
export function getCanonConfig(canonKey: string): CanonRegistryEntry | undefined {
  try {
    const raw = chainletStorage.getItem(`${CODEX_CONFIG_PREFIX}${canonKey}`);
    if (raw) {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      // Check TTL
      if (parsed._cachedAt && parsed._ttl) {
        const age = Date.now() - new Date(parsed._cachedAt).getTime();
        if (age < parsed._ttl) {
          const { _cachedAt, _ttl, ...entry } = parsed;
          return entry as CanonRegistryEntry;
        }
      }
    }
  } catch {
    // Cache read failed
  }
  // Fallback to static seed
  return CANON_REGISTRY.find(c => c.navId === canonKey || c.constituentId === canonKey);
}

/**
 * Get all canon configs from cache index, falling back to static seed.
 */
export function getAllCanonConfigs(): CanonRegistryEntry[] {
  try {
    const indexRaw = chainletStorage.getItem(`${CODEX_CONFIG_PREFIX}__index__`);
    if (indexRaw) {
      const index = typeof indexRaw === 'string' ? JSON.parse(indexRaw) : indexRaw;
      if (Array.isArray(index.keys)) {
        const results: CanonRegistryEntry[] = [];
        for (const key of index.keys) {
          const entry = getCanonConfig(key);
          if (entry) results.push(entry);
        }
        if (results.length > 0) return results;
      }
    }
  } catch {
    // Fallback
  }
  return [...CANON_REGISTRY];
}

/**
 * Initialize ongoing cache invalidation via CreateEventSubscription.
 * Call once on boot after RefreshConfigCache().
 */
export async function initConfigSubscription(): Promise<() => void> {
  const { CreateEventSubscription } = await import('../sync/CreateEventSubscription');
  // Listen on the EVENT prefix (where SkillBindingCreated/Deprecated/
  // ContentAmended TXs land) — NOT the cache-projection prefix that this
  // very refresh writes to. Subscribing to the cache prefix caused a
  // self-feeding loop because cache writes have no eventType to filter on.
  return CreateEventSubscription(
    'cappz:skill-config/events/',
    () => {
      RefreshConfigCache().catch(err =>
        console.warn('[CanonRegistry] Event-driven refresh failed:', err)
      );
    },
    ['SkillBindingCreated', 'SkillBindingDeprecated', 'ContentAmended'],
  );
}
