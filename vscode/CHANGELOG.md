# Changelog

## 0.3.0 — 2026-10-27

- Nothing leaves the machine: `localpilot.ollamaUrl` must point at this machine (localhost, 127.0.0.0/8, `::1`); other hosts are refused. The bundled core ignores proxies and redirects.
- LocalPilot no longer downloads models. Removed **Pull Model** (`localpilot.pullModel`), pull progress and the Pull model buttons; when a model is missing, **Copy pull command** copies `ollama pull <model>` to run in a terminal.
- **Start Ollama** starts Ollama inside a no-network sandbox (macOS `sandbox-exec`, bundled `sandbox/no-network.sb`, `OLLAMA_NO_CLOUD=1`), via the `local.ollama.sandboxed` launch agent when it is installed. Off macOS it starts nothing and says so.
- Approved agent commands run inside the same no-network sandbox. Where that is not possible (not macOS, no `sandbox-exec`, no profile) they are not run. Failed commands end with "(LocalPilot runs commands without network access)".

## 0.2.2 — 2026-10-21

- Typing through a suggestion is reported once for the whole run: when the rest of a suggestion you are typing into is shown again, its watch is handed over without a report, so a backspace no longer logs the run as rejected before you accept it, and long type-throughs are no longer cut off (and logged rejected) after 8 keys.

## 0.2.1 — 2026-10-21

- Adaptive completions never generate more tokens than `localpilot.completionMaxTokens`: learning only shortens suggestions (it could previously go up to twice the setting, above the latency target).
- Every 10th multi-line suggestion per language uses the configured limits, so longer suggestions keep being tried after learning has shortened them.
- One typing run through a suggestion is logged once: the rest served from the cache after each key is no longer a separate record, and style examples no longer repeat the same suggestion.
- Settings panel stats: partial, typed-through and rejected counts, "Accept rate (incl. partial)", and the line / token limits tagged *learned* or *default*. **Reset learning** asks for a second click (**Confirm**). The context budget field starts at 256, like the setting.
- The chat view only writes a model name that is installed in Ollama (or already configured).

## 0.2.0 — 2026-10-21

- Model selection: pick the chat and completion models from the models installed in Ollama (chat header, Settings panel, status bar menu, **Select Chat Model** / **Select Completion Model**), with size and capability hints and an explicit "Ollama down" state.
- Chat session deletion: delete one session (refused while its reply runs) or clear all after a confirmation, from the chat view or with **Delete Chat Session** / **Clear All Chat Sessions**.
- Settings panel in the chat view for the completion settings, with completion stats and **Reset learning**.
- Adaptive completions (`localpilot.adaptiveCompletions`, default on): outcomes of shown suggestions (accepted, partial, typed through, rejected) are logged locally and used to tune completion length and add style examples. New commands **Show Completion Stats** and **Reset Completion Learning**.
- The outcome log stays on your machine (`<workspace>/.localpilot/completions.jsonl`: at most 200 characters before the cursor, the suggestion and timings; rotated past 10 000 lines). Partial accepts are inferred from edits; the known biases are listed in the README.
- Bundled `localpilot-core` with the v2 protocol: `ollama/models`, `chat/deleteSession`, `chat/clearSessions`, `completion/outcome`, `completion/stats`, `completion/resetLearning` and the `adaptiveCompletions` setting.

## 0.1.0 — 2026-10-21

First release.

- Inline (ghost text) completions from a local Ollama FIM model, in files and Jupyter notebook code cells; debounced, cancelled when superseded.
- Agent chat view (`Cmd+Shift+L`): streaming replies, sessions, file edits and terminal commands that run only after you approve them (Approve / Always / Deny).
- Bundled `localpilot-core` sidecar (macOS arm64), restarted on crash and when core settings change.
- Status bar with Ollama and core state; commands to start Ollama, pull models, toggle completions and restart the core.
