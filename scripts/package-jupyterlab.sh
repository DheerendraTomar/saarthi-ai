#!/usr/bin/env bash
# Builds a self-contained LocalPilot JupyterLab wheel for this machine's platform:
#   release core → jupyterlab/localpilot_jupyter/bin/<triple>/ + sandbox profile → chat UI
#   → production labextension → dist/localpilot_jupyter-<version>-py3-none-any.whl
# Usage: bash scripts/package-jupyterlab.sh   (run `npm ci` once first on a clean checkout)
#        SKIP_CORE_BUILD=1 bash scripts/package-jupyterlab.sh
#          # reuse dist/core/<triple>/localpilot-core instead of running build-core.sh
# Needs Rust, Node 20+, JupyterLab 4.5 in the current Python env (provides jlpm),
# and `uv` or `python -m build`.
# Prints the wheel path on the last line.
#
# The wheel is tagged py3-none-any but bundles only this machine's core binary,
# so in v1 it is effectively macOS arm64 only (aarch64-apple-darwin). On another
# platform, set $LOCALPILOT_CORE_BINARY or c.LocalPilot.core_binary.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"

# 0. Preflight: jlpm and `jupyter labextension build` come from JupyterLab.
command -v jlpm >/dev/null || { echo "package-jupyterlab: jlpm not found: install JupyterLab 4.5 in this Python env first (pip install \"jupyterlab>=4.5,<5\")" >&2; exit 1; }

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
      *) echo "package-jupyterlab: unknown host; set TARGET" >&2; exit 1 ;;
    esac
  fi
  core="$repo/dist/core/$triple/localpilot-core"
  if [ ! -x "$core" ]; then
    echo "package-jupyterlab: SKIP_CORE_BUILD=1 but $core is missing; run scripts/build-core.sh" >&2
    exit 1
  fi
else
  core="$(bash scripts/build-core.sh | tail -n 1)"
  triple="$(basename "$(dirname "$core")")"
fi
bin_dir="jupyterlab/localpilot_jupyter/bin/$triple"
rm -rf jupyterlab/localpilot_jupyter/bin
mkdir -p "$bin_dir"
cp "$core" "$bin_dir/"
chmod +x "$bin_dir/$(basename "$core")"

# Sandbox profile: package data, so the server has a real file path for it.
rm -rf jupyterlab/localpilot_jupyter/sandbox
mkdir -p jupyterlab/localpilot_jupyter/sandbox
cp sandbox/no-network.sb jupyterlab/localpilot_jupyter/sandbox/no-network.sb

# 2. Chat UI single-file bundle (embedded into the labextension by embed-chat-ui.js).
npm run build -w chat-ui

# 3. Production labextension → jupyterlab/localpilot_jupyter/labextension
#    (the wheel's hatch-jupyter-builder hook then skips its own build).
(cd jupyterlab && jlpm install --immutable && jlpm build:prod)

# 4. Wheel.
version="$(sed -n 's/^version = "\(.*\)"$/\1/p' jupyterlab/pyproject.toml | head -n 1)"
wheel="$repo/dist/localpilot_jupyter-$version-py3-none-any.whl"
mkdir -p dist
rm -f "$wheel"
if command -v uv >/dev/null 2>&1; then
  uv build --wheel --out-dir "$repo/dist" jupyterlab
else
  python3 -m build --wheel --outdir "$repo/dist" jupyterlab
fi

# 5. The wheel must contain the labextension, the server-extension config, the sandbox profile and the core (executable).
python3 - "$wheel" "$triple" <<'PY'
import stat, sys, zipfile
wheel, triple = sys.argv[1], sys.argv[2]
data = f"localpilot_jupyter-{wheel.rsplit('/', 1)[1].split('-')[1]}.data/data"
with zipfile.ZipFile(wheel) as z:
    infos = {i.filename: i for i in z.infolist()}
required = [
    f"{data}/share/jupyter/labextensions/localpilot-jupyter/package.json",
    f"{data}/share/jupyter/labextensions/localpilot-jupyter/install.json",
    f"{data}/etc/jupyter/jupyter_server_config.d/localpilot_jupyter.json",
    f"localpilot_jupyter/bin/{triple}/localpilot-core",
    "localpilot_jupyter/sandbox/no-network.sb",
]
missing = [f for f in required if f not in infos]
if not any(f.startswith(f"{data}/share/jupyter/labextensions/localpilot-jupyter/static/remoteEntry.") for f in infos):
    missing.append(f"{data}/share/jupyter/labextensions/localpilot-jupyter/static/remoteEntry.*.js")
if missing:
    sys.exit(f"package-jupyterlab: missing from {wheel}: {', '.join(missing)}")
core = infos[f"localpilot_jupyter/bin/{triple}/localpilot-core"]
if not (core.external_attr >> 16) & stat.S_IXUSR:
    sys.exit(f"package-jupyterlab: localpilot-core in {wheel} is not executable")
PY
echo "$wheel"
