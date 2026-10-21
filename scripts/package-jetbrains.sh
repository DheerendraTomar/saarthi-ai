#!/usr/bin/env bash
# Builds a self-contained LocalPilot plugin zip for JetBrains IDEs (PyCharm 2026.2+, build 262+) on this machine:
#   release core → dist/core/<triple>/ (bundled by Gradle's prepareSandbox at lib/bin/<triple>/localpilot-core)
#   → chat UI → jetbrains/src/main/resources/chat/index.html → ./gradlew buildPlugin
#   → dist/localpilot-jetbrains-<version>.zip
# Usage: bash scripts/package-jetbrains.sh   (run `npm ci` once first on a clean checkout)
#        SKIP_CORE_BUILD=1 bash scripts/package-jetbrains.sh
#          # reuse dist/core/<triple>/localpilot-core instead of running build-core.sh
# Needs Rust (unless SKIP_CORE_BUILD=1), Node 20+, and JDK 25 (JAVA_HOME, or found by /usr/libexec/java_home).
# The version comes from jetbrains/gradle.properties (pluginVersion).
# Install: Settings → Plugins → ⚙ → Install Plugin from Disk… → the zip. Prints the zip path on the last line.
#
# The zip bundles only the core binaries in dist/core/ (normally just this machine's triple, so in v1 it is
# effectively macOS arm64 only). On another platform, set Settings → Tools → LocalPilot → Core binary path.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"

die() { echo "package-jetbrains: $*" >&2; exit 1; }

# 0. Preflight.
command -v node >/dev/null || die "node not found: install Node.js 20+ (e.g. nvm install 20)"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 20 ] || die "Node.js 20+ is needed, found $(node -v) (e.g. nvm use 20)"
[ -d node_modules ] || die "node_modules is missing: run npm ci in $repo first"

java_major() { "$1/bin/java" -XshowSettings:properties -version 2>&1 | sed -n 's/^ *java\.specification\.version = //p'; }
if [ -z "${JAVA_HOME:-}" ] || [ ! -x "$JAVA_HOME/bin/java" ] || [ "$(java_major "$JAVA_HOME")" != "25" ]; then
  jdk25="$(/usr/libexec/java_home -v 25 2>/dev/null || true)"
  [ -n "$jdk25" ] && [ "$(java_major "$jdk25")" = "25" ] \
    || die "JDK 25 is needed: set JAVA_HOME to a JDK 25 (e.g. Temurin 25); found ${JAVA_HOME:-no JAVA_HOME}"
  export JAVA_HOME="$jdk25"
fi

# 1. Release core binary (build-core.sh prints the path it wrote on its last line).
if [ "${SKIP_CORE_BUILD:-}" = "1" ]; then
  if [ -n "${TARGET:-}" ]; then
    triple="$TARGET"
  elif command -v rustc >/dev/null 2>&1; then
    triple="$(rustc -vV | sed -n 's/^host: //p')"
  else
    case "$(uname -s)/$(uname -m)" in
      Darwin/arm64) triple="aarch64-apple-darwin" ;;
      Darwin/x86_64) triple="x86_64-apple-darwin" ;;
      Linux/x86_64) triple="x86_64-unknown-linux-gnu" ;;
      *) die "unknown host; set TARGET" ;;
    esac
  fi
  core="$repo/dist/core/$triple/localpilot-core"
  [ -x "$core" ] || die "SKIP_CORE_BUILD=1 but $core is missing; run scripts/build-core.sh"
else
  command -v cargo >/dev/null || die "cargo not found: install Rust (https://rustup.rs) or set SKIP_CORE_BUILD=1"
  core="$(bash scripts/build-core.sh | tail -n 1)"
  triple="$(basename "$(dirname "$core")")"
fi
chmod +x "$core"

# 2. Chat UI → the single-file page the chat tool window loads (a jar resource; gitignored).
npm run build -w chat-ui
mkdir -p jetbrains/src/main/resources/chat
cp chat-ui/dist/index.html jetbrains/src/main/resources/chat/index.html

# 3. Plugin zip. prepareSandbox copies dist/core/<triple>/localpilot-core to lib/bin/<triple>/ (jetbrains/build.gradle.kts).
#    --rerun: never reuse a cached zip (the executable bit on the core is not part of the task's cache key).
(cd jetbrains && ./gradlew buildPlugin --rerun)

version="$(sed -n 's/^pluginVersion *= *//p' jetbrains/gradle.properties | head -n 1)"
built="jetbrains/build/distributions/localpilot-jetbrains-$version.zip"
[ -f "$built" ] || die "$built was not produced"
zip="$repo/dist/localpilot-jetbrains-$version.zip"
mkdir -p dist
cp "$built" "$zip"

# 4. The zip must contain the plugin jar (with the chat page) and an executable core.
listing="$(unzip -Z "$zip")"
jar="localpilot-jetbrains/lib/localpilot-jetbrains-$version.jar"
bin="localpilot-jetbrains/lib/bin/$triple/localpilot-core"
grep -q " $jar\$" <<<"$listing" || die "$jar is missing from $zip"
grep -q "^-rwx.* $bin\$" <<<"$listing" || die "$bin is missing from $zip or not executable"
check_jar="$(dirname "$built")/plugin.jar.check"
unzip -p "$zip" "$jar" > "$check_jar"
jar_listing="$(unzip -l "$check_jar")"
rm -f "$check_jar"
grep -q " chat/index.html\$" <<<"$jar_listing" || die "chat/index.html is missing from $jar"
echo "$zip"
