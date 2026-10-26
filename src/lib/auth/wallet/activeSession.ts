/**
 * COPE node crystallized.
 * Node ID: v12-23-01-active-wallet-session
 * Provenance: m/44'/144'/100'/principles/cope/v1
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * In-memory holder for the active wallet key pair. Set at wallet sign-in
 * (phrase unlock), cleared on lock/sign-out. Never persisted — the phrase
 * or the encrypted key vault is the only way back in (zero-storage secrets).
 * Block writers (outbox flush, escrow service) sign through here so every
 * block carries a verifiable wallet signature.
 */

import type { WalletKeyPair } from './session';

let active: WalletKeyPair | null = null;

export function setActiveWalletKey(key: WalletKeyPair | null): void {
  active = key;
}

export function getActiveWalletKey(): WalletKeyPair | null {
  return active;
}

export function hasActiveWalletKey(): boolean {
  return active !== null;
}
