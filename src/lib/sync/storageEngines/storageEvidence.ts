/** Wallet-scoped device evidence. Signed only while the owner is unlocked. */
import { userInstanceRoot, CAPPZ_USER_SLUG } from '../../wallets/paths';
import { getActiveWalletKey } from '../../auth/wallet/activeSession';
import { signMessage, verifySignature } from '../../auth/wallet/session';
import { sha256Hex } from '../a2aSecureChannel';
import type { CappzNetwork } from '../../network/networkTypes';
import type { StorageEngineEvent } from './engineSelection';

const COPE = "m/44'/144'/100'/principles/cope/v1";
const PREFIX = 'cappz:storage-evidence/';

/** vNext-01 — the validated ledger receipt once the batch root is on XRPL. */
export interface EvidenceAnchor {
  batchId: string;
  txHash: string;
  ledgerIndex: number;
  anchorAccount: string;
  root: string;
  network: CappzNetwork;
  anchoredAt: string;
}

export interface StorageEvidence {
  address: string;
  owner: string;
  event: StorageEngineEvent;
  contentHash: string;
  predecessor: string | null;
  signature: string;
  governingPrinciple: string;
  // The signature covers only the fields above — status and the anchor
  // receipt are downstream lifecycle, so marking a record anchored never
  // invalidates its signature.
  status: 'local-pending' | 'anchored';
  anchor?: EvidenceAnchor;
}

// Imports of the storage stack are deferred until after module initialization:
// storage selection is itself imported by cappz-middleware.
export async function readStorageEvidence(owner: string): Promise<StorageEvidence[]> {
  const { chainletStorage } = await import('../chainletStorage');
  return (await chainletStorage.getItem<StorageEvidence[]>(`${PREFIX}${owner}`)) ?? [];
}

export async function signStorageEvidence(event: StorageEngineEvent): Promise<StorageEvidence | null> {
  const key = getActiveWalletKey();
  if (!key) return null;
  const list = await readStorageEvidence(key.address);
  const predecessor = list.at(-1)?.contentHash ?? null;
  const address = `${userInstanceRoot(key.address, CAPPZ_USER_SLUG)}/storage/events`;
  const contentHash = await sha256Hex(JSON.stringify({ address, owner: key.address, predecessor, event, governingPrinciple: COPE }));
  const signature = await signMessage(key.privateKey, contentHash);
  const record: StorageEvidence = { address, owner: key.address, event, contentHash, predecessor, signature, governingPrinciple: COPE, status: 'local-pending' };
  const { chainletStorage } = await import('../chainletStorage');
  await chainletStorage.setItem(`${PREFIX}${key.address}`, [...list, record]);
  const { flushActiveKvEngine } = await import('./engineSelection');
  await flushActiveKvEngine();
  // Announce new evidence so open panels refresh their proof status.
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('cappz:storage-evidence-updated'));
  return record;
}

export async function verifyStorageEvidence(record: StorageEvidence): Promise<boolean> {
  if (record.governingPrinciple !== COPE || record.address !== `${userInstanceRoot(record.owner, CAPPZ_USER_SLUG)}/storage/events`) return false;
  const expected = await sha256Hex(JSON.stringify({ address: record.address, owner: record.owner, predecessor: record.predecessor, event: record.event, governingPrinciple: COPE }));
  return expected === record.contentHash && verifySignature(expected, record.signature, record.owner);
}
