# LocalPilot

A Copilot-style coding assistant that runs entirely on your machine: inline
(ghost text) completions and an agent chat that can edit files and run commands
with your approval, backed by a local [Ollama](https://ollama.com). Nothing
leaves your machine.

Since v2 (VS Code 0.2.0): pick the chat and completion models from those
installed in Ollama, delete chat sessions, edit completion settings in the chat
view, and **adaptive completions** — the core learns per language from what you
accept or reject (logged locally in `.localpilot/completions.jsonl`) and tunes
suggestion length and style examples. JupyterLab ships the v2 core and chat UI
but wires these controls in its next update.

| Part | What it is |
| --- | --- |
| [`core/`](core/README.md) | `localpilot-core`, the Rust sidecar: document overlay, workspace index, completion engine, agent chat. Speaks JSON-RPC over stdio. |
| [`vscode/`](vscode/README.md) | The VS Code extension (bundles the core). |
| [`jupyterlab/`](jupyterlab/README.md) | The JupyterLab 4.5 extension, `localpilot-jupyter`: a server extension that runs the core and a labextension (bundles the core). |
| [`jetbrains/`](jetbrains/README.md) | The JetBrains plugin for PyCharm 2026.2 (build 262+): ghost text in files and notebook cells, chat tool window (bundles the core). |
| `chat-ui/` | The chat webview, shared by IDE clients. |
| `rpc-client/` | TypeScript JSON-RPC client for the core. |

Design: [`docs/superpowers/specs/2026-10-20-localpilot-design.md`](docs/superpowers/specs/2026-10-20-localpilot-design.md).

## Quick start (VS Code, macOS arm64)

```sh
ollama serve &                           # or launch the Ollama app
ollama pull qwen2.5-coder:0.5b-base      # completions
ollama pull qwen3.8:27b-mlx              # chat
npm ci
bash scripts/package-vscode.sh           # → dist/localpilot-0.2.2.vsix
code --install-extension dist/localpilot-0.2.2.vsix --force
```

Open a folder in VS Code: ghost text appears as you type, and `Cmd+Shift+L`
opens the chat. Settings, the manual smoke checklist and troubleshooting are in
[`vscode/README.md`](vscode/README.md).

## Quick start (JupyterLab, macOS arm64)

```sh
pip install "jupyterlab>=4.5,<5"         # JupyterLab 4.5 in this Python env (provides jlpm)
npm ci
bash scripts/package-jupyterlab.sh       # → dist/localpilot_jupyter-0.1.1-py3-none-any.whl
pip install --no-deps --force-reinstall dist/localpilot_jupyter-0.1.1-py3-none-any.whl
jupyter lab
```

With Ollama running and the models pulled (above), ghost text appears in notebook
cells and files, and `Alt Shift L` opens the chat. Settings, the manual smoke
checklist and troubleshooting are in [`jupyterlab/README.md`](jupyterlab/README.md).

## Quick start (PyCharm 2026.2, macOS arm64)

Needs a JDK 25 (e.g. Temurin 25), Node.js 20+, and Rust to build the core (or
`SKIP_CORE_BUILD=1` to reuse an existing `dist/core/<triple>/localpilot-core`).

```sh
npm ci
bash scripts/package-jetbrains.sh        # → dist/localpilot-jetbrains-0.1.0.zip
```

In PyCharm: **Settings → Plugins → ⚙ → Install Plugin from Disk…** →
`dist/localpilot-jetbrains-0.1.0.zip` (it loads without a restart; if an open
project looks inert, reopen it). With Ollama running and the
models pulled (above), ghost text appears in files and notebook cells, and
`Cmd+Shift+L` opens the chat tool window. Settings, the manual smoke checklist and
known limitations are in [`jetbrains/README.md`](jetbrains/README.md).
