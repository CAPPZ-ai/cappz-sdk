/**
 * COPE node crystallized.
 * Node ID: v12-23-03-frame-codec
 * Provenance: m/44'/144'/100'/principles/cope/v1
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * One length-prefixed binary framing shared by every edge transport
 * (tcp, quic, bundle, relay ladder). Bitcoin-inspired wire shape —
 * magic, command, length, checksum — without Bitcoin's block-specific
 * messages. Pure codec: no sockets here, so it runs in the browser,
 * Deno, and tests over in-memory pipes.
 *
 *   [0..3]  magic  'CPZ1'
 *   [4]     command (FrameCommand)
 *   [5..8]  payload length, uint32 big-endian
 *   [9..12] first 4 bytes of sha256(payload)
 *   [13..]  payload (JSON-encoded by callers)
 */

const MAGIC = new Uint8Array([0x43, 0x50, 0x5a, 0x31]); // 'CPZ1'
const HEADER_BYTES = 13;
export const MAX_FRAME_PAYLOAD = 8 * 1024 * 1024;

export const FRAME_COMMANDS = [
  'hello', // signed capability hello on connect
  'hello-ack',
  'manifest', // headers-first manifest offer
  'inv', // inventory gossip (head announcements)
  'getdata', // pull request for bodies
  'frame', // one sealed SealedFrame payload
  'ack', // delivery confirmation
  'log', // human-readable activity note (demo comms stream)
  'ping',
  'pong',
  'bye',
  'auth', // v15-04-00 — first frame on a socket carrier: {ticket, cursor} (never in a URL)
] as const;
export type FrameCommand = (typeof FRAME_COMMANDS)[number];

export interface WireFrame {
  command: FrameCommand;
  payload: Uint8Array;
}

async function checksum4(payload: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', payload.slice().buffer as ArrayBuffer);
  return new Uint8Array(digest).slice(0, 4);
}

/** Encode one frame. Async because the checksum is sha256. */
export async function encodeFrame(command: FrameCommand, payload: Uint8Array): Promise<Uint8Array> {
  if (payload.length > MAX_FRAME_PAYLOAD) throw new Error('frame payload too large');
  const sum = await checksum4(payload);
  const out = new Uint8Array(HEADER_BYTES + payload.length);
  out.set(MAGIC, 0);
  out[4] = FRAME_COMMANDS.indexOf(command);
  new DataView(out.buffer).setUint32(5, payload.length, false);
  out.set(sum, 9);
  out.set(payload, HEADER_BYTES);
  return out;
}

/**
 * Incremental decoder. Feed bytes as they arrive (any chunking); complete
 * frames come back. Throws on bad magic, bad checksum, or unknown command —
 * callers drop the connection on throw.
 */
export class FrameDecoder {
  private buf = new Uint8Array(0);

  async feed(bytes: Uint8Array): Promise<WireFrame[]> {
    const merged = new Uint8Array(this.buf.length + bytes.length);
    merged.set(this.buf, 0);
    merged.set(bytes, this.buf.length);
    this.buf = merged;
    const frames: WireFrame[] = [];
    for (;;) {
      if (this.buf.length < HEADER_BYTES) break;
      const view = new DataView(this.buf.buffer, this.buf.byteOffset);
      if (
        this.buf[0] !== MAGIC[0] || this.buf[1] !== MAGIC[1] ||
        this.buf[2] !== MAGIC[2] || this.buf[3] !== MAGIC[3]
      ) throw new Error('bad frame magic');
      const cmdIdx = this.buf[4];
      if (cmdIdx >= FRAME_COMMANDS.length) throw new Error('unknown frame command');
      const length = view.getUint32(5, false);
      if (length > MAX_FRAME_PAYLOAD) throw new Error('frame payload too large');
      if (this.buf.length < HEADER_BYTES + length) break;
      const payload = this.buf.slice(HEADER_BYTES, HEADER_BYTES + length);
      const sum = await checksum4(payload);
      if (sum[0] !== this.buf[9] || sum[1] !== this.buf[10] || sum[2] !== this.buf[11] || sum[3] !== this.buf[12]) {
        throw new Error('frame checksum mismatch');
      }
      frames.push({ command: FRAME_COMMANDS[cmdIdx], payload });
      this.buf = this.buf.slice(HEADER_BYTES + length);
    }
    return frames;
  }

  get pendingBytes(): number {
    return this.buf.length;
  }
}

/** JSON convenience pair used by the sync engine over any transport. */
export async function encodeJsonFrame(command: FrameCommand, value: unknown): Promise<Uint8Array> {
  return encodeFrame(command, new TextEncoder().encode(JSON.stringify(value)));
}

export function decodeJsonFrame<T>(frame: WireFrame): T {
  return JSON.parse(new TextDecoder().decode(frame.payload)) as T;
}
