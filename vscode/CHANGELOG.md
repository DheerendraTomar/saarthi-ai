# Changelog

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
