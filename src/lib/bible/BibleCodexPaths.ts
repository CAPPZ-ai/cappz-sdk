/**
 * BibleCodexPaths — Single Source of Truth for all Bible Codex HD paths.
 *
 * AX-59: All HD paths for a codex or domain MUST be defined in a single
 * source-of-truth module. Consumer files import constants and builder
 * functions. Hardcoded path strings in consumer files is AP-17.
 *
 * AX-64: Language Sibling Addresses — Translations within a manuscript
 * tradition are sibling address trees under the canon root.
 *
 * HD Hierarchy:
 *   m/44'/144'/0'/bible-codex/                     ← BIBLE_CODEX_ROOT
 *   ├── ethiopian/                                  ← CANON_ROOTS.ethiopian
 *   │   ├── geez/{book}/{chapter}'/{verse}'         ← Original language
 *   │   ├── english/{book}/{chapter}'/{verse}'      ← Translation
 *   │   └── _meta/default-language → english
 *   ├── kjv/                                        ← CANON_ROOTS.kjv
 *   │   └── english/{book}/{chapter}'/{verse}'
 *   ├── peshitta/                                   ← CANON_ROOTS.peshitta
 *   │   ├── syriac/{book}/{chapter}'/{verse}'
 *   │   └── english/{book}/{chapter}'/{verse}'
 *   ├── wlc/                                        ← CANON_ROOTS.wlc
 *   │   ├── hebrew/{book}/{chapter}'/{verse}'
 *   │   └── english/{book}/{chapter}'/{verse}'
 *   ├── nestle-1904/                                ← CANON_ROOTS.nestle1904
 *   │   ├── greek/{book}/{chapter}'/{verse}'
 *   │   └── english/{book}/{chapter}'/{verse}'
 *   ├── qumran/                                     ← CANON_ROOTS.qumran
 *   │   └── {scroll}/{section}'/{fragment}'
 *   ├── nag-hammadi/                                ← CANON_ROOTS.nagHammadi
 *   │   └── codex-{n}/{tractate}/{section}'
 *   ├── geneva/                                     ← CANON_ROOTS.geneva (planned)
 *   └── vulgate/                                    ← CANON_ROOTS.vulgate (planned)
 *
 * CPM Package: cappz:bible-codex-paths@2.0.0
 * Wallet Address: m/44'/144'/0'/cappz/skills/bible/artifacts/BibleCodexPaths.ts
 */

// ─── HD Path Normalization ─────────────────────────────────────

/**
 * Normalize an HD path: trim whitespace, strip trailing non-alphanumeric/
 * non-apostrophe characters (slashes, dots, etc.).
 * Apostrophes are preserved because BIP-44 hardened indices end in '.
 */
export function normalizeHdPath(path: string): string {
  let s = path.trim();
  while (s.length > 0 && !/[a-zA-Z0-9']$/.test(s)) {
    s = s.slice(0, -1);
  }
  return s;
}

// ─── Codex KV Root (wallet-rooted key namespace) ──────────────

/**
 * Shared root for all codex KV keys. Content and ops-log are siblings
 * under this root, ensuring purge operations on one cannot touch the other.
 *
 * cappz:codex/content:...       ← corpus data
 * cappz:codex/ops-log:...       ← operations log
 * cappz:codex/ingest-meta:...   ← ingest metadata
 */
export const CODEX_KV_ROOT = 'cappz:codex';
export const CODEX_CONTENT_PREFIX = `${CODEX_KV_ROOT}/content:`;
export const CODEX_OPS_LOG_PREFIX = `${CODEX_KV_ROOT}/ops-log:`;
export const CODEX_INGEST_META_PREFIX = `${CODEX_KV_ROOT}/ingest-meta:`;
/** Config cache prefix for FetchSkillsOnChain / RefreshConfigCache (AX-69) */
export const CODEX_CONFIG_PREFIX = `${CODEX_KV_ROOT}/config/`;

// ─── Federated Codex Root ──────────────────────────────────────

/** The federated root for the entire Bible Codex domain */
export const BIBLE_CODEX_ROOT = normalizeHdPath("m/44'/144'/0'/bible-codex");

// ─── Canon Roots (derived from codex root) ─────────────────────

export const CANON_ROOTS = {
  ethiopian:   normalizeHdPath(`${BIBLE_CODEX_ROOT}/ethiopian`),
  kjv:         normalizeHdPath(`${BIBLE_CODEX_ROOT}/kjv`),
  peshitta:    normalizeHdPath(`${BIBLE_CODEX_ROOT}/peshitta`),
  wlc:         normalizeHdPath(`${BIBLE_CODEX_ROOT}/wlc`),
  nestle1904:  normalizeHdPath(`${BIBLE_CODEX_ROOT}/nestle-1904`),
  qumran:      normalizeHdPath(`${BIBLE_CODEX_ROOT}/qumran`),
  nagHammadi:  normalizeHdPath(`${BIBLE_CODEX_ROOT}/nag-hammadi`),
  /** Planned — Geneva Bible (1560) */
  geneva:      normalizeHdPath(`${BIBLE_CODEX_ROOT}/geneva`),
  /** Planned — Latin Vulgate */
  vulgate:     normalizeHdPath(`${BIBLE_CODEX_ROOT}/vulgate`),
} as const;

export type CanonKey = keyof typeof CANON_ROOTS;

// ─── Language Tier Builders (AX-64) ────────────────────────────

/** Build HD address for a canon's language root */
export function languageRoot(canon: CanonKey, language: string): string {
  return `${CANON_ROOTS[canon]}/${language}`;
}

/** Build HD address for a verse with explicit language tier */
export function verseAddressWithLang(canon: CanonKey, language: string, book: string, chapter: number, verse: number): string {
  return `${CANON_ROOTS[canon]}/${language}/${book}/${chapter}'/${verse}'`;
}

/** Build HD address for a chapter with explicit language tier */
export function chapterAddressWithLang(canon: CanonKey, language: string, book: string, chapter: number): string {
  return `${CANON_ROOTS[canon]}/${language}/${book}/${chapter}'`;
}

/** Build HD address for a book with explicit language tier */
export function bookAddressWithLang(canon: CanonKey, language: string, book: string): string {
  return `${CANON_ROOTS[canon]}/${language}/${book}`;
}

/** Build translation source meta address */
export function translationSourceAddress(canon: CanonKey, language: string): string {
  return `${CANON_ROOTS[canon]}/_meta/translation-sources/${language}`;
}

/** Build default language meta address */
export function defaultLanguageAddress(canon: CanonKey): string {
  return `${CANON_ROOTS[canon]}/_meta/default-language`;
}

// ─── Legacy Path Builder Functions (default language shorthand) ─

/** Build HD address for a specific verse (legacy — no language tier) */
export function verseAddress(canon: CanonKey, book: string, chapter: number, verse: number): string {
  return `${CANON_ROOTS[canon]}/${book}/${chapter}'/${verse}'`;
}

/** Build HD address for a chapter */
export function chapterAddress(canon: CanonKey, book: string, chapter: number): string {
  return `${CANON_ROOTS[canon]}/${book}/${chapter}'`;
}

/** Build HD address for a book */
export function bookAddress(canon: CanonKey, book: string): string {
  return `${CANON_ROOTS[canon]}/${book}`;
}

/** Build HD address for a Qumran scroll section/fragment */
export function scrollSectionAddress(scrollName: string, section: number, fragment: number): string {
  return `${CANON_ROOTS.qumran}/${scrollName.replace(/\s+/g, '-')}/${section}'/${fragment}'`;
}

/** Build HD address for a Nag Hammadi tractate section */
export function tractateSectionAddress(codex: number | string, tractateName: string, section: number): string {
  return `${CANON_ROOTS.nagHammadi}/codex-${codex}/${tractateName.replace(/\s+/g, '-').toLowerCase()}/${section}'`;
}

/** Build HD address for a Qumran scroll (book-level) */
export function scrollAddress(scrollName: string): string {
  return `${CANON_ROOTS.qumran}/${scrollName.replace(/\s+/g, '-').toLowerCase()}`;
}

/** Build HD address for a Nag Hammadi tractate (book-level) */
export function tractateAddress(codex: number | string, tractateName: string): string {
  const codexLabel = codex === 0 ? 'berlin-codex' : `codex-${codex}`;
  return `${CANON_ROOTS.nagHammadi}/${codexLabel}/${tractateName.replace(/\s+/g, '-').toLowerCase()}`;
}

/** Core content address for a canon */
export function canonCoreContentAddress(canon: CanonKey): string {
  return `${CANON_ROOTS[canon]}/core-content`;
}

/** Agent encryption key address for a canon */
export function canonAgentKeyAddress(canonSkillName: string): string {
  return `m/44'/144'/0'/cappz/skills/${canonSkillName}/keys/encryption`;
}
