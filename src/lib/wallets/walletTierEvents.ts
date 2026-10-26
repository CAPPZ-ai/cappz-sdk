/**
 * COPE node crystallized.
 * Node ID: v12-08-wallet-tier-events
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Wallet tiering event substrate (v12-08).
 *
 * Copy = by-ref read-only replica (no keys, resolves the template head).
 * Clone = by-val owned instance (its own namespace and writable zones).
 *
 * AP-12: no boolean flags. Tier membership, custody, alias identity and
 * agent turns are all resolved by replaying these transactions latest-wins.
 * AP-22: events are Noun-Verb (past tense).
 */

import { CappzEventCache, type CappzEventCacheEntry } from '../sync/CappzEventCache';
import { createNotarizedEvent, type EventCustodyStatus } from '../mdm/eventCustody';
import { cappzPath } from './paths';

export const WALLET_TIER_ROOT = cappzPath('wallet-tiers');
export const WALLET_TIER_GOVERNING_PRINCIPLE =
  "m/44'/144'/100'/principles/cope/v1#wallet-tier-sovereignty";

export type WalletTierEventType =
  // Tier origination
  | 'WalletCopied' // by-ref read-only replica created
  | 'WalletCloned' // by-val owned instance created
  | 'WalletTemplateRegistered' // instance ↔ template provenance edge
  | 'ConstituentIncluded' // reference edge to a content node
  | 'ConstituentRemoved'
  // MDM tier typing (v11-5-1-mdm-wallet-tiers)
  | 'WalletTierTyped' // wallet root → cappz:/WalletTier/{PTW|POW|UAW} value address
  | 'WalletTierRetyped' // correlated re-typing; latest-wins (AP-12)
  | 'UserPowAnchored' // user account root → chosen POW replica root
  // Version governance
  | 'VersionPinned' // opt-out of head tracking
  | 'VersionUnpinned'
  | 'DomainModelAmended' // upgrade broadcast from a template head
  // Agent context
  | 'SessionStarted'
  | 'NextSequenced'
  | 'PreviousSequenced'
  | 'ConstituentsAggregated'
  | 'ContextTurnAppended'
  // v14-16-23 agent workspace skill
  | 'ContextTagAssigned' // tag-value metadata on a context thread (append-only)
  | 'ContextTagRemoved'
  | 'ResearchRunRecorded' // one research run version inside a thread
  | 'ContentMigrated' // ad-hoc record moved into a wallet; source cleared only after this
  // Alias identity
  | 'UserAliasCreated'
  | 'UserAliasAmended'
  // v14-05-00 subscriptions + treasury (fees category)
  | 'SubscriptionStarted'
  | 'SubscriptionCancelled'
  | 'SubscriptionCharged'
  | 'FundsDeposited';

export interface WalletTierTx extends CappzEventCacheEntry {
  eventType: WalletTierEventType;
  sourceAddress: string;
  targetAddress: string;
  payload: Record<string, unknown> & { governingPrinciple: string };
  eventMdmAddress: string;
  eventRegistrationTxId: string;
  custodyStatus: EventCustodyStatus;
  txHash: string;
}

const tierCache = new CappzEventCache<WalletTierTx>(
  `${WALLET_TIER_ROOT}/event-log`,
  'cappz:wallet-tiers:events/',
);

export async function createWalletTierTx(params: {
  txId: string;
  timestamp?: string;
  eventType: WalletTierEventType;
  sourceAddress: string;
  targetAddress: string;
  payload?: Record<string, unknown>;
}): Promise<WalletTierTx> {
  const event = await createNotarizedEvent({
    ...params,
    governingPrinciple: WALLET_TIER_GOVERNING_PRINCIPLE,
    emitterDomain: 'wallet-tiers',
  });
  return { ...event, eventType: params.eventType };
}

export async function appendWalletTierTxs(txs: WalletTierTx[], options?: { requireDurable?: boolean }): Promise<WalletTierTx[]> {
  if (options?.requireDurable) { await tierCache.appendMany(txs, options); return tierCache.getCached(); }
  const existingIds = new Set(tierCache.getCached().map((t) => t.txId));
  for (const tx of txs) {
    if (existingIds.has(tx.txId)) continue;
    await tierCache.append(tx);
    existingIds.add(tx.txId);
  }
  return tierCache.getCached();
}

export async function refreshWalletTierTxs(): Promise<WalletTierTx[]> {
  return tierCache.refresh();
}

export function getWalletTierTxs(): WalletTierTx[] {
  return tierCache.getCached();
}

export function subscribeWalletTiers(fn: (entries: WalletTierTx[]) => void): () => void {
  return tierCache.subscribe(fn);
}

// ─── Resolution helpers (latest-wins replay, AP-12) ─────────────

/** All TXs targeting an address, oldest → newest. */
export function findTxsForTarget(targetAddress: string, txs = getWalletTierTxs()): WalletTierTx[] {
  return txs.filter((t) => t.targetAddress === targetAddress);
}

/** The most recent TX of a given type for an address, or null. */
export function resolveLatestTx(
  targetAddress: string,
  eventType: WalletTierEventType,
  txs = getWalletTierTxs(),
): WalletTierTx | null {
  const matches = findTxsForTarget(targetAddress, txs).filter((t) => t.eventType === eventType);
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

/**
 * Resolve the version a wallet reads at.
 * Default is `head` — a copy tracks the template head automatically, which is
 * what makes admin content amendments propagate with no per-user migration.
 * A `VersionPinned` (later un-pinnable) is the only way to opt out.
 */
export function resolveVersionMode(
  targetAddress: string,
  txs = getWalletTierTxs(),
): { mode: 'head' } | { mode: 'pinned'; version: string } {
  const relevant = findTxsForTarget(targetAddress, txs).filter(
    (t) => t.eventType === 'VersionPinned' || t.eventType === 'VersionUnpinned',
  );
  const latest = relevant[relevant.length - 1];
  if (!latest || latest.eventType === 'VersionUnpinned') return { mode: 'head' };
  return { mode: 'pinned', version: String(latest.payload.version ?? '') };
}

/** Reference edges currently in force for a wallet (included minus removed). */
export function resolveConstituents(
  targetAddress: string,
  txs = getWalletTierTxs(),
): string[] {
  const state = new Map<string, boolean>();
  for (const tx of findTxsForTarget(targetAddress, txs)) {
    if (tx.eventType === 'ConstituentIncluded') {
      state.set(String(tx.payload.constituentAddress ?? tx.sourceAddress), true);
    } else if (tx.eventType === 'ConstituentRemoved') {
      state.set(String(tx.payload.constituentAddress ?? tx.sourceAddress), false);
    }
  }
  return Array.from(state.entries())
    .filter(([, included]) => included)
    .map(([address]) => address);
}

/** All TXs emitted BY an address, oldest → newest (v11-5-1). */
export function findTxsForSource(sourceAddress: string, txs = getWalletTierTxs()): WalletTierTx[] {
  return txs.filter((t) => t.sourceAddress === sourceAddress);
}
