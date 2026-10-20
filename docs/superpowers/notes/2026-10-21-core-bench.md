# Core bench — measured numbers (2026-10-21)

Task 11 of `docs/superpowers/plans/2026-10-20-core.md`. All numbers below are
copied from actual runs of `./target/release/localpilot-core bench` on the
owner's machine.

## Machine and setup

- Apple M4 Pro, 48 GiB (`hw.memsize` = 51539607552), macOS 27.0.1 (26A434)
- Ollama 0.40.6 at `http://localhost:11434` (already running; not started by the bench). No `OLLAMA_*` environment variables set in the shell.
- Completion models: `qwen2.5-coder:1.5b-base` (default) and `qwen2.5-coder:0.5b-base` (pulled for this task). `ollama ps` after the runs: both loaded `100% GPU`, context 32768, runner `llamacpp`, keep-alive 30 min.
- Chat idle: the chat model `qwen3.8:27b-mlx` was never loaded during any run.
- Workspace: this repo (`/Users/dst/projects/ollama`, 45 indexed files); file `core/src/handlers.rs` (556 lines).
- Command: `bench --workspace /Users/dst/projects/ollama --file core/src/handlers.rs --n 20 [--model …]`. Cache off; 20 cursor positions at line ends evenly spread through the file; one warm-up request (end of line 0) not counted. Snippet block computed before timing.

Metric definitions: **core overhead** = request entered the engine → HTTP request to Ollama about to be sent; **TTFT** = request start → first streamed chunk; **total** = request start → result returned.

## Results summary

| Target | 1.5b (default), warm | 0.5b, warm |
|---|---|---|
| TTFT p50 ≤ 250 ms | **FAIL** 338.88 ms | PASS 115.45 ms |
| TTFT p95 ≤ 600 ms | PASS 391.79 ms | PASS 137.23 ms |
| Core overhead p95 < 5 ms | PASS 0.10 ms | PASS 0.07 ms |
| Idle RSS of `serve` ≤ 30 MB | PASS 14.0 MB (model-independent) | PASS |

Core overhead is two orders of magnitude under target in every run. TTFT is
model-bound: the default 1.5b model misses the p50 target in this bench; the
0.5b model meets all targets.

## Full output

### Run 1 — 1.5b, first run after model load (model was not resident)

The warm-up request loaded the model (TTFT 963 ms). The early timed requests
still show a post-load tail; this run's p95 is a load outlier, not the warm
number (see run 2).

```
LocalPilot core bench
  workspace     /Users/dst/projects/ollama
  file          core/src/handlers.rs (556 lines)
  model         qwen2.5-coder:1.5b-base @ http://localhost:11434
  requests      20 (cache off; 1 warm-up not counted); streamed 20, empty suggestions 9
  index build   16.8 ms (45 files)
  snippets      1.6 ms (warmed before timing)
  warm-up       overhead 0.1 ms, TTFT 962.9 ms, total 1010.5 ms
  RSS           before 7.7 MB, after 14.2 MB

metric (ms)            p50       p95       max
core overhead         0.04      0.08      0.09
TTFT                384.59   1089.64   1095.78
total               579.75   1385.69   1531.36

FAIL  TTFT p50 <= 250 ms (measured 384.59)
FAIL  TTFT p95 <= 600 ms (measured 1089.64)
PASS  core overhead p95 < 5 ms (measured 0.08)
PASS  bench RSS after run <= 30 MB (idle serve RSS is measured separately) (measured 14.19)
```

### Run 2 — 1.5b, warm (the number of record for the default model)

```
LocalPilot core bench
  workspace     /Users/dst/projects/ollama
  file          core/src/handlers.rs (556 lines)
  model         qwen2.5-coder:1.5b-base @ http://localhost:11434
  requests      20 (cache off; 1 warm-up not counted); streamed 20, empty suggestions 9
  index build   8.0 ms (45 files)
  snippets      0.7 ms (warmed before timing)
  warm-up       overhead 0.0 ms, TTFT 31.7 ms, total 77.4 ms
  RSS           before 7.7 MB, after 14.2 MB

metric (ms)            p50       p95       max
core overhead         0.04      0.10      0.13
TTFT                338.88    391.79    404.84
total               397.77    722.68    773.98

FAIL  TTFT p50 <= 250 ms (measured 338.88)
PASS  TTFT p95 <= 600 ms (measured 391.79)
PASS  core overhead p95 < 5 ms (measured 0.10)
PASS  bench RSS after run <= 30 MB (idle serve RSS is measured separately) (measured 14.16)
```

### Run 3 — 1.5b, warm, `--json` (per-sample data)

Summary: TTFT p50 339.10 / p95 396.13 / max 404.35 ms; overhead p50 0.047 /
p95 0.095 ms; total p50 398.9 / p95 730.5 ms; 9 empty suggestions; RSS 7.7 →
14.2 MB. Same verdicts as run 2.

Per-request `overhead ms / TTFT ms / total ms`, in file order:

```
0.032 316.6 727.6
0.031 387.6 545.2
0.110 362.8 526.1
0.048 346.9 375.6
0.037 366.2 366.2
0.047 336.9 401.2
0.031 341.3 405.9
0.032 348.3 435.0
0.055 345.1 784.7
0.025  13.3 309.4
0.062  23.2  61.9
0.060  23.9  95.6
0.067 270.3 270.4
0.040 381.0 396.7
0.064 282.2 324.3
0.061 404.3 597.4
0.025 259.9 276.1
0.094 395.7 559.8
0.069 221.3 641.5
0.034 206.7 216.0
```

The distribution is bimodal: 3/20 requests at 13–24 ms, 17/20 at 207–404 ms.

### Run 4 — 0.5b, first run (model pulled and loaded by the warm-up)

```
LocalPilot core bench
  workspace     /Users/dst/projects/ollama
  file          core/src/handlers.rs (556 lines)
  model         qwen2.5-coder:0.5b-base @ http://localhost:11434
  requests      20 (cache off; 1 warm-up not counted); streamed 20, empty suggestions 7
  index build   7.6 ms (45 files)
  snippets      0.7 ms (warmed before timing)
  warm-up       overhead 0.0 ms, TTFT 3561.3 ms, total 3647.1 ms
  RSS           before 7.7 MB, after 14.2 MB

metric (ms)            p50       p95       max
core overhead         0.03      0.11      0.18
TTFT                131.89    355.48    374.64
total               364.41    579.08    595.97

PASS  TTFT p50 <= 250 ms (measured 131.89)
PASS  TTFT p95 <= 600 ms (measured 355.48)
PASS  core overhead p95 < 5 ms (measured 0.11)
PASS  bench RSS after run <= 30 MB (idle serve RSS is measured separately) (measured 14.20)
```

### Run 5 — 0.5b, warm

```
LocalPilot core bench
  workspace     /Users/dst/projects/ollama
  file          core/src/handlers.rs (556 lines)
  model         qwen2.5-coder:0.5b-base @ http://localhost:11434
  requests      20 (cache off; 1 warm-up not counted); streamed 20, empty suggestions 7
  index build   7.3 ms (45 files)
  snippets      0.8 ms (warmed before timing)
  warm-up       overhead 0.0 ms, TTFT 12.4 ms, total 91.2 ms
  RSS           before 7.7 MB, after 14.4 MB

metric (ms)            p50       p95       max
core overhead         0.04      0.07      0.09
TTFT                115.45    137.23    141.58
total               216.34    399.03    410.35

PASS  TTFT p50 <= 250 ms (measured 115.45)
PASS  TTFT p95 <= 600 ms (measured 137.23)
PASS  core overhead p95 < 5 ms (measured 0.07)
PASS  bench RSS after run <= 30 MB (idle serve RSS is measured separately) (measured 14.42)
```

### Idle RSS of `serve`

`localpilot-core serve --workspace /Users/dst/projects/ollama` spawned by a
script; `initialize` sent with default settings, `index/ready` awaited, RSS
read with `ps -o rss= -p <pid>`, then `shutdown`:

```
initialize -> {"capabilities": {"bench": true, "chat": true, "completion": true}, "indexStatus": "building", "ollamaStatus": {"detail": "Ollama 0.40.6", "state": "ok"}}
index/ready after 18 ms: {"buildMs": 6, "files": 45}
RSS right after index/ready: 14.0 MB
RSS idle +2s: 14.0 MB
RSS idle +5s: 14.0 MB
RSS idle +10s: 14.0 MB
shutdown -> {"id":2,"jsonrpc":"2.0","result":{}}
exit code 0
```

Idle RSS 14.0 MB ≤ 30 MB: **PASS**.

## Caveats

- **Fresh prefixes are the pessimistic path.** The 20 positions are distinct and far apart, and the cache is off, so most requests send a prompt whose prefix window differs from the previous one (up to the ~3.5 k-token `completionContextTokens` budget). The slow mode (207–404 ms on 1.5b) is consistent with Ollama evaluating that prompt from scratch. The fast samples (13–24 ms) are consistent with Ollama reusing its KV cache for a shared prompt prefix — the case the engine is designed for while typing at one spot (stable snippet block + line-aligned prefix window). This is a hypothesis from the observed pattern; it was not investigated further. The bench does not simulate typing.
- **First-run load time** is excluded by the warm-up but shows in the first run after a load: 963 ms warm-up and a ~1.1 s p95 for 1.5b (run 1); 3.6 s warm-up for the freshly pulled 0.5b (run 4).
- **Both coder models were resident** during the 0.5b runs (1.5b was still within its keep-alive).
- **Empty suggestions** (9/20 for 1.5b, 7/20 for 0.5b): line-end cursors in Rust often get trimmed to nothing by the stop rules. This does not affect TTFT (measured at the first chunk).
- **Small repo**: index build 7–17 ms over 45 files; larger workspaces will take longer (the build is off the request path in `serve`).
- **Bench RSS vs idle RSS**: the bench process RSS (14.2 MB after 21 requests) is shown for reference; the target applies to idle `serve` RSS, measured separately above (14.0 MB).
- The bench uses the default settings (`http://localhost:11434`); it does not read `OLLAMA_HOST`.
- `bench` exits 0 if every check passes, 1 if any check fails, 2 if it could not run.
