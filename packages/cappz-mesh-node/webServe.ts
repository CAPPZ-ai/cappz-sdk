/**
 * COPE node crystallized.
 * Node ID: v15-13-00-mesh-web-serve
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Phones that cannot run this program (iPhone, iPad, any locked-down phone)
 * join through their browser. A running node serves the mesh web app over
 * HTTPS on the local network — no internet involved — and accepts the app's
 * WebSocket on /mesh as one more MeshLink. The app is a full mesh node in the
 * browser with its own wallet and keys: this node only relays for it and
 * verifies it like any peer; it cannot read its direct messages.
 *
 * HTTPS because browsers expose WebCrypto only in a secure context. The
 * certificate is self-signed (the KeyZ X.509 projection, identity/x509.ts):
 * a phone accepts it once per node ("visit this website"). Its SHA-256 is
 * printed so a careful user can compare it on the warning page.
 *
 * The WebSocket server is the minimal RFC 6455 subset browsers use (binary
 * frames, ping, close), so the node needs no extra dependency.
 */

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { Duplex } from 'node:stream';
import { issueSelfSignedCertificate } from '../../src/lib/identity/x509.ts';
import type { MeshNode, MeshLink } from '../../src/lib/mesh/meshNode.ts';
import { readKitManifest, zipKitDir, kitFingerprint } from './kit.ts';

export const MESH_WEB_PORT = 41480;
const MAX_WS_MESSAGE = 16 * 1024 * 1024;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'; // RFC 6455 §1.3

function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces()).flatMap((l) => (l ?? []).filter((i) => i.family === 'IPv4' && !i.internal).map((i) => i.address));
}

/** A certificate for this node's LAN addresses, kept in home/tls.json and renewed when the addresses change. */
async function tlsFor(home: string): Promise<{ key: string; cert: string; sha256: string }> {
  const p = path.join(home, 'tls.json');
  const ips = lanAddresses().sort();
  if (fs.existsSync(p)) {
    const t = JSON.parse(fs.readFileSync(p, 'utf8')) as { key: string; cert: string; sha256: string; ips: string[]; notAfter: number };
    if (t.notAfter > Date.now() + 86400_000 && ips.every((ip) => t.ips.includes(ip))) return t;
  }
  const keyPair = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const notAfter = new Date(Date.now() + 365 * 86400_000);
  const issued = await issueSelfSignedCertificate({ keyPair, algorithm: 'p256', commonName: `cappz-mesh ${os.hostname()}`, organization: 'CAPPZ mesh', dnsNames: ['localhost', `${os.hostname()}.local`], ipAddresses: ['127.0.0.1', ...ips], notAfter });
  const t = { key: issued.keyPem!, cert: issued.pem, sha256: issued.sha256, ips: ['127.0.0.1', ...ips], notAfter: notAfter.getTime() };
  fs.writeFileSync(p, JSON.stringify(t), { mode: 0o600 });
  return t;
}

/** One WebSocket connection as a MeshLink. */
function wsLink(sock: Duplex, id: string, onMessage: (b: Uint8Array) => void, onClose: () => void): MeshLink {
  let buf = Buffer.alloc(0);
  let parts: Buffer[] = [];
  let closed = false;
  const frame = (opcode: number, payload: Buffer) => {
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
    if (!sock.destroyed) sock.write(Buffer.concat([head, payload]));
  };
  const close = () => { if (closed) return; closed = true; try { frame(8, Buffer.alloc(0)); } catch { /* gone */ } sock.destroy(); onClose(); };
  sock.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0, opcode = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, at = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; }
      else if (len === 127) { if (buf.length < 10) return; const big = buf.readBigUInt64BE(2); if (big > BigInt(MAX_WS_MESSAGE)) return close(); len = Number(big); at = 10; }
      if (!masked || len > MAX_WS_MESSAGE) return close(); // browsers always mask
      if (buf.length < at + 4 + len) return;
      const mask = buf.subarray(at, at + 4);
      const payload = Buffer.from(buf.subarray(at + 4, at + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(at + 4 + len);
      if (opcode === 8) return close();
      if (opcode === 9) { frame(10, payload); continue; }
      if (opcode === 10) continue;
      if (opcode === 1 || opcode === 2 || opcode === 0) {
        parts.push(payload);
        if (parts.reduce((n, p) => n + p.length, 0) > MAX_WS_MESSAGE) return close();
        if (fin) { const m = Buffer.concat(parts); parts = []; onMessage(new Uint8Array(m.buffer, m.byteOffset, m.byteLength)); }
      }
    }
  });
  sock.on('close', () => { if (!closed) { closed = true; onClose(); } });
  sock.on('error', () => { if (!closed) { closed = true; onClose(); } });
  return { id, carrier: 'wss', send: (bytes) => frame(2, Buffer.from(bytes)), close };
}

export interface MeshWeb { url: string[]; sha256: string; close(): void }

export async function serveMeshWeb(node: MeshNode, o: { home: string; webDir: string; kitDir?: string; port?: number; log?: (l: string) => void }): Promise<MeshWeb> {
  const log = o.log ?? (() => {});
  const port = o.port ?? MESH_WEB_PORT;
  const tls = await tlsFor(o.home);
  const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
  const server = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    const url = new URL(req.url ?? '/', 'https://x');
    if (o.kitDir && (url.pathname === '/kit' || url.pathname.startsWith('/kit/'))) return serveKit(url.pathname.slice(5), res);
    if (url.pathname === '/charter.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(fs.readFileSync(path.join(o.home, 'charter.json'))); return; }
    const name = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
    const f = path.join(o.webDir, name);
    if (!fs.existsSync(f)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream', 'cache-control': 'no-cache', 'content-security-policy': "default-src 'self'; connect-src 'self' wss:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'" });
    fs.createReadStream(f).pipe(res);
  });
  // The go-kit, for computers that do not have it yet: only files the signed manifest names (no path traversal).
  let kitZip: Uint8Array | null = null;
  const serveKit = (rel: string, res: import('node:http').ServerResponse) => {
    const m = readKitManifest(o.kitDir!);
    if (!m) { res.writeHead(404); res.end('no kit'); return; }
    if (rel === '' || rel === '/') {
      const sizeMb = (f: string) => (fs.statSync(path.join(o.kitDir!, f)).size / 1048576).toFixed(1);
      const rows = Object.keys(m.files).filter((f) => !f.startsWith('node/') && !f.startsWith('web/')).map((f) => `<li><a href="/kit/${encodeURI(f)}" download>${f}</a> <small>${m.files[f].slice(0, 12)}</small></li>`).join('');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>CAPPZ Mesh go-kit</title><body style="font:16px system-ui;max-width:640px;margin:24px auto;padding:0 16px">
<h1>CAPPZ Mesh go-kit</h1><p>Kit fingerprint <b>${kitFingerprint(m)}</b> — compare it with a coordinator's before running. ${m.signer ? `Signed by ${m.signer.slice(0, 16)}…` : '<b>Unsigned kit.</b>'}</p>
<p><a href="/kit/cappz-mesh-kit.zip" download><b>Download everything (cappz-mesh-kit.zip)</b></a>${m.nodeVersion ? ` — includes Node.js ${m.nodeVersion} for ${[...new Set(Object.keys(m.files).filter((f) => f.startsWith('node/')).map((f) => f.split('/')[1]))].join(', ')}` : ' — needs Node.js 20+ on the computer'}</p>
<p>Unzip, then: Linux <code>sh start.sh</code> · Mac double-click <code>start.command</code> · Windows double-click <code>start.bat</code>. iPhone and iPad: no download needed, <a href="/">open the phone app</a>.</p><ul>${rows}</ul>`);
      return;
    }
    if (rel === 'cappz-mesh-kit.zip') {
      kitZip ??= zipKitDir(o.kitDir!);
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': kitZip.byteLength, 'content-disposition': 'attachment; filename="cappz-mesh-kit.zip"' });
      res.end(kitZip);
      log('go-kit downloaded');
      return;
    }
    const f = decodeURIComponent(rel);
    if (!(f in m.files) && f !== 'KIT-MANIFEST.json') { res.writeHead(404); res.end('not in the kit'); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${path.basename(f)}"` });
    fs.createReadStream(path.join(o.kitDir!, f)).pipe(res);
  };

  let n = 0;
  server.on('upgrade', (req, sock: Duplex) => {
    const key = req.headers['sec-websocket-key'];
    if (req.url !== '/mesh' || typeof key !== 'string') { sock.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const id = `wss:${req.socket.remoteAddress}#${++n}`;
    const link = wsLink(sock, id, (b) => void node.receive(id, b), () => { node.linkDown(id); log(`browser left ${req.socket.remoteAddress}`); });
    log(`browser joined ${req.socket.remoteAddress}`);
    void node.linkUp(link);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '0.0.0.0', () => resolve()); });
  const url = lanAddresses().map((ip) => `https://${ip}:${port}/`);
  return { url, sha256: tls.sha256, close: () => server.close() };
}
