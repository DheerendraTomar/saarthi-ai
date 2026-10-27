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
Python environment that runs JupyterLab. The package requires **JupyterLab ≥ 4.5**
(< 5) and jupyter_server 2.x; it is built against the 4.5 APIs and does not load in
older JupyterLab.
Requires Rust (stable), Node 20+ and npm, `uv` (or `pip install build`), and
JupyterLab 4.5 installed in the current Python env (it provides `jlpm`, which the
script needs).

```sh
pip install "jupyterlab>=4.5,<5"           # provides jlpm
npm ci                                     # once, from the repo root
bash scripts/package-jupyterlab.sh         # → dist/localpilot_jupyter-0.3.0-py3-none-any.whl
pip install --no-deps --force-reinstall dist/localpilot_jupyter-0.3.0-py3-none-any.whl
jupyter server extension list              # → localpilot_jupyter enabled, OK
jupyter labextension list                  # → localpilot-jupyter v0.3.0 enabled OK
```

`--no-deps` keeps pip from reinstalling (or upgrading) JupyterLab and the rest of
the environment along with the wheel; they are already installed above.

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

LocalPilot talks only to an [Ollama](https://ollama.com) on this machine (`ollamaUrl`,
default `http://localhost:11434`, as seen from the **Jupyter server**; any host that
is not localhost, 127.0.0.0/8 or ::1 is refused). It never downloads models: pull
them yourself in a terminal.

```sh
ollama pull qwen2.5-coder:0.5b-base        # inline completions (default)
ollama pull qwen3.8:27b-mlx                # agent chat (default)
```

**Start Ollama (sandboxed, in a terminal)** (command palette, category LocalPilot, or
the chat view's **Start Ollama** button) asks the server for the start line, opens a
JupyterLab terminal and types it in. The server decides the line:

- macOS with `~/Library/LaunchAgents/local.ollama.sandboxed.plist`: restarts that
  LaunchAgent (`launchctl bootstrap gui/$(id -u) <plist> 2>/dev/null || launchctl
  kickstart gui/$(id -u)/local.ollama.sandboxed`).
- macOS otherwise: `OLLAMA_NO_CLOUD=1 OLLAMA_HOST=127.0.0.1:11434 exec
  /usr/bin/sandbox-exec -f <profile> ollama serve`, using the bundled no-network
  profile (`localpilot_jupyter/sandbox/no-network.sb`). It stops when you close the terminal.
- Not macOS: nothing starts. LocalPilot only starts Ollama inside a no-network
  sandbox; start Ollama yourself with `OLLAMA_NO_CLOUD=1`.

## Commands run without network access

Commands the agent runs (after you approve them) run on the Jupyter server as
`/usr/bin/sandbox-exec -f <profile> /bin/sh -c <command>` in a directory inside the
server root. The profile allows everything except network: only this machine
(loopback) is reachable and DNS is blocked, so `git push`, `pip install`, `curl` and
the like fail. A failing command gets the line `(LocalPilot runs commands without
network access)` appended to its stderr. If the sandbox is unavailable (not macOS,
or `sandbox-exec` or the profile is missing), the command is not run at all.

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
| `ollamaUrl` | `http://localhost:11434` | Base URL of the Ollama on this machine (localhost, 127.0.0.1 or ::1), as seen from the Jupyter server. Other hosts are refused. |
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
| `adaptiveCompletions` | `true` | Adapt completion length and style examples to your outcomes (see *Adaptive completions*). Off: the configured limits, no examples; outcomes are still logged. |

The core reads its settings only when it starts, so changing any setting except
`completionsEnabled` and `completionDebounceMs` restarts it (once, 0.5 s after the
last edit). The core is shared by every tab of the Jupyter server, and a restart
ends a chat reply that is still streaming.

The chat panel edits some of these too: its **model pickers** write `chatModel` /
`completionModel` (only models Ollama reports as installed), and its **Settings**
panel writes `completionMaxTokens` (≥ 1), `completionDebounceMs` (≥ 0),
`completionContextTokens` (≥ 256) and `adaptiveCompletions`, rounding and clamping
to those minimums. Both go through the settings registry like an edit in the
Settings Editor (so a core setting restarts the core). The palette has **Select
Chat Model…** and **Select Completion Model…** as well.

**Server-side settings** (the browser never chooses which binary the server runs):

| What | How |
| --- | --- |
| Core binary | `$LOCALPILOT_CORE_BINARY`, else `c.LocalPilot.core_binary` in `jupyter_server_config.py`, else the bundled `localpilot_jupyter/bin/<triple>/localpilot-core`. |
| Core log level | `c.LocalPilot.core_log_level = "debug"` (`error` … `trace`, default `info`). |

## Chat sessions

The chat panel's session switcher has **Delete** (per session) and **Clear all**.
The core refuses to delete a session whose reply is still running (the panel says
so); **Clear all** keeps such sessions and reports how many it kept. Sessions are
shared by every tab of the Jupyter server: deleting one in a tab removes it from
the other tabs' chat panels too, and a tab may delete a session another tab
started.

## Adaptive completions

LocalPilot learns from what you do with its suggestions — no model training, just
per-language bookkeeping in the core:

- Every shown suggestion's outcome is logged to `<root_dir>/.localpilot/completions.jsonl`
  (language, a prompt hash, at most 200 characters before the cursor, the
  suggestion, the outcome and timings). Outcomes reported by JupyterLab:
  - **accepted** — the whole suggestion was taken with `Tab` (the inline
    completer's accept);
  - **typedThrough** — you typed the whole suggestion yourself, key by key
    (auto-closed brackets and quotes are fine);
  - **partial** — part of it arrived in one multi-character edit and then the text
    went elsewhere (see the biases below); the taken text is logged;
  - **rejected** — it was dismissed or replaced by the next request untouched, you
    typed something else, or you typed only part of it by hand.

  A suggestion you are partway through is reported once nothing more of it
  arrives for 2 s; trailing whitespace does not count.
- **Known biases** (JupyterLab's inline completer has no accept hook and no
  *accept next word / line*; LocalPilot infers outcomes from the cell's or file's
  edits, like the VS Code extension):
  - any single edit inserting ≥ 2 characters (with a letter or digit) that matches
    the ghost text counts as a `Tab` accept — including a tab-completer (Jupyter
    `Tab` completion) accept or a paste that happens to match it. This is also the
    only way **partial** arises in JupyterLab;
  - a one-character suggestion accepted with `Tab` is logged as **typedThrough**;
  - taking part of a suggestion and pressing `Tab` more than 2 s later is logged as
    **rejected** (or **partial**), not accepted.
- **Stats**: **Show Completion Stats** (palette) or the chat panel's Settings shows
  per-language counts, the accept rate and whether the length limits were
  *learned* (from ≥ 10 outcomes, with adaptive completions on) or are the
  configured *default*.
- **To reset**: **Reset Completion Learning…** (palette; asks first) or **Reset
  learning**, then **Confirm**, in the chat panel's Settings forgets the learned
  values and examples; the log file is kept. To stop adapting without resetting,
  set `adaptiveCompletions` to `false`. To delete the history entirely, delete
  `.localpilot/completions.jsonl` too.

## Manual smoke checklist

Walk this after installing a new build (`jupyter lab` restarted, models pulled):

1. **Ollama down banner** — quit Ollama (`pkill ollama` / quit the app), run
   **Restart LocalPilot Core** from the palette: the chat view shows **Ollama down**
   and the status bar shows `Ollama down`.
2. **Start Ollama** — click **Start Ollama** in the chat view (or run **Start Ollama
   (sandboxed, in a terminal)**): a JupyterLab terminal opens and runs the sandboxed
   start line (LaunchAgent restart, or `sandbox-exec … ollama serve`), and the
   banner clears. On Linux/Windows it shows the "needs macOS" error and starts nothing.
3. **Model missing** — set `completionModel` to a model you don't have (e.g.
   `qwen2.5-coder:1.5b-base` after `ollama rm` of it): the chat view shows **Model
   missing** with **Copy pull command** (no Pull button; there is no `Pulling N%`).
   Click it, paste in a terminal, run it; the banner clears. **Copy Ollama Pull
   Command…** in the palette does the same.
4. **Ghost text in a notebook** — open an `.ipynb` with a Python kernel, type
   `def fibonacci(n):` and a newline in a code cell: grey ghost text appears;
   `Tab` accepts it.
5. **Ghost text in a file** — same in a `.py` file opened in the file editor.
6. **Chat edit of a cell, approved** — open the chat (`Alt Shift L`), put the cursor
   in a code cell and ask for a change to that cell: the diff card shows the cell
   (`….ipynb.cell<N>.py`); click **Approve**: the cell changes in place and the
   notebook is saved (no unsaved-changes dot on its tab).
7a. **Run command, no network** — ask the chat to run `curl -sS https://example.com`
   and approve: it fails (could not resolve host) and stderr ends with `(LocalPilot
   runs commands without network access)`. `echo ok` works.
7. **Run command, denied** — ask the chat to run `ls`: a command card appears; click
   **Deny**: nothing runs, and the agent says it was denied.
8. **Theme** — switch **Settings → Theme** between JupyterLab Light and Dark: the
   chat panel follows without a reload.
9. **Model pickers** — in the chat panel, pick another chat model and another
   completion model from the pickers: the Settings Editor shows the new
   `chatModel` / `completionModel`, the core restarts, and the picker keeps the new
   choice. Quit Ollama and open the picker again: it says Ollama is down and keeps
   the last list. **Select Chat Model…** from the palette does the same.
10. **Settings panel** — open the chat panel's Settings, change *Max tokens* to `0`:
    it snaps to `1`; toggle *Adaptive completions*: the Settings Editor follows.
11. **Delete / Clear all** — delete a finished session: the panel switches to the
    next one; with a reply streaming in another session, **Clear all** keeps that
    one and says so. With a second JupyterLab tab open, its chat panel drops the
    deleted sessions too.
12. **Completion stats** — accept a ghost-text suggestion with `Tab`, dismiss
    another by typing something else, then **Show Completion Stats**: `accepted`
    and `rejected` went up for the language. **Reset Completion Learning…** asks
    first, then the stats show *default* limits.

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
  Start it (above; **Start Ollama** is sandboxed), then **Restart LocalPilot Core**. Check
  `curl http://localhost:11434/api/tags` on the server machine.
- **"Model missing" / no ghost text**: LocalPilot does not download models. Use
  **Copy pull command** (chat view) or **Copy Ollama Pull Command…** (palette), run
  `ollama pull <model>` in a terminal, and check `ollama list`. Completions also pause while `completionsEnabled` is off and while
  a chat reply is generating; check that **LocalPilot** is enabled under
  **Settings → Inline Completer**.
- **Commands fail with "no network"**: by design. Agent commands run in a no-network
  sandbox; run network steps (`pip install`, `git push`, downloads) yourself in a terminal.
- **"Not run: … no-network sandbox (macOS)"**: the sandbox is unavailable (not macOS,
  or `/usr/bin/sandbox-exec` or the bundled profile is missing), so commands are refused.
- **Start Ollama says it needs macOS**: LocalPilot only starts Ollama inside the
  sandbox. Start Ollama yourself with `OLLAMA_NO_CLOUD=1 ollama serve`.
- **403 on `/localpilot/rpc`**: LocalPilot needs the same permission as terminals
  (`execute` on `terminals`), because the agent can run commands.
- **"LocalPilot unreachable"** (status bar, plus a notification with **Retry**): the
  tab could not reach the server extension at all — 5 failed connects, a socket
  closed with 1008/4403/4404, or `GET /localpilot/status` answered 403/404. Usually
  the server extension is not loaded in the environment running `jupyter lab`: run
  `jupyter server extension list` there (it must list `localpilot_jupyter enabled`),
  fix it, restart `jupyter lab`, then click **Retry** (or **Restart LocalPilot
  Core**). Requests fail at once in this state instead of waiting.
- **A large file isn't seen by completions / chat**: documents above 1 MB (about a
  million characters; a notebook's cells each and all together) are not synced to the
  core; the browser console says so once per file.

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
