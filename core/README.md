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
localpilot-core bench --workspace <dir> --file <path> [--n <count>] [--model <name>] [--json] [--mode spread|typing]
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
  (`qwen2.5-coder:1.5b-base`).
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

Behaviour to rely on:

- **`initialize` responds before the index is built**, with
  `indexStatus: "building"`; wait for `index/ready` if you need the index.
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

- Default models: `qwen2.5-coder:1.5b-base` (completion, FIM through
  `/api/generate` + `suffix`, no raw template) and `qwen3.8:27b-mlx` (chat,
  native `tool_calls`).
- **`OLLAMA_MAX_LOADED_MODELS` does not need to be set**: with defaults
  (unset) both models stay resident on 48 GB. Set it to `2` or more if your
  Ollama evicts one model when the other loads.
- Every request sends `keep_alive` (setting `keepAlive`, default `30m`) so the
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

TTFT is model-bound; core overhead is ~50× under target. The default
completion model stays `qwen2.5-coder:1.5b-base` (it meets both TTFT targets on
the keystroke path); `qwen2.5-coder:0.5b-base` meets every target and is an
option for more headroom.

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
