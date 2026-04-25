#!/usr/bin/env bash
# demo-load.sh — drive realistic multi-turn chat traffic against
# OpenAI-compatible LLM endpoints (vLLM, llama.cpp server, TGI, etc.)
# so the spark-dashboard has something interesting to display.
#
# Usage:
#   dev/demo-load.sh [options] <endpoint> [endpoint ...]
#
# See -h for the full option list.

set -uo pipefail

# ---------- defaults ----------
CONVS=2
TURNS=6
MAX_TOKENS=128
TEMPERATURE=0.7
THINK_MS=400
QUIET=0
declare -a OVERRIDE_MODELS=()
declare -a ENDPOINTS_RAW=()
declare -a CHILD_PIDS=()
RUN_DIR=""
START_EPOCH=0

# ---------- usage ----------
usage() {
  cat <<EOF
Usage: $(basename "$0") [options] <endpoint> [endpoint ...]

  endpoint   host:port[/base]  or  http(s)://host:port[/base]
             Examples:
               localhost:8001
               localhost:8000/v1
               http://192.168.1.77:8000
               https://gpu.internal/openai/v1

Options:
  -c, --conversations N   Parallel conversations per (endpoint, model). Default: ${CONVS}
  -t, --turns N           Turns per conversation before history resets. Default: ${TURNS}
  -m, --max-tokens N      max_tokens per assistant reply. Default: ${MAX_TOKENS}
      --temperature F     Sampling temperature. Default: ${TEMPERATURE}
      --think-ms N        Sleep between turns in ms (jittered). Default: ${THINK_MS}
      --model NAME        Skip /v1/models discovery; use this model id.
                          Repeatable; applies to every endpoint.
  -q, --quiet             Suppress per-turn stdout (logs still go to disk).
  -h, --help              Show this help.

The script loops until interrupted (Ctrl+C). Each conversation runs the
configured number of turns, resets, and starts again with a fresh prompt.
EOF
}

# ---------- arg parsing ----------
while [[ $# -gt 0 ]]; do
  case "$1" in
    -c|--conversations) CONVS="$2"; shift 2 ;;
    -t|--turns) TURNS="$2"; shift 2 ;;
    -m|--max-tokens) MAX_TOKENS="$2"; shift 2 ;;
    --temperature) TEMPERATURE="$2"; shift 2 ;;
    --think-ms) THINK_MS="$2"; shift 2 ;;
    --model) OVERRIDE_MODELS+=("$2"); shift 2 ;;
    -q|--quiet) QUIET=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; while [[ $# -gt 0 ]]; do ENDPOINTS_RAW+=("$1"); shift; done ;;
    -*) echo "error: unknown option: $1" >&2; usage >&2; exit 1 ;;
    *) ENDPOINTS_RAW+=("$1"); shift ;;
  esac
done

if [[ ${#ENDPOINTS_RAW[@]} -eq 0 ]]; then
  usage >&2
  exit 1
fi

for dep in curl jq; do
  if ! command -v "$dep" >/dev/null 2>&1; then
    echo "error: required command not found: $dep" >&2
    exit 1
  fi
done

for n in "$CONVS" "$TURNS" "$MAX_TOKENS" "$THINK_MS"; do
  [[ "$n" =~ ^[0-9]+$ ]] || { echo "error: numeric option got '$n'" >&2; exit 1; }
done

# ---------- helpers ----------
normalize_endpoint() {
  local raw="$1" base
  if [[ "$raw" =~ ^https?:// ]]; then
    base="$raw"
  else
    base="http://$raw"
  fi
  base="${base%/}"
  printf '%s' "$base"
}

# Returns the full URL for the given OpenAI sub-path.
# If the base already ends in /v1, the leading /v1 is dropped from the path.
api_url() {
  local base="$1" path="$2"
  if [[ "$base" =~ /v1$ ]]; then
    printf '%s%s' "$base" "${path#/v1}"
  else
    printf '%s%s' "$base" "$path"
  fi
}

short_label() {
  # Strip scheme for compact log labels.
  local s="$1"
  s="${s#http://}"
  s="${s#https://}"
  printf '%s' "$s"
}

now_ms() {
  # macOS date doesn't support %N reliably; use python or perl fallback.
  if date +%s%3N 2>/dev/null | grep -qv N; then
    date +%s%3N
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import time;print(int(time.time()*1000))'
  else
    # 1s resolution fallback
    echo "$(( $(date +%s) * 1000 ))"
  fi
}

jitter_sleep_ms() {
  local base="$1"
  local jitter=$(( base * 30 / 100 ))
  local delta=$(( (RANDOM % (jitter * 2 + 1)) - jitter ))
  local ms=$(( base + delta ))
  (( ms < 0 )) && ms=0
  # bash sleep accepts fractional seconds on most systems.
  awk -v ms="$ms" 'BEGIN{ printf "%.3f\n", ms/1000 }' | xargs sleep
}

preview() {
  # Trim a long string to ~60 chars, single-line.
  local s="$1"
  s="${s//$'\n'/ }"
  s="${s//$'\r'/ }"
  if (( ${#s} > 60 )); then
    s="${s:0:57}..."
  fi
  printf '%s' "$s"
}

# ---------- prompt pool ----------
# Each seed is a newline-separated list of follow-up user turns. The first
# line is the opener; subsequent lines reference earlier turns so the
# conversation actually builds on its own history (good KV-cache exercise).
declare -a PROMPT_SEEDS=(
"Outline a 3-sprint plan to ship a notes app.
Sprint 1 looks vague — break it into 5 concrete engineering tickets.
Estimate each ticket in story points and justify briefly.
Now compress the whole plan into one paragraph for a stakeholder.
What is the single biggest risk in this plan, and how would you mitigate it?"

"Write a Python function that finds the longest palindromic substring.
Add docstring and type hints.
Now write 4 pytest cases that cover edge cases (empty, single char, all same, no palindrome).
Refactor the function to O(n^2) without expanding around centers — propose a different approach.
Compare runtime and memory of both versions in a short table."

"Summarize the plot of Hamlet in 5 bullet points.
Now retell it in the voice of a sports commentator.
Pick the most pivotal scene and explain why a director might cut it.
Suggest a modern adaptation setting and three casting choices.
Write a one-sentence pitch for that adaptation."

"Explain how a transformer's self-attention works to someone who knows linear algebra but not ML.
Where does the quadratic cost come from?
Describe two practical workarounds (sliding window, linear attention).
Which one would you pick for 1M-token context, and why?
Sketch the change to the attention equation in two lines of math."

"Translate 'The early bird catches the worm' into French, German, Japanese, and Swahili.
For each, suggest a more idiomatic local proverb with the same meaning.
Which language has the most semantically distant proverb? Explain.
Now write a short paragraph (3 sentences) using all five proverbs in a single coherent passage."

"You are a senior SRE. Walk me through diagnosing a sudden p99 latency spike on a Postgres-backed API.
Assume CPU and memory look normal. What do you check next?
The slow query log shows nothing unusual. Now what?
You discover lock_wait_time has tripled. Outline the next 3 actions in order.
Write the postmortem TL;DR for this incident."

"Design a REST API for a library catalog. Resources, endpoints, methods.
Add pagination and filtering to the books endpoint.
How would you version this API once it ships?
What changes if the client wants offline-first sync?
Pick three error cases and define their HTTP status + response body."

"Compose a haiku about debugging at 3am.
Write a second one from the perspective of the bug.
Now expand the bug's haiku into a four-line free verse.
Title the resulting collection.
Suggest cover art in one sentence."

"Plan a 5-day trip to Lisbon for someone who likes architecture and seafood.
Day 2 is too touristy — replace it with neighborhoods locals actually go to.
Add one budget option and one splurge option per day.
Now compress this into a one-page itinerary I can paste into a doc.
What's a realistic total budget in EUR per person?"

"Define what 'idempotent' means in HTTP and give a concrete example.
Compare PUT and PATCH on idempotency.
Show a case where a poorly designed POST is accidentally idempotent.
What would the right fix look like at the protocol layer?
Summarize in 2 sentences for a junior engineer."

"Explain the difference between concurrency and parallelism with a kitchen analogy.
Now do it again with a music analogy.
Which analogy is better and why?
Map the analogy back to a Go program: which keyword is which part?
Write a 4-line code sketch that demonstrates concurrency without parallelism."

"Pitch a board game playable in 30 minutes for 4 players, with deduction mechanics.
Name the game and write a 2-sentence box blurb.
Sketch the turn structure: phases and player actions.
What's the win condition, and how do you avoid runaway leader?
Suggest the first expansion's theme."
)

GENERIC_FOLLOWUPS=(
  "Could you say that more concisely?"
  "What are the trade-offs of that approach?"
  "Give a concrete example."
  "Now explain it to a beginner."
  "What would you change if performance mattered most?"
  "Rewrite that as a numbered list."
  "What did you assume that I might disagree with?"
  "Push back on your own answer."
)

random_seed_index() {
  echo $(( RANDOM % ${#PROMPT_SEEDS[@]} ))
}

# Print the n-th line (1-indexed) of a multi-line seed; falls back to a
# generic follow-up if past the end.
seed_turn() {
  local seed="$1" n="$2"
  local line
  line=$(printf '%s\n' "$seed" | sed -n "${n}p")
  if [[ -z "$line" ]]; then
    line="${GENERIC_FOLLOWUPS[$(( RANDOM % ${#GENERIC_FOLLOWUPS[@]} ))]}"
  fi
  printf '%s' "$line"
}

# ---------- discovery ----------
discover_models() {
  local base="$1"
  local url
  url=$(api_url "$base" "/v1/models")
  curl -fsS --max-time 5 "$url" 2>/dev/null | jq -r '.data[].id' 2>/dev/null
}

# ---------- conversation worker ----------
# Args: base label model conv_id log_path
run_conversation() {
  local base="$1" label="$2" model="$3" conv_id="$4" log_path="$5"
  local chat_url
  chat_url=$(api_url "$base" "/v1/chat/completions")

  local sent_total=0 fail_total=0 tok_total=0

  trap 'printf "%s requests=%d failures=%d completion_tokens=%d\n" "$label/$model/$conv_id" "$sent_total" "$fail_total" "$tok_total" >>"$RUN_DIR/tally.log"; exit 0' TERM INT

  while :; do
    local seed_idx seed system_prompt history reply_body http_code
    seed_idx=$(random_seed_index)
    seed="${PROMPT_SEEDS[$seed_idx]}"
    system_prompt="You are a helpful, concise assistant. Keep replies under ${MAX_TOKENS} tokens."

    history=$(jq -nc --arg sys "$system_prompt" '[{role:"system",content:$sys}]')

    local turn
    for (( turn=1; turn<=TURNS; turn++ )); do
      local user_msg
      user_msg=$(seed_turn "$seed" "$turn")
      history=$(jq -c --arg c "$user_msg" '. + [{role:"user",content:$c}]' <<<"$history")

      local payload
      payload=$(jq -nc \
        --arg model "$model" \
        --argjson msgs "$history" \
        --argjson max "$MAX_TOKENS" \
        --argjson temp "$TEMPERATURE" \
        '{model:$model, messages:$msgs, max_tokens:$max, temperature:$temp, stream:false}')

      local t0 t1 dt
      t0=$(now_ms)

      local attempt=0 max_attempts=2 ok=0
      reply_body=""
      http_code=""
      while (( attempt < max_attempts )); do
        attempt=$(( attempt + 1 ))
        local tmpfile
        tmpfile=$(mktemp "$RUN_DIR/req.XXXXXX")
        http_code=$(curl -sS -o "$tmpfile" -w '%{http_code}' \
          --max-time 60 \
          -H 'Content-Type: application/json' \
          -X POST \
          --data-binary @- \
          "$chat_url" <<<"$payload" 2>>"$log_path" || echo "000")
        reply_body=$(cat "$tmpfile" 2>/dev/null || true)
        rm -f "$tmpfile"

        if [[ "$http_code" =~ ^2 ]]; then
          ok=1
          break
        fi
        # 4xx: don't retry, log and bail this turn
        if [[ "$http_code" =~ ^4 ]]; then
          break
        fi
        # 5xx / 000: backoff and retry once
        if (( attempt < max_attempts )); then
          sleep $(( attempt ))
        fi
      done

      t1=$(now_ms)
      dt=$(( t1 - t0 ))
      sent_total=$(( sent_total + 1 ))

      if (( ok != 1 )); then
        fail_total=$(( fail_total + 1 ))
        {
          printf '[%(%H:%M:%S)T] [%s][%s][conv=%d][turn=%d/%d] HTTP %s — %s\n' \
            -1 "$label" "$model" "$conv_id" "$turn" "$TURNS" "$http_code" "$(preview "$reply_body")"
        } >>"$log_path"
        if (( QUIET == 0 )); then
          printf '[%s][%s][conv=%d][turn=%d/%d] FAIL http=%s\n' \
            "$label" "$model" "$conv_id" "$turn" "$TURNS" "$http_code"
        fi
        # Drop this conversation, start fresh seed
        break
      fi

      local content tokens
      content=$(jq -r '.choices[0].message.content // ""' <<<"$reply_body" 2>/dev/null || echo "")
      tokens=$(jq -r '.usage.completion_tokens // 0' <<<"$reply_body" 2>/dev/null || echo "0")
      [[ "$tokens" =~ ^[0-9]+$ ]] || tokens=0
      tok_total=$(( tok_total + tokens ))

      history=$(jq -c --arg c "$content" '. + [{role:"assistant",content:$c}]' <<<"$history")

      {
        printf '[%(%H:%M:%S)T] [%s][%s][conv=%d][turn=%d/%d] %s  →  %s  (%dms, %s tok)\n' \
          -1 "$label" "$model" "$conv_id" "$turn" "$TURNS" \
          "$(preview "$user_msg")" "$(preview "$content")" "$dt" "$tokens"
      } >>"$log_path"

      if (( QUIET == 0 )); then
        printf '[%s][%s][conv=%d][turn=%d/%d] %s → %s (%dms,%stok)\n' \
          "$label" "$model" "$conv_id" "$turn" "$TURNS" \
          "$(preview "$user_msg")" "$(preview "$content")" "$dt" "$tokens"
      fi

      jitter_sleep_ms "$THINK_MS"
    done
  done
}

# ---------- shutdown ----------
shutdown() {
  local rc="${1:-130}"
  echo
  echo "stopping… killing ${#CHILD_PIDS[@]} workers"
  for pid in "${CHILD_PIDS[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  # Give workers a moment to write tallies
  sleep 0.5
  for pid in "${CHILD_PIDS[@]}"; do
    kill -KILL "$pid" 2>/dev/null || true
  done

  local end_epoch
  end_epoch=$(date +%s)
  local elapsed=$(( end_epoch - START_EPOCH ))

  if [[ -f "$RUN_DIR/tally.log" ]]; then
    awk -v elapsed="$elapsed" '
      {
        for (i=1;i<=NF;i++) {
          if ($i ~ /^requests=/)         { split($i,a,"="); reqs += a[2] }
          else if ($i ~ /^failures=/)    { split($i,a,"="); fails += a[2] }
          else if ($i ~ /^completion_tokens=/) { split($i,a,"="); toks += a[2] }
        }
      }
      END {
        printf("\nsummary:\n  duration:           %ds\n  requests sent:      %d\n  requests failed:    %d\n  completion tokens:  %d\n  logs:               %s\n",
               elapsed, reqs, fails, toks, ENVIRON["RUN_DIR"])
      }
    ' "$RUN_DIR/tally.log"
  else
    printf '\nsummary: no tally captured. logs: %s\n' "$RUN_DIR"
  fi

  exit "$rc"
}

trap 'shutdown 130' INT TERM

# ---------- main ----------
RUN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/spark-demo-load.XXXXXX")
export RUN_DIR
START_EPOCH=$(date +%s)

echo "spark-dashboard demo load"
echo "  workers per (endpoint, model): $CONVS"
echo "  turns per conversation:         $TURNS"
echo "  max_tokens / temperature:       $MAX_TOKENS / $TEMPERATURE"
echo "  think time (ms, ±30%):          $THINK_MS"
echo "  log directory:                  $RUN_DIR"
echo

declare -a TARGETS=()  # entries: "<base>|<label>|<model>"

for raw in "${ENDPOINTS_RAW[@]}"; do
  base=$(normalize_endpoint "$raw")
  label=$(short_label "$base")

  declare -a models=()
  if [[ ${#OVERRIDE_MODELS[@]} -gt 0 ]]; then
    models=("${OVERRIDE_MODELS[@]}")
    echo "[$label] using override models: ${models[*]}"
  else
    echo "[$label] discovering models at $(api_url "$base" "/v1/models")…"
    mapfile -t models < <(discover_models "$base")
    if [[ ${#models[@]} -eq 0 ]]; then
      echo "[$label] WARN: no models discovered — skipping"
      continue
    fi
    echo "[$label] models: ${models[*]}"
  fi

  for model in "${models[@]}"; do
    [[ -z "$model" ]] && continue
    TARGETS+=("$base|$label|$model")
  done
done

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  echo "error: no usable (endpoint, model) pairs — exiting" >&2
  exit 1
fi

echo
echo "spawning $(( ${#TARGETS[@]} * CONVS )) workers across ${#TARGETS[@]} (endpoint, model) pairs"
echo "press Ctrl+C to stop"
echo

for entry in "${TARGETS[@]}"; do
  IFS='|' read -r base label model <<<"$entry"
  for (( c=1; c<=CONVS; c++ )); do
    safe_label="${label//\//_}"
    safe_model="${model//\//_}"
    log_path="$RUN_DIR/${safe_label}-${safe_model}-conv${c}.log"
    : >"$log_path"
    (
      run_conversation "$base" "$label" "$model" "$c" "$log_path"
    ) &
    CHILD_PIDS+=("$!")
  done
done

wait
shutdown 0
