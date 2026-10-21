# localpilot-core

The Rust sidecar behind LocalPilot, a Copilot-style plugin for VS Code and
PyCharm that runs entirely against a local [Ollama](https://ollama.com). One
core process serves one workspace: IDE clients spawn it and speak
newline-delimited JSON-RPC 2.0 over stdio. It owns the document overlay
(unsaved buffers), the workspace index, the inline completion engine (FIM via
`/api/generate`) and the agent chat (tool calling via `/api/chat`). The core
never writes workspace files itself: edits and commands are sent to the client
as `workspace/applyEdit` / `workspace/runCommand` requests.

Design: [`docs/superpowers/specs/2026-10-20-localpilot-design.md`](../docs/superpowers/specs/2026-10-20-localpilot-design.md).

## Build

```sh
bash scripts/build-core.sh          # from the repo root
```

Builds `--release` for the host triple (`rustc -vV`, e.g. `aarch64-apple-darwin`)
and copies the binary to `dist/core/<target-triple>/localpilot-core`
(`localpilot-core.exe` on Windows). Set `TARGET=<triple>` to cross-build for an
installed rustup target. CI (`.github/workflows/core.yml`) runs fmt, clippy and
tests on macOS arm64, then builds release artifacts for `aarch64-apple-darwin`,
`x86_64-apple-darwin`, `x86_64-unknown-linux-gnu` and `x86_64-pc-windows-msvc`
(only the arm64 macOS build is required to pass in v1).

## CLI

```text
localpilot-core serve --workspace <dir> [--log-level <filter>]
localpilot-core bench --workspace <dir> --file <path> [--n <count>] [--model <name>] [--max-tokens <n>] [--json] [--mode spread|typing]
```

`serve` — JSON-RPC over stdio for one workspace, until `shutdown` or stdin EOF.

- `--workspace <dir>`: workspace root.
- `--log-level <filter>`: a level (`error`, `warn`, `info`, `debug`, `trace`)
  or a `tracing` directive such as `localpilot_core=debug`. Default `info`.
- Stdout is the protocol channel only. Logs are appended to
  **`<workspace>/.localpilot/core.log`** (never stdout).

`bench` — measures completion latency against the local Ollama (spec §5.5).

- `--workspace <dir>`: workspace root to index.
- `--file <path>`: file to complete in, relative to the workspace.
- `--n <count>`: timed completions after one uncounted warm-up. Default `20`.
- `--model <name>`: completion model. Default: the settings default
  (`qwen2.5-coder:0.5b-base`).
- `--max-tokens <n>`: completion max tokens (`num_predict`). Default: the
  settings default (`32`).
- `--json`: print the report as one JSON object.
- `--mode spread|typing`: `spread` (default, worst case) completes at line ends
  spread across the file, so prompts are fresh; `typing` types one character
  per request at one spot (the keystroke path).
- Uses the default Ollama URL `http://localhost:11434` (it does not read
  `OLLAMA_HOST`). Exits 0 if every check passes, 1 if any fails, 2 if it could
  not run.

## Protocol

The protocol is specified in §4.4 of the
[design spec](../docs/superpowers/specs/2026-10-20-localpilot-design.md#44-protocol-json-rpc-20-newline-delimited-over-stdio);
the wire types (method names, params, results, notifications) are in
[`src/protocol.rs`](src/protocol.rs). All keys and enum strings are camelCase;
`Position.character` counts UTF-16 code units.

Additions beyond the spec:

- **`textDocument/didSave { uri }`** (notification): the client reports a save;
  the core refreshes that file's related-code snippets.
- **`index/ready { files, buildMs }`** (notification): emitted once the
  background workspace index build finishes.
- **`InitializeResult.indexStatus`** (`"building" | "ready"`): `initialize`
  returns `{ capabilities, ollamaStatus, indexStatus }`.
- **`sessionId` on `workspace/applyEdit` and `workspace/runCommand`**: both
  requests carry the `sessionId` of the chat turn that asked for them, so a
  client serving several sessions (the JupyterLab bridge) can route them.
- **`ollama/models {}`** → `{ models: [{ name, sizeBytes, family?,
  supportsInsert, supportsTools }] }`: the models installed in Ollama, in
  `/api/tags` order. The capabilities come from one `/api/show` per model
  (`"insert"` = fill-in-the-middle, usable for completions; `"tools"` = usable
  for agent chat); if `/api/show` fails for a model, or takes over 3 s, both
  are `false` (at most 8 `/api/show` calls run at once).
  `family` is omitted when Ollama reports none. Ollama unreachable (or not
  answering within 10 s) fails with `-32000`, never an empty list.
- **`chat/deleteSession { sessionId }`** → `{}`: removes
  `.localpilot/sessions/<sessionId>.json`. A session without a file (one that
  never ran a turn, or already deleted) is not an error. Refused with
  `-32602` (message starts with `turn running`) while a turn runs in that
  session; other sessions can be deleted meanwhile. An invalid id is `-32602`.
- **`chat/clearSessions {}`** → `{ deleted, skipped }`: deletes every saved
  session file (unreadable ones too) except those of sessions with a running
  turn; `skipped` lists the ids of all sessions with a running turn.
- **`completion/outcome { requestId, outcome, acceptedText? }`**
  (notification), `outcome` one of `"accepted" | "partial" | "rejected" |
  "typedThrough"`: what the user did with a served suggestion.
  `completion/accepted` and `completion/rejected` keep working and mean
  `accepted` / `rejected`. Each served suggestion is appended once to
  **`<workspace>/.localpilot/completions.jsonl`** when its outcome arrives:
  `{ ts, requestId, lang, ext?, promptHash, contextTail, suggestion, lines,
  outcome, acceptedText?, ttftMs, totalMs, model?, maxLines?, numPredict? }`
  - `ts` Unix ms when served; `lang` lower-case (`"python"`, …, `"other"`);
    `ext` the file's lower-case extension.
  - `promptHash` = first 16 hex digits of SHA-256 of prompt `\0` suffix.
  - `contextTail` = at most 200 characters before the cursor — no other file
    content is logged.
  - `acceptedText` only for `accepted` / `partial`, cut to the suggestion's
    length.
  - `ttftMs` is `null` for a cache hit or a joined generation.
  - `model`, `maxLines` (stop-rule line cap) and `numPredict` are the limits
    in effect for that request.

  A suggestion with no outcome within 60 s (or once 64 newer ones are
  waiting) is logged as `rejected` and a later outcome for it is ignored; a
  late outcome (after 60 s) is still recorded with its real outcome if
  nothing expired it first (expiry is lazy: on the next served suggestion or
  outcome). On `shutdown` (or stdin EOF) every suggestion still waiting is
  logged as `rejected`. Writing happens on a background writer, never on the
  request path. The file is rotated past 10 000 lines, keeping the newest
  5 000. Resetting learning writes `completions.meta.json`
  (`{ "learningResetAt": ms }`); the log itself is never truncated.
- **`completion/stats {}`** → `{ languages: { [lang]: { served, accepted,
  partial, rejected, typedThrough, acceptRate, learnedMaxLines,
  learnedNumPredict, examples } }, logPath, adaptive }`: outcome counts per
  language since the last learning reset (written outcomes only; the call
  waits for queued ones). `acceptRate` = `(accepted + partial) / served`.
  `learnedMaxLines` / `learnedNumPredict` / `examples` (a count) are what
  the policy yields now, i.e. what the next snippet refresh applies (the
  configured `8` / `completionMaxTokens` / `0` with too few outcomes or when
  `adaptive` is `false`). `logPath` is `null` before `initialize`.
- **`completion/resetLearning {}`** → `{}`: forgets everything learned (counts,
  learned limits, examples — at once, for every open file) and records the
  reset in `completions.meta.json`; the log file keeps every record.
- **Adaptive completions** (setting **`adaptiveCompletions`**, default `true`).
  From the newest 50 logged outcomes of the file's language, the engine picks
  the multi-line cap and `num_predict`:
  - Records served with `maxLines` 1 (single-line mode, or while a learned
    cap of 1 was in effect) are left out: they say nothing about multi-line
    length. Fewer than 10 left → the configured values (cap 8,
    `completionMaxTokens`). This also means a learned cap of 1 is revisited
    once ~40 newer one-line records push the older ones out of the 50.
  - Suggestions are bucketed by lines (1 / 2–4 / 5–8, longer → 5–8); each
    bucket with ≥ 3 records is scored by accepted characters per served
    suggestion (`accepted`: the suggestion, `partial`: `acceptedText`,
    `rejected` / `typedThrough`: 0). The best bucket wins (ties → shorter);
    if no bucket scores above 0 (mostly rejections), the 1-line bucket wins.
  - Cap = the bucket's upper bound (1, 4 or 8), applied in multi-line mode
    only (single-line mode always stops at the line end). `num_predict` =
    1.5 × the longest accepted text of the bucket in tokens, bounded to
    [16, 2 × `completionMaxTokens`] (16 when nothing was accepted; never 0).
  - **Style examples:** up to 3 of the most recent `accepted` suggestions of
    the same language with ≥ 2 lines, newest first, each as
    `<comment> Example\n<contextTail>\n<suggestion>\n\n` (the language's
    line comment), ≤ 300 tokens together. They lead the snippet block and
    take their tokens out of the snippet budget (768 by default), so the
    prompt stays within `completionContextTokens`.
  - Learned limits and examples are computed only when a file's snippet block
    is refreshed (open, save, watcher change, or 60 s old) and stored with it;
    requests only read them, so the prompt stays byte-identical while typing
    and Ollama's KV cache keeps working. `maxLines` / `numPredict` in each log
    record are the values that were in effect.
  - `adaptiveCompletions: false`: configured limits and no examples; outcomes
    are still logged.
- **One Ollama status shape everywhere: `{ ollama, detail }`**, with
  `ollama` one of `"ok" | "down" | "modelMissing"`. It is
  `InitializeResult.ollamaStatus`, the `ollama/status` result and the params
  of the `status` notification.

Behaviour to rely on:

- **`initialize` responds before the index is built**, with
  `indexStatus: "building"`; wait for `index/ready` if you need the index.
  On a small workspace **`index/ready` can arrive before the `initialize`
  response**: treat `index/ready` as final whenever it arrives, and do not let
  a later `indexStatus: "building"` overwrite it.
- **Settings are taken only at `initialize`.** There is no way to change them
  on a running core (a second `initialize` is refused): to apply changed
  settings, restart the core.
- `status` is sent when the Ollama status changes, and also after a failed
  chat turn (even if unchanged), so a transient chat error never leaves the
  client showing `down` while Ollama is healthy.
- Workspace paths: the core keeps the root the way the client spells it
  (symlinks unresolved), so `workspace/applyEdit` URIs match the client's
  document URIs; confinement and the index use the resolved root.
- The agent's `edit_file` / `create_file` never write under `.git/` or
  `.localpilot/` (any path component, case-insensitive), whatever the user's
  approvals. `read_file` refuses files over 1 MB on disk (the index limit).
- The core's state lives in `<workspace>/.localpilot/` (`core.log`,
  `sessions/`, `completions.jsonl`, `completions.meta.json`); it creates `.localpilot/.gitignore` (`*`) together with the log.
- **Notifications that arrive before `initialize` has been handled are dropped**
  (logged), so send `didOpen` etc. after the `initialize` response. Requests
  other than `initialize` / `shutdown` before then fail with `-32600`; a second
  `initialize` is refused with `-32600`.
- **`chat/send` returns `{}` immediately** once the turn is queued. The turn
  streams `chat/token`, `chat/toolCall`, `chat/toolResult`; its end is signalled
  **only** by `chat/done`.
- `chat/send` while a turn is already running in that session fails with
  **`-32602`** (invalid params).
- `capabilities` is `{ completion: true, chat: true, bench: false }`:
  `bench/run` is not served over RPC (it answers `-32601`); use the `bench`
  subcommand.
- `ollama/pull` streams `ollama/pullProgress` notifications and responds when
  the pull finishes.

Error codes: `-32600` invalid request, `-32601` method not found, `-32602`
invalid params, `-32603` internal error (also used when a core→client request
times out or the connection closes before the client answers), `-32000` Ollama
down, `-32001` model missing, `-32002` cancelled.

## Ollama environment

Verified on Ollama 0.40.6, Apple M4 Pro 48 GB
([notes](../docs/superpowers/notes/2026-10-20-ollama-assumptions.md)):

- Default models: `qwen2.5-coder:0.5b-base` (completion, FIM through
  `/api/generate` + `suffix`, no raw template; `completionMaxTokens` 32 — see
  Measured performance) and `qwen3.8:27b-mlx` (chat,
  native `tool_calls`).
- **`OLLAMA_MAX_LOADED_MODELS` does not need to be set**: with defaults
  (unset) both models stayed resident on the 48 GB test machine; other values
  are untested.
- Every generate/chat request sends `keep_alive` (setting `keepAlive`, default `30m`) so the
  models stay loaded.
- Chat thinking defaults off (`chatThinking: "off"` → `think:false`); thinking
  roughly doubles latency even on trivial prompts.
- Expect ~10 s for the first chat request after a cold start (5.8 s model
  load); the first completion after a load takes about a second.

## Measured performance

From [`2026-10-21-core-bench.md`](../docs/superpowers/notes/2026-10-21-core-bench.md)
(Apple M4 Pro, warm models, `--n 20` on `core/src/handlers.rs`):

| Target | 1.5b spread (worst case) | 1.5b typing (keystroke path) | 0.5b spread | 0.5b typing |
|---|---|---|---|---|
| TTFT p50 ≤ 250 ms | **FAIL** 338.88 ms | PASS 220.52 ms | PASS 115.45 ms | PASS 81.12 ms |
| TTFT p95 ≤ 600 ms | PASS 391.79 ms | PASS 221.72 ms | PASS 137.23 ms | PASS 83.86 ms |
| Core overhead p95 < 5 ms | PASS 0.10 ms | PASS 0.05 ms | PASS 0.07 ms | PASS 0.11 ms |
| Idle RSS of `serve` ≤ 30 MB | PASS 14.0 MB (model-independent) | | | |

TTFT is model-bound; core overhead is ~50× under target.

**What the user waits for is the bench's `total` column, not TTFT**: the client
receives one final completion (no streaming to the editor), so ghost text
appears after the whole generation. Re-measured on total (typing mode, `--n 20`,
p50 / p95 ms;
[details](../docs/superpowers/notes/2026-10-21-core-bench.md#re-measurement-on-total-2026-10-21)):

| max tokens | 1.5b total | 0.5b total |
|---|---|---|
| 64 | 628 / 640 | 295 / 300 |
| 32 | 426 / 429 | **211 / 212** |
| 16 | 326 / 327 | 146 / 147 |

Rule: the largest max tokens whose typing-mode total meets p50 ≤ 250 ms and
p95 ≤ 600 ms, preferring 1.5b at equal max tokens. 1.5b misses p50 at every
setting (TTFT alone is ≈ 222 ms), so the defaults are
**`qwen2.5-coder:0.5b-base` with `completionMaxTokens` 32** (spread mode, the
worst case: total p50 262 / p95 464 ms). Trade-off: 32 tokens is about 2–4
short lines, so multi-line suggestions are shorter than the 8-line cap allows;
users who prefer longer or higher-quality suggestions can set
`completionModel` / `completionMaxTokens` and accept the latency above.

### Known limits

- **Index memory**: RSS of `serve` with a built index is ≈ 154 MB at 11k files
  (measured); extrapolated ≈ 600 MB at 50k files. The follow-up is interning
  identifiers in the symbol index.

## Tests and bench

```sh
cd core
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

The tests need no running Ollama: they use a mock Ollama server
(`tests/support`), including end-to-end tests that drive the real binary over
stdio (`tests/e2e_stdio.rs`).

To benchmark against your local Ollama (models pulled, Ollama running):

```sh
cd core
cargo build --release
./target/release/localpilot-core bench --workspace .. --file core/src/handlers.rs --n 20
./target/release/localpilot-core bench --workspace .. --file core/src/handlers.rs --n 20 --mode typing
```
