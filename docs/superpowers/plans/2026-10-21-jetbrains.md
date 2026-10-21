# LocalPilot JetBrains (PyCharm) Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A JetBrains plugin (Kotlin) for PyCharm 2026.2 (and any IntelliJ-platform IDE) that spawns the Rust core, shows ghost-text inline completions — including inside `.ipynb` cells in PyCharm's notebook editor — and hosts the shared chat UI in a tool window with approval-gated edits/commands. Installable from a `.zip` on the owner's machine.

**Architecture:** Thin client over the same stdio JSON-RPC protocol as VS Code. `CoreProcess` spawns the bundled binary per project; `DocumentSyncListener` mirrors open documents (and notebook cells as virtual files, same scheme as the other clients); `LocalPilotInlineCompletionProvider` implements the platform's `InlineCompletionProvider`; `ChatToolWindow` hosts `chat-ui/dist/index.html` in JCEF with a `JBCefJSQuery`-backed `window.cefQuery` shim injected before the bundle runs; `workspace/applyEdit` → `WriteCommandAction` + `FileDocumentManager.saveDocument`; `workspace/runCommand` → `GeneralCommandLine` with capture.

**Tech Stack:** Kotlin 2.x, IntelliJ Platform Gradle Plugin 2.x, Gradle wrapper (no system Gradle), JDK 17 toolchain, `platformType = PY` (PyCharm Professional, for the notebook editor) with `pluginSinceBuild = 262`, kotlinx.serialization for JSON, JCEF (`JBCefBrowser`, `JBCefJSQuery`), platform test framework (`BasePlatformTestCase`) + JUnit for pure Kotlin.

**Spec:** `docs/superpowers/specs/2026-10-20-localpilot-design.md` §8.2 (+ §4.4, §5.2, §7, §8.3). Reuses `chat-ui/dist/index.html` (plan 2026-10-21-vscode Tasks 1–3; JCEF convention in `chat-ui/src/host.ts` `CefBridge`: UI→host `window.cefQuery({request: JSON})`, host→UI `window.postMessage(obj, "*")`) and the notebook virtual-file scheme (VS Code Task 5). Protocol: `core/src/protocol.rs`, `core/README.md`. Executors read the spec and those files.

## Global Constraints

- Wire protocol = `core/src/protocol.rs`; positions are `{line, character}` with `character` in UTF-16 code units — IntelliJ `Document` offsets are UTF-16, so `Document.getLineNumber(offset)` / `offset - getLineStartOffset(line)` map directly.
- One core per open project: `localpilot-core serve --workspace <project basePath> --log-level <level>`; binary bundled in the plugin at `lib/bin/<triple>/localpilot-core` (v1 `aarch64-apple-darwin`), overridable by setting `coreBinaryPath`; restart ≤ 3×/min then error notification; stdin close on project close.
- Never auto-start Ollama; `down` → notification with "Start Ollama" (opens the IDE terminal running `ollama serve`) and "Retry"; `modelMissing` → "Pull model" via `ollama/pull` with a progress indicator.
- Settings (Settings → Tools → LocalPilot), same keys/defaults as the core/VS Code (`ollamaUrl`, `completionModel` = `qwen2.5-coder:0.5b-base`, `chatModel` = `qwen3.8:27b-mlx`, `completionsEnabled`, `completionDebounceMs` 120, `completionMaxTokens` 32, `chatThinking`, `coreBinaryPath`, `allowedCommandsAlways`, `completionContextTokens` 3584, `chatContextTokens` 24000, `logLevel`); a change restarts the core.
- Completions: fire after `completionDebounceMs` quiet (the platform's `InlineCompletionProvider` has its own debounce — set it from the setting), cancel in-flight on the next event, honour coroutine cancellation → `completion/cancel`; report accepted/rejected.
- Notebook cells: in `.ipynb` files opened in PyCharm's notebook editor, each code cell is synced as `file://<notebook path>.cell<i>.<ext>` plus a `.cells.<ext>` concatenation document (same scheme as VS Code/JupyterLab); completions are offered inside code cells only; a cell edit maps to the right virtual document.
- Approved edits: applied in a `WriteCommandAction` (undoable), then `FileDocumentManager.saveDocument` for touched files only; files not open are loaded via `VirtualFile`/`Document` and saved; the core never writes.
- `run_command`: `GeneralCommandLine` with the project base dir (or `cwd` param, confined to the project), output captured (16 KB tails) and echoed to a "LocalPilot" console/tool window tab, 10-minute timeout.
- JCEF: `window.cefQuery` must exist before the bundle's module script runs (inject a `<script>` defining it from `JBCefJSQuery.inject(...)` at the top of the HTML; see VS Code Task 1 review note); host→UI via `browser.cefBrowser.executeJavaScript("window.postMessage(<json>, '*')")`; no external network from the page.
- Keymap: `Cmd+Shift+L` / `Ctrl+Shift+L` opens the chat tool window.
- `./gradlew test` and `./gradlew verifyPlugin` green before each commit; conventional commit messages; **no Co-Authored-By or other trailers**.

## Review Focus

1. **Notebook cursor → cell mapping** — a caret in cell 3 must yield the virtual URI for cell 3 with a position relative to the cell's start, including after cells are added/removed above (Task 4).
2. **Light-edit / non-project files** — scratch files, library sources and files outside the project must not be synced or completed (Task 3).
3. **EDT discipline** — no blocking I/O or core requests on the UI thread; document reads under `ReadAction`, writes under `WriteCommandAction`; the inline provider runs on its coroutine (Task 3–5).
4. **Core crash mid-chat** — turn ends with an error in the UI, completions resume after restart (Task 2 + Task 5).
5. **Approval with edited command** — edited string reaches `chat/approve.editedArgs` as the whole args object (`{...args, command}`), and the "always" key is the edited command (Task 5).

---

## File structure

```
jetbrains/
  build.gradle.kts, settings.gradle.kts, gradle.properties, gradle/wrapper/*, gradlew
  src/main/resources/META-INF/plugin.xml       id "dev.localpilot", depends com.intellij.modules.platform (+ optional notebooks module)
  src/main/resources/chat/index.html           copied from chat-ui/dist by scripts/package-jetbrains.sh
  src/main/kotlin/dev/localpilot/
    rpc/JsonRpc.kt                 message types + line codec (kotlinx.serialization)
    rpc/CoreProcess.kt             spawn, stdio reader/writer coroutines, request/notify/onNotification/onRequest, restart policy
    settings/LocalPilotSettings.kt PersistentStateComponent + Configurable (UI)
    sync/DocumentSyncListener.kt   FileEditorManagerListener + DocumentListener → didOpen/didChange/didClose/didSave
    sync/NotebookCells.kt          .ipynb → cell ranges, virtual URIs, concat doc, caret→cell mapping
    completion/LocalPilotInlineCompletionProvider.kt
    chat/ChatToolWindowFactory.kt  JCEF browser + cefQuery shim + bridge
    chat/ApplyEdit.kt, chat/RunCommand.kt
    status/LocalPilotStatusBarWidget.kt
    actions/*.kt                   OpenChat, StartOllama, PullModel, NewSession, ToggleCompletions, RestartCore
  src/test/kotlin/...              JsonRpcTest, CoreProcessTest (fake core = node vscode/test/fakeCore.mjs), NotebookCellsTest, DocumentSyncTest (BasePlatformTestCase), InlineProviderTest, ApplyEditTest
scripts/package-jetbrains.sh      build core → copy binary → build chat-ui → copy html → ./gradlew buildPlugin → dist/localpilot-<ver>.zip
```

---

### Task 1: Gradle project, plugin.xml, JSON-RPC codec

**Files:** build files + wrapper, `plugin.xml`, `rpc/JsonRpc.kt`, `JsonRpcTest.kt`

**Interfaces — Produces:** `sealed class RpcMessage { Request(id, method, params), Notification(method, params), Response(id, result?, error?) }`, `RpcError(code, message, data?)`, `encode(msg): String` (one line), `decode(line): RpcMessage?`; project builds with `./gradlew build` on JDK 17 against PyCharm 2026.2 (`platformType = PY`, version matching build 262 — implementer verifies the exact `platformVersion` string available in the plugin repository) and `verifyPlugin` passes.

- [ ] Failing tests: `encode_is_single_line`, `decode_request_notification_response`, `decode_tolerates_null_params`, `unknown_json_returns_null`.
- [ ] FAIL → implement → PASS → `./gradlew verifyPlugin` → commit `feat(jetbrains): gradle project, plugin.xml, JSON-RPC codec`

### Task 2: CoreProcess + settings

**Files:** `rpc/CoreProcess.kt`, `settings/LocalPilotSettings.kt`, `CoreProcessTest.kt`

**Interfaces — Produces:** `class CoreProcess(project, binary: Path, workspace: Path, settings)` (project `Service`): `suspend fun start(): InitializeResult`, `suspend fun <T> request(method, params, serializer): T` (coroutine-cancellable → sends `completion/cancel` for completion requests via a hook), `fun notify(method, params)`, `fun onNotification(method, handler)`, `fun onRequest(method, handler: suspend (params) -> result)` (answers core→client requests), `suspend fun stop()` (`shutdown`, wait ≤ 2 s, destroy), `val state: StateFlow<State>`; restart ≤ 3/min; pending requests fail with `CoreCrashed`; `resolveBinaryPath(settings)` (setting → bundled `lib/bin/<triple>` → error). `LocalPilotSettings` persistent state with the keys above + a `Configurable` form; `onChange → restart`.

- [ ] Failing tests (JUnit, real child process = `node <repo>/vscode/test/fakeCore.mjs`): `start_sends_initialize_and_returns_result`, `request_response_matching`, `server_to_client_request_answered`, `crash_rejects_pending_and_restarts`, `restart_limit_three_per_minute`, `stop_sends_shutdown`.
- [ ] FAIL → implement → PASS → commit `feat(jetbrains): core process client and settings`

### Task 3: Document sync (files)

**Files:** `sync/DocumentSyncListener.kt`, `DocumentSyncTest.kt`

**Interfaces — Produces:** on project open: `didOpen` for all open editors; `FileEditorManagerListener.fileOpened/fileClosed` → `didOpen/didClose`; `DocumentListener.documentChanged` → incremental `didChange` (`{range, text}` from `DocumentEvent` offsets → UTF-16 positions); `FileDocumentManagerListener.beforeDocumentSaving` → `didSave`; only local files under the project base path (`ProjectFileIndex.isInContent` and not library/scratch) — Review Focus 2; `replayOpen()` on core restart.

- [ ] Failing tests (`BasePlatformTestCase` with a fake core client recording calls): `opens_and_changes_content_file`, `ignores_scratch_and_library_files`, `offsets_map_to_utf16_positions_with_emoji`, `save_sends_didSave`, `replay_after_restart`.
- [ ] FAIL → implement → PASS → commit `feat(jetbrains): document sync`

### Task 4: Notebook cells

**Files:** `sync/NotebookCells.kt`, `NotebookCellsTest.kt`, hooks in `DocumentSyncListener`

**Interfaces — Produces:** `NotebookCells.forDocument(doc, file): List<Cell { index, kind: code|markdown|raw, language, startOffset, endOffset, id? }>` — implementer verifies against the installed PyCharm 2026.2 how the notebook editor exposes cells (the `com.intellij.notebooks.visualization` `NotebookCellLines` API when the notebooks module is available; fallback: parse the `.ipynb` JSON from the document text), and documents which path is used; `cellUri(file, index, ext)`, `concatUri(file, ext)`, `caretToCell(cells, offset) -> (cell, Position)` (Review Focus 1); sync emits per-cell virtual docs + the concat doc (200 ms debounce) like the other clients; markdown/raw not synced; closing the notebook closes all.

- [ ] Failing tests: `cells_parsed_with_offsets_and_kinds`, `caret_maps_to_cell_relative_position_after_insertion_above` (Review Focus 1), `virtual_uris_and_concat_doc`, `markdown_cells_skipped`.
- [ ] FAIL → implement → PASS → commit `feat(jetbrains): notebook cell sync`

### Task 5: Inline completion provider + chat tool window + edits/commands + actions + status

**Files:** `completion/LocalPilotInlineCompletionProvider.kt`, `chat/{ChatToolWindowFactory.kt,ApplyEdit.kt,RunCommand.kt}`, `status/LocalPilotStatusBarWidget.kt`, `actions/*.kt`, `plugin.xml` registrations, tests `InlineProviderTest`, `ApplyEditTest`, `RunCommandTest`

**Interfaces — Produces:**
- `LocalPilotInlineCompletionProvider : InlineCompletionProvider` (`id = "localpilot"`): `isEnabled(event)` per settings and syncable/notebook-cell check; `getSuggestion(request)` → map editor caret to (uri, position) — notebook-aware via `NotebookCells` — send `completion/request`, honour cancellation → `completion/cancel`, return a single-variant suggestion with the text; accepted → `completion/accepted` via the platform's insert handler; superseded → `completion/rejected`; `InlineCompletionProviderPresentation` text "LocalPilot".
- `ChatToolWindowFactory`: `JBCefBrowser` loading HTML = `<script>` cefQuery shim (`JBCefJSQuery.inject`) + `chat-ui/dist/index.html` body; bridge relaying `UiToHost` ⇄ core (`chat/send` with current session, `chat/stop`, `chat/approve` passing `editedArgs` through unchanged, sessions/history, `ui/ready` → `session/list` first then status; `ui/activeFile` from the selected editor + selection; `ui/insertAtCursor`; `ollama/start` → StartOllama action; `ollama/pull` → PullModel); core notifications → `window.postMessage`; core crash mid-turn → synthesized `chat/done {error}` + `ui/error` (Review Focus 4); theme: inject `--vscode-*` equivalents from `JBColor`/`UIUtil` as CSS variables at load and on LAF change.
- `ApplyEdit.apply(params): ApplyEditResult` — `edit` → `Document.replaceString` in `WriteCommandAction` (UTF-16 offsets from positions), `create` → create `VirtualFile` with contents; virtual cell URIs → the notebook document range for that cell; then save touched documents; never throws.
- `RunCommand.run(params): RunCommandResult` — `GeneralCommandLine` (shell), confined cwd, tails, timeout, echo to a console view.
- Status bar widget + actions as listed; keymap `Cmd+Shift+L`.

- [ ] Failing tests: `provider_requests_completion_for_caret_and_returns_text`, `provider_cancels_on_coroutine_cancel`, `provider_disabled_returns_nothing`, `provider_in_notebook_uses_cell_uri`, `applyEdit_replaces_range_and_saves_only_touched`, `applyEdit_targets_notebook_cell_range`, `applyEdit_returns_error_not_throw`, `runCommand_captures_tails_and_times_out`, `editedArgs_passed_through_unchanged` (Review Focus 5), `crash_mid_turn_emits_error_done` (Review Focus 4).
- [ ] FAIL → implement → PASS → commit `feat(jetbrains): inline completions, chat tool window, edits, commands`

### Task 6: Packaging, install, smoke

**Files:** `scripts/package-jetbrains.sh`, `jetbrains/README.md`, `.github/workflows/jetbrains.yml` (build + test on macOS)

- [ ] Script: build core → copy binary into the plugin's `lib/bin/<triple>/` (via Gradle `prepareSandbox`/resources) → `npm run build -w chat-ui` → copy html → `./gradlew buildPlugin` → `dist/localpilot-<ver>.zip`.
- [ ] Install into the owner's PyCharm 2026.2.3 (Settings → Plugins → Install from disk) — provide the exact path; `./gradlew runIde` works for dev.
- [ ] Manual smoke checklist in README: Ollama down notification; Start Ollama; pull model; ghost text in a `.py` file; ghost text inside a notebook cell; chat edit with approve → file saved; chat edit of a notebook cell; run command with deny.
- [ ] Commit `feat(jetbrains): packaging, README`

---

## Self-review notes

- Spec §8.2 coverage: target build 262 (T1), `InlineCompletionProvider` (T5), JCEF tool window with the shared bundle (T5), `WriteCommandAction` edits (T5), `GeneralCommandLine` (T5), Gradle wrapper/JDK 17 (T1), notebook requirement (T4 + T5).
- Known unknowns left to implementers with explicit verification steps: exact `platformVersion` string for 2026.2; the notebook cell API surface in PyCharm 2026.2; `InlineCompletionProvider` accept/reject hooks in build 262.
