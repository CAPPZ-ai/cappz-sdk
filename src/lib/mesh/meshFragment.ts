/**
 * COPE node crystallized.
 * Node ID: v15-13-00-mesh-fragment
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * CPZ1 frames across links that carry only small packets: a BLE GATT
 * characteristic (≈180–512 bytes after MTU negotiation), a LoRa packet
 * (≤ 222 bytes at common data rates), a QR code sequence. A frame is split
 * into numbered fragments and reassembled before it reaches the node; the
 * frame's own checksum then covers the whole. Fragments of an unfinished
 * frame are dropped after a timeout, and a receiver holds a bounded number
 * of partial frames, so a peer cannot pin its memory.
 *
 *   [0]     0xC7
 *   [1..4]  frame id, uint32 BE
 *   [5..6]  fragment index, uint16 BE
 *   [7..8]  fragment count, uint16 BE
 *   [9..]   fragment bytes
 */

import type { MeshLink } from './meshNode.ts';

const MAGIC = 0xc7;
export const FRAGMENT_HEADER_BYTES = 9;

export function fragmentFrame(frameId: number, frame: Uint8Array, mtu: number): Uint8Array[] {
  const room = mtu - FRAGMENT_HEADER_BYTES;
  if (room < 16) throw new Error('mtu too small');
  const count = Math.max(1, Math.ceil(frame.byteLength / room));
  if (count > 0xffff) throw new Error('frame too large for this mtu');
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const part = frame.subarray(i * room, (i + 1) * room);
    const f = new Uint8Array(FRAGMENT_HEADER_BYTES + part.byteLength);
    const v = new DataView(f.buffer);
    f[0] = MAGIC; v.setUint32(1, frameId >>> 0); v.setUint16(5, i); v.setUint16(7, count);
    f.set(part, FRAGMENT_HEADER_BYTES);
    out.push(f);
  }
  return out;
}

export class Reassembler {
  private readonly partial = new Map<number, { parts: (Uint8Array | undefined)[]; got: number; started: number }>();
  dropped = 0;

  constructor(private readonly opts: { maxPartial?: number; timeoutMs?: number; now?: () => number } = {}) {}

  /** One fragment in; a whole frame out when it completes, else null. Malformed fragments are dropped. */
  push(fragment: Uint8Array): Uint8Array | null {
    if (fragment.byteLength < FRAGMENT_HEADER_BYTES || fragment[0] !== MAGIC) { this.dropped++; return null; }
    const v = new DataView(fragment.buffer, fragment.byteOffset, fragment.byteLength);
    const id = v.getUint32(1); const i = v.getUint16(5); const count = v.getUint16(7);
    if (count === 0 || i >= count) { this.dropped++; return null; }
    const now = (this.opts.now ?? Date.now)();
    this.expire(now);
    let p = this.partial.get(id);
    if (!p || p.parts.length !== count) {
      if (this.partial.size >= (this.opts.maxPartial ?? 64)) { this.partial.delete(this.partial.keys().next().value!); this.dropped++; }
      p = { parts: new Array(count), got: 0, started: now };
      this.partial.set(id, p);
    }
    if (!p.parts[i]) { p.parts[i] = fragment.slice(FRAGMENT_HEADER_BYTES); p.got++; }
    if (p.got < count) return null;
    this.partial.delete(id);
    const total = p.parts.reduce((n, x) => n + x!.byteLength, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const x of p.parts) { out.set(x!, o); o += x!.byteLength; }
    return out;
  }

  private expire(now: number): void {
    const t = this.opts.timeoutMs ?? 120_000;
    for (const [id, p] of this.partial) if (now - p.started > t) { this.partial.delete(id); this.dropped++; }
  }
}

/**
 * Wrap a small-packet radio as a MeshLink. `sendPacket` puts one packet on the air;
 * feed every received packet to `onPacket`, which returns a whole frame for node.receive.
 */
export function fragmentingLink(radio: { id: string; carrier: string; mtu: number; sendPacket(p: Uint8Array): void | Promise<void>; close(): void }): { link: MeshLink; onPacket(p: Uint8Array): Uint8Array | null; reassembler: Reassembler } {
  let next = (Math.random() * 0xffffffff) >>> 0;
  const reassembler = new Reassembler();
  return {
    reassembler,
    link: {
      id: radio.id,
      carrier: radio.carrier,
      async send(frame: Uint8Array) {
        for (const p of fragmentFrame(next++ >>> 0, frame, radio.mtu)) await radio.sendPacket(p);
      },
      close: () => radio.close(),
    },
    onPacket: (p) => reassembler.push(p),
  };
}
