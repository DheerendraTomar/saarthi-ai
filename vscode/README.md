# LocalPilot for VS Code

Copilot-style inline completions and an agent chat, running entirely on your machine via Ollama.

## Keybinding

`Cmd+Shift+L` (macOS) / `Ctrl+Shift+L` opens the LocalPilot chat in any window with a folder open.
This shadows VS Code's default **Select All Occurrences of Find Match** on the same chord.
To get that back, open **Preferences: Open Keyboard Shortcuts**, search for `localpilot.openChat`,
and change or remove its binding (or rebind `editor.action.selectHighlights`).

## Install

LocalPilot is not on the Marketplace; build the `.vsix` from this repo and install it.
Requires Rust (stable), Node 20+ and npm; the bundled core is built for this machine
(`aarch64-apple-darwin` on Apple Silicon).

```sh
npm ci                                   # once, from the repo root
bash scripts/package-vscode.sh           # → dist/localpilot-0.1.0.vsix
code --install-extension dist/localpilot-0.1.0.vsix --force
code --list-extensions | grep localpilot # → localpilot.localpilot
```

If `code` is not on your `PATH`, use
`"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"` (or run
**Shell Command: Install 'code' command in PATH** from the Command Palette).
Reload VS Code windows after installing. LocalPilot needs a folder open: it starts
one core per window for the first workspace folder.

## Start Ollama

LocalPilot talks only to a local [Ollama](https://ollama.com) (`localpilot.ollamaUrl`,
default `http://localhost:11434`).

```sh
ollama serve                             # or launch the Ollama app
ollama pull qwen2.5-coder:0.5b-base      # inline completions (default)
ollama pull qwen3.8:27b-mlx              # agent chat (default)
```

From VS Code, **LocalPilot: Start Ollama** opens a terminal named "Ollama" running
`ollama serve`, and **LocalPilot: Pull Model** pulls the completion or chat model
with progress. The chat view's status pill offers the same actions when Ollama is
down or a model is missing; the status bar item opens a menu with them too.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| `localpilot.ollamaUrl` | `http://localhost:11434` | Base URL of the local Ollama server. |
| `localpilot.completionModel` | `qwen2.5-coder:0.5b-base` | FIM model for inline completions; `qwen2.5-coder:1.5b-base` is the higher-quality alternative. |
| `localpilot.chatModel` | `qwen3.8:27b-mlx` | Tool-calling model for agent chat. |
| `localpilot.completionsEnabled` | `true` | Show ghost-text completions. **Client-side**: no core restart. Also toggled by **LocalPilot: Toggle Inline Completions**. |
| `localpilot.completionDebounceMs` | `120` | Delay after the last keystroke before a completion is requested. **Client-side**: no core restart. |
| `localpilot.completionMaxTokens` | `32` | Max tokens generated per inline completion. |
| `localpilot.completionContextTokens` | `3584` | Prompt budget for completions (prefix + suffix + related snippets). |
| `localpilot.chatThinking` | `off` | `on` lets the chat model think before answering (slower). |
| `localpilot.chatContextTokens` | `24000` | Chat history budget before older turns are dropped. |
| `localpilot.allowedCommandsAlways` | `[]` | Commands approved with **Always**; the agent runs these without asking. |
| `localpilot.coreBinaryPath` | `""` | Use this `localpilot-core` binary instead of the bundled one. |
| `localpilot.logLevel` | `info` | Core log level (`error` … `trace`). |

The core reads its settings only when it starts, so changing any setting except
`completionsEnabled` and `completionDebounceMs` restarts it (once, 0.5 s after the
last edit). A restart ends a chat reply that is still streaming.

## Manual smoke checklist

Walk this after installing a new build (folder open, Ollama models pulled):

1. **Ollama down banner** — quit Ollama (`pkill ollama` / quit the app), run
   **LocalPilot: Restart Core**: the chat view shows **Ollama down** and the status
   bar shows the problem.
2. **Start Ollama** — click **Start Ollama** in the chat view: a terminal named
   "Ollama" runs `ollama serve`, and the banner clears.
3. **Pull model** — set `localpilot.completionModel` to a model you don't have
   (e.g. `qwen2.5-coder:1.5b-base` after `ollama rm` of it): the chat view shows
   **Model missing**; click **Pull model** and watch the progress notification
   finish with "… is ready".
4. **Ghost text in Python** — in a `.py` file type `def fibonacci(n):` and a newline:
   grey ghost text appears; `Tab` accepts it.
5. **Ghost text in a notebook** — open an `.ipynb`, type in a code cell: ghost text
   appears inside the cell and `Tab` accepts it.
6. **Chat edit, approved** — open the chat (`Cmd+Shift+L`), ask it to add a docstring
   to a function in an open file: a diff card appears; click **Approve**: the edit
   is applied and the file is saved (no dirty dot on its tab).
7. **Run command, denied** — ask the chat to run `ls` (or the tests): a command
   card appears; click **Deny**: nothing runs, and the agent says it was denied.

## Troubleshooting

- **Logs**: the core logs to `<workspace>/.localpilot/core.log` (set
  `localpilot.logLevel` to `debug` for more); the extension logs to the **LocalPilot**
  output channel. Add `.localpilot/` to your `.gitignore`.
- **"Ollama down"**: Ollama isn't answering at `localpilot.ollamaUrl`. Start it
  (`ollama serve`, the Ollama app, or **LocalPilot: Start Ollama**), then pick
  **Retry** from the status bar menu. Check `curl http://localhost:11434/api/tags`.
- **"Model missing" / no ghost text**: pull the configured model
  (`ollama pull qwen2.5-coder:0.5b-base` or **LocalPilot: Pull Model**) and check
  `ollama list`. Completions also pause while `localpilot.completionsEnabled` is
  off (status bar).
- **Core failed to start / crashed**: see the error message and the log above;
  **LocalPilot: Restart Core** starts it again. "no core binary" means the `.vsix`
  was built for another platform: build it on this machine or set
  `localpilot.coreBinaryPath`.
- **Nothing happens**: LocalPilot needs a folder open (not a single file).

## Development

```sh
npm test -w vscode         # unit tests (vitest, mocked vscode API)
npm run lint -w vscode
npm run test:e2e -w vscode # real VS Code 1.142.0 (cached in vscode/.vscode-test/) + the fake core
```

The e2e smoke sets `LOCALPILOT_FAKE_CORE=1`, so it launches `test/fakeCore.mjs`
instead of the Rust core and needs neither the core nor Ollama.
