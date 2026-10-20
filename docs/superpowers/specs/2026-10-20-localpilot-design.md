# LocalPilot — Design

*Date: 2026-10-20. Status: draft for approval.*

## 1. Intent

A Copilot-style assistant for VS Code and PyCharm (all JetBrains IDEs) that runs
entirely against models served by a local Ollama instance. Nothing leaves the
machine. Two surfaces:

1. **Inline completions** — ghost text as you type. Must feel instant.
2. **Agent chat** — a side panel (icon or shortcut) where you talk to an agent
   that can read the project, propose solutions, and — after you approve — edit
   files, create files, and run commands. The experience to copy is Claude Code
   / Copilot agent mode, not a plain chatbot.

"LocalPilot" is a placeholder name chosen by the designer; rename freely
(it appears in package names, so rename before the first release).

### Why

- Privacy: code never leaves the laptop.
- No subscription.
- The owner already runs a strong local model (`qwen3.8:27b-mlx`, 17 GB) on an
  M4 Pro / 48 GB and wants it to be *useful inside the editor*, not just in a
  terminal.

### Success looks like

- Ghost text appears within a few hundred milliseconds of pausing typing and is
  accepted often enough to be worth keeping on.
- In chat, "add a `--dry-run` flag to this CLI" produces a reviewable diff
  across the right files, applied only when accepted.
- Both IDEs behave the same.

## 2. Goals, non-goals, anti-goals

**Goals**

- Highly efficient inline completion: low latency, low CPU/memory when idle,
  never blocks the editor.
- Agentic chat with tool use and an approval step for anything that changes
  state.
- One shared core so both IDEs behave identically and bugs are fixed once.
- Works offline. Only talks to `http://localhost:11434` (configurable).

**Non-goals (v1)**

- Cloud model providers. Ollama only.
- Windows/Linux/Intel-Mac binaries in the first build (cross-compilation is set
  up, but Apple Silicon is the only tested target).
- Multi-user / remote-dev / SSH workspaces. Multi-root workspaces use the
  first folder only.
- Marketplace publishing. v1 ships as a `.vsix` and a JetBrains `.zip` installed
  from disk.
- Image/vision input, even though the installed model is multimodal.
- Its own embeddings/vector index. Context retrieval is lexical (see §6).

**Anti-goals (these would make it a failure even if it "works")**

- Completions that lag or stutter the editor. If in doubt, show nothing.
- The agent silently modifying files or running commands without approval.
- The 17 GB chat model being evicted/reloaded on every completion (model
  thrash).
- A sidecar that sits at hundreds of MB or spins the CPU while idle.

## 3. Constraints and environment (verified on the owner's machine)

| Thing | Value |
|---|---|
| Machine | Apple M4 Pro, 48 GB unified memory, macOS (Darwin 27) |
| Ollama | 0.40.6 (Homebrew CLI, **not** the menu-bar app — nothing auto-starts it) |
| Installed model | `qwen3.8:27b-mlx` — served by Ollama's MLX backend; chat template has `<tool_call>` and `<think>` support; multimodal (vision ignored) |
| Completion model | none installed yet; design assumes `qwen2.5-coder:1.5b-base` (~1 GB) |
| VS Code | 1.142.0 |
| PyCharm | 2026.2.3, build `PY-262.10968.92` |
| JDKs | 17 (Homebrew), 21 not present, 25, 26. IntelliJ Platform Gradle Plugin → **use JDK 17 toolchain**. No `gradle` on PATH → ship the Gradle wrapper. |
| Node | 20.19 / npm 10.8 |
| Rust | cargo/rustc 1.99, clippy, rust-analyzer present |

## 4. Architecture (designer's call, accepted by owner)

```
┌───────────────┐   JSON-RPC 2.0 over stdio   ┌──────────────────────┐   HTTP   ┌────────┐
│ VS Code ext   │◄───────────────────────────►│  localpilot-core      │◄────────►│ Ollama │
│ (TypeScript)  │                             │  (Rust binary)        │          │ :11434 │
└───────────────┘                             │  • completion engine  │          └────────┘
┌───────────────┐                             │  • agent loop + tools │
│ JetBrains     │◄───────────────────────────►│  • workspace index    │
│ plugin (Kotlin)│                            │  • doc overlay        │
└───────────────┘                             └──────────────────────┘
        ▲  both embed the same chat-ui bundle (TypeScript, webview / JCEF)
```

Monorepo layout:

```
core/        Rust crate → binary `localpilot-core`
chat-ui/     TypeScript (Preact + Vite) → single-file bundle used by both IDEs
vscode/      VS Code extension (TypeScript, esbuild)
jetbrains/   IntelliJ Platform plugin (Kotlin, Gradle wrapper, JDK 17)
docs/
```

### 4.1 Why a Rust sidecar

The core is a separate process for both IDEs, spoken to exactly like a language
server. Rust is used because the parts that are CPU-bound — workspace scanning,
lexical search for related context, prompt assembly on every keystroke — must
be fast and must idle at near-zero. Model inference latency dominates
everything else and is unaffected by the choice of language; see §5 for the
things that actually make completions fast.

### 4.2 Process lifecycle

- Each IDE window spawns one `localpilot-core` process with the workspace root
  as an argument. It exits when stdin closes.
- The sidecar never auto-starts Ollama. If `GET /api/version` fails it returns a
  typed error; the IDE shows a one-click "Start Ollama" action that runs
  `ollama serve` in an IDE terminal, plus a "Retry" action.
- On first use, if the completion model is missing, the IDE offers to pull it
  (progress streamed from `POST /api/pull`). Chat model missing → error with
  the model name.
- Binary location: the VS Code extension and JetBrains plugin each **bundle**
  the `aarch64-apple-darwin` binary. A `localpilot.coreBinaryPath` setting
  overrides it (for dev builds). Cross-compilation targets for x86_64 macOS,
  Linux, Windows are configured in CI but not shipped in v1.

### 4.3 Document overlay (unsaved buffers)

The sidecar must never read stale code from disk. IDE clients sync open
documents LSP-style: `textDocument/didOpen`, `didChange` (incremental ranges),
`didClose`. The sidecar keeps an in-memory overlay; **every** read — completions,
context retrieval, and the agent's `read_file` tool — goes through the overlay
first and falls back to disk. Edits proposed by the agent are expressed against
overlay content.

### 4.4 Protocol (JSON-RPC 2.0, newline-delimited, over stdio)

Client → core requests:

- `initialize { workspaceRoot, settings }` → `{ capabilities, ollamaStatus }`
- `textDocument/didOpen | didChange | didClose` (notifications)
- `completion/request { uri, position, requestId }` → `{ items: [{ text, range }] }`
  (empty list is a valid, common answer)
- `completion/cancel { requestId }` (notification)
- `completion/accepted { requestId }` / `completion/rejected` (telemetry-free;
  used only to tune the local cache)
- `chat/send { sessionId, message, attachments: [{ uri } | { uri, range }] }`
- `chat/stop { sessionId }`
- `chat/approve { sessionId, toolCallId, decision: "once" | "always" | "deny", editedArgs? }`
- `chat/newSession`, `chat/listSessions`, `chat/history { sessionId }`
- `ollama/status`, `ollama/pull { model }` (streams progress notifications)
- `bench/run` → timing report (see §5.5)
- `shutdown`

Core → client notifications:

- `chat/token { sessionId, delta, kind: "text" | "thinking" }`
- `chat/toolCall { sessionId, toolCallId, name, args, requiresApproval, preview }`
  — `preview` is a unified diff for edits, the command line for commands.
- `chat/toolResult { sessionId, toolCallId, ok, summary }`
- `chat/done { sessionId, stopReason }`
- `workspace/applyEdit { ops: [{ kind: "edit", uri, range, newText } | { kind: "create", uri, content }], save: true }`
  → client applies via the IDE's own edit API (so undo/redo and formatting
  work), **then saves the touched files to disk** (see §7.3 on save
  semantics) and **responds** with `{ applied: bool, error? }`, which becomes
  the tool result. Files not open in an editor are opened in the background
  by the client, edited, and saved — never written by the core.
- `workspace/runCommand { command, cwd }` → client runs it in an IDE terminal
  / process and responds with `{ exitCode, stdout, stderr }` (truncated to a
  size limit set by the builder).
- `status { ollama: "ok" | "down" | "modelMissing", detail }`

Settings (in both IDEs, forwarded in `initialize`):
`ollamaUrl`, `completionModel`, `chatModel`, `completionsEnabled`,
`completionDebounceMs`, `completionMaxTokens`, `chatThinking` (off | on),
`coreBinaryPath`, `allowedCommandsAlways` (list), `completionContextTokens`
(completion prompt budget), `chatContextTokens` (chat history budget).

## 5. Inline completion engine

This is where "highly efficient" is earned. All of these are required.

1. **Small FIM model, kept warm.** Default `qwen2.5-coder:1.5b-base` via
   `POST /api/generate` with `prompt` + `suffix` (Ollama's native FIM). Every
   request passes `keep_alive: "30m"` (configurable) so the model is never
   unloaded between keystrokes.
2. **Debounce + cancel.** Client fires after `completionDebounceMs` (default
   120 ms) of no typing. Any new keystroke sends `completion/cancel`, and the
   core aborts the in-flight HTTP request (drop the stream) so Ollama stops
   generating.
3. **Stable prefix for KV-cache reuse.** The prompt is built as
   `[related-file snippets][file prefix up to cursor]` with the *same*
   ordering and byte-identical snippet text across consecutive requests, so
   Ollama's prompt cache hits on the long shared prefix and only the last few
   tokens are new. Snippets are refreshed on a slow cadence (e.g. on file
   switch / save), not per keystroke.
4. **Context windows.** Prefix: up to ~2 k tokens before the cursor. Suffix:
   up to ~512 tokens after. Related snippets: ≤ ~1 k tokens total from the
   workspace index (§6). Hard cap via `completionContextTokens`.
5. **Output cap + early stop.** `num_predict` ≤ `completionMaxTokens` (default
   64). Streaming; the core stops reading when the completion reaches a natural
   boundary (balanced close of the current block / blank line / the next line
   already matches the suffix). Single-line in the middle of a line,
   multi-line at end of line, with a cap of ~8 lines.
6. **Cache.** LRU keyed on `(uri, prefix-hash, suffix-hash)`. If the user types
   characters that are the start of the cached completion, serve the remainder
   from cache with no model call. Backspace into a cached state is free.
7. **Don't fire when it's pointless.** No completion inside strings being
   typed character-by-character? — *left to builder.* Required skip cases: when
   the cursor is immediately followed by a non-whitespace identifier character,
   when the file is larger than a size limit, when a completion for the same
   state is already in flight.
8. **Never block the IDE.** Clients call the provider asynchronously; a
   completion that misses the IDE's cancellation token is simply dropped.
9. **Thinking is always off** for completions (base model; no chat template).
10. **Paused while chat generates (designer's call).** Both models share one
    GPU, so while the chat agent is streaming the core answers completion
    requests with an empty list and the status-bar item reads "completions
    paused during chat". They resume automatically on `chat/done`. The §5.5
    targets are measured with chat idle.

### 5.5 Performance targets and `bench`

Targets on the owner's machine with the models above, measured by
`localpilot-core bench` (runs N synthetic completion requests against a sample
file and prints p50/p95):

- Time from `completion/request` to first ghost-text token: **p50 ≤ 250 ms,
  p95 ≤ 600 ms** when the model is warm.
- Core-side overhead (request received → HTTP sent): **< 5 ms p95**, including
  context retrieval.
- Sidecar idle: **≤ 30 MB RSS, ~0% CPU.** With a 50 k-file workspace indexed:
  ≤ 150 MB.
- Chat: first token ≤ 2 s with thinking off, after the model is warm.

If the completion-model default cannot hit these, the plan should try
`qwen2.5-coder:0.5b-base` and note the trade.

## 6. Workspace index and context retrieval

- On `initialize`, walk the workspace respecting `.gitignore` (the `ignore`
  crate), skipping binaries and files > 1 MB. Maintain a file list and a
  per-file symbol/identifier table built with a cheap tokenizer (no tree-sitter
  in v1; left to builder whether to add it later).
- Watch for changes (`notify` crate) and update incrementally.
- Related-snippet selection for completions: (a) files imported by / importing
  the current file (regex-based import detection for Python, JS/TS, Go, Rust,
  Java, Kotlin — builder may extend), (b) the N most recently edited files,
  (c) files sharing the most identifiers with the window around the cursor.
  Pick the top few snippets by score, trimmed to the token budget.
- The same index backs the agent's `search` tool.

## 7. Agent chat

### 7.1 Model and prompt

- Default `chatModel`: `qwen3.8:27b-mlx` via `POST /api/chat` with `tools`
  and `stream: true`, `keep_alive: "30m"`.
- Thinking: **off by default** (`think: false`) because it multiplies latency;
  setting `chatThinking: on` streams thinking tokens to a collapsed section in
  the UI.
- System prompt: tells the model it is a coding agent inside an IDE, lists the
  tools, insists on small targeted edits, and includes the workspace root,
  the active file, and the user's selection when sent as attachments.

### 7.2 Tools

| Tool | Approval | Notes |
|---|---|---|
| `read_file { path, startLine?, endLine? }` | auto | via overlay |
| `list_files { glob? }` | auto | from index |
| `search { query, glob?, maxResults? }` | auto | literal or regex, from index |
| `get_diagnostics { path? }` | auto | *optional in v1*, IDE-provided |
| `edit_file { path, old, new }` | **ask** | exact-match replace of `old` with `new`; see 7.3 |
| `create_file { path, content }` | **ask** | fails if exists |
| `run_command { command, cwd? }` | **ask** | executed by the IDE client; output returned truncated |

Approval decisions: `once`, `always` (for this session; `run_command` "always"
is scoped to the exact command string), `deny` (model receives "user denied"
and continues). Reads/searches/lists are always automatic.

### 7.3 Edit application and robustness

Local models mis-quote `old` text often. The core resolves `edit_file` as:
1. exact match; 2. match ignoring leading/trailing whitespace per line;
3. match with all whitespace runs normalised. If exactly one match is found
the edit becomes a `workspace/applyEdit` with a diff preview; if zero or many,
the tool returns a descriptive error (with the nearest candidate lines) so the
model can retry. Edits are applied by the IDE, not by the core writing to
disk, and the IDE's response is the tool result. After an accepted edit, the
overlay is updated by the IDE's normal `didChange`.

**Save semantics (designer's call, mirrors Claude Code):** an approved
`edit_file` / `create_file` is applied *and saved to disk* by the IDE client
immediately, so a following `run_command` (tests, build) sees the new code.
Only the files the agent touched are saved; the user's other unsaved buffers
are left alone. The IDE's undo stack still covers the change.

### 7.4 Sessions

Sessions persist to `<workspace>/.localpilot/sessions/*.json` (git-ignored by
a generated `.localpilot/.gitignore`). History is sent back to the model in
full until `chatContextTokens`; then older turns are dropped oldest-first,
keeping the system prompt and the last tool results. (Summarisation is
left to a later version.)

## 8. IDE clients

### 8.1 VS Code (`vscode/`)

- `InlineCompletionItemProvider` → `completion/request`, honours the
  cancellation token → `completion/cancel`.
- Activity-bar icon + `Cmd+Shift+L` (default keybinding, configurable) opens
  a `WebviewView` hosting `chat-ui`.
- `workspace/applyEdit` → `vscode.WorkspaceEdit`; the diff preview in the
  chat is rendered by `chat-ui`, and an optional "Open diff" button uses
  `vscode.diff`.
- `run_command` → runs in a `Task`/pseudo-terminal and captures output.
- Status-bar item: model state, Ollama down, "pulling model…".
- Packaging: `vsce package` → `.vsix` with the bundled binary.

### 8.2 JetBrains (`jetbrains/`)

- Target: IntelliJ Platform 2026.2 (build 262) — `pluginSinceBuild = 262`.
  Must work in PyCharm; should work in all JetBrains IDEs (no language-plugin
  dependencies).
- `com.intellij.codeInsight.inlineCompletion.InlineCompletionProvider` for
  ghost text.
- Tool window with a JCEF browser hosting the same `chat-ui` bundle; bridge
  via `JBCefJSQuery`.
- `workspace/applyEdit` → `WriteCommandAction` + `Document.replaceString`.
- `run_command` → `GeneralCommandLine` / terminal plugin.
- Build: Gradle wrapper, IntelliJ Platform Gradle Plugin 2.x, Kotlin, JDK 17
  toolchain. `./gradlew buildPlugin` → `.zip`; `./gradlew runIde` for dev.

### 8.3 `chat-ui/`

- Preact + TypeScript + Vite, built to a single HTML/JS bundle with no
  external loads (CSP-safe for both webviews).
- Message list with streaming markdown + code blocks (copy / insert at cursor),
  tool-call cards with approve / always / deny and an inline diff,
  thinking (collapsed) section, stop button, session switcher, model/status
  pill, "@ attach current file / selection".
- Talks to the host through a tiny `postMessage` shim with two
  implementations (VS Code `acquireVsCodeApi`, JCEF `window.cefQuery`).

## 9. Testing and verification

- Rust: unit tests for prompt assembly (byte-stable prefixes), cache, edit
  matching (all three strategies), FIM boundary stop logic, index scoring; an
  integration test against a **mock Ollama** HTTP server (streams canned
  responses) so CI never needs a model.
- `bench` subcommand as in §5.5; the plan must run it on the real machine and
  record numbers in `docs/`.
- chat-ui: component tests for tool-call cards and streaming.
- VS Code: `@vscode/test-electron` smoke test (activate, request completion
  against mock core).
- JetBrains: `./gradlew test` with the platform test framework for the
  provider; manual `runIde` check in PyCharm.
- Live smoke test checklist (manual, on the owner's machine): Ollama down →
  banner; pull model; ghost text in a Python file; chat edit with approve;
  run command with deny.

## 10. Assumptions to verify first (plan task 1)

These are believed but not yet observed. The first plan task starts Ollama and
checks each; if one fails, the spec item it affects is noted below.

1. Ollama 0.40.6 parses tool calls from the MLX-backed `qwen3.8:27b-mlx` via
   `/api/chat` with `tools`. (Affects §7 — fallback: prompt-based JSON tool
   calling parsed by the core.)
2. `qwen2.5-coder:1.5b-base` + `/api/generate` with `suffix` yields proper FIM
   in this version. (Affects §5 — fallback: hand-built FIM tokens in `prompt`,
   `raw: true`.)
3. Both models stay resident together: check `OLLAMA_MAX_LOADED_MODELS` on
   macOS; if the default is 1, document `OLLAMA_MAX_LOADED_MODELS=2` in setup
   and surface a warning from `ollama/status` when the chat model is evicted.
4. `think: false` is honoured for this model so chat is not silently slow.
5. Ollama's prompt cache reuses the shared prefix for `/api/generate` with a
   changing suffix (measure with `bench`; affects §5.3's value).

## 11. Left to the builder

- Exact crate choices (`tokio`, `reqwest`, `serde`, `ignore`, `notify` are the
  obvious ones), JSON-RPC framing library vs. hand-rolled.
- Token counting approach (a cheap byte/char heuristic is acceptable).
- Precise completion stop heuristics and skip cases beyond those listed.
- Output truncation limits for `run_command`, file-size limits for the index.
- Chat-ui styling (follow each IDE's theme variables).
- CI setup (GitHub Actions matrix for the cross-compile targets).
- Logging: a `--log-level` flag and a log file under `.localpilot/`.

## 12. Build order

1. `core/` with mock-Ollama tests, `bench`, and the live assumption checks.
2. `chat-ui/`.
3. `vscode/` end-to-end, measured against the §5.5 targets.
4. `jetbrains/`.
5. Packaging (`.vsix`, plugin `.zip`), install on the owner's machine, manual
   smoke checklist.
