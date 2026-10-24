#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# Install the matching CLI once: cargo install wasm-bindgen-cli --version 0.2.129 --locked
if [[ "$(wasm-bindgen --version)" != "wasm-bindgen 0.2.129" ]]; then
  printf '%s\n' 'Expected wasm-bindgen 0.2.129' >&2
  exit 1
fi
cargo build --locked --release --target wasm32-unknown-unknown
mkdir -p dist/pkg
wasm-bindgen --target web --out-name game --out-dir dist/pkg \
  target/wasm32-unknown-unknown/release/game.wasm
cp index.html runtime.js dist/
