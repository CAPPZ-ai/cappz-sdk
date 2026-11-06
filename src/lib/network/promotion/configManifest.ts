/**
 * Config manifest — what a promotion actually carries (15.34.0).
 *
 * A platform's configuration is not a pile of ledger memos on one account. It
 * is what the app ships (token definition, exchange rules, requirements) plus
 * what each network's accounts commit to on their own ledger (a release plan,
 * fee tokens). The app collects both into a manifest per network. A manifest
 * never holds ledger state the run itself writes (issuer flags, trust lines):
 * the anchor is written mid-run and must still match at verification.
 * Promotion compares the source manifest with the target's:
 *
 *   shared entries   must be equal on both networks. Both present and unequal
 *                    is the only thing that blocks ("differs").
 *   network entries  differ by design (addresses, fee-token issuers, a plan's
 *                    start date); they are reported, never compared.
 *
 * Missing is not equal and not different: an entry absent on one side is
 * reported as missing-on-source / missing-on-target so the operator sees it,
 * and the decision is theirs. The target manifest's hash is what a promotion
 * anchors on the target network (CONFIG_MANIFEST_MEMO), so anyone can later
 * recompute it from the same release and the same ledger.
 */
import { canonicalJson, sha256HexOf } from '../../identity/canonical';
import type { PromotionNetwork } from './promotionRun';

export type ConfigScope = 'shared' | 'network';

export interface ConfigEntry {
  /** Stable key, e.g. `token`, `tokenomics.months`, `addresses.issuer`. */
  key: string;
  scope: ConfigScope;
  /** `undefined` means the source of this entry holds nothing (missing, not empty). */
  value: unknown;
  /** Where the value was read: a shipped file, a registry, or `ledger:<account>`. */
  from: string;
}

export interface ConfigManifest {
  network: PromotionNetwork;
  entries: ConfigEntry[];
  /** False when a ledger read was truncated or failed, so an absent entry may only be unread. */
  complete: boolean;
  /** Reads that could not complete, in words. */
  gaps: string[];
}

export type ConfigEntryState = 'equal' | 'differs' | 'missing-on-source' | 'missing-on-target' | 'missing-on-both' | 'network-specific';

export interface ConfigDiffRow {
  key: string;
  scope: ConfigScope;
  state: ConfigEntryState;
  source?: unknown;
  target?: unknown;
}

export interface ConfigDiff {
  rows: ConfigDiffRow[];
  /** Shared entries present on both sides with different values. */
  blocking: ConfigDiffRow[];
  counts: Record<ConfigEntryState, number>;
}

const present = (e: ConfigEntry | undefined): e is ConfigEntry => !!e && e.value !== undefined;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

export function diffConfigManifests(source: ConfigManifest, target: ConfigManifest): ConfigDiff {
  const s = new Map(source.entries.map((e) => [e.key, e]));
  const t = new Map(target.entries.map((e) => [e.key, e]));
  const keys = [...new Set([...s.keys(), ...t.keys()])].sort();
  const rows: ConfigDiffRow[] = keys.map((key) => {
    const a = s.get(key);
    const b = t.get(key);
    const scope: ConfigScope = (a ?? b)!.scope;
    const row: ConfigDiffRow = { key, scope, state: 'equal', ...(present(a) ? { source: a.value } : {}), ...(present(b) ? { target: b.value } : {}) };
    if (!present(a) && !present(b)) row.state = 'missing-on-both';
    else if (!present(a)) row.state = 'missing-on-source';
    else if (!present(b)) row.state = 'missing-on-target';
    else if (scope === 'network') row.state = 'network-specific';
    else row.state = same(a.value, b.value) ? 'equal' : 'differs';
    return row;
  });
  const counts = { equal: 0, differs: 0, 'missing-on-source': 0, 'missing-on-target': 0, 'missing-on-both': 0, 'network-specific': 0 } as Record<ConfigEntryState, number>;
  for (const r of rows) counts[r.state]++;
  return { rows, blocking: rows.filter((r) => r.state === 'differs'), counts };
}

/** Canonical hash over the entries (key, scope, value); `from` and gaps are provenance, not content. */
export function configManifestHash(m: ConfigManifest, scope?: ConfigScope): Promise<string> {
  const entries = m.entries
    .filter((e) => !scope || e.scope === scope)
    .map((e) => [e.key, e.scope, e.value === undefined ? null : e.value])
    .sort((x, y) => String(x[0]).localeCompare(String(y[0])));
  return sha256HexOf(canonicalJson(entries));
}

/** The memo a promotion anchors on the target network: small, recomputable, no values. */
export const CONFIG_MANIFEST_MEMO = 'cappz:config:manifest';

export interface ConfigManifestAnchor {
  kind: 'ConfigManifestAnchored';
  v: 1;
  source: PromotionNetwork;
  target: PromotionNetwork;
  /** The release that collected the manifest (so the hash can be recomputed from the same code). */
  release: string;
  /** Hash of the target manifest (every entry). */
  manifest: string;
  /** Hash of the shared entries; equal on both networks when nothing differs. */
  shared: string;
  entries: number;
}

export async function configManifestAnchor(p: { source: ConfigManifest; target: ConfigManifest; release: string }): Promise<ConfigManifestAnchor> {
  return {
    kind: 'ConfigManifestAnchored', v: 1,
    source: p.source.network, target: p.target.network, release: p.release,
    manifest: await configManifestHash(p.target),
    shared: await configManifestHash(p.target, 'shared'),
    entries: p.target.entries.length,
  };
}

/** True when `anchors` already holds this manifest for this network pair (idempotent anchoring). */
export function hasConfigManifestAnchor(anchors: ReadonlyArray<Partial<ConfigManifestAnchor>>, want: Pick<ConfigManifestAnchor, 'source' | 'target' | 'manifest'>): boolean {
  return anchors.some((a) => a.source === want.source && a.target === want.target && a.manifest === want.manifest);
}

/** One line per state for a check reason or a step detail. */
export function describeConfigDiff(d: ConfigDiff, source: PromotionNetwork, target: PromotionNetwork): string {
  const keys = (state: ConfigEntryState) => d.rows.filter((r) => r.state === state).map((r) => r.key).join(', ');
  // A rehearsal has the same network on both sides, so name the side as well.
  const src = source === target ? `the source (${source})` : source;
  const tgt = source === target ? `the target (${target})` : target;
  const parts: string[] = [];
  if (d.counts.equal) parts.push(`${d.counts.equal} shared entries equal`);
  if (d.counts.differs) parts.push(`differs: ${keys('differs')}`);
  if (d.counts['missing-on-source']) parts.push(`not on ${src}: ${keys('missing-on-source')}`);
  if (d.counts['missing-on-target']) parts.push(`not on ${tgt}: ${keys('missing-on-target')}`);
  if (d.counts['missing-on-both']) parts.push(`on neither: ${keys('missing-on-both')}`);
  if (d.counts['network-specific']) parts.push(`${d.counts['network-specific']} network-specific (${keys('network-specific')})`);
  return parts.join('; ');
}
