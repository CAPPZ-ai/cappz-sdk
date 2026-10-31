#!/usr/bin/env bash
# Rebuild the vendored cappz-native WebAssembly (SIMD128) and record each
# module's sha256 in the provenance manifest (a TS module) that the loader
# checks before instantiating. Two modules, so a page that only hashes or
# erasure-codes does not download the signature code:
#   cappz_native.wasm      GF(2^8) Reed-Solomon kernel + SHA-256   (feature core)
#   cappz_native_sig.wasm  secp256k1 / Ed25519 batch verification (feature sig)
# Usage: packages/cappz-native/build-wasm.sh   (from the repository root)
set -euo pipefail
# getrandom (pulled in by the signature crates' dependencies) has no entropy
# source on bare wasm32; nothing here needs one, so it is built to refuse.
FLAGS='-C target-feature=+simd128 --cfg getrandom_backend="unsupported"'
CRATE="packages/cappz-native"
OUT="src/lib/native/wasm"
VERSION="$(grep -m1 '^version' "$CRATE/Cargo.toml" | cut -d'"' -f2)"
build() { # feature artifact — fails the script if cargo fails, so no stale module is copied
  RUSTFLAGS="$FLAGS" cargo build --manifest-path "$CRATE/Cargo.toml" --lib --profile wasm --target wasm32-unknown-unknown --locked --no-default-features --features "$1"
  cp "$CRATE/target/wasm32-unknown-unknown/wasm/cappz_native.wasm" "$OUT/$2"
}
build core cappz_native.wasm
CORE_SHA="$(sha256sum "$OUT/cappz_native.wasm" | cut -d' ' -f1)"
build sig cappz_native_sig.wasm
SIG_SHA="$(sha256sum "$OUT/cappz_native_sig.wasm" | cut -d' ' -f1)"
# A TypeScript module, not JSON: Deno refuses JSON imports without an import
# attribute, and the edge node loads this through chunkedBodies.
cat > "$OUT/cappz-native.manifest.ts" <<TS
/** Provenance of the cappz-native WebAssembly modules, written by packages/cappz-native/build-wasm.sh. Do not edit. */
const build = (feature: string) => \`packages/cappz-native/build-wasm.sh (RUSTFLAGS: -C target-feature=+simd128 --cfg getrandom_backend="unsupported"; cargo build --lib --profile wasm --target wasm32-unknown-unknown --locked --no-default-features --features \${feature})\`;

/** GF(2^8) Reed-Solomon kernel and SHA-256. */
export const CAPPZ_NATIVE_WASM_MANIFEST_DATA = {
  artifact: 'cappz_native.wasm',
  crate: 'cappz-native',
  version: '$VERSION',
  target: 'wasm32-unknown-unknown +simd128 (feature core)',
  sha256: '$CORE_SHA',
  build: build('core'),
} as const;

/** secp256k1 / Ed25519 batch verification. */
export const CAPPZ_NATIVE_SIG_WASM_MANIFEST_DATA = {
  artifact: 'cappz_native_sig.wasm',
  crate: 'cappz-native',
  version: '$VERSION',
  target: 'wasm32-unknown-unknown +simd128 (feature sig)',
  sha256: '$SIG_SHA',
  build: build('sig'),
} as const;
TS
echo "cappz-native wasm $VERSION core $CORE_SHA sig $SIG_SHA"
