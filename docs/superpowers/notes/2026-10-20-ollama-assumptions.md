# Ollama assumptions — verified on the target machine

- Date: 2026-10-20
- Machine: macOS, Apple Silicon M4 Pro, 48 GB
- Ollama: `{"version":"0.40.6"}` (already running at `http://localhost:11434`)
- Models: `qwen2.5-coder:1.5b-base` (gguf, Q4_K_M, runner `llamacpp`), `qwen3.8:27b-mlx` (safetensors, nvfp4, runner `mlx`)
- `OLLAMA_*` env: unset/default (`OLLAMA_MAX_LOADED_MODELS` unset)
- Script: `scripts/ollama-check.sh` (run with `bash scripts/ollama-check.sh`). Evidence below is from the final run
  (models already warm) unless marked "cold".

## Results

| # | Assumption (design §10) | Result | Evidence (summary) |
|---|---|---|---|
| 1 | `/api/generate` with `suffix` does FIM for `qwen2.5-coder:1.5b-base` (no raw template needed) | **PASS** | `"response":"return a + b"`, `done_reason:"stop"` |
| 2 | `qwen3.8:27b-mlx` emits native `message.tool_calls` via `/api/chat` + `tools` | **PASS** | `tool_calls[0].function.name == "get_weather"`, `arguments == {"city":"Paris"}` (an object, not a string) |
| 3 | Tool result round-trip with `{"role":"tool","content":…,"tool_name":…}` | **PASS** | reply: `"The weather in Paris is currently 22°C and sunny."` |
| 4 | `think:false` suppresses thinking | **PASS** | `think:false`: `message` has no `thinking` key; wall 0.68 s. `think:true`: `thinking` string (110 chars), wall 1.52 s |
| 5 | Both models resident simultaneously with default settings | **PASS** | `/api/ps` lists both (`mlx` 20.06 GB + `llamacpp` 2.12 GB); `OLLAMA_MAX_LOADED_MODELS` unset |
| 6 | Prompt (KV) cache reuse for identical FIM prefix | **PASS** | run 1: `prompt_eval_count` 1509, `prompt_eval_cached_count` 1, `prompt_eval_duration` 696.7 ms; run 2: 1509 / 1502 / 11.4 ms (~61× faster) |
| 7 | Dropping a streaming request frees the model promptly | **PASS** | curl killed at 1 s (exit 28, 165 chunks received); next request TTFB 0.0086 s, total 0.051 s |

## Evidence (raw JSON, trimmed)

### 1. FIM

Request:
```json
{"model":"qwen2.5-coder:1.5b-base","prompt":"def add(a, b):\n    ","suffix":"\n\ndef sub(a, b):\n    return a - b\n","stream":false,"options":{"num_predict":32,"temperature":0},"keep_alive":"30m"}
```
Response (cold, first-ever load; `context` array truncated):
```json
{"model":"qwen2.5-coder:1.5b-base","created_at":"2026-10-20T16:09:02.636088Z","response":"return a + b","done":true,"done_reason":"stop","context":[151659,750,912,…,151660,689,264,488,293],"total_duration":994127000,"load_duration":777590000,"prompt_eval_count":23,"prompt_eval_cached_count":0,"prompt_eval_duration":188111000,"eval_count":5,"eval_duration":25313000}
```
Warm: same response, `total_duration` 46.7 ms. The `context` token ids start with 151659 (`<|fim_prefix|>`), contain
151661 (`<|fim_suffix|>`) and 151660 (`<|fim_middle|>`) — Ollama applied the FIM template itself.
Note: the response does **not** include the leading indentation (prompt ended with the 4 spaces) and has no trailing newline.

### 2. Tool call

Request:
```json
{"model":"qwen3.8:27b-mlx","messages":[{"role":"user","content":"What is the weather in Paris? Use the tool."}],"tools":[{"type":"function","function":{"name":"get_weather","description":"Get the current weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string","description":"City name"}},"required":["city"]}}}],"stream":false,"think":false,"keep_alive":"30m"}
```
Response:
```json
{"model":"qwen3.8:27b-mlx","created_at":"2026-10-20T16:09:47.212603Z","message":{"role":"assistant","content":"","tool_calls":[{"id":"call_vvuuzrel","function":{"index":0,"name":"get_weather","arguments":{"city":"Paris"}}}]},"done":true,"done_reason":"stop","total_duration":715986667,"load_duration":364458,"prompt_eval_count":288,"prompt_eval_cached_count":284,"prompt_eval_duration":71854458,"eval_count":25,"eval_duration":642669125}
```
Exact `tool_calls` shape:
```json
[{"id":"call_vvuuzrel","function":{"index":0,"name":"get_weather","arguments":{"city":"Paris"}}}]
```
- `id` is at the tool-call level (format `call_` + 8 lowercase alnum); there is **no** `type` field.
- `index` is **inside** `function`, not at the tool-call level.
- `arguments` is a JSON **object**, not a JSON-encoded string.
- `content` is `""` (empty string, present) when tool calls are returned.

Cold first request to the 27B (model load): `load_duration` 5.81 s, `prompt_eval_duration` 3.13 s, wall 10.65 s.

### 3. Tool result round-trip

The messages array that worked (assistant message echoed back verbatim from step 2, then the tool message):
```json
[{"role":"user","content":"What is the weather in Paris? Use the tool."},
 {"role":"assistant","content":"","tool_calls":[{"id":"call_vvuuzrel","function":{"index":0,"name":"get_weather","arguments":{"city":"Paris"}}}]},
 {"role":"tool","content":"22C sunny","tool_name":"get_weather"}]
```
Tool message shape: `{"role":"tool","content":"<result text>","tool_name":"<function name>"}` (no `tool_call_id` needed;
`tool_call_id` was not tested). Same `tools` array was resent.

Response:
```json
{"model":"qwen3.8:27b-mlx","created_at":"2026-10-20T16:09:47.71546Z","message":{"role":"assistant","content":"The weather in Paris is currently 22°C and sunny."},"done":true,"done_reason":"stop","total_duration":483411166,"load_duration":324041,"prompt_eval_count":335,"prompt_eval_cached_count":334,"prompt_eval_duration":11625,"eval_count":13,"eval_duration":482170959}
```

### 4. Thinking

`think:false` (same request as check 2): `message` keys are `role`, `content`, `tool_calls` — no `thinking` key.
Wall 0.680 s (`eval_count` 25).

`think:true`:
```json
{"model":"qwen3.8:27b-mlx","created_at":"2026-10-20T16:09:49.949193Z","message":{"role":"assistant","content":"","thinking":"The user wants to know the weather in Paris. I need to call the get_weather function with city set to \"Paris\".","tool_calls":[{"id":"call_vkgbqwl2","function":{"index":0,"name":"get_weather","arguments":{"city":"Paris"}}}]},"done":true,"done_reason":"stop","total_duration":1521035792,"load_duration":328583,"prompt_eval_count":286,"prompt_eval_cached_count":285,"prompt_eval_duration":6125,"eval_count":53,"eval_duration":1519717125}
```
Wall 1.522 s (`eval_count` 53) — thinking roughly doubles latency even on this trivial prompt.
`thinking` is a sibling of `content` inside `message`.

### 5. Residency

`GET /api/ps` after checks 1–4 (both listed):
```json
{"models":[
 {"name":"qwen3.8:27b-mlx","model":"qwen3.8:27b-mlx","size":20062412916,"digest":"5642e974…","details":{"parent_model":"","format":"safetensors","family":"","families":null,"parameter_size":"","quantization_level":"nvfp4"},"expires_at":"2026-10-20T22:09:49.949309+05:30","size_vram":20062412916,"context_length":32768,"runner":"mlx"},
 {"name":"qwen2.5-coder:1.5b-base","model":"qwen2.5-coder:1.5b-base","size":2122024222,"digest":"02e0f281…","details":{"parent_model":"","format":"gguf","family":"qwen2","families":["qwen2"],"parameter_size":"1.5B","quantization_level":"Q4_K_M"},"expires_at":"2026-10-20T22:09:46.485823+05:30","size_vram":2122024222,"context_length":32768,"runner":"llamacpp"}]}
```
`OLLAMA_MAX_LOADED_MODELS`: unset/default. Note `families` can be `null` and `family`/`parameter_size` can be `""`
(MLX model) — types must tolerate that. `keep_alive:"30m"` is reflected in `expires_at`. 27B size grew from
19.13 GB to 20.06 GB between runs (KV cache growth).

### 6. Prompt-cache reuse

Prefix: a nonce comment line + 30 generated Python functions + `def mean(values):\n    `, byte-identical in both runs
(1509 prompt tokens). Suffixes differ (`def median…` vs `def variance…`). `num_predict:16`, `temperature:0`.
```
run 1: {"prompt_eval_count":1509,"prompt_eval_cached_count":1,"prompt_eval_duration":696697000,"eval_count":2,"total_duration":708275000,"response":"pass"}  wall=0.710s
run 2: {"prompt_eval_count":1509,"prompt_eval_cached_count":1502,"prompt_eval_duration":11426000,"eval_count":16,"total_duration":106619542,"response":"\"\"\"Return the mean of the values.\"\"\"\n    total = 0\n    for"}  wall=0.109s
```
`prompt_eval_count` reports the full prompt length; the new field **`prompt_eval_cached_count`** reports how many
of those tokens came from cache. Only 7 tokens (the differing suffix + FIM markers after it) were re-evaluated — so
the FIM template puts prefix first and the suffix after, and cache reuse works across differing suffixes.

### 7. Streaming cancel

`POST /api/generate` `{"model":"qwen2.5-coder:1.5b-base","prompt":"# A long essay about Python\n","stream":true,"options":{"num_predict":512},"keep_alive":"30m"}`
dropped with `curl --max-time 1`: `curl: (28) Operation timed out after 1001 milliseconds with 17948 bytes received`,
165 NDJSON chunks received, each shaped `{"model":…,"created_at":…,"response":"<token>","done":false}`.
`/api/ps` immediately after: both models still loaded (cancel does not unload).
Second request (streaming, `num_predict:8`): `http=200 ttfb=0.0086s total=0.051s`.

Caveat: at ~6 ms/token the cancelled stream would have needed ~2 more seconds to finish 512 tokens, so a 9 ms TTFB
indicates it was aborted (or ran in a parallel slot — `OLLAMA_NUM_PARALLEL` is default). Cancel was only exercised
on the `llamacpp` runner (completion model), not on the `mlx` 27B.

## Consequences for the plan

- **Check 1 PASS** → Task 8 uses `/api/generate` with `prompt` + `suffix` (no `raw: true` / manual
  `<|fim_prefix|>…<|fim_suffix|>…<|fim_middle|>` template needed). The returned text does not repeat the indent
  already in the prompt.
- **Check 2 PASS** → Task 9 uses native tool calling (`tools` + `message.tool_calls`), not prompt-based JSON.
- **Check 5 PASS** → no README requirement to set `OLLAMA_MAX_LOADED_MODELS=2`; defaults keep both models resident on 48 GB.
- Task 5 Ollama types must match the shapes above, specifically:
  - `ToolCall { id: Option<String>, function: { index: Option<u32>, name: String, arguments: serde_json::Value /* object */ } }` — no `type` field in responses.
  - Assistant messages are sent back including `tool_calls` as received; tool results are `{"role":"tool","content","tool_name"}`.
  - `message.thinking` is optional (absent when `think:false`); `message.content` is present (may be `""`).
  - Final responses carry `prompt_eval_count`, `prompt_eval_cached_count`, `prompt_eval_duration`, `eval_count`,
    `eval_duration`, `load_duration`, `total_duration`, `done_reason`; `/api/generate` also returns `context`.
  - `/api/ps` entries: `name`, `model`, `size`, `digest`, `details{format,family,families(nullable),parameter_size,quantization_level}`, `expires_at`, `size_vram`, `context_length`, `runner`.
- Thinking should default off for chat (`think:false`): ~2× latency even on trivial prompts.
- Keep FIM prefixes stable (prefix first, suffix varies) to benefit from the KV cache (~61× faster prompt eval at 1.5k tokens).
- Expect ~10 s for the first 27B request after a cold start (5.8 s load); the core should surface a "loading model" state.
