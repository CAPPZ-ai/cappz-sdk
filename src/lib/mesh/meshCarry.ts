/**
 * COPE node crystallized.
 * Node ID: v15-13-00-mesh-carry
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Bundles carried by hand: a file of CPZ1 frames (transport type `bundle`)
 * written to a USB stick or SD card, walked or driven to another site, and
 * imported there. The file is not trusted as a whole — each bundle carries
 * its own signature and credentials and passes the receiving node's gate, so
 * a stick found in the street is as safe to import as one from a courier.
 */

import { encodeJsonFrame, decodeJsonFrame, FrameDecoder } from '../sync/frameCodec.ts';
import type { MeshBundle } from './meshBundle.ts';

export interface CarryManifest { v: 1; kind: 'cpz-mesh-carry'; meshId: string; count: number; writtenAt: string }

export async function writeCarryFile(meshId: string, bundles: MeshBundle[], now = Date.now()): Promise<Uint8Array> {
  const parts: Uint8Array[] = [await encodeJsonFrame('manifest', { v: 1, kind: 'cpz-mesh-carry', meshId, count: bundles.length, writtenAt: new Date(now).toISOString() } satisfies CarryManifest)];
  for (const b of bundles) parts.push(await encodeJsonFrame('frame', b));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}

/** Throws on a corrupted file (bad magic or checksum); bundles are verified by the node that imports them. */
export async function readCarryFile(bytes: Uint8Array): Promise<{ manifest: CarryManifest; bundles: MeshBundle[] }> {
  const frames = await new FrameDecoder().feed(bytes);
  const [head, ...rest] = frames;
  if (!head || head.command !== 'manifest') throw new Error('not a mesh carry file');
  const manifest = decodeJsonFrame<CarryManifest>(head);
  if (manifest.kind !== 'cpz-mesh-carry') throw new Error('not a mesh carry file');
  return { manifest, bundles: rest.filter((f) => f.command === 'frame').map((f) => decodeJsonFrame<MeshBundle>(f)) };
}
