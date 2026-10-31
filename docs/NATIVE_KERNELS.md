# Native kernels: Reed-Solomon and SHA-256 on ARM

`packages/cappz-native` (15.14.0; streaming SHA-256 in 15.15.0) is a small Rust crate with the SDK's two compute hot spots:

- **SHA-256** — every content address, chunk id, model-weight shard and notarization leaf in the SDK is one. One-shot, per-chunk on all cores, and streamed for input that arrives in pieces.
- **GF(2^8) matrix × shards** — the one kernel Reed-Solomon erasure coding needs.

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

The `wasm` backend runs Reed-Solomon 1.5–2× faster than TypeScript (126 vs 71 MB/s encode, 156 vs 83 MB/s rebuild). Its SHA-256 (about 205 MB/s) is portable code, because WebAssembly has no SHA instructions, and it dominates the shard hashing. These WASM figures were measured in Node's V8, not yet in a browser.

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

## Safety

- Every C ABI function checks its pointers and sizes and returns a status code; nothing panics across the boundary (`panic = "abort"` in release). The TypeScript wrapper checks shapes and output overlap before calling.
- The vendored WASM is checked against `src/lib/native/wasm/cappz-native.manifest.json` (sha256) before it is instantiated; tampered bytes are refused (tested). The build is reproducible: rebuilding gives the same hash.
- The native library is not committed. Build it from source; `loadKernels` reports why a backend was skipped.
- SHA-256 here hashes public content, so it is not constant-time. Do not use it for secrets (MACs, KDFs).
- The engines are checked against the FIPS 180-4 vectors, against `node:crypto` around every block boundary, and against each other for every length from 0 to 300 bytes.
- A streaming SHA-256 state lives in caller-owned bytes (112, tagged). A wrong tag, an impossible buffer length or a length that disagrees with the buffer is refused (`-3`), a finished state is wiped so it cannot be reused, and the paired update refuses one state given twice.

## Build

```sh
cd packages/cappz-native
cargo test --release                    # kernel tests (FIPS vectors, kernel agreement)
cargo build --release --lib             # target/release/cappz_native.dll | libcappz_native.so | .dylib
cd ../.. && packages/cappz-native/build-wasm.sh   # wasm32 + SIMD128, updates the manifest
```

On Windows ARM64 you need the Visual Studio 2022 Build Tools with the ARM64 C++ tools and a Windows SDK. If `vcvarsall.bat arm64` reports errors from its `msbuild`/`cmake` extensions, MSYS or Git tools are on `PATH` ahead of Windows' own `find`. Either run from a plain Developer prompt, or set `PATH`, `INCLUDE` and `LIB` to the `Hostarm64\arm64` compiler and the SDK's `arm64` libraries directly.

## Not yet

- **Deno and Bun loaders are written but untested**; neither runtime was installed on the benchmark machine. `node:ffi` (experimental in Node 26) is tested. Node 22, which the SDK's tests target, has no FFI and uses WASM or TypeScript.
- **Browser numbers.** The WASM build has not yet been measured in Edge or Chrome on ARM.
- **A threaded WASM build** (shared memory and workers) would bring multi-core shard math to browsers.
