# LocalPilot for JetBrains IDEs

The LocalPilot plugin for PyCharm 2026.2 (build 262+; other IntelliJ-based IDEs of
the same build should work but are untested). It bundles the `localpilot-core`
sidecar and the shared chat UI, and talks to a local [Ollama](https://ollama.com):

- **Inline completions** (ghost text) in files and in Jupyter notebook cells
  (PyCharm Professional's notebook editor).
- **Agent chat** in the **LocalPilot** tool window (right side): edits files and
  notebook cells and runs commands, each only after you approve it.
- **Model picker, sessions, settings panel and adaptive completions**, as in the
  VS Code extension (see [`../vscode/README.md`](../vscode/README.md)).

Nothing leaves your machine.

## Build

On macOS arm64, with Rust, Node.js 20+ and a JDK 25 (e.g. Temurin 25):

```sh
npm ci                                   # once, at the repo root
bash scripts/package-jetbrains.sh        # → dist/localpilot-jetbrains-0.1.0.zip
```

The script builds the release core (`scripts/build-core.sh`; `SKIP_CORE_BUILD=1`
reuses `dist/core/<triple>/localpilot-core`), builds the chat UI and copies it to
`src/main/resources/chat/index.html` (gitignored), then runs `./gradlew buildPlugin`.
Gradle's `prepareSandbox` puts the core at `lib/bin/<triple>/localpilot-core`
inside the plugin, where the plugin looks for it. It finds JDK 25 via `JAVA_HOME`
or `/usr/libexec/java_home -v 25`. The version comes from `gradle.properties`
(`pluginVersion`).

The zip bundles only the core binaries in `dist/core/` (normally just this
machine's), so it is effectively macOS arm64 only. On another platform, set
**Core binary** in the settings (below).

## Install

1. In PyCharm: **Settings → Plugins → ⚙ → Install Plugin from Disk…** and pick
   `<repo>/dist/localpilot-jetbrains-0.1.0.zip`.
2. PyCharm 2026.2 loads it without a restart (all of LocalPilot's extension
   points are dynamic). Projects that are already open are set up when the plugin
   loads (document sync, chat hooks, core), and again lazily when the LocalPilot
   tool window or status bar widget appears. If LocalPilot still looks inert in a
   project (no ghost text, the status bar stuck on "stopped", chat edits answering
   "not available"), reopen the project or restart the IDE.

Alternatively, with the IDE **closed**, unzip the archive into the IDE's plugins
directory. For PyCharm 2026.2 on macOS that is
`~/Library/Application Support/JetBrains/PyCharm2026.2/plugins/`, which gives
`…/plugins/localpilot-jetbrains/lib/…`.

To update, install the new zip the same way (or delete `plugins/localpilot-jetbrains`
first when unzipping by hand).

## Start Ollama

```sh
ollama serve &                           # or launch the Ollama app
ollama pull qwen2.5-coder:0.5b-base      # completions (fill-in-the-middle)
ollama pull qwen3.8:27b-mlx              # chat (tool calling)
```

If Ollama is not running, LocalPilot shows an **Ollama down** balloon with
**Start Ollama** (runs `ollama serve` in an "Ollama" tab of the Run tool window)
and **Retry**. If a configured model is missing, the balloon offers **Pull model**
(a cancellable background task with progress).

## Using it

- **Ghost text** appears as you type; `Tab` accepts it. The IDE's **Insert Next
  Word** / **Insert Next Line** inline-completion actions accept part of it.
- **Chat**: `Cmd+Shift+L` (macOS) / `Ctrl+Shift+L` opens the LocalPilot tool window.
- **Status bar**: the LocalPilot widget shows the state (starting, Ollama down,
  model missing, pulling N%, completions off, completions paused during chat,
  crashed). Click it for the menu.
- **Tools → LocalPilot** (and the status bar menu): Open LocalPilot Chat, New
  LocalPilot Chat, Start Ollama (only if Ollama is not already answering), Check Ollama Again, Pull Model…, Select Chat Model…, Select Completion
  Model…, Inline Completions (toggle), Show Completion Stats, Reset Completion
  Learning…, Restart LocalPilot Core.

LocalPilot works on a project with a base directory (the workspace the core
indexes); the core logs to `<project>/.localpilot/core.log` and keeps that folder
out of git itself.

## Settings

**Settings → Tools → LocalPilot** (application-wide). Same keys and defaults as the
core and the VS Code extension:

| Setting | Default | Notes |
| --- | --- | --- |
| Ollama URL (`ollamaUrl`) | `http://localhost:11434` | Base URL of the local Ollama server. |
| Completion model (`completionModel`) | `qwen2.5-coder:0.5b-base` | FIM model for inline completions; also set by **Select Completion Model…**. |
| Show inline completions (`completionsEnabled`) | on | **Client-side**: no core restart. Also the **Inline Completions** toggle. |
| Debounce (`completionDebounceMs`) | `120` | Delay after the last keystroke before a completion is requested. **Client-side**. |
| Max tokens (`completionMaxTokens`) | `32` | Max tokens per inline completion. |
| Completion context tokens (`completionContextTokens`) | `3584` | Prompt budget for completions. |
| Adaptive completions (`adaptiveCompletions`) | on | Adapt completion length and add style examples from past accepts/rejects. |
| Chat model (`chatModel`) | `qwen3.8:27b-mlx` | Tool-calling model for chat; also set by **Select Chat Model…** and the chat's picker. |
| Thinking (`chatThinking`) | `off` | `on` lets the chat model think before answering (slower). |
| Chat context tokens (`chatContextTokens`) | `24000` | Chat history budget. |
| Commands approved "Always" (`allowedCommandsAlways`) | none | The agent runs these without asking; remove entries here. |
| Core binary (`coreBinaryPath`) | empty | Use this `localpilot-core` instead of the bundled one. |
| Log level (`logLevel`) | `info` | Core log level (`error` … `trace`). |

The core reads its settings only when it starts, so changing any setting except
the two client-side ones restarts it (debounced); a restart ends a chat reply
that is still streaming. The chat's settings panel edits max tokens, debounce,
completion context tokens and adaptive completions.

## Manual smoke checklist

Walk this after installing a new build (a project open, Ollama models pulled):

1. **Ollama down** — quit Ollama, run **Tools → LocalPilot → Restart LocalPilot
   Core**: an **Ollama down** balloon appears and the status bar says so.
2. **Start Ollama** — click **Start Ollama** in the balloon: an "Ollama" tab in the
   Run tool window runs `ollama serve`; the status clears within ~10 s.
3. **Pull model** — select a completion model you don't have (or `ollama rm` one):
   the **Model missing** balloon offers **Pull model**; the background task shows
   progress and ends with "… is ready".
4. **Ghost text in Python** — in a `.py` file type `def fibonacci(n):` and a
   newline: grey ghost text appears; `Tab` accepts it.
5. **Ghost text in a notebook** — open an `.ipynb`, type in a code cell: ghost text
   appears inside the cell and `Tab` accepts it.
6. **Chat edit, approved** — `Cmd+Shift+L`, ask for a docstring on a function in an
   open file: a diff card appears; **Approve**: the edit is applied and the file is
   saved.
7. **Chat edit in a notebook** — put the caret in a notebook code cell, attach it in
   the chat and ask for a change: the card shows `….ipynb.cell<N>.py`; **Approve**:
   the cell changes in place and the notebook is saved.
8. **Run command, denied** — ask the chat to run `ls`: a command card appears;
   **Deny**: nothing runs and the agent says it was denied.
9. **Models (v2)** — pick a chat model in the chat's picker and a completion model
   via **Select Completion Model…** (models without fill-in-the-middle / tool calling
   are flagged). With Ollama quit, the chat picker shows **No models — Ollama down**
   and the IDE picker offers Start Ollama / Retry.
10. **Settings panel** — change max tokens in the chat's settings panel: it appears
    in **Settings → Tools → LocalPilot** (and the core restarts once).
11. **Sessions** — delete a chat session, then **Clear all**: the list empties and a
    new chat starts.
12. **Stats / learning** — after a few accepts/rejects, **Show Completion Stats**
    lists them per language (**Open Log** opens the log); **Reset Completion
    Learning…** clears them after confirming.
13. **Links** — an `https://` link in a chat answer opens in the system browser,
    and the chat pane stays on the chat.

## Known limitations

- **Notebooks are seen as the Jupyter plugin's `#%%` source text.** A cell line
  that starts with `#%%` appears (and is saved) as `##%%`; a literal `#%%` line
  cannot be put into a cell through it. Cells are matched by position (no cell ids).
- **Whole `.ipynb` edits are refused**: the agent edits notebooks cell by cell
  (`<nb>.ipynb.cell<N>.<ext>`); the read-only concatenation `….ipynb.cells.<ext>`
  cannot be edited either.
- The notebook's kernel language is read when it opens; a kernel change is
  picked up on reopen.
- **Completion outcomes come from the IDE's inline-completion events**: a
  suggestion served but never shown is logged as rejected (by timeout); Insert
  Next Word / Line count as partial accepts. These two actions are
  `@ApiStatus.Experimental` in 2026.2 (`verifyPlugin` warns about them).
- **Start Ollama** uses a Run tool window tab, not the Terminal; closing the
  project stops that `ollama serve`. If `ollama` is not on the login shell's
  `PATH`, the tab shows `ollama: not found`.
- The **Pull model** balloon offers the configured models rather than detecting
  which one is missing.
- **Dynamic install / update**: the plugin installs itself into open projects
  when it is loaded without a restart (verified by tests, not on every IDE
  build). If a project stays inert after installing or updating, reopen it or
  restart the IDE.
- Cancelling a **Pull model** task only stops watching it: the protocol has no
  pull cancel, so Ollama finishes the download (the status bar keeps the
  percentage until it does).
- Chat edits run on the EDT without modality, so an open modal dialog delays them
  until it closes; created files are not undone by **Undo**.
- Windows is untested (the command runner's quoting, the bundled core).

## Troubleshooting

- **"Core binary not found"**: the zip was built without `dist/core/<triple>/`
  for this machine (or for another platform). Rebuild with
  `scripts/package-jetbrains.sh`, or set **Core binary** in the settings.
- **Blank chat pane**: the plugin was built without the chat UI. Rebuild with the
  script (it copies `chat-ui/dist/index.html`).
- **Logs**: `<project>/.localpilot/core.log` (raise **Log level** to `debug`), and
  the IDE log (**Help → Show Log in Finder**, search for `LocalPilot`).
- **"Ollama down"**: check `curl http://localhost:11434/api/tags`, then **Check
  Ollama Again**.

## Development

```sh
cd jetbrains
export JAVA_HOME=$(/usr/libexec/java_home -v 25)
./gradlew test verifyPlugin              # unit + platform tests (Node 20 for the fake-core tests)
./gradlew runIde                         # PyCharm 2026.2.3 sandbox with the plugin
```

`runIde` uses the sandbox under `.intellijPlatform/sandbox/` (its own
`config_runIde`, `plugins_runIde`, `log_runIde`). `prepareSandbox` bundles the core
from `../dist/core/` (run `scripts/build-core.sh` once) and the chat UI from
`src/main/resources/chat/index.html` (run the package script, or
`npm run build -w chat-ui` and copy `chat-ui/dist/index.html` there). CI:
`.github/workflows/jetbrains.yml` (macOS, JDK 25, Node 20: `test verifyPlugin`).
