/**
 * COPE node crystallized.
 * Node ID: v15-13-00-mesh-webrtc
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Two browsers on the same local network (a hotspot, a Wi-Fi Direct group, a
 * travel router) link directly with a WebRTC data channel, signalled with no
 * server: one phone makes an offer code, the other answers with a code, and
 * the codes travel by AirDrop, Nearby Share, a QR code or reading them out.
 * No STUN or TURN — only local (host) candidates, which is all a network with
 * no internet has. Gathering completes before a code is made, so one code
 * each way is enough.
 *
 * The codes carry no secret and need no integrity: the link authenticates
 * with the signed mesh hello, like every carrier. Transport type
 * `webrtc-datachannel`.
 *
 * Status: browser-only. Codes are unit-tested; the full pairing ran between
 * two Chrome pages against a live node. Not yet run on iOS Safari or across
 * two physical phones (see docs/MESH_RESILIENCE.md, "What is verified").
 */

import { deflateSync, inflateSync } from 'fflate';
import { toBase64Url, fromBase64Url, utf8 } from '../identity/canonical.ts';
import type { MeshLink } from './meshNode.ts';

const PREFIX = 'CPZM1';
const GATHER_TIMEOUT_MS = 4000;

export function encodeSignal(desc: { type: string; sdp?: string }): string {
  // Only what a host-candidate session needs; fewer bytes make a smaller QR code.
  const sdp = (desc.sdp ?? '').split('\r\n').filter((l) => !/^a=(extmap|rtcp-fb|ssrc|msid)/.test(l)).join('\r\n');
  return `${PREFIX}${desc.type === 'offer' ? 'O' : 'A'}${toBase64Url(deflateSync(utf8(sdp), { level: 9 }))}`;
}

export function decodeSignal(code: string): { type: 'offer' | 'answer'; sdp: string } {
  const c = code.trim().replace(/\s+/g, '');
  if (!c.startsWith(PREFIX)) throw new Error('not a mesh pairing code');
  const type = c[PREFIX.length] === 'O' ? 'offer' : c[PREFIX.length] === 'A' ? 'answer' : null;
  if (!type) throw new Error('not a mesh pairing code');
  return { type, sdp: new TextDecoder().decode(inflateSync(fromBase64Url(c.slice(PREFIX.length + 1)))) };
}

async function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, GATHER_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); } });
  });
}

export interface PendingPair {
  /** The code to hand to the other phone. */
  code: string;
  /** Resolves with the link once the data channel opens. */
  link: Promise<MeshLink>;
  /** Offerer only: apply the other phone's answer code. */
  complete?(answerCode: string): Promise<void>;
  cancel(): void;
}

function linkFor(pc: RTCPeerConnection, dc: RTCDataChannel, onBytes: (id: string, b: Uint8Array) => void, onDown: (id: string) => void): Promise<MeshLink> {
  const id = `webrtc:${Math.random().toString(36).slice(2, 10)}`;
  dc.binaryType = 'arraybuffer';
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('pairing timed out')), 120_000);
    dc.onopen = () => {
      clearTimeout(t);
      resolve({ id, carrier: 'webrtc-datachannel', send: (bytes) => { if (dc.readyState === 'open') dc.send(bytes.slice()); }, close: () => { dc.close(); pc.close(); } });
    };
    dc.onmessage = (e) => onBytes(id, new Uint8Array(e.data as ArrayBuffer));
    dc.onclose = () => onDown(id);
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') { clearTimeout(t); onDown(id); } };
  });
}

type Rtc = new (config: RTCConfiguration) => RTCPeerConnection;
const rtc = (): Rtc => (globalThis as unknown as { RTCPeerConnection?: Rtc }).RTCPeerConnection ?? (() => { throw new Error('this browser has no WebRTC'); })();

/** Phone A: make an offer code. */
export async function offerPairing(onBytes: (linkId: string, b: Uint8Array) => void, onDown: (linkId: string) => void, Peer: Rtc = rtc()): Promise<PendingPair> {
  const pc = new Peer({ iceServers: [] });
  const dc = pc.createDataChannel('cpz1', { ordered: true });
  const link = linkFor(pc, dc, onBytes, onDown);
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);
  return {
    code: encodeSignal(pc.localDescription!),
    link,
    async complete(answerCode: string) {
      const a = decodeSignal(answerCode);
      if (a.type !== 'answer') throw new Error('that is an offer code: the other phone must answer it');
      await pc.setRemoteDescription({ type: 'answer', sdp: a.sdp });
    },
    cancel: () => pc.close(),
  };
}

/** Phone B: answer an offer code. */
export async function answerPairing(offerCode: string, onBytes: (linkId: string, b: Uint8Array) => void, onDown: (linkId: string) => void, Peer: Rtc = rtc()): Promise<PendingPair> {
  const o = decodeSignal(offerCode);
  if (o.type !== 'offer') throw new Error('that is an answer code: give it to the phone that made the offer');
  const pc = new Peer({ iceServers: [] });
  const link = new Promise<MeshLink>((resolve, reject) => {
    pc.ondatachannel = (e) => linkFor(pc, e.channel, onBytes, onDown).then(resolve, reject);
  });
  await pc.setRemoteDescription({ type: 'offer', sdp: o.sdp });
  await pc.setLocalDescription(await pc.createAnswer());
  await gathered(pc);
  return { code: encodeSignal(pc.localDescription!), link, cancel: () => pc.close() };
}
