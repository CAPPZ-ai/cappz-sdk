#!/usr/bin/env bash
# Rebuild the vendored cappz-native WebAssembly (SIMD128) and record its sha256
# in the provenance manifest that loadWasmKernels checks before instantiating.
# Usage: packages/cappz-native/build-wasm.sh   (from the repository root)
set -euo pipefail
CRATE="packages/cappz-native"
OUT="src/lib/native/wasm"
RUSTFLAGS='-C target-feature=+simd128' cargo build --manifest-path "$CRATE/Cargo.toml" --lib --profile wasm --target wasm32-unknown-unknown --locked
cp "$CRATE/target/wasm32-unknown-unknown/wasm/cappz_native.wasm" "$OUT/cappz_native.wasm"
VERSION="$(grep -m1 '^version' "$CRATE/Cargo.toml" | cut -d'"' -f2)"
SHA="$(sha256sum "$OUT/cappz_native.wasm" | cut -d' ' -f1)"
cat > "$OUT/cappz-native.manifest.json" <<JSON
{
  "artifact": "cappz_native.wasm",
  "crate": "cappz-native",
  "version": "$VERSION",
  "target": "wasm32-unknown-unknown +simd128",
  "sha256": "$SHA",
  "build": "RUSTFLAGS='-C target-feature=+simd128' cargo build --manifest-path packages/cappz-native/Cargo.toml --lib --profile wasm --target wasm32-unknown-unknown --locked"
}
JSON
echo "cappz-native wasm $VERSION sha256 $SHA"
