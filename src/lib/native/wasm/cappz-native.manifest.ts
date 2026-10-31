/** Provenance of the cappz-native WebAssembly modules, written by packages/cappz-native/build-wasm.sh. Do not edit. */
const build = (feature: string) => `packages/cappz-native/build-wasm.sh (RUSTFLAGS: -C target-feature=+simd128 --cfg getrandom_backend="unsupported"; cargo build --lib --profile wasm --target wasm32-unknown-unknown --locked --no-default-features --features ${feature})`;

/** GF(2^8) Reed-Solomon kernel and SHA-256. */
export const CAPPZ_NATIVE_WASM_MANIFEST_DATA = {
  artifact: 'cappz_native.wasm',
  crate: 'cappz-native',
  version: '0.4.0',
  target: 'wasm32-unknown-unknown +simd128 (feature core)',
  sha256: '440335ccf32edd944daa631e4e6db77d3352b87307f149b10ad7d19b0f83f586',
  build: build('core'),
} as const;

/** secp256k1 / Ed25519 batch verification. */
export const CAPPZ_NATIVE_SIG_WASM_MANIFEST_DATA = {
  artifact: 'cappz_native_sig.wasm',
  crate: 'cappz-native',
  version: '0.4.0',
  target: 'wasm32-unknown-unknown +simd128 (feature sig)',
  sha256: '4d8a06ed604d7722797f017c2e2eccec66c1caf4aa80c19170c9cf62ae326555',
  build: build('sig'),
} as const;
