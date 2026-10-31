#!/usr/bin/env bash
# Rebuild the vendored cappz-native WebAssembly (SIMD128) and record its sha256
# in the provenance manifest (a TS module) that loadWasmKernels checks before instantiating.
# Usage: packages/cappz-native/build-wasm.sh   (from the repository root)
set -euo pipefail
# getrandom (pulled in by the signature crates' dependencies) has no entropy
# source on bare wasm32; nothing here needs one, so it is built to refuse.
FLAGS='-C target-feature=+simd128 --cfg getrandom_backend="unsupported"'
CRATE="packages/cappz-native"
OUT="src/lib/native/wasm"
RUSTFLAGS="$FLAGS" cargo build --manifest-path "$CRATE/Cargo.toml" --lib --profile wasm --target wasm32-unknown-unknown --locked
cp "$CRATE/target/wasm32-unknown-unknown/wasm/cappz_native.wasm" "$OUT/cappz_native.wasm"
VERSION="$(grep -m1 '^version' "$CRATE/Cargo.toml" | cut -d'"' -f2)"
SHA="$(sha256sum "$OUT/cappz_native.wasm" | cut -d' ' -f1)"
# A TypeScript module, not JSON: Deno refuses JSON imports without an import
# attribute, and the edge node loads this through chunkedBodies.
cat > "$OUT/cappz-native.manifest.ts" <<TS
/** Provenance of cappz_native.wasm, written by packages/cappz-native/build-wasm.sh. Do not edit. */
export const CAPPZ_NATIVE_WASM_MANIFEST_DATA = {
  artifact: 'cappz_native.wasm',
  crate: 'cappz-native',
  version: '$VERSION',
  target: 'wasm32-unknown-unknown +simd128',
  sha256: '$SHA',
  build: 'packages/cappz-native/build-wasm.sh (RUSTFLAGS: -C target-feature=+simd128 --cfg getrandom_backend="unsupported"; cargo build --lib --profile wasm --target wasm32-unknown-unknown --locked)',
} as const;
TS
echo "cappz-native wasm $VERSION sha256 $SHA"
