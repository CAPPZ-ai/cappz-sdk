/** Provenance of cappz_native.wasm, written by packages/cappz-native/build-wasm.sh. Do not edit. */
export const CAPPZ_NATIVE_WASM_MANIFEST_DATA = {
  artifact: 'cappz_native.wasm',
  crate: 'cappz-native',
  version: '0.3.0',
  target: 'wasm32-unknown-unknown +simd128',
  sha256: '6f735b8dcbd07dd550283aa0604401e8215874c066c296119bcdecbda2b4133a',
  build: 'packages/cappz-native/build-wasm.sh (RUSTFLAGS: -C target-feature=+simd128 --cfg getrandom_backend="unsupported"; cargo build --lib --profile wasm --target wasm32-unknown-unknown --locked)',
} as const;
