#!/usr/bin/env bash
# Build the NAPI addon for linux-x64 and stage it at native/aires-sdk-napi.node.
# Uses Docker so this works from any host. Intended to run at prepublishOnly
# time so the published tarball contains a Linux-ready binary.

set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
WORKSPACE_ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$HERE/native/aires-sdk-napi.node"

echo "[aires/sdk] building linux-x64 NAPI addon via docker..."

docker run --rm \
  --platform linux/amd64 \
  -v "$WORKSPACE_ROOT":/src \
  -w /src/packages/sdk-ts/native \
  -e CARGO_TARGET_DIR=/src/target-linux \
  rust:1.88-bookworm \
  bash -c "apt-get update -qq && apt-get install -y --no-install-recommends protobuf-compiler >/dev/null && \
           cargo build --release --target x86_64-unknown-linux-gnu 2>&1 | tail -10 && \
           cp /src/target-linux/x86_64-unknown-linux-gnu/release/libaires_sdk_napi.so \
              /src/packages/sdk-ts/native/aires-sdk-napi.node"

if [ ! -f "$OUT" ]; then
  echo "[aires/sdk] build failed — $OUT not produced" >&2
  exit 1
fi

echo "[aires/sdk] built → $OUT"
ls -la "$OUT"
