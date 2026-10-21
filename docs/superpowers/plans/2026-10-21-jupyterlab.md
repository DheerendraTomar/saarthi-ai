# LocalPilot JupyterLab Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pip-installable JupyterLab 4 extension (`localpilot-jupyter`) that gives ghost-text inline completions in notebook cells and text editors, and a sidebar chat agent with approval-gated edits/commands — backed by the same Rust core, running under the Jupyter server.

**Architecture:** A `jupyter_server` extension (Python) owns one `localpilot-core serve` process per server and bridges it to browser tabs over a WebSocket (`/localpilot/rpc`, one JSON-RPC line per text frame), multiplexing tabs and answering `workspace/runCommand` itself. The labextension (TypeScript) reuses `@localpilot/rpc-client` over the WebSocket, syncs notebook cells as virtual files (same scheme as the VS Code plan), implements `IInlineCompletionProvider`, and hosts the shared `chat-ui` bundle in an iframe with a parent-window `postMessage` bridge.

**Tech Stack:** Python 3.11 (`jupyter_server` ≥ 2.10, `tornado`), `hatchling` + `hatch-jupyter-builder` for the wheel; TypeScript, `@jupyterlab/builder` 4.x, `@jupyterlab/completer`, `@jupyterlab/notebook`, `@jupyterlab/fileeditor`, `@jupyterlab/apputils`, `@jupyterlab/terminal`; tests: `pytest` + `pytest-jupyter` (server), `jest` via `@jupyterlab/testing` (frontend), vitest for the pure helpers.

**Spec:** `docs/superpowers/specs/2026-10-20-localpilot-design.md` §8.4 (plus §4.4 protocol, §5.2, §7). Reuses: `chat-ui/` (plan 2026-10-21-vscode Tasks 1–3), `rpc-client/` (VS Code Task 4), notebook virtual-file scheme (VS Code Task 5). Executors read the spec and the referenced reports.

## Global Constraints

- Wire protocol = `core/src/protocol.rs`; the server bridge never parses JSON-RPC bodies except to rewrite ids for multiplexing and to intercept `workspace/runCommand`.
- One core per Jupyter server, workspace = `ServerApp.root_dir`; spawn lazily; restart ≤ 3×/min then report `down` with detail; stop on server exit; never auto-start Ollama.
- `workspace/runCommand` answered server-side: `shell=True`, cwd = root_dir (or `cwd` param, confined to root_dir), stdout/stderr tails 16 KB, 10-minute timeout; `workspace/applyEdit` forwarded to the tab whose `chat/send` started the turn.
- Virtual URIs for cells: `file://<abs notebook path>.cell<i>.<ext>` and `file://<abs notebook path>.cells.<ext>` (ext from the kernel language: `py`, `r`, `jl`, …); markdown/raw cells are not synced; closing a notebook `didClose`s all of them.
- Completions: provider respects JupyterLab's own debounce; abort → `completion/cancel`; empty items → no suggestion; accepted/rejected reported.
- Approved edits are applied to the cell/document model and the notebook/file is saved; the core never writes.
- Settings keys = §4.4 names, via the settings registry; change → `POST /localpilot/restart`.
- Binary bundled in the wheel at `localpilot_jupyter/bin/<triple>/localpilot-core` (v1: `aarch64-apple-darwin`); overridable by `LOCALPILOT_CORE_BINARY` env or `c.LocalPilot.core_binary`.
- No telemetry; no network from the browser except the Jupyter server's own origin (CSP/XSRF respected).
- Host contract with `chat-ui` (learned from the VS Code final review): send core notifications to the UI flattened as `{ type: <method>, ...params }`; on `ui/ready` send `session/list` **before** any turn event, then `session/history`, then `status`; pass `chat/approve.editedArgs` through whole; keep the full `chat/toolCall` params of calls still awaiting a decision per session and re-post them after `session/history`; send `chat/turnState { sessionId, running }` so the UI shows Stop; Stop targets the session whose turn is running; always send `completionsEnabled: true` to the core and gate completions client-side.
- `@localpilot/rpc-client` ships TypeScript source (`main: ./src/index.ts`): the labextension build must transpile it (include it in the TS project or bundle via the builder's webpack config).
- `pytest` and `jlpm test` green, `jlpm lint` clean before each commit; conventional commit messages; **no Co-Authored-By or other trailers**.

## Review Focus

1. **Two tabs, one core** — a completion request from tab A must never receive tab B's response (id namespacing), and tab B closing must not kill tab A's turn (Task 1).
2. **Notebook with non-Python kernel / no kernel yet** — cells must map to an extension from the kernel language when known and to `txt` otherwise, without throwing (Task 3).
3. **Server restart while a chat turn streams** — the UI must end the turn with an error, and reconnect the WebSocket with backoff (Task 2 + Task 5).
4. **XSRF / auth** — the WebSocket and REST endpoints must require the Jupyter token/cookie like every other server endpoint (Task 1).
5. **Edit to a cell that was deleted/moved during approval** — apply by cell id captured at proposal time, fail cleanly if gone (Task 5).

---

## File structure

```
jupyterlab/
  pyproject.toml                 hatchling + hatch-jupyter-builder; package localpilot_jupyter
  package.json                   labextension name "localpilot-jupyter", @jupyterlab/builder
  tsconfig.json, jest.config.js
  localpilot_jupyter/
    __init__.py                  _jupyter_server_extension_points, _jupyter_labextension_paths
    app.py                       LocalPilotApp(ExtensionApp): config traits (core_binary, log_level), handlers
    core_process.py              CoreProcess: spawn/restart/stop, stdin writer, stdout line reader, broadcast
    bridge.py                    RpcWebSocket handler: per-tab id namespace, routing table for core→client requests
    commands.py                  run_command(params, root_dir) -> result (confinement, capture, timeout)
    handlers.py                  StatusHandler (GET /localpilot/status), RestartHandler (POST /localpilot/restart)
    bin/<triple>/localpilot-core (copied by scripts/build-core.sh; git-ignored)
  tests/ (pytest)                test_core_process.py, test_bridge.py, test_commands.py, conftest.py (fake core = node vscode/test/fakeCore.mjs reused)
  src/
    index.ts                     plugin activation: settings, client, sync, provider, chat, commands, status
    client.ts                    WsCoreClient: WebSocket + RpcEndpoint, reconnect/backoff, onStatus
    settings.ts                  read ISettingRegistry → Settings; onChange → restart
    documentSync.ts              notebook cells (virtual URIs) + file editors → didOpen/didChange/didClose/didSave
    cellUri.ts                   pure helpers: cellUri(nbPath, idx, ext), concatUri, extForLanguage
    inlineProvider.ts            IInlineCompletionProvider implementation
    chat/chatWidget.ts           sidebar Widget with iframe(srcdoc = chat-ui bundle) + parent postMessage bridge
    chat/applyEdit.ts            virtual URI → cell (by id) / file → model edit + save
    commands.ts                  localpilot:open-chat, start-ollama (terminal), pull-model, new-session, toggle-completions
    status.ts                    status bar item
  schema/plugin.json             settings schema (localpilot.* keys)
  style/index.css
  test/ (jest)                   cellUri.test.ts, documentSync.test.ts, inlineProvider.test.ts, applyEdit.test.ts
chat-ui/src/host.ts              + IframeBridge (parent-window postMessage), selected when window.parent !== window and no VS Code/JCEF api
scripts/package-jupyterlab.sh    build core → copy binary → build chat-ui → jlpm build:prod → python -m build → dist/*.whl
```

---

### Task 1: Python package, core process manager, WebSocket bridge, runCommand

**Files:** `jupyterlab/pyproject.toml`, `localpilot_jupyter/{__init__.py,app.py,core_process.py,bridge.py,commands.py,handlers.py}`, `jupyterlab/tests/{conftest.py,test_core_process.py,test_bridge.py,test_commands.py}`

**Interfaces — Produces:**
- `CoreProcess(binary: Path, workspace: Path, log_level: str)`: `async start()`, `async stop()`, `send_line(str)`, `add_listener(cb: Callable[[str], None]) -> remove`, `state: "stopped"|"starting"|"ready"|"crashed"`, restart policy ≤ 3/min; `initialize` is sent by the server on start with the settings from the first client (stored) and the result cached for later tabs (they get a synthetic `initialize` response).
- `RpcWebSocket` (`/localpilot/rpc`, auth required): on open registers a tab id; outgoing client→core: rewrites numeric ids to `<tab>:<id>` strings (JSON-RPC allows string ids) and forwards; core→client responses are routed back by prefix; notifications are broadcast to all tabs (chat notifications filtered by `sessionId` ownership map: `sessionId → tab`); core→client requests `workspace/applyEdit` routed to the owning tab, `workspace/runCommand` answered by `commands.run_command`; on tab close: pending requests to that tab answered with an error to the core.
- `run_command(params, root_dir) -> {exitCode, stdout, stderr}` with cwd confinement, tails, timeout.
- `GET /localpilot/status` → `{ core: state, ollama: last status or null }`; `POST /localpilot/restart` → restarts the core (used on settings change).
- Fake core for tests: reuse `vscode/test/fakeCore.mjs` (written in VS Code Task 4) via `node`; conftest provides its path.

- [ ] Failing tests: `core_process_starts_and_answers_initialize`, `crash_restarts_then_gives_up_after_3`, `two_tabs_get_their_own_completion_responses` (Review Focus 1), `closing_tab_does_not_affect_other_tab_turn`, `apply_edit_routed_to_owning_tab`, `run_command_answered_server_side_with_confined_cwd`, `endpoints_require_auth` (Review Focus 4).
- [ ] FAIL → implement → PASS (`pytest jupyterlab/tests`) → commit `feat(jupyterlab): server extension with core bridge`

### Task 2: Labextension scaffold, WsCoreClient, settings, status

**Files:** `jupyterlab/{package.json,tsconfig.json,jest.config.js}`, `src/{index.ts,client.ts,settings.ts,status.ts}`, `schema/plugin.json`, `style/index.css`, `test/client.test.ts`

**Interfaces — Produces:** `WsCoreClient` wrapping `RpcEndpoint` from `@localpilot/rpc-client` over a `WebSocket` to `/localpilot/rpc` (URL from `ServerConnection.makeSettings()` with token/XSRF), auto-reconnect with backoff 0.5 s→10 s, `onReconnect` resends `didOpen` for all synced docs (hook for Task 3), `onStatus(cb)`; `readSettings(registry)` and `onSettingsChange → POST /localpilot/restart`; status bar item text mirrors VS Code's.

- [ ] Failing tests (jest with a mock WebSocket): `connects_and_initializes_with_settings`, `reconnects_with_backoff_and_replays_didOpen`, `disconnect_mid_turn_rejects_pending_and_emits_error` (Review Focus 3).
- [ ] FAIL → implement → PASS (`jlpm test`) → `jlpm build` succeeds → commit `feat(jupyterlab): extension scaffold, websocket core client, settings`

### Task 3: Document sync for notebooks and file editors

**Files:** `src/{cellUri.ts,documentSync.ts}`, `test/{cellUri.test.ts,documentSync.test.ts}`

**Interfaces — Produces:** `extForLanguage(lang: string | undefined): string` (`python→py`, `r→r`, `julia→jl`, else `txt`); `cellUri(nbPath, index, ext)`, `concatUri(nbPath, ext)`; `DocumentSync(client, notebookTracker, editorTracker)`: on notebook open/cell add/remove/move/change → full-text `didChange` of affected cell docs (cell docs are re-indexed on structural changes: close old indices, open new), concat doc updated with 200 ms debounce; notebook save → `didSave` for all its docs; file editors (`IEditorTracker`) sync as `file://<abs path>`; `replayOpen()` for reconnects.

- [ ] Failing tests: `cells_map_to_virtual_uris_and_concat`, `markdown_cells_not_synced`, `unknown_kernel_language_uses_txt` (Review Focus 2), `cell_move_reindexes_docs`, `close_notebook_closes_all_virtual_docs`, `replay_resends_all_open_docs`.
- [ ] FAIL → implement → PASS → commit `feat(jupyterlab): notebook and editor document sync`

### Task 4: Inline completion provider

**Files:** `src/inlineProvider.ts`, `test/inlineProvider.test.ts`, registration in `index.ts`

**Interfaces — Produces:** `LocalPilotInlineProvider implements IInlineCompletionProvider` (`identifier = "localpilot"`, `name = "LocalPilot"`): `fetch(request, context)` → resolves the cell/editor's virtual or file URI + cursor (UTF-16), skips if completions disabled or doc not synced, sends `completion/request` with a fresh `requestId`, maps items to `IInlineCompletionItem { insertText }`, wires `context`'s abort/cancellation (JupyterLab 4.1+ passes an `AbortSignal` via `request`? — implementer verifies the exact API for 4.5 and documents it) → `completion/cancel`; `completion/accepted` on item accept (via the completer's `onAccept` hook if available in 4.5, else via a document-change heuristic — document the choice), `completion/rejected` when superseded.

- [ ] Failing tests: `fetch_sends_request_for_cell_uri_with_utf16_position`, `abort_sends_cancel`, `empty_items_yield_no_suggestion`, `disabled_returns_empty_without_request`.
- [ ] FAIL → implement → PASS → commit `feat(jupyterlab): inline completion provider`

### Task 5: Chat sidebar, iframe bridge, applyEdit, commands

**Files:** `chat-ui/src/host.ts` (+ `IframeBridge`, tests in `chat-ui/test/host.test.ts`), `src/chat/{chatWidget.ts,applyEdit.ts}`, `src/commands.ts`, `test/applyEdit.test.ts`, `test/chatWidget.test.ts`

**Interfaces — Produces:** `IframeBridge`: UI→host `window.parent.postMessage(msg, "*")`, host→UI `iframe.contentWindow.postMessage(msg, "*")`, in-memory state; selected in `createHostBridge` after VS Code and JCEF checks when `window.parent !== window`. `ChatWidget` (sidebar, `id = "localpilot-chat"`): iframe `srcdoc` = chat-ui bundle (imported as text at build time), relays `UiToHost` ⇄ core exactly like VS Code Task 6 (`chat/send` with current session, sessions, history, `ui/activeFile` from the active cell/editor, `ui/insertAtCursor` into the active cell, `ollama/start` → `commands.startOllama`); `applyEdit(params)`: virtual cell URI → cell resolved by its virtual URI at apply time (DocumentSync re-indexes moved cells synchronously) and then by id, edit via `sharedModel.updateSource`, else file via `docManager` model, then `context.save()`; returns `{applied, error}` (Review Focus 5). Commands: open chat (`Alt Shift L` — `Accel Shift L` is JupyterLab's New Launcher), start Ollama (open a JupyterLab terminal, send `ollama serve\n`), pull model, new session, toggle completions, restart core.

- [ ] Failing tests: `iframe_bridge_posts_to_parent_and_receives_from_parent`, `chatWidget_relays_send_with_session_and_forwards_tokens`, `applyEdit_edits_cell_by_id_and_saves`, `applyEdit_fails_cleanly_when_cell_gone` (Review Focus 5), `applyEdit_edits_file_model_and_saves`, `core_disconnect_mid_turn_shows_error` (Review Focus 3).
- [ ] FAIL → implement → PASS → commit `feat(jupyterlab): chat sidebar, edit application, commands`

### Task 6: Packaging, install, smoke

**Files:** `scripts/package-jupyterlab.sh`, `jupyterlab/README.md`, `.github/workflows/jupyterlab.yml` (lint + tests)

- [ ] Script: build core → copy binary into `localpilot_jupyter/bin/<triple>/` → `npm run build -w chat-ui` → `jlpm build:prod` → `python -m build --wheel` → `dist/localpilot_jupyter-<ver>-py3-none-any.whl` (platform-tag note: v1 wheel is effectively macOS-arm only; document).
- [ ] Install into the owner's pyenv Python: `pip install dist/*.whl` → `jupyter server extension list` and `jupyter labextension list` show it enabled.
- [ ] Manual smoke checklist in README (Ollama down banner; start Ollama from the terminal command; ghost text in a Python cell; chat edit of a cell with approve → notebook saved; run command with deny), walked by the owner.
- [ ] Commit `feat(jupyterlab): packaging, install, README`

---

## Self-review notes

- Spec §8.4 coverage: server-owned core + WS bridge + multiplexing + server-side runCommand (T1); settings/restart (T2); virtual-file sync (T3); provider (T4); chat/iframe/applyEdit/terminal (T5); wheel + binary (T6).
- Shared code: `@localpilot/rpc-client` and `chat-ui` are consumed, not copied; `fakeCore.mjs` reused for Python tests.
- Open API detail left to the Task 4 implementer: exact abort/accept hooks of `@jupyterlab/completer` in 4.5 (verify against installed node_modules).
