/**
 * COPE node crystallized.
 * Node ID: v12-23-04-edge-session
 * Provenance: m/44'/144'/100'/principles/cope/v1
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Transport-neutral peer session over the shared CPZ1 frame codec. TCP and
 * QUIC (and in-memory pipes in tests) hand this a byte duplex; the hello /
 * hello-ack handshake and frame loop are identical on every path.
 *
 * v15-03-00: the peer's hello is Ed25519-verified (helloSignature.ts), not
 * only checked for presence. A session records the check it passed.
 */

import { FrameDecoder, encodeJsonFrame, decodeJsonFrame, type WireFrame, type FrameCommand } from './frameCodec';
import type { TransportHello } from './transportContract';
import { acceptsSignature, verifyHello, type SignatureCheck, type VerifyOptions } from './helloSignature';
import { verifyHelloKeyDeclaration } from './helloKeyDeclaration';

/** Minimal byte duplex every socket kind can satisfy. */
export interface ByteDuplex {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): void;
}

export interface EdgePeerSession {
  remoteHello: TransportHello;
  /** Signature check the peer's hello passed ('verified-bound' or 'verified-unbound'). */
  helloCheck: SignatureCheck;
  send(command: FrameCommand, value: unknown): Promise<void>;
  frames(): AsyncIterable<WireFrame>;
  close(): void;
}

async function* readFrames(readable: ReadableStream<Uint8Array>): AsyncGenerator<WireFrame> {
  const decoder = new FrameDecoder();
  const reader = readable.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      for (const frame of await decoder.feed(value)) yield frame;
    }
  } finally {
    reader.releaseLock();
  }
}

export interface EdgeSessionOptions extends VerifyOptions {
  /** Carry only keys the peer's wallet declared (declaredKeys must return a list). */
  requireBoundKey?: boolean;
  /** Resolve declared keys once the peer's wallet is known (inbound sessions). */
  declaredKeysFor?: (walletAddress: string) => Promise<readonly string[] | null> | readonly string[] | null;
}

/** Verify a peer hello; throws with the reason when it must be dropped. */
export async function assertSignedHello(hello: TransportHello, opts: EdgeSessionOptions = {}): Promise<SignatureCheck> {
  const check = await verifyHello(hello, opts);
  if (check === 'unsigned') throw new Error('unsigned hello dropped');
  if (!acceptsSignature(check, Boolean(opts.requireBoundKey))) throw new Error(`hello dropped: ${check}`);
  return check;
}

/**
 * Open a session: send our hello, wait for the peer's hello (or hello-ack),
 * reply with hello-ack if we received a hello. First non-hello frame = drop.
 */
export async function openEdgeSession(duplex: ByteDuplex, hello: TransportHello, opts: EdgeSessionOptions = {}): Promise<EdgePeerSession> {
  const writer = duplex.writable.getWriter();
  const send = async (command: FrameCommand, value: unknown) => {
    await writer.write(await encodeJsonFrame(command, value));
  };
  // don't block on our hello write before reading — both peers send first
  const helloSent = send('hello', hello);
  const iterator = readFrames(duplex.readable);
  const first = await iterator.next();
  if (first.done) throw new Error('connection closed before hello');
  const frame = first.value;
  if (frame.command !== 'hello' && frame.command !== 'hello-ack') {
    duplex.close();
    throw new Error('expected hello as first frame');
  }
  const remoteHello = decodeJsonFrame<TransportHello>(frame);
  let helloCheck: SignatureCheck;
  try {
    let declaredKeys = opts.declaredKeysFor ? await opts.declaredKeysFor(remoteHello?.walletAddress ?? '') : opts.declaredKeys;
    // v15-04-00: the peer's wallet-signed key declaration binds its device key.
    const decl = remoteHello?.keyDeclaration;
    if (decl && decl.walletAddress === remoteHello.walletAddress && (await verifyHelloKeyDeclaration(decl, opts.now)) === 'valid') {
      declaredKeys = [...(declaredKeys ?? []), decl.devicePublicKey];
    }
    helloCheck = await assertSignedHello(remoteHello, { ...opts, declaredKeys });
  } catch (e) { duplex.close(); throw e; }
  await helloSent;
  if (frame.command === 'hello') await send('hello-ack', hello);
  return {
    remoteHello,
    helloCheck,
    send,
    frames: () => ({ [Symbol.asyncIterator]: () => iterator }),
    close: () => { try { writer.releaseLock(); duplex.close(); } catch { /* already closed */ } },
  };
}

/** In-memory duplex pair — tests and same-process demos. */
export function memoryDuplexPair(): [ByteDuplex, ByteDuplex] {
  const q = { highWaterMark: 64 };
  const ab = new TransformStream<Uint8Array, Uint8Array>(undefined, q, q);
  const ba = new TransformStream<Uint8Array, Uint8Array>(undefined, q, q);
  const closer = (w: WritableStream<Uint8Array>) => () => { void w.close().catch(() => {}); };
  return [
    { readable: ba.readable, writable: ab.writable, close: closer(ab.writable) },
    { readable: ab.readable, writable: ba.writable, close: closer(ba.writable) },
  ];
}
