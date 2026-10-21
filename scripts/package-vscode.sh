#!/usr/bin/env bash
# Builds a self-contained LocalPilot .vsix for this machine's platform:
#   release core → vscode/bin/<triple>/ → chat UI → vscode/media/chat.html
#   → minified extension → dist/localpilot-<version>.vsix
# Usage: bash scripts/package-vscode.sh   (run `npm ci` once first on a clean checkout)
# Prints the .vsix path on the last line.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"

# 1. Release core binary (build-core.sh prints the path it wrote on its last line).
core="$(bash scripts/build-core.sh | tail -n 1)"
triple="$(basename "$(dirname "$core")")"
bin_dir="vscode/bin/$triple"
rm -rf vscode/bin
mkdir -p "$bin_dir"
cp "$core" "$bin_dir/"
chmod +x "$bin_dir/$(basename "$core")"

# 2. Chat UI → the single-file page the chat webview loads.
npm run build -w chat-ui
mkdir -p vscode/media
cp chat-ui/dist/index.html vscode/media/chat.html

# 3. Extension bundle, minified, without source maps (the UI was built above).
npm run build -w vscode -- --production --skip-ui
rm -f vscode/out/*.map

# 4. Package. node_modules are not shipped: esbuild already bundled every dependency.
version="$(node -p 'require("./vscode/package.json").version')"
vsix="$repo/dist/localpilot-$version.vsix"
mkdir -p dist
(cd vscode && npx --no-install vsce package --no-dependencies --allow-missing-repository -o "$vsix")

# 5. The package must contain the core and the chat page.
listing="$(unzip -l "$vsix")"
for f in "extension/bin/$triple/$(basename "$core")" extension/media/chat.html extension/out/extension.js; do
  if ! grep -q " $f\$" <<<"$listing"; then
    echo "package-vscode: $f is missing from $vsix" >&2
    exit 1
  fi
done
echo "$vsix"
