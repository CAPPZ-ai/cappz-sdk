/**
 * COPE node crystallized.
 * Node ID: v12-08-prime-operational-wallet
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Prime Operational Wallet (POW) — the wallet the UI binds to.
 *
 * The POW holds a **by-ref copy** of its Prime Template Wallet: reference
 * edges to the template's content nodes, private keys absent, canon zone
 * read-only. Content is never duplicated, so an admin `ContentAmended` at
 * the PTW is visible through the POW immediately with no migration.
 *
 * The POW's own writable zone holds the shared agent binding and the
 * Public Session. The PTW never receives interaction TXs.
 */

import { operationalRoot } from './paths';
import {
  appendWalletTierTxs,
  createWalletTierTx,
  getWalletTierTxs,
  refreshWalletTierTxs,
  resolveConstituents,
  resolveLatestTx,
  type WalletTierTx,
} from './walletTierEvents';
import { sha256Hex } from '../governance/PrinciplesChainlet';
import { typeWallet } from './walletTierTyping';

export interface PrimeOperationalWallet {
  slug: string;
  /** POW root — the wallet the UI binds to. */
  root: string;
  /** The Prime Template Wallet this POW copies by reference. */
  templateRoot: string;
  /** Shared, pooled agent conversation. */
  publicSessionAddress: string;
  /** Read-only content zone — reference edges only, never content bytes. */
  contentAddress: string;
  /** Address the shared agent is bound to. */
  agentAddress: string;
}

export function describePrimeOperationalWallet(
  slug: string,
  templateRoot: string,
): PrimeOperationalWallet {
  const root = operationalRoot(slug);
  return {
    slug,
    root,
    templateRoot,
    publicSessionAddress: `${root}/context/public`,
    contentAddress: `${root}/content/${slug}`,
    agentAddress: `${root}/agent`,
  };
}

/** Deterministic TX id so re-running origination is idempotent. */
async function originationTxId(kind: string, root: string, subject: string): Promise<string> {
  const hash = await sha256Hex(`${kind}|${root}|${subject}`);
  return `${kind}-${hash.slice(0, 24)}`;
}

/**
 * Originate the POW for a template. Content-hash keyed and idempotent:
 * re-running resolves the existing wallet instead of forking a second one.
 *
 * @param constituentAddresses Content node addresses in the PTW that the POW
 *   references. These are **references**, not copies.
 */
export async function originatePrimeOperationalWallet(params: {
  slug: string;
  templateRoot: string;
  constituentAddresses: string[];
  /** Multi-POW: label for this replica (default 'primary'). */
  replicaLabel?: string;
  /** Coarse region this replica serves. */
  region?: string;
  /** Regulatory jurisdiction the replica satisfies (e.g. 'EU/GDPR'). */
  jurisdiction?: string;
  /** Why the replica exists. */
  purpose?: 'redundancy' | 'scale-out' | 'residency';
}): Promise<PrimeOperationalWallet> {
  const pow = describePrimeOperationalWallet(params.slug, params.templateRoot);

  await refreshWalletTierTxs();
  const existing = resolveLatestTx(pow.root, 'WalletCopied');
  const alreadyReferenced = new Set(resolveConstituents(pow.contentAddress));

  const txs: WalletTierTx[] = [];

  if (!existing) {
    txs.push(
      await createWalletTierTx({
        txId: await originationTxId('WalletCopied', pow.root, params.templateRoot),
        eventType: 'WalletCopied',
        sourceAddress: params.templateRoot,
        targetAddress: pow.root,
        payload: {
          slug: params.slug,
          tier: 'prime-operational',
          // A copy carries no keys — it can only resolve, never rewrite, the template.
          keyMaterial: 'absent',
          contentZone: pow.contentAddress,
          contentZoneAccess: 'read-only',
          publicSession: pow.publicSessionAddress,
          agent: pow.agentAddress,
        },
      }),
    );
  }

  for (const address of params.constituentAddresses) {
    if (alreadyReferenced.has(address)) continue;
    const constituentId = address.split('/').pop() ?? address;
    const targetAddr = `${pow.contentAddress}/${constituentId}`;
    txs.push(
      await createWalletTierTx({
        txId: await originationTxId('ConstituentIncluded', targetAddr, address),
        eventType: 'ConstituentIncluded',
        sourceAddress: address,
        targetAddress: targetAddr,
        payload: {
          constituentAddress: address,
          linkage: 'by-ref',
          resolvesAgainst: params.templateRoot,
        },
      }),
    );
  }

  if (txs.length > 0) await appendWalletTierTxs(txs);

  // v11-5-1: declare the tier as MDM refdata. Idempotent; multi-POW safe —
  // each replica types itself independently against cappz:/WalletTier/POW.
  await typeWallet({
    walletRoot: pow.root,
    tier: 'POW',
    attribution: {
      slug: params.slug,
      contentRoot: pow.contentAddress,
      replicaLabel: params.replicaLabel ?? 'primary',
      region: params.region,
      jurisdiction: params.jurisdiction,
      purpose: params.purpose ?? 'redundancy',
    },
  });

  return pow;
}

/** Whether the POW has been originated (no boolean stored — replayed). */
export function resolvePrimeOperationalWalletOrigin(slug: string): WalletTierTx | null {
  return resolveLatestTx(operationalRoot(slug), 'WalletCopied', getWalletTierTxs());
}

/**
 * Broadcast a template content amendment. Copies track the template head, so
 * this TX exists to invalidate graph caches rather than to move any content.
 */
export async function broadcastDomainModelAmended(params: {
  templateRoot: string;
  contentAddress: string;
  contentHash: string;
}): Promise<void> {
  await appendWalletTierTxs([
    await createWalletTierTx({
      txId: `DomainModelAmended-${params.contentHash.slice(0, 24)}`,
      eventType: 'DomainModelAmended',
      sourceAddress: params.templateRoot,
      targetAddress: params.contentAddress,
      payload: {
        contentHash: params.contentHash,
        routing: 'broadcast',
        applyMode: 'autoApply',
      },
    }),
  ]);
}
