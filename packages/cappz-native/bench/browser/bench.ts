/**
 * In-browser benchmark (bundled by run-browser-bench.mjs): what a page gets
 * from WebCrypto, the WASM kernels and the TypeScript fallbacks in this
 * browser. Publishes window.__benchResults when done.
 */
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import * as secp from '@noble/secp256k1';
import { argon2id } from 'hash-wasm';
import { loadWasmKernels, typescriptKernels, type NativeKernels } from '../../../../src/lib/native/cappzNative';
import { digestContent } from '../../../../src/lib/crypto/contentDigest';
import { rsEncode, rsDecode, rsEncodeAsync, rsDecodeAsync } from '../../../../src/lib/erasure/reedSolomon';
import { createKernelPool, rsDecodeParallel, rsEncodeParallel } from '../../../../src/lib/native/kernelPool';
import { generateRecoveryPhrase, keyPairFromPhrase, signMessage } from '../../../../src/lib/auth/wallet/session';

interface Row { group: string; name: string; ms: number; rate: number; unit: string }
const rows: Row[] = [];
const MiB = 1 << 20;
const log = (s: string) => { const el = document.getElementById('log'); if (el) el.textContent += s + '\n'; };

function fill(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < n; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; out[i] = x & 0xff; }
  return out;
}

async function time(fn: () => unknown, runs = 7): Promise<number> {
  await fn();
  const t: number[] = [];
  for (let i = 0; i < runs; i++) { const s = performance.now(); await fn(); t.push(performance.now() - s); }
  t.sort((a, b) => a - b);
  return t[Math.floor(runs / 2)];
}
async function measure(group: string, name: string, amount: number, unit: 'MB/s' | '/s', fn: () => unknown, runs?: number) {
  const ms = await time(fn, runs);
  rows.push({ group, name, ms, rate: amount / (ms / 1000), unit });
  log(`${group} · ${name}: ${(amount / (ms / 1000)).toFixed(0)} ${unit}`);
}

async function main() {
  const bytesOf = async (u: string) => new Uint8Array(await (await fetch(u)).arrayBuffer());
  const wasm = await loadWasmKernels(await bytesOf('cappz_native.wasm'), { signatures: await bytesOf('cappz_native_sig.wasm') });
  const backends: NativeKernels[] = [typescriptKernels, wasm];

  // SHA-256, 64 MiB
  {
    const data = fill(64 * MiB, 3);
    const g = 'sha256 · 64 MiB';
    await measure(g, 'WebCrypto subtle.digest', 64, 'MB/s', () => crypto.subtle.digest('SHA-256', data));
    await measure(g, '@noble/hashes (TypeScript)', 64, 'MB/s', () => nobleSha256(data), 3);
    await measure(g, 'cappz-native wasm', 64, 'MB/s', () => wasm.sha256(data));
  }
  // Notarization digest: file hash + salted leaf
  {
    const data = fill(64 * MiB, 11);
    const blob = new Blob([data]);
    const salt = new Uint8Array(16).fill(7);
    const g = 'notarize 64 MiB (file hash + salted leaf)';
    await measure(g, 'digestContent · WebCrypto, one buffer', 64, 'MB/s', () => digestContent(blob, { leafPrefix: salt, kernels: typescriptKernels }));
    await measure(g, 'digestContent · streamed, wasm', 64, 'MB/s', () => digestContent(blob, { leafPrefix: salt, kernels: wasm, webCryptoMaxBytes: -1 }));
    await measure(g, 'digestContent · streamed, typescript', 64, 'MB/s', () => digestContent(blob, { leafPrefix: salt, kernels: typescriptKernels, webCryptoMaxBytes: -1 }), 3);
  }
  // Reed-Solomon 10+4, 16 MiB
  {
    const data = fill(16 * MiB, 7);
    for (const b of backends) {
      const runs = b.backend === 'typescript' ? 3 : 7;
      await measure('RS encode 10+4 · 16 MiB', b.backend, 16, 'MB/s', () => rsEncode(data, 10, 4, b), runs);
      const { descriptor, shards } = rsEncode(data, 10, 4, b);
      const damaged = shards.map((s, i) => (i < 4 ? null : s));
      await measure('RS rebuild 10+4 · 16 MiB, 4 lost', b.backend, 16, 'MB/s', () => rsDecode(damaged, descriptor, b), runs);
      await measure('RS encode 10+4 · 16 MiB', `${b.backend}, shard hashes on WebCrypto (rsEncodeAsync)`, 16, 'MB/s', () => rsEncodeAsync(data, 10, 4, b), runs);
      await measure('RS rebuild 10+4 · 16 MiB, 4 lost', `${b.backend}, shard hashes on WebCrypto (rsDecodeAsync)`, 16, 'MB/s', () => rsDecodeAsync(damaged, descriptor, b), runs);
    }
  }
  // Signature verification
  {
    const N = 128;
    const secpItems = [];
    for (let i = 0; i < N; i++) {
      const k = keyPairFromPhrase(generateRecoveryPhrase());
      const msg = `KeyZ declaration ${i}`;
      secpItems.push({ digest: nobleSha256(nobleSha256(new TextEncoder().encode(msg))), signature: secp.etc.hexToBytes(await signMessage(k.privateKey, msg)), publicKey: k.publicKey });
    }
    for (const b of backends) await measure(`secp256k1 verify · ${N}`, b.backend === 'typescript' ? '@noble (TypeScript)' : 'wasm', N, '/s', () => b.secp256k1VerifyMany(secpItems), b.backend === 'typescript' ? 3 : 7);
    const edItems = [];
    for (let i = 0; i < N; i++) {
      const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
      const message = new TextEncoder().encode(`{"kind":"hello","n":${i}}`);
      edItems.push({ publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)), message, signature: new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey, message)) });
    }
    await measure(`Ed25519 verify · ${N}`, 'WebCrypto, import per verify', N, '/s', async () => { for (const it of edItems) { const k = await crypto.subtle.importKey('raw', it.publicKey, 'Ed25519', false, ['verify']); await crypto.subtle.verify('Ed25519', k, it.signature, it.message); } });
    for (const b of backends) await measure(`Ed25519 verify · ${N}`, b.backend === 'typescript' ? '@noble (TypeScript)' : 'wasm', N, '/s', () => b.ed25519VerifyMany(edItems), b.backend === 'typescript' ? 3 : 7);
  }
  // Chunk hashing (putBody, shard hashes): does WebCrypto spread concurrent digests over cores?
  {
    const data = fill(64 * MiB, 5);
    const chunk = 4 * MiB;
    const pieces = Array.from({ length: 16 }, (_, i) => data.subarray(i * chunk, (i + 1) * chunk));
    const g = 'sha256 · 16 chunks of 4 MiB';
    await measure(g, 'WebCrypto, one after another', 64, 'MB/s', async () => { for (const p of pieces) await crypto.subtle.digest('SHA-256', p); });
    await measure(g, 'WebCrypto, all at once (Promise.all)', 64, 'MB/s', () => Promise.all(pieces.map((p) => crypto.subtle.digest('SHA-256', p))));
    await measure(g, 'wasm sha256Chunks', 64, 'MB/s', () => wasm.sha256Chunks(data, chunk));
  }
  // Reed-Solomon: the GF kernel alone (no shard hashing)
  {
    const k = 10, m = 4, len = Math.ceil(16 * MiB / k);
    const inputs = fill(k * len, 9);
    const coeffs = fill(m * k, 4).map((c) => c || 1);
    for (const b of backends) await measure('GF kernel only · 10+4 over 16 MiB', b.backend, 16, 'MB/s', () => b.gfMatmul(coeffs, m, k, inputs, len, 1), b.backend === 'typescript' ? 3 : 7);
  }
  // Multi-threaded WASM: a pool of workers, each with the core module
  {
    const data = fill(64 * MiB, 13);
    const core = await bytesOf('cappz_native.wasm');
    await measure('RS encode 10+4 · 64 MiB', 'one thread (rsEncodeAsync)', 64, 'MB/s', () => rsEncodeAsync(data, 10, 4, wasm), 5);
    const { descriptor, shards } = rsEncode(data, 10, 4, wasm);
    const damaged = shards.map((x, i) => (i < 4 ? null : x));
    await measure('RS rebuild 10+4 · 64 MiB, 4 lost', 'one thread (rsDecodeAsync)', 64, 'MB/s', () => rsDecodeAsync(damaged, descriptor, wasm), 5);
    await measure('sha256 · 64 MiB in 1 MiB chunks', 'one thread (WebCrypto)', 64, 'MB/s', async () => { for (let at = 0; at < data.length; at += MiB) await crypto.subtle.digest('SHA-256', data.subarray(at, at + MiB)); }, 5);
    for (const size of [1, 2, 4, 8]) {
      const pool = await createKernelPool({ createWorker: () => new Worker('kernel-worker.js', { type: 'module' }), wasm: core, size });
      await measure('RS encode 10+4 · 64 MiB', `pool of ${size} workers`, 64, 'MB/s', () => rsEncodeParallel(data, 10, 4, pool), 5);
      await measure('RS rebuild 10+4 · 64 MiB, 4 lost', `pool of ${size} workers`, 64, 'MB/s', () => rsDecodeParallel(damaged, descriptor, pool), 5);
      await measure('sha256 · 64 MiB in 1 MiB chunks', `pool of ${size} workers`, 64, 'MB/s', () => pool.sha256Chunks(data, MiB), 5);
      pool.close();
    }
  }
  // Wallet unlock KDF: argon2id as keyVault runs it (64 MiB, 3 passes, 1 lane)
  {
    const salt = new Uint8Array(16).fill(1);
    await measure('argon2id 64 MiB t=3 p=1 (keyVault unlock)', 'hash-wasm on the calling thread', 1, '/s', () => argon2id({ password: 'login:passcode', salt, iterations: 3, memorySize: 64 * 1024, parallelism: 1, hashLength: 32, outputType: 'binary' }), 3);
  }
  // Main-thread blocking and core count, for the worker decisions
  rows.push({ group: 'environment', name: `hardwareConcurrency ${navigator.hardwareConcurrency}; crossOriginIsolated ${globalThis.crossOriginIsolated}`, ms: 0, rate: 0, unit: '' });
}

main().then(
  () => { (window as unknown as { __benchResults: unknown }).__benchResults = { ua: navigator.userAgent, rows }; },
  (err) => { (window as unknown as { __benchResults: unknown }).__benchResults = { error: String(err?.stack ?? err), rows }; },
);
