//! TensorFold's `tensorfold-native` server (github.com/ashhart/TensorFold):
//! an open-source Zig inference engine that serves the OpenAI-compatible API
//! and Prometheus metrics under a `tensorfold:` name prefix.
//!
//! What the adapter reports comes from `/v1/metrics` (older releases answer
//! `/metrics`; v1.1.3 mounts both). The engine counts requests and tokens,
//! KV-cache occupancy per pool, the request latency histograms, time to first
//! token, time per output token, prefill and decode seconds, decode rounds,
//! and its MTP speculative-decoding counters. It has no queue-time histogram
//! and no separate inter-token-latency histogram: time per output token is the
//! gap between generated tokens, so those two groups are left out (ADR-0004)
//! rather than filled with a stand-in — `request_time_per_output_token_seconds`
//! is what the TPOT tiles read.
//!
//! Auth is `--api-key` / `--api-key-file` / `TENSORFOLD_API_KEY`, a bearer
//! token. With keys configured every route needs one except `/`, `/health` and
//! `/slide`, and `/health` then answers only `{"status":"ok"}`. The metrics
//! route is mounted whether or not a key gates it, so metrics are never "off":
//! a refused scrape is the dashboard missing the key, carried as
//! `metrics_error` (`AuthRequired`), not as a launch flag.

use super::common::{
    spec_acceptance_rate, spec_live_acceptance_rate, warmup_skip_from_env, CounterRate, EngineHttp,
};
use super::histogram::{goodput_pct, mean_ms, percentiles_ms, wire_buckets};
use super::model_info::ModelResolver;
use super::prometheus::{parse_prometheus_text, ParsedMetrics};
use super::warmup::WarmupTracker;
use super::{
    EngineAdapter, EngineMetrics, EngineStatus, EngineType, MetricGroup, MetricsError,
    ModelResolution, E2E_SLO_MS, TPOT_SLO_MS, TTFT_SLO_MS,
};
use async_trait::async_trait;
use reqwest::StatusCode;
use serde_json::Value;
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use tokio::sync::Mutex;

/// The request counter warmup progress is measured on: every TensorFold
/// request adds one observation to the time-to-first-token histogram, as on
/// vLLM and SGLang.
const WARMUP_TRIGGER_KEY: &str = "tensorfold_time_to_first_token_seconds_count";

/// TensorFold's metrics route, `/v1/metrics`, and on older builds the same
/// exposition on `/metrics`.
pub const METRICS_PATH: &str = "/v1/metrics";

/// The older builds' spelling of the same route, tried when `/v1/metrics`
/// answers 404.
const LEGACY_METRICS_PATH: &str = "/metrics";

/// The health route, open even when an API key gates the rest.
const HEALTH_PATH: &str = "/health";

/// Upstream's queue-wait histograms, rendered only under
/// `TENSORFOLD_PHASE_METRICS=1`: its own name and the vLLM mirror. Either one
/// proves the phase families are mounted.
const QUEUE_WAIT_HISTOGRAMS: [&str; 2] = [
    "tensorfold_request_queue_seconds",
    "tensorfold_request_queue_time_seconds",
];

pub struct TensorfoldAdapter {
    /// The endpoint, and the bearer token of a launch with `--api-key` (or its
    /// environment variable). `/health` is open, the metrics routes are not.
    http: EngineHttp,
    /// Model identity: `/v1/models`, the command-line hint (`--name`), HF
    /// enrichment — shared with the vLLM and SGLang adapters, since
    /// TensorFold's `/v1/models` answers identically.
    model: ModelResolver,
    /// Generation tokens/s and its running average.
    gen_rate: Mutex<CounterRate>,
    /// Prompt tokens/s and its running average.
    prompt_rate: Mutex<CounterRate>,
    /// The `(accepted, drafted)` MTP counters of the last scrape, for the live
    /// acceptance rate. Cleared at the warmup baseline, and whenever a counter
    /// is absent or went backwards.
    prev_spec_decode: Mutex<Option<(f64, f64)>>,
    warmup: Mutex<WarmupTracker>,
    /// Latched by each answered scrape: true when the metrics route refused
    /// the dashboard (401/403), false once it answers. The route itself is
    /// always mounted, so a refusal is the one reason metrics are unreadable —
    /// never "metrics off". An unreachable server leaves the latch alone: it
    /// is offline, not refused.
    metrics_unauthorized: AtomicBool,
    /// Whether a scrape has carried TensorFold's optional prompt-cache
    /// families. `PrefixCache` is a per-engine decision, not a per-type one:
    /// only engines that keep prompt states publish the families, and a scrape
    /// that has never shown one reads as "this engine does not report it"
    /// rather than as the tile's "not yet". Monotonic: the families do not come
    /// and go for one engine.
    prefix_cache_seen: AtomicBool,
    /// Whether a scrape has carried the optional queue-wait histograms, which
    /// upstream renders only under `TENSORFOLD_PHASE_METRICS=1`. `QueueTime` is
    /// a per-launch decision like `PrefixCache`: a launch without the phase
    /// families has no queue-wait measurement, so its tile says "not reported"
    /// instead of a permanent dash.
    queue_wait_seen: AtomicBool,
    /// Whether a scrape has carried the preemption counter. Upstream publishes
    /// it only where the server counts preemption events and never at a
    /// fabricated zero, so an engine whose scrape has never shown it reports no
    /// `Preemptions` rather than an empty declared group.
    preemptions_seen: AtomicBool,
    /// The engine's own live rates from its last `/health` answer: the tokens
    /// it decoded and prefilled in its last 2 s window, divided by 2 — the
    /// same figure its terminal line and its `--dashboard` page show. `/health`
    /// is open even when an API key gates the rest, but such a launch answers
    /// only `{"status":"ok"}`, so the rates are `None` there and the scrape
    /// counters are diffed instead.
    live_rates: Mutex<Option<LiveRates>>,
    /// Running means of the engine-reported generation and prefill rates, for
    /// the `avg_*` fields beside them. Only polls that saw throughput count, so
    /// the average holds steady while the engine idles — the rule
    /// `CounterRate` follows for the counter-diffed fallback.
    decode_rate_mean: Mutex<RateMean>,
    prefill_rate_mean: Mutex<RateMean>,
}

impl TensorfoldAdapter {
    pub fn new(
        client: reqwest::Client,
        endpoint: String,
        served_model: Option<String>,
        api_key: Option<String>,
    ) -> Self {
        Self {
            http: EngineHttp::new(client, endpoint, api_key),
            model: ModelResolver::new(served_model),
            gen_rate: Mutex::default(),
            prompt_rate: Mutex::default(),
            prev_spec_decode: Mutex::default(),
            warmup: Mutex::new(WarmupTracker::new(
                warmup_skip_from_env(),
                WARMUP_TRIGGER_KEY,
            )),
            metrics_unauthorized: AtomicBool::new(false),
            prefix_cache_seen: AtomicBool::new(false),
            queue_wait_seen: AtomicBool::new(false),
            preemptions_seen: AtomicBool::new(false),
            live_rates: Mutex::default(),
            decode_rate_mean: Mutex::default(),
            prefill_rate_mean: Mutex::default(),
        }
    }

    /// The `(status, body)` a metrics route answered with, or `None` when the
    /// server could not be reached.
    async fn answer(&self, path: &str) -> Option<(StatusCode, String)> {
        let response = self.http.get(path).send().await.ok()?;
        let status = response.status();
        Some((status, response.text().await.unwrap_or_default()))
    }

    /// A scrape's status and body: `/v1/metrics`, else the older `/metrics`
    /// when v1 is missing. `None` when neither could be reached.
    async fn scrape(&self) -> Option<(StatusCode, String)> {
        let (mut status, mut body) = self.answer(METRICS_PATH).await?;
        if status == StatusCode::NOT_FOUND {
            (status, body) = self.answer(LEGACY_METRICS_PATH).await?;
        }
        Some((status, body))
    }
}

/// Parse a TensorFold scrape with the shared parser after its metric-name
/// prefix is normalized (`prometheus.rs` rewrites `tensorfold:` to
/// `tensorfold_`), and keep each gauge's label series for the mapping to
/// combine per what it measures: request counts sum over lanes, KV-cache
/// occupancy per pool averages.
fn parse_tensorfold(body: &str) -> Option<ParsedMetrics> {
    parse_prometheus_text(body)
}

/// Whether a parsed scrape carries any TensorFold series. An engine that has
/// not logged a sample yet answers with nothing, and any other exporter's
/// samples are not the engine's.
fn has_tensorfold_series(parsed: &ParsedMetrics) -> bool {
    let tensorfold = |name: &String| name.starts_with("tensorfold_");
    parsed.counters.keys().any(tensorfold)
        || parsed.gauges.keys().any(tensorfold)
        || parsed.histograms.keys().any(tensorfold)
}

/// Whether a scrape carries TensorFold's optional prompt-cache families —
/// the signal that this engine keeps prompt states and therefore reports
/// `PrefixCache`. The hits may be counted directly or as cached prompt
/// tokens; either one proves the families are mounted.
fn has_prompt_cache_families(parsed: &ParsedMetrics) -> bool {
    [
        "tensorfold_prefix_cache_queries_total",
        "tensorfold_prefix_cache_hits_total",
        "tensorfold_prompt_tokens_cached_total",
    ]
    .iter()
    .any(|name| parsed.counters.contains_key(*name))
}

/// Whether a scrape carries the optional queue-wait histograms — the signal
/// that the launch has the phase families mounted and therefore reports
/// `QueueTime`.
fn has_queue_wait_histograms(parsed: &ParsedMetrics) -> bool {
    QUEUE_WAIT_HISTOGRAMS
        .iter()
        .any(|name| parsed.histograms.contains_key(*name))
}

/// The prompt tokens a scrape counts as served from a kept prompt state: the
/// dedicated counter, or the hits family upstream mirrors it as. `None` on an
/// engine without prompt states.
fn prefix_cache_hits(parsed: &ParsedMetrics) -> Option<f64> {
    [
        "tensorfold_prefix_cache_hits_total",
        "tensorfold_prompt_tokens_cached_total",
    ]
    .iter()
    .find_map(|name| parsed.counters.get(*name).copied())
}

/// Whether a scrape carries the preemption counter — the signal that this
/// launch counts preemption events and therefore reports `Preemptions`.
fn has_preemption_counter(parsed: &ParsedMetrics) -> bool {
    parsed.counters.contains_key("tensorfold_preemptions_total")
}

/// The engine's live decode and prefill rates, from the `live` block of its
/// `/health` answer.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
struct LiveRates {
    decode_tps: Option<f64>,
    prefill_tps: Option<f64>,
}

/// The `live` block of a `/health` body: the tokens the engine decoded and
/// prefilled in its last 2 s window, divided by 2. `None` when the answer does
/// not carry such a block — a key-gated launch answers only `{"status":"ok"}`.
fn health_live_rates(body: &str) -> Option<LiveRates> {
    let answer = serde_json::from_str::<Value>(body).ok()?;
    let live = answer.get("live")?;
    let rate = |key: &str| live.get(key).and_then(Value::as_f64);
    let rates = LiveRates {
        decode_tps: rate("decode_tokens_per_second"),
        prefill_tps: rate("prefill_tokens_per_second"),
    };
    (rates.decode_tps.is_some() || rates.prefill_tps.is_some()).then_some(rates)
}

/// The running average of rates the engine itself reported. Only polls that
/// saw throughput are counted, so the average holds steady across the idle
/// polls a live engine spends between requests.
#[derive(Debug, Default)]
struct RateMean {
    /// `(sum of the rates, how many)`.
    accum: (f64, u64),
}

impl RateMean {
    /// Feed one poll's engine-reported rate; returns the running average, or
    /// `None` before any poll has seen throughput.
    fn observe(&mut self, rate: Option<f64>) -> Option<f64> {
        if let Some(rate) = rate {
            if rate > 0.0 {
                self.accum.0 += rate;
                self.accum.1 += 1;
            }
        }
        (self.accum.1 > 0).then(|| self.accum.0 / self.accum.1 as f64)
    }

    fn reset(&mut self) {
        *self = Self::default();
    }
}

/// The `(accepted, drafted)` MTP counters as read, with the vLLM-named mirrors
/// TensorFold publishes beside them as fallbacks; `None` unless both are
/// present — the live acceptance rate needs a pair to diff.
fn spec_counters(raw: &ParsedMetrics) -> Option<(f64, f64)> {
    let counter = |names: [&str; 2]| {
        names
            .iter()
            .find_map(|name| raw.counters.get(*name).copied())
    };
    Some((
        counter([
            "tensorfold_mtp_accepted_total",
            "tensorfold_spec_decode_num_accepted_tokens_total",
        ])?,
        counter([
            "tensorfold_mtp_drafted_total",
            "tensorfold_spec_decode_num_draft_tokens_total",
        ])?,
    ))
}

#[async_trait]
impl EngineAdapter for TensorfoldAdapter {
    fn engine_type(&self) -> EngineType {
        EngineType::Tensorfold
    }

    fn endpoint(&self) -> &str {
        self.http.endpoint()
    }

    /// What this TensorFold engine reports, decided from what its scrapes
    /// carry (ADR-0004's per-engine rule).
    ///
    /// Two groups are left out for every TensorFold engine, because no series
    /// in its scrape measures that quantity and a stand-in would be a
    /// different one:
    /// - `BatchSize`: `avg_batch_size` would be generated tokens over decode
    ///   rounds, but upstream adds each finished request's own rounds, so that
    ///   ratio does not grow with concurrency — it is draft acceptance per
    ///   round, not tokens per engine step. The field stays `None`.
    /// - `ItlMean` and `ItlPercentiles`: there is no inter-token-latency
    ///   histogram of its own. `request_time_per_output_token_seconds` is time
    ///   per output token — the gap between generated tokens — so it is
    ///   reported under the TPOT tiles, whose quantity it names, not copied
    ///   into ITL as though it were a second measurement.
    ///
    /// `QueueTime`, `PrefixCache` and `Preemptions` are optional per launch,
    /// not per type: `QueueTime` appears once a scrape carries upstream's
    /// queue-wait histograms (rendered under `TENSORFOLD_PHASE_METRICS=1`),
    /// `PrefixCache` once a scrape carries the prompt-cache families (only
    /// engines that keep prompt states publish them), and `Preemptions` once a
    /// scrape carries the preemption counter (upstream publishes it only where
    /// the server counts those events). Until then the groups are not reported,
    /// so their tiles say "not reported" rather than "--" (not yet, forever).
    /// Once seen, they stay declared.
    fn metric_groups(&self) -> BTreeSet<MetricGroup> {
        let mut groups = MetricGroup::all();
        for group in [
            MetricGroup::BatchSize,
            MetricGroup::ItlMean,
            MetricGroup::ItlPercentiles,
        ] {
            groups.remove(&group);
        }
        if !self.queue_wait_seen.load(Ordering::Relaxed) {
            groups.remove(&MetricGroup::QueueTime);
        }
        if !self.prefix_cache_seen.load(Ordering::Relaxed) {
            groups.remove(&MetricGroup::PrefixCache);
        }
        if !self.preemptions_seen.load(Ordering::Relaxed) {
            groups.remove(&MetricGroup::Preemptions);
        }
        groups
    }

    /// TensorFold always mounts its metrics routes — there is no launch flag
    /// to turn them on — so metrics are never "off"; an unreadable scrape is
    /// the dashboard missing the API key, carried by `metrics_error`.
    fn metrics_launch_flag(&self) -> Option<&'static str> {
        None
    }

    fn metrics_off(&self) -> bool {
        false
    }

    fn metrics_error(&self) -> Option<MetricsError> {
        self.metrics_unauthorized
            .load(Ordering::Relaxed)
            .then_some(MetricsError::AuthRequired)
    }

    /// `/health` is open (a key-gated launch answers only `{"status":"ok"}`
    /// there). A loading engine says `warming: true`; 2xx without it is
    /// running; a non-2xx is an error naming the status — and a failure to
    /// reach the server is an error too, never "metrics off".
    ///
    /// The same answer carries the engine's own live decode and prefill rates;
    /// they are stored here for the next `get_metrics` (the poll probes health
    /// first), or cleared when this answer has no `live` block so the scrape
    /// counters are diffed instead of keeping a stale rate.
    async fn health_check(&self) -> EngineStatus {
        let response = match self.http.get(HEALTH_PATH).send().await {
            Ok(response) => response,
            Err(e) => return EngineStatus::Error(e.to_string()),
        };
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        *self.live_rates.lock().await = health_live_rates(&body);
        health_status(status, &body)
    }

    /// `/v1/models` through the resolver vLLM and SGLang use: TensorFold's
    /// answer has the same shape (`owned_by: tensorfold`), its launch names
    /// the model with `--name`, and an auth-gated `/v1/models` the dashboard
    /// lacks a key for surfaces as `AuthRequired` beside the command-line
    /// fallback, exactly as on vLLM.
    async fn get_model_info(&self) -> ModelResolution {
        self.model.resolve(&self.http).await
    }

    async fn get_metrics(&self) -> Option<EngineMetrics> {
        // A server that cannot be reached is offline, not refused: nothing is
        // latched before it answers.
        let (status, body) = self.scrape().await?;
        match status {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                if !self.metrics_unauthorized.swap(true, Ordering::Relaxed) {
                    tracing::warn!(
                        endpoint = %self.http.endpoint(),
                        "TensorFold metrics refused the dashboard's API key — \
                         configure a provider API key to read its metrics",
                    );
                }
                return None;
            }
            status if status.is_success() => {
                self.metrics_unauthorized.store(false, Ordering::Relaxed);
            }
            // A transient failure is not "refused": leave the latch alone.
            _ => return None,
        }
        // Metrics mounted but no TensorFold series yet is "no data yet": the
        // engine reports nothing this tick, and its panels say so.
        let raw = parse_tensorfold(&body).filter(has_tensorfold_series)?;

        // The optional PrefixCache declaration follows the scrape: an engine
        // that keeps prompt states publishes the families, and one that does
        // not never does. A scrape that shows one declares the group from this
        // tick on.
        if has_prompt_cache_families(&raw) {
            self.prefix_cache_seen.store(true, Ordering::Relaxed);
        }
        // So does the optional QueueTime declaration: upstream renders the
        // queue-wait histograms only under TENSORFOLD_PHASE_METRICS=1.
        if has_queue_wait_histograms(&raw) {
            self.queue_wait_seen.store(true, Ordering::Relaxed);
        }
        // Preemptions is the same per-engine decision: upstream publishes the
        // counter only where it counts preemption events.
        if has_preemption_counter(&raw) {
            self.preemptions_seen.store(true, Ordering::Relaxed);
        }

        let warmup_out = {
            let mut tracker = self.warmup.lock().await;
            tracker.observe(&raw)
        };
        if warmup_out.just_transitioned {
            self.gen_rate.lock().await.reset();
            self.prompt_rate.lock().await.reset();
            self.decode_rate_mean.lock().await.reset();
            self.prefill_rate_mean.lock().await.reset();
            *self.prev_spec_decode.lock().await = None;
            tracing::info!(
                endpoint = %self.http.endpoint(),
                "warmup complete — baseline captured, steady-state metrics now reported"
            );
        }
        let parsed = &warmup_out.adjusted;
        let warming_up = warmup_out.warming_up;

        let counter = |name: &str| parsed.counters.get(name).copied();
        let current_gen = counter("tensorfold_generation_tokens_total");
        let current_prompt = counter("tensorfold_prompt_tokens_total");
        let now = Instant::now();
        // Live throughput: the engine's own windowed rate from `/health` when
        // its answer carried one. Its scrape counters only move when a request
        // finishes, so diffing them — the fallback for a key-gated launch,
        // whose open health route answers just the status — reads zero while
        // requests are still decoding and bursts by a whole request's tokens
        // when one completes.
        let live_rates = *self.live_rates.lock().await;
        let (tokens_per_sec, avg_tokens_per_sec) = match live_rates.and_then(|l| l.decode_tps) {
            Some(rate) => (
                Some(rate),
                self.decode_rate_mean.lock().await.observe(Some(rate)),
            ),
            None => self.gen_rate.lock().await.observe(current_gen, now),
        };
        let (prompt_tokens_per_sec, avg_prompt_tokens_per_sec) =
            match live_rates.and_then(|l| l.prefill_tps) {
                Some(rate) => (
                    Some(rate),
                    self.prefill_rate_mean.lock().await.observe(Some(rate)),
                ),
                None => self.prompt_rate.lock().await.observe(current_prompt, now),
            };

        // Live (windowed) acceptance rate from per-poll deltas of the MTP
        // counters. The snapshot is discarded whenever a counter is absent —
        // including the vLLM-named mirrors dropping out — or went backwards
        // (a restart reset its counters), which would otherwise diff against a
        // stale pair and inflate or negate the rate.
        let spec_live = {
            let mut prev = self.prev_spec_decode.lock().await;
            let now = spec_counters(&raw);
            let live = spec_live_acceptance_rate(*prev, now);
            *prev = now;
            live
        };

        Some(engine_metrics(
            parsed,
            &raw,
            RateInputs {
                tokens_per_sec,
                prompt_tokens_per_sec,
                avg_tokens_per_sec,
                avg_prompt_tokens_per_sec,
            },
            spec_live,
            warming_up,
        ))
    }
}

/// The health answer's reading: 2xx with `warming: true` is loading, any other
/// 2xx running, a non-2xx an error naming the status. `/health` answers only
/// `{"status":"ok"}` once a key is configured, and that reads as running.
fn health_status(status: StatusCode, body: &str) -> EngineStatus {
    if !status.is_success() {
        return EngineStatus::Error(format!("HTTP {status}"));
    }
    if health_warming(body) == Some(true) {
        EngineStatus::Loading
    } else {
        EngineStatus::Running
    }
}

/// The `warming` field of a `/health` body, or `None` when the body says
/// nothing (or is not JSON).
fn health_warming(body: &str) -> Option<bool> {
    serde_json::from_str::<Value>(body)
        .ok()?
        .get("warming")?
        .as_bool()
}

/// The rate fields are the adapter's only stateful derivation (deltas and
/// running means across polls). They arrive as inputs so the rest of the
/// mapping is pure over one scrape and fully testable against a fixture.
#[derive(Debug, Default, Clone, Copy)]
struct RateInputs {
    tokens_per_sec: Option<f64>,
    prompt_tokens_per_sec: Option<f64>,
    avg_tokens_per_sec: Option<f64>,
    avg_prompt_tokens_per_sec: Option<f64>,
}

/// Map one parsed TensorFold scrape onto the engine snapshot.
///
/// Pure: the fetch, the auth latch, the warmup tracker and the rate state stay
/// in `get_metrics`; everything here reads the scrape and nothing else.
/// `parsed` is the scrape after the warmup baseline is subtracted, `raw` the
/// same scrape as read, for the lifetime figures that must not restart at the
/// baseline. `warming_up` blanks the delta- and histogram-derived fields
/// exactly as the vLLM adapter blanks them. `spec_decode_acceptance_rate_live`
/// is the per-poll delta rate, `None` while warming or on the first reading.
fn engine_metrics(
    parsed: &ParsedMetrics,
    raw: &ParsedMetrics,
    rates: RateInputs,
    spec_decode_acceptance_rate_live: Option<f64>,
    warming_up: bool,
) -> EngineMetrics {
    let counter = |name: &str| parsed.counters.get(name).copied();
    let raw_counter = |name: &str| raw.counters.get(name).copied();

    // Requests running and waiting are counts of this one engine, so a scrape
    // that split them across lanes sums them.
    let active_requests = parsed
        .gauge_sum("tensorfold_requests_running")
        .map(|v| v as u64);
    let queued_requests = parsed
        .gauge_sum("tensorfold_requests_waiting")
        .map(|v| v as u64);

    // KV-cache occupancy: each series is one stream's cache divided by that
    // stream's context window, so the engine-wide fraction is their mean.
    // v1.1.3 also publishes the same ratios under vLLM's name
    // (`kv_cache_usage_perc`, one series per stream); a release carrying only
    // the mirror is read through it. The figure is the engine's own gauge, not
    // an estimate.
    let kv_cache_percent = parsed
        .gauge_mean("tensorfold_kv_cache_usage_ratio")
        .or_else(|| parsed.gauge_mean("tensorfold_kv_cache_usage_perc"))
        .map(|v| v * 100.0);

    let ttft_ms = mean_ms(
        counter("tensorfold_time_to_first_token_seconds_sum"),
        counter("tensorfold_time_to_first_token_seconds_count"),
    );
    let e2e_latency_ms = mean_ms(
        counter("tensorfold_request_latency_seconds_sum"),
        counter("tensorfold_request_latency_seconds_count"),
    );
    // Time per output token: the engine's own histogram, seconds from the
    // first generated token to the last over the tokens less one.
    let tpot_ms = mean_ms(
        counter("tensorfold_request_time_per_output_token_seconds_sum"),
        counter("tensorfold_request_time_per_output_token_seconds_count"),
    );

    // Request count: TTFT observations == requests that reached first token —
    // the same lifetime figure vLLM and SGLang derive from the same quantity.
    // Read from `raw` so it stays absolute across the warmup baseline.
    let total_requests =
        raw_counter("tensorfold_time_to_first_token_seconds_count").map(|v| v.max(0.0) as u64);
    // Token counters are read off the warmup-adjusted scrape (#154): the
    // engine's lifetime count while warming, then the tokens since the baseline
    // — the window every other warmup-adjusted figure covers.
    let total_prompt_tokens = counter("tensorfold_prompt_tokens_total").map(|v| v.max(0.0) as u64);
    let total_generation_tokens =
        counter("tensorfold_generation_tokens_total").map(|v| v.max(0.0) as u64);

    // Prompt tokens restored from a kept prompt state were not prefilled, so
    // they come out of the prefill-throughput numerator; the engine's prefill
    // seconds cover only the tokens it actually prefilled.
    let cached_prompt_tokens = prefix_cache_hits(parsed);
    // Per-request prefill throughput: the engine's prefilled prompt tokens over
    // the prompt-pass seconds it counted itself, not over TTFT.
    let per_request_prompt_tps = match (
        counter("tensorfold_prompt_tokens_total"),
        counter("tensorfold_request_prefill_seconds_sum"),
    ) {
        (Some(p), Some(t)) if t > 0.0 => {
            let prefilled = (p - cached_prompt_tokens.unwrap_or(0.0)).max(0.0);
            Some(prefilled / t)
        }
        _ => None,
    };
    // Per-request decode throughput: generation tokens over the decode seconds
    // the engine counted, the same shape.
    let per_request_tps = match (
        counter("tensorfold_generation_tokens_total"),
        counter("tensorfold_request_decode_seconds_sum"),
    ) {
        (Some(g), Some(t)) if t > 0.0 => Some(g / t),
        _ => None,
    };

    // Queue wait: upstream renders the queue-wait histograms only under
    // TENSORFOLD_PHASE_METRICS=1; a launch without them reports no QueueTime
    // (the group is not declared), and the reading is baseline-subtracted like
    // every other histogram.
    let queue_time_ms = mean_ms(
        counter("tensorfold_request_queue_seconds_sum"),
        counter("tensorfold_request_queue_seconds_count"),
    )
    .or_else(|| {
        mean_ms(
            counter("tensorfold_request_queue_time_seconds_sum"),
            counter("tensorfold_request_queue_time_seconds_count"),
        )
    });

    // Lifetime preemption counter, absolute.
    let preemptions_total = raw_counter("tensorfold_preemptions_total").map(|v| v.max(0.0) as u64);

    // Prefix cache: only engines that keep prompt states publish these
    // families. Hits are counted either directly or as cached prompt tokens;
    // the queries counter is the denominator and the volume tile, and both are
    // read off the warmup-adjusted scrape like the token totals above. All
    // absent together on an engine without prompt state.
    let prefix_queries = counter("tensorfold_prefix_cache_queries_total");
    let prefix_hits = cached_prompt_tokens;
    let prefix_cache_hit_rate = match (prefix_hits, prefix_queries) {
        (Some(h), Some(q)) if q > 0.0 => Some((h / q) * 100.0),
        _ => None,
    };
    let prefix_cache_queries_total = prefix_queries.map(|v| v.max(0.0) as u64);

    // Speculative decoding: TensorFold's spec decode is MTP. The lifetime
    // counters are read absolute, with the vLLM-named mirrors it publishes as
    // fallbacks. Its acceptance rate is accepted/drafted, the engine's own
    // ratio. There is no per-attempt counter — `decode_rounds_total` counts
    // decode rounds, not draft attempts — so draft attempts and the mean
    // acceptance length (accepted tokens per attempt) are left empty inside the
    // declared group rather than derived from the rate, which is a different
    // quantity.
    let spec_draft = raw_counter("tensorfold_mtp_drafted_total")
        .or_else(|| raw_counter("tensorfold_spec_decode_num_draft_tokens_total"));
    let spec_accepted = raw_counter("tensorfold_mtp_accepted_total")
        .or_else(|| raw_counter("tensorfold_spec_decode_num_accepted_tokens_total"));
    let spec_decode_draft_tokens_total = spec_draft.map(|v| v.max(0.0) as u64);
    let spec_decode_accepted_tokens_total = spec_accepted.map(|v| v.max(0.0) as u64);
    let spec_decode_acceptance_rate = spec_acceptance_rate(spec_accepted, spec_draft);

    // Tail latency percentiles, SLO goodput and the raw buckets, from the
    // request-level histograms — through the same helpers as the vLLM adapter.
    let ttft_percentiles = percentiles_ms(parsed, "tensorfold_time_to_first_token_seconds");
    let e2e_percentiles = percentiles_ms(parsed, "tensorfold_request_latency_seconds");
    let tpot_percentiles =
        percentiles_ms(parsed, "tensorfold_request_time_per_output_token_seconds");
    let ttft_goodput_pct = goodput_pct(
        parsed,
        "tensorfold_time_to_first_token_seconds",
        TTFT_SLO_MS,
    );
    let e2e_goodput_pct = goodput_pct(parsed, "tensorfold_request_latency_seconds", E2E_SLO_MS);
    let tpot_goodput_pct = goodput_pct(
        parsed,
        "tensorfold_request_time_per_output_token_seconds",
        TPOT_SLO_MS,
    );
    let ttft_buckets = wire_buckets(parsed, "tensorfold_time_to_first_token_seconds");
    let e2e_buckets = wire_buckets(parsed, "tensorfold_request_latency_seconds");
    let tpot_buckets = wire_buckets(parsed, "tensorfold_request_time_per_output_token_seconds");

    let blank = warming_up;
    EngineMetrics {
        tokens_per_sec: if blank { None } else { rates.tokens_per_sec },
        avg_tokens_per_sec: if blank {
            None
        } else {
            rates.avg_tokens_per_sec
        },
        per_request_tps: if blank { None } else { per_request_tps },
        ttft_ms: if blank { None } else { ttft_ms },
        active_requests,
        queued_requests,
        kv_cache_percent,
        kv_cache_is_estimated: false,
        total_requests,
        e2e_latency_ms: if blank { None } else { e2e_latency_ms },
        prompt_tokens_per_sec: if blank {
            None
        } else {
            rates.prompt_tokens_per_sec
        },
        avg_prompt_tokens_per_sec: if blank {
            None
        } else {
            rates.avg_prompt_tokens_per_sec
        },
        per_request_prompt_tps: if blank { None } else { per_request_prompt_tps },
        // No swap counter exists on TensorFold; the field stays empty inside a
        // group it does report (as SGLang's spec counters do).
        swapped_requests: None,
        prefix_cache_hit_rate,
        // Queue wait is reported only when the launch renders the phase
        // histograms (the group is not declared otherwise).
        queue_time_ms: if blank { None } else { queue_time_ms },
        // No separate inter-token-latency histogram: its groups are not
        // reported; `request_time_per_output_token_seconds` is TPOT's.
        inter_token_latency_ms: None,
        preemptions_total,
        total_prompt_tokens,
        total_generation_tokens,
        prefix_cache_queries_total,
        // Tokens per decode round is draft acceptance, not a batch size
        // (ADR-0004): the field stays empty and BatchSize is not reported.
        avg_batch_size: None,
        ttft_percentiles: if blank { None } else { ttft_percentiles },
        itl_percentiles: None,
        e2e_percentiles: if blank { None } else { e2e_percentiles },
        ttft_goodput_pct: if blank { None } else { ttft_goodput_pct },
        itl_goodput_pct: None,
        e2e_goodput_pct: if blank { None } else { e2e_goodput_pct },
        ttft_buckets: if blank { None } else { ttft_buckets },
        itl_buckets: None,
        e2e_buckets: if blank { None } else { e2e_buckets },
        tpot_ms: if blank { None } else { tpot_ms },
        tpot_percentiles: if blank { None } else { tpot_percentiles },
        tpot_goodput_pct: if blank { None } else { tpot_goodput_pct },
        tpot_buckets: if blank { None } else { tpot_buckets },
        // Spec counters and the lifetime ratio are pass-through (ungated);
        // there is no per-attempt counter and no mean length.
        spec_decode_draft_tokens_total,
        spec_decode_accepted_tokens_total,
        spec_decode_drafts_total: None,
        spec_decode_acceptance_rate,
        spec_decode_acceptance_rate_live: if blank {
            None
        } else {
            spec_decode_acceptance_rate_live
        },
        spec_decode_mean_acceptance_length: None,
        warming_up,
    }
}

// ---------------------------------------------------------------------------
// Identification
// ---------------------------------------------------------------------------

/// Whether the server behind `http` is a TensorFold server. `/health` is open
/// and costs the engine nothing, and only TensorFold answers it in one of its
/// shapes: a `Server: TensorFold` header (which vLLM's `uvicorn`, SGLang's
/// `uvicorn` and Ollama send not), a JSON body with a `model_ids` array (its
/// own `/health` without a key), or an ok status beside a `model` string.
///
/// A 2xx is required: a server named TensorFold but not answering 2xx is not
/// serving. vLLM's empty 200 `/health`, SGLang's ready body, llama.cpp's
/// `{"status":"ok"}` without a model, and Ollama's no `/health` all stay out.
pub(crate) async fn identify(http: &EngineHttp) -> bool {
    let Ok(health) = http.get(HEALTH_PATH).send().await else {
        return false;
    };
    let status = health.status().as_u16();
    let server = health
        .headers()
        .get(reqwest::header::SERVER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let body = health.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return false;
    }
    if server
        .as_deref()
        .is_some_and(|server| server.to_ascii_lowercase().contains("tensorfold"))
    {
        return true;
    }
    health_answers_like_tensorfold(&body)
}

/// Whether `/health` answered TensorFold's own JSON: the `model_ids` array its
/// status answers carry, or the `backend: "tensorfold"` a key-gated or Spark
/// launch keeps. A bare `{"status":"ok","model":…}` — llama.cpp's shape, among
/// others — is not enough to claim an engine it does not name.
fn health_answers_like_tensorfold(body: &str) -> bool {
    let Some(health) = serde_json::from_str::<Value>(body).ok() else {
        return false;
    };
    if health.get("model_ids").is_some_and(Value::is_array) {
        return true;
    }
    health.get("backend").and_then(Value::as_str) == Some("tensorfold")
}

#[cfg(test)]
mod tests {
    use super::super::histogram::{fraction_le, percentile};
    use super::*;

    /// A scrape of the live engine's `/v1/metrics` — the wire reports
    /// `version: 1.2.5`; see `fixtures/tensorfold_health.json` — captured
    /// verbatim with curl. The `Server: TensorFold` header came with it.
    const REAL: &str = include_str!("fixtures/tensorfold_metrics.txt");

    fn parsed_real() -> ParsedMetrics {
        parse_tensorfold(REAL).expect("fixture parses")
    }

    fn assert_close(got: Option<f64>, want: f64) {
        let got = got.expect("a value");
        assert!((got - want).abs() < 1e-9, "got {got}, want {want}");
    }

    /// `engine_metrics` for a scrape no baseline has been subtracted from —
    /// one that is its own raw reading.
    fn map_unbaselined(
        parsed: &ParsedMetrics,
        rates: RateInputs,
        spec_live: Option<f64>,
        warming: bool,
    ) -> EngineMetrics {
        engine_metrics(parsed, parsed, rates, spec_live, warming)
    }

    #[test]
    fn real_scrape_series_arrive_under_underscored_names() {
        let p = parsed_real();
        assert_eq!(p.gauge_sum("tensorfold_requests_running"), Some(0.0));
        assert_eq!(
            p.counters.get("tensorfold_prompt_tokens_total"),
            Some(&250_296_082.0)
        );
        assert_eq!(
            p.counters.get("tensorfold_generation_tokens_total"),
            Some(&341_951.0)
        );
        assert_eq!(
            p.counters
                .get("tensorfold_time_to_first_token_seconds_count"),
            Some(&911.0)
        );
        assert!(p
            .histograms
            .contains_key("tensorfold_request_time_per_output_token_seconds"));
        assert!(p.gauges.keys().all(|name| !name.contains(':')));
    }

    /// The whole ADR-0004 contract in one test: every field TensorFold has a
    /// series for carries the captured value, every field it has none for
    /// stays None — no zero, no estimate, no stand-in. Values are read off the
    /// fixture where the exact number is an implementation detail of the
    /// capture, and written out where the contract names one.
    #[test]
    fn the_real_fixture_maps_onto_the_fields_tensorfold_reports() {
        let parsed = parsed_real();
        let m = map_unbaselined(&parsed, RateInputs::default(), None, false);

        // ActiveRequests: counts sum across lanes.
        assert_eq!(m.active_requests, Some(0), "requests_running");
        assert_eq!(m.queued_requests, Some(0), "requests_waiting");

        // KvCache: the mean of the per-pool ratios, times 100.
        let pools: Vec<f64> = parsed
            .gauges
            .get("tensorfold_kv_cache_usage_ratio")
            .expect("kv ratio series")
            .iter()
            .map(|g| g.value)
            .collect();
        let want_kv = pools.iter().sum::<f64>() / pools.len() as f64 * 100.0;
        assert_close(m.kv_cache_percent, want_kv);
        assert!(!m.kv_cache_is_estimated, "the gauge is the engine's own");

        // RequestTotal: the TTFT observation count, absolute.
        assert_eq!(m.total_requests, Some(911));
        assert_eq!(m.total_prompt_tokens, Some(250_296_082));
        assert_eq!(m.total_generation_tokens, Some(341_951));

        // TtftMean: the histogram's sum over count; TtftPercentiles and the
        // goodput/buckets come off the same histogram.
        let ttft = &parsed.histograms["tensorfold_time_to_first_token_seconds"];
        assert_close(
            m.ttft_ms,
            parsed.counters["tensorfold_time_to_first_token_seconds_sum"]
                / parsed.counters["tensorfold_time_to_first_token_seconds_count"]
                * 1000.0,
        );
        assert_close(
            m.per_request_prompt_tps,
            parsed.counters["tensorfold_prompt_tokens_total"]
                / parsed.counters["tensorfold_request_prefill_seconds_sum"],
        );
        assert_close(
            m.ttft_percentiles.as_ref().and_then(|p| p.p50_ms),
            percentile(ttft, 0.5).expect("p50") * 1000.0,
        );
        assert_close(
            m.ttft_goodput_pct,
            fraction_le(ttft, TTFT_SLO_MS / 1000.0).expect("goodput") * 100.0,
        );
        assert_eq!(m.ttft_buckets.as_ref().map(Vec::len), Some(ttft.len()));

        // E2eMean/E2ePercentiles: the request latency histogram.
        let e2e = &parsed.histograms["tensorfold_request_latency_seconds"];
        assert_close(
            m.e2e_latency_ms,
            parsed.counters["tensorfold_request_latency_seconds_sum"]
                / parsed.counters["tensorfold_request_latency_seconds_count"]
                * 1000.0,
        );
        assert_close(
            m.e2e_percentiles.as_ref().and_then(|p| p.p95_ms),
            percentile(e2e, 0.95).expect("p95") * 1000.0,
        );
        assert_close(
            m.e2e_goodput_pct,
            fraction_le(e2e, E2E_SLO_MS / 1000.0).expect("goodput") * 100.0,
        );
        assert_eq!(m.e2e_buckets.as_ref().map(Vec::len), Some(e2e.len()));

        // TpotMean/TpotPercentiles: the time-per-output-token histogram —
        // the engine's own TPOT quantity.
        let tpot = &parsed.histograms["tensorfold_request_time_per_output_token_seconds"];
        assert_close(
            m.tpot_ms,
            parsed.counters["tensorfold_request_time_per_output_token_seconds_sum"]
                / parsed.counters["tensorfold_request_time_per_output_token_seconds_count"]
                * 1000.0,
        );
        assert_close(m.per_request_tps, 341_951.0 / 8_928.651_192);
        assert_close(
            m.tpot_percentiles.as_ref().and_then(|p| p.p99_ms),
            percentile(tpot, 0.99).expect("p99") * 1000.0,
        );
        assert_close(
            m.tpot_goodput_pct,
            fraction_le(tpot, TPOT_SLO_MS / 1000.0).expect("goodput") * 100.0,
        );
        assert_eq!(m.tpot_buckets.as_ref().map(Vec::len), Some(tpot.len()));

        // BatchSize: tokens per decode round is draft acceptance, not a batch
        // size, so the group is not reported and the field stays empty.
        assert_eq!(m.avg_batch_size, None);

        // Preemptions: this engine's scrape carries no preemption counter, so
        // the field stays empty; there is no swap counter either.
        assert_eq!(m.preemptions_total, None);
        assert_eq!(m.swapped_requests, None);

        // Speculative decoding: MTP's lifetime draft/accept counters and the
        // ratio derived from them.
        assert_eq!(m.spec_decode_draft_tokens_total, Some(377_838));
        assert_eq!(m.spec_decode_accepted_tokens_total, Some(246_617));
        assert_close(m.spec_decode_acceptance_rate, 246_617.0 / 377_838.0 * 100.0);
        assert_eq!(m.spec_decode_drafts_total, None);
        assert_eq!(m.spec_decode_mean_acceptance_length, None);
        assert_eq!(m.spec_decode_acceptance_rate_live, None);

        // Absent series, enumerated (ADR-0004): the moment one gains a value
        // from a stand-in this test is where the reviewer sees it. Queue
        // time and ITL belong to groups `metric_groups` leaves out; the
        // prefix cache is optional and this engine has no prompt states.
        assert_eq!(m.queue_time_ms, None);
        assert_eq!(m.inter_token_latency_ms, None);
        assert!(m.itl_percentiles.is_none());
        assert_eq!(m.itl_goodput_pct, None);
        assert!(m.itl_buckets.is_none());
        assert_eq!(m.prefix_cache_hit_rate, None);
        assert_eq!(m.prefix_cache_queries_total, None);
        assert!(!m.warming_up);
        // Rates are the adapter's stateful derivation; the pure mapping was
        // given none and invents none.
        assert_eq!(m.tokens_per_sec, None);
        assert_eq!(m.prompt_tokens_per_sec, None);
    }

    /// The KV tile reads vLLM's mirror name when a release carries only that.
    #[test]
    fn kv_usage_falls_back_to_the_vllm_mirror_name() {
        let body = "\
# TYPE tensorfold:kv_cache_usage_perc gauge
tensorfold:kv_cache_usage_perc{stream=\"0\"} 0.5
tensorfold:kv_cache_usage_perc{stream=\"1\"} 0.3
";
        let parsed = parse_tensorfold(body).expect("parses");
        let m = map_unbaselined(&parsed, RateInputs::default(), None, false);
        assert_close(m.kv_cache_percent, 40.0);
    }

    /// The optional prompt-cache families fill PrefixCache when the engine
    /// keeps prompt states; with `prompt_tokens_cached_total` standing in for
    /// the hits counter, the ratio is still cached-over-queried tokens.
    #[test]
    fn the_prompt_cache_families_fill_the_prefix_cache_group() {
        let with_hits = "\
# TYPE tensorfold:prefix_cache_hits_total counter
tensorfold:prefix_cache_hits_total 30
# TYPE tensorfold:prefix_cache_queries_total counter
tensorfold:prefix_cache_queries_total 100
";
        let parsed = parse_tensorfold(with_hits).expect("parses");
        let m = map_unbaselined(&parsed, RateInputs::default(), None, false);
        assert_close(m.prefix_cache_hit_rate, 30.0);
        assert_eq!(m.prefix_cache_queries_total, Some(100));

        let cached_tokens = "\
# TYPE tensorfold:prompt_tokens_cached_total counter
tensorfold:prompt_tokens_cached_total 25
# TYPE tensorfold:prefix_cache_queries_total counter
tensorfold:prefix_cache_queries_total 100
";
        let parsed = parse_tensorfold(cached_tokens).expect("parses");
        let m = map_unbaselined(&parsed, RateInputs::default(), None, false);
        assert_close(m.prefix_cache_hit_rate, 25.0);
        assert_eq!(m.prefix_cache_queries_total, Some(100));
    }

    /// The MTP counters' vLLM-named mirrors are fallbacks: a release that
    /// publishes only those still reports its speculative decoding.
    #[test]
    fn spec_counters_fall_back_to_the_vllm_mirror_names() {
        let body = "\
# TYPE tensorfold:spec_decode_num_draft_tokens_total counter
tensorfold:spec_decode_num_draft_tokens_total 500
# TYPE tensorfold:spec_decode_num_accepted_tokens_total counter
tensorfold:spec_decode_num_accepted_tokens_total 250
";
        let parsed = parse_tensorfold(body).expect("parses");
        assert_eq!(spec_counters(&parsed), Some((250.0, 500.0)));
        let m = map_unbaselined(&parsed, RateInputs::default(), None, false);
        assert_eq!(m.spec_decode_draft_tokens_total, Some(500));
        assert_eq!(m.spec_decode_accepted_tokens_total, Some(250));
        assert_close(m.spec_decode_acceptance_rate, 50.0);
    }

    #[test]
    fn warmup_gate_blanks_delta_metrics_only() {
        // The mapping's blanking contract, through the real fixture: while
        // warming, everything a delta or a baseline needs reads None, and
        // every instantaneous reading passes through — the same contract the
        // vLLM and SGLang adapters hold.
        let rates = RateInputs {
            tokens_per_sec: Some(30.0),
            prompt_tokens_per_sec: Some(100.0),
            avg_tokens_per_sec: Some(25.0),
            avg_prompt_tokens_per_sec: Some(90.0),
        };
        let blank = map_unbaselined(&parsed_real(), rates, Some(50.0), true);
        assert_eq!(blank.tokens_per_sec, None);
        assert_eq!(blank.avg_tokens_per_sec, None);
        assert_eq!(blank.prompt_tokens_per_sec, None);
        assert_eq!(blank.avg_prompt_tokens_per_sec, None);
        assert_eq!(blank.ttft_ms, None);
        assert_eq!(blank.e2e_latency_ms, None);
        assert_eq!(blank.tpot_ms, None);
        assert_eq!(blank.per_request_tps, None);
        assert_eq!(blank.per_request_prompt_tps, None);
        assert_eq!(blank.avg_batch_size, None);
        assert!(blank.ttft_percentiles.is_none());
        assert!(blank.e2e_percentiles.is_none());
        assert!(blank.tpot_percentiles.is_none());
        assert_eq!(blank.ttft_goodput_pct, None);
        assert_eq!(blank.e2e_goodput_pct, None);
        assert_eq!(blank.tpot_goodput_pct, None);
        assert!(blank.ttft_buckets.is_none());
        assert!(blank.e2e_buckets.is_none());
        assert!(blank.tpot_buckets.is_none());
        assert_eq!(blank.spec_decode_acceptance_rate_live, None);
        assert!(blank.warming_up);
        // Pass-through fields survive warming: gauges, absolute counters and
        // the lifetime ratios.
        assert_eq!(blank.active_requests, Some(0));
        assert_eq!(blank.total_requests, Some(911));
        assert_eq!(blank.total_generation_tokens, Some(341_951));
        assert_eq!(blank.preemptions_total, None);
        assert_eq!(blank.spec_decode_draft_tokens_total, Some(377_838));
        assert_close(
            blank.spec_decode_acceptance_rate,
            246_617.0 / 377_838.0 * 100.0,
        );

        let live = map_unbaselined(&parsed_real(), rates, Some(50.0), false);
        assert_eq!(live.tokens_per_sec, Some(30.0));
        assert_eq!(live.avg_prompt_tokens_per_sec, Some(90.0));
        assert!(live.ttft_ms.unwrap() > 0.0);
        assert!(live.e2e_percentiles.unwrap().p50_ms.unwrap() > 0.0);
        assert!(live.tpot_percentiles.unwrap().p50_ms.unwrap() > 0.0);
        assert_eq!(live.spec_decode_acceptance_rate_live, Some(50.0));
    }

    fn adapter() -> TensorfoldAdapter {
        TensorfoldAdapter::new(
            reqwest::Client::new(),
            "http://127.0.0.1:8080".into(),
            None,
            None,
        )
    }

    /// The groups every TensorFold engine reports before any scrape has shown
    /// the optional queue, prefix-cache or preemption families — every group
    /// but batch size, queue time, ITL and those optional ones. Written out, so
    /// a group added later is a decision for TensorFold rather than a default.
    fn tensorfold_groups() -> BTreeSet<MetricGroup> {
        BTreeSet::from([
            MetricGroup::Throughput,
            MetricGroup::ActiveRequests,
            MetricGroup::RequestTotal,
            MetricGroup::KvCache,
            MetricGroup::SpeculativeDecoding,
            MetricGroup::TtftMean,
            MetricGroup::TtftPercentiles,
            MetricGroup::E2eMean,
            MetricGroup::E2ePercentiles,
            MetricGroup::TpotMean,
            MetricGroup::TpotPercentiles,
        ])
    }

    /// A scrape carrying upstream's optional phase families: the queue-wait
    /// histograms a `TENSORFOLD_PHASE_METRICS=1` launch renders.
    const QUEUE_SCRAPE: &str = "\
# TYPE tensorfold:request_queue_seconds histogram
tensorfold:request_queue_seconds_bucket{le=\"0.5\"} 3
tensorfold:request_queue_seconds_bucket{le=\"+Inf\"} 4
tensorfold:request_queue_seconds_sum 0.5
tensorfold:request_queue_seconds_count 4
";

    /// A scrape carrying the preemption counter an engine that counts those
    /// events publishes.
    const PREEMPTIONS_SCRAPE: &str = "\
# TYPE tensorfold:preemptions_total counter
tensorfold:preemptions_total 2
";

    /// The optional queue-wait families fill QueueTime when upstream renders
    /// them, through the baseline-adjusted histogram like every other latency.
    #[test]
    fn the_queue_wait_families_fill_the_queue_time_group() {
        let parsed = parse_tensorfold(QUEUE_SCRAPE).expect("parses");
        let m = map_unbaselined(&parsed, RateInputs::default(), None, false);
        assert_close(m.queue_time_ms, 0.5 / 4.0 * 1000.0);

        let mirror = parse_tensorfold(
            "\
# TYPE tensorfold:request_queue_time_seconds histogram
tensorfold:request_queue_time_seconds_bucket{le=\"+Inf\"} 1
tensorfold:request_queue_time_seconds_sum 0.25
tensorfold:request_queue_time_seconds_count 1
",
        )
        .expect("parses");
        let m = map_unbaselined(&mirror, RateInputs::default(), None, false);
        assert_close(m.queue_time_ms, 250.0);

        // Baselines blank a delta-derived histogram figure like the rest.
        assert_eq!(
            map_unbaselined(&parsed, RateInputs::default(), None, true).queue_time_ms,
            None
        );
    }

    /// Prompt tokens restored from a kept prompt state are not prefilled, so
    /// they come out of the prefill-throughput numerator.
    #[test]
    fn cached_prompt_tokens_are_not_counted_as_prefilled() {
        let parsed = parse_tensorfold(
            "\
# TYPE tensorfold:prompt_tokens_total counter
tensorfold:prompt_tokens_total 1000
# TYPE tensorfold:prompt_tokens_cached_total counter
tensorfold:prompt_tokens_cached_total 400
# TYPE tensorfold:request_prefill_seconds histogram
tensorfold:request_prefill_seconds_bucket{le=\"+Inf\"} 1
tensorfold:request_prefill_seconds_sum 10
tensorfold:request_prefill_seconds_count 1
",
        )
        .expect("parses");
        let m = map_unbaselined(&parsed, RateInputs::default(), None, false);
        assert_close(m.per_request_prompt_tps, 60.0);
    }

    /// The same set plus the optional PrefixCache, declared once a scrape has
    /// shown its families.
    fn tensorfold_groups_with_prefix_cache() -> BTreeSet<MetricGroup> {
        let mut groups = tensorfold_groups();
        groups.insert(MetricGroup::PrefixCache);
        groups
    }

    /// The prompt-cache families as upstream renders them: the kept-state
    /// gauges, the cached-token counter and its vLLM-named hit/query mirrors.
    /// The capture host serves a family without kept prompt states, so this
    /// scrape is the engine's exposition shape (from upstream's metrics source
    /// and exposition tests), not a live capture.
    const CACHE_SCRAPE: &str = include_str!("fixtures/tensorfold_metrics_prompt_cache.txt");

    /// The declaration and the mapping agree in both directions, over the real
    /// scrape: a group TensorFold leaves out has no field the mapping fills,
    /// and each group an engine declares has one that scrape fills.
    /// PrefixCache is optional per engine (ADR-0004): the captured scrape
    /// carries no prompt-cache families, so the declaration must leave it out
    /// rather than show its tiles as "not yet" forever — and a scrape that
    /// does carry them declares it and fills the fields (the adapter latch test
    /// below drives that through the real code path).
    #[test]
    fn the_declaration_and_the_mapping_agree() {
        let adapter = adapter();
        let declared = adapter.metric_groups();
        assert_eq!(declared, tensorfold_groups());
        assert!(
            !declared.contains(&MetricGroup::PrefixCache),
            "a scrape with no prompt-cache families does not declare PrefixCache"
        );
        assert!(
            !declared.contains(&MetricGroup::QueueTime),
            "a launch without the phase families does not declare QueueTime"
        );
        assert!(
            !declared.contains(&MetricGroup::Preemptions),
            "a launch whose scrape has no preemption counter does not declare Preemptions"
        );
        assert!(!adapter.metrics_off());
        assert_eq!(adapter.metrics_launch_flag(), None);
        assert_eq!(adapter.metrics_error(), None);

        let rates = RateInputs {
            tokens_per_sec: Some(30.0),
            prompt_tokens_per_sec: Some(100.0),
            avg_tokens_per_sec: Some(25.0),
            avg_prompt_tokens_per_sec: Some(90.0),
        };
        let parsed = parsed_real();
        let metrics = engine_metrics(&parsed, &parsed, rates, Some(50.0), false);
        let json = |m: EngineMetrics| serde_json::to_value(m).unwrap();

        assert_eq!(
            json(metrics.clone().reported_only(&declared)),
            json(metrics.clone()),
            "nothing TensorFold fills belongs to a group it leaves out",
        );
        for group in &declared {
            assert_ne!(
                json(metrics.clone().reported_only(&BTreeSet::from([*group]))),
                json(EngineMetrics::default()),
                "the real scrape fills {group:?}",
            );
        }
        // The mapping would fill PrefixCache from a scrape that carries it;
        // the declaration only claims it once such a scrape has been seen.
        assert_eq!(metrics.prefix_cache_hit_rate, None);
        assert_eq!(metrics.prefix_cache_queries_total, None);
        let with_cache = parse_tensorfold(CACHE_SCRAPE).expect("parses");
        let cache_metrics =
            engine_metrics(&with_cache, &with_cache, RateInputs::default(), None, false);
        assert_ne!(
            json(cache_metrics.reported_only(&BTreeSet::from([MetricGroup::PrefixCache]))),
            json(EngineMetrics::default()),
            "a scrape with prompt-cache families fills PrefixCache",
        );
    }

    /// PrefixCache is a per-engine declaration, driven by the scrape: the
    /// captured scrape (no prompt-cache families) never declares it, and a
    /// scrape that carries one declares it from that tick on and reports its
    /// fields under it. The tiles read "not reported" until then, never "--".
    #[tokio::test]
    async fn the_prefix_cache_group_is_declared_only_after_its_families_appear() {
        use super::super::test_server::TestServer;

        let captured = TestServer::start(|_| (200, REAL.to_string())).await;
        let adapter =
            TensorfoldAdapter::new(reqwest::Client::new(), captured.url.clone(), None, None);
        assert!(!adapter.metric_groups().contains(&MetricGroup::PrefixCache));
        let m = adapter.get_metrics().await.expect("metrics");
        assert_eq!(m.prefix_cache_hit_rate, None);
        assert_eq!(m.prefix_cache_queries_total, None);
        assert!(
            !adapter.metric_groups().contains(&MetricGroup::PrefixCache),
            "the captured engine keeps no prompt states"
        );

        let cache = TestServer::start(|_| (200, CACHE_SCRAPE.to_string())).await;
        let adapter = TensorfoldAdapter::new(reqwest::Client::new(), cache.url.clone(), None, None);
        assert!(!adapter.metric_groups().contains(&MetricGroup::PrefixCache));
        let m = adapter.get_metrics().await.expect("metrics");
        assert_close(m.prefix_cache_hit_rate, 96.0 / 220.0 * 100.0);
        assert_eq!(m.prefix_cache_queries_total, Some(220));
        let declared = adapter.metric_groups();
        assert_eq!(declared, tensorfold_groups_with_prefix_cache());
        assert!(
            declared.contains(&MetricGroup::PrefixCache),
            "a scrape with the families declares the group"
        );
        assert_ne!(
            serde_json::to_value(m.reported_only(&declared)).unwrap(),
            serde_json::to_value(EngineMetrics::default()).unwrap(),
            "the declared group carries the scraped fields"
        );
    }

    /// QueueTime and Preemptions are per-launch declarations like PrefixCache,
    /// driven by the scrape: absent while the capture has no phase families or
    /// preemption counter, declared from the first scrape that carries them.
    #[tokio::test]
    async fn the_optional_groups_are_declared_only_when_their_families_appear() {
        use super::super::test_server::TestServer;

        let captured = TestServer::start(|_| (200, REAL.to_string())).await;
        let adapter =
            TensorfoldAdapter::new(reqwest::Client::new(), captured.url.clone(), None, None);
        assert!(!adapter.metric_groups().contains(&MetricGroup::QueueTime));
        assert!(!adapter.metric_groups().contains(&MetricGroup::Preemptions));
        adapter.get_metrics().await.expect("metrics");
        assert!(
            !adapter.metric_groups().contains(&MetricGroup::QueueTime),
            "the captured launch renders no phase families"
        );
        assert!(
            !adapter.metric_groups().contains(&MetricGroup::Preemptions),
            "the captured scrape carries no preemption counter"
        );

        let queue = TestServer::start(|_| (200, QUEUE_SCRAPE.to_string())).await;
        let adapter = TensorfoldAdapter::new(reqwest::Client::new(), queue.url.clone(), None, None);
        assert!(!adapter.metric_groups().contains(&MetricGroup::QueueTime));
        adapter.get_metrics().await.expect("metrics");
        assert!(
            adapter.metric_groups().contains(&MetricGroup::QueueTime),
            "a scrape with the phase families declares the group"
        );

        let preemptions = TestServer::start(|_| (200, PREEMPTIONS_SCRAPE.to_string())).await;
        let adapter =
            TensorfoldAdapter::new(reqwest::Client::new(), preemptions.url.clone(), None, None);
        assert!(!adapter.metric_groups().contains(&MetricGroup::Preemptions));
        adapter.get_metrics().await.expect("metrics");
        assert!(
            adapter.metric_groups().contains(&MetricGroup::Preemptions),
            "a scrape with the preemption counter declares the group"
        );
    }

    #[test]
    fn only_tensorfold_series_count_as_the_engines() {
        let comment_only = parse_tensorfold("# only a comment\n").expect("parses");
        assert!(!has_tensorfold_series(&comment_only));
        let foreign = parse_tensorfold("process_open_fds 12\n").expect("parses");
        assert!(!has_tensorfold_series(&foreign));
        assert!(has_tensorfold_series(&parsed_real()));
    }

    /// A scrape whose request and token counters stand at `requests` and
    /// `tokens` — the shape a live engine's scrape grows through.
    fn growing_scrape(requests: u64, tokens: u64) -> String {
        format!(
            "# TYPE tensorfold:time_to_first_token_seconds histogram\n\
             tensorfold:time_to_first_token_seconds_bucket{{le=\"0.5\"}} {requests}\n\
             tensorfold:time_to_first_token_seconds_bucket{{le=\"+Inf\"}} {requests}\n\
             tensorfold:time_to_first_token_seconds_sum {sum}\n\
             tensorfold:time_to_first_token_seconds_count {requests}\n\
             # TYPE tensorfold:generation_tokens_total counter\n\
             tensorfold:generation_tokens_total {tokens}\n\
             # TYPE tensorfold:requests_running gauge\n\
             tensorfold:requests_running 1\n",
            sum = requests as f64 * 0.1,
        )
    }

    /// A scrape whose request, token and prefix-cache counters stand at the
    /// given values — the shape a live engine's scrape grows through.
    fn counting_scrape(
        requests: u64,
        prompt: u64,
        generation: u64,
        queries: u64,
        hits: u64,
    ) -> String {
        format!(
            "# TYPE tensorfold:time_to_first_token_seconds histogram\n\
             tensorfold:time_to_first_token_seconds_bucket{{le=\"+Inf\"}} {requests}\n\
             tensorfold:time_to_first_token_seconds_sum {sum}\n\
             tensorfold:time_to_first_token_seconds_count {requests}\n\
             # TYPE tensorfold:prompt_tokens_total counter\n\
             tensorfold:prompt_tokens_total {prompt}\n\
             # TYPE tensorfold:generation_tokens_total counter\n\
             tensorfold:generation_tokens_total {generation}\n\
             # TYPE tensorfold:prefix_cache_queries_total counter\n\
             tensorfold:prefix_cache_queries_total {queries}\n\
             # TYPE tensorfold:prefix_cache_hits_total counter\n\
             tensorfold:prefix_cache_hits_total {hits}\n",
            sum = requests as f64 * 0.1,
        )
    }

    /// Warmup ends on TensorFold's own request counter, and the lifetime
    /// request count stays absolute across the baseline.
    #[tokio::test]
    async fn warmup_completes_as_tensorfold_serves_requests() {
        use super::super::test_server::TestServer;
        use std::sync::atomic::AtomicU64;
        use std::sync::Arc;

        let polls = Arc::new(AtomicU64::new(0));
        let served = polls.clone();
        let server = TestServer::start(move |r| {
            if r.path != "/v1/metrics" {
                return (404, String::new());
            }
            let n = served.fetch_add(1, Ordering::SeqCst);
            (200, growing_scrape(5 + n, 1000 + 100 * n))
        })
        .await;
        let adapter =
            TensorfoldAdapter::new(reqwest::Client::new(), server.url.clone(), None, None);

        // First scrape: 5 requests already served — the attach cursor.
        let first = adapter.get_metrics().await.expect("metrics");
        assert!(first.warming_up);
        assert_eq!(first.total_requests, Some(5));
        assert_eq!(first.tokens_per_sec, None);

        // One more request: warmup is over, and the lifetime count does not
        // restart at the baseline.
        let second = adapter.get_metrics().await.expect("metrics");
        assert!(!second.warming_up, "warmup ends after one request");
        assert_eq!(second.total_requests, Some(6));

        // Steady state: the delta-derived figures fill in.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        let third = adapter.get_metrics().await.expect("metrics");
        assert!(!third.warming_up);
        assert_eq!(third.total_requests, Some(7));
        assert!(third.tokens_per_sec.is_some_and(|tps| tps > 0.0));
        assert!(third.ttft_ms.is_some_and(|ms| ms > 0.0));
    }

    /// Token counters and the prefix-cache ratio count from the warmup
    /// baseline, the rule #154 made for every engine: the lifetime count while
    /// warming, zero at the baseline scrape, then the window since it.
    #[tokio::test]
    async fn token_counters_count_from_the_warmup_baseline() {
        use super::super::test_server::TestServer;
        use std::sync::atomic::AtomicUsize; // Ordering is imported for the module

        // (requests, prompt tokens, generation tokens, prefix queries, hits).
        const SCRAPES: [(u64, u64, u64, u64, u64); 3] = [
            (5, 1_000, 200, 10, 4),
            (6, 1_100, 260, 20, 8),
            (7, 1_350, 410, 30, 12),
        ];
        let polls = std::sync::Arc::new(AtomicUsize::new(0));
        let served = polls.clone();
        let server = TestServer::start(move |r| {
            if r.path != "/v1/metrics" {
                return (404, String::new());
            }
            let n = served.fetch_add(1, Ordering::SeqCst);
            let (requests, prompt, generation, queries, hits) = SCRAPES[n];
            (
                200,
                counting_scrape(requests, prompt, generation, queries, hits),
            )
        })
        .await;
        let adapter =
            TensorfoldAdapter::new(reqwest::Client::new(), server.url.clone(), None, None);
        // Skip one request, whatever `SPARK_WARMUP_SKIP_REQUESTS` says.
        *adapter.warmup.lock().await = WarmupTracker::new(1, WARMUP_TRIGGER_KEY);

        // Attached at 5 requests: still warming, so the lifetime counters.
        let first = adapter.get_metrics().await.expect("metrics");
        assert!(first.warming_up);
        assert_eq!(first.total_prompt_tokens, Some(1_000));
        assert_eq!(first.total_generation_tokens, Some(200));
        assert_eq!(
            first.total_requests,
            Some(5),
            "the request count stays absolute"
        );
        assert_eq!(first.prefix_cache_queries_total, Some(10));
        assert_close(first.prefix_cache_hit_rate, 40.0);

        // One more request ends warmup. This scrape is the baseline, so the
        // token and prefix-cache counters restart, not keep their lifetime
        // values.
        let second = adapter.get_metrics().await.expect("metrics");
        assert!(!second.warming_up);
        assert_eq!(second.total_prompt_tokens, Some(0));
        assert_eq!(second.total_generation_tokens, Some(0));
        assert_eq!(second.prefix_cache_queries_total, Some(0));
        assert_eq!(
            second.prefix_cache_hit_rate, None,
            "no queries against the baseline"
        );

        // Steady state: the counters since the baseline, not lifetime totals.
        let third = adapter.get_metrics().await.expect("metrics");
        assert!(!third.warming_up);
        assert_eq!(third.total_prompt_tokens, Some(250));
        assert_eq!(third.total_generation_tokens, Some(150));
        assert_eq!(third.prefix_cache_queries_total, Some(10));
        assert_close(third.prefix_cache_hit_rate, 40.0);
        assert_ne!(
            third.total_generation_tokens,
            Some(410),
            "not the engine's lifetime count"
        );
    }

    /// The live throughput is the engine's own windowed rate from `/health` —
    /// not a diff of the scrape counters, which only move when a request
    /// finishes and read zero while requests are still decoding.
    #[tokio::test]
    async fn live_throughput_is_the_engines_own_windowed_rate() {
        use super::super::test_server::TestServer;
        use std::sync::atomic::AtomicU64;
        use std::sync::Arc;

        let health_polls = Arc::new(AtomicU64::new(0));
        let served_health = health_polls.clone();
        let metric_polls = Arc::new(AtomicU64::new(0));
        let served_metrics = metric_polls.clone();
        let server = TestServer::start(move |r| match r.path.as_str() {
            "/health" => {
                let n = served_health.fetch_add(1, Ordering::SeqCst);
                let decode = 60.0 + 10.0 * n as f64;
                (
                    200,
                    format!(
                        r#"{{"status":"ok","model":"m","warming":false,"live":{{"connections":0,"waiting":0,"decode_tokens_per_second":{decode},"prefill_tokens_per_second":0.0}}}}"#
                    ),
                )
            }
            "/v1/metrics" => {
                let n = served_metrics.fetch_add(1, Ordering::SeqCst);
                (200, growing_scrape(5 + n, 1000 + 100 * n))
            }
            _ => (404, String::new()),
        })
        .await;
        let adapter =
            TensorfoldAdapter::new(reqwest::Client::new(), server.url.clone(), None, None);

        // Warmup: the first scrape attaches the baseline, and the rates blank.
        assert_eq!(adapter.health_check().await, EngineStatus::Running);
        let first = adapter.get_metrics().await.expect("metrics");
        assert!(first.warming_up);
        assert_eq!(first.tokens_per_sec, None);

        // One request later the baseline is captured; the live rate is the
        // `/health` window (70 tok/s at this poll), not a counter diff.
        assert_eq!(adapter.health_check().await, EngineStatus::Running);
        let second = adapter.get_metrics().await.expect("metrics");
        assert!(!second.warming_up);
        assert_eq!(second.tokens_per_sec, Some(70.0));
        assert_eq!(second.avg_tokens_per_sec, Some(70.0));
        assert_eq!(second.prompt_tokens_per_sec, Some(0.0));
        assert_eq!(second.avg_prompt_tokens_per_sec, None);

        // The running average follows the engine-reported rates.
        assert_eq!(adapter.health_check().await, EngineStatus::Running);
        let third = adapter.get_metrics().await.expect("metrics");
        assert_eq!(third.tokens_per_sec, Some(80.0));
        assert_eq!(third.avg_tokens_per_sec, Some(75.0));
    }

    /// A key-gated launch answers only the status on the open health route, so
    /// the adapter clears any stored live rate and diffs the scrape counters
    /// instead of keeping a stale one.
    #[tokio::test]
    async fn a_key_gated_health_falls_back_to_diffing_the_scrape_counters() {
        use super::super::test_server::TestServer;
        use std::sync::atomic::AtomicU64;
        use std::sync::Arc;

        let health_polls = Arc::new(AtomicU64::new(0));
        let served_health = health_polls.clone();
        let metric_polls = Arc::new(AtomicU64::new(0));
        let served_metrics = metric_polls.clone();
        let server = TestServer::start(move |r| match r.path.as_str() {
            "/health" => {
                let n = served_health.fetch_add(1, Ordering::SeqCst);
                let body = if n == 0 {
                    // An engine that publishes its rates.
                    r#"{"status":"ok","live":{"decode_tokens_per_second":999.0,"prefill_tokens_per_second":0.0}}"#
                        .to_string()
                } else {
                    // The same engine behind a key: only the status is open.
                    r#"{"status":"ok"}"#.to_string()
                };
                (200, body)
            }
            "/v1/metrics" => {
                let n = served_metrics.fetch_add(1, Ordering::SeqCst);
                (200, growing_scrape(5 + n, 1000 + 100 * n))
            }
            _ => (404, String::new()),
        })
        .await;
        let adapter =
            TensorfoldAdapter::new(reqwest::Client::new(), server.url.clone(), None, None);

        assert_eq!(adapter.health_check().await, EngineStatus::Running);
        let first = adapter.get_metrics().await.expect("metrics");
        assert!(first.warming_up);

        // The status-only answer clears the 999 tok/s rate: the fallback's
        // first counter diff has no previous reading yet.
        assert_eq!(adapter.health_check().await, EngineStatus::Running);
        let second = adapter.get_metrics().await.expect("metrics");
        assert!(!second.warming_up);
        assert_eq!(
            second.tokens_per_sec, None,
            "the stale live rate must not survive a status-only health answer"
        );

        // Steady state: the counter delta fills the rate in.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert_eq!(adapter.health_check().await, EngineStatus::Running);
        let third = adapter.get_metrics().await.expect("metrics");
        assert!(third.tokens_per_sec.is_some_and(|tps| tps > 0.0));
    }

    /// A metrics 401 latches `AuthRequired` — the state that says the dashboard
    /// lacks the key, not that metrics are off — and a successful answer clears
    /// it, as a fixed provider API key would.
    #[tokio::test]
    async fn a_refused_metrics_route_latches_auth_required_and_a_success_clears_it() {
        use super::super::test_server::TestServer;
        use std::sync::atomic::AtomicU16;
        use std::sync::Arc;

        let status = Arc::new(AtomicU16::new(401));
        let answer = status.clone();
        let server = TestServer::start(move |_| {
            let code = answer.load(Ordering::SeqCst);
            // A refusal answers upstream's 401 body (its keyed golden
            // transcript); a successful scrape answers a parseable scrape.
            let body = if code == StatusCode::OK.as_u16() {
                "# TYPE tensorfold:requests_running gauge\n\
                 tensorfold:requests_running 2\n\
                 # TYPE tensorfold:time_to_first_token_seconds histogram\n\
                 tensorfold:time_to_first_token_seconds_bucket{le=\"+Inf\"} 1\n\
                 tensorfold:time_to_first_token_seconds_sum 0.2\n\
                 tensorfold:time_to_first_token_seconds_count 1\n"
                    .to_string()
            } else {
                include_str!("fixtures/tensorfold_metrics_401.json").to_string()
            };
            (code, body)
        })
        .await;
        let adapter =
            TensorfoldAdapter::new(reqwest::Client::new(), server.url.clone(), None, None);

        assert!(adapter.get_metrics().await.is_none());
        assert_eq!(
            adapter.metrics_error(),
            Some(MetricsError::AuthRequired),
            "a 401 is the dashboard missing the key"
        );
        assert!(
            !adapter.metrics_off(),
            "the route is mounted; auth is the reason"
        );

        for refused in [StatusCode::FORBIDDEN, StatusCode::UNAUTHORIZED] {
            status.store(refused.as_u16(), Ordering::SeqCst);
            assert!(adapter.get_metrics().await.is_none());
            assert_eq!(adapter.metrics_error(), Some(MetricsError::AuthRequired));
        }

        status.store(StatusCode::OK.as_u16(), Ordering::SeqCst);
        let m = adapter.get_metrics().await.expect("metrics");
        assert_eq!(adapter.metrics_error(), None, "a key fixed it");
        assert_eq!(m.active_requests, Some(2));
    }

    /// Older builds serve the scrape on `/metrics` only; `/v1/metrics` 404s
    /// and the adapter falls back — one request more, and the metrics arrive.
    #[tokio::test]
    async fn a_missing_v1_metrics_route_falls_back_to_the_legacy_one() {
        use super::super::test_server::TestServer;
        let server = TestServer::start(|r| match r.path.as_str() {
            "/metrics" => (
                200,
                "# TYPE tensorfold:requests_running gauge\n\
                 tensorfold:requests_running 3\n"
                    .to_string(),
            ),
            _ => (404, "Not Found".to_string()),
        })
        .await;
        let adapter =
            TensorfoldAdapter::new(reqwest::Client::new(), server.url.clone(), None, None);
        let m = adapter.get_metrics().await.expect("metrics via fallback");
        assert_eq!(m.active_requests, Some(3));
        let asked: Vec<_> = server.requests().iter().map(|r| r.path.clone()).collect();
        assert_eq!(asked, vec!["/v1/metrics", "/metrics"]);
    }

    /// Where `/v1/metrics` answers, it is the only route asked — the fallback
    /// is for releases that predate it, not a second scrape every tick.
    #[tokio::test]
    async fn the_v1_metrics_route_is_preferred_when_it_answers() {
        use super::super::test_server::TestServer;
        let server = TestServer::start(|_| {
            (
                200,
                "# TYPE tensorfold:requests_running gauge\n\
                 tensorfold:requests_running 3\n"
                    .to_string(),
            )
        })
        .await;
        let adapter =
            TensorfoldAdapter::new(reqwest::Client::new(), server.url.clone(), None, None);
        assert_eq!(
            adapter
                .get_metrics()
                .await
                .expect("metrics")
                .active_requests,
            Some(3)
        );
        let asked: Vec<_> = server.requests().iter().map(|r| r.path.clone()).collect();
        assert_eq!(asked, vec!["/v1/metrics"]);
        assert_eq!(asked[0], METRICS_PATH);
    }

    /// The live acceptance rate is the delta between two scrapes' MTP counters;
    /// it is blank while warming, and cleared to `None` when the counters
    /// restart.
    #[tokio::test]
    async fn the_live_acceptance_rate_is_the_delta_between_scrapes() {
        use super::super::test_server::TestServer;
        use std::sync::atomic::AtomicU64;
        use std::sync::Arc;

        let polls = Arc::new(AtomicU64::new(0));
        let served = polls.clone();
        let server = TestServer::start(move |_| {
            let n = served.fetch_add(1, Ordering::SeqCst);
            let body = format!(
                "# TYPE tensorfold:time_to_first_token_seconds histogram\n\
                 tensorfold:time_to_first_token_seconds_bucket{{le=\"+Inf\"}} {count}\n\
                 tensorfold:time_to_first_token_seconds_sum {sum}\n\
                 tensorfold:time_to_first_token_seconds_count {count}\n\
                 # TYPE tensorfold:mtp_drafted_total counter\n\
                 tensorfold:mtp_drafted_total {drafted}\n\
                 # TYPE tensorfold:mtp_accepted_total counter\n\
                 tensorfold:mtp_accepted_total {accepted}\n",
                count = 5 + n,
                sum = (5 + n) as f64 * 0.1,
                drafted = 100 + 100 * n,
                accepted = 50 + 50 * n,
            );
            (200, body)
        })
        .await;
        let adapter =
            TensorfoldAdapter::new(reqwest::Client::new(), server.url.clone(), None, None);

        let first = adapter.get_metrics().await.expect("metrics");
        assert_eq!(
            first.spec_decode_acceptance_rate_live, None,
            "first reading"
        );
        // The second poll ends warmup, and the baseline resets the delta
        // snapshot, so that poll has no live rate either.
        let second = adapter.get_metrics().await.expect("metrics");
        assert!(!second.warming_up, "warmup ends after one request");
        assert_eq!(second.spec_decode_acceptance_rate_live, None);
        // Steady state: 50 accepted of 100 drafted in the interval.
        let third = adapter.get_metrics().await.expect("metrics");
        assert!(!third.warming_up);
        assert_close(third.spec_decode_acceptance_rate_live, 50.0);
        assert_close(third.spec_decode_acceptance_rate, 150.0 / 300.0 * 100.0);
    }

    /// The captured health answer carries the engine's own live rates; a
    /// key-gated answer (status only) or one without the `live` block does not.
    #[test]
    fn the_health_live_block_carries_the_engines_own_rates() {
        let captured = health_live_rates(include_str!("fixtures/tensorfold_health.json"))
            .expect("the captured answer carries the live block");
        assert_eq!(captured.decode_tps, Some(51.0));
        assert_eq!(captured.prefill_tps, Some(0.0));
        assert_eq!(
            health_live_rates(r#"{"status":"ok"}"#),
            None,
            "the key-gated answer has no live block"
        );
        assert_eq!(health_live_rates("not json"), None);
        assert_eq!(
            health_live_rates(r#"{"status":"ok","live":{"connections":0}}"#),
            None,
            "a live block without a rate is no rate"
        );
    }

    /// The engine-reported rate average skips idle polls and holds while the
    /// engine idles, the same rule the counter-diffed rates follow.
    #[test]
    fn the_rate_average_skips_idle_polls_and_holds_while_idle() {
        let mut mean = RateMean::default();
        assert_eq!(mean.observe(None), None);
        assert_eq!(mean.observe(Some(0.0)), None);
        assert_eq!(mean.observe(Some(80.0)), Some(80.0));
        assert_eq!(
            mean.observe(Some(0.0)),
            Some(80.0),
            "an idle poll holds the average"
        );
        assert_eq!(mean.observe(Some(120.0)), Some(100.0));
        mean.reset();
        assert_eq!(mean.observe(Some(50.0)), Some(50.0));
    }

    /// Health: a warming engine is loading; a key-gated launch's `{"status":"ok"}`
    /// answer is running; a non-2xx is an error naming the status; and the
    /// endpoint's API key travels with the request.
    #[tokio::test]
    async fn health_reads_warming_and_reports_failures() {
        use super::super::test_server::TestServer;
        let cases: [(u16, &str, EngineStatus); 6] = [
            (
                200,
                r#"{"status":"ok","model":"m","warming":true}"#,
                EngineStatus::Loading,
            ),
            // The health answer captured verbatim from the live engine (the
            // wire reports version 1.2.5): idle, so running.
            (
                200,
                include_str!("fixtures/tensorfold_health.json"),
                EngineStatus::Running,
            ),
            (
                200,
                r#"{"status":"ok","model":"m","warming":false}"#,
                EngineStatus::Running,
            ),
            // A key-gated launch answers only this on the open route: the
            // status-only health body from upstream's keyed golden transcript.
            (
                200,
                include_str!("fixtures/tensorfold_health_keyed.json"),
                EngineStatus::Running,
            ),
            (
                500,
                "",
                EngineStatus::Error("HTTP 500 Internal Server Error".into()),
            ),
            (401, "", EngineStatus::Error("HTTP 401 Unauthorized".into())),
        ];
        for (status, body, expected) in cases {
            let server = TestServer::start(move |_| (status, body.to_string())).await;
            let adapter = TensorfoldAdapter::new(
                reqwest::Client::new(),
                server.url.clone(),
                None,
                Some("k".into()),
            );
            assert_eq!(adapter.health_check().await, expected, "{status} {body:?}");
            let asked = server.requests();
            assert_eq!(asked.len(), 1);
            assert_eq!(asked[0].path, HEALTH_PATH);
            assert_eq!(asked[0].authorization.as_deref(), Some("Bearer k"));
        }
    }

    /// The models answer captured verbatim from the live instance resolves
    /// through the shared resolver without a metadata error: TensorFold's
    /// `/v1/models` has vLLM's shape and names its served id.
    #[tokio::test]
    async fn the_captured_models_answer_names_the_model() {
        use super::super::test_server::TestServer;
        let server = TestServer::start(|r| match r.path.as_str() {
            "/v1/models" => (
                200,
                include_str!("fixtures/tensorfold_models.json").to_string(),
            ),
            _ => (404, String::new()),
        })
        .await;
        let adapter =
            TensorfoldAdapter::new(reqwest::Client::new(), server.url.clone(), None, None);
        let resolution = adapter.get_model_info().await;
        assert_eq!(
            resolution.metadata_error, None,
            "the engine's own answer resolved"
        );
        assert_eq!(
            resolution.model.map(|m| m.name).as_deref(),
            Some("deepseek-v4.1-flash"),
            "the id /v1/models reports"
        );
        let asked: Vec<_> = server.requests().iter().map(|r| r.path.clone()).collect();
        assert_eq!(asked, vec!["/v1/models"]);
    }

    /// TensorFold's `/v1/models` goes through the resolver vLLM and SGLang
    /// use, so an API-key launch the dashboard holds no key for is reported the
    /// same way: the command-line name as a fallback, `AuthRequired` beside it,
    /// and the warning that tells the operator to configure a provider API
    /// key.
    #[tokio::test]
    async fn an_unauthorized_models_route_warns_like_vllm() {
        use super::super::test_server::TestServer;
        use super::super::ModelMetadataError;
        use std::io::Write;
        use std::sync::{Arc, Mutex as StdMutex};

        #[derive(Clone, Default)]
        struct Captured(Arc<StdMutex<Vec<u8>>>);
        impl Write for Captured {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let logs = Captured::default();
        let writer = logs.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(move || writer.clone())
            .with_ansi(false)
            .finish();
        let _guard = tracing::subscriber::set_default(subscriber);

        let server = TestServer::start(|_| (401, "Unauthorized".into())).await;
        let adapter = TensorfoldAdapter::new(
            reqwest::Client::new(),
            server.url.clone(),
            // Not an `org/name` id, so HF enrichment never leaves the host.
            Some("tf-local".into()),
            None,
        );
        let resolution = adapter.get_model_info().await;

        assert_eq!(
            resolution.metadata_error,
            Some(ModelMetadataError::AuthRequired)
        );
        assert_eq!(
            resolution.model.map(|m| m.name).as_deref(),
            Some("tf-local")
        );
        let logged = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
        assert!(
            logged.contains("configure a provider API key"),
            "warning logged: {logged}"
        );
    }

    fn http(url: &str, key: Option<&str>) -> EngineHttp {
        EngineHttp::new(
            reqwest::Client::new(),
            url.to_string(),
            key.map(str::to_string),
        )
    }

    /// Identification accepts TensorFold's several answers and rejects servers
    /// that only look like it: vLLM's empty `/health`, SGLang's ready body,
    /// llama.cpp's status-only JSON, and Ollama's missing route.
    #[tokio::test]
    async fn identify_accepts_tensorfold_and_rejects_other_engines() {
        use super::super::test_server::TestServer;

        // Header-based acceptance.
        for (case, header) in [
            ("exact", "TensorFold"),
            ("lowercase", "tensorfold"),
            ("versioned", "TensorFold/1.1.3"),
        ] {
            let server = TestServer::start_with_headers(move |_| {
                (200, String::new(), vec![("Server", header.to_string())])
            })
            .await;
            assert!(identify(&http(&server.url, None)).await, "{case}");
        }
        // Body-based acceptance, with a foreign `Server` header: only answers
        // that name TensorFold itself count, not another engine's ok status.
        for (case, body) in [
            (
                "model ids",
                r#"{"status":"ok","model":"m","model_ids":["m"],"warming":false}"#,
            ),
            (
                "the backend field",
                r#"{"status":"ok","model":"m","backend":"tensorfold"}"#,
            ),
            (
                "the captured health answer",
                include_str!("fixtures/tensorfold_health.json"),
            ),
        ] {
            let server = TestServer::start_with_headers(move |_| {
                (
                    200,
                    body.to_string(),
                    vec![("Server", "uvicorn".to_string())],
                )
            })
            .await;
            assert!(identify(&http(&server.url, None)).await, "{case}");
        }

        // Rejections: 2xx is required of a named server, and the body shapes
        // other engines answer must not read as TensorFold.
        let rejects: [(u16, &str, &str, &str); 8] = [
            (200, "", "uvicorn", "vLLM's empty health"),
            (200, "OK", "uvicorn", "SGLang's ready body on health"),
            (
                200,
                r#"{"status":"ok"}"#,
                "llama.cpp",
                "llama.cpp's status-only json",
            ),
            (
                200,
                r#"{"status":"ok","model":"m"}"#,
                "uvicorn",
                "an ok status and a model name name nothing",
            ),
            (404, "Not Found", "uvicorn", "Ollama has no /health"),
            (200, r#"{"ok":true}"#, "uvicorn", "ok without a model"),
            (500, "", "TensorFold", "named but not serving"),
            (401, "", "TensorFold", "refused"),
        ];
        for (status, body, header, case) in rejects {
            let server = TestServer::start_with_headers(move |_| {
                (
                    status,
                    body.to_string(),
                    vec![("Server", header.to_string())],
                )
            })
            .await;
            assert!(!identify(&http(&server.url, None)).await, "{case}");
        }
        // …and the endpoint's key travels with the probe.
        let server = TestServer::start(|_| (200, r#"{"model_ids":[]}"#.to_string())).await;
        assert!(identify(&http(&server.url, Some("k"))).await);
        let asked = server.requests();
        assert_eq!(asked[0].authorization.as_deref(), Some("Bearer k"));
    }
}
