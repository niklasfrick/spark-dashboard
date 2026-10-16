use super::common::{
    spec_acceptance_rate, spec_live_acceptance_rate, spec_mean_acceptance_length,
    warmup_skip_from_env, CounterRate, EngineHttp,
};
use super::histogram::{goodput_pct, mean_ms, percentiles_ms, wire_buckets};
use super::model_info::ModelResolver;
use super::prometheus::parse_prometheus_text;
use super::warmup::WarmupTracker;
use super::{
    EngineAdapter, EngineMetrics, EngineStatus, EngineType, MetricGroup, ModelResolution,
    E2E_SLO_MS, ITL_SLO_MS, TPOT_SLO_MS, TTFT_SLO_MS,
};
use async_trait::async_trait;
use std::collections::BTreeSet;
use std::time::Instant;
use tokio::sync::Mutex;

/// The request counter warmup progress is measured on: every vLLM request
/// adds one observation to the time-to-first-token histogram.
const WARMUP_TRIGGER_KEY: &str = "vllm_time_to_first_token_seconds_count";

pub struct VllmAdapter {
    /// The endpoint, and the bearer token of an auth-gated deployment
    /// (vLLM `--api-key`), applied to every engine request.
    http: EngineHttp,
    /// Model identity: `/v1/models`, the command-line hint, HF enrichment.
    model: ModelResolver,
    /// Generation tokens/s and its running average, from the
    /// generation_tokens_total counter.
    gen_rate: Mutex<CounterRate>,
    /// Prompt tokens/s and its running average, from prompt_tokens_total.
    prompt_rate: Mutex<CounterRate>,
    /// Previous (accepted, draft) spec-decode counter readings, used to compute
    /// the live (windowed) token acceptance rate from per-poll deltas. No
    /// timestamp is stored because the live TAR is a unit-free ratio of deltas.
    prev_spec_decode: Mutex<Option<(f64, f64)>>,
    /// Warmup baseline tracker — drops the first `SPARK_WARMUP_SKIP_REQUESTS`
    /// observations from histogram-derived metrics so the slow first inference
    /// does not skew steady-state percentiles and averages.
    warmup: Mutex<WarmupTracker>,
}

impl VllmAdapter {
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
            prev_spec_decode: Mutex::new(None),
            warmup: Mutex::new(WarmupTracker::new(
                warmup_skip_from_env(),
                WARMUP_TRIGGER_KEY,
            )),
        }
    }
}

#[async_trait]
impl EngineAdapter for VllmAdapter {
    fn engine_type(&self) -> EngineType {
        EngineType::Vllm
    }

    fn endpoint(&self) -> &str {
        self.http.endpoint()
    }

    /// vLLM reports every one of the seventeen metric groups. Speculative
    /// decoding included: the group says the engine *can* report it, and the
    /// `spec_decode_*` counters — present only when a draft model is
    /// configured — say whether this one does, which the panel already tells
    /// apart ("not using speculative decoding").
    fn metric_groups(&self) -> BTreeSet<MetricGroup> {
        MetricGroup::all()
    }

    async fn health_check(&self) -> EngineStatus {
        self.http.health("/health").await
    }

    async fn get_model_info(&self) -> ModelResolution {
        self.model.resolve(&self.http).await
    }

    async fn get_metrics(&self) -> Option<EngineMetrics> {
        let body = self
            .http
            .get("/metrics")
            .send()
            .await
            .ok()?
            .text()
            .await
            .ok()?;

        let raw = parse_prometheus_text(&body)?;

        // Run the parsed metrics through the warmup tracker. While warming, the
        // tracker hands back gauges and counters as-is so pass-through fields
        // (active/queued/kv_cache) stay populated; histogram-derived fields
        // are then forced to None below. After baselining, `adjusted` contains
        // counter and histogram deltas — feeding them into the existing
        // `percentile`/`fraction_le` helpers yields warmup-free metrics.
        let warmup_out = {
            let mut tracker = self.warmup.lock().await;
            tracker.observe(&raw)
        };

        // On baseline transition, the per-poll rate state captured during
        // warmup refers to absolute counter values. Post-transition the
        // tracker hands back deltas, so a stale `prev_*` reading would yield
        // a hugely negative rate on the next tick. Reset everything that
        // depends on the previous reading before computing rates below.
        if warmup_out.just_transitioned {
            self.gen_rate.lock().await.reset();
            self.prompt_rate.lock().await.reset();
            *self.prev_spec_decode.lock().await = None;
            tracing::info!(
                endpoint = %self.http.endpoint(),
                "warmup complete — baseline captured, steady-state metrics now reported"
            );
        }

        let parsed = &warmup_out.adjusted;
        let warming_up = warmup_out.warming_up;

        // Under data parallelism each engine core reports its own series
        // (`engine="0"`, `engine="1"`): the request counts partition the
        // engine's work and sum, while each core's KV usage is a ratio of its
        // own pool, so the engine-wide figure is their mean.
        let active_requests = parsed
            .gauge_sum("vllm_num_requests_running")
            .map(|v| v as u64);
        let queued_requests = parsed
            .gauge_sum("vllm_num_requests_waiting")
            .map(|v| v as u64);
        // v1 uses vllm_kv_cache_usage_perc, v0.6 uses vllm_gpu_cache_usage_perc
        let kv_cache_percent = parsed
            .gauge_mean("vllm_kv_cache_usage_perc")
            .or_else(|| parsed.gauge_mean("vllm_gpu_cache_usage_perc"))
            .map(|v| v * 100.0);

        let counter = |name: &str| parsed.counters.get(name).copied();

        // TTFT from histogram sum/count (average)
        let ttft_ms = mean_ms(
            counter("vllm_time_to_first_token_seconds_sum"),
            counter("vllm_time_to_first_token_seconds_count"),
        );

        // total_requests is a pass-through display field — show the engine's
        // absolute lifetime request count, not the post-baseline delta. Read
        // from `raw` so the value stays continuous across the warmup→active
        // transition rather than snapping back to zero.
        let total_requests = raw
            .counters
            .get("vllm_time_to_first_token_seconds_count")
            .map(|&c| c as u64);

        // Per-request avg TPS from time_per_output_token histogram: 1 / avg_TPOT
        // v1: vllm_request_time_per_output_token_seconds, v0.6: vllm_time_per_output_token_seconds
        let per_request_tps = {
            let sum = parsed
                .counters
                .get("vllm_request_time_per_output_token_seconds_sum")
                .or_else(|| {
                    parsed
                        .counters
                        .get("vllm_time_per_output_token_seconds_sum")
                });
            let count = parsed
                .counters
                .get("vllm_request_time_per_output_token_seconds_count")
                .or_else(|| {
                    parsed
                        .counters
                        .get("vllm_time_per_output_token_seconds_count")
                });
            match (sum, count) {
                (Some(&s), Some(&c)) if c > 0.0 && s > 0.0 => Some(c / s),
                _ => None,
            }
        };

        // Token rates from the generation and prompt counters (delta /
        // elapsed), each with the running mean of its nonzero readings.
        let current_gen = counter("vllm_generation_tokens_total");
        let current_prompt = counter("vllm_prompt_tokens_total");
        let now = Instant::now();
        let (tokens_per_sec, avg_tokens_per_sec) =
            self.gen_rate.lock().await.observe(current_gen, now);
        let (prompt_tokens_per_sec, avg_prompt_tokens_per_sec) =
            self.prompt_rate.lock().await.observe(current_prompt, now);

        // Per-request prompt TPS: prompt_tokens_total / ttft_total_seconds
        // Approximates average prefill throughput per request
        let per_request_prompt_tps = {
            let prompt_total = parsed.counters.get("vllm_prompt_tokens_total");
            let ttft_sum = parsed.counters.get("vllm_time_to_first_token_seconds_sum");
            match (prompt_total, ttft_sum) {
                (Some(&p), Some(&t)) if t > 0.0 => Some(p / t),
                _ => None,
            }
        };

        // --- New metrics ---

        // End-to-end request latency (avg from histogram)
        let e2e_latency_ms = mean_ms(
            counter("vllm_e2e_request_latency_seconds_sum"),
            counter("vllm_e2e_request_latency_seconds_count"),
        );

        // Swapped requests (memory pressure indicator)
        let swapped_requests = parsed
            .gauge_sum("vllm_num_requests_swapped")
            .map(|v| v as u64);

        // Prefix cache hit rate as percentage, computed from the two counters
        // vLLM exposes (vllm:prefix_cache_hits / vllm:prefix_cache_queries).
        // Guard against queries == 0 so the tile stays blank until the engine
        // has served at least one prompt.
        let prefix_cache_hit_rate = {
            let hits = parsed.counters.get("vllm_prefix_cache_hits_total");
            let queries = parsed.counters.get("vllm_prefix_cache_queries_total");
            match (hits, queries) {
                (Some(&h), Some(&q)) if q > 0.0 => Some((h / q) * 100.0),
                _ => None,
            }
        };

        // Cumulative prefix-cache queries — pass-through lifetime counter, the
        // volume the hit rate is derived from. Mirrors total_*_tokens: shown
        // raw and ungated by warmup so it stays continuous.
        let prefix_cache_queries_total = parsed
            .counters
            .get("vllm_prefix_cache_queries_total")
            .map(|&q| q as u64);

        // Average queue wait time (from histogram)
        let queue_time_ms = mean_ms(
            counter("vllm_request_queue_time_seconds_sum"),
            counter("vllm_request_queue_time_seconds_count"),
        );

        // Total preemptions — pass-through display field, read absolute value
        // from `raw` so the lifetime count stays continuous across baselining.
        let preemptions_total = raw
            .counters
            .get("vllm_num_preemptions_total")
            .map(|v| *v as u64);

        // Speculative decoding. vLLM only emits these counters when the served
        // model has speculative decoding configured, so their presence is the
        // signal the frontend uses to show the section at all. The values are
        // read from `raw` (absolute lifetime) so the cumulative token counters
        // count up continuously and the lifetime acceptance ratios are stable.
        // vLLM's prometheus_client appends `_total` to counter names, so try the
        // `_total` key first and fall back to the bare logical name.
        let spec_counter = |name: &str| -> Option<f64> {
            raw.counters
                .get(&format!("vllm_spec_decode_{name}_total"))
                .or_else(|| raw.counters.get(&format!("vllm_spec_decode_{name}")))
                .copied()
        };
        let spec_draft = spec_counter("num_draft_tokens");
        let spec_accepted = spec_counter("num_accepted_tokens");
        let spec_drafts = spec_counter("num_drafts");

        // Prometheus counters are non-negative by spec; clamp before the lossy
        // f64->u64 cast so a malformed/negative sample can never wrap to a huge
        // value (same boundary as `preemptions_total` / `total_requests`).
        let spec_decode_draft_tokens_total = spec_draft.map(|v| v.max(0.0) as u64);
        let spec_decode_accepted_tokens_total = spec_accepted.map(|v| v.max(0.0) as u64);
        let spec_decode_drafts_total = spec_drafts.map(|v| v.max(0.0) as u64);

        // Lifetime token acceptance rate (TAR) = accepted / draft * 100.
        let spec_decode_acceptance_rate = spec_acceptance_rate(spec_accepted, spec_draft);
        // Mean acceptance length = accepted tokens / draft attempts.
        let spec_decode_mean_acceptance_length =
            spec_mean_acceptance_length(spec_accepted, spec_drafts);
        // Live (windowed) TAR from per-poll deltas: Δaccepted / Δdraft * 100.
        // The snapshot is discarded (`prev = None`) whenever a counter is
        // missing this poll or appears to have gone backwards (engine restart
        // resets its counters). Both cases would otherwise diff against a stale
        // snapshot and silently inflate or negate the live rate.
        let spec_decode_acceptance_rate_live = {
            let mut prev_lock = self.prev_spec_decode.lock().await;
            let now = spec_accepted.zip(spec_draft);
            let live = spec_live_acceptance_rate(*prev_lock, now);
            *prev_lock = now;
            live
        };

        // Average batch size (tokens per iteration step)
        let avg_batch_size = {
            let sum = parsed.counters.get("vllm_iteration_tokens_total_sum");
            let count = parsed.counters.get("vllm_iteration_tokens_total_count");
            match (sum, count) {
                (Some(&s), Some(&c)) if c > 0.0 => Some(s / c),
                _ => None,
            }
        };

        // Average inter-token latency during decode (from histogram).
        // Guard against count == 0 so the tile stays blank until the engine
        // has streamed at least one inter-token gap.
        let inter_token_latency_ms = mean_ms(
            counter("vllm_inter_token_latency_seconds_sum"),
            counter("vllm_inter_token_latency_seconds_count"),
        );

        // Average time per output token during decode (from histogram
        // sum/count). vLLM v1 names it `request_time_per_output_token`;
        // v0.6 used `time_per_output_token`. Same shape as ttft_ms.
        let tpot_ms = mean_ms(
            counter("vllm_request_time_per_output_token_seconds_sum")
                .or_else(|| counter("vllm_time_per_output_token_seconds_sum")),
            counter("vllm_request_time_per_output_token_seconds_count")
                .or_else(|| counter("vllm_time_per_output_token_seconds_count")),
        );

        // Tail latency percentiles, SLO goodput and the raw buckets, from the
        // request-level histograms (`_bucket{le="..."}` lines, in seconds).
        let ttft_percentiles = percentiles_ms(parsed, "vllm_time_to_first_token_seconds");
        let itl_percentiles = percentiles_ms(parsed, "vllm_inter_token_latency_seconds");
        let e2e_percentiles = percentiles_ms(parsed, "vllm_e2e_request_latency_seconds");
        let ttft_goodput_pct = goodput_pct(parsed, "vllm_time_to_first_token_seconds", TTFT_SLO_MS);
        let itl_goodput_pct = goodput_pct(parsed, "vllm_inter_token_latency_seconds", ITL_SLO_MS);
        let e2e_goodput_pct = goodput_pct(parsed, "vllm_e2e_request_latency_seconds", E2E_SLO_MS);
        let ttft_buckets = wire_buckets(parsed, "vllm_time_to_first_token_seconds");
        let itl_buckets = wire_buckets(parsed, "vllm_inter_token_latency_seconds");
        let e2e_buckets = wire_buckets(parsed, "vllm_e2e_request_latency_seconds");

        // TPOT has two possible histogram keys depending on vLLM version.
        // Resolve whichever is present, then read it like the others.
        let tpot_hist = if parsed
            .histograms
            .contains_key("vllm_request_time_per_output_token_seconds")
        {
            Some("vllm_request_time_per_output_token_seconds")
        } else if parsed
            .histograms
            .contains_key("vllm_time_per_output_token_seconds")
        {
            Some("vllm_time_per_output_token_seconds")
        } else {
            None
        };
        let tpot_percentiles = tpot_hist.and_then(|m| percentiles_ms(parsed, m));
        let tpot_goodput_pct = tpot_hist.and_then(|m| goodput_pct(parsed, m, TPOT_SLO_MS));
        let tpot_buckets = tpot_hist.and_then(|m| wire_buckets(parsed, m));

        // While warming, histogram-derived metrics still compute from raw
        // pass-through counters/buckets (the tracker doesn't yet have a
        // baseline), so they would carry the slow first observation. Force
        // those fields to None until the tracker transitions to Active. Pass-
        // through fields (gauges + total/preemptions/prefix-cache-rate) stay
        // populated so the UI keeps showing live engine state during warmup.
        let blank = warming_up;
        Some(EngineMetrics {
            tokens_per_sec: if blank { None } else { tokens_per_sec },
            avg_tokens_per_sec: if blank { None } else { avg_tokens_per_sec },
            per_request_tps: if blank { None } else { per_request_tps },
            ttft_ms: if blank { None } else { ttft_ms },
            active_requests,
            queued_requests,
            kv_cache_percent,
            kv_cache_is_estimated: false,
            total_requests,
            e2e_latency_ms: if blank { None } else { e2e_latency_ms },
            prompt_tokens_per_sec: if blank { None } else { prompt_tokens_per_sec },
            avg_prompt_tokens_per_sec: if blank {
                None
            } else {
                avg_prompt_tokens_per_sec
            },
            per_request_prompt_tps: if blank { None } else { per_request_prompt_tps },
            swapped_requests,
            prefix_cache_hit_rate,
            queue_time_ms: if blank { None } else { queue_time_ms },
            inter_token_latency_ms: if blank { None } else { inter_token_latency_ms },
            preemptions_total,
            total_prompt_tokens: current_prompt.map(|v| v as u64),
            total_generation_tokens: current_gen.map(|v| v as u64),
            prefix_cache_queries_total,
            avg_batch_size: if blank { None } else { avg_batch_size },
            ttft_percentiles: if blank { None } else { ttft_percentiles },
            itl_percentiles: if blank { None } else { itl_percentiles },
            e2e_percentiles: if blank { None } else { e2e_percentiles },
            ttft_goodput_pct: if blank { None } else { ttft_goodput_pct },
            itl_goodput_pct: if blank { None } else { itl_goodput_pct },
            e2e_goodput_pct: if blank { None } else { e2e_goodput_pct },
            ttft_buckets: if blank { None } else { ttft_buckets },
            itl_buckets: if blank { None } else { itl_buckets },
            e2e_buckets: if blank { None } else { e2e_buckets },
            tpot_ms: if blank { None } else { tpot_ms },
            tpot_percentiles: if blank { None } else { tpot_percentiles },
            tpot_goodput_pct: if blank { None } else { tpot_goodput_pct },
            tpot_buckets: if blank { None } else { tpot_buckets },
            // Cumulative counters and lifetime ratios are pass-through (ungated
            // by warmup) so they count up / stay stable continuously. Live TAR
            // is a delta-derived rate, so it is blanked during warmup like the
            // other per-poll rates.
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

#[cfg(test)]
mod tests {
    use super::super::histogram::percentile;
    use super::*;

    /// vLLM fills every engine panel, so it declares every one of the
    /// seventeen groups — an operator running it sees no "not reported" tile
    /// or placeholder anywhere.
    #[test]
    fn vllm_reports_every_metric_group() {
        let adapter = VllmAdapter::new(
            reqwest::Client::new(),
            "http://localhost:8000".into(),
            None,
            None,
        );
        assert_eq!(adapter.metric_groups(), MetricGroup::all());
    }

    /// Sanity check: percentiles flow from the parser through the adapter.
    /// We don't spin up an HTTP mock here — `parse_prometheus_text` is the
    /// boundary we care about, so we assert the percentile pipeline against
    /// a representative `/metrics` body. p50 < p95 < p99 must hold.
    #[test]
    fn ttft_percentiles_roundtrip_from_metrics_body() {
        let body = "\
# HELP vllm:time_to_first_token_seconds TTFT histogram.
# TYPE vllm:time_to_first_token_seconds histogram
vllm:time_to_first_token_seconds_bucket{le=\"0.05\"} 50
vllm:time_to_first_token_seconds_bucket{le=\"0.1\"} 80
vllm:time_to_first_token_seconds_bucket{le=\"0.5\"} 95
vllm:time_to_first_token_seconds_bucket{le=\"1.0\"} 99
vllm:time_to_first_token_seconds_bucket{le=\"+Inf\"} 100
vllm:time_to_first_token_seconds_sum 12.0
vllm:time_to_first_token_seconds_count 100.0
";
        let parsed = parse_prometheus_text(body).expect("parse");
        let buckets = parsed
            .histograms
            .get("vllm_time_to_first_token_seconds")
            .expect("histogram");
        let p50 = percentile(buckets, 0.5).expect("p50") * 1000.0;
        let p95 = percentile(buckets, 0.95).expect("p95") * 1000.0;
        let p99 = percentile(buckets, 0.99).expect("p99") * 1000.0;
        assert!(p50 < p95, "p50 {p50} < p95 {p95}");
        assert!(p95 < p99, "p95 {p95} < p99 {p99}");
        // p50 lands at the 0.05 boundary (cumulative count exactly 50).
        // p99 lands inside the (0.5, 1.0] bucket.
        assert!((40.0..=60.0).contains(&p50), "p50 {p50} near 50ms");
        assert!(p99 > 500.0 && p99 <= 1000.0, "p99 {p99} in (500, 1000]");
    }

    /// TPOT pipeline: vLLM v1 emits `request_time_per_output_token_seconds`.
    /// The histogram must land under the normalized key (so `tpot_hist`
    /// resolves it), percentiles must order p50<p95<p99, and the sum/count
    /// counters must yield the same average TPOT the adapter computes.
    #[test]
    fn tpot_histogram_roundtrip_from_metrics_body() {
        let body = "\
# HELP vllm:request_time_per_output_token_seconds TPOT histogram.
# TYPE vllm:request_time_per_output_token_seconds histogram
vllm:request_time_per_output_token_seconds_bucket{le=\"0.01\"} 50
vllm:request_time_per_output_token_seconds_bucket{le=\"0.05\"} 80
vllm:request_time_per_output_token_seconds_bucket{le=\"0.1\"} 95
vllm:request_time_per_output_token_seconds_bucket{le=\"0.5\"} 99
vllm:request_time_per_output_token_seconds_bucket{le=\"+Inf\"} 100
vllm:request_time_per_output_token_seconds_sum 2.0
vllm:request_time_per_output_token_seconds_count 100.0
";
        let parsed = parse_prometheus_text(body).expect("parse");
        let buckets = parsed
            .histograms
            .get("vllm_request_time_per_output_token_seconds")
            .expect("tpot histogram captured under normalized key");
        let p50 = percentile(buckets, 0.5).expect("p50") * 1000.0;
        let p95 = percentile(buckets, 0.95).expect("p95") * 1000.0;
        let p99 = percentile(buckets, 0.99).expect("p99") * 1000.0;
        assert!(p50 < p95 && p95 < p99, "p50 {p50} < p95 {p95} < p99 {p99}");

        let sum = parsed
            .counters
            .get("vllm_request_time_per_output_token_seconds_sum")
            .copied()
            .expect("sum");
        let count = parsed
            .counters
            .get("vllm_request_time_per_output_token_seconds_count")
            .copied()
            .expect("count");
        let tpot_ms = (sum / count) * 1000.0;
        assert!((tpot_ms - 20.0).abs() < 1e-6, "tpot {tpot_ms} ≈ 20ms");
    }

    /// vLLM v0.6 names the metric `time_per_output_token_seconds` (no
    /// `request_` prefix). The resolver must fall back to it when the v1
    /// name is absent.
    #[test]
    fn tpot_falls_back_to_v06_metric_name() {
        let body = "\
# HELP vllm:time_per_output_token_seconds TPOT histogram.
# TYPE vllm:time_per_output_token_seconds histogram
vllm:time_per_output_token_seconds_bucket{le=\"0.05\"} 10
vllm:time_per_output_token_seconds_bucket{le=\"+Inf\"} 10
vllm:time_per_output_token_seconds_sum 0.3
vllm:time_per_output_token_seconds_count 10.0
";
        let parsed = parse_prometheus_text(body).expect("parse");
        assert!(
            !parsed
                .histograms
                .contains_key("vllm_request_time_per_output_token_seconds"),
            "v1 name must be absent in this fixture"
        );
        assert!(
            parsed
                .histograms
                .contains_key("vllm_time_per_output_token_seconds"),
            "v0.6 name must be present so the resolver falls back to it"
        );
        let sum = parsed
            .counters
            .get("vllm_time_per_output_token_seconds_sum")
            .copied()
            .expect("v0.6 sum");
        let count = parsed
            .counters
            .get("vllm_time_per_output_token_seconds_count")
            .copied()
            .expect("v0.6 count");
        let tpot_ms = (sum / count) * 1000.0;
        assert!((tpot_ms - 30.0).abs() < 1e-6, "tpot {tpot_ms} ≈ 30ms");
    }

    /// Integration check: the warmup tracker baselines after the first
    /// observation, and percentiles computed from the second `/metrics` body
    /// reflect *only* the post-baseline observations — proving that the slow
    /// first inference does not pollute steady-state percentiles.
    #[test]
    fn warmup_tracker_excludes_first_observation_from_percentiles() {
        use super::super::warmup::WarmupTracker;

        // Body 1: a single slow observation in the (1.0, +Inf] bucket.
        let body_warmup = "\
# HELP vllm:time_to_first_token_seconds TTFT histogram.
# TYPE vllm:time_to_first_token_seconds histogram
vllm:time_to_first_token_seconds_bucket{le=\"0.05\"} 0
vllm:time_to_first_token_seconds_bucket{le=\"0.1\"} 0
vllm:time_to_first_token_seconds_bucket{le=\"0.5\"} 0
vllm:time_to_first_token_seconds_bucket{le=\"1.0\"} 0
vllm:time_to_first_token_seconds_bucket{le=\"+Inf\"} 1
vllm:time_to_first_token_seconds_sum 8.0
vllm:time_to_first_token_seconds_count 1.0
";
        // Body 2: 100 fast observations all in [0, 0.05] on top of the warmup.
        let body_steady = "\
# HELP vllm:time_to_first_token_seconds TTFT histogram.
# TYPE vllm:time_to_first_token_seconds histogram
vllm:time_to_first_token_seconds_bucket{le=\"0.05\"} 100
vllm:time_to_first_token_seconds_bucket{le=\"0.1\"} 100
vllm:time_to_first_token_seconds_bucket{le=\"0.5\"} 100
vllm:time_to_first_token_seconds_bucket{le=\"1.0\"} 100
vllm:time_to_first_token_seconds_bucket{le=\"+Inf\"} 101
vllm:time_to_first_token_seconds_sum 9.0
vllm:time_to_first_token_seconds_count 101.0
";

        // Body 0: simulates the first poll right after the dashboard attaches
        // — no requests yet. The tracker captures count=0 as its initial
        // cursor here; it transitions to Active only once the cursor advances
        // by `skip_requests`.
        let body_idle = "\
# HELP vllm:time_to_first_token_seconds TTFT histogram.
# TYPE vllm:time_to_first_token_seconds histogram
vllm:time_to_first_token_seconds_bucket{le=\"0.05\"} 0
vllm:time_to_first_token_seconds_bucket{le=\"0.1\"} 0
vllm:time_to_first_token_seconds_bucket{le=\"0.5\"} 0
vllm:time_to_first_token_seconds_bucket{le=\"1.0\"} 0
vllm:time_to_first_token_seconds_bucket{le=\"+Inf\"} 0
vllm:time_to_first_token_seconds_sum 0.0
vllm:time_to_first_token_seconds_count 0.0
";

        let mut tracker = WarmupTracker::new(1, WARMUP_TRIGGER_KEY);

        let parsed_idle = parse_prometheus_text(body_idle).expect("parse idle");
        let out_idle = tracker.observe(&parsed_idle);
        assert!(out_idle.warming_up);
        assert!(!out_idle.just_transitioned);

        let parsed_warmup = parse_prometheus_text(body_warmup).expect("parse warmup");
        let out_warmup = tracker.observe(&parsed_warmup);
        // After the warmup request lands, the tracker baselines and emits
        // warming_up=false, just_transitioned=true. The adjusted histogram
        // contains (current - baseline) where current == baseline → all zeros.
        assert!(!out_warmup.warming_up);
        assert!(out_warmup.just_transitioned);

        let parsed_steady = parse_prometheus_text(body_steady).expect("parse steady");
        let out_steady = tracker.observe(&parsed_steady);
        assert!(!out_steady.warming_up);
        assert!(!out_steady.just_transitioned);

        let buckets = out_steady
            .adjusted
            .histograms
            .get("vllm_time_to_first_token_seconds")
            .expect("histogram");
        let p50 = percentile(buckets, 0.5).expect("p50") * 1000.0;
        let p95 = percentile(buckets, 0.95).expect("p95") * 1000.0;
        // All 100 post-baseline observations live in [0, 0.05]; p50 and p95
        // must land inside that bucket. Without the tracker the slow warmup
        // observation would push p99 (and the +Inf overflow) into the tail.
        assert!(p50 <= 50.0, "p50 {p50} should be in fast bucket (<=50ms)");
        assert!(p95 <= 50.0, "p95 {p95} should be in fast bucket (<=50ms)");
        // Sum and count deltas: 1.0 sum across 100 fast observations.
        let sum = out_steady
            .adjusted
            .counters
            .get("vllm_time_to_first_token_seconds_sum")
            .copied()
            .expect("sum delta");
        let count = out_steady
            .adjusted
            .counters
            .get("vllm_time_to_first_token_seconds_count")
            .copied()
            .expect("count delta");
        assert!((sum - 1.0).abs() < 1e-9, "sum delta {sum}");
        assert!((count - 100.0).abs() < 1e-9, "count delta {count}");
    }

    /// The frontend recomputes goodput from histogram buckets the backend
    /// ships in `EngineMetrics`. This test runs `wire_buckets`, which
    /// `get_metrics()` ships them through, against a representative
    /// `/metrics` body and asserts the wire-shape contract: cumulative counts
    /// preserved, +Inf replaced with `f64::MAX`, and the buckets serialize to
    /// plain JSON.
    #[test]
    fn ttft_buckets_replace_infinity_with_f64_max() {
        let body = "\
# HELP vllm:time_to_first_token_seconds TTFT histogram.
# TYPE vllm:time_to_first_token_seconds histogram
vllm:time_to_first_token_seconds_bucket{le=\"0.05\"} 50
vllm:time_to_first_token_seconds_bucket{le=\"0.1\"} 80
vllm:time_to_first_token_seconds_bucket{le=\"+Inf\"} 100
vllm:time_to_first_token_seconds_sum 12.0
vllm:time_to_first_token_seconds_count 100.0
";
        let parsed = parse_prometheus_text(body).expect("parse");
        let buckets = wire_buckets(&parsed, "vllm_time_to_first_token_seconds").expect("histogram");
        assert_eq!(buckets.len(), 3);
        assert!((buckets[0].le_seconds - 0.05).abs() < 1e-9);
        assert!((buckets[0].cumulative_count - 50.0).abs() < 1e-9);
        assert!((buckets[1].le_seconds - 0.1).abs() < 1e-9);
        assert_eq!(buckets[2].le_seconds, f64::MAX);
        assert!((buckets[2].cumulative_count - 100.0).abs() < 1e-9);

        // The wire format must be valid JSON — non-finite floats would break
        // `JSON.parse` on the frontend.
        let json = serde_json::to_string(&buckets).expect("serialize");
        assert!(
            !json.contains("inf") && !json.contains("Inf") && !json.contains("NaN"),
            "wire format must not contain non-finite tokens: {json}"
        );
    }

    /// Empty histograms produce `None`, matching the warmup/no-traffic case
    /// where the frontend should fall back to the backend `*_goodput_pct`.
    #[test]
    fn ttft_buckets_none_when_metric_absent() {
        let body = "# Empty body, no histograms.\n";
        let parsed = parse_prometheus_text(body).expect("parse");
        assert!(wire_buckets(&parsed, "vllm_time_to_first_token_seconds").is_none());
    }

    /// Cumulative token counters flow from the parser to the new
    /// `total_prompt_tokens` / `total_generation_tokens` fields. The adapter
    /// reads them off `parsed.counters` and casts f64 -> u64, so assert the
    /// same boundary the struct fields are populated from.
    #[test]
    fn token_totals_roundtrip_from_metrics_body() {
        let body = "\
# HELP vllm:prompt_tokens_total Prompt tokens counter.
# TYPE vllm:prompt_tokens_total counter
vllm:prompt_tokens_total 123456.0
# HELP vllm:generation_tokens_total Generation tokens counter.
# TYPE vllm:generation_tokens_total counter
vllm:generation_tokens_total 7890123.0
";
        let parsed = parse_prometheus_text(body).expect("parse");
        let prompt = parsed
            .counters
            .get("vllm_prompt_tokens_total")
            .copied()
            .map(|v| v as u64);
        let gen = parsed
            .counters
            .get("vllm_generation_tokens_total")
            .copied()
            .map(|v| v as u64);
        assert_eq!(prompt, Some(123_456));
        assert_eq!(gen, Some(7_890_123));
    }

    /// `prefix_cache_queries_total` is a pass-through lifetime counter read
    /// off `parsed.counters` and cast f64 -> u64 (same boundary as the token
    /// totals, ungated by warmup). Assert it propagates from the metrics body.
    #[test]
    fn prefix_cache_queries_roundtrip_from_metrics_body() {
        let body = "\
# HELP vllm:prefix_cache_queries Prefix cache queries counter.
# TYPE vllm:prefix_cache_queries counter
vllm:prefix_cache_queries_total 654321.0
# HELP vllm:prefix_cache_hits Prefix cache hits counter.
# TYPE vllm:prefix_cache_hits counter
vllm:prefix_cache_hits_total 123456.0
";
        let parsed = parse_prometheus_text(body).expect("parse");
        let queries = parsed
            .counters
            .get("vllm_prefix_cache_queries_total")
            .copied()
            .map(|v| v as u64);
        assert_eq!(queries, Some(654_321));
    }

    /// vLLM's prometheus_client appends `_total` to the speculative-decoding
    /// counters. Assert the parser captures them under the normalized
    /// `vllm_spec_decode_*_total` keys the adapter reads.
    #[test]
    fn spec_decode_counters_roundtrip_from_metrics_body() {
        let body = "\
# HELP vllm:spec_decode_num_draft_tokens Cumulative drafted tokens.
# TYPE vllm:spec_decode_num_draft_tokens counter
vllm:spec_decode_num_draft_tokens_total 1000.0
# HELP vllm:spec_decode_num_accepted_tokens Cumulative accepted tokens.
# TYPE vllm:spec_decode_num_accepted_tokens counter
vllm:spec_decode_num_accepted_tokens_total 720.0
# HELP vllm:spec_decode_num_drafts Cumulative draft attempts.
# TYPE vllm:spec_decode_num_drafts counter
vllm:spec_decode_num_drafts_total 240.0
";
        let parsed = parse_prometheus_text(body).expect("parse");
        let draft = parsed
            .counters
            .get("vllm_spec_decode_num_draft_tokens_total")
            .copied();
        let accepted = parsed
            .counters
            .get("vllm_spec_decode_num_accepted_tokens_total")
            .copied();
        let drafts = parsed
            .counters
            .get("vllm_spec_decode_num_drafts_total")
            .copied();
        assert_eq!(draft, Some(1000.0));
        assert_eq!(accepted, Some(720.0));
        assert_eq!(drafts, Some(240.0));
        // Derived signals computed from the parsed counters.
        assert_eq!(spec_acceptance_rate(accepted, draft), Some(72.0));
        assert_eq!(spec_mean_acceptance_length(accepted, drafts), Some(3.0));
    }

    /// A metrics body without any speculative-decoding lines must leave every
    /// spec-decode counter absent, so the adapter reports `None` and the
    /// frontend hides the section.
    #[test]
    fn spec_decode_counters_absent_when_not_configured() {
        let body = "\
# HELP vllm:generation_tokens Generated tokens.
# TYPE vllm:generation_tokens counter
vllm:generation_tokens_total 42.0
";
        let parsed = parse_prometheus_text(body).expect("parse");
        assert!(!parsed
            .counters
            .contains_key("vllm_spec_decode_num_draft_tokens_total"));
        assert!(!parsed
            .counters
            .contains_key("vllm_spec_decode_num_draft_tokens"));
    }

    /// Under data parallelism vLLM labels each engine core's series
    /// (`engine="0"`, `engine="1"`). The snapshot is the whole engine: request
    /// counts and token counters sum across the cores, and KV usage — each
    /// core's ratio of its own pool — is their mean. Before the parser
    /// combined label series, whichever core's line came last stood in for
    /// all of them.
    #[tokio::test]
    async fn data_parallel_engine_cores_combine_into_one_engine() {
        use super::super::test_server::TestServer;
        let body = "\
# TYPE vllm:num_requests_running gauge
vllm:num_requests_running{engine=\"0\",model_name=\"m\"} 8.0
vllm:num_requests_running{engine=\"1\",model_name=\"m\"} 7.0
# TYPE vllm:num_requests_waiting gauge
vllm:num_requests_waiting{engine=\"0\",model_name=\"m\"} 2.0
vllm:num_requests_waiting{engine=\"1\",model_name=\"m\"} 1.0
# TYPE vllm:kv_cache_usage_perc gauge
vllm:kv_cache_usage_perc{engine=\"0\",model_name=\"m\"} 0.5
vllm:kv_cache_usage_perc{engine=\"1\",model_name=\"m\"} 0.3
# TYPE vllm:prompt_tokens counter
vllm:prompt_tokens_total{engine=\"0\",model_name=\"m\"} 100.0
vllm:prompt_tokens_total{engine=\"1\",model_name=\"m\"} 50.0
# TYPE vllm:time_to_first_token_seconds histogram
vllm:time_to_first_token_seconds_bucket{engine=\"0\",le=\"+Inf\",model_name=\"m\"} 4
vllm:time_to_first_token_seconds_bucket{engine=\"1\",le=\"+Inf\",model_name=\"m\"} 6
vllm:time_to_first_token_seconds_sum{engine=\"0\",model_name=\"m\"} 1.0
vllm:time_to_first_token_seconds_sum{engine=\"1\",model_name=\"m\"} 2.0
vllm:time_to_first_token_seconds_count{engine=\"0\",model_name=\"m\"} 4
vllm:time_to_first_token_seconds_count{engine=\"1\",model_name=\"m\"} 6
";
        let server = TestServer::start(move |_| (200, body.to_string())).await;
        let adapter = VllmAdapter::new(reqwest::Client::new(), server.url.clone(), None, None);

        let m = adapter.get_metrics().await.expect("metrics");
        assert_eq!(m.active_requests, Some(15));
        assert_eq!(m.queued_requests, Some(3));
        let kv = m.kv_cache_percent.expect("kv");
        assert!((kv - 40.0).abs() < 1e-9, "mean of 50% and 30%, got {kv}");
        assert_eq!(m.total_prompt_tokens, Some(150));
        assert_eq!(m.total_requests, Some(10));

        // One scrape, unauthenticated: no key was configured.
        let asked = server.requests();
        assert_eq!(asked.len(), 1);
        assert_eq!(asked[0].path, "/metrics");
        assert_eq!(asked[0].authorization, None);
    }
    #[tokio::test]
    async fn generated_token_totals_use_the_completed_warmup_baseline() {
        use super::super::test_server::TestServer;
        use std::sync::{Arc, Mutex as StdMutex};

        let counters = Arc::new(StdMutex::new((10, 1_000)));
        let served = counters.clone();
        let server = TestServer::start(move |_| {
            let (requests, tokens) = *served.lock().unwrap();
            (
                200,
                format!(
                    "# TYPE vllm:generation_tokens_total counter\n\
                 vllm:generation_tokens_total {tokens}\n\
                 # TYPE vllm:time_to_first_token_seconds histogram\n\
                 vllm:time_to_first_token_seconds_bucket{{le=\"+Inf\"}} {requests}\n\
                 vllm:time_to_first_token_seconds_sum {requests}\n\
                 vllm:time_to_first_token_seconds_count {requests}\n"
                ),
            )
        })
        .await;
        let adapter = VllmAdapter::new(reqwest::Client::new(), server.url.clone(), None, None);
        *adapter.warmup.lock().await = WarmupTracker::new(1, WARMUP_TRIGGER_KEY);

        let warming = adapter.get_metrics().await.expect("warming metrics");
        assert!(warming.warming_up);
        assert_eq!(warming.total_generation_tokens, Some(1_000));

        *counters.lock().unwrap() = (11, 1_100);
        let baseline = adapter.get_metrics().await.expect("baseline metrics");
        assert!(!baseline.warming_up);
        assert_eq!(baseline.total_generation_tokens, Some(0));

        *counters.lock().unwrap() = (13, 1_160);
        let steady = adapter.get_metrics().await.expect("steady metrics");
        assert!(!steady.warming_up);
        assert_eq!(steady.total_generation_tokens, Some(60));
        assert_eq!(steady.total_requests, Some(13));
    }
}
