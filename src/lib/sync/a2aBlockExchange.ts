/**
 * A2A Block Exchange — v12-21-00: routed through the a2a-sync engine.
 *
 * Peers and sync state come from the A2A sync ledger (DataSyncRequested /
 * SyncSessionOpened …) and registered copies — no hosted-table reads.
 * Payloads move copy-to-copy over the encrypted channel (a2aSecureChannel);
 * the session wallet records hashes only. Governed by
 * src/bpmn/substrate/a2a-sync.bpmn.
 */

import { chainletStorage } from './chainletStorage';
import { middlewareNotify } from './cappz-middleware';
import type { SyncBlock } from './chainletSyncAdapter';
import { ChainletStoreParamType, getChainletParam } from './chainletStoreParams';
import { getA2ASyncEngine, getSyncCopy, listSyncCopies, registerSyncCopy } from './a2aSyncLedger';
import type { SyncCopy } from './a2aSyncEngine';

const DEVICE_ID_KEY = getChainletParam(ChainletStoreParamType.A2ADeviceIdKey);
const PEER_PREFIX = 'cappz:a2a/peers/';

export interface PeerInfo {
  deviceId: string;
  walletAddress?: string;
  lastSyncedHash: string;
  lastSyncedAt: number;
}

/** Register this device as a sync peer for a wallet (local peer record). */
export async function registerSyncPeer(walletAddress: string): Promise<void> {
  const deviceId = await chainletStorage.getItem<string>(DEVICE_ID_KEY);
  if (!deviceId) return;
  const key = `${PEER_PREFIX}${walletAddress}/${deviceId}`;
  await chainletStorage.setItem(key, { deviceId, walletAddress, registeredAt: new Date().toISOString() });
  middlewareNotify('kv', key, 'write', key);
}

/** Peers = registered copies of the same wallet, other than this device. */
export async function discoverPeers(walletAddress: string): Promise<PeerInfo[]> {
  const myDeviceId = await chainletStorage.getItem<string>(DEVICE_ID_KEY);
  return listSyncCopies(walletAddress)
    .filter((c) => c.copyId !== myDeviceId)
    .map((c) => ({ deviceId: c.copyId, walletAddress: c.walletAddress, lastSyncedHash: '0'.repeat(64), lastSyncedAt: 0 }));
}

function localCopyFor(walletAddress?: string, exclude?: string): SyncCopy | undefined {
  return listSyncCopies(walletAddress).find((c) => c.copyId !== exclude && c.role === 'edge')
    ?? listSyncCopies(walletAddress).find((c) => c.copyId !== exclude);
}

/** Pull what this copy lacks from a peer copy via an a2a-sync session. */
export async function syncFromPeer(peer: PeerInfo): Promise<number> {
  const source = getSyncCopy(peer.deviceId);
  const requester = localCopyFor(peer.walletAddress, peer.deviceId);
  if (!source || !requester) return 0;
  const r = await getA2ASyncEngine().runSyncSession(requester, source);
  peer.lastSyncedAt = Date.now();
  return r.delivered.length;
}

/** AX-78 — cache wallet copies sync through the same engine. */
export async function syncCacheWalletCopies(
  walletAddress: string,
  _cacheWalletHdRoot: string,
): Promise<{ peersFound: number; blocksApplied: number }> {
  return runSyncCycle(walletAddress);
}

export async function runSyncCycle(walletAddress: string): Promise<{ peersFound: number; blocksApplied: number }> {
  const peers = await discoverPeers(walletAddress);
  let total = 0;
  for (const peer of peers) {
    try { total += await syncFromPeer(peer); } catch (err) {
      console.warn(`[A2ASync] sync from ${peer.deviceId.slice(0, 12)} failed:`, err);
    }
  }
  return { peersFound: peers.length, blocksApplied: total };
}

/**
 * Subscribe to canonical state from the escrowed copy. When the escrow copy
 * is registered in this runtime, the edge pulls immediately; the returned
 * function unregisters.
 */
export function subscribeToEscrowedSource(
  escrowedWalletAddress: string,
  onBlocks?: (blocks: SyncBlock[]) => void,
  escrowCopy?: SyncCopy,
): () => void {
  if (!escrowedWalletAddress) return () => {};
  const off = escrowCopy ? registerSyncCopy(escrowCopy) : () => {};
  void runSyncCycle(escrowedWalletAddress).then(() => onBlocks?.([])).catch(() => undefined);
  return off;
}
