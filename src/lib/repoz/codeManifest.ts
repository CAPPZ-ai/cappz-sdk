/**
 * COPE node crystallized.
 * Node ID: v14-16-00-code-manifest
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Stage 1 (shadow) of "all code in wallets": every source file gets a RepoZ
 * address under <app>/repoz/code/<path>, a hash, and ContentCreated/ContentAmended
 * against the prior manifest. GitHub is compared and drift is reported, not blocking.
 * Plus a cascading wallet-graph export (down ConstituentIncluded edges).
 */
import { repozCodeRoot } from './paths';

export interface CodeArtifact { path: string; address: string; hash: string; generated: boolean; event: 'ContentCreated' | 'ContentAmended' | 'Unchanged' }

const SECRET_PATHS = [/(^|\/)\.env(\.|$)/, /secrets?\.(json|ya?ml)$/i];
const GENERATED = [/\.generated\./, /^src\/generated\//];

export function codeAddress(appRoot: string, filePath: string): string {
  return `${repozCodeRoot(appRoot)}/${filePath.split('/').map(encodeURIComponent).join('/')}`;
}

export function planCodeManifest(appRoot: string, current: Record<string, string>, prior: Record<string, string> = {}): CodeArtifact[] {
  return Object.keys(current)
    .filter((p) => !SECRET_PATHS.some((re) => re.test(p)))
    .sort()
    .map((p) => ({
      path: p,
      address: codeAddress(appRoot, p),
      hash: current[p],
      generated: GENERATED.some((re) => re.test(p)),
      event: !(p in prior) ? 'ContentCreated' : prior[p] === current[p] ? 'Unchanged' : 'ContentAmended',
    }));
}

/** Shadow drift: wallet manifest vs GitHub mirror hashes. */
export function compareWithMirror(wallet: Record<string, string>, mirror: Record<string, string>): { onlyInWallet: string[]; onlyInMirror: string[]; differ: string[] } {
  const keys = new Set([...Object.keys(wallet), ...Object.keys(mirror)]);
  const r = { onlyInWallet: [] as string[], onlyInMirror: [] as string[], differ: [] as string[] };
  for (const k of [...keys].sort()) {
    if (!(k in mirror)) r.onlyInWallet.push(k);
    else if (!(k in wallet)) r.onlyInMirror.push(k);
    else if (wallet[k] !== mirror[k]) r.differ.push(k);
  }
  return r;
}

/**
 * v14-16-01 multi-master import: a GitHub-side change that did not come through
 * RepoZ is staged as a pending amendment — ContentCreated for new files,
 * ContentAmended (referencing the base head it changes) for existing ones.
 * If the same file also changed RepoZ-side since the base, the import collides
 * and is flagged for Conflict Remediation instead of being silently merged.
 */
export interface StagedImport {
  path: string;
  address: string;
  event: 'ContentCreated' | 'ContentAmended' | 'ConflictDetected';
  baseHash?: string;
  incomingHash: string;
}

export function planGitHubImport(
  appRoot: string,
  mirror: Record<string, string>,
  walletBase: Record<string, string>,
  walletHead: Record<string, string> = walletBase,
): StagedImport[] {
  const drift = compareWithMirror(walletHead, mirror);
  const staged: StagedImport[] = [];
  for (const p of [...drift.onlyInMirror, ...drift.differ].filter((p) => !SECRET_PATHS.some((re) => re.test(p))).sort()) {
    const address = codeAddress(appRoot, p);
    const baseHash = walletBase[p];
    const headChanged = p in walletHead && walletHead[p] !== baseHash;
    if (headChanged && baseHash !== undefined) {
      staged.push({ path: p, address, event: 'ConflictDetected', baseHash, incomingHash: mirror[p] });
    } else {
      staged.push({ path: p, address, event: baseHash === undefined ? 'ContentCreated' : 'ContentAmended', baseHash, incomingHash: mirror[p] });
    }
  }
  return staged;
}

export interface GraphEdge { eventType: string; sourceAddress: string; targetAddress: string }
export interface ExportOptions {
  /** Follow edges into included shared branches outside the start subtree. */
  acrossShared?: boolean;
  /** Addresses the caller may read; anything else (e.g. another tenant's /_local) is skipped. */
  canRead: (address: string) => boolean;
}

/** Cascading export: start node, its subtree, and ConstituentIncluded children; never private namespaces of others. */
export function collectExportSet(start: string, edges: GraphEdge[], addresses: string[], opts: ExportOptions): string[] {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const a = queue.shift()!;
    if (seen.has(a) || !opts.canRead(a)) continue;
    if (!a.startsWith(start) && !opts.acrossShared) continue;
    seen.add(a);
    for (const x of addresses) if (x !== a && x.startsWith(`${a}/`)) queue.push(x);
    for (const e of edges) if (e.eventType === 'ConstituentIncluded' && e.sourceAddress === a) queue.push(e.targetAddress);
  }
  return [...seen].sort();
}
