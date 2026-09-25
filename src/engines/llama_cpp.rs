//! llama.cpp (`llama-server`) engine adapter.
//!
//! llama.cpp exposes a much smaller metric surface than vLLM: no histograms,
//! no request counter, no KV-usage gauge. This adapter maps what it *can*
//! provide (throughput, concurrency, token totals, mean TPOT/TTFT/E2E, prefix
//! cache, speculative decoding) and leaves everything else `None` so the UI
//! hides it rather than showing a dash or a confident zero.
//!
//! Two signals come from endpoints other than `/metrics`:
//! * **Request count (N)** — derived by polling `/slots` (default-on) and
//!   counting `is_processing` false→true transitions per slot. llama.cpp emits
//!   no request counter in `/metrics`. This is approximate (it misses
//!   sub-poll-interval requests) — see the spec §4.2 ceiling.
//! * **Model identity** — the launch `-m`/`-hf` arg (carried as `served_model`
//!   by the detector), falling back to `/v1/models`. Shown as the basename.
//!
//! Mean fields are computed over the post-attach window: on the first poll we
//! snapshot the cumulative counters as a baseline and subtract it thereafter,
//! so `mean = (Δtime / Δcount)` lines up with the post-attach request count N
//! instead of dividing engine-lifetime time by a partial request count.

use super::prometheus::parse_prometheus_text;
use super::{
    EngineAdapter, EngineMetrics, EngineStatus, EngineType, ModelInfo, ModelMetadataError,
    ModelResolution,
};
use async_trait::async_trait;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

/// Counter names (post-normalization: `llamacpp:` → `llamacpp_`).
const C_PROMPT_TOKENS: &str = "llamacpp_prompt_tokens_total";
const C_PROMPT_CACHED: &str = "llamacpp_prompt_tokens_cached_total";
const C_PROMPT_SECONDS: &str = "llamacpp_prompt_seconds_total";
const C_PREDICT_TOKENS: &str = "llamacpp_tokens_predicted_total";
const C_PREDICT_SECONDS: &str = "llamacpp_tokens_predicted_seconds_total";
const C_SPEC_DRAFT_TOKENS: &str = "llamacpp_spec_decode_num_draft_tokens_total";
const C_SPEC_ACCEPTED_TOKENS: &str = "llamacpp_spec_decode_num_accepted_tokens_total";
const C_SPEC_DRAFTS: &str = "llamacpp_spec_decode_num_drafts_total";

/// Gauge names.
const G_REQ_PROCESSING: &str = "llamacpp_requests_processing";
const G_REQ_DEFERRED: &str = "llamacpp_requests_deferred";
const G_BUSY_SLOTS_PER_DECODE: &str = "llamacpp_n_busy_slots_per_decode";

/// Cumulative-counter snapshot taken on the first successful `/metrics` poll.
/// Subsequent polls compute `current - baseline` (clamped ≥ 0) so mean fields
/// cover the same window as the `/slots`-derived request count. Reset on a
/// detected engine restart (any counter dropping below its baseline).
#[derive(Clone, Copy, Debug, Default)]
struct Baseline {
    prompt_tokens: f64,
    prompt_cached: f64,
    prompt_seconds: f64,
    predict_tokens: f64,
    predict_seconds: f64,
}

impl Baseline {
    fn from_count(counters: &HashMap<String, f64>) -> Self {
        Self {
            prompt_tokens: counters.get(C_PROMPT_TOKENS).copied().unwrap_or(0.0),
            prompt_cached: counters.get(C_PROMPT_CACHED).copied().unwrap_or(0.0),
            prompt_seconds: counters.get(C_PROMPT_SECONDS).copied().unwrap_or(0.0),
            predict_tokens: counters.get(C_PREDICT_TOKENS).copied().unwrap_or(0.0),
            predict_seconds: counters.get(C_PREDICT_SECONDS).copied().unwrap_or(0.0),
        }
    }

    /// Post-attach deltas (clamped non-negative). A counter missing from the
    /// current poll is treated as 0, so a `(0.0 - baseline).max(0)` → 0 delta.
    fn delta(&self, counters: &HashMap<String, f64>) -> Self {
        let d = |key: &str| counters.get(key).copied().unwrap_or(0.0);
        Self {
            prompt_tokens: (d(C_PROMPT_TOKENS) - self.prompt_tokens).max(0.0),
            prompt_cached: (d(C_PROMPT_CACHED) - self.prompt_cached).max(0.0),
            prompt_seconds: (d(C_PROMPT_SECONDS) - self.prompt_seconds).max(0.0),
            predict_tokens: (d(C_PREDICT_TOKENS) - self.predict_tokens).max(0.0),
            predict_seconds: (d(C_PREDICT_SECONDS) - self.predict_seconds).max(0.0),
        }
    }

    /// True if any tracked counter has fallen below its baseline — the
    /// canonical "engine restarted" signal (counters reset to 0).
    fn regressed(&self, counters: &HashMap<String, f64>) -> bool {
        let vals = [
            (self.prompt_tokens, C_PROMPT_TOKENS),
            (self.prompt_cached, C_PROMPT_CACHED),
            (self.prompt_seconds, C_PROMPT_SECONDS),
            (self.predict_tokens, C_PREDICT_TOKENS),
            (self.predict_seconds, C_PREDICT_SECONDS),
        ];
        vals.iter()
            .any(|&(b, key)| counters.get(key).is_some_and(|c| *c < b))
    }
}

/// One `/slots` entry, reduced to the fields the adapter uses: the slot id,
/// its processing state (request counting), and the live per-token progress
/// of the in-flight task (`id_task` + `next_token[].n_decoded`, the live
/// generation rate).
#[derive(Deserialize)]
struct Slot {
    id: u32,
    is_processing: bool,
    /// Task id of the in-flight request; changes when the slot starts a new
    /// task (re-baseline signal for the live rate).
    #[serde(default)]
    id_task: u64,
    /// Per-token progress of the in-flight task (`n_decoded` = tokens
    /// generated so far). Absent or empty while the slot is idle.
    #[serde(default)]
    next_token: Vec<NextToken>,
}

/// A `next_token` array element of a `/slots` entry. `n_decoded` is the
/// number of tokens generated so far in the current task — it advances per
/// token while the slot processes, unlike the lifetime
/// `tokens_predicted_total` metric counter.
#[derive(Deserialize)]
struct NextToken {
    #[serde(default)]
    n_decoded: i64,
}

/// Live generation rate (tokens/s) from per-slot `/slots` progress.
///
/// `prev` maps slot id → (id_task, n_decoded, timestamp) from the last
/// poll. Returns `Some(0.0)` when no slot is processing, `Some(rate)` when
/// at least one processing slot has a usable delta, and `None` when slots
/// are processing but none has a baseline yet (first tick of a new task).
fn live_generation_rate(
    prev: &HashMap<u32, (u64, i64, Instant)>,
    now: Instant,
    slots: &[Slot],
) -> Option<f64> {
    let mut rate = 0.0;
    let mut have_delta = false;
    let mut any_processing = false;
    for slot in slots {
        if !slot.is_processing {
            continue;
        }
        any_processing = true;
        let decoded: i64 = slot.next_token.iter().map(|t| t.n_decoded).sum();
        if let Some(&(task, prev_n, pt)) = prev.get(&slot.id) {
            // Re-baseline (no rate this tick) when the task changed or the
            // counter regressed — `decoded` is not comparable then.
            if slot.id_task == task && decoded >= prev_n {
                let elapsed = now.duration_since(pt).as_secs_f64();
                if elapsed > 0.0 {
                    rate += (decoded - prev_n) as f64 / elapsed;
                    have_delta = true;
                }
            }
        }
    }
    match (any_processing, have_delta) {
        (false, _) => Some(0.0),
        (true, true) => Some(rate),
        (true, false) => None,
    }
}

pub struct LlamaCppAdapter {
    client: reqwest::Client,
    endpoint: String,
    /// Optional bearer token. llama.cpp's own `/health`, `/metrics` and
    /// `/v1/models` are open, but a fronting proxy may gate them; applied
    /// harmlessly when set.
    api_key: Option<String>,
    /// Model identity recovered from the launch command line (`-m`/`-hf`),
    /// carried by the detector as `served_model`.
    served_model: Option<String>,

    /// Attach baseline for mean fields (None until the first successful poll).
    baseline: Mutex<Option<Baseline>>,
    /// Per-poll rate state: previous raw counter value + timestamp (prompt
    /// rate only — the generation rate comes from `/slots`, see `slot_gen`).
    prev_prompt_tokens: Mutex<Option<(f64, Instant)>>,
    /// Per-slot live generation progress: slot id → (id_task, n_decoded,
    /// Instant). The lifetime `tokens_predicted_total` counter is only
    /// flushed at request completion in current llama.cpp builds (the server
    /// adds a slot's whole `n_gen` in `metrics_on_prediction`, fired from the
    /// slot's reset callback), so per-poll deltas of it read 0 during a
    /// running job and spike by the full request size on completion. The
    /// per-slot `next_token[].n_decoded` counter advances per token instead.
    slot_gen: Mutex<HashMap<u32, (u64, i64, Instant)>>,
    /// Previous (accepted, draft) spec-decode counters for the live TAR.
    prev_spec_decode: Mutex<Option<(f64, f64)>>,
    /// Running averages of the live rates: (sum of non-zero readings, count).
    avg_accum: Mutex<(f64, u64)>,
    avg_prompt_accum: Mutex<(f64, u64)>,

    /// Per-slot `is_processing` from the last `/slots` poll (slot id → state),
    /// used to count false→true (request started) transitions.
    slot_state: Mutex<HashMap<u32, bool>>,
    /// Post-attach request count (started requests observed via `/slots`).
    requests_started: Mutex<u64>,
    /// Set when a `/metrics` scrape returns 501 (server started without
    /// `--metrics`). Surfaced on the snapshot so the UI can say why there are
    /// no metrics rather than a generic "waiting".
    metrics_disabled: AtomicBool,
}

impl LlamaCppAdapter {
    pub fn new(
        client: reqwest::Client,
        endpoint: String,
        served_model: Option<String>,
        api_key: Option<String>,
    ) -> Self {
        Self {
            client,
            endpoint,
            api_key,
            served_model,
            baseline: Mutex::new(None),
            prev_prompt_tokens: Mutex::new(None),
            slot_gen: Mutex::new(HashMap::new()),
            prev_spec_decode: Mutex::new(None),
            avg_accum: Mutex::new((0.0, 0)),
            avg_prompt_accum: Mutex::new((0.0, 0)),
            slot_state: Mutex::new(HashMap::new()),
            requests_started: Mutex::new(0),
            metrics_disabled: AtomicBool::new(false),
        }
    }

    fn auth(&self, rb: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.api_key {
            Some(key) => rb.bearer_auth(key),
            None => rb,
        }
    }

    /// GET `url`, returning the body on success. `None` on any failure
    /// (connection error, non-2xx). Used for `/metrics` (a 501 when the server
    /// lacks `--metrics` yields `None` → metrics blank, but the engine is still
    /// detected via `/health`).
    async fn get_text(&self, url: String) -> Option<String> {
        let resp = self
            .auth(self.client.get(url).timeout(Duration::from_secs(2)))
            .send()
            .await
            .ok()?;
        if !resp.status().is_success() {
            return None;
        }
        resp.text().await.ok()
    }

    /// Poll `/slots`, fold the per-slot `is_processing` transitions into the
    /// request count, and track per-slot generation progress for the live
    /// rate. Returns (post-attach request count, live tokens/s). On a
    /// `/slots` failure (endpoint disabled / error) the previous count is
    /// returned unchanged and the live rate is `None` — request counting
    /// degrades gracefully rather than resetting.
    async fn observe_slots(&self) -> (u64, Option<f64>) {
        let url = format!("{}/slots", self.endpoint);
        let body = match self.get_text(url).await {
            Some(b) => b,
            None => {
                return (*self.requests_started.lock().await, None);
            }
        };
        let slots: Vec<Slot> = match serde_json::from_str(&body) {
            Ok(s) => s,
            Err(e) => {
                tracing::debug!(endpoint = %self.endpoint, error = %e, "/slots parse failed");
                return (*self.requests_started.lock().await, None);
            }
        };

        let now = Instant::now();
        let mut state = self.slot_state.lock().await;
        let mut started = self.requests_started.lock().await;

        // Count false→true (request started) per slot. A slot seen for the
        // first time only establishes its state — no transition is counted, so
        // a request already in flight at attach is not double-counted later.
        for slot in &slots {
            let was = *state.get(&slot.id).unwrap_or(&false);
            let processing = slot.is_processing;
            if !was && processing {
                *started += 1;
            }
            state.insert(slot.id, processing);
        }

        // Live generation rate against the previous tick's per-slot progress,
        // then re-baseline the slots still processing.
        let live;
        {
            let mut gen = self.slot_gen.lock().await;
            live = live_generation_rate(&gen, now, &slots);
            gen.retain(|id, _| slots.iter().any(|s| s.id == *id && s.is_processing));
            for slot in &slots {
                if slot.is_processing {
                    let decoded: i64 = slot.next_token.iter().map(|t| t.n_decoded).sum();
                    gen.insert(slot.id, (slot.id_task, decoded, now));
                }
            }
        }
        (*started, live)
    }
}

#[async_trait]
impl EngineAdapter for LlamaCppAdapter {
    fn engine_type(&self) -> EngineType {
        EngineType::LlamaCpp
    }

    fn endpoint(&self) -> &str {
        &self.endpoint
    }

    fn metrics_disabled(&self) -> bool {
        self.metrics_disabled.load(Ordering::Relaxed)
    }

    async fn health_check(&self) -> EngineStatus {
        match self
            .auth(
                self.client
                    .get(format!("{}/health", self.endpoint))
                    .timeout(Duration::from_secs(2)),
            )
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => EngineStatus::Running,
            Ok(r) => EngineStatus::Error(format!("HTTP {}", r.status())),
            Err(e) => EngineStatus::Error(e.to_string()),
        }
    }

    async fn get_model_info(&self) -> ModelResolution {
        // llama.cpp's `/v1/models` lists the model by name; the launch `-m`/`-hf`
        // arg (carried as `served_model`) is the authoritative identity. Prefer
        // the API value when present, fall back to the hint. Both are usually
        // the same `.gguf` path.
        let api_name = match self
            .auth(
                self.client
                    .get(format!("{}/v1/models", self.endpoint))
                    .timeout(Duration::from_secs(2)),
            )
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                match resp.json::<LlamaCppModelsResponse>().await {
                    Ok(m) => m
                        .models
                        .first()
                        .and_then(|m| m.name.clone().or_else(|| m.model.clone())),
                    Err(_) => None,
                }
            }
            Ok(resp) => {
                let metadata_error = classify_models_error_status(resp.status().as_u16());
                if metadata_error == ModelMetadataError::AuthRequired {
                    tracing::warn!(
                        endpoint = %self.endpoint,
                        status = %resp.status(),
                        "/v1/models rejected the request as unauthorized — \
                         configure a provider API key to read model metadata",
                    );
                } else {
                    tracing::debug!(
                        endpoint = %self.endpoint,
                        status = %resp.status(),
                        "/v1/models returned non-success",
                    );
                }
                return ModelResolution {
                    model: self.served_model.as_ref().map(|n| model_from_name(n)),
                    metadata_error: Some(metadata_error),
                };
            }
            Err(e) => {
                tracing::debug!(endpoint = %self.endpoint, error = %e, "/v1/models request failed");
                return ModelResolution {
                    model: self.served_model.as_ref().map(|n| model_from_name(n)),
                    metadata_error: Some(ModelMetadataError::Unavailable),
                };
            }
        };

        let name = api_name.or_else(|| self.served_model.clone());
        let Some(name) = name else {
            return ModelResolution {
                model: None,
                metadata_error: None,
            };
        };

        // Metadata enrichment (params/quant) is HF-repo-based and N/A for a
        // local `.gguf` path — only the name is populated.
        ModelResolution {
            model: Some(model_from_name(&name)),
            metadata_error: None,
        }
    }

    async fn get_metrics(&self) -> Option<EngineMetrics> {
        let url = format!("{}/metrics", self.endpoint);
        let resp = self
            .auth(self.client.get(url).timeout(Duration::from_secs(2)))
            .send()
            .await
            .ok()?;
        // A 501 means the server was started without `--metrics`: a distinct,
        // actionable state (the UI shows a hint) rather than a transient error.
        // Any success clears it (the server has since gained the flag).
        if resp.status().as_u16() == 501 {
            self.metrics_disabled.store(true, Ordering::Relaxed);
            return None;
        }
        if !resp.status().is_success() {
            return None;
        }
        self.metrics_disabled.store(false, Ordering::Relaxed);
        let body = resp.text().await.ok()?;
        let raw = parse_prometheus_text(&body)?;

        // Request count from /slots (post-attach, approximate) + the live
        // generation rate from per-slot progress (see `slot_gen`).
        let (requests, live_gen_tps) = self.observe_slots().await;
        let warming_up = requests < 1;

        // Baseline at attach + restart detection.
        let mut baseline_lock = self.baseline.lock().await;
        let restarted = baseline_lock
            .as_ref()
            .is_some_and(|b| b.regressed(&raw.counters));
        if restarted || baseline_lock.is_none() {
            *baseline_lock = Some(Baseline::from_count(&raw.counters));
            if restarted {
                // Engine restarted: reset the post-attach request count, the
                // per-poll rate state, the running averages, and the spec-decode
                // delta state so nothing diffs against a stale pre-restart value.
                *self.requests_started.lock().await = 0;
                *self.prev_prompt_tokens.lock().await = None;
                *self.slot_gen.lock().await = HashMap::new();
                *self.prev_spec_decode.lock().await = None;
                *self.avg_accum.lock().await = (0.0, 0);
                *self.avg_prompt_accum.lock().await = (0.0, 0);
                tracing::info!(
                    endpoint = %self.endpoint,
                    "llama.cpp counters regressed — treating as restart, re-baselining"
                );
            }
        }
        let delta = baseline_lock
            .as_ref()
            .expect("baseline just set")
            .delta(&raw.counters);
        drop(baseline_lock);

        // --- Live per-poll rates (window throughput; 0 when idle) ---
        // Generation: live per-slot `n_decoded` progress from `/slots` (the
        // lifetime counter only flushes at request completion — `slot_gen`).
        let tokens_per_sec = live_gen_tps;
        // Prompt: per-poll delta of the lifetime counter (prefill completes
        // within a few ticks, so its completion-time flush is not
        // misleadingly spiky).
        let prompt_tokens_per_sec = {
            let now = Instant::now();
            let prompt_now = raw.counters.get(C_PROMPT_TOKENS).copied();
            let mut prev = self.prev_prompt_tokens.lock().await;
            let tps = match (prompt_now, prev.as_ref()) {
                (Some(cur), Some(&(pv, pt))) => {
                    let elapsed = now.duration_since(pt).as_secs_f64();
                    if elapsed > 0.0 {
                        Some((cur - pv) / elapsed)
                    } else {
                        None
                    }
                }
                _ => None,
            };
            if let Some(v) = prompt_now {
                *prev = Some((v, now));
            }
            tps
        };

        // --- Running averages of the live rates (only accumulate when > 0) ---
        let avg_tokens_per_sec = {
            let mut acc = self.avg_accum.lock().await;
            if let Some(tps) = tokens_per_sec {
                if tps > 0.0 {
                    acc.0 += tps;
                    acc.1 += 1;
                }
            }
            (acc.1 > 0).then_some(acc.0 / acc.1 as f64)
        };
        let avg_prompt_tokens_per_sec = {
            let mut acc = self.avg_prompt_accum.lock().await;
            if let Some(tps) = prompt_tokens_per_sec {
                if tps > 0.0 {
                    acc.0 += tps;
                    acc.1 += 1;
                }
            }
            (acc.1 > 0).then_some(acc.0 / acc.1 as f64)
        };

        // --- Post-attach mean fields (blanked while warming) ---
        let tpot_ms = (delta.predict_tokens > 0.0)
            .then(|| 1000.0 * delta.predict_seconds / delta.predict_tokens);
        let per_request_tps =
            (delta.predict_seconds > 0.0).then(|| delta.predict_tokens / delta.predict_seconds);
        let per_request_prompt_tps =
            (delta.prompt_seconds > 0.0).then(|| delta.prompt_tokens / delta.prompt_seconds);
        // Inter-token latency ≈ mean time per generated token (same as TPOT).
        let inter_token_latency_ms = tpot_ms;
        // Mean TTFT (prefill time per request) and E2E (prefill+decode per
        // request), over the post-attach window.
        let ttft_ms = (requests > 0).then(|| 1000.0 * delta.prompt_seconds / requests as f64);
        let e2e_latency_ms = (requests > 0)
            .then(|| 1000.0 * (delta.prompt_seconds + delta.predict_seconds) / requests as f64);

        // --- Pass-through gauges ---
        let active_requests = raw.gauges.get(G_REQ_PROCESSING).map(|v| *v as u64);
        let queued_requests = raw.gauges.get(G_REQ_DEFERRED).map(|v| *v as u64);
        let avg_batch_size = raw.gauges.get(G_BUSY_SLOTS_PER_DECODE).copied();

        // --- Prefix cache (if the counter is present on this build) ---
        let prefix_cache_hit_rate = {
            let processed = delta.prompt_tokens;
            let cached = delta.prompt_cached;
            let queried = cached + processed;
            (queried > 0.0).then(|| (cached / queried) * 100.0)
        };
        let prefix_cache_queries_total =
            (delta.prompt_cached + delta.prompt_tokens).max(0.0) as u64;

        // --- Cumulative (engine-lifetime) totals, read from raw ---
        let total_generation_tokens = raw
            .counters
            .get(C_PREDICT_TOKENS)
            .map(|v| v.max(0.0) as u64);
        let total_prompt_tokens = raw.counters.get(C_PROMPT_TOKENS).map(|v| v.max(0.0) as u64);

        // --- Speculative decoding (raw lifetime counters; present but 0 without
        // a draft model) ---
        let spec = |name: &str| raw.counters.get(name).copied();
        let spec_draft = spec(C_SPEC_DRAFT_TOKENS);
        let spec_accepted = spec(C_SPEC_ACCEPTED_TOKENS);
        let spec_drafts = spec(C_SPEC_DRAFTS);

        let spec_decode_draft_tokens_total = spec_draft.map(|v| v.max(0.0) as u64);
        let spec_decode_accepted_tokens_total = spec_accepted.map(|v| v.max(0.0) as u64);
        let spec_decode_drafts_total = spec_drafts.map(|v| v.max(0.0) as u64);
        let spec_decode_acceptance_rate = spec_acceptance_rate(spec_accepted, spec_draft);
        let spec_decode_mean_acceptance_length =
            spec_mean_acceptance_length(spec_accepted, spec_drafts);
        // Live (windowed) TAR from per-poll deltas.
        let spec_decode_acceptance_rate_live = {
            let mut prev = self.prev_spec_decode.lock().await;
            match (spec_accepted, spec_draft) {
                (Some(acc), Some(draft)) => {
                    let live = prev.as_ref().and_then(|&(pa, pd)| {
                        if acc >= pa && draft >= pd {
                            spec_acceptance_rate(Some(acc - pa), Some(draft - pd))
                        } else {
                            None
                        }
                    });
                    *prev = Some((acc, draft));
                    live
                }
                _ => {
                    *prev = None;
                    None
                }
            }
        };

        // While warming (no request observed yet) blank the derived mean/rate
        // fields so the first slow inference does not skew steady-state values.
        // Gauges and lifetime totals stay populated.
        let blank = warming_up;
        Some(EngineMetrics {
            tokens_per_sec: if blank { None } else { tokens_per_sec },
            avg_tokens_per_sec: if blank { None } else { avg_tokens_per_sec },
            per_request_tps: if blank { None } else { per_request_tps },
            ttft_ms: if blank { None } else { ttft_ms },
            active_requests,
            queued_requests,
            // No live KV-in-use field on llama.cpp — left hidden (None).
            kv_cache_percent: None,
            kv_cache_is_estimated: false,
            total_requests: Some(requests),
            e2e_latency_ms: if blank { None } else { e2e_latency_ms },
            prompt_tokens_per_sec: if blank { None } else { prompt_tokens_per_sec },
            avg_prompt_tokens_per_sec: if blank {
                None
            } else {
                avg_prompt_tokens_per_sec
            },
            per_request_prompt_tps: if blank { None } else { per_request_prompt_tps },
            swapped_requests: None,
            prefix_cache_hit_rate,
            queue_time_ms: None,
            inter_token_latency_ms: if blank { None } else { inter_token_latency_ms },
            preemptions_total: None,
            total_prompt_tokens,
            total_generation_tokens,
            prefix_cache_queries_total: Some(prefix_cache_queries_total),
            avg_batch_size: if blank { None } else { avg_batch_size },
            // No histograms on llama.cpp — all distribution fields hidden.
            ttft_percentiles: None,
            itl_percentiles: None,
            e2e_percentiles: None,
            ttft_goodput_pct: None,
            itl_goodput_pct: None,
            e2e_goodput_pct: None,
            ttft_buckets: None,
            itl_buckets: None,
            e2e_buckets: None,
            tpot_ms: if blank { None } else { tpot_ms },
            tpot_percentiles: None,
            tpot_goodput_pct: None,
            tpot_buckets: None,
            spec_decode_draft_tokens_total,
            spec_decode_accepted_tokens_total,
            spec_decode_drafts_total,
            spec_decode_acceptance_rate,
            spec_decode_acceptance_rate_live: if blank {
                None
            } else {
                spec_decode_acceptance_rate_live
            },
            spec_decode_mean_acceptance_length,
            warming_up,
        })
    }
}

/// `/v1/models` reply shape for llama.cpp (`{"models":[{"name":…,"model":…}]}`),
/// which differs from vLLM's OpenAI `{"data":[{"id":…}]}`.
#[derive(Deserialize)]
struct LlamaCppModelsResponse {
    #[serde(default)]
    models: Vec<LlamaCppModel>,
}

#[derive(Deserialize)]
struct LlamaCppModel {
    name: Option<String>,
    model: Option<String>,
}

/// Reduce a model identifier (usually a `.gguf` filesystem path) to a
/// display `ModelInfo`. Only the name is populated — parameter/quant metadata
/// would require HF-repo or GGUF-header parsing, which is out of scope. The
/// basename of the path is shown so the tile reads as a model name rather than
/// a full path.
fn model_from_name(name: &str) -> ModelInfo {
    let display = name
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(name)
        .to_string();
    ModelInfo {
        name: display,
        parameter_size: None,
        quantization: None,
        precision: None,
        tensor_type: None,
        model_type: None,
        pipeline_tag: None,
    }
}

/// Classify a non-success `/v1/models` status the same way the vLLM adapter
/// does: 401/403 = auth required (operator configures a key), else a generic
/// unavailability.
fn classify_models_error_status(status: u16) -> ModelMetadataError {
    match status {
        401 | 403 => ModelMetadataError::AuthRequired,
        _ => ModelMetadataError::Unavailable,
    }
}

/// Token acceptance rate (TAR) as a percentage: `accepted / draft * 100`.
/// `None` unless both are present, `draft > 0`, and `accepted >= 0`.
fn spec_acceptance_rate(accepted: Option<f64>, draft: Option<f64>) -> Option<f64> {
    match (accepted, draft) {
        (Some(a), Some(d)) if d > 0.0 && a >= 0.0 => Some((a / d) * 100.0),
        _ => None,
    }
}

/// Mean acceptance length: `accepted / drafts`. `None` unless `drafts > 0`.
fn spec_mean_acceptance_length(accepted: Option<f64>, drafts: Option<f64>) -> Option<f64> {
    match (accepted, drafts) {
        (Some(a), Some(n)) if n > 0.0 => Some(a / n),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a `/metrics` body from a counter/gauge table, in llama.cpp's
    /// `llamacpp:` colon form (exactly as the live server emits it).
    fn metrics_body(counters: &[(&str, f64)], gauges: &[(&str, f64)]) -> String {
        let mut s = String::new();
        for (name, v) in counters {
            s.push_str(&format!(
                "# TYPE llamacpp:{name} counter\nllamacpp:{name} {v}\n"
            ));
        }
        for (name, v) in gauges {
            s.push_str(&format!(
                "# TYPE llamacpp:{name} gauge\nllamacpp:{name} {v}\n"
            ));
        }
        s
    }

    /// The prefix normalizer must route `llamacpp:` counters and gauges into the
    /// right buckets — the whole adapter depends on these keys.
    #[test]
    fn parses_llamacpp_counters_and_gauges() {
        let body = metrics_body(
            &[
                ("tokens_predicted_total", 100.0),
                ("prompt_tokens_total", 40.0),
            ],
            &[
                ("requests_processing", 2.0),
                ("n_busy_slots_per_decode", 1.5),
            ],
        );
        let p = parse_prometheus_text(&body).expect("parse");
        assert_eq!(p.counters.get(C_PREDICT_TOKENS), Some(&100.0));
        assert_eq!(p.counters.get(C_PROMPT_TOKENS), Some(&40.0));
        assert_eq!(p.gauges.get(G_REQ_PROCESSING), Some(&2.0));
        assert_eq!(p.gauges.get(G_BUSY_SLOTS_PER_DECODE), Some(&1.5));
    }

    /// `model_from_name` shows the basename of a `.gguf` path and passes
    /// through bare ids.
    #[test]
    fn model_name_is_basename_of_path() {
        let m = model_from_name("/home/x/models/Qwen3.8-27B-IQ3_S.gguf");
        assert_eq!(m.name, "Qwen3.8-27B-IQ3_S.gguf");
        assert_eq!(model_from_name("org/model").name, "model");
        assert_eq!(model_from_name("alias").name, "alias");
    }

    /// Baseline deltas are clamped non-negative and track post-attach growth.
    #[test]
    fn baseline_delta_tracks_post_attach_growth() {
        let base = Baseline {
            prompt_tokens: 10.0,
            prompt_cached: 0.0,
            prompt_seconds: 1.0,
            predict_tokens: 50.0,
            predict_seconds: 2.0,
        };
        let counters: HashMap<String, f64> = [
            (C_PROMPT_TOKENS, 25.0),
            (C_PROMPT_CACHED, 0.0),
            (C_PROMPT_SECONDS, 3.0),
            (C_PREDICT_TOKENS, 200.0),
            (C_PREDICT_SECONDS, 5.0),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), *v))
        .collect();
        let d = base.delta(&counters);
        assert_eq!(d.prompt_tokens, 15.0);
        assert_eq!(d.prompt_seconds, 2.0);
        assert_eq!(d.predict_tokens, 150.0);
        assert_eq!(d.predict_seconds, 3.0);
        // A counter that dropped below baseline clamps to 0 (no negatives).
        let dropped: HashMap<String, f64> = [(C_PREDICT_TOKENS, 10.0)]
            .iter()
            .map(|(k, v)| (k.to_string(), *v))
            .collect();
        assert_eq!(base.delta(&dropped).predict_tokens, 0.0);
    }

    /// A counter dropping below its baseline is a restart signal.
    #[test]
    fn baseline_regression_detects_restart() {
        let base = Baseline {
            prompt_tokens: 0.0,
            prompt_cached: 0.0,
            prompt_seconds: 0.0,
            predict_tokens: 100.0,
            predict_seconds: 10.0,
        };
        let counters: HashMap<String, f64> = [(C_PREDICT_TOKENS, 0.0)]
            .iter()
            .map(|(k, v)| (k.to_string(), *v))
            .collect();
        assert!(base.regressed(&counters));
    }

    /// A realistic `/slots` body (current llama.cpp build) deserializes with
    /// the task id and live per-token progress; idle slots without
    /// `next_token` data still parse.
    #[test]
    fn parses_slots_live_progress() {
        let body = r#"[
            {"id":0,"n_ctx":8192,"is_processing":false,"id_task":7,"next_token":[{"n_remain":-1,"n_decoded":0}]},
            {"id":1,"n_ctx":8192,"is_processing":true,"id_task":8,"next_token":[{"n_remain":100,"n_decoded":42}]},
            {"id":2,"n_ctx":8192,"is_processing":true}
        ]"#;
        let slots: Vec<Slot> = serde_json::from_str(body).expect("parse");
        assert_eq!(slots[1].id_task, 8);
        assert_eq!(slots[1].next_token[0].n_decoded, 42);
        // `next_token`/`id_task` are optional (older builds may omit them).
        assert_eq!(slots[2].id_task, 0);
        assert!(slots[2].next_token.is_empty());
    }

    /// Live generation rate from per-slot progress: 0 when idle, the sum of
    /// per-slot deltas while decoding, None on the first tick of a new task,
    /// and re-baselined when a task changes or the counter regresses.
    #[test]
    fn live_rate_tracks_per_slot_progress() {
        let t0 = Instant::now();
        let t1 = t0 + Duration::from_secs(1);

        let idle: [Slot; 0] = [];
        assert_eq!(live_generation_rate(&HashMap::new(), t1, &idle), Some(0.0));

        fn slot(id: u32, task: u64, decoded: i64) -> Slot {
            Slot {
                id,
                is_processing: true,
                id_task: task,
                next_token: vec![NextToken { n_decoded: decoded }],
            }
        }

        // First tick of a new task: no baseline yet → None.
        assert_eq!(
            live_generation_rate(&HashMap::new(), t0, &[slot(0, 100, 0)]),
            None
        );

        // One second later the same task has 60 decoded tokens → 60 tok/s.
        let mut prev: HashMap<u32, (u64, i64, Instant)> = HashMap::new();
        prev.insert(0, (100, 0, t0));
        assert_eq!(
            live_generation_rate(&prev, t1, &[slot(0, 100, 60)]),
            Some(60.0)
        );

        // Second slot joins with its own baseline → rates sum.
        prev.insert(1, (101, 0, t0));
        let slots = [slot(0, 100, 90), slot(1, 101, 30)];
        // 90/1s + 30/1s = 120 tok/s.
        assert_eq!(live_generation_rate(&prev, t1, &slots), Some(120.0));

        // Task change on slot 0: no comparable baseline for it, slot 0
        // re-baselines silently; slot 1 still rates (45/1s).
        let slots = [slot(0, 101, 0), slot(1, 101, 45)];
        assert_eq!(live_generation_rate(&prev, t1, &slots), Some(45.0));

        // Both tasks changed → no usable delta while slots are processing.
        let mut prev2: HashMap<u32, (u64, i64, Instant)> = HashMap::new();
        prev2.insert(0, (100, 5, t0));
        let slots = [slot(0, 200, 0)];
        assert_eq!(live_generation_rate(&prev2, t1, &slots), None);

        // Counter regression on the same task re-baselines instead of
        // emitting a negative rate.
        let mut prev3: HashMap<u32, (u64, i64, Instant)> = HashMap::new();
        prev3.insert(0, (100, 50, t0));
        let slots = [slot(0, 100, 5)];
        assert_eq!(live_generation_rate(&prev3, t1, &slots), None);
    }

    /// `/metrics` returning 501 (llama-server started without `--metrics`)
    /// yields no metrics and sets the `metrics_disabled` flag, so the UI can
    /// tell the operator why; a fresh adapter starts clean.
    #[tokio::test]
    async fn metrics_disabled_flag_tracks_501() {
        use axum::http::StatusCode;
        use axum::routing::get;

        async fn metrics_501() -> StatusCode {
            StatusCode::NOT_IMPLEMENTED
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = axum::Router::new().route("/metrics", get(metrics_501));
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let adapter =
            LlamaCppAdapter::new(reqwest::Client::new(), format!("http://{addr}"), None, None);
        assert!(!adapter.metrics_disabled(), "fresh adapter is not disabled");
        assert!(
            adapter.get_metrics().await.is_none(),
            "a 501 yields no metrics"
        );
        assert!(adapter.metrics_disabled(), "a 501 sets the disabled flag");
    }
}
