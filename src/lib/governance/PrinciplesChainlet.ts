/**
 * PrinciplesChainlet — sovereign anchor for the COPE Substrate.
 *
 * Emits PrincipleAdopted / PrincipleAmended TXs at:
 *   m/44'/144'/100'/principles/<id>/v<N>
 *
 * Every admin verb, BPMN dispatch and notarization that declares
 * `governingPrinciple` is verified against the on-chain hash of the
 * referenced principle at dispatch time. A missing or drifted hash
 * structurally fails the dispatch (M7 — substrate-drift detector).
 *
 * AX-73 compliant: no static registry. The active principle list
 * is hydrated from the chain via `listActivePrinciples()`.
 *
 * AP-12 compliant: principle activation/revocation is event-sourced
 * (PrincipleAdopted vs PrincipleRevoked). No boolean enabled flags.
 */

import { CappzEventCache } from '../sync/CappzEventCache';
import { WALLET_ROOTS } from '../wallets/paths';

// ─── HD Path Constants ───────────────────────────────────────────

/** RepoZ root for principles — m/44'/144'/100'/principles */
export const PRINCIPLES_ROOT = `${WALLET_ROOTS.UNASSIGNED.replace(/\/99'$/, "/100'")}/principles`;

/** Build a versioned principle path. */
export function principlePath(id: string, version: number): string {
  return `${PRINCIPLES_ROOT}/${id}/v${version}`;
}

/** Build a principle id root (un-versioned). */
export function principleIdRoot(id: string): string {
  return `${PRINCIPLES_ROOT}/${id}`;
}

// ─── Types ───────────────────────────────────────────────────────

export type PrincipleEventType =
  | 'PrincipleAdopted'
  | 'PrincipleAmended'
  | 'PrincipleRevoked'
  | 'PrincipleInvoked';

export interface PrincipleRecord {
  /** CappzEventCacheEntry — txId is the principle's HD path. */
  txId: string;
  /** CappzEventCacheEntry — adoption time. */
  timestamp: string;
  /** Stable id, e.g. 'cope' */
  id: string;
  /** Monotonically increasing version */
  version: number;
  /** Full HD path to this version */
  path: string;
  /** SHA-256 of the canonical document content (lowercase hex) */
  contentHash: string;
  /** Path to the source document, e.g. 'public/soul.md' */
  sourceDocument: string;
  /** Adoption / amendment rationale */
  rationale: string;
  /** Author wallet (or 'lovable-agent' for substrate-level adoption) */
  author: string;
  adoptedAt: string;
  /** If amendment, the prior version's contentHash */
  previousHash?: string;
  /** Event type — which lifecycle TX produced this record */
  eventType: PrincipleEventType;
}

export interface PrincipleInvocationRecord {
  /** CappzEventCacheEntry — txId is the invocationId. */
  txId: string;
  /** CappzEventCacheEntry — invocation time. */
  timestamp: string;
  invocationId: string;
  commandId: string;
  principlePath: string;
  principleHash: string;
  invokedAt: string;
  invokedBy: string;
  /** Pass = the invocation's expected hash matched the current chain hash */
  hashVerified: boolean;
}

// ─── Storage ─────────────────────────────────────────────────────

const principleCache = new CappzEventCache<PrincipleRecord>(
  PRINCIPLES_ROOT,
  'cappz:principles',
);

const invocationCache = new CappzEventCache<PrincipleInvocationRecord>(
  `${PRINCIPLES_ROOT}/_invocations`,
  'cappz:principles:invocations',
);

// ─── Hash Helper ─────────────────────────────────────────────────

/**
 * SHA-256 of arbitrary string content. Lower-case hex.
 * Browser-native via SubtleCrypto.
 */
export async function sha256Hex(content: string): Promise<string> {
  const enc = new TextEncoder().encode(content);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ─── Public API ──────────────────────────────────────────────────

export const principlesChainlet = {
  /**
   * Adopt a new principle (initial v1) or initial bootstrap.
   * Idempotent: if a record at this path with the same contentHash
   * already exists, returns it without emitting a new TX.
   */
  async adopt(params: {
    id: string;
    sourceDocument: string;
    content: string;
    rationale: string;
    author: string;
  }): Promise<PrincipleRecord> {
    const contentHash = await sha256Hex(params.content);
    const existing = (await principleCache.refresh()).find(
      r => r.id === params.id && r.contentHash === contentHash,
    );
    if (existing) return existing;

    const version = 1;
    const path = principlePath(params.id, version);
    const adoptedAt = new Date().toISOString();
    const record: PrincipleRecord = {
      txId: path,
      timestamp: adoptedAt,
      id: params.id,
      version,
      path,
      contentHash,
      sourceDocument: params.sourceDocument,
      rationale: params.rationale,
      author: params.author,
      adoptedAt,
      eventType: 'PrincipleAdopted',
    };
    await principleCache.append(record);
    return record;
  },

  /**
   * Amend an existing principle to a new version.
   * Requires the previous version's hash; emits PrincipleAmended.
   */
  async amend(params: {
    id: string;
    sourceDocument: string;
    content: string;
    rationale: string;
    author: string;
  }): Promise<PrincipleRecord> {
    const all = await principleCache.refresh();
    const prior = all
      .filter(r => r.id === params.id)
      .sort((a, b) => b.version - a.version)[0];
    if (!prior) {
      throw new Error(
        `[PrinciplesChainlet] cannot amend unknown principle: ${params.id}`,
      );
    }
    const contentHash = await sha256Hex(params.content);
    if (contentHash === prior.contentHash) return prior; // no-op

    const version = prior.version + 1;
    const path = principlePath(params.id, version);
    const adoptedAt = new Date().toISOString();
    const record: PrincipleRecord = {
      txId: path,
      timestamp: adoptedAt,
      id: params.id,
      version,
      path,
      contentHash,
      sourceDocument: params.sourceDocument,
      rationale: params.rationale,
      author: params.author,
      adoptedAt,
      previousHash: prior.contentHash,
      eventType: 'PrincipleAmended',
    };
    await principleCache.append(record);
    return record;
  },

  /**
   * List active principles (latest version of each id, not revoked).
   * AX-73: hydrated from chain, never from a static registry.
   */
  async listActivePrinciples(): Promise<PrincipleRecord[]> {
    const all = await principleCache.refresh();
    const byId = new Map<string, PrincipleRecord>();
    for (const r of all) {
      if (r.eventType === 'PrincipleRevoked') {
        byId.delete(r.id);
        continue;
      }
      const cur = byId.get(r.id);
      if (!cur || r.version > cur.version) byId.set(r.id, r);
    }
    return Array.from(byId.values());
  },

  /** Resolve the declared version, not an unrelated latest-version hash. */
  async getAtPath(path: string): Promise<PrincipleRecord | null> {
    const all = await principleCache.refresh();
    const records = all.filter(r => r.path === path &&
      (r.eventType === 'PrincipleAdopted' || r.eventType === 'PrincipleAmended'));
    const record = records[0];
    if (!record || !record.contentHash || records.some(r => r.contentHash !== record.contentHash)) return null;
    const active = await this.listActivePrinciples();
    if (!active.some(r => r.id === record.id)) return null;
    return record;
  },

  /**
   * Verify a principle path's recorded hash matches an expected hash.
   * Used by AdminCommandBus pre-dispatch (M7 substrate-drift detector).
   */
  async verifyPrincipleHash(
    path: string,
    expectedHash: string,
  ): Promise<boolean> {
    const record = await this.getAtPath(path);
    if (!record) return false;
    return record.contentHash === expectedHash;
  },

  /**
   * Resolve the latest record for a principle id.
   */
  async getLatest(id: string): Promise<PrincipleRecord | null> {
    const active = await this.listActivePrinciples();
    return active.find(r => r.id === id) ?? null;
  },

  /**
   * Record a principle invocation. Called by AdminCommandBus on every
   * dispatch. Persists as PrincipleInvoked TX so CodexOpsLogViewer can
   * surface it under the `principle_invocation` category.
   */
  async recordInvocation(params: {
    commandId: string;
    principlePath: string;
    principleHash: string;
    invokedBy: string;
    hashVerified: boolean;
  }): Promise<PrincipleInvocationRecord> {
    const invocationId = `inv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const invokedAt = new Date().toISOString();
    const record: PrincipleInvocationRecord = {
      txId: invocationId,
      timestamp: invokedAt,
      invocationId,
      commandId: params.commandId,
      principlePath: params.principlePath,
      principleHash: params.principleHash,
      invokedAt,
      invokedBy: params.invokedBy,
      hashVerified: params.hashVerified,
    };
    await invocationCache.append(record);
    return record;
  },

  /**
   * For diagnostics / tests: list raw cached principle records.
   */
  getCachedRecords(): PrincipleRecord[] {
    return principleCache.getCached();
  },

  getCachedInvocations(): PrincipleInvocationRecord[] {
    return invocationCache.getCached();
  },
};

// ─── Boot Helper ─────────────────────────────────────────────────

/**
 * Bootstrap the COPE substrate principle from public/soul.md.
 *
 * Called by SkillLoader during boot. Idempotent — only emits a TX
 * when the hash of soul.md has changed since the last adoption.
 */
export async function bootstrapCopeSubstrate(): Promise<PrincipleRecord> {
  // Fetch soul.md from the public root. Network failures fall back
  // to a stub so the chainlet still boots in offline / SSR contexts.
  let content = '';
  try {
    const res = await fetch('/soul.md', { cache: 'no-store' });
    if (res.ok) content = await res.text();
  } catch {
    /* offline / no-fetch context */
  }
  if (!content) {
    content = '# soul.md — COPE substrate (offline-fallback stub)\n';
  }

  const latest = await principlesChainlet.getLatest('cope');
  if (!latest) {
    return principlesChainlet.adopt({
      id: 'cope',
      sourceDocument: 'public/soul.md',
      content,
      rationale: 'Initial adoption of COPE substrate v1',
      author: 'lovable-agent',
    });
  }

  // If soul.md drifted vs. on-chain hash, amend.
  const newHash = await sha256Hex(content);
  if (newHash !== latest.contentHash) {
    return principlesChainlet.amend({
      id: 'cope',
      sourceDocument: 'public/soul.md',
      content,
      rationale: `soul.md drift detected; amending v${latest.version} → v${latest.version + 1}`,
      author: 'lovable-agent',
    });
  }
  return latest;
}
