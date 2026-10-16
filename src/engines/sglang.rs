use super::common::{warmup_skip_from_env, CounterRate, EngineHttp, GaugeMean};
use super::histogram::{goodput_pct, mean_ms, percentiles_ms, wire_buckets};
use super::model_info::ModelResolver;
use super::prometheus::{parse_prometheus_text, GaugeSeries, ParsedMetrics};
use super::warmup::WarmupTracker;
use super::{
    EngineAdapter, EngineMetrics, EngineStatus, EngineType, MetricGroup, ModelResolution,
    E2E_SLO_MS, ITL_SLO_MS, TTFT_SLO_MS,
};
use async_trait::async_trait;
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

/// The launch flag that turns SGLang's `/metrics` endpoint on. Without it the
/// server answers everything else but serves no metrics — the state the
/// dashboard names on the wire (`metrics_off`) instead of reporting every
/// group as "not reported", which would describe the wrong fact.
pub const METRICS_LAUNCH_FLAG: &str = "--enable-metrics";

/// The request counter warmup progress is measured on: every SGLang request
/// adds one observation to the time-to-first-token histogram, as on vLLM.
const WARMUP_TRIGGER_KEY: &str = "sglang_time_to_first_token_seconds_count";

/// How long after a failed `/server_info` lookup the adapter asks again.
const DRAFTER_LOOKUP_RETRY: Duration = Duration::from_secs(60);

/// What the adapter has learned of the server's drafter, and when it last
/// asked.
#[derive(Debug, Default)]
struct DrafterLookup {
    /// Whether a drafter is configured; `None` until `/server_info` said.
    configured: Option<bool>,
    last_attempt: Option<Instant>,
}

pub struct SglangAdapter {
    /// The endpoint, and the bearer token of a launch with `--api-key`.
    /// SGLang gates `/v1/models` (and everything except `/health`, `/ready`,
    /// `/metrics`) with it; the open routes ignore a presented token
    /// harmlessly.
    http: EngineHttp,
    /// Model identity: `/v1/models`, the command-line hint
    /// (`--model-path` / `--served-model-name`), HF enrichment — shared with
    /// the vLLM adapter, since SGLang's `/v1/models` answers identically.
    model: ModelResolver,
    /// Generation tokens/s and its running average.
    gen_rate: Mutex<CounterRate>,
    /// Running average of the live `gen_throughput` gauge — the honest decode
    /// mean, since the counter's mean is polluted by completion-time spikes.
    gen_gauge_mean: Mutex<GaugeMean>,
    /// Prompt tokens/s and its running average.
    prompt_rate: Mutex<CounterRate>,
    warmup: Mutex<WarmupTracker>,
    /// Whether the server runs a drafter, read once from `/server_info` —
    /// the only place an idle SGLang drafter shows: its acceptance gauges
    /// read `0` until it verifies a draft, exactly like a server with none.
    drafter: Mutex<DrafterLookup>,
    /// Latched by each metrics scrape: true when `/metrics` answered 404 (the
    /// launch without `--enable-metrics`, which never mounts the route),
    /// false when it answered at all. A scrape that could not reach the
    /// server, or met a transient error, leaves the flag untouched — an
    /// unreachable engine is "offline", not "metrics off".
    metrics_off: AtomicBool,
}

impl SglangAdapter {
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
            gen_gauge_mean: Mutex::default(),
            prompt_rate: Mutex::default(),
            warmup: Mutex::new(WarmupTracker::new(
                warmup_skip_from_env(),
                WARMUP_TRIGGER_KEY,
            )),
            drafter: Mutex::default(),
            metrics_off: AtomicBool::new(false),
        }
    }

    /// Whether the server is configured with a drafter, `None` while that is
    /// unknown. `/server_info` gathers every scheduler's internal state, so
    /// it is asked once rather than every poll — again a minute after a
    /// failed attempt — and the launch flags it reports do not change while
    /// the server runs.
    async fn drafter_configured(&self) -> Option<bool> {
        let mut lookup = self.drafter.lock().await;
        if lookup.configured.is_some() {
            return lookup.configured;
        }
        if lookup
            .last_attempt
            .is_some_and(|at| at.elapsed() < DRAFTER_LOOKUP_RETRY)
        {
            return None;
        }
        lookup.last_attempt = Some(Instant::now());
        let response = self.http.get("/server_info").send().await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        let info = response.json::<serde_json::Value>().await.ok()?;
        lookup.configured = drafter_in_server_info(&info);
        lookup.configured
    }
}

/// Whether `/server_info` names a speculative algorithm — `EAGLE`, `NEXTN`,
/// `NGRAM`, … — or none (`null`). `None` when the answer carries no
/// `speculative_algorithm` field at all.
fn drafter_in_server_info(info: &serde_json::Value) -> Option<bool> {
    match info.get("speculative_algorithm")? {
        serde_json::Value::Null => Some(false),
        serde_json::Value::String(name) => {
            Some(!(name.is_empty() || name.eq_ignore_ascii_case("none")))
        }
        _ => None,
    }
}

/// Parse an SGLang scrape with the shared parser, which sums counters and
/// histograms across the label series SGLang splits them into
/// (`is_streaming`, `cache_source`, and one series per rank), and keep each
/// gauge's series for `engine_metrics` to combine per what it measures.
///
/// One SGLang-specific step: under `--enable-priority-scheduling` the
/// scheduler logs each queue gauge twice, its total under `priority=""` and a
/// breakdown under `priority="<n>"` beside it. Only the totals partition the
/// engine, so the breakdown series are dropped before anything sums them.
fn parse_sglang(body: &str) -> Option<ParsedMetrics> {
    let mut parsed = parse_prometheus_text(body)?;
    for series in parsed.gauges.values_mut() {
        series.retain(|g| g.labels.get("priority").is_none_or(|p| p.is_empty()));
    }
    Some(parsed)
}

/// Whether a parsed scrape carries any SGLang series. A server started with
/// `--enable-metrics` whose collectors have not logged yet answers with none
/// — nothing has been written to its multiprocess registry — and any other
/// sample (a process collector, a proxy's own metrics) is not the engine's.
fn has_sglang_series(parsed: &ParsedMetrics) -> bool {
    let sglang = |name: &String| name.starts_with("sglang_");
    parsed.counters.keys().any(sglang)
        || parsed.gauges.keys().any(sglang)
        || parsed.histograms.keys().any(sglang)
}

/// SGLang's acceptance gauges, combined across the ranks that report them.
///
/// Each data-parallel rank logs its own `spec_accept_length` and
/// `spec_accept_rate`, both over its last decode-log interval, and logs them
/// as `0` until it has verified a draft — as a server without a drafter does
/// for good. A rank that has verified one reports a length of at least 1, so
/// the engine-wide figures are the means over the ranks whose length is
/// positive, each rank's rate read off the series with the same labels.
/// Returns `(length, rate)`; `None` while no rank has verified a draft.
fn spec_acceptance(parsed: &ParsedMetrics) -> Option<(f64, Option<f64>)> {
    let ranks: Vec<&GaugeSeries> = parsed
        .gauges
        .get("sglang_spec_accept_length")
        .into_iter()
        .flatten()
        .filter(|g| g.value > 0.0)
        .collect();
    if ranks.is_empty() {
        return None;
    }
    let length = ranks.iter().map(|g| g.value).sum::<f64>() / ranks.len() as f64;
    let rates: Vec<f64> = parsed
        .gauges
        .get("sglang_spec_accept_rate")
        .into_iter()
        .flatten()
        .filter(|g| ranks.iter().any(|r| r.labels == g.labels))
        .map(|g| g.value)
        .collect();
    let rate = (!rates.is_empty()).then(|| rates.iter().sum::<f64>() / rates.len() as f64);
    Some((length, rate))
}

#[async_trait]
impl EngineAdapter for SglangAdapter {
    fn engine_type(&self) -> EngineType {
        EngineType::Sglang
    }

    fn endpoint(&self) -> &str {
        self.http.endpoint()
    }

    /// SGLang reports every metric group but four, each left out because no
    /// series in its scrape measures that quantity, and a stand-in would be a
    /// different one (ADR-0004):
    /// - `TpotMean` and `TpotPercentiles`: time per output token has no
    ///   histogram of its own in any probed version, and the per-request
    ///   decode throughput is derived from it.
    /// - `BatchSize`: there is no per-iteration token counter to read tokens
    ///   per engine step off.
    /// - `Preemptions`: `num_retracted_reqs` is a gauge of the requests
    ///   retracted now, not the lifetime preemption counter, and there is no
    ///   swap counter.
    fn metric_groups(&self) -> BTreeSet<MetricGroup> {
        let mut groups = MetricGroup::all();
        for group in [
            MetricGroup::TpotMean,
            MetricGroup::TpotPercentiles,
            MetricGroup::BatchSize,
            MetricGroup::Preemptions,
        ] {
            groups.remove(&group);
        }
        groups
    }

    fn metrics_launch_flag(&self) -> Option<&'static str> {
        Some(METRICS_LAUNCH_FLAG)
    }

    fn metrics_off(&self) -> bool {
        self.metrics_off.load(Ordering::Relaxed)
    }

    async fn health_check(&self) -> EngineStatus {
        // `/ready` is SGLang's cheap readiness probe. `/health` is not: it
        // runs a one-token generation through the scheduler, so it stalls for
        // as long as the queue ahead of it — a live but busy engine would
        // read as failing health under exactly the load that matters.
        // `/ready` arrived in v0.5.20; before it, `/model_info` — also
        // answered by the tokenizer manager, never the scheduler — stands in.
        self.http.health_or("/ready", "/model_info").await
    }

    async fn get_model_info(&self) -> ModelResolution {
        self.model.resolve(&self.http).await
    }

    async fn get_metrics(&self) -> Option<EngineMetrics> {
        let resp = self.http.get("/metrics").send().await.ok()?;
        let status = resp.status();
        let body = resp.text().await.ok()?;
        // The latch decision is `metrics_off_signal`, pure below so the ways
        // a scrape can answer are testable without a server. A failure to
        // reach the server never gets here — the `send()` above stops it —
        // because offline is not the same as off.
        if let Some(off) = metrics_off_signal(status.is_success(), status.as_u16()) {
            self.metrics_off.store(off, Ordering::Relaxed);
        }
        // Metrics on but no SGLang series yet is "no data yet": the engine
        // reports nothing this tick, and its panels say it has no metrics yet.
        let raw = status
            .is_success()
            .then(|| parse_sglang(&body))
            .flatten()
            .filter(has_sglang_series)?;
        let warmup_out = {
            let mut tracker = self.warmup.lock().await;
            tracker.observe(&raw)
        };
        if warmup_out.just_transitioned {
            self.gen_rate.lock().await.reset();
            self.gen_gauge_mean.lock().await.reset();
            self.prompt_rate.lock().await.reset();
            tracing::info!(
                endpoint = %self.http.endpoint(),
                "warmup complete — baseline captured, steady-state metrics now reported"
            );
        }
        let parsed = &warmup_out.adjusted;
        let warming_up = warmup_out.warming_up;

        let counter = |name: &str| parsed.counters.get(name).copied();
        let current_gen = counter("sglang_generation_tokens_total");
        let current_prompt = counter("sglang_prompt_tokens_total");
        let now = Instant::now();
        // SGLang's `generation_tokens_total` counter only advances at request
        // completion, so a delta between polls reads 0 for the whole of an
        // in-flight request and spikes once at the end. `gen_throughput` is the
        // scheduler's live decode-rate gauge — one series per data-parallel
        // rank (attention-TP rank 0), summed to the engine, exactly like
        // `num_running_reqs` — so it is the honest live tokens/sec. The counter
        // delta stays as the fallback for a release that has no such gauge.
        let live_decode = parsed.gauge_sum("sglang_gen_throughput");
        let (gen_delta_tps, gen_delta_mean) =
            self.gen_rate.lock().await.observe(current_gen, now);
        let tokens_per_sec = live_decode_tps(live_decode, gen_delta_tps);
        // The decode mean comes from the live gauge when it is present. The
        // counter's running mean is the mean of completion-time deltas — a
        // per-request token count, not a throughput — so it is only the
        // fallback for a release with no `gen_throughput` gauge.
        let avg_tokens_per_sec = match live_decode {
            Some(g) => self.gen_gauge_mean.lock().await.observe(Some(g)),
            None => gen_delta_mean,
        };
        let (prompt_tokens_per_sec, avg_prompt_tokens_per_sec) =
            self.prompt_rate.lock().await.observe(current_prompt, now);
        let drafter = self.drafter_configured().await;

        Some(engine_metrics(
            parsed,
            &raw,
            RateInputs {
                tokens_per_sec,
                prompt_tokens_per_sec,
                avg_tokens_per_sec,
                avg_prompt_tokens_per_sec,
            },
            warming_up,
            drafter,
        ))
    }
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

/// The live decode rate. SGLang's `gen_throughput` gauge is the scheduler's
/// real-time tokens/sec; the `generation_tokens_total` counter only advances at
/// request completion, so a delta between polls reads 0 for the whole of an
/// in-flight request and spikes once at the end. Prefer the gauge; fall back to
/// the counter delta for a release that exposes no such gauge.
fn live_decode_tps(gauge: Option<f64>, counter_delta: Option<f64>) -> Option<f64> {
    gauge.or(counter_delta)
}

/// The metrics-off latch decision for one *answered* scrape.
///
/// SGLang mounts `/metrics` only when launched with `--enable-metrics`
/// (`add_prometheus_middleware` in `http_server.py`), and its API-key
/// middleware always lets `/metrics` through, so the route's existence is
/// the signal:
///
/// - answered OK: the route is mounted, metrics are on (`Some(false)`) —
///   whether or not any series has been logged yet;
/// - 404: the launch without the flag, which never mounts the route — off
///   (`Some(true)`);
/// - any other answered failure: transient, and a transient is not "off" —
///   `None` leaves the previous reading alone.
fn metrics_off_signal(success: bool, code: u16) -> Option<bool> {
    match (success, code) {
        (true, _) => Some(false),
        (false, 404) => Some(true),
        (false, _) => None,
    }
}

/// Map one parsed SGLang scrape onto the engine snapshot.
/// Pure: the fetch, the metrics-off latch, the warmup tracker and the rate
/// state stay in `get_metrics`; everything here reads the scrape and nothing
/// else. `parsed` is the scrape after the warmup baseline is subtracted,
/// `raw` the same scrape as read, for the lifetime figures that must not
/// restart at the baseline. `warming_up` blanks the delta-derived fields
/// exactly as the vLLM adapter blanks them. `drafter` is whether the server
/// is configured with one, `None` while unknown.
fn engine_metrics(
    parsed: &ParsedMetrics,
    raw: &ParsedMetrics,
    rates: RateInputs,
    warming_up: bool,
    drafter: Option<bool>,
) -> EngineMetrics {
    let counter = |name: &str| parsed.counters.get(name).copied();

    // Each data-parallel rank logs its own series of the scheduler gauges
    // (one per rank, from its attention-TP rank 0). The request counts
    // partition the engine's work, so they sum.
    let active_requests = parsed
        .gauge_sum("sglang_num_running_reqs")
        .map(|v| v as u64);
    let queued_requests = parsed.gauge_sum("sglang_num_queue_reqs").map(|v| v as u64);
    // `full_token_usage` is the fraction of the token pool in use (0-1),
    // SGLang's counterpart of vLLM's kv_cache_usage_perc. Verified live
    // against v0.5.2x on a GB10: 0.381 at a 454k-token pool under load.
    // Releases before the hybrid full/SWA split report only `token_usage`,
    // the same fraction for a model with one pool. Each rank's usage is a
    // ratio of its own pool, and data-parallel ranks size their pools alike,
    // so the engine-wide figure is the mean.
    let kv_cache_percent = parsed
        .gauge_mean("sglang_full_token_usage")
        .or_else(|| parsed.gauge_mean("sglang_token_usage"))
        .map(|v| v * 100.0);

    let ttft_ms = mean_ms(
        counter("sglang_time_to_first_token_seconds_sum"),
        counter("sglang_time_to_first_token_seconds_count"),
    );
    let e2e_latency_ms = mean_ms(
        counter("sglang_e2e_request_latency_seconds_sum"),
        counter("sglang_e2e_request_latency_seconds_count"),
    );
    let queue_time_ms = mean_ms(
        counter("sglang_queue_time_seconds_sum"),
        counter("sglang_queue_time_seconds_count"),
    );
    let inter_token_latency_ms = mean_ms(
        counter("sglang_inter_token_latency_seconds_sum"),
        counter("sglang_inter_token_latency_seconds_count"),
    );

    // Request count: TTFT observations == requests that reached first
    // token. The same pass-through lifetime display the vLLM adapter
    // derives from the same quantity; read from `raw` so it does not drop
    // to zero at the warmup baseline.
    let total_requests = raw
        .counters
        .get("sglang_time_to_first_token_seconds_count")
        .map(|&v| v as u64);

    // Per-request prefill throughput: prompt tokens per second of TTFT.
    // Same shape as the vLLM adapter's approximation.
    let per_request_prompt_tps = match (
        counter("sglang_prompt_tokens_total"),
        counter("sglang_time_to_first_token_seconds_sum"),
    ) {
        (Some(p), Some(t)) if t > 0.0 => Some(p / t),
        _ => None,
    };

    // Prefix cache: SGLang counts cached tokens and total prompt tokens
    // (vLLM counts hits and queries). The ratio is the same quantity —
    // fraction of prompt tokens served from the radix cache.
    let prefix_cache_hit_rate = match (
        counter("sglang_cached_tokens_total"),
        counter("sglang_prompt_tokens_total"),
    ) {
        (Some(h), Some(q)) if q > 0.0 => Some((h / q) * 100.0),
        _ => None,
    };
    let prefix_cache_queries_total = counter("sglang_prompt_tokens_total").map(|v| v as u64);

    // Speculative decoding. SGLang exposes acceptance as gauges
    // (`spec_accept_rate` is the accepted/drafted ratio of recent verify
    // rounds, `spec_accept_length` the mean tokens a round emits) and has
    // no draft/accept token counters — so the cumulative fields and the
    // delta-derived live rate stay `None` and the acceptance figures come
    // from the gauges.
    //
    // A server without a drafter logs both gauges as `0` rather than
    // omitting them, so a configured drafter is judged by a nonzero
    // accept length: zero reads identically to "nothing accepted yet",
    // and a panel permanently showing 0% would be the worse of the two
    // readings. Nonzero length is the same configured signal the
    // frontend reads off vLLM's optional counters.
    //
    // The two engines count the length differently. SGLang's
    // `spec_accept_length` is generated tokens per verify round
    // (`num_correct_drafts + batch_size` over the rounds, in
    // `batch_result_processor.py`): the accepted drafts plus the one token
    // the target model emits itself every round, the bonus. The field is
    // vLLM's accepted/drafts — accepted draft tokens per draft, the tile's
    // "tok/draft" — which leaves the bonus out. Subtracting it reports the
    // same quantity (ADR-0004), instead of a figure one higher. (UNO, which
    // emits two non-draft tokens a round, would still read one high.)
    let acceptance = spec_acceptance(parsed);
    let spec_decode_mean_acceptance_length = acceptance.map(|(length, _)| (length - 1.0).max(0.0));
    let spec_decode_acceptance_rate = acceptance.and_then(|(_, rate)| rate).map(|v| v * 100.0);

    // Draft rounds: SGLang counts each request's verify rounds and adds
    // them to `spec_verify_calls_total` when the request finishes — vLLM's
    // `num_drafts`, one per request per draft. The counter appears only once
    // a request with a verified draft has finished, so a drafter that has not
    // drafted yet shows nowhere in the scrape; for a server that says it
    // runs one, that absence is a count of zero — the same "configured,
    // nothing drafted yet" a vLLM drafter reports with its counters at zero.
    // Read absolute, as vLLM's spec counters are.
    let spec_decode_drafts_total = match (
        raw.counters.get("sglang_spec_verify_calls_total").copied(),
        drafter,
    ) {
        (_, Some(false)) => None,
        (Some(rounds), _) => Some(rounds.max(0.0) as u64),
        (None, Some(true)) => Some(0),
        (None, None) => None,
    };

    // Percentiles, goodput and shipped buckets from the request-level
    // histograms, through the same helpers as the vLLM adapter — SGLang's
    // buckets are plain cumulative histograms in seconds.
    let ttft_percentiles = percentiles_ms(parsed, "sglang_time_to_first_token_seconds");
    let itl_percentiles = percentiles_ms(parsed, "sglang_inter_token_latency_seconds");
    let e2e_percentiles = percentiles_ms(parsed, "sglang_e2e_request_latency_seconds");
    let ttft_goodput_pct = goodput_pct(parsed, "sglang_time_to_first_token_seconds", TTFT_SLO_MS);
    let itl_goodput_pct = goodput_pct(parsed, "sglang_inter_token_latency_seconds", ITL_SLO_MS);
    let e2e_goodput_pct = goodput_pct(parsed, "sglang_e2e_request_latency_seconds", E2E_SLO_MS);
    let ttft_buckets = wire_buckets(parsed, "sglang_time_to_first_token_seconds");
    let itl_buckets = wire_buckets(parsed, "sglang_inter_token_latency_seconds");
    let e2e_buckets = wire_buckets(parsed, "sglang_e2e_request_latency_seconds");

    // Fields SGLang does not report at all (ADR-0004 — absent series are
    // not reported, never proxied by a stand-in): TPOT has no histogram
    // of its own in any probed version, `num_retracted_reqs` is a gauge
    // of how many requests are retracted now rather than the lifetime
    // preemption counter the Preemptions group names, and there is no
    // per-iteration token counter behind avg_batch_size. Their groups are
    // the ones `metric_groups` leaves out.
    let blank = warming_up;
    EngineMetrics {
        tokens_per_sec: if blank { None } else { rates.tokens_per_sec },
        avg_tokens_per_sec: if blank {
            None
        } else {
            rates.avg_tokens_per_sec
        },
        per_request_tps: None,
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
        swapped_requests: None,
        prefix_cache_hit_rate,
        queue_time_ms: if blank { None } else { queue_time_ms },
        inter_token_latency_ms: if blank { None } else { inter_token_latency_ms },
        preemptions_total: None,
        total_prompt_tokens: counter("sglang_prompt_tokens_total").map(|v| v as u64),
        total_generation_tokens: counter("sglang_generation_tokens_total").map(|v| v as u64),
        prefix_cache_queries_total,
        avg_batch_size: None,
        ttft_percentiles: if blank { None } else { ttft_percentiles },
        itl_percentiles: if blank { None } else { itl_percentiles },
        e2e_percentiles: if blank { None } else { e2e_percentiles },
        ttft_goodput_pct: if blank { None } else { ttft_goodput_pct },
        itl_goodput_pct: if blank { None } else { itl_goodput_pct },
        e2e_goodput_pct: if blank { None } else { e2e_goodput_pct },
        ttft_buckets: if blank { None } else { ttft_buckets },
        itl_buckets: if blank { None } else { itl_buckets },
        e2e_buckets: if blank { None } else { e2e_buckets },
        tpot_ms: None,
        tpot_percentiles: None,
        tpot_goodput_pct: None,
        tpot_buckets: None,
        spec_decode_draft_tokens_total: None,
        spec_decode_accepted_tokens_total: None,
        spec_decode_drafts_total,
        spec_decode_acceptance_rate,
        spec_decode_acceptance_rate_live: None,
        spec_decode_mean_acceptance_length,
        warming_up,
    }
}

#[cfg(test)]
mod tests {
    use super::super::histogram::percentile;
    use super::*;

    /// A scrape of a real SGLang v0.5.2x (qwen4-main nightly) on a GB10,
    /// captured live with `--enable-metrics` and EAGLE/NEXTN speculative
    /// decoding configured. Trimming kept whole metric blocks; every label
    /// series is verbatim, including the `is_streaming` splits the parser
    /// sums.
    const REAL: &str = include_str!("fixtures/sglang_metrics.txt");

    fn parsed_real() -> ParsedMetrics {
        parse_sglang(REAL).expect("fixture parses")
    }

    fn assert_close(got: Option<f64>, want: f64) {
        let got = got.expect("a value");
        assert!((got - want).abs() < 1e-9, "got {got}, want {want}");
    }

    /// `engine_metrics` for a scrape no baseline has been subtracted from —
    /// one that is its own raw reading.
    fn map_unbaselined(parsed: &ParsedMetrics, rates: RateInputs, warming: bool) -> EngineMetrics {
        engine_metrics(parsed, parsed, rates, warming, None)
    }

    #[test]
    fn real_scrape_series_arrive_under_underscored_names() {
        let p = parsed_real();
        assert_eq!(p.gauge_sum("sglang_num_running_reqs"), Some(1.0));
        assert_eq!(
            p.gauge_sum("sglang_full_token_usage"),
            Some(0.3813953488372093)
        );
        assert_eq!(p.gauge_sum("sglang_spec_accept_length"), Some(2.8));
    }

    /// A counter split across streaming and non-streaming label series is
    /// the sum of both, never whichever line happened to come last.
    #[test]
    fn label_split_counters_are_summed_not_picked() {
        let p = parsed_real();
        // Fixture: generation 28264.0 across its two label series. The exact
        // split is whatever the capture says; the sum must equal both lines.
        let mut want = 0.0;
        for line in REAL.lines() {
            if let Some(rest) = line.strip_prefix("sglang:generation_tokens_total{") {
                if let Some(space) = line.rfind(' ') {
                    want += line[space + 1..].parse::<f64>().expect("fixture value");
                    let _ = rest;
                }
            }
        }
        assert!(want > 0.0, "fixture must contain the series");
        let got = p.counters.get("sglang_generation_tokens_total").copied();
        assert_eq!(got, Some(want));
    }

    /// Histogram buckets split by label must merge per `le` with summed
    /// counts, or percentiles interpolate against half the observations.
    #[test]
    fn label_split_histogram_buckets_merge_per_le() {
        let p = parsed_real();
        let ttft = p
            .histograms
            .get("sglang_time_to_first_token_seconds")
            .expect("ttft histogram");
        // +Inf bucket == sum of both label series' counts (104 + 104 here;
        // read from the fixture, not hardcoded — this asserts the merge did
        // the arithmetic, and the fixture's shape).
        let mut want = 0.0;
        for line in REAL.lines() {
            if line.starts_with("sglang:time_to_first_token_seconds_count{") {
                let space = line.rfind(' ').expect("sample line");
                want += line[space + 1..].parse::<f64>().expect("fixture value");
            }
        }
        let last = ttft.last().expect("buckets");
        assert!(last.0.is_infinite());
        assert_eq!(last.1, want);
        // Percentiles come out of it: p50 of the merged histogram is a real
        // positive number, not None (the fixture has >100 observations).
        let p50 = percentile(ttft, 0.50).expect("p50 interpolates");
        assert!(p50 > 0.0 && p50 < 10.0, "got {p50}");
    }

    #[test]
    fn warmup_gate_blanks_delta_metrics_only() {
        // The mapping's blanking contract, through the real fixture: while
        // warming, everything a delta or a baseline needs reads None, and
        // every instantaneous reading passes through — the same contract the
        // vLLM adapter holds, checked on identical field names.
        let rates = RateInputs {
            tokens_per_sec: Some(30.0),
            prompt_tokens_per_sec: Some(100.0),
            avg_tokens_per_sec: Some(25.0),
            avg_prompt_tokens_per_sec: Some(90.0),
        };
        let blank = map_unbaselined(&parsed_real(), rates, true);
        assert_eq!(blank.tokens_per_sec, None);
        assert_eq!(blank.avg_tokens_per_sec, None);
        assert_eq!(blank.prompt_tokens_per_sec, None);
        assert_eq!(blank.avg_prompt_tokens_per_sec, None);
        assert_eq!(blank.ttft_ms, None);
        assert_eq!(blank.e2e_latency_ms, None);
        assert_eq!(blank.queue_time_ms, None);
        assert_eq!(blank.inter_token_latency_ms, None);
        assert_eq!(blank.per_request_prompt_tps, None);
        assert!(blank.ttft_percentiles.is_none());
        assert_eq!(blank.ttft_goodput_pct, None);
        assert!(blank.ttft_buckets.is_none());
        assert!(blank.warming_up);

        let live = map_unbaselined(&parsed_real(), rates, false);
        assert_eq!(live.tokens_per_sec, Some(30.0));
        assert_eq!(live.avg_prompt_tokens_per_sec, Some(90.0));
        assert!(live.ttft_ms.unwrap() > 0.0);
        assert!(live.ttft_percentiles.unwrap().p50_ms.unwrap() > 0.0);
        // Instantaneous fields survive warming in both passes.
        assert_eq!(live.active_requests, Some(1));
        assert_eq!(blank.active_requests, Some(1));
        assert_eq!(blank.spec_decode_acceptance_rate, Some(60.0));
        assert_close(blank.spec_decode_mean_acceptance_length, 1.8);
    }

    #[test]
    fn the_real_fixture_maps_onto_the_fields_sglang_reports() {
        // The whole ADR-0004 contract in one test: every field SGLang has a
        // series for carries the captured value, every field it has none for
        // stays None — no zero, no estimate, no stand-in.
        let m = map_unbaselined(&parsed_real(), RateInputs::default(), false);
        assert_eq!(m.active_requests, Some(1));
        assert_eq!(m.queued_requests, Some(0));
        assert!((m.kv_cache_percent.unwrap() - 38.13953488372093).abs() < 1e-9);
        assert_eq!(m.spec_decode_acceptance_rate, Some(60.0));
        // The fixture's `spec_accept_length` is 2.8 tokens a round, the bonus
        // included: 1.8 accepted draft tokens per draft.
        assert_close(m.spec_decode_mean_acceptance_length, 1.8);
        assert!(m.total_requests.unwrap() > 0);
        assert!(m.ttft_ms.unwrap() > 0.0);
        assert!(m.itl_percentiles.unwrap().p95_ms.unwrap() > 0.0);

        // The prefix ratio and totals against the parsed counters directly,
        // including the label-series sums (streaming + non-streaming).
        let parsed = parsed_real();
        let cached = parsed.counters["sglang_cached_tokens_total"];
        let prompt = parsed.counters["sglang_prompt_tokens_total"];
        assert!((prompt - 2.3651_203e7).abs() < 1.0, "label series summed");
        assert_eq!(m.total_prompt_tokens, Some(prompt as u64));
        assert_eq!(m.total_generation_tokens, Some(166_402));
        assert!(
            (m.prefix_cache_hit_rate.unwrap() - cached / prompt * 100.0).abs() < 1e-9,
            "hit rate is cached-over-prompt of the same summed series"
        );

        // Absent series, enumerated (ADR-0004): the moment one gains a value
        // from a stand-in this test is where the reviewer sees it. The TPOT,
        // batch-size and preemption fields belong to groups `metric_groups`
        // leaves out, so their tiles read "not reported"; the spec counters
        // sit in a group SGLang reports and stay empty within it.
        assert_eq!(m.per_request_tps, None);
        assert_eq!(m.swapped_requests, None);
        assert_eq!(m.preemptions_total, None);
        assert_eq!(m.avg_batch_size, None);
        assert_eq!(m.tpot_ms, None);
        assert!(m.tpot_percentiles.is_none());
        assert_eq!(m.tpot_goodput_pct, None);
        assert!(m.tpot_buckets.is_none());
        assert_eq!(m.spec_decode_draft_tokens_total, None);
        assert_eq!(m.spec_decode_accepted_tokens_total, None);
        // The fixture's capture trimmed `spec_verify_calls_total` away.
        assert_eq!(m.spec_decode_drafts_total, None);
        assert_eq!(m.spec_decode_acceptance_rate_live, None);
        // Rates are the adapter's stateful derivation; the pure mapping was
        // given none and invents none.
        assert_eq!(m.tokens_per_sec, None);
        assert_eq!(m.prompt_tokens_per_sec, None);
    }

    #[test]
    fn zero_acceptance_gauges_mean_no_drafter_not_zero_percent() {
        // v0.5.21 logs both spec gauges as `0` when no drafter is configured
        // (metrics_reporter sets them explicitly), so `0` must not read as a
        // 0% acceptance rate on a plain engine — it reads as absent.
        let body = "# TYPE sglang:num_running_reqs gauge\n\
                    sglang:num_running_reqs{engine_type=\"unified\"} 4.0\n\
                    # TYPE sglang:spec_accept_rate gauge\n\
                    sglang:spec_accept_rate{engine_type=\"unified\"} 0.0\n\
                    # TYPE sglang:spec_accept_length gauge\n\
                    sglang:spec_accept_length{engine_type=\"unified\"} 0.0\n";
        let parsed = parse_sglang(body).expect("parses");
        let m = map_unbaselined(&parsed, RateInputs::default(), false);
        assert_eq!(m.active_requests, Some(4));
        assert_eq!(m.spec_decode_acceptance_rate, None);
        assert_eq!(m.spec_decode_mean_acceptance_length, None);
    }

    #[test]
    fn live_decode_prefers_the_gauge_over_the_completion_ticked_delta() {
        // Mid-request the counter delta is 0 while the gauge is live: the gauge
        // wins, so the panel ticks during generation instead of reading 0.
        assert_eq!(live_decode_tps(Some(30.0), Some(0.0)), Some(30.0));
        assert_eq!(live_decode_tps(Some(30.0), None), Some(30.0));
        // A release with no `gen_throughput` gauge falls back to the delta.
        assert_eq!(live_decode_tps(None, Some(12.0)), Some(12.0));
        // Neither present: nothing to report.
        assert_eq!(live_decode_tps(None, None), None);
    }

    #[test]
    fn metrics_off_latches_from_the_answer_and_only_the_answer() {
        // The two answers that decide, plus the ones that must not latch:
        // a transient failure keeps the previous reading.
        assert_eq!(metrics_off_signal(true, 200), Some(false));
        assert_eq!(metrics_off_signal(false, 404), Some(true));
        assert_eq!(metrics_off_signal(false, 429), None);
        assert_eq!(metrics_off_signal(false, 500), None);
    }

    /// Only a 404 says metrics are off. A server launched with
    /// `--enable-metrics` whose collectors have not logged yet answers 200
    /// with no SGLang series — that is "no data yet", and telling its
    /// operator to relaunch with a flag they already passed would be wrong.
    #[tokio::test]
    async fn only_a_missing_route_latches_metrics_off() {
        use super::super::test_server::TestServer;

        let cases: [(u16, &str, bool, bool); 4] = [
            // status, body, metrics off afterwards, metrics reported
            (404, "Not Found", true, false),
            (200, "", false, false),
            (
                200,
                "# TYPE python_gc_objects_collected counter\npython_gc_objects_collected_total 7\n",
                false,
                false,
            ),
            (
                200,
                "# TYPE sglang:num_running_reqs gauge\nsglang:num_running_reqs 2.0\n",
                false,
                true,
            ),
        ];
        for (status, body, off, reported) in cases {
            let server = TestServer::start(move |_| (status, body.to_string())).await;
            let adapter =
                SglangAdapter::new(reqwest::Client::new(), server.url.clone(), None, None);
            let metrics = adapter.get_metrics().await;
            assert_eq!(adapter.metrics_off(), off, "{status} {body:?}");
            assert_eq!(metrics.is_some(), reported, "{status} {body:?}");
        }
    }

    /// A latched "off" clears as soon as the route answers — the operator
    /// relaunched with the flag — even before the first series is logged.
    #[tokio::test]
    async fn metrics_off_clears_once_the_route_answers() {
        use super::super::test_server::TestServer;
        use std::sync::atomic::AtomicBool;
        use std::sync::Arc;

        let relaunched = Arc::new(AtomicBool::new(false));
        let flag = relaunched.clone();
        let server = TestServer::start(move |_| {
            if flag.load(Ordering::SeqCst) {
                (200, String::new())
            } else {
                (404, "Not Found".into())
            }
        })
        .await;
        let adapter = SglangAdapter::new(reqwest::Client::new(), server.url.clone(), None, None);
        assert!(adapter.get_metrics().await.is_none());
        assert!(adapter.metrics_off());

        relaunched.store(true, Ordering::SeqCst);
        assert!(adapter.get_metrics().await.is_none(), "no series yet");
        assert!(!adapter.metrics_off());
    }

    /// Only `sglang:` series count as the engine's: a comment-only body, or
    /// one holding some other exporter's samples, has nothing to report.
    #[test]
    fn only_sglang_series_count_as_the_engines() {
        let comment_only = parse_sglang("# only a comment\n").expect("parses");
        assert!(!has_sglang_series(&comment_only));
        let foreign = parse_sglang("process_open_fds 12\n").expect("parses");
        assert!(!has_sglang_series(&foreign));
        assert!(has_sglang_series(&parsed_real()));
    }

    /// With `--dp-size 2` each rank logs its own scheduler gauges. The engine
    /// runs both ranks' requests, so counts sum; token usage is each rank's
    /// own pool, so it averages; the acceptance figures average over the
    /// ranks that have verified drafts, each rate paired with its rank.
    #[test]
    fn data_parallel_ranks_combine_into_one_engine() {
        let body = "\
# TYPE sglang:num_running_reqs gauge
sglang:num_running_reqs{dp_rank=\"0\",model_name=\"m\",tp_rank=\"0\"} 8.0
sglang:num_running_reqs{dp_rank=\"1\",model_name=\"m\",tp_rank=\"1\"} 7.0
# TYPE sglang:num_queue_reqs gauge
sglang:num_queue_reqs{dp_rank=\"0\",model_name=\"m\",tp_rank=\"0\"} 2.0
sglang:num_queue_reqs{dp_rank=\"1\",model_name=\"m\",tp_rank=\"1\"} 1.0
# TYPE sglang:full_token_usage gauge
sglang:full_token_usage{dp_rank=\"0\",model_name=\"m\",tp_rank=\"0\"} 0.5
sglang:full_token_usage{dp_rank=\"1\",model_name=\"m\",tp_rank=\"1\"} 0.3
# TYPE sglang:spec_accept_length gauge
sglang:spec_accept_length{dp_rank=\"0\",model_name=\"m\",tp_rank=\"0\"} 3.0
sglang:spec_accept_length{dp_rank=\"1\",model_name=\"m\",tp_rank=\"1\"} 2.0
# TYPE sglang:spec_accept_rate gauge
sglang:spec_accept_rate{dp_rank=\"1\",model_name=\"m\",tp_rank=\"1\"} 0.4
sglang:spec_accept_rate{dp_rank=\"0\",model_name=\"m\",tp_rank=\"0\"} 0.8
";
        let parsed = parse_sglang(body).expect("parses");
        let m = map_unbaselined(&parsed, RateInputs::default(), false);
        assert_eq!(m.active_requests, Some(15));
        assert_eq!(m.queued_requests, Some(3));
        let kv = m.kv_cache_percent.expect("kv");
        assert!((kv - 40.0).abs() < 1e-9, "mean of 50% and 30%, got {kv}");
        assert_eq!(m.spec_decode_mean_acceptance_length, Some(1.5));
        let rate = m.spec_decode_acceptance_rate.expect("rate");
        assert!(
            (rate - 60.0).abs() < 1e-9,
            "mean of 80% and 40%, got {rate}"
        );
    }

    /// A rank that has not verified a draft yet logs `0` and stays out of
    /// the acceptance mean, rather than halving the other rank's figures.
    #[test]
    fn a_rank_without_verified_drafts_stays_out_of_the_acceptance_mean() {
        let body = "\
# TYPE sglang:spec_accept_length gauge
sglang:spec_accept_length{dp_rank=\"0\"} 3.0
sglang:spec_accept_length{dp_rank=\"1\"} 0.0
# TYPE sglang:spec_accept_rate gauge
sglang:spec_accept_rate{dp_rank=\"0\"} 0.8
sglang:spec_accept_rate{dp_rank=\"1\"} 0.0
";
        let m = map_unbaselined(
            &parse_sglang(body).expect("parses"),
            RateInputs::default(),
            false,
        );
        assert_eq!(m.spec_decode_mean_acceptance_length, Some(2.0));
        assert_eq!(m.spec_decode_acceptance_rate, Some(80.0));
    }

    /// Under priority scheduling a queue gauge carries its total under
    /// `priority=""` and a per-priority breakdown beside it; summing all of
    /// them would count every request twice.
    #[test]
    fn priority_breakdowns_do_not_count_twice() {
        let body = "\
# TYPE sglang:num_running_reqs gauge
sglang:num_running_reqs{model_name=\"m\",priority=\"\"} 5.0
sglang:num_running_reqs{model_name=\"m\",priority=\"0\"} 3.0
sglang:num_running_reqs{model_name=\"m\",priority=\"1\"} 2.0
";
        let m = map_unbaselined(
            &parse_sglang(body).expect("parses"),
            RateInputs::default(),
            false,
        );
        assert_eq!(m.active_requests, Some(5));
    }

    /// Releases before the hybrid full/SWA split report the pool's usage as
    /// `token_usage` only; the KV tile reads it rather than going blank.
    #[test]
    fn kv_usage_falls_back_to_token_usage() {
        let body = "\
# TYPE sglang:token_usage gauge
sglang:token_usage{model_name=\"m\"} 0.25
";
        let m = map_unbaselined(
            &parse_sglang(body).expect("parses"),
            RateInputs::default(),
            false,
        );
        assert_eq!(m.kv_cache_percent, Some(25.0));
    }

    /// The bucket bound is the `le` label, read off the parsed label set —
    /// not the last `le="` in the line, which a label like `role="decode"`
    /// after it would turn into a bound of "decode".
    #[test]
    fn bucket_bounds_come_from_the_le_label_wherever_it_sits() {
        let body = "\
# TYPE sglang:time_to_first_token_seconds histogram
sglang:time_to_first_token_seconds_bucket{le=\"0.5\",role=\"decode\"} 3
sglang:time_to_first_token_seconds_bucket{le=\"+Inf\",role=\"decode\"} 4
";
        let parsed = parse_sglang(body).expect("parses");
        let ttft = parsed
            .histograms
            .get("sglang_time_to_first_token_seconds")
            .expect("ttft histogram");
        assert_eq!(ttft.len(), 2);
        assert_eq!(ttft[0], (0.5, 3.0));
        assert!(ttft[1].0.is_infinite());
        assert_eq!(ttft[1].1, 4.0);
    }

    fn adapter() -> SglangAdapter {
        SglangAdapter::new(
            reqwest::Client::new(),
            "http://127.0.0.1:30000".into(),
            None,
            None,
        )
    }

    /// Every group but TPOT's two, batch size and preemptions — written out,
    /// so a group added later is a decision for SGLang rather than a default.
    fn sglang_groups() -> BTreeSet<MetricGroup> {
        BTreeSet::from([
            MetricGroup::Throughput,
            MetricGroup::ActiveRequests,
            MetricGroup::RequestTotal,
            MetricGroup::QueueTime,
            MetricGroup::KvCache,
            MetricGroup::PrefixCache,
            MetricGroup::SpeculativeDecoding,
            MetricGroup::TtftMean,
            MetricGroup::TtftPercentiles,
            MetricGroup::E2eMean,
            MetricGroup::E2ePercentiles,
            MetricGroup::ItlMean,
            MetricGroup::ItlPercentiles,
        ])
    }

    /// The declaration and the mapping agree in both directions, over the
    /// real scrape: a group SGLang leaves out has no field the mapping fills,
    /// and each group it declares has one the scrape fills.
    #[test]
    fn sglang_reports_every_group_but_tpot_batch_size_and_preemptions() {
        let adapter = adapter();
        assert_eq!(adapter.metric_groups(), sglang_groups());

        let rates = RateInputs {
            tokens_per_sec: Some(30.0),
            prompt_tokens_per_sec: Some(100.0),
            avg_tokens_per_sec: Some(25.0),
            avg_prompt_tokens_per_sec: Some(90.0),
        };
        let parsed = parsed_real();
        let metrics = engine_metrics(&parsed, &parsed, rates, false, Some(true));
        let json = |m: EngineMetrics| serde_json::to_value(m).unwrap();

        assert_eq!(
            json(metrics.clone().reported_only(&adapter.metric_groups())),
            json(metrics.clone()),
            "nothing SGLang fills belongs to a group it leaves out",
        );
        for group in adapter.metric_groups() {
            assert_ne!(
                json(metrics.clone().reported_only(&BTreeSet::from([group]))),
                json(EngineMetrics::default()),
                "the real scrape fills {group:?}",
            );
        }
    }

    /// SGLang says "metrics off" with a flag name, not with an empty group
    /// list — the two states render differently in the UI (ADR-0004).
    #[test]
    fn metrics_off_names_its_flag_beyond_the_group_declaration() {
        let adapter = adapter();
        assert_eq!(adapter.metric_groups(), sglang_groups());
        assert!(!adapter.metrics_off());
        assert_eq!(adapter.metrics_launch_flag(), Some("--enable-metrics"));
    }

    /// A body whose request and token counters stand at `requests` and
    /// `tokens` — the shape a live engine's scrape grows through.
    fn growing_scrape(requests: u64, tokens: u64) -> String {
        format!(
            "# TYPE sglang:time_to_first_token_seconds histogram\n\
             sglang:time_to_first_token_seconds_bucket{{le=\"0.5\",is_streaming=\"true\"}} {requests}\n\
             sglang:time_to_first_token_seconds_bucket{{le=\"+Inf\",is_streaming=\"true\"}} {requests}\n\
             sglang:time_to_first_token_seconds_sum{{is_streaming=\"true\"}} {sum}\n\
             sglang:time_to_first_token_seconds_count{{is_streaming=\"true\"}} {requests}\n\
             # TYPE sglang:generation_tokens_total counter\n\
             sglang:generation_tokens_total{{is_streaming=\"true\"}} {tokens}\n\
             # TYPE sglang:num_running_reqs gauge\n\
             sglang:num_running_reqs{{tp_rank=\"0\"}} 1.0\n",
            sum = requests as f64 * 0.1,
        )
    }

    /// Warmup ends on SGLang's own request counter. It was measured on
    /// vLLM's, which an SGLang scrape never carries, so at the default
    /// `SPARK_WARMUP_SKIP_REQUESTS=1` the engine stayed warming forever and
    /// every rate, mean, percentile and goodput figure stayed blank. And the
    /// lifetime request count stays absolute across the baseline.
    #[tokio::test]
    async fn warmup_completes_as_sglang_serves_requests() {
        use super::super::test_server::TestServer;
        use std::sync::atomic::AtomicU64;
        use std::sync::Arc;

        let polls = Arc::new(AtomicU64::new(0));
        let served = polls.clone();
        let server = TestServer::start(move |r| {
            if r.path != "/metrics" {
                return (404, String::new());
            }
            let n = served.fetch_add(1, Ordering::SeqCst);
            (200, growing_scrape(5 + n, 1000 + 100 * n))
        })
        .await;
        let adapter = SglangAdapter::new(reqwest::Client::new(), server.url.clone(), None, None);

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

    /// SGLang's model identity goes through the resolver vLLM uses, so an
    /// API-key launch the dashboard holds no key for is reported the same
    /// way: the command-line name as a fallback, `AuthRequired` beside it,
    /// and the warning that tells the operator to configure a provider API
    /// key — which the adapter's own copy of the code had dropped.
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
        let adapter = SglangAdapter::new(
            reqwest::Client::new(),
            server.url.clone(),
            // Not an `org/name` id, so HF enrichment never leaves the host.
            Some("qwen3-local".into()),
            None,
        );
        let resolution = adapter.get_model_info().await;

        assert_eq!(
            resolution.metadata_error,
            Some(ModelMetadataError::AuthRequired)
        );
        assert_eq!(
            resolution.model.map(|m| m.name).as_deref(),
            Some("qwen3-local")
        );
        let logged = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
        assert!(
            logged.contains("configure a provider API key"),
            "warning logged: {logged}"
        );
    }

    /// A release without `/ready` is healthy while `/model_info` answers; a
    /// 401 there is reported as such, and `/ready`, where it exists, wins.
    #[tokio::test]
    async fn health_falls_back_to_model_info_where_ready_is_missing() {
        use super::super::test_server::TestServer;
        for (ready, model_info, expected) in [
            (200, 404, EngineStatus::Running),
            (
                503,
                200,
                EngineStatus::Error("HTTP 503 Service Unavailable".into()),
            ),
            (404, 200, EngineStatus::Running),
            (
                404,
                401,
                EngineStatus::Error("HTTP 401 Unauthorized".into()),
            ),
            (404, 404, EngineStatus::Error("HTTP 404 Not Found".into())),
        ] {
            let server = TestServer::start(move |r| match r.path.as_str() {
                "/ready" => (ready, String::new()),
                _ => (model_info, String::new()),
            })
            .await;
            let adapter = SglangAdapter::new(
                reqwest::Client::new(),
                server.url.clone(),
                None,
                Some("k".into()),
            );
            assert_eq!(
                adapter.health_check().await,
                expected,
                "/ready {ready}, /model_info {model_info}"
            );
            assert!(server
                .requests()
                .iter()
                .all(|r| r.path != "/health" && r.path != "/server_info"));
        }
    }

    /// SGLang's accept length counts the token the target model emits every
    /// verify round; the dashboard's figure — vLLM's accepted/drafts — does
    /// not. A drafter whose drafts are all rejected emits one token a round
    /// and accepts none.
    #[test]
    fn acceptance_length_leaves_out_the_bonus_token() {
        let body = "\
# TYPE sglang:spec_accept_length gauge
sglang:spec_accept_length{tp_rank=\"0\"} 1.0
# TYPE sglang:spec_accept_rate gauge
sglang:spec_accept_rate{tp_rank=\"0\"} 0.0
";
        let m = map_unbaselined(
            &parse_sglang(body).expect("parses"),
            RateInputs::default(),
            false,
        );
        assert_eq!(m.spec_decode_mean_acceptance_length, Some(0.0));
        assert_eq!(m.spec_decode_acceptance_rate, Some(0.0));
    }

    /// An SGLang drafter that has not verified a draft logs its acceptance
    /// gauges as `0`, exactly like a server without one. `/server_info`
    /// tells them apart: a configured drafter reports zero draft rounds —
    /// "has drafted no tokens yet" — while a server without one reports no
    /// speculative decoding at all.
    #[test]
    fn an_idle_drafter_reports_zero_draft_rounds_and_no_drafter_reports_none() {
        let idle = parse_sglang(
            "# TYPE sglang:spec_accept_length gauge\n\
             sglang:spec_accept_length{tp_rank=\"0\"} 0.0\n\
             # TYPE sglang:spec_accept_rate gauge\n\
             sglang:spec_accept_rate{tp_rank=\"0\"} 0.0\n",
        )
        .expect("parses");
        let rates = RateInputs::default();

        let configured = engine_metrics(&idle, &idle, rates, false, Some(true));
        assert_eq!(configured.spec_decode_drafts_total, Some(0));
        assert_eq!(configured.spec_decode_acceptance_rate, None);
        assert_eq!(configured.spec_decode_mean_acceptance_length, None);

        let without = engine_metrics(&idle, &idle, rates, false, Some(false));
        assert_eq!(without.spec_decode_drafts_total, None);

        let unknown = engine_metrics(&idle, &idle, rates, false, None);
        assert_eq!(unknown.spec_decode_drafts_total, None);

        // Once requests with verified drafts finish, the counter speaks for
        // itself, with or without `/server_info`.
        let drafted = parse_sglang(
            "# TYPE sglang:spec_verify_calls counter\n\
             sglang:spec_verify_calls_total{model_name=\"m\"} 42.0\n",
        )
        .expect("parses");
        let m = engine_metrics(&drafted, &drafted, rates, false, None);
        assert_eq!(m.spec_decode_drafts_total, Some(42));
    }

    #[test]
    fn server_info_names_the_speculative_algorithm_or_none() {
        use serde_json::json;
        let drafter = |info| drafter_in_server_info(&info);
        assert_eq!(
            drafter(json!({"speculative_algorithm": "EAGLE"})),
            Some(true)
        );
        assert_eq!(drafter(json!({"speculative_algorithm": null})), Some(false));
        assert_eq!(
            drafter(json!({"speculative_algorithm": "NONE"})),
            Some(false)
        );
        assert_eq!(drafter(json!({"model_path": "m"})), None);
    }

    /// The adapter asks `/server_info` once, not every poll: the route
    /// gathers every scheduler's state.
    #[tokio::test]
    async fn the_drafter_is_looked_up_once() {
        use super::super::test_server::TestServer;
        let server = TestServer::start(|r| match r.path.as_str() {
            "/server_info" => (200, r#"{"speculative_algorithm":"EAGLE"}"#.into()),
            _ => (
                200,
                "# TYPE sglang:num_running_reqs gauge\nsglang:num_running_reqs 0.0\n".into(),
            ),
        })
        .await;
        let adapter = SglangAdapter::new(reqwest::Client::new(), server.url.clone(), None, None);
        for _ in 0..3 {
            let m = adapter.get_metrics().await.expect("metrics");
            assert_eq!(m.spec_decode_drafts_total, Some(0));
        }
        let lookups = server
            .requests()
            .iter()
            .filter(|r| r.path == "/server_info")
            .count();
        assert_eq!(lookups, 1);
    }
}
