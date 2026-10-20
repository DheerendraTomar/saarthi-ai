#!/usr/bin/env bash
# Builds localpilot-core in release mode for the host (or $TARGET) and copies
# the binary to dist/core/<target-triple>/localpilot-core[.exe].
# Usage: bash scripts/build-core.sh            # host triple
#        TARGET=x86_64-apple-darwin bash scripts/build-core.sh
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
host="$(rustc -vV | sed -n 's/^host: //p')"
target="${TARGET:-$host}"

exe=""
case "$target" in
  *windows*) exe=".exe" ;;
esac

cd "$repo/core"
if [ "$target" = "$host" ]; then
  cargo build --release --locked
  built="$repo/core/target/release/localpilot-core$exe"
else
  cargo build --release --locked --target "$target"
  built="$repo/core/target/$target/release/localpilot-core$exe"
fi

out="$repo/dist/core/$target"
mkdir -p "$out"
cp "$built" "$out/localpilot-core$exe"
echo "$out/localpilot-core$exe"
