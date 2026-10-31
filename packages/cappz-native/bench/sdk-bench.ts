/**
 * End-to-end benchmark through the SDK's TypeScript API (FFI and copy costs
 * included), against what an SDK user would otherwise call. Prints a
 * Markdown table and writes bench/results-<arch>-<platform>.json.
 *
 *   npx vite-node packages/cappz-native/bench/sdk-bench.ts
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { typescriptKernels, loadWasmKernels, loadNativeLibrary, nativeLibraryName, type NativeKernels } from '../../../src/lib/native/cappzNative';
import { rsEncode, rsDecode } from '../../../src/lib/erasure/reedSolomon';
import { digestContent } from '../../../src/lib/crypto/contentDigest';
import CryptoJS from 'crypto-js';
import * as secp from '@noble/secp256k1';
import { buildNotaryBatch, verifyNotaryInclusion } from '../../../src/lib/crypto/notaryBatch';
import { generateRecoveryPhrase, keyPairFromPhrase, signMessage } from '../../../src/lib/auth/wallet/session';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const MiB = 1 << 20;
const quick = process.argv.includes('--quick');

function bytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < n; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; out[i] = x & 0xff; }
  return out;
}

/** Median of `runs` timings (ms) after one warmup. */
async function time(fn: () => unknown, runs = quick ? 3 : 9): Promise<number> {
  await fn();
  const t: number[] = [];
  for (let i = 0; i < runs; i++) { const s = performance.now(); await fn(); t.push(performance.now() - s); }
  t.sort((a, b) => a - b);
  return t[Math.floor(runs / 2)];
}

interface Result { group: string; name: string; ms: number; mbps: number }
const results: Result[] = [];
async function measure(group: string, name: string, megabytes: number, fn: () => unknown, runs?: number) {
  const ms = await time(fn, runs);
  results.push({ group, name, ms, mbps: megabytes / (ms / 1e3) });
}

const backends: NativeKernels[] = [typescriptKernels, await loadWasmKernels(new Uint8Array(readFileSync(path.resolve(here, '../../../src/lib/native/wasm/cappz_native.wasm'))))];
const libPath = process.env.CAPPZ_NATIVE_LIB ?? path.resolve(here, '../target/release', nativeLibraryName());
if (existsSync(libPath)) backends.push(await loadNativeLibrary(libPath));
const native = backends.find((b) => b.backend === 'native');

// ── SHA-256, one buffer ─────────────────────────────────────────────────
for (const size of [1024, 64 * 1024, 64 * MiB]) {
  const data = bytes(size, 3);
  const reps = Math.max(1, Math.floor((quick ? 16 : 64) * MiB / size));
  const mb = (size * reps) / MiB;
  const label = size >= MiB ? `${size / MiB} MiB` : `${size / 1024} KiB`;
  const g = `sha256 · ${label}`;
  await measure(g, 'node:crypto createHash (OpenSSL)', mb, () => { for (let i = 0; i < reps; i++) createHash('sha256').update(data).digest(); });
  await measure(g, 'WebCrypto subtle.digest', mb, async () => { for (let i = 0; i < reps; i++) await webcrypto.subtle.digest('SHA-256', data); });
  await measure(g, '@noble/hashes (TypeScript backend)', mb, () => { for (let i = 0; i < reps; i++) nobleSha256(data); });
  for (const b of backends.slice(1)) await measure(g, `cappz-native ${b.backend}`, mb, () => { for (let i = 0; i < reps; i++) b.sha256(data); });
}

// ── Content addressing: whole-file hash + 4 MiB chunk ids (putBody) ─────
{
  const size = (quick ? 32 : 256) * MiB, chunk = 4 * MiB;
  const data = bytes(size, 5);
  const g = `content-address ${size / MiB} MiB (whole + 4 MiB chunks)`;
  const mb = size / MiB;
  await measure(g, 'WebCrypto (SDK today)', mb, async () => {
    await webcrypto.subtle.digest('SHA-256', data);
    for (let at = 0; at < size; at += chunk) await webcrypto.subtle.digest('SHA-256', data.subarray(at, at + chunk));
  }, 5);
  if (native) await measure(g, 'cappz-native, all cores', mb, () => { native.sha256(data); native.sha256Chunks(data, chunk); }, 5);
}

// ── Notarization: file hash + salted leaf ──────────────────────────────
{
  const size = (quick ? 32 : 64) * MiB;
  const data = bytes(size, 11);
  const blob = new Blob([data]);
  const salt = new Uint8Array(16).fill(7);
  const g = `notarize a ${size / MiB} MiB file (file hash + salted leaf)`;
  const mb = size / MiB;
  // Today: the UI hashes the file with crypto-js in 1 MiB pieces, then the
  // XRPL notary service hashes salt || file with crypto-js over the whole file.
  await measure(g, 'crypto-js: UI file hash + notary leaf (today, 2 passes)', mb, async () => {
    const h = CryptoJS.algo.SHA256.create();
    for (let at = 0; at < size; at += MiB) h.update(CryptoJS.lib.WordArray.create(data.subarray(at, at + MiB)));
    h.finalize().toString();
    const all = new Uint8Array(await blob.arrayBuffer());
    CryptoJS.SHA256(CryptoJS.lib.WordArray.create(salt).concat(CryptoJS.lib.WordArray.create(all))).toString();
  }, 3);
  await measure(g, 'digestContent · WebCrypto, one buffer (browser ≤ 64 MiB)', mb, () => digestContent(blob, { leafPrefix: salt, kernels: typescriptKernels }));
  for (const b of backends) {
    const runs = b.backend === 'typescript' ? 3 : undefined;
    await measure(g, `digestContent · streamed, ${b.backend}`, mb, () => digestContent(blob, { leafPrefix: salt, kernels: b, webCryptoMaxBytes: -1 }), runs);
  }
}

// ── Signature verification (signatures per second) ─────────────────────
{
  const N = quick ? 64 : 256;
  const secpItems = [];
  for (let i = 0; i < N; i++) {
    const k = keyPairFromPhrase(generateRecoveryPhrase());
    const msg = `KeyZ declaration ${i}`;
    const sig = secp.etc.hexToBytes(await signMessage(k.privateKey, msg));
    secpItems.push({ digest: nobleSha256(nobleSha256(new TextEncoder().encode(msg))), signature: sig, publicKey: k.publicKey });
  }
  const edItems = [];
  for (let i = 0; i < N; i++) {
    const keys = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const message = new TextEncoder().encode(`{"kind":"hello","n":${i}}`);
    edItems.push({ publicKey: new Uint8Array(await webcrypto.subtle.exportKey('raw', keys.publicKey)), message, signature: new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, keys.privateKey, message)) });
  }
  const per = (group: string, name: string, fn: () => unknown, runs?: number) => measure(group, name, N, fn, runs);
  const gs = `secp256k1 verify · ${N} wallet signatures`;
  for (const b of backends) {
    const runs = b.backend === 'typescript' ? 3 : undefined;
    await per(gs, `${b.backend}${b.backend === 'typescript' ? ' (@noble, the SDK until now)' : ''}${b.backend === 'native' ? ', one core' : ''}`, () => b.secp256k1VerifyMany(secpItems, 1), runs);
    if (b.backend === 'native') await per(gs, 'native, all cores', () => b.secp256k1VerifyMany(secpItems, 0));
  }
  const ge = `Ed25519 verify · ${N} hello signatures`;
  await per(ge, 'WebCrypto, import per verify (the SDK until now)', async () => { for (const it of edItems) { const k = await webcrypto.subtle.importKey('raw', it.publicKey, { name: 'Ed25519' }, false, ['verify']); await webcrypto.subtle.verify({ name: 'Ed25519' }, k, it.signature, it.message); } });
  for (const b of backends) {
    const runs = b.backend === 'typescript' ? 3 : undefined;
    await per(ge, `${b.backend}${b.backend === 'native' ? ', one core' : ''}`, () => b.ed25519VerifyMany(edItems, 1), runs);
    if (b.backend === 'native') await per(ge, 'native, all cores', () => b.ed25519VerifyMany(edItems, 0));
  }
}

// ── Batch notarization (Merkle proofs) ─────────────────────────────────
{
  const n = 1000;
  const leaves = Array.from({ length: n }, (_, i) => createHash('sha256').update(`file ${i}`).digest('hex').toUpperCase());
  let batch = buildNotaryBatch(leaves);
  await measure(`notary batch · ${n} files`, 'build root + every inclusion proof', n, () => { batch = buildNotaryBatch(leaves); });
  await measure(`notary batch · ${n} files`, 'verify every inclusion proof', n, () => { for (const p of batch.proofs) verifyNotaryInclusion(leaves[p.index], p, batch); });
}

// ── Reed-Solomon ────────────────────────────────────────────────────────
for (const [k, m, size] of [[10, 4, (quick ? 16 : 64) * MiB], [4, 2, 16 * MiB]] as const) {
  const data = bytes(size, 7);
  const ge = `RS encode ${k}+${m} · ${size / MiB} MiB`;
  const gd = `RS rebuild ${k}+${m} · ${size / MiB} MiB, ${m} data shards lost`;
  const mb = size / MiB;
  {
    // The scheme cappz uses today: one XOR parity copied m times (survives one loss).
    const shardSize = Math.ceil(size / k);
    await measure(ge, 'XOR parity (current cappz, not RS)', mb, () => {
      const parity = new Uint8Array(shardSize);
      for (let j = 0; j < k; j++) { const s = data.subarray(j * shardSize, (j + 1) * shardSize); for (let i = 0; i < s.length; i++) parity[i] ^= s[i]; }
    }, 3);
  }
  for (const b of backends) {
    const runs = b.backend === 'typescript' ? 3 : undefined;
    await measure(ge, `rsEncode · ${b.backend}`, mb, () => rsEncode(data, k, m, b), runs);
    const { descriptor, shards } = rsEncode(data, k, m, b);
    const damaged = shards.map((s, i) => (i < m ? null : s));
    await measure(gd, `rsDecode · ${b.backend}`, mb, () => rsDecode(damaged, descriptor, b), runs);
  }
}

// ── Report ──────────────────────────────────────────────────────────────
const cpu = os.cpus()[0]?.model ?? 'unknown';
const device = { arch: process.arch, platform: process.platform, cpu, cores: os.availableParallelism(), node: process.version, features: native?.features ?? null };
console.log(`\n${cpu} · ${device.cores} cores · ${process.platform}-${process.arch} · Node ${process.version}\n`);
for (const group of [...new Set(results.map((r) => r.group))]) {
  const rows = results.filter((r) => r.group === group);
  const unit = /verify|batch/.test(group) ? 'per second' : 'MB/s';
  console.log(`\n**${group}**\n\n| implementation | ${unit} | median | vs first row |\n|---|---:|---:|---:|`);
  for (const r of rows) {
    const ms = r.ms < 1 ? `${(r.ms * 1e3).toFixed(0)} µs` : `${r.ms.toFixed(1)} ms`;
    console.log(`| ${r.name} | ${r.mbps.toFixed(0)} | ${ms} | ${(r.mbps / rows[0].mbps).toFixed(1)}× |`);
  }
}
const out = path.resolve(here, `results-${process.arch}-${process.platform}.json`);
writeFileSync(out, JSON.stringify({ device, date: new Date().toISOString(), results }, null, 2) + '\n');
console.log(`\nwrote ${out}`);
