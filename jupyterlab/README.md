# LocalPilot for JupyterLab

Copilot-style inline completions and an agent chat in JupyterLab 4.5, running
entirely on your machine via Ollama. One package, `localpilot-jupyter`, holds both
halves:

- a **Jupyter server extension** that runs one `localpilot-core` per Jupyter server
  (workspace = the server's `root_dir`) and bridges it to every browser tab over
  `WS /localpilot/rpc`;
- a **JupyterLab extension**: ghost-text completions in notebook cells and files, a
  chat sidebar (the same chat UI as VS Code), commands and a status-bar item.

## Install

LocalPilot is not on PyPI; build the wheel from this repo and install it into the
Python environment that runs JupyterLab (JupyterLab 4.5, jupyter_server 2.x).
Requires Rust (stable), Node 20+ and npm, `uv` (or `pip install build`), and
JupyterLab 4.5 installed in the current Python env (it provides `jlpm`, which the
script needs).

```sh
pip install "jupyterlab>=4.5,<5"           # provides jlpm
npm ci                                     # once, from the repo root
bash scripts/package-jupyterlab.sh         # → dist/localpilot_jupyter-0.1.0-py3-none-any.whl
pip install --force-reinstall dist/localpilot_jupyter-0.1.0-py3-none-any.whl
jupyter server extension list              # → localpilot_jupyter enabled, OK
jupyter labextension list                  # → localpilot-jupyter v0.1.0 enabled OK
```

`SKIP_CORE_BUILD=1 bash scripts/package-jupyterlab.sh` skips `cargo build` and
bundles the existing `dist/core/<triple>/localpilot-core` (from
`scripts/build-core.sh`).

**Platform:** the wheel is tagged `py3-none-any`, but it bundles only the core built
on this machine (`localpilot_jupyter/bin/aarch64-apple-darwin/localpilot-core` on
Apple Silicon). In v1 it is effectively **macOS arm64 only**. Elsewhere, build the
core yourself and point the server at it (see Settings).

If you used a development install (`pip install -e .` plus
`jupyter labextension develop`), remove it first: `pip uninstall localpilot-jupyter`
and delete the `share/jupyter/labextensions/localpilot-jupyter` symlink that
`develop` left behind (`jupyter labextension list` shows its path).

Restart `jupyter lab` after installing. The wheel enables the server extension
itself (`etc/jupyter/jupyter_server_config.d/localpilot_jupyter.json`).

## Start Ollama

LocalPilot talks only to a local [Ollama](https://ollama.com) (`ollamaUrl`, default
`http://localhost:11434`, as seen from the **Jupyter server**).

```sh
ollama serve                               # or launch the Ollama app
ollama pull qwen2.5-coder:0.5b-base        # inline completions (default)
ollama pull qwen3.8:27b-mlx                # agent chat (default)
```

From JupyterLab, **Start Ollama (in a terminal)** (command palette, category
LocalPilot, or the chat view's **Start Ollama** button) opens a JupyterLab terminal
and types `ollama serve` into it, so Ollama runs on the Jupyter server's machine
and stops when you close that terminal. **Pull Model with Ollama…** pulls the
completion or chat model with progress in the status bar.

## Keyboard shortcut

`Alt Shift L` (`Option Shift L` on macOS) opens the LocalPilot chat. It is not
`Accel Shift L` (`Cmd Shift L`) as in VS Code, because JupyterLab already uses that
chord for **New Launcher**. Rebind it under **Settings → Settings Editor →
Keyboard Shortcuts** (command `localpilot:open-chat`). JupyterLab shortcuts do not
fire while focus is inside the chat frame; click outside it first.

Inline completions use JupyterLab's inline completer: `Tab` accepts, `Alt ]` /
`Alt [` cycle, `Alt \` asks for one now. The provider is listed as **LocalPilot**
under **Settings → Inline Completer**.

## Settings

**Settings → Settings Editor → LocalPilot.** Same keys and defaults as the VS Code
extension's `localpilot.*` settings, without the prefix:

| Setting | Default | Notes |
| --- | --- | --- |
| `ollamaUrl` | `http://localhost:11434` | Base URL of Ollama, as seen from the Jupyter server. |
| `completionModel` | `qwen2.5-coder:0.5b-base` | FIM model for inline completions; `qwen2.5-coder:1.5b-base` is the higher-quality alternative. |
| `chatModel` | `qwen3.8:27b-mlx` | Tool-calling model for agent chat. |
| `completionsEnabled` | `true` | Show ghost-text completions. **Client-side**: no core restart. Also toggled by **Pause/Resume Inline Completions**. |
| `completionDebounceMs` | `120` | Delay after the last keystroke. **Client-side**; becomes the provider's `debouncerDelay` default in the Inline Completer settings, applied on reload. |
| `completionMaxTokens` | `32` | Max tokens generated per inline completion. |
| `completionContextTokens` | `3584` | Prompt budget for completions. |
| `chatThinking` | `off` | `on` lets the chat model think before answering (slower). |
| `chatContextTokens` | `24000` | Chat history budget before older turns are dropped. |
| `allowedCommandsAlways` | `[]` | Commands approved with **Always**; the agent runs these without asking. |
| `coreBinaryPath` | `""` | **Ignored in JupyterLab** (kept for parity). Server-side instead: see below. |
| `logLevel` | `info` | **Ignored in JupyterLab** (kept for parity). Server-side instead: see below. |

The core reads its settings only when it starts, so changing any setting except
`completionsEnabled` and `completionDebounceMs` restarts it (once, 0.5 s after the
last edit). The core is shared by every tab of the Jupyter server, and a restart
ends a chat reply that is still streaming.

**Server-side settings** (the browser never chooses which binary the server runs):

| What | How |
| --- | --- |
| Core binary | `$LOCALPILOT_CORE_BINARY`, else `c.LocalPilot.core_binary` in `jupyter_server_config.py`, else the bundled `localpilot_jupyter/bin/<triple>/localpilot-core`. |
| Core log level | `c.LocalPilot.core_log_level = "debug"` (`error` … `trace`, default `info`). |

## Manual smoke checklist

Walk this after installing a new build (`jupyter lab` restarted, models pulled):

1. **Ollama down banner** — quit Ollama (`pkill ollama` / quit the app), run
   **Restart LocalPilot Core** from the palette: the chat view shows **Ollama down**
   and the status bar shows `Ollama down`.
2. **Start Ollama** — click **Start Ollama** in the chat view (or run **Start Ollama
   (in a terminal)**): a JupyterLab terminal opens running `ollama serve`, and the
   banner clears.
3. **Pull model** — set `completionModel` to a model you don't have (e.g.
   `qwen2.5-coder:1.5b-base` after `ollama rm` of it): the chat view shows **Model
   missing**; click **Pull model** and watch `Pulling N%` in the status bar finish.
4. **Ghost text in a notebook** — open an `.ipynb` with a Python kernel, type
   `def fibonacci(n):` and a newline in a code cell: grey ghost text appears;
   `Tab` accepts it.
5. **Ghost text in a file** — same in a `.py` file opened in the file editor.
6. **Chat edit of a cell, approved** — open the chat (`Alt Shift L`), put the cursor
   in a code cell and ask for a change to that cell: the diff card shows the cell
   (`….ipynb.cell<N>.py`); click **Approve**: the cell changes in place and the
   notebook is saved (no unsaved-changes dot on its tab).
7. **Run command, denied** — ask the chat to run `ls`: a command card appears; click
   **Deny**: nothing runs, and the agent says it was denied.
8. **Theme** — switch **Settings → Theme** between JupyterLab Light and Dark: the
   chat panel follows without a reload.

## Troubleshooting

- **Logs**: the core logs to `<root_dir>/.localpilot/core.log` (`root_dir` is the
  directory `jupyter lab` serves; set `c.LocalPilot.core_log_level = "debug"` for
  more). The server extension logs to the `jupyter lab` console under
  `LocalPilotApp`.
- **Status**: `GET /localpilot/status` (e.g.
  `curl -H "Authorization: token $TOKEN" http://localhost:8888/localpilot/status`)
  returns `{"core": "stopped"|"starting"|"ready"|"crashed", "ollama": {...}, "rootDir": ...}`.
  The core starts on the first tab's connection; `stopped` before that is normal.
- **"LocalPilot core restarted" / chat reconnects**: when the core restarts (a
  setting changed, **Restart LocalPilot Core**, or a crash) the server closes every
  tab's socket with code **1012**. Tabs reconnect with backoff, re-initialize and
  re-send their open documents; a streaming chat reply ends with an error, but the
  session and its history stay.
- **Core crashed**: after 3 automatic restarts within a minute the server stops restarting it
  (`"core": "crashed"`). Fix the cause (see the log), then **Restart LocalPilot
  Core**.
- **"LocalPilot core binary not found"**: the wheel has no core for this platform.
  Build one (`bash scripts/build-core.sh`) and set `LOCALPILOT_CORE_BINARY` or
  `c.LocalPilot.core_binary`.
- **"Ollama down"**: Ollama isn't answering at `ollamaUrl` from the Jupyter server.
  Start it (above), then **Restart LocalPilot Core**. Check
  `curl http://localhost:11434/api/tags` on the server machine.
- **"Model missing" / no ghost text**: pull the configured model and check
  `ollama list`. Completions also pause while `completionsEnabled` is off and while
  a chat reply is generating; check that **LocalPilot** is enabled under
  **Settings → Inline Completer**.
- **403 on `/localpilot/rpc`**: LocalPilot needs the same permission as terminals
  (`execute` on `terminals`), because the agent can run commands.

## Development

```sh
cd jupyterlab
pip install -e ".[test]"                   # builds the labextension (jlpm build)
jupyter labextension develop . --overwrite
jlpm lint && jlpm test                     # TypeScript: tsc + eslint, jest
python -m pytest                           # server extension + bridge (uses vscode/test/fakeCore.mjs)
jlpm watch                                 # rebuild on change; reload JupyterLab
```

`npm run build -w chat-ui` (repo root) must run before `jlpm build`; the chat UI is
embedded into the labextension by `scripts/embed-chat-ui.js`.
