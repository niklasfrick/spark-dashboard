# Llama.cpp Inference Engine — Feature Spec

Working design doc for adding `llama.cpp` (`llama-server`) as a second inference
engine alongside vLLM. Branch: `feat/llama-cpp-engine`. Untracked working doc,
matching `SplunkHEC-spec.md` (not a committed artifact).

Status: **implemented on `feat/llama-cpp-engine`; end-to-end verified against the live server (§12). §10 items 3–4 (display defaults) applied; open for review.**

---

## 1. Goal

Detect a running `llama-server`, read its metrics, and render the KPIs it can
actually produce (directly or by derivation) — while cleanly **hiding** the KPIs
that have no llama.cpp source rather than showing a wall of dashes or a
confident-but-wrong `0`.

Non-goals for v1:
- No log-based request counting / per-request percentiles (deferred, §9).
- No change to how vLLM is detected or rendered.
- No new third-party Rust/TS dependencies.

## 2. Test environment (live host)

Confirmed 2026-09-25 against the dev box:

| GPU | Model | Occupant |
|---|---|---|
| 0 | RTX PRO 6000 Blackwell (96 GB) | `VLLM::EngineCore` (PID 2930808) |
| 1 | RTX 3090 (24 GB) | `llama-server` (PID 1729486) |
| 2 | RTX 3090 (24 GB) | `llama-server` (PID 1729486) |

**The llama.cpp on the 3090s is a *native host process*, not a Docker
container** (cgroup is `user.slice/…`, no `docker-*.scope`). The Docker llama.cpp
containers are all stopped (`server-cuda13` ×2 `Created`, `server-cuda-b10236`
`Exited`). So detection is exercised through the **native process-scan path**,
not the Docker path (the Docker path is still spec'd below for completeness).

Live server facts:
- binary: `/home/splunk/AI-Apps/GSQ-RCO GGUF/llama.cpp/build/bin/llama-server`
- build: commit `5d806aa` — well past `b7191` (post-spec-decode, post the
  `kv_cache_*` removal).
- launch: `-m <Qwen3.8-27B-…-mtp.gguf> --host 0.0.0.0 --port 8098 -ts 1,1
  --parallel 1 …` (tensor-split across the two 3090s, 1 slot).
- `/health` → **200**, `/v1/models` → **200** (returns the raw `.gguf` path).
- Started **without `--metrics`** → `/metrics` 501. **Resolved 2026-09-25:** added
  `--metrics` to `run-3090x2.sh` and relaunched (now PID **1473871**). `/metrics`
  → **200** with all 15 `llamacpp:` series; `/slots` → **200**. A 64-token test
  completion confirmed the counters advance (see §11).

**Live test target:** `http://127.0.0.1:8098` (running, `--metrics` on). Unit
tests (synthetic `/metrics` + `/slots` bodies) still need no server.

## 3. llama.cpp metric surface

`/metrics` (Prometheus text, prefix `llamacpp:`, **no labels**, **off by default**
→ 501 without `--metrics`). Current build's full set:

| Metric | Type | Notes |
|---|---|---|
| `prompt_tokens_total` | counter | prefill tokens (excl. cache hits) |
| `prompt_seconds_total` | counter | prefill time (s) |
| `prompt_tokens_seconds` | gauge | last request prefill tok/s; **0 when idle** |
| `prompt_tokens_cached_total` | counter | prompt tokens served from cache (**present on this build**) |
| `tokens_predicted_total` | counter | generated tokens — **flushed per request, not per token** (see below) |
| `tokens_predicted_seconds_total` | counter | decode time (s) |
| `predicted_tokens_seconds` | gauge | last request gen tok/s; **0 when idle** |
| `requests_processing` | gauge | active requests (= slots busy) |
| `requests_deferred` | gauge | queued requests |
| `n_tokens_max` | counter | high-watermark of context tokens |
| `n_decode_total` | counter | `llama_decode()` calls |
| `n_busy_slots_per_decode` | gauge | mean busy slots per decode step |
| `spec_decode_num_draft_tokens_total` | counter | 0 without a draft model |
| `spec_decode_num_accepted_tokens_total` | counter | 0 without a draft model |
| `spec_decode_num_drafts_total` | counter | 0 without a draft model |
| `spec_decode_num_accepted_tokens_per_pos_total` | counter | labelled `position=` |

Key structural facts:
- **No histograms** → no percentile/goodput source.
- **No request counter** → `total_requests` must be derived.
- **No `kv_cache_*`** (removed upstream); only `n_tokens_max` high-watermark.
- The two `*_tokens_seconds` gauges read **0 when idle** → derive throughput
  from the **counters**, never the gauges.
- `GET /slots` is **on by default**. On this build, at rest: `{id, n_ctx,
  speculative, is_processing}`; mid/after a request it adds `id_task`,
  `n_prompt_tokens`, `n_prompt_tokens_processed`, `n_prompt_tokens_cache`, and
  `next_token[]` (with `n_decoded` — **live per-token progress of the
  in-flight task**). **No field gives live KV tokens-in-use** —
  `n_prompt_tokens` persists after the request completes, and `n_tokens_max`
  tracks the *prompt* high-water, not total context. See §4.3.
- **`tokens_predicted_total` (and the other `_total` counters) only advance
  when a slot resets — i.e. at request completion** (verified on this build,
  2026-09-25: a running job held `requests_processing=1` for minutes while the
  counter stayed flat, then jumped +1647 tokens the moment a request
  finished; upstream `metrics_on_prediction` runs from the slot's reset
  callback and adds the slot's whole `n_gen`). Per-poll deltas therefore read
  0 mid-job and spike by the full request size at completion — they cannot
  drive a live rate. The live generation rate comes from `/slots`
  `next_token[].n_decoded` deltas instead (§4.1).

## 4. KPI contract — what fills, what's derived, what's hidden

### 4.1 Populated directly or from counters (v1)

| `EngineMetrics` field | llama.cpp source |
|---|---|
| `active_requests` | `requests_processing` |
| `queued_requests` | `requests_deferred` |
| `total_generation_tokens` | `tokens_predicted_total` |
| `total_prompt_tokens` | `prompt_tokens_total` |
| `tokens_per_sec` / `avg_tokens_per_sec` | **live**: per-slot Δ`/slots` `next_token[].n_decoded` / Δt (summed across processing slots; `None` on the first tick of a new task) + running avg — the lifetime counter only flushes at request completion (§3 note) |
| `prompt_tokens_per_sec` / `avg_prompt_tokens_per_sec` | `Δprompt_tokens_total / Δprompt_seconds_total` + running avg |
| `tpot_ms` | `1000 · tokens_predicted_seconds_total / tokens_predicted_total` (mean) |
| `per_request_tps` | `tokens_predicted_total / tokens_predicted_seconds_total` |
| `per_request_prompt_tps` | `prompt_tokens_total / prompt_seconds_total` |
| `inter_token_latency_ms` | same mean as `tpot_ms` (`1000 · Δpredict_s / Δpredict_tokens`) |
| `avg_batch_size` | `n_busy_slots_per_decode` (proxy) |
| `prefix_cache_hit_rate` | `prompt_tokens_cached_total / (cached + prompt_tokens_total) · 100` — **recent builds only; read if present** |
| `prefix_cache_queries_total` | `prompt_tokens_cached_total + prompt_tokens_total` (if present) |
| `spec_decode_*` (all 6) | the three `spec_decode_*` counters → TAR / live TAR / acceptance length (same math as vLLM) |

### 4.2 Populated from a derived request count **N** (v1, approximate)

`total_requests`, `ttft_ms` (mean), `e2e_latency_ms` (mean) all need N.
v1 derives N by **polling `/slots` every tick** and counting
`is_processing` false→true transitions across slots:

- `total_requests` = N accumulated since the dashboard attached.
- `ttft_ms` (mean) ≈ `Δprompt_seconds_total / ΔN` (prefill time; **queue wait
  excluded** — llama.cpp never records it).
- `e2e_latency_ms` (mean) ≈ `(Δprompt_seconds_total + Δtokens_predicted_seconds_total) / ΔN`.

Known v1 ceiling (`ponytail:` — approximate N): undercounts back-to-back
requests that never free a slot between 1 s polls, and misses sub-second
requests. Upgrade path (§9) replaces this with accurate log-derived N.

### 4.3 `kv_cache_percent` — hidden on this build

Verified against the live server: **no source gives live KV tokens-in-use.** The
slot's `n_prompt_tokens` persists after the request completes (it is the last
value, not current KV), and `n_tokens_max` is the *prompt* high-watermark, not
total context (observed: 30 prompt + 23 generated = 53, but `n_tokens_max` = 30).
So `kv_cache_percent` is **`None` → hidden** (moved to §4.4). Revisit only if a
build exposes a clean "current KV tokens in use" field; then set
`kv_cache_is_estimated = true`.

### 4.4 Hidden (no source — do not render, do not zero)

| Field | Reason |
|---|---|
| `ttft_percentiles` / `itl_percentiles` / `e2e_percentiles` / `tpot_percentiles` | no histograms |
| `ttft_goodput_pct` / `itl_goodput_pct` / `e2e_goodput_pct` / `tpot_goodput_pct` | no histograms |
| `ttft_buckets` / `itl_buckets` / `e2e_buckets` / `tpot_buckets` | no histograms |
| `queue_time_ms` | queue start never timestamped |
| `preemptions_total` | concept doesn't exist (llama.cpp defers, never preempts) |
| `swapped_requests` | concept doesn't exist (no swap counter) |
| `kv_cache_percent` | no live KV-in-use field on this build (see §4.3) |

Showing `0` for preemptions/swaps would read as "healthy" — it must be hidden.

## 5. Display logic (frontend)

The wire already carries `engine_type`, and every unsupported field already
arrives as `null`. The frontend already (a) renders `null` as dashes and
(b) hides the spec-decode section when all its fields are `null`. The one missing
piece is telling apart **"engine can't produce this"** (hide the section) from
**"no data yet"** (dashes).

Add a static capability map keyed by `EngineType` in the frontend:

```ts
// frontend/src/lib/engineCapability.ts (new)
export const KPI_GROUPS = ['throughput','concurrency','kv','totals',
  'specDecode','latencyMeans','latencyDistribution','queueing','scheduler'] as const;

export const ENGINE_CAPABILITY: Record<EngineType, ReadonlySet<KpiGroup>> = {
  Vllm: new Set(KPI_GROUPS),
  LlamaCpp: new Set(['throughput','concurrency','totals','specDecode','latencyMeans']),
};
```

Rule, per panel/section:
- group **not** in `ENGINE_CAPABILITY[engine_type]` → **don't render** the section.
- group present but value `null` → **dashes** (warming up / no traffic yet).

Per-build degradation (old build without `spec_decode_*`, `--metrics` off) is
already handled by the existing all-`null`-means-hide logic; the map only encodes
structural per-engine-type differences. `kv_cache_is_estimated` → "est." badge.

## 6. Design — concrete changes

### 6.1 Rust

- **`src/engines/mod.rs`**
  - `enum EngineType { Vllm, LlamaCpp }` + `Display` (`"llama.cpp"`) + serde.
  - `create_adapter`: add `EngineType::LlamaCpp` arm.
- **`src/engines/prometheus.rs`**
  - Generalize the prefix rewrite: today it hard-codes `vllm:` → `vllm_`;
    also rewrite `llamacpp:` → `llamacpp_` (or rewrite any `name:` prefix).
- **`src/engines/llama_cpp.rs`** (new) — `LlamaCppAdapter: EngineAdapter`
  - Health: `GET /health` (same as vLLM).
  - Model: parse from launch args (`-m` / `-hf`); **display the basename**
    (e.g. `Qwen3.8-27B-…-mtp.gguf`), skip HF enrichment (it's a file path).
  - Metrics: fetch `/metrics`, parse via `parse_prometheus_text`, reuse the
    `WarmupTracker` + `prev_*` rate state from `vllm.rs` (the delta/rate
    machinery ports verbatim). Map per §4. Leave §4.4 fields `None`.
  - **`/slots` poll**: track per-slot `is_processing` transitions for N (§4.2)
    and used/`n_ctx` for the KV estimate (§4.3).
  - `/metrics` 501 → metrics `None` but status still `Running` (engine detected
    via `/health`); optionally surface a "metrics disabled" flag (open, §10).
- **`src/engines/detector.rs`**
  - `ENGINE_BINARIES += ("llama-server", EngineType::LlamaCpp, "http://localhost:8080")`
    (llama.cpp default port is **8080**, not 8000).
  - `parse_endpoint_from_args` works **as-is** (`--host`/`--port`, 0.0.0.0→localhost).
  - New `parse_model_from_args_llama` (`-m <path>` / `--model <path>` / `-hf <repo>`).
  - `probe_engine`: `EngineType::LlamaCpp => GET /health` 200 (same as vLLM).
  - Docker path: match `image.contains("llama.cpp")` (i.e. `ghcr.io/ggml-org/llama.cpp:server*`)
    or `command.contains("llama-server")`; new `is_llama_process` for the
    name-only-candidate proof.

### 6.2 Frontend

- `frontend/src/types/metrics.ts`: `EngineType = 'Vllm' | 'LlamaCpp'`.
- New `frontend/src/lib/engineCapability.ts` (§5) + unit test.
- Panels/sections: gate rendering on the capability map (§5).
- **Per CLAUDE.md metrics-contract rule**, this change touches: Rust types/tests,
  TS types, formatters (`format.ts`), Vitest specs, components — all in one PR.

### 6.3 Wire / schema

- No `DASHBOARD_SCHEMA_VERSION` bump (we're not changing the dashboard document
  shape, only adding an engine type + display gating). Confirm N/A in the commit.

## 7. Testing

- **Rust unit tests** (primary gate — no live server):
  - `prometheus.rs`: a `llamacpp:` body parses to the right gauges/counters
    (mirror the existing `vllm_` tests).
  - `llama_cpp.rs`: a synthetic `/metrics` + `/slots` body set → assert the mapped
    `EngineMetrics` (§4.1–4.3), and that §4.4 fields stay `None`.
  - `detector.rs`: `llama-server … --host 0.0.0.0 --port 8098 -m /x/y.gguf`
    → endpoint `http://localhost:8098` + model basename; Docker image match.
- **Vitest**: capability map + section gating (a `LlamaCpp` snapshot hides the
  latency-distribution/queueing/scheduler sections; `Vllm` shows all).
- **Live smoke (ready — live server now has `--metrics`)**: point
  `spark-dashboard --engine-url http://127.0.0.1:8098` at the running Qwen3.8
  server, assert the populated tiles render and hidden sections don't.
- **Pre-commit gate** (CLAUDE.md): `cargo fmt --check`, `clippy -D warnings`,
  `cargo test --locked`; `npm run lint`, `npm run build`, `npm test -- --run`
  (+ `test:browser` only if a `*.browser.test.tsx` changed).

## 8. Version & operational caveats

- `--metrics` is **off by default** (501). The engine is still detected via
  `/health`; metrics stay empty until the server is relaunched with `--metrics`
  (or `LLAMA_ARG_ENDPOINT_METRICS=1`).
- Requires build **≥ b7191** (earlier builds emit JSON-escaped exposition).
- The surface shifts across builds: `spec_decode_*` added 2026-08-05;
  `kv_cache_*` removed; `prompt_tokens_cached_total` present in recent builds but
  not in the current README list → **read every metric "if present"**.
- **No labels** on any series → one scrape per server; router mode
  (`/metrics?model=`) is unstable across builds.
- Upstream is adding histograms ([#27011](https://github.com/ggml-org/llama.cpp/issues/27011),
  router-metrics discussion). Reading histogram keys **by name** (the vLLM
  `percentiles_ms` pattern) means a future build fills the distribution tiles
  with zero frontend change — just flip the capability-map entry.

## 9. Phasing

- **v1 (this branch):** §4.1 + §4.2 (`/slots`-derived N) + §5 (capability map;
  `kv_cache_percent` hidden). No log parsing.
- **Upgrade path (later branch):** a log-parser module (the app already has an
  engine-log pipeline) that yields an **accurate N** (seedable from container log
  history to engine-lifetime) and approximate **per-request TTFT/E2E/TPOT
  percentiles + goodput**. Isolated module + its own tests; v1 must not depend on it.

## 10. Open items & resolutions

1. **Uncommitted WIP** — **resolved 2026-09-25**: dropped the `TEMP-DIAG` lines in
   `detector.rs` (reverted to HEAD); kept the `index.html` title change.
2. **Live testing** — **resolved 2026-09-25**: relaunched the live Qwen3.8 server
   with `--metrics` (PID 1473871); it is the integration test target.
3. **Model name display**: basename (`…-mtp.gguf`) vs full path vs. an
   operator-set label.
4. **"metrics disabled" affordance**: when `/metrics` is 501, do we show a
   "start with `--metrics`" hint on the engine tile (small extra field) or just
   render empty tiles?

## 11. Live verification data (2026-09-25)

One 64-token completion (`"Write a short haiku about GPUs."`, `n_predict=64`) on
the relaunched server. Counters before → after:

| Metric | Before | After | Derived |
|---|---|---|---|
| `tokens_predicted_total` | 0 | 23 | — |
| `tokens_predicted_seconds_total` | 0 | 0.3637 | gen ≈ 23/0.3637 = **63 t/s** (gauge `predicted_tokens_seconds`=60.5) |
| `prompt_tokens_total` | 0 | 8 | — |
| `prompt_seconds_total` | 0 | 0.2038 | TTFT ≈ 0.2038/1 = **204 ms** |
| `n_decode_total` | 0 | 24 | — |
| `n_tokens_max` | 0 | 30 | prompt high-water (not total ctx) |

`/slots` flipped `is_processing` false→true→false over the request (N derivation
confirmed). Response `tokens_predicted=23`, `tokens_evaluated=8`. E2E ≈
(0.2038+0.3637)/1 = **568 ms**. TPOT ≈ 1000·0.3637/23 = **15.8 ms**.

## 12. End-to-end dashboard verification (2026-09-25)

Built the branch binary and ran a second instance on `127.0.0.1:3999`
(isolated `SPARK_DASHBOARD_STATE_DIR`) alongside the live engines; the user's
real dashboard on `:3000` was left untouched. **Detection** (process scan) found
both `vLLM @ :8086 (unsloth/Qwen3.8-27B-NVFP4)` and `llama.cpp @ :8098` (model
basename from the `-m` path). After one 16-token chat completion on 8098, the
live WebSocket snapshot for the llama.cpp engine read:

| Field | Wire value | Notes |
|---|---|---|
| `engine_type` | `"LlamaCpp"` | PascalCase — `EngineType` has no `serde rename_all`, so the variant name is the wire value; matches the `frontend` `EngineType` union |
| `model.name` | `Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf` | basename of the `-m` path (no params/quant for a local GGUF) |
| `warming_up` | `false` | N≥1 after the request |
| `total_requests` | `1` | **`/slots` false→true count — exactly one request fired (the keystone, confirmed)** |
| `ttft_ms` / `e2e_latency_ms` | `359` / `609` | post-attach means |
| `tpot_ms` / `inter_token_latency_ms` | `15.6` / `15.6` | per-token mean (ITL ≈ TPOT) |
| `per_request_tps` | `64.0` | generated tokens / predict-seconds |
| `total_prompt_tokens` / `total_generation_tokens` | `70` / `39` | engine-lifetime counters |
| `prefix_cache_hit_rate` | `0` | `prompt_tokens_cached_total` present, 0 cached (populated, not `None`) |
| `kv_cache_percent` / `preemptions_total` / `*_percentiles` / `*_goodput_pct` | `null` | genuinely absent → hidden by the capability map |

The vLLM engine was unchanged (`kv=5.3%`, `preemptions=0`, `total_requests=544`,
HF metadata `19.9B params`) — **no regression**. Frontend gating (KV / goodput /
queue / percentiles hidden for `LlamaCpp`; `llama.cpp` name + `llama-cpp.svg`
icon) is covered by the Vitest capability + format tests.
