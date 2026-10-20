#!/usr/bin/env bash
# Verifies the Ollama assumptions LocalPilot relies on (design doc §10).
# Prints every raw response so the results can be recorded verbatim.
# Requires: curl, jq, a running Ollama at $OLLAMA_URL.
set -u

OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
FIM_MODEL="qwen2.5-coder:1.5b-base"
CHAT_MODEL="qwen3.8:27b-mlx"

hr() { printf '\n==================== %s ====================\n' "$1"; }

# post PATH JSON -> prints body; prints wall time to stderr-ish line
post() {
  local path="$1" body="$2"
  curl -sS -m 600 -X POST "$OLLAMA_URL$path" -H 'Content-Type: application/json' -d "$body" \
    -w '\n[http=%{http_code} wall=%{time_total}s ttfb=%{time_starttransfer}s]\n'
}

hr "0. version / env"
curl -sS -m 10 "$OLLAMA_URL/api/version"; echo
env | grep OLLAMA || echo "OLLAMA_* env: unset/default"

# ---------------------------------------------------------------------------
hr "1. FIM via /api/generate suffix"
FIM_REQ=$(jq -nc --arg m "$FIM_MODEL" '{
  model:$m, prompt:"def add(a, b):\n    ", suffix:"\n\ndef sub(a, b):\n    return a - b\n",
  stream:false, options:{num_predict:32, temperature:0}, keep_alive:"30m"}')
echo "REQUEST: $FIM_REQ"
post /api/generate "$FIM_REQ"

# ---------------------------------------------------------------------------
TOOLS='[{"type":"function","function":{"name":"get_weather","description":"Get the current weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string","description":"City name"}},"required":["city"]}}}]'
USER_MSG='{"role":"user","content":"What is the weather in Paris? Use the tool."}'

chat_req() { # think(bool) messages(json array)
  jq -nc --arg m "$CHAT_MODEL" --argjson think "$1" --argjson msgs "$2" --argjson tools "$TOOLS" \
    '{model:$m, messages:$msgs, tools:$tools, stream:false, think:$think, keep_alive:"30m"}'
}

hr "2. Tool call (think:false)"
REQ2=$(chat_req false "[$USER_MSG]")
echo "REQUEST: $REQ2"
RESP2_RAW=$(post /api/chat "$REQ2")
echo "$RESP2_RAW"
RESP2=$(echo "$RESP2_RAW" | head -n 1)
echo "--- message.tool_calls:"
echo "$RESP2" | jq -c '.message.tool_calls'

# ---------------------------------------------------------------------------
hr "3. Tool result round-trip"
ASSIST=$(echo "$RESP2" | jq -c '.message')
TOOL_MSG='{"role":"tool","content":"22C sunny","tool_name":"get_weather"}'
REQ3=$(chat_req false "[$USER_MSG, $ASSIST, $TOOL_MSG]")
echo "REQUEST: $REQ3"
post /api/chat "$REQ3"

# ---------------------------------------------------------------------------
hr "4a. Same chat, think:false"
RESP4A=$(post /api/chat "$(chat_req false "[$USER_MSG]")")
echo "$RESP4A"
echo "--- has thinking field: $(echo "$RESP4A" | head -n1 | jq '.message | has("thinking")')  value: $(echo "$RESP4A" | head -n1 | jq -c '.message.thinking')"

hr "4b. Same chat, think:true"
RESP4B=$(post /api/chat "$(chat_req true "[$USER_MSG]")")
echo "$RESP4B"
echo "--- thinking length: $(echo "$RESP4B" | head -n1 | jq '.message.thinking // "" | length')"

# ---------------------------------------------------------------------------
hr "5. Residency /api/ps"
curl -sS -m 10 "$OLLAMA_URL/api/ps"; echo
echo "OLLAMA_MAX_LOADED_MODELS=${OLLAMA_MAX_LOADED_MODELS:-unset/default}"

# ---------------------------------------------------------------------------
hr "6. Prompt-cache reuse (identical ~1500-token prefix, different suffixes)"
# Nonce line makes the prefix cache-cold for run 1 even if the script ran before.
PREFIX="# session $(date +%s)-$RANDOM
"
for i in $(seq 1 30); do
  PREFIX+="def compute_metric_${i}(values, weight=${i}):
    \"\"\"Return the weighted sum of values for metric ${i}.\"\"\"
    total = 0
    for v in values:
        total += v * weight
    return total

"
done
PREFIX+="def mean(values):
    "
fim_cache_req() { # suffix
  jq -nc --arg m "$FIM_MODEL" --arg p "$PREFIX" --arg s "$1" \
    '{model:$m, prompt:$p, suffix:$s, stream:false, options:{num_predict:16, temperature:0}, keep_alive:"30m"}'
}
for run in 1 2; do
  if [ "$run" = 1 ]; then SUF=$'\n\ndef median(values):\n    pass\n'; else SUF=$'\n\ndef variance(values):\n    pass\n'; fi
  R=$(post /api/generate "$(fim_cache_req "$SUF")")
  echo "run $run: $(echo "$R" | head -n1 | jq -c '{prompt_eval_count, prompt_eval_cached_count, prompt_eval_duration, eval_count, total_duration, response}') $(echo "$R" | tail -n1)"
done

# ---------------------------------------------------------------------------
hr "7. Streaming cancel"
STREAM_REQ=$(jq -nc --arg m "$FIM_MODEL" '{model:$m, prompt:"# A long essay about Python\n", stream:true, options:{num_predict:512}, keep_alive:"30m"}')
echo "starting stream, curl killed after 1s (--max-time 1)"
curl -sS --max-time 1 -X POST "$OLLAMA_URL/api/generate" -d "$STREAM_REQ" > /tmp/ollama-cancel-stream.out
echo "curl exit=$? (28 = timeout expected); chunks received: $(wc -l < /tmp/ollama-cancel-stream.out)"
head -n 3 /tmp/ollama-cancel-stream.out
echo "--- /api/ps right after cancel:"
curl -sS -m 10 "$OLLAMA_URL/api/ps"; echo
echo "--- second request (streaming, small), ttfb = time to first chunk:"
SECOND=$(jq -nc --arg m "$FIM_MODEL" '{model:$m, prompt:"def hello():\n    ", stream:true, options:{num_predict:8}, keep_alive:"30m"}')
curl -sS -m 60 -X POST "$OLLAMA_URL/api/generate" -d "$SECOND" -o /tmp/ollama-second.out \
  -w 'second request: http=%{http_code} ttfb=%{time_starttransfer}s total=%{time_total}s\n'
echo "--- second request body (NDJSON):"
cat /tmp/ollama-second.out

# ---------------------------------------------------------------------------
# stream_post PATH JSON -> prints every NDJSON line verbatim, then curl timing
stream_post() {
  curl -sS -m 600 -X POST "$OLLAMA_URL$1" -H 'Content-Type: application/json' -d "$2" \
    -w '[http=%{http_code} ttfb=%{time_starttransfer}s total=%{time_total}s]\n'
}

hr "8a. Streaming /api/generate (full NDJSON)"
REQ8A=$(jq -nc --arg m "$FIM_MODEL" '{model:$m, prompt:"def hello():\n    ", stream:true, options:{num_predict:8, temperature:0}, keep_alive:"30m"}')
echo "REQUEST: $REQ8A"
stream_post /api/generate "$REQ8A"

hr "8b. Streaming /api/chat with tools, think:false (full NDJSON)"
REQ8B=$(jq -nc --arg m "$CHAT_MODEL" --argjson msgs "[$USER_MSG]" --argjson tools "$TOOLS" \
  '{model:$m, messages:$msgs, tools:$tools, stream:true, think:false, keep_alive:"30m"}')
echo "REQUEST: $REQ8B"
stream_post /api/chat "$REQ8B"

hr "8c. Streaming /api/chat plain text (no tools), think:false (full NDJSON)"
REQ8C=$(jq -nc --arg m "$CHAT_MODEL" \
  '{model:$m, messages:[{role:"user", content:"Say hello in exactly five words."}], stream:true, think:false, keep_alive:"30m"}')
echo "REQUEST: $REQ8C"
stream_post /api/chat "$REQ8C"

hr "done"
