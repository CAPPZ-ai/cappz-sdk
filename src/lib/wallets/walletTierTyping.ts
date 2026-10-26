/**
 * COPE node crystallized.
 * Node ID: v11-5-1-mdm-wallet-tiers
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Wallet tier typing as MDM refdata (v11-5-1-mdm-wallet-tiers).
 *
 * AX-73 (no static registries) / AP-17 (no hardcoded paths) / AX-68 (generic
 * HD-walk-and-resolve): a wallet's tier is NOT a computed string and NOT a
 * local table. It is a transaction from the wallet root to the permanent HD
 * address of a `cappz:/WalletTier` refdata value.
 *
 *   cappz:/WalletTier/PTW  <- WalletTierTyped (source = <ptw root>)
 *   cappz:/WalletTier/POW  <- WalletTierTyped (source = <pow replica root>, ...N)
 *   cappz:/WalletTier/UAW  <- WalletTierTyped (source = <uaw root>, ...thousands)
 *
 * Tier membership is therefore an inbound-edge SET, never a singleton. Zero,
 * one or many POWs are all legal: replicas exist for redundancy, scale-out,
 * geolocated load balance and data-residency (GDPR) requirements.
 *
 * AP-12: no boolean flags — re-typing and user↔POW anchoring are resolved by
 * latest-wins replay of correlated transactions.
 */

import { cappzRefDataWallet } from '../wallet/chainlet/CappzRefDataWallet';
import { WALLET_TIER_DOMAIN } from '../wallet/chainlet/cappzDomains';
import {
  appendWalletTierTxs,
  createWalletTierTx,
  findTxsForSource,
  findTxsForTarget,
  getWalletTierTxs,
  refreshWalletTierTxs,
  type WalletTierTx,
} from './walletTierEvents';

// ─── Tier codes ────────────────────────────────────────────────

export type WalletTierCode = 'PTW' | 'POW' | 'UAW';

export const WALLET_TIER_CODES: readonly WalletTierCode[] = ['PTW', 'POW', 'UAW'] as const;

/** Why a POW replica exists. Discriminates copies in a multi-POW deployment. */
export type PowPurpose = 'redundancy' | 'scale-out' | 'residency';

export interface WalletTierAttribution {
  /** Pseudonymous alias address of the originator. Never an identity. */
  aliasAddress?: string;
  /** TX id of the origination event this typing is correlated to. */
  originationTxId?: string;
  /** Coarse region only (e.g. 'eu-west', 'us-east'). Never coordinates. */
  region?: string;
  /** Application slug this wallet serves. */
  slug?: string;
  /** POW-only: human label for the replica. */
  replicaLabel?: string;
  /** POW-only: regulatory jurisdiction the replica satisfies (e.g. 'EU/GDPR'). */
  jurisdiction?: string;
  /** POW-only: why the replica exists. */
  purpose?: PowPurpose;
  /** Content parent address, when it differs from `<root>/content/<slug>`. */
  contentRoot?: string;
}

// ─── Refdata address resolution (AX-68) ───────────────────────

/** Permanent HD value address for a tier code. */
export function resolveTierAddress(tier: WalletTierCode): string {
  return cappzRefDataWallet.resolveAddress(WALLET_TIER_DOMAIN.domainCode, tier);
}

/** Reverse: HD value address → tier code, or null when not a tier address. */
export function resolveTierCodeByAddress(hdAddress: string): WalletTierCode | null {
  for (const code of WALLET_TIER_CODES) {
    if (resolveTierAddress(code) === hdAddress) return code;
  }
  return null;
}

// ─── Typing (origination) ─────────────────────────────────────

export interface TypeWalletParams {
  walletRoot: string;
  tier: WalletTierCode;
  attribution?: WalletTierAttribution;
  /** Set when this supersedes an earlier typing — emits WalletTierRetyped. */
  retype?: boolean;
}

/**
 * Declare a wallet's tier by emitting a typing TX to the refdata value address.
 * Idempotent: a wallet already typed to the same tier is not re-emitted.
 */
export async function typeWallet(params: TypeWalletParams): Promise<WalletTierTx | null> {
  const { walletRoot, tier, attribution, retype } = params;
  const targetAddress = resolveTierAddress(tier);

  const current = resolveWalletTier(walletRoot);
  if (current === tier && !retype) return null;

  const eventType = current && current !== tier ? 'WalletTierRetyped' : 'WalletTierTyped';

  const tx = await createWalletTierTx({
    txId: `wallet-tier:${tier}:${walletRoot}:${Date.now()}`,
    eventType,
    sourceAddress: walletRoot,
    targetAddress,
    payload: {
      tier,
      tierAddress: targetAddress,
      previousTier: current ?? null,
      ...(attribution ?? {}),
    },
  });

  await appendWalletTierTxs([tx]);
  return tx;
}

// ─── Resolution (latest-wins replay) ──────────────────────────

/** The tier a wallet root is currently typed as, or null when untyped. */
export function resolveWalletTier(
  walletRoot: string,
  txs = getWalletTierTxs(),
): WalletTierCode | null {
  const typing = findTxsForSource(walletRoot, txs).filter(
    (t) => t.eventType === 'WalletTierTyped' || t.eventType === 'WalletTierRetyped',
  );
  const latest = typing[typing.length - 1];
  if (!latest) return null;
  const code = resolveTierCodeByAddress(latest.targetAddress);
  return code ?? ((latest.payload.tier as WalletTierCode) ?? null);
}

export interface TypedWallet {
  root: string;
  tier: WalletTierCode;
  typedAt: string;
  attribution: WalletTierAttribution;
}

/**
 * Ecosystem census primitive: every wallet currently typed to a tier.
 * Reads the inbound-edge set of the tier's refdata value address.
 */
export function listWalletsOfTier(
  tier: WalletTierCode,
  txs = getWalletTierTxs(),
): TypedWallet[] {
  const targetAddress = resolveTierAddress(tier);
  const byRoot = new Map<string, TypedWallet>();

  for (const tx of findTxsForTarget(targetAddress, txs)) {
    if (tx.eventType !== 'WalletTierTyped' && tx.eventType !== 'WalletTierRetyped') continue;
    byRoot.set(tx.sourceAddress, {
      root: tx.sourceAddress,
      tier,
      typedAt: tx.timestamp,
      attribution: tx.payload as WalletTierAttribution,
    });
  }

  // Drop wallets whose LATEST typing moved them to a different tier.
  return Array.from(byRoot.values())
    .filter((w) => resolveWalletTier(w.root, txs) === tier)
    .sort((a, b) => a.typedAt.localeCompare(b.typedAt));
}

/** POW replicas serving an application slug, oldest typing first. */
export function listPowReplicas(slug: string, txs = getWalletTierTxs()): TypedWallet[] {
  return listWalletsOfTier('POW', txs).filter(
    (w) => !w.attribution.slug || w.attribution.slug === slug,
  );
}

// ─── Multi-POW user anchoring (AP-12: a TX, not a setting) ────

/**
 * Anchor a user's account root to a specific POW replica. Shared-state mode:
 * the user joins that replica's pooled Public Session. Re-anchoring emits a
 * new TX; the latest one wins. Isolated-state mode simply never anchors.
 */
export async function anchorUserToPow(params: {
  userRoot: string;
  powRoot: string;
  slug: string;
  reason?: PowPurpose | 'user-choice';
}): Promise<WalletTierTx> {
  const tx = await createWalletTierTx({
    txId: `pow-anchor:${params.slug}:${params.userRoot}:${Date.now()}`,
    eventType: 'UserPowAnchored',
    sourceAddress: params.userRoot,
    targetAddress: params.powRoot,
    payload: { slug: params.slug, reason: params.reason ?? 'user-choice' },
  });
  await appendWalletTierTxs([tx]);
  return tx;
}

/** The POW root a user is currently anchored to for a slug, or null. */
export function resolveUserPowAnchor(
  userRoot: string,
  slug: string,
  txs = getWalletTierTxs(),
): string | null {
  const anchors = findTxsForSource(userRoot, txs).filter(
    (t) => t.eventType === 'UserPowAnchored' && t.payload.slug === slug,
  );
  const latest = anchors[anchors.length - 1];
  return latest ? latest.targetAddress : null;
}

/** How many UAWs are anchored to each POW replica — replica load view. */
export function countAnchorsPerPow(slug: string, txs = getWalletTierTxs()): Map<string, number> {
  const latestByUser = new Map<string, string>();
  for (const tx of txs) {
    if (tx.eventType !== 'UserPowAnchored' || tx.payload.slug !== slug) continue;
    latestByUser.set(tx.sourceAddress, tx.targetAddress);
  }
  const counts = new Map<string, number>();
  for (const powRoot of latestByUser.values()) {
    counts.set(powRoot, (counts.get(powRoot) ?? 0) + 1);
  }
  return counts;
}

/**
 * Deterministic replica selection for an unanchored viewer:
 * nearest by declared region, else the earliest-typed replica. Never random.
 */
export function selectPowReplica(
  replicas: TypedWallet[],
  preferredRegion?: string,
): TypedWallet | null {
  if (replicas.length === 0) return null;
  if (preferredRegion) {
    const match = replicas.find((r) => r.attribution.region === preferredRegion);
    if (match) return match;
  }
  return replicas[0];
}

// ─── Census ───────────────────────────────────────────────────

export interface WalletTierCensus {
  tier: WalletTierCode;
  tierAddress: string;
  count: number;
  byRegion: Record<string, number>;
}

export function censusWalletTiers(txs = getWalletTierTxs()): WalletTierCensus[] {
  return WALLET_TIER_CODES.map((tier) => {
    const wallets = listWalletsOfTier(tier, txs);
    const byRegion: Record<string, number> = {};
    for (const w of wallets) {
      const region = w.attribution.region ?? 'unspecified';
      byRegion[region] = (byRegion[region] ?? 0) + 1;
    }
    return { tier, tierAddress: resolveTierAddress(tier), count: wallets.length, byRegion };
  });
}

/** Hydrate the tier event log before resolving (cold start). */
export async function ensureWalletTierTxs(): Promise<WalletTierTx[]> {
  return refreshWalletTierTxs();
}
