/**
 * COPE node crystallized.
 * Node ID: v15-13-00-mesh-kit
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * The go-kit: everything a device needs to join the mesh, with no internet
 * and no install step, in one folder (and one zip of it) that can be copied
 * to a USB stick or downloaded from any running node (/kit/).
 *
 *   cappz-mesh.mjs        the whole node program, every dependency bundled (needs only Node.js ≥ 20)
 *   web/                  the phone app (served by the node; iPhone, iPad, browser-only phones)
 *   node/<platform>/      optional Node.js runtimes, so a computer without Node can still run it
 *   start.sh · start.command · start.bat   launchers (Linux/Termux · macOS · Windows)
 *   charter.json          the mesh this kit is for (optional)
 *   MESH_FIELD_GUIDE.md · README.txt
 *   KIT-MANIFEST.json     sha256 of every file, signed by a charter authority's wallet
 *
 * A kit passed hand to hand can be tampered with (a trojaned program is the
 * obvious wartime attack). `verify-kit` recomputes every hash and checks the
 * signature against the charter's authorities. A device with no trusted copy
 * yet cannot verify its first kit by itself — the guide says to compare the
 * printed kit fingerprint with a coordinator's.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { zipSync } from 'fflate';
import { signMessage, verifySignature } from '../../src/lib/auth/wallet/session.ts';
import { canonicalJson } from '../../src/lib/identity/canonical.ts';
import type { MeshCharter } from '../../src/lib/mesh/meshIdentity.ts';

export const NODE_PLATFORMS = ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64', 'win-x64'] as const;
export type NodePlatform = (typeof NODE_PLATFORMS)[number];

export interface KitManifest {
  v: 1;
  kind: 'cpz-mesh-kit';
  builtAt: string;
  sdkVersion: string;
  nodeVersion?: string;
  meshId?: string;
  files: Record<string, string>; // relative path → sha256 hex
  signer?: string;
  signature?: string;
}

export type KitCheck =
  | { state: 'verified-by-authority'; signer: string; fingerprint: string }
  | { state: 'signed-unknown-signer'; signer: string; fingerprint: string }
  | { state: 'unsigned'; fingerprint: string }
  | { state: 'tampered'; files: string[]; fingerprint: string }
  | { state: 'bad-signature'; fingerprint: string }
  | { state: 'no-manifest' };

const sha256File = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const walk = (dir: string, base = dir): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p, base) : [path.relative(base, p).split(path.sep).join('/')];
});
const unsignedBody = (m: KitManifest) => { const { signature: _s, ...rest } = m; return canonicalJson(rest); };
/** Short, readable fingerprint of a kit: compare it aloud with a coordinator's. */
export const kitFingerprint = (m: KitManifest) => crypto.createHash('sha256').update(unsignedBody({ ...m, signer: undefined })).digest('hex').slice(0, 16).replace(/(.{4})/g, '$1 ').trim();

const LAUNCH_SH = `#!/bin/sh
# CAPPZ Mesh launcher (Linux, Raspberry Pi, Android Termux). Uses the bundled Node.js if present.
cd "$(dirname "$0")"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) P=linux-x64 ;; Linux-aarch64|Linux-arm64) P=linux-arm64 ;;
  Darwin-arm64) P=darwin-arm64 ;; Darwin-x86_64) P=darwin-x64 ;; *) P=none ;;
esac
NODE=node
if [ -x "node/$P/bin/node" ] && [ -z "$PREFIX" ]; then NODE="node/$P/bin/node"; fi   # Termux ($PREFIX) uses its own nodejs package
if ! command -v "$NODE" >/dev/null 2>&1 && [ ! -x "$NODE" ]; then echo "Node.js not found: install it (Termux: pkg install nodejs-lts) or use a kit with runtimes."; exit 1; fi
if [ $# -eq 0 ]; then set -- quickstart; fi
exec "$NODE" cappz-mesh.mjs "$@"
`;
const LAUNCH_BAT = `@echo off
rem CAPPZ Mesh launcher (Windows). Uses the bundled Node.js if present.
cd /d "%~dp0"
set NODE=node
if exist "node\\win-x64\\node.exe" set NODE=node\\win-x64\\node.exe
if "%~1"=="" ( "%NODE%" cappz-mesh.mjs quickstart ) else ( "%NODE%" cappz-mesh.mjs %* )
pause
`;
const README = (fp: string, meshName?: string) => `CAPPZ MESH GO-KIT${meshName ? ` for "${meshName}"` : ''}
Kit fingerprint: ${fp}  (compare with your coordinator before running)

Runs with NO internet. Copy this whole folder to a computer or Android phone.

  Linux / Raspberry Pi:   sh start.sh
  Mac:                    double-click start.command (first time: right-click > Open)
  Windows:                double-click start.bat
  Android:                install Termux + nodejs-lts beforehand, then: sh start.sh
  iPhone / iPad:          you cannot run this program; join the Wi-Fi of a device running it
                          and open the https://... address it prints, in Safari.

The first start creates a wallet and joins as a GUEST (routine messages only).
Give your address to a coordinator for a grant; it can arrive over the mesh.
Full instructions: MESH_FIELD_GUIDE.md
Check this kit: <node> cappz-mesh.mjs verify-kit .
`;

/** Download and verify a Node.js runtime for a platform (needs internet: do it before the outage). */
async function fetchNode(version: string, platform: NodePlatform, dest: string, log: (s: string) => void): Promise<void> {
  const base = `https://nodejs.org/dist/${version}`;
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const name = platform === 'win-x64' ? `node-${version}-win-x64.zip` : `node-${version}-${platform}.tar.gz`;
  const want = sums.split('\n').find((l) => l.endsWith(`  ${name}`))?.split(/\s+/)[0];
  if (!want) throw new Error(`no ${name} in SHASUMS256`);
  const bytes = new Uint8Array(await (await fetch(`${base}/${name}`)).arrayBuffer());
  const got = crypto.createHash('sha256').update(bytes).digest('hex');
  if (got !== want) throw new Error(`${name}: checksum mismatch`);
  fs.mkdirSync(dest, { recursive: true });
  const archive = path.join(dest, name);
  fs.writeFileSync(archive, bytes);
  const { execFileSync } = await import('node:child_process');
  if (name.endsWith('.zip')) {
    const { unzipSync } = await import('fflate');
    const files = unzipSync(bytes);
    for (const [p, data] of Object.entries(files)) {
      const rel = p.split('/').slice(1).join('/');
      if (!rel || p.endsWith('/')) continue;
      fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
      fs.writeFileSync(path.join(dest, rel), data);
    }
  } else execFileSync('tar', ['-xzf', archive, '-C', dest, '--strip-components=1']);
  fs.rmSync(archive);
  // Keep only the runtime and its licence: npm, corepack, headers and docs are not needed to run the kit.
  const keep = new Set(platform === 'win-x64' ? ['node.exe', 'LICENSE'] : ['bin', 'LICENSE']);
  for (const e of fs.readdirSync(dest)) if (!keep.has(e)) fs.rmSync(path.join(dest, e), { recursive: true, force: true });
  if (platform !== 'win-x64') for (const e of fs.readdirSync(path.join(dest, 'bin'))) if (e !== 'node') fs.rmSync(path.join(dest, 'bin', e), { force: true });
  log(`node ${version} ${platform} ✓ (sha256 matches nodejs.org SHASUMS256)`);
}

export async function buildKit(o: {
  sdkRoot: string;
  out: string;
  charter?: MeshCharter;
  meshId?: string;
  sdkVersion: string;
  withNode?: NodePlatform[];
  signer?: { address: string; privateKey: Uint8Array };
  log?: (s: string) => void;
}): Promise<{ manifest: KitManifest; zip: string; fingerprint: string }> {
  const log = o.log ?? console.log;
  const pkg = path.join(o.sdkRoot, 'packages/cappz-mesh-node');
  fs.rmSync(o.out, { recursive: true, force: true });
  fs.mkdirSync(path.join(o.out, 'web'), { recursive: true });
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: [path.join(pkg, 'main.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node20',
    outfile: path.join(o.out, 'cappz-mesh.mjs'), external: ['esbuild'], legalComments: 'none', logLevel: 'warning',
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
  await bundleMeshWeb(path.join(pkg, 'web'), path.join(o.out, 'web'));
  fs.copyFileSync(path.join(pkg, 'web/index.html'), path.join(o.out, 'web/index.html'));
  fs.copyFileSync(path.join(o.sdkRoot, 'docs/MESH_FIELD_GUIDE.md'), path.join(o.out, 'MESH_FIELD_GUIDE.md'));
  fs.copyFileSync(path.join(o.sdkRoot, 'LICENSE'), path.join(o.out, 'LICENSE'));
  if (o.charter) fs.writeFileSync(path.join(o.out, 'charter.json'), JSON.stringify(o.charter, null, 2));
  fs.writeFileSync(path.join(o.out, 'start.sh'), LAUNCH_SH, { mode: 0o755 });
  fs.writeFileSync(path.join(o.out, 'start.command'), LAUNCH_SH, { mode: 0o755 });
  fs.writeFileSync(path.join(o.out, 'start.bat'), LAUNCH_BAT.replace(/\n/g, '\r\n'));
  for (const p of o.withNode ?? []) await fetchNode(process.version, p, path.join(o.out, 'node', p), log);

  const files: Record<string, string> = {};
  for (const f of walk(o.out).sort()) files[f] = sha256File(path.join(o.out, f));
  let manifest: KitManifest = {
    v: 1, kind: 'cpz-mesh-kit', builtAt: new Date().toISOString(), sdkVersion: o.sdkVersion,
    ...(o.withNode?.length ? { nodeVersion: process.version } : {}), ...(o.meshId ? { meshId: o.meshId } : {}), files,
  };
  if (o.signer) { manifest = { ...manifest, signer: o.signer.address }; manifest.signature = await signMessage(o.signer.privateKey, unsignedBody(manifest)); }
  const fingerprint = kitFingerprint(manifest);
  fs.writeFileSync(path.join(o.out, 'KIT-MANIFEST.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(o.out, 'README.txt'), README(fingerprint, o.charter?.name));

  // One zip of the folder, for a download from a node or a single copy.
  const zip = path.join(path.dirname(o.out), 'cappz-mesh-kit.zip');
  fs.writeFileSync(zip, zipKitDir(o.out));
  return { manifest, zip, fingerprint };
}

/** The kit folder as one zip (top folder `cappz-mesh-kit/`); Unix modes kept for the launchers and runtimes. */
export function zipKitDir(dir: string): Uint8Array {
  const entries: Record<string, [Uint8Array, { os: number; attrs: number }]> = {};
  for (const f of walk(dir)) {
    const st = fs.statSync(path.join(dir, f));
    entries[`cappz-mesh-kit/${f}`] = [new Uint8Array(fs.readFileSync(path.join(dir, f))), { os: 3, attrs: (st.mode & 0o777) << 16 }];
  }
  return zipSync(entries as unknown as Parameters<typeof zipSync>[0], { level: 6 });
}

export function readKitManifest(dir: string): KitManifest | null {
  const p = path.join(dir, 'KIT-MANIFEST.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) as KitManifest : null;
}

export async function verifyKit(dir: string, charter?: MeshCharter): Promise<KitCheck> {
  const mp = path.join(dir, 'KIT-MANIFEST.json');
  if (!fs.existsSync(mp)) return { state: 'no-manifest' };
  const m = JSON.parse(fs.readFileSync(mp, 'utf8')) as KitManifest;
  const fingerprint = kitFingerprint(m);
  const bad: string[] = [];
  for (const [f, h] of Object.entries(m.files)) { const p = path.join(dir, f); if (!fs.existsSync(p) || sha256File(p) !== h) bad.push(f); }
  // Anything executable that the manifest does not name is also tampering.
  for (const f of walk(dir)) if (!(f in m.files) && !['KIT-MANIFEST.json', 'README.txt'].includes(f) && /\.(mjs|js|sh|command|bat|exe)$|^node\//.test(f)) bad.push(`+${f}`);
  if (bad.length) return { state: 'tampered', files: bad, fingerprint };
  if (!m.signature || !m.signer) return { state: 'unsigned', fingerprint };
  if (!(await verifySignature(unsignedBody(m), m.signature, m.signer))) return { state: 'bad-signature', fingerprint };
  return charter?.authorities.includes(m.signer) ? { state: 'verified-by-authority', signer: m.signer, fingerprint } : { state: 'signed-unknown-signer', signer: m.signer, fingerprint };
}

/** The phone app's two bundles: web/app.js, and the OPFS write worker Safari before 26 needs (MESH_WEB_WORKER). */
export const MESH_WEB_WORKER = 'opfs-write-worker.js';
export async function bundleMeshWeb(srcWebDir: string, outDir: string): Promise<void> {
  const esbuild = await import('esbuild');
  const common = { bundle: true, platform: 'browser' as const, target: ['safari15', 'chrome100'], minify: true, logLevel: 'warning' as const };
  // app.ts names the worker file (setOpfsWriteWorkerUrl), so opfsWrite's import.meta default is unused here.
  await esbuild.build({ ...common, entryPoints: [path.join(srcWebDir, 'app.ts')], format: 'iife', outfile: path.join(outDir, 'app.js'), logOverride: { 'empty-import-meta': 'silent' } });
  await esbuild.build({ ...common, entryPoints: [path.join(srcWebDir, '../../../src/lib/sync/storageEngines/opfsWriteWorker.ts')], format: 'esm', outfile: path.join(outDir, MESH_WEB_WORKER) });
}
