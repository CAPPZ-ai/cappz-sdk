/**
 * COPE node crystallized.
 * Node ID: v15-13-00-mesh-native
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * The bridge between the mesh web app and a native shell that owns the
 * radios a browser cannot reach: Apple MultipeerConnectivity on iPhone, iPad
 * and Mac (peer-to-peer Wi-Fi + Bluetooth, no access point), and Google
 * Nearby Connections on Android (Bluetooth, BLE, Wi-Fi Direct / Aware). The
 * shell (packages/cappz-mesh-native) hosts the same web app in a WebView and
 * only moves bytes; keys, verification and routing stay in the MeshNode, and
 * every native peer must still pass the signed hello.
 *
 *   native → web   { t: 'up', peer, carrier } · { t: 'data', peer, b64 } · { t: 'down', peer }
 *   web → native   { t: 'start', service } · { t: 'send', peer, b64 } · { t: 'close', peer }
 *
 * The web side splits outgoing bytes into chunks (Nearby BYTES payloads are
 * capped at 32 KiB); the node's frame decoder reassembles any chunking.
 */

import { toBase64Url, fromBase64Url } from '../identity/canonical.ts';
import type { MeshLink, MeshNode } from './meshNode.ts';

export type NativeIn = { t: 'up'; peer: string; carrier?: string } | { t: 'data'; peer: string; b64: string } | { t: 'down'; peer: string };
export type NativeOut = { t: 'start'; service: string } | { t: 'send'; peer: string; b64: string } | { t: 'close'; peer: string };

export interface NativeHost {
  post(m: NativeOut): void;
  /** Register the receiver for messages from the shell. */
  listen(cb: (m: NativeIn) => void): void;
}

export const NATIVE_CHUNK_BYTES = 16 * 1024;
export const NATIVE_SERVICE = 'cappz-mesh';

/** Connect a node to a native shell's peers. Returns a stop function. */
export function attachNativeBridge(node: MeshNode, host: NativeHost, o: { log?: (s: string) => void } = {}): () => void {
  const links = new Map<string, MeshLink>();
  const id = (peer: string) => `native:${peer}`;
  host.listen((m) => {
    if (!m || typeof m.peer !== 'string') return;
    if (m.t === 'up' && !links.has(m.peer)) {
      const peer = m.peer;
      const link: MeshLink = {
        id: id(peer),
        carrier: m.carrier ?? 'native',
        send: (bytes) => { for (let i = 0; i < bytes.byteLength; i += NATIVE_CHUNK_BYTES) host.post({ t: 'send', peer, b64: toBase64Url(bytes.subarray(i, i + NATIVE_CHUNK_BYTES)) }); },
        close: () => { links.delete(peer); host.post({ t: 'close', peer }); node.linkDown(id(peer)); },
      };
      links.set(peer, link);
      o.log?.(`native peer up ${peer} (${link.carrier})`);
      void node.linkUp(link);
    } else if (m.t === 'data' && links.has(m.peer) && typeof m.b64 === 'string') {
      void node.receive(id(m.peer), fromBase64Url(m.b64));
    } else if (m.t === 'down' && links.has(m.peer)) {
      links.delete(m.peer);
      node.linkDown(id(m.peer));
      o.log?.(`native peer down ${m.peer}`);
    }
  });
  host.post({ t: 'start', service: NATIVE_SERVICE });
  return () => { for (const p of [...links.keys()]) links.get(p)!.close(); };
}

interface NativeWindow {
  webkit?: { messageHandlers?: { cappzMesh?: { postMessage(m: unknown): void } } };
  CappzMeshAndroid?: { post(json: string): void };
  __cappzMeshNative?: (m: NativeIn | string) => void;
}

/** The shell this page runs in, if any: iOS/macOS WKWebView or Android WebView. Native code delivers messages by calling window.__cappzMeshNative(json). */
export function detectNativeHost(w: NativeWindow = globalThis as unknown as NativeWindow): NativeHost | null {
  const ios = w.webkit?.messageHandlers?.cappzMesh;
  const android = w.CappzMeshAndroid;
  if (!ios && !android) return null;
  return {
    post: (m) => (ios ? ios.postMessage(m) : android!.post(JSON.stringify(m))),
    listen: (cb) => { w.__cappzMeshNative = (m) => cb(typeof m === 'string' ? JSON.parse(m) as NativeIn : m); },
  };
}
