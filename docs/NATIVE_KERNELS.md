# Native kernels: Reed-Solomon and SHA-256 on ARM

`packages/cappz-native` (15.14.0; streaming SHA-256 in 15.15.0) is a small Rust crate with the SDK's two compute hot spots:

- **SHA-256** — every content address, chunk id, model-weight shard and notarization leaf in the SDK is one. One-shot, per-chunk on all cores, and streamed for input that arrives in pieces.
- **GF(2^8) matrix × shards** — the one kernel Reed-Solomon erasure coding needs.
- **Signature verification** (15.16.0) — secp256k1 ECDSA (wallet, KeyZ and session signatures) and Ed25519 (hellos, edge requests), in batches across cores, on the audited `k256` and `ed25519-dalek` crates.

It is loaded three ways behind one TypeScript interface (`src/lib/native/cappzNative.ts`), and every backend produces byte-identical output:

| Backend | Where | What it uses |
|---|---|---|
| `native` | Node 26+ (`node:ffi`), Deno (`Deno.dlopen`), Bun (`bun:ffi`) | NEON table lookups for GF, the ARMv8 SHA-256 instructions, all cores |
| `wasm` | browsers, any runtime | SIMD128 (`i8x16.swizzle`, which ARM browsers lower to NEON `TBL`) |
| `typescript` | everywhere | portable code, always available |

Nothing requires the native build. Without it the SDK runs the TypeScript kernels, as before.

## What it is for

**Erasure coding that survives what it claims to.** `rsEncode(data, k, m)` produces `k` data shards and `m` parity shards; `rsDecode` rebuilds the bytes from **any** `k` of them. This replaces XOR parity, under which every "parity" shard is the same XOR, so ten data shards plus four parity shards still lose data when two shards go missing. The matrix is a Vandermonde matrix made systematic, so data shards are plain slices of the input and every `k`-row subset is invertible (tested for all subsets).

**Corruption becomes loss, not wrong bytes.** Reed-Solomon repairs erasures, not errors: a damaged shard used as if it were good silently corrupts the result. The descriptor records each shard's SHA-256, and `rsDecode` drops any shard that does not match, then rebuilds from the rest. `lost` in the result says which shards were set aside.

**Content addressing on all cores.** When native kernels are loaded, `putBody` (chunked bodies, `src/lib/sync/chunkedBodies.ts`) computes the whole-file hash and every chunk id in one call. The ids are the same as before; only the time changes.

**Notarization in one pass** (15.15.0). `digestContent(file, { leafPrefix })` (`src/lib/crypto/contentDigest.ts`) reads a file once and returns both its SHA-256 and the salted leaf, SHA-256(prefix || content). The prefix is whatever the receipt scheme salts with: the salt text (`notarizeClient`, `verifyClient`, `cappz-notarize`) or raw salt bytes (a notary that salts with bytes). Leaves are byte-identical to before, checked against fixed vectors and against `crypto-js`. It picks its path by runtime and size:

| Runtime | Path | Memory |
|---|---|---|
| Native kernels loaded (Node 26, Deno, Bun) | streamed; the two digests on two cores; the next slice read while this one is hashed | two 4 MiB slices |
| Browser, up to 64 MiB | WebCrypto over one buffer — a browser's only route to the CPU's SHA instructions | the file plus the prefix |
| Browser, larger | streamed on WASM (or TypeScript) kernels | two 4 MiB slices |

`notarizeClient` and `verifyClient` take `file` (a `Blob`) or `fileBytes` and report `onProgress`; `fileBase64` still works but costs a third more bytes and two copies. `notarizeClient` also returns `contentSha256` from the same pass.

```ts
import { loadKernels } from '@cappz/sdk/lib/native/cappzNative';
import { rsEncode, rsDecode } from '@cappz/sdk/lib/erasure/reedSolomon';

// Once at startup: the fastest backend that loads becomes the SDK default.
const k = await loadKernels({ libraryPath: 'packages/cappz-native/target/release/cappz_native.dll', wasmBytes });
console.log(k.backend, k.skipped); // 'native', [] — or why a faster backend was skipped

const { descriptor, shards } = rsEncode(bytes, 10, 4);   // store shards on 14 providers
const { data, lost } = rsDecode(maybeShards, descriptor); // any 10 intact shards
```

## Measured

Windows Dev Kit 2023: Snapdragon 8cx Gen 3 (4 × Cortex-X1 + 4 × Cortex-A78), 32 GB, Windows 11 ARM64, Node 26.12.1, Rust 1.99.1, MSVC 19.44, clang-cl 19.1.5. Medians of 9–15 runs after a warmup. Raw output is in `packages/cappz-native/bench/`; rerun with `npm run native:bench` and `cargo run --release --bin bench --features cpp,sha2-crate` (from `packages/cappz-native`).

### Through the SDK API (what an app gets, FFI and copies included)

| Work | Before | Native | Speed-up |
|---|---:|---:|---:|
| SHA-256, 64 MiB | 319 MB/s (`node:crypto`, OpenSSL) | 1,397 MB/s | 4.4× |
| SHA-256, 1 KiB | 164 MB/s (`node:crypto`); 29 MB/s (WebCrypto, async per call) | 629 MB/s | 3.8× / 22× |
| Content-address 256 MiB (whole hash + 4 MiB chunk ids, `putBody`) | 141 MB/s (WebCrypto, the SDK until now) | 1,198 MB/s | 8.5× |
| Reed-Solomon encode 10+4, 64 MiB (incl. hashing all 14 shards) | 71 MB/s (TypeScript) | 1,398 MB/s | 20× |
| Reed-Solomon rebuild 10+4, 64 MiB, 4 data shards lost (incl. verifying shards) | 83 MB/s (TypeScript) | 891 MB/s | 11× |

Notarizing a 64 MiB file (its SHA-256 plus the salted leaf):

| Path | MB/s | Time | Speed-up |
|---|---:|---:|---:|
| `crypto-js` twice: a UI file hash, then the notary's whole-file leaf (the previous way) | 23 | 2.79 s | 1× |
| `digestContent`, WebCrypto, one buffer | 206 | 310 ms | 9× |
| `digestContent`, streamed, WASM | 94 | 684 ms | 4.1× |
| `digestContent`, streamed, native | 649 | 99 ms | 28× |

A single native SHA-256 stream runs at 1.39 GB/s. With both digests it reached 694 MB/s from memory, one after the other; reading the file's slices added 45 ms more. Hashing the two digests on two cores and reading ahead took the native path from 457 to 649 MB/s.

For scale: XOR parity of the same 64 MiB ran at 673 MB/s, so real Reed-Solomon with integrity hashes on the native backend costs less time than the scheme it replaces.

### In the browser (15.17.0)

Measured in Edge 156 and Chrome 156, both native ARM64 builds, on the same machine. Rerun with `packages/cappz-native/bench/browser/run-browser-bench.mjs`; results are in `bench/browser/results-*.json`. Edge and Chrome agree within a few percent; Edge is shown.

| Work | WebCrypto | WASM | TypeScript |
|---|---:|---:|---:|
| SHA-256, 64 MiB | **1,040 MB/s** | 194 MB/s | 77 MB/s |
| GF kernel only, 10+4 over 16 MiB | | 1,509 MB/s | 154 MB/s |
| Reed-Solomon encode 10+4, 16 MiB: WASM kernel with WebCrypto shard hashes (`rsEncodeAsync`) | | **417 MB/s** | 40 MB/s |
| Reed-Solomon rebuild, 4 lost: same (`rsDecodeAsync`) | | **435 MB/s** | 49 MB/s |
| Reed-Solomon encode with WASM shard hashes (`rsEncode`) | | 121 MB/s | |
| Notarization digest, 64 MiB (`digestContent`) | 361 MB/s (one buffer) | 91 MB/s (streamed) | 36 MB/s |
| secp256k1 verify | | 2,344/s | 1,257/s |
| Ed25519 verify | **13,061/s** | 8,889/s | 1,896/s |
| argon2id 64 MiB (wallet unlock) | | 193 ms | |

What this means:

- **In a browser, WebCrypto hashes about five times faster than WASM.** Browsers' WebCrypto uses the CPU's SHA instructions (Node's OpenSSL does not, on this machine), and WebAssembly cannot reach them. So shard hashes go through WebCrypto (`rsEncodeAsync`, `rsDecodeAsync`, `sha256Chunked`), and the WASM kernel does only the GF math, where it is 10× TypeScript.
- **Concurrent WebCrypto digests do not use more cores.** Sixteen digests at once ran at the same 1.1 GB/s as one after another.
- **Above 64 MiB, `digestContent` streams on WASM at about 90 MB/s** to keep memory flat. A larger `webCryptoMaxBytes` trades memory for about 4× speed.
- **Signatures:** in a browser the WASM module verifies secp256k1 only 1.8× faster than @noble (Node's V8 had suggested ~10×), and WebCrypto's Ed25519 beats it. That is why it is a separate, optional module.
- **Multi-threaded WASM** (`src/lib/native/kernelPool.ts`): a pool of Web Workers, each running the verified core module. Reed-Solomon's GF math is split by byte range, chunk hashing by chunk, and each worker hashes with its own WebCrypto. It needs neither nightly Rust nor cross-origin isolation headers, and its output is byte-identical to the single-threaded codec. Measured on 64 MiB (Edge; Chrome within 2%):

  | | one thread | 2 workers | 4 workers | 8 workers |
  |---|---:|---:|---:|---:|
  | chunk hashing, 1 MiB chunks | 1,061 MB/s | 1,164 | 1,485 | **1,768** |
  | Reed-Solomon encode 10+4 | 436 MB/s | 399 | 440 | **505** |
  | Reed-Solomon rebuild, 4 lost | 437 MB/s | 354 | 382 | 413 |

  Hashing scales to 1.7×. Reed-Solomon gains only 16% at 8 workers and loses below 4, because every slice is copied twice: into the worker, then into its WASM memory. On this chip that copying and the memory bandwidth absorb most of the extra cores. Use the pool for chunk hashing and for encoding large files on 8+ cores (cappz does both); keep rebuilds on one thread. True WASM threads with shared memory would remove the copies, but they need nightly Rust and cross-origin isolation.

### Kernels, Rust against C++ (in one process, no bindings)

The C++ twins in `cpp/kernels.cpp` use the same algorithm, tile size and unroll as the Rust code. Values are MB/s of data processed; for 64 B, latency per hash.

| Kernel | Rust | C++ clang-cl 19 | C++ MSVC 19.44 | Portable Rust |
|---|---:|---:|---:|---:|
| RS encode 10+4, 1 MiB shards | 4,134 | 4,231 | 3,563 | 514 |
| RS encode 10+4, 64 KiB shards | 5,032 | 5,090 | 4,093 | 485 |
| RS encode 4+2, 4 MiB shards | 6,356 | 6,534 | 6,085 | 1,062 |
| SHA-256, 64 MiB | 1,401 | 1,388 | 1,400 | 250 |
| SHA-256, 1 KiB | 1,349 | 1,293 | 1,286 | 233 |
| SHA-256, 64 B (latency) | 72 ns | 99 ns | 109 ns | 504 ns |

All 8 cores: Reed-Solomon 7.7–8.4 GB/s (10+4) and 10.2–11.2 GB/s (4+2); chunk hashing 6.1–7.6 GB/s. The spread between runs comes from thermals and from scheduling across the X1 and A78 cores.

**Decision: Rust.** clang-cl is within 3% of Rust on bulk work (ahead on GF by 1–3%, behind on SHA by up to 4%). MSVC is 8–19% slower on GF. Rust is fastest on small messages (72 ns vs 99 ns), which content addressing of many small bodies depends on. Performance is a tie at worst, so memory safety decides: the shipped library is Rust, and the C++ is kept only as the benchmark reference (`--features cpp`).

### Things this measurement found

- **`node:crypto` hashes at about 320 MB/s on this machine**, roughly a quarter of what the ARMv8 SHA-256 instructions deliver. WebCrypto in Node is the same.
- **The RustCrypto `sha2` crate (0.10) does not use the SHA instructions on Windows ARM64**: 367 MB/s, the speed of portable code. Its CPU-feature detection does not report them on this target, which is why the crate has its own SHA-256 engine that checks with `is_aarch64_feature_detected!("sha2")`.
- **Fresh buffers cost page faults on Windows.** Writing parity straight into the stripe (an optional `out` argument to `gfMatmul`) instead of allocating it and copying it in took Reed-Solomon encode from 1.1 to 1.4 GB/s.

## Signature verification (15.16.0)

secp256k1 has no WebCrypto implementation, so every wallet signature, KeyZ declaration and revocation was checked in pure JavaScript (@noble/secp256k1) at about 3.6 ms each. `secp256k1VerifyMany` and `ed25519VerifyMany` verify batches on the loaded kernels, and the SDK uses them automatically:

- `verifySignature` (wallet sessions, KeyZ) on native kernels, or WASM ones carrying the signature module;
- hello signatures on native kernels (browsers keep WebCrypto Ed25519).

The answers are identical by test: the same valid, tampered and high-S cases on every backend. The SDK's wallet signatures are ECDSA over SHA-256(SHA-256(message)), low-S, and the high-S twin is refused everywhere.

| 256 signatures, in Node | @noble (before) | WASM | native, one core | native, all cores |
|---|---:|---:|---:|---:|
| secp256k1 verify | 272/s | 2,642/s (9.7×; 1.8× in browsers, see below) | 13,563/s (50×) | 70,378/s (258×) |

| 256 signatures, in Node | WebCrypto (before) | WASM | native, one core | native, all cores |
|---|---:|---:|---:|---:|
| Ed25519 verify | 6,535/s | 9,485/s (1.5×) | 17,019/s (2.6×) | 82,514/s (12.6×) |

**Rust against C:** `k256` took 72 µs per signature and libsecp256k1 (the C library behind Bitcoin) 67 µs. That is 7% apart, so Rust ships (`--features c-secp256k1` keeps the comparison runnable). Ed25519 uses `ed25519-dalek`'s `verify_strict`, which refuses non-canonical encodings and small-order keys. OpenSSL via WebCrypto is the C baseline in the table above.

**Two WASM modules (15.17.0).** Signature verification lives in its own module, `cappz_native_sig.wasm` (199 KB). `cappz_native.wasm` (37.5 KB) holds the GF kernel and SHA-256, so a page that only hashes or erasure-codes does not download the signature code. Without the signature module, verification uses the TypeScript code. Add the module with `loadWasmKernels(core, { signatures })` or `withWasmSignatures(kernels, bytes)`; each module is checked against its own pinned hash. In a browser it buys secp256k1 verification about 1.8× over @noble; natively the gain is 50×. WASM builds use getrandom's `unsupported` backend: nothing here needs randomness, and the modules import nothing from JavaScript.

The WASM manifest is a TypeScript module, `cappz-native.manifest.ts`. Deno refuses JSON imports without an import attribute, and the edge node reaches the kernels through `chunkedBodies`.

## Bulk AES (15.17.0)

`src/lib/crypto/aesCompat.ts` encrypts on WebCrypto, which uses hardware AES (the ARMv8 AES instructions on Snapdragon). It writes `cz1.` + base64(salt ‖ IV ‖ AES-256-GCM), with the key from PBKDF2-SHA-256 (100,000 rounds). It still opens everything `crypto-js` wrote in passphrase mode (`Salted__`, EVP_BytesToKey MD5, AES-256-CBC), also through WebCrypto. GCM authenticates, so a wrong key or a changed byte yields null.

Encrypting a 16 MiB file in Edge and Chrome took 3.2 s and stored 43 MB with `crypto-js` as cappz used it (hex text of the file, then AES). WebCrypto took 23 ms and stores 21 MB of base64. The module makes encryption fast and authenticated. It cannot make a key derived from public values private.

## Safety

- Every C ABI function checks its pointers and sizes and returns a status code; nothing panics across the boundary (`panic = "abort"` in release). The TypeScript wrapper checks shapes and output overlap before calling.
- The vendored WASM is checked against `src/lib/native/wasm/cappz-native.manifest.ts` (sha256; a TS module because Deno refuses JSON imports without an import attribute) before it is instantiated; tampered bytes are refused (tested). The build is reproducible: rebuilding gives the same hash.
- The native library is not committed. Build it from source; `loadKernels` reports why a backend was skipped.
- SHA-256 here hashes public content, so it is not constant-time. Do not use it for secrets (MACs, KDFs).
- The engines are checked against the FIPS 180-4 vectors, against `node:crypto` around every block boundary, and against each other for every length from 0 to 300 bytes.
- A streaming SHA-256 state lives in caller-owned bytes (112, tagged). A wrong tag, an impossible buffer length or a length that disagrees with the buffer is refused (`-3`), a finished state is wiped so it cannot be reused, and the paired update refuses one state given twice.

## Build

```sh
cd packages/cappz-native
cargo test --release                    # kernel tests (FIPS vectors, kernel agreement)
cargo build --release --lib             # target/release/cappz_native.dll | libcappz_native.so | .dylib
cd ../.. && packages/cappz-native/build-wasm.sh   # both wasm32 + SIMD128 modules, updates the manifest (run where cargo can link build.rs, e.g. an MSVC prompt on Windows)
```

On Windows ARM64 you need the Visual Studio 2022 Build Tools with the ARM64 C++ tools and a Windows SDK. If `vcvarsall.bat arm64` reports errors from its `msbuild`/`cmake` extensions, MSYS or Git tools are on `PATH` ahead of Windows' own `find`. Either run from a plain Developer prompt, or set `PATH`, `INCLUDE` and `LIB` to the `Hostarm64\arm64` compiler and the SDK's `arm64` libraries directly.

## Not yet

- **The Bun loader is written but untested.** Bun's binary does not start on this Windows build (22H2). Deno 2.9 (native ARM64) is tested: the FFI loader, Reed-Solomon, streaming SHA-256, batch Ed25519 verification and `chunkedBodies` all run on the native library. `node:ffi` (experimental in Node 26) is tested too. Node 22, which the SDK's tests target, has no FFI and uses WASM or TypeScript.
- **Shared-memory WASM threads** (nightly Rust plus cross-origin isolation) to remove the pool's copies; see the browser section.
