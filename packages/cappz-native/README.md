# cappz-native

Rust kernels for the SDK: GF(2^8) matrix × shards (Reed-Solomon) and SHA-256, with NEON / ARMv8 SHA-256 paths, a WASM SIMD128 path and portable fallbacks, exposed as one C ABI (`src/lib.rs`).

- TypeScript wrapper and backend selection: `src/lib/native/cappzNative.ts`
- Reed-Solomon codec on top: `src/lib/erasure/reedSolomon.ts`
- Design, measurements, the Rust vs C++ decision and build steps: [docs/NATIVE_KERNELS.md](../../docs/NATIVE_KERNELS.md)

```sh
cargo test --release
cargo build --release --lib
cargo run --release --bin bench --features cpp,sha2-crate   # Rust vs C++ (cpp/) vs RustCrypto sha2
```
