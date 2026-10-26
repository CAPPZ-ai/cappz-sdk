/**
 * COPE node crystallized.
 * Node ID: v15-12-02-sync-transport-types
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * The v1 transport shape, on its own so code that only carries frames
 * (transportContract.ts, the public SDK) does not depend on the sync engine.
 * a2aSyncEngine.ts re-exports both types.
 */
import type { SealedFrame } from './a2aSecureChannel';

export type TransportKind = 'direct' | 'relay' | 'store-forward';

export interface SyncTransport {
  kind: TransportKind;
  available(): boolean;
  /** Move one sealed frame to the other side. Returns what arrived. */
  carry(frame: SealedFrame): Promise<{ frame: SealedFrame; blobKey?: string }>;
  release?(blobKey: string): Promise<void>;
}
