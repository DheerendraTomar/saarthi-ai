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
