mod common;
pub mod detector;
pub mod histogram;
pub mod llamacpp;
mod model_info;
pub mod ollama;
pub mod prometheus;
pub mod sglang;
pub mod tensorfold;
#[cfg(test)]
pub(crate) mod test_server;
pub mod vllm;
pub mod warmup;

use async_trait::async_trait;
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq, Hash)]
pub enum EngineType {
    Vllm,
    Sglang,
    Ollama,
    /// llama.cpp's `llama-server`.
    LlamaCpp,
    /// TensorFold's `tensorfold-native`.
    Tensorfold,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq, Hash)]
pub enum DeploymentMode {
    Docker,
    Native,
}

impl std::fmt::Display for EngineType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EngineType::Vllm => write!(f, "vLLM"),
            EngineType::Sglang => write!(f, "SGLang"),
            EngineType::Ollama => write!(f, "Ollama"),
            EngineType::LlamaCpp => write!(f, "llama.cpp"),
            EngineType::Tensorfold => write!(f, "TensorFold"),
        }
    }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(tag = "type", content = "message")]
pub enum EngineStatus {
    Running,
    Loading,
    Stopped,
    Error(String),
}

/// A set of engine metrics an engine reports together or not at all
/// (ADR-0004). Each engine states on the metrics contract which groups it
/// reports; a tile whose group is not reported keeps its slot and says so
/// rather than showing a zero, which a `null` field cannot carry — `null`
/// already means "warming up", "not emitted yet" and "feature not
/// configured".
///
/// The groups are cut where the panels cut tiles, so that each is
/// all-or-nothing on every engine type (ADR-0004's amendment, #142). Every
/// `EngineMetrics` field but `warming_up` belongs to exactly one group; the
/// table is `EngineMetrics::reported_only`.
///
/// The variant names are the wire format, mirrored by `METRIC_GROUPS` in
/// `frontend/src/types/metrics.ts`, and the declaration order is the wire
/// order: a `BTreeSet` of groups serializes in it. Adding or splitting a
/// group is a metrics-contract change.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize)]
pub enum MetricGroup {
    /// Prompt and generation token rates and their running averages
    /// (`prompt_tokens_per_sec`, `tokens_per_sec`, `avg_prompt_tokens_per_sec`,
    /// `avg_tokens_per_sec`), and the lifetime token counters behind them
    /// (`total_prompt_tokens`, `total_generation_tokens`).
    Throughput,
    /// Tokens per engine step (`avg_batch_size`).
    BatchSize,
    /// Running and queued requests (`active_requests`, `queued_requests`).
    ActiveRequests,
    /// The lifetime request count (`total_requests`).
    RequestTotal,
    /// The preemption counter and swapped requests (`preemptions_total`,
    /// `swapped_requests`).
    Preemptions,
    /// Mean time a request waits in the queue before it is scheduled
    /// (`queue_time_ms`).
    QueueTime,
    /// KV cache utilization (`kv_cache_percent`, and its
    /// `kv_cache_is_estimated` flag).
    KvCache,
    /// Prefix cache hit rate and query volume (`prefix_cache_hit_rate`,
    /// `prefix_cache_queries_total`).
    PrefixCache,
    /// Draft/accepted token counters and the acceptance figures derived from
    /// them (the six `spec_decode_*` fields). Reported by an engine that
    /// *can* speculate; whether this one is configured to is what the
    /// counters themselves say.
    SpeculativeDecoding,
    /// Mean time to first token (`ttft_ms`), and the per-request prefill
    /// throughput derived from the TTFT sum (`per_request_prompt_tps`).
    TtftMean,
    /// TTFT p50/p95/p99 (`ttft_percentiles`), the histogram buckets they are
    /// read off (`ttft_buckets`) and the SLO goodput (`ttft_goodput_pct`).
    TtftPercentiles,
    /// Mean end-to-end request latency (`e2e_latency_ms`).
    E2eMean,
    /// End-to-end latency p50/p95/p99 (`e2e_percentiles`), the histogram
    /// buckets (`e2e_buckets`) and the SLO goodput (`e2e_goodput_pct`).
    E2ePercentiles,
    /// Mean inter-token latency (`inter_token_latency_ms`).
    ItlMean,
    /// Inter-token latency p50/p95/p99 (`itl_percentiles`), the histogram
    /// buckets (`itl_buckets`) and the SLO goodput (`itl_goodput_pct`).
    ItlPercentiles,
    /// Mean time per output token (`tpot_ms`), and the per-request decode
    /// throughput derived from it (`per_request_tps`).
    TpotMean,
    /// TPOT p50/p95/p99 (`tpot_percentiles`), the histogram buckets
    /// (`tpot_buckets`) and the SLO goodput (`tpot_goodput_pct`).
    TpotPercentiles,
}

impl MetricGroup {
    /// Every metric group, in wire order — the declaration order above.
    pub const ALL: [MetricGroup; 17] = [
        MetricGroup::Throughput,
        MetricGroup::BatchSize,
        MetricGroup::ActiveRequests,
        MetricGroup::RequestTotal,
        MetricGroup::Preemptions,
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
        MetricGroup::TpotMean,
        MetricGroup::TpotPercentiles,
    ];

    /// The set of every group — what an engine reporting everything declares.
    pub fn all() -> BTreeSet<MetricGroup> {
        Self::ALL.into_iter().collect()
    }
}

/// Why model metadata could not be read from the engine's `/v1/models`
/// endpoint. Travels on the wire next to `model` so the frontend can say
/// *why* a name is missing (or provisional) instead of silently showing the
/// command-line fallback. `None` on the snapshot means metadata resolved
/// normally.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub enum ModelMetadataError {
    /// `/v1/models` rejected the request as unauthorized (401/403) — the
    /// dashboard lacks the engine's API key. Actionable: configure a
    /// provider API key.
    AuthRequired,
    /// `/v1/models` could not be used for any non-auth reason: unreachable,
    /// non-auth error status, unparseable body, or an empty model list.
    Unavailable,
}

/// Why a running engine's metrics endpoint answered without metrics. Travels
/// on the wire next to `metrics_off`, in the shape `ModelMetadataError` has,
/// so the frontend says what it says about a refused `/v1/models`: the
/// dashboard lacks the engine's key. `None` on the snapshot means the
/// endpoint did not refuse the dashboard — its metrics answered, are off, or
/// could not be reached for some other reason.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub enum MetricsError {
    /// The metrics endpoint refused the dashboard's request (401/403) —
    /// the dashboard lacks the engine's API key. Not metrics off: the engine
    /// publishes them, and the fix is a provider API key, not a launch flag.
    AuthRequired,
}

/// The outcome of a model-info fetch: what resolved (possibly from the
/// command-line fallback) and why the engine's own answer is missing, if it
/// is. Both can be populated at once — a fallback name accompanied by the
/// reason it is only a fallback.
#[derive(Clone, Debug, Default)]
pub struct ModelResolution {
    pub model: Option<ModelInfo>,
    pub metadata_error: Option<ModelMetadataError>,
}

#[derive(Clone, Debug, serde::Serialize, PartialEq)]
pub struct ModelInfo {
    pub name: String,
    pub parameter_size: Option<String>,
    pub quantization: Option<String>,
    pub precision: Option<String>,
    pub tensor_type: Option<String>,
    pub model_type: Option<String>,
    pub pipeline_tag: Option<String>,
}

impl ModelInfo {
    /// A model known by its name alone, every other field empty: a
    /// command-line name, or an engine's own that nothing enriched.
    pub fn named(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            parameter_size: None,
            quantization: None,
            precision: None,
            tensor_type: None,
            model_type: None,
            pipeline_tag: None,
        }
    }
}

/// One model an engine has loaded right now: an entry of the list an engine
/// type that serves several models at once (Ollama) carries in place of a
/// single `model`. The field names are the wire format, mirrored by
/// `LoadedModel` in `frontend/src/types/metrics.ts`.
#[derive(Clone, Debug, serde::Serialize, PartialEq)]
pub struct LoadedModel {
    /// The model's name as the engine lists it, e.g. `tinyllama:latest`.
    pub name: String,
    /// The parameter count as the engine words it (`"1B"`); `None` when it
    /// gives none.
    pub parameter_size: Option<String>,
    /// The quantization level (`"Q4_0"`); `None` when the engine gives none.
    pub quantization: Option<String>,
    /// Memory the loaded model occupies, in bytes.
    pub size_bytes: u64,
    /// The part of `size_bytes` held in GPU memory.
    pub vram_bytes: u64,
    /// The context window the model was loaded with, in tokens; `None` when
    /// the engine does not say.
    pub context_length: Option<u32>,
    /// When the engine unloads the model if it stays idle, RFC 3339 exactly as
    /// the engine wrote it; `None` when it gives no time.
    pub expires_at: Option<String>,
}

/// Tail-latency percentiles in milliseconds, derived from a Prometheus
/// histogram. Any quantile may be `None` if the histogram has not yet
/// observed enough data to interpolate.
#[derive(Clone, Debug, serde::Serialize, Default)]
pub struct LatencyPercentiles {
    pub p50_ms: Option<f64>,
    pub p95_ms: Option<f64>,
    pub p99_ms: Option<f64>,
}

/// SLO threshold for time-to-first-token (ms). Requests slower than this
/// are considered to have missed the SLO when computing goodput.
pub const TTFT_SLO_MS: f64 = 500.0;
/// SLO threshold for inter-token latency during decode (ms).
pub const ITL_SLO_MS: f64 = 50.0;
/// SLO threshold for end-to-end request latency (ms).
pub const E2E_SLO_MS: f64 = 5000.0;
/// SLO threshold for time per output token during decode (ms). A token
/// every 50ms is roughly 20 tok/s; mirrors the related `ITL_SLO_MS`.
pub const TPOT_SLO_MS: f64 = 50.0;

/// One Prometheus histogram bucket for transport to the frontend.
///
/// `le_seconds` is the upper bound (`le` label) for the bucket and
/// `cumulative_count` is the cumulative observation count Prometheus
/// emits. The frontend uses these to recompute goodput at custom
/// SLO thresholds without a backend roundtrip.
///
/// `+Inf` is replaced by `f64::MAX` before serialization — `serde_json`
/// emits non-finite floats as `null`/errors which would break the
/// frontend's `JSON.parse`. The interpolation logic treats values
/// at or beyond `f64::MAX` as the "overflow" bucket, matching the
/// Rust `fraction_le` semantics.
#[derive(Clone, Debug, serde::Serialize)]
pub struct HistogramBucket {
    pub le_seconds: f64,
    pub cumulative_count: f64,
}

#[derive(Clone, Debug, serde::Serialize, Default)]
pub struct EngineMetrics {
    pub tokens_per_sec: Option<f64>,
    pub avg_tokens_per_sec: Option<f64>,
    pub per_request_tps: Option<f64>,
    pub ttft_ms: Option<f64>,
    pub active_requests: Option<u64>,
    pub queued_requests: Option<u64>,
    pub kv_cache_percent: Option<f64>,
    pub kv_cache_is_estimated: bool,
    pub total_requests: Option<u64>,
    // --- New metrics ---
    /// Average end-to-end request latency in milliseconds.
    pub e2e_latency_ms: Option<f64>,
    /// Prompt (prefill) token throughput (tokens/sec), computed as rate from counter.
    pub prompt_tokens_per_sec: Option<f64>,
    /// Running average of prompt (prefill) token throughput (tokens/sec).
    pub avg_prompt_tokens_per_sec: Option<f64>,
    /// Per-request average prompt throughput: prompt_tokens / prefill_time (tokens/sec).
    pub per_request_prompt_tps: Option<f64>,
    /// Number of requests swapped to CPU memory (0 = healthy, >0 = memory pressure).
    pub swapped_requests: Option<u64>,
    /// GPU prefix cache hit rate as percentage (0-100).
    pub prefix_cache_hit_rate: Option<f64>,
    /// Average time a request spends waiting in the queue (ms).
    pub queue_time_ms: Option<f64>,
    /// Average inter-token latency during decode in milliseconds
    /// (gap between successive generated tokens).
    pub inter_token_latency_ms: Option<f64>,
    /// Cumulative count of scheduling preemptions.
    pub preemptions_total: Option<u64>,
    /// Cumulative prompt (prefill) tokens processed since engine start.
    /// Raw lifetime counter, not warmup-adjusted.
    pub total_prompt_tokens: Option<u64>,
    /// Cumulative generation (decode) tokens produced since engine start.
    /// Raw lifetime counter, not warmup-adjusted.
    pub total_generation_tokens: Option<u64>,
    /// Cumulative count of prefix-cache token queries since engine start.
    /// Raw lifetime counter, not warmup-adjusted.
    pub prefix_cache_queries_total: Option<u64>,
    /// Average tokens processed per engine iteration step (batch size proxy).
    pub avg_batch_size: Option<f64>,
    /// Tail latency percentiles for time-to-first-token (ms).
    pub ttft_percentiles: Option<LatencyPercentiles>,
    /// Tail latency percentiles for inter-token latency during decode (ms).
    pub itl_percentiles: Option<LatencyPercentiles>,
    /// Tail latency percentiles for end-to-end request latency (ms).
    pub e2e_percentiles: Option<LatencyPercentiles>,
    /// Goodput: percentage (0-100) of TTFT observations meeting `TTFT_SLO_MS`.
    pub ttft_goodput_pct: Option<f64>,
    /// Goodput: percentage (0-100) of ITL observations meeting `ITL_SLO_MS`.
    pub itl_goodput_pct: Option<f64>,
    /// Goodput: percentage (0-100) of E2E observations meeting `E2E_SLO_MS`.
    pub e2e_goodput_pct: Option<f64>,
    /// Raw TTFT histogram buckets (cumulative). Frontend uses these to
    /// recompute goodput at user-customized SLO thresholds.
    pub ttft_buckets: Option<Vec<HistogramBucket>>,
    /// Raw ITL histogram buckets (cumulative).
    pub itl_buckets: Option<Vec<HistogramBucket>>,
    /// Raw E2E histogram buckets (cumulative).
    pub e2e_buckets: Option<Vec<HistogramBucket>>,
    /// Average time per output token during decode in milliseconds — the
    /// gap between generating each subsequent token, excluding TTFT.
    pub tpot_ms: Option<f64>,
    /// Tail latency percentiles for time per output token (ms).
    pub tpot_percentiles: Option<LatencyPercentiles>,
    /// Goodput: percentage (0-100) of TPOT observations meeting `TPOT_SLO_MS`.
    pub tpot_goodput_pct: Option<f64>,
    /// Raw TPOT histogram buckets (cumulative).
    pub tpot_buckets: Option<Vec<HistogramBucket>>,
    // --- Speculative decoding ---
    // These are populated only when the served model has speculative decoding
    // configured (vLLM emits `vllm:spec_decode_*` only in that case). When the
    // metrics are absent all six fields are `None`, which the frontend uses to
    // hide the speculative-decoding section entirely.
    /// Cumulative speculatively-generated (draft) tokens. Raw lifetime counter,
    /// not warmup-adjusted, so it counts up continuously across the engine's life.
    pub spec_decode_draft_tokens_total: Option<u64>,
    /// Cumulative draft tokens that passed verification. Raw lifetime counter.
    pub spec_decode_accepted_tokens_total: Option<u64>,
    /// Cumulative number of speculative-decode draft attempts. Raw lifetime counter.
    pub spec_decode_drafts_total: Option<u64>,
    /// Lifetime token acceptance rate (TAR) as a percentage: accepted/draft*100.
    pub spec_decode_acceptance_rate: Option<f64>,
    /// Live (windowed) TAR from per-poll deltas: Δaccepted/Δdraft*100. Fluctuates
    /// with recent traffic; `None` during warmup and on the first reading.
    pub spec_decode_acceptance_rate_live: Option<f64>,
    /// Mean accepted tokens per draft attempt: accepted/drafts (acceptance length).
    pub spec_decode_mean_acceptance_length: Option<f64>,
    /// True while the engine is still in warmup — histogram-derived fields
    /// (averages, percentiles, goodput, rates) are intentionally `None` so the
    /// first slow inference does not pollute steady-state metrics. See
    /// `engines::warmup` for the state machine.
    pub warming_up: bool,
}

impl EngineMetrics {
    /// These metrics with every field of a metric group outside `reported`
    /// blanked: `None`, and `kv_cache_is_estimated` `false`. A field of a
    /// group the engine does not report then never goes on the wire filled,
    /// whatever the adapter put in it — the declaration decides, and a tile
    /// reads "not reported" rather than a stray value.
    ///
    /// This is the field-to-group table of the metrics contract, mirrored by
    /// `METRIC_FIELD_GROUP` in `frontend/src/lib/engineMetrics.ts`. It is a
    /// struct literal without `..self` on purpose: a field added without a
    /// group does not compile. `warming_up` is engine state, not a metric,
    /// and passes through.
    pub fn reported_only(self, reported: &BTreeSet<MetricGroup>) -> EngineMetrics {
        use MetricGroup::*;
        let keep = |group: MetricGroup| reported.contains(&group);
        EngineMetrics {
            tokens_per_sec: self.tokens_per_sec.filter(|_| keep(Throughput)),
            avg_tokens_per_sec: self.avg_tokens_per_sec.filter(|_| keep(Throughput)),
            prompt_tokens_per_sec: self.prompt_tokens_per_sec.filter(|_| keep(Throughput)),
            avg_prompt_tokens_per_sec: self.avg_prompt_tokens_per_sec.filter(|_| keep(Throughput)),
            total_prompt_tokens: self.total_prompt_tokens.filter(|_| keep(Throughput)),
            total_generation_tokens: self.total_generation_tokens.filter(|_| keep(Throughput)),
            avg_batch_size: self.avg_batch_size.filter(|_| keep(BatchSize)),
            active_requests: self.active_requests.filter(|_| keep(ActiveRequests)),
            queued_requests: self.queued_requests.filter(|_| keep(ActiveRequests)),
            total_requests: self.total_requests.filter(|_| keep(RequestTotal)),
            preemptions_total: self.preemptions_total.filter(|_| keep(Preemptions)),
            swapped_requests: self.swapped_requests.filter(|_| keep(Preemptions)),
            queue_time_ms: self.queue_time_ms.filter(|_| keep(QueueTime)),
            kv_cache_percent: self.kv_cache_percent.filter(|_| keep(KvCache)),
            kv_cache_is_estimated: self.kv_cache_is_estimated && keep(KvCache),
            prefix_cache_hit_rate: self.prefix_cache_hit_rate.filter(|_| keep(PrefixCache)),
            prefix_cache_queries_total: self
                .prefix_cache_queries_total
                .filter(|_| keep(PrefixCache)),
            spec_decode_draft_tokens_total: self
                .spec_decode_draft_tokens_total
                .filter(|_| keep(SpeculativeDecoding)),
            spec_decode_accepted_tokens_total: self
                .spec_decode_accepted_tokens_total
                .filter(|_| keep(SpeculativeDecoding)),
            spec_decode_drafts_total: self
                .spec_decode_drafts_total
                .filter(|_| keep(SpeculativeDecoding)),
            spec_decode_acceptance_rate: self
                .spec_decode_acceptance_rate
                .filter(|_| keep(SpeculativeDecoding)),
            spec_decode_acceptance_rate_live: self
                .spec_decode_acceptance_rate_live
                .filter(|_| keep(SpeculativeDecoding)),
            spec_decode_mean_acceptance_length: self
                .spec_decode_mean_acceptance_length
                .filter(|_| keep(SpeculativeDecoding)),
            ttft_ms: self.ttft_ms.filter(|_| keep(TtftMean)),
            per_request_prompt_tps: self.per_request_prompt_tps.filter(|_| keep(TtftMean)),
            ttft_percentiles: self.ttft_percentiles.filter(|_| keep(TtftPercentiles)),
            ttft_buckets: self.ttft_buckets.filter(|_| keep(TtftPercentiles)),
            ttft_goodput_pct: self.ttft_goodput_pct.filter(|_| keep(TtftPercentiles)),
            e2e_latency_ms: self.e2e_latency_ms.filter(|_| keep(E2eMean)),
            e2e_percentiles: self.e2e_percentiles.filter(|_| keep(E2ePercentiles)),
            e2e_buckets: self.e2e_buckets.filter(|_| keep(E2ePercentiles)),
            e2e_goodput_pct: self.e2e_goodput_pct.filter(|_| keep(E2ePercentiles)),
            inter_token_latency_ms: self.inter_token_latency_ms.filter(|_| keep(ItlMean)),
            itl_percentiles: self.itl_percentiles.filter(|_| keep(ItlPercentiles)),
            itl_buckets: self.itl_buckets.filter(|_| keep(ItlPercentiles)),
            itl_goodput_pct: self.itl_goodput_pct.filter(|_| keep(ItlPercentiles)),
            tpot_ms: self.tpot_ms.filter(|_| keep(TpotMean)),
            per_request_tps: self.per_request_tps.filter(|_| keep(TpotMean)),
            tpot_percentiles: self.tpot_percentiles.filter(|_| keep(TpotPercentiles)),
            tpot_buckets: self.tpot_buckets.filter(|_| keep(TpotPercentiles)),
            tpot_goodput_pct: self.tpot_goodput_pct.filter(|_| keep(TpotPercentiles)),
            warming_up: self.warming_up,
        }
    }
}

/// A per-request inference metric record.
/// Empty for now; future engine adapter integration will populate these.
#[derive(Clone, Debug, serde::Serialize)]
pub struct RecentRequest {
    pub start_ms: u64,
    pub end_ms: u64,
    pub tokens_per_sec: f64,
    pub ttft_ms: f64,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct EngineSnapshot {
    pub engine_type: EngineType,
    pub endpoint: String,
    pub status: EngineStatus,
    pub model: Option<ModelInfo>,
    /// Why `model` is missing or only a command-line fallback. `None` when
    /// metadata resolved normally (or has not been attempted yet).
    pub model_metadata_error: Option<ModelMetadataError>,
    /// The models the engine has loaded now, sorted by name, for an engine
    /// type that serves several at once and names no single one — `model` is
    /// then always `None`, and an empty list is an engine with nothing
    /// loaded, which is still running. `None` for a single-model engine type
    /// (vLLM, SGLang), whose model is `model`. Always serialized, `null`
    /// included, as the adapter's `loaded_models` decides.
    pub loaded_models: Option<Vec<LoadedModel>>,
    /// The metric groups this engine reports, as its adapter declares them.
    /// Always serialized — an empty set is an engine that reports nothing,
    /// which is not the same as a snapshot from a backend that predates the
    /// field (the frontend reads that as "every group", which is what such a
    /// backend reported).
    pub metric_groups: BTreeSet<MetricGroup>,
    /// The engine runs and can report metrics, but was started without the
    /// launch flag that turns its metrics endpoint on; the value is that
    /// flag, named so the UI can tell the operator what to add. Distinct
    /// from an empty `metric_groups` ("this engine does not report these
    /// metrics at all"): here the metrics exist and are switched off.
    /// `None` when metrics are on or the engine type has no metrics toggle
    /// (the common case — most engines always expose `/metrics`).
    pub metrics_off: Option<String>,
    /// The engine runs, and its metrics endpoint refused the dashboard — for
    /// want of its API key, reported the way `model_metadata_error` reports
    /// a refused `/v1/models` rather than as `metrics_off`, since no launch
    /// flag fixes it. Carried only while the engine is running, exactly as
    /// `metrics_off` is. Always serialized, `null` included.
    pub metrics_error: Option<MetricsError>,
    pub metrics: Option<EngineMetrics>,
    pub recent_requests: Vec<RecentRequest>,
    pub deployment_mode: DeploymentMode,
    /// Indexes of the GPU(s) this engine was observed running on, derived by
    /// matching `pids` against NVML's per-device compute-process lists.
    /// Empty = unknown (NVML unavailable, empty process lists, engine not on
    /// a GPU yet) — the UI shows nothing rather than a wrong guess. Filled in
    /// by the metrics collector at snapshot-assembly time (it owns the NVML
    /// device handles), so the copy in the shared engine state is always empty.
    pub gpu_indexes: Vec<u32>,
    /// Host-namespace PIDs belonging to the engine, used to compute
    /// `gpu_indexes`. Internal plumbing between the collector loops — not
    /// part of the wire format.
    #[serde(skip_serializing)]
    pub pids: Vec<u32>,
    /// Full Docker container id when the engine is running in a container
    /// discovered via the Docker scan layer. Internal-only: not serialized to
    /// the frontend (the dashboard has no use for it), but read by the log
    /// viewer to stream the exact container the dashboard is showing.
    #[serde(skip)]
    pub container_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Trait
// ---------------------------------------------------------------------------

#[async_trait]
pub trait EngineAdapter: Send + Sync {
    fn engine_type(&self) -> EngineType;
    fn endpoint(&self) -> &str;
    /// Which metric groups this engine reports. The adapter decides, per
    /// engine rather than per type — what an engine exposes can depend on its
    /// version and on how it was launched, and only the adapter sees the
    /// scrape. A group listed here whose fields are momentarily `None` is
    /// "not yet"; a group left out is "not reported", and its tiles say so.
    /// The snapshot blanks a left-out group's fields whatever `get_metrics`
    /// put in them (`EngineMetrics::reported_only`).
    fn metric_groups(&self) -> BTreeSet<MetricGroup>;
    /// When the engine is running but its metrics endpoint is switched off by
    /// a launch flag, the name of that flag — so the UI can say "metrics are
    /// off; relaunch with `--enable-metrics`" instead of the vaguer "not
    /// reported". `None` (the default) means metrics are on, or the engine
    /// type has no metrics toggle at all. An engine type that grows this
    /// signal overrides the flag name; the collector loop and wire format
    /// need no change.
    fn metrics_launch_flag(&self) -> Option<&'static str> {
        None
    }
    /// Whether this instance is currently observed with its metrics endpoint
    /// off — see `metrics_launch_flag`. Read on every snapshot assembly; the
    /// adapter answers from its last scrape, without making a request.
    fn metrics_off(&self) -> bool {
        false
    }
    /// Why this instance's metrics endpoint last refused the dashboard, if it
    /// did: `AuthRequired` when it answered 401/403 for want of the engine's
    /// API key. `None` (the default) for an engine type whose metrics never
    /// need a key, and for one whose last answer did not refuse. Read on
    /// every snapshot assembly; the adapter answers from its last scrape,
    /// without making a request.
    fn metrics_error(&self) -> Option<MetricsError> {
        None
    }
    /// The models the engine has loaded now, as last read, for an engine type
    /// that serves several models at once and names none on its own: the
    /// list it carries in place of a single `model`. `None` (the default) is
    /// a single-model engine type. Read on every snapshot assembly; the
    /// adapter answers from its last read, without making a request.
    fn loaded_models(&self) -> Option<Vec<LoadedModel>> {
        None
    }
    /// Re-read what `loaded_models` answers from the engine. Called on every
    /// poll tick the engine passes its health check. A read that fails or
    /// times out keeps the last list: a slow answer must not empty an
    /// engine's models for a tick. Nothing to do for a single-model type.
    async fn refresh_loaded_models(&self) {}
    async fn health_check(&self) -> EngineStatus;
    async fn get_model_info(&self) -> ModelResolution;
    async fn get_metrics(&self) -> Option<EngineMetrics>;
}

// ---------------------------------------------------------------------------
// Grace period state machine (D-09, D-10)
// ---------------------------------------------------------------------------

/// Safety-net refresh interval for cached model info. Model identity is static
/// for a running engine, so re-resolving `/v1/models` this rarely is enough to
/// pick up an out-of-band model swap while dropping ~99.8% of the traffic.
const MODEL_REFRESH_INTERVAL: Duration = Duration::from_secs(600);

/// Retry cooldown when nothing resolved yet (e.g. auth-gated `/v1/models` with
/// no key and no command-line hint). Prevents a 1-second hot loop while still
/// recovering a still-starting engine reasonably quickly.
const MODEL_UNRESOLVED_RETRY: Duration = Duration::from_secs(30);

pub struct EngineState {
    pub adapter: Box<dyn EngineAdapter>,
    pub consecutive_failures: u32,
    pub last_seen: Instant,
    pub status: EngineStatus,
    pub stopped_at: Option<Instant>,
    pub deployment_mode: DeploymentMode,
    /// Last successfully resolved model info. Reused every poll tick instead of
    /// re-hitting `/v1/models`; invalidated on engine restart.
    pub cached_model: Option<ModelInfo>,
    /// Why the last fetch could not read metadata from the engine itself
    /// (`cached_model` is then absent or a command-line fallback). Cleared by
    /// the next fetch that resolves without error.
    pub model_metadata_error: Option<ModelMetadataError>,
    /// When `cached_model` was last populated — drives the 10-minute refresh.
    pub model_fetched_at: Option<Instant>,
    /// When a fetch was last attempted (success or unresolved) — drives the
    /// unresolved-retry cooldown.
    pub model_attempted_at: Option<Instant>,
    /// Host-namespace PIDs from the most recent detection tick. Empty for
    /// manual overrides until process/Docker detection also finds the engine.
    pub pids: Vec<u32>,
    /// Docker container id captured at detection time (Linux Docker scan only).
    /// Forwarded into each `EngineSnapshot` for the log viewer to consume.
    pub container_id: Option<String>,
}

impl EngineState {
    pub fn new(adapter: Box<dyn EngineAdapter>, deployment_mode: DeploymentMode) -> Self {
        Self {
            adapter,
            consecutive_failures: 0,
            last_seen: Instant::now(),
            status: EngineStatus::Running,
            stopped_at: None,
            deployment_mode,
            cached_model: None,
            model_metadata_error: None,
            model_fetched_at: None,
            model_attempted_at: None,
            pids: Vec::new(),
            container_id: None,
        }
    }

    /// Whether `/v1/models` should be hit on this poll tick. Returns `true`
    /// only when there is no cleanly resolved model and the unresolved
    /// cooldown has elapsed, or when the cached model is older than the
    /// refresh interval. A resolution that carried a metadata error is
    /// provisional even when it produced a name (the command-line fallback),
    /// so it retries on the short cooldown rather than being trusted for the
    /// full refresh interval — an operator who fixes the API key sees the
    /// warning clear within the cooldown, not after ten minutes.
    pub fn should_fetch_model(&self) -> bool {
        if self.model_metadata_error.is_some() {
            return match self.model_attempted_at {
                None => true,
                Some(attempted) => attempted.elapsed() >= MODEL_UNRESOLVED_RETRY,
            };
        }
        match (&self.cached_model, self.model_fetched_at) {
            (Some(_), Some(fetched)) => fetched.elapsed() >= MODEL_REFRESH_INTERVAL,
            (Some(_), None) => true,
            (None, _) => match self.model_attempted_at {
                None => true,
                Some(attempted) => attempted.elapsed() >= MODEL_UNRESOLVED_RETRY,
            },
        }
    }

    /// Record the outcome of a model-info fetch. Always stamps the attempt
    /// and the metadata error (so a clean fetch clears a stale warning);
    /// only updates the cache + refresh clock when something resolved. An
    /// errored fetch that produced no name keeps the last-known model
    /// visible, with the fresh error explaining why it may be stale.
    pub fn cache_model(&mut self, resolution: ModelResolution) {
        let now = Instant::now();
        self.model_attempted_at = Some(now);
        self.model_metadata_error = resolution.metadata_error;
        if resolution.model.is_some() {
            self.cached_model = resolution.model;
            self.model_fetched_at = Some(now);
        }
    }

    /// Drop the cached model so the next successful probe re-resolves it.
    fn invalidate_model_cache(&mut self) {
        self.cached_model = None;
        self.model_metadata_error = None;
        self.model_fetched_at = None;
        self.model_attempted_at = None;
    }

    /// Update state based on the result of a health probe.
    ///
    /// On success: reset failure counter, update last_seen, set Running.
    /// On failure: increment counter. If >= 3, transition to Stopped and
    /// record the moment we entered Stopped (only if not already stopped).
    pub fn record_probe_result(&mut self, success: bool) {
        if success {
            self.consecutive_failures = 0;
            self.last_seen = Instant::now();
            self.status = EngineStatus::Running;
            self.stopped_at = None;
        } else {
            self.consecutive_failures += 1;
            if self.consecutive_failures >= 3 {
                if self.stopped_at.is_none() {
                    self.stopped_at = Some(Instant::now());
                    // Engine left Running — treat a later recovery as a
                    // restart and re-resolve the model exactly once.
                    self.invalidate_model_cache();
                }
                self.status = EngineStatus::Stopped;
            }
        }
    }

    /// The snapshot this engine contributes to a poll tick. What it reports is
    /// whatever its adapter declares — the snapshot never decides that itself,
    /// but it holds the metrics to it: a field of a metric group the adapter
    /// does not declare goes on the wire empty (`EngineMetrics::reported_only`).
    fn snapshot(
        &self,
        status: EngineStatus,
        model: Option<ModelInfo>,
        metrics: Option<EngineMetrics>,
    ) -> EngineSnapshot {
        // The flag travels only while the engine is observed *running* with
        // metrics off: an engine that has since gone down must report as
        // offline, not as "running with metrics off" on the strength of a
        // latch from its last live scrape. Both parts come from the same
        // adapter state, so they cannot disagree.
        let metrics_off = match &status {
            EngineStatus::Running if self.adapter.metrics_off() => {
                self.adapter.metrics_launch_flag().map(str::to_string)
            }
            _ => None,
        };
        // The refusal travels on the same terms: a down engine reports
        // offline, not "refused the key" from its last live scrape.
        let metrics_error = match &status {
            EngineStatus::Running => self.adapter.metrics_error(),
            _ => None,
        };
        let metric_groups = self.adapter.metric_groups();
        // An engine that reports no group has no metrics to carry at all —
        // not an all-blank set whose `warming_up` flag could still say it is
        // warming up. Its tiles read "not reported", whatever the adapter
        // handed in.
        let metrics = metrics
            .filter(|_| !metric_groups.is_empty())
            .map(|m| m.reported_only(&metric_groups));
        EngineSnapshot {
            engine_type: self.adapter.engine_type(),
            endpoint: self.adapter.endpoint().to_string(),
            status,
            model,
            model_metadata_error: self.model_metadata_error,
            loaded_models: self.adapter.loaded_models(),
            metric_groups,
            metrics_off,
            metrics_error,
            metrics,
            recent_requests: Vec::new(),
            deployment_mode: self.deployment_mode.clone(),
            gpu_indexes: Vec::new(),
            pids: self.pids.clone(),
            container_id: self.container_id.clone(),
        }
    }

    /// One poll tick of this engine: probe its health, refresh what it says
    /// about its model(s) and metrics, and assemble its snapshot.
    async fn poll(&mut self) -> EngineSnapshot {
        let health = self.adapter.health_check().await;
        let success = matches!(health, EngineStatus::Running | EngineStatus::Loading);
        self.record_probe_result(success);

        // Use the health-check returned status for the snapshot
        // (may be more specific, e.g. Loading vs Running)
        let status = if success { health } else { self.status.clone() };

        // Model identity is static for a running engine, so only re-resolve
        // /v1/models on first success, after a restart, or on the 10-minute
        // safety net. During a transient blip keep the last-known model
        // visible. An engine still loading its model (llama.cpp answers 503
        // "Loading model" on every route) is asked once it runs, rather than
        // recorded as unavailable for the retry cooldown.
        if status == EngineStatus::Running && self.should_fetch_model() {
            let fetched = self.adapter.get_model_info().await;
            self.cache_model(fetched);
        }
        let model = self.cached_model.clone();

        let metrics = if success {
            self.adapter.get_metrics().await
        } else {
            None
        };

        // What an engine serving several models has loaded changes from one
        // tick to the next, so it is re-read on every tick the engine answers;
        // through a blip the last list stands, as the last model does above.
        if success {
            self.adapter.refresh_loaded_models().await;
        }

        self.snapshot(status, model, metrics)
    }

    /// Returns true when the engine has been in Stopped state for longer than
    /// 30 seconds, meaning it should be removed from the active engine list.
    pub fn should_remove(&self) -> bool {
        if let Some(stopped) = self.stopped_at {
            self.status == EngineStatus::Stopped && stopped.elapsed() > Duration::from_secs(30)
        } else {
            false
        }
    }
}

/// Clear the PID set of every engine the current detection pass did not see.
/// Their snapshots keep being emitted through the grace period, but matching
/// stale PIDs against NVML risks a wrong GPU badge once the OS recycles a PID.
fn clear_stale_pids(
    engine_map: &mut HashMap<(EngineType, String), EngineState>,
    detected_keys: &std::collections::HashSet<(EngineType, String)>,
) {
    for (key, state) in engine_map.iter_mut() {
        if !detected_keys.contains(key) {
            state.pids.clear();
        }
    }
}

// ---------------------------------------------------------------------------
// Manual override (D-11, D-12)
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct EngineOverride {
    pub engine_type: EngineType,
    pub endpoint: String,
    /// Optional bearer token for an auth-gated endpoint. Never printed.
    pub api_key: Option<String>,
}

// Manual Debug so the API key is never leaked into logs (the override list is
// logged with `{:?}` at startup).
impl std::fmt::Debug for EngineOverride {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EngineOverride")
            .field("engine_type", &self.engine_type)
            .field("endpoint", &self.endpoint)
            .field("api_key", &self.api_key.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

// ---------------------------------------------------------------------------
// API key resolution
// ---------------------------------------------------------------------------

/// Resolves the bearer token for an engine endpoint: an explicit per-endpoint
/// key wins, otherwise the global fallback (env / `--provider-api-key`).
#[derive(Clone, Default)]
pub struct ApiKeyResolver {
    per_endpoint: HashMap<String, String>,
    global: Option<String>,
}

impl ApiKeyResolver {
    /// Build from index-paired `--engine-url` / `--engine-api-key` vectors plus
    /// a global fallback. Extra keys (no matching URL) and empty keys are
    /// ignored.
    pub fn from_pairs(
        engine_urls: &[String],
        engine_api_keys: &[String],
        global: Option<String>,
    ) -> Self {
        let per_endpoint = engine_urls
            .iter()
            .zip(engine_api_keys.iter())
            .filter(|(_, k)| !k.is_empty())
            .map(|(url, key)| (url.clone(), key.clone()))
            .collect();
        Self {
            per_endpoint,
            global: global.filter(|g| !g.is_empty()),
        }
    }

    /// The key to use for `endpoint`, if any.
    pub fn resolve(&self, endpoint: &str) -> Option<String> {
        self.per_endpoint
            .get(endpoint)
            .cloned()
            .or_else(|| self.global.clone())
    }
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

pub fn create_adapter(
    engine_type: EngineType,
    endpoint: String,
    client: reqwest::Client,
    model_hint: Option<String>,
    api_key: Option<String>,
) -> Box<dyn EngineAdapter> {
    match engine_type {
        EngineType::Vllm => Box::new(vllm::VllmAdapter::new(
            client, endpoint, model_hint, api_key,
        )),
        EngineType::Sglang => Box::new(sglang::SglangAdapter::new(
            client, endpoint, model_hint, api_key,
        )),
        // Ollama names no model on its command line; what it has loaded comes
        // from its own API.
        EngineType::Ollama => Box::new(ollama::OllamaAdapter::new(client, endpoint, api_key)),
        EngineType::LlamaCpp => Box::new(llamacpp::LlamaCppAdapter::new(
            client, endpoint, model_hint, api_key,
        )),
        EngineType::Tensorfold => Box::new(tensorfold::TensorfoldAdapter::new(
            client, endpoint, model_hint, api_key,
        )),
    }
}

// ---------------------------------------------------------------------------
// Engine collector loop
// ---------------------------------------------------------------------------

/// Attaches a newly discovered container to an engine that had none, reporting
/// whether it changed anything.
///
/// The engine map assigns `container_id` only for a key it is inserting for the
/// first time, and an engine can exist before its container is known: one
/// configured with `--engine-url` is seeded before any detection has run at
/// all, and a containerized one can be found by its host process before the
/// Docker scan reaches it. Without this back-fill such an engine keeps
/// `container_id: None` for its whole life, and the log viewer — which resolves
/// an endpoint to a container through exactly this field — can never stream it.
///
/// An engine that already has a container keeps it: re-pointing a live log
/// stream at a different container mid-session is not something a detection
/// tick should do quietly.
fn adopt_container(state: &mut EngineState, container_id: Option<&str>) -> bool {
    if state.container_id.is_some() {
        return false;
    }
    let Some(id) = container_id else {
        return false;
    };

    state.container_id = Some(id.to_string());
    // Learning the container also settles where the engine runs — a manual
    // override is seeded as Native because nothing knew any better yet.
    state.deployment_mode = DeploymentMode::Docker;
    true
}

/// Runs the engine detection and metrics collection loop.
///
/// This function is spawned as a background tokio task. It:
/// 1. Detects engines every 5 seconds via process scan + Docker + API probe
/// 2. Polls each active engine every 1 second for health + metrics
/// 3. Resolves model info from `/v1/models` only on first success, then reuses
///    the cached value — re-resolving on engine restart or every 10 minutes
///    as a safety net (model identity is static for a running engine)
/// 4. Maintains grace period state (3 failures -> Stopped, 30s -> removed)
/// 5. Writes current snapshots into the shared `Arc<RwLock<Vec<EngineSnapshot>>>`
pub async fn engine_collector_loop(
    shared_snapshots: Arc<RwLock<Vec<EngineSnapshot>>>,
    overrides: Vec<EngineOverride>,
    api_keys: ApiKeyResolver,
) {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap_or_default();

    let mut sys = sysinfo::System::new();
    let mut engine_map: HashMap<(EngineType, String), EngineState> = HashMap::new();

    // Seed manual overrides into the engine map at startup (D-12)
    for ov in &overrides {
        let adapter = create_adapter(
            ov.engine_type.clone(),
            ov.endpoint.clone(),
            client.clone(),
            None,
            ov.api_key.clone(),
        );
        let key = (ov.engine_type.clone(), ov.endpoint.clone());
        engine_map.insert(key, EngineState::new(adapter, DeploymentMode::Native));
        tracing::info!(
            "Manual engine override registered: {} at {}",
            ov.engine_type,
            ov.endpoint
        );
    }

    let mut detection_interval = tokio::time::interval(Duration::from_secs(5));
    let mut poll_interval = tokio::time::interval(Duration::from_secs(1));

    loop {
        tokio::select! {
            _ = detection_interval.tick() => {
                // Refresh process list for scanning
                detector::refresh_process_table(&mut sys);

                let detected = detector::detect_engines(&sys, &client, &api_keys).await;

                // Add newly detected engines
                for d in &detected {
                    let key = (d.engine_type.clone(), d.endpoint.clone());
                    let state = engine_map.entry(key).or_insert_with(|| {
                        let adapter = create_adapter(
                            d.engine_type.clone(),
                            d.endpoint.clone(),
                            client.clone(),
                            d.served_model.clone(),
                            api_keys.resolve(&d.endpoint),
                        );
                        tracing::info!(
                            "Detected engine: {} at {} (model={:?})",
                            d.engine_type,
                            d.endpoint,
                            d.served_model,
                        );
                        let mut state =
                            EngineState::new(adapter, d.deployment_mode.clone());
                        state.container_id = d.container_id.clone();
                        state
                    });
                    // Refresh the PID set every detection tick — engines
                    // restart and fork workers over their lifetime.
                    state.pids = d.pids.clone();

                    if adopt_container(state, d.container_id.as_deref()) {
                        tracing::info!(
                            "Engine at {} resolved to container {:?}",
                            d.endpoint,
                            d.container_id,
                        );
                    }
                }

                // Engines absent from this pass (stopped, restarting, probe
                // blip) keep emitting snapshots through the grace period, but
                // their PIDs are stale — the OS may recycle one onto an
                // unrelated GPU process, turning the badge into a confident
                // wrong guess. Clear them: empty = unknown = no badge.
                let detected_keys: std::collections::HashSet<_> = detected
                    .iter()
                    .map(|d| (d.engine_type.clone(), d.endpoint.clone()))
                    .collect();
                clear_stale_pids(&mut engine_map, &detected_keys);
            }

            _ = poll_interval.tick() => {
                // Poll each active engine for health + metrics
                let mut snapshots = Vec::new();

                // Collect keys first to avoid borrow issues
                let keys: Vec<_> = engine_map.keys().cloned().collect();

                for key in &keys {
                    if let Some(state) = engine_map.get_mut(key) {
                        snapshots.push(state.poll().await);
                    }
                }

                // Remove engines that have exceeded the 30-second grace period
                engine_map.retain(|_key, state| !state.should_remove());

                // Write updated snapshots to shared state
                let mut lock = shared_snapshots.write().await;
                *lock = snapshots;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal adapter so `EngineState` can be constructed in tests. Only the
    /// identity and the declared metric groups are read; the probes are never
    /// exercised — the cache logic under test is pure.
    struct StubAdapter {
        groups: BTreeSet<MetricGroup>,
        /// Whether the adapter reports its metrics endpoint as switched off,
        /// and the flag that would switch it on (`None` = a type without a
        /// toggle, the trait default's shape).
        metrics_off: bool,
        flag: Option<&'static str>,
        /// Why the adapter's metrics endpoint refused the dashboard, as its
        /// last scrape found (`None` = it did not, the trait default's shape).
        metrics_error: Option<MetricsError>,
    }

    #[async_trait]
    impl EngineAdapter for StubAdapter {
        fn engine_type(&self) -> EngineType {
            EngineType::Vllm
        }
        fn endpoint(&self) -> &str {
            "http://stub:8000"
        }
        fn metric_groups(&self) -> BTreeSet<MetricGroup> {
            self.groups.clone()
        }
        async fn health_check(&self) -> EngineStatus {
            EngineStatus::Running
        }
        async fn get_model_info(&self) -> ModelResolution {
            ModelResolution::default()
        }
        async fn get_metrics(&self) -> Option<EngineMetrics> {
            None
        }
        fn metrics_launch_flag(&self) -> Option<&'static str> {
            self.flag
        }
        fn metrics_off(&self) -> bool {
            self.metrics_off
        }
        fn metrics_error(&self) -> Option<MetricsError> {
            self.metrics_error
        }
    }

    fn state() -> EngineState {
        state_reporting(MetricGroup::all())
    }

    /// An engine whose adapter declares exactly `groups`.
    fn state_reporting(groups: BTreeSet<MetricGroup>) -> EngineState {
        EngineState::new(
            Box::new(StubAdapter {
                groups,
                metrics_off: false,
                flag: None,
                metrics_error: None,
            }),
            DeploymentMode::Native,
        )
    }

    /// An adapter reporting metrics off behind a named flag, like SGLang
    /// without `--enable-metrics`.
    fn state_metrics_off() -> EngineState {
        EngineState::new(
            Box::new(StubAdapter {
                groups: MetricGroup::all(),
                metrics_off: true,
                flag: Some("--enable-metrics"),
                metrics_error: None,
            }),
            DeploymentMode::Native,
        )
    }

    /// An adapter whose metrics endpoint refused the dashboard for want of
    /// its API key, like llama-server started with `--api-key` and no key
    /// configured here.
    fn state_metrics_refused() -> EngineState {
        EngineState::new(
            Box::new(StubAdapter {
                groups: MetricGroup::all(),
                metrics_off: false,
                flag: None,
                metrics_error: Some(MetricsError::AuthRequired),
            }),
            DeploymentMode::Native,
        )
    }

    fn model(name: &str) -> ModelInfo {
        ModelInfo {
            name: name.to_string(),
            parameter_size: None,
            quantization: None,
            precision: None,
            tensor_type: None,
            model_type: None,
            pipeline_tag: None,
        }
    }

    /// A fetch that resolved cleanly from the engine's own endpoint.
    fn resolved(name: &str) -> ModelResolution {
        ModelResolution {
            model: Some(model(name)),
            metadata_error: None,
        }
    }

    /// A fetch that fell back to the command-line hint (or nothing) because
    /// `/v1/models` could not be read.
    fn errored(name: Option<&str>, error: ModelMetadataError) -> ModelResolution {
        ModelResolution {
            model: name.map(model),
            metadata_error: Some(error),
        }
    }

    /// Back-date an instant by `d`; relies on CI monotonic-clock uptime.
    fn ago(d: Duration) -> Instant {
        Instant::now()
            .checked_sub(d)
            .expect("monotonic clock has enough uptime for test")
    }

    #[test]
    fn fresh_state_fetches_model() {
        assert!(state().should_fetch_model());
    }

    #[test]
    fn cached_model_is_not_refetched_within_interval() {
        let mut s = state();
        s.cache_model(resolved("a/b"));
        assert!(!s.should_fetch_model());
    }

    #[test]
    fn cached_model_refetched_after_refresh_interval() {
        let mut s = state();
        s.cache_model(resolved("a/b"));
        s.model_fetched_at = Some(ago(MODEL_REFRESH_INTERVAL + Duration::from_secs(1)));
        assert!(s.should_fetch_model());
    }

    #[test]
    fn unresolved_model_respects_retry_cooldown() {
        let mut s = state();
        s.cache_model(ModelResolution::default());
        assert!(!s.should_fetch_model(), "within cooldown");
        s.model_attempted_at = Some(ago(MODEL_UNRESOLVED_RETRY + Duration::from_secs(1)));
        assert!(s.should_fetch_model(), "cooldown elapsed");
    }

    /// A fallback name that arrived with a metadata error is provisional: it
    /// must retry on the short unresolved cooldown, not sit on the 10-minute
    /// refresh interval — otherwise a fixed API key would leave the auth
    /// warning standing for up to ten minutes.
    #[test]
    fn errored_resolution_retries_on_unresolved_cooldown() {
        let mut s = state();
        s.cache_model(errored(Some("a/b"), ModelMetadataError::AuthRequired));
        assert_eq!(
            s.model_metadata_error,
            Some(ModelMetadataError::AuthRequired)
        );
        assert!(!s.should_fetch_model(), "within cooldown");
        s.model_attempted_at = Some(ago(MODEL_UNRESOLVED_RETRY + Duration::from_secs(1)));
        assert!(
            s.should_fetch_model(),
            "cooldown elapsed despite cached name"
        );
    }

    /// The warning clears as soon as a fetch resolves cleanly — a cached
    /// success must not keep showing a stale auth warning.
    #[test]
    fn clean_fetch_clears_metadata_error() {
        let mut s = state();
        s.cache_model(errored(Some("a/b"), ModelMetadataError::AuthRequired));
        s.cache_model(resolved("a/b"));
        assert_eq!(s.model_metadata_error, None);
        assert!(!s.should_fetch_model(), "clean result trusted again");
    }

    /// An errored fetch that produced no name (no command-line hint) keeps
    /// the last-known model visible; the fresh error explains why it may be
    /// stale.
    #[test]
    fn errored_fetch_without_name_keeps_last_known_model() {
        let mut s = state();
        s.cache_model(resolved("a/b"));
        s.cache_model(errored(None, ModelMetadataError::Unavailable));
        assert_eq!(
            s.cached_model.as_ref().map(|m| m.name.as_str()),
            Some("a/b")
        );
        assert_eq!(
            s.model_metadata_error,
            Some(ModelMetadataError::Unavailable)
        );
    }

    /// A restart invalidation drops the error along with the cached model —
    /// the re-resolved engine starts from a clean slate.
    #[test]
    fn restart_clears_metadata_error() {
        let mut s = state();
        s.cache_model(errored(Some("a/b"), ModelMetadataError::AuthRequired));
        s.record_probe_result(false);
        s.record_probe_result(false);
        s.record_probe_result(false);
        assert_eq!(s.model_metadata_error, None);
    }

    #[test]
    fn restart_invalidates_cached_model() {
        let mut s = state();
        s.cache_model(resolved("a/b"));
        assert!(!s.should_fetch_model());

        // 3 consecutive failures => Stopped => cache cleared once.
        s.record_probe_result(false);
        s.record_probe_result(false);
        s.record_probe_result(false);

        assert_eq!(s.status, EngineStatus::Stopped);
        assert!(s.cached_model.is_none());
        assert!(s.should_fetch_model());
    }

    #[test]
    fn successful_probe_keeps_model_cache() {
        let mut s = state();
        s.cache_model(resolved("a/b"));
        s.record_probe_result(true);
        assert!(s.cached_model.is_some());
        assert!(!s.should_fetch_model());
    }

    /// An adapter whose health the test sets tick by tick, counting how often
    /// `poll` asks it for its model. Asked while it loads, it answers as a
    /// loading engine does — no model, unavailable — and with its model once
    /// it runs.
    struct ScriptedAdapter {
        health: Arc<std::sync::Mutex<EngineStatus>>,
        model_asks: Arc<std::sync::atomic::AtomicUsize>,
    }

    #[async_trait]
    impl EngineAdapter for ScriptedAdapter {
        fn engine_type(&self) -> EngineType {
            EngineType::Vllm
        }
        fn endpoint(&self) -> &str {
            "http://scripted:8000"
        }
        fn metric_groups(&self) -> BTreeSet<MetricGroup> {
            MetricGroup::all()
        }
        async fn health_check(&self) -> EngineStatus {
            self.health.lock().unwrap().clone()
        }
        async fn get_model_info(&self) -> ModelResolution {
            self.model_asks
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            match *self.health.lock().unwrap() {
                EngineStatus::Running => resolved("a/b"),
                _ => errored(None, ModelMetadataError::Unavailable),
            }
        }
        async fn get_metrics(&self) -> Option<EngineMetrics> {
            None
        }
    }

    /// The model fetch waits for Running, whichever adapter is behind it: an
    /// engine reporting Loading is healthy, but not asked for its model — the
    /// answer would be "unavailable", held for the retry cooldown — and the
    /// first tick it reports Running, it is.
    #[tokio::test]
    async fn an_engine_still_loading_is_asked_for_its_model_once_it_runs() {
        let health = Arc::new(std::sync::Mutex::new(EngineStatus::Loading));
        let model_asks = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let asks = || model_asks.load(std::sync::atomic::Ordering::SeqCst);
        let mut s = EngineState::new(
            Box::new(ScriptedAdapter {
                health: health.clone(),
                model_asks: model_asks.clone(),
            }),
            DeploymentMode::Native,
        );

        for _ in 0..2 {
            let snapshot = s.poll().await;
            assert_eq!(snapshot.status, EngineStatus::Loading);
            assert!(snapshot.model.is_none());
            assert_eq!(snapshot.model_metadata_error, None);
        }
        assert_eq!(asks(), 0, "not asked while it loads");

        *health.lock().unwrap() = EngineStatus::Running;
        let snapshot = s.poll().await;
        assert_eq!(snapshot.status, EngineStatus::Running);
        assert_eq!(snapshot.model.map(|m| m.name).as_deref(), Some("a/b"));
        assert_eq!(snapshot.model_metadata_error, None);
        assert_eq!(asks(), 1, "asked the first tick it runs");
    }

    #[test]
    fn per_endpoint_key_wins_over_global() {
        let r = ApiKeyResolver::from_pairs(
            &["http://a:8000".into(), "http://b:8001".into()],
            &["key-a".into(), "key-b".into()],
            Some("global".into()),
        );
        assert_eq!(r.resolve("http://a:8000"), Some("key-a".into()));
        assert_eq!(r.resolve("http://b:8001"), Some("key-b".into()));
    }

    #[test]
    fn global_key_used_when_endpoint_unpaired() {
        let r = ApiKeyResolver::from_pairs(
            &["http://a:8000".into()],
            &["key-a".into()],
            Some("global".into()),
        );
        assert_eq!(r.resolve("http://detected:9000"), Some("global".into()));
    }

    #[test]
    fn no_key_resolves_to_none() {
        let r = ApiKeyResolver::from_pairs(&[], &[], None);
        assert_eq!(r.resolve("http://a:8000"), None);
    }

    #[test]
    fn empty_keys_are_ignored() {
        let r =
            ApiKeyResolver::from_pairs(&["http://a:8000".into()], &["".into()], Some("".into()));
        assert_eq!(r.resolve("http://a:8000"), None);
    }

    #[test]
    fn a_container_is_adopted_by_an_engine_that_had_none() {
        // The manual-override case: an engine configured with --engine-url is
        // seeded before detection has run, so it starts with no container and
        // its logs cannot be resolved until one is attached.
        let mut s = state();
        assert_eq!(s.container_id, None);
        assert_eq!(s.deployment_mode, DeploymentMode::Native);

        assert!(adopt_container(&mut s, Some("abc123")));

        assert_eq!(s.container_id.as_deref(), Some("abc123"));
        // Learning the container settles where the engine runs, too.
        assert_eq!(s.deployment_mode, DeploymentMode::Docker);
    }

    #[test]
    fn an_engine_keeps_the_container_it_already_has() {
        // Re-pointing a live log stream at another container mid-session is not
        // something a detection tick should do quietly.
        let mut s = state();
        adopt_container(&mut s, Some("first"));

        assert!(!adopt_container(&mut s, Some("second")));
        assert_eq!(s.container_id.as_deref(), Some("first"));
    }

    #[test]
    fn a_native_engine_is_left_alone_when_detection_reports_no_container() {
        let mut s = state();

        assert!(!adopt_container(&mut s, None));

        assert_eq!(s.container_id, None);
        assert_eq!(s.deployment_mode, DeploymentMode::Native);
    }

    #[test]
    fn stale_pids_cleared_for_engines_absent_from_detection() {
        let mut map: HashMap<(EngineType, String), EngineState> = HashMap::new();
        let seen_key = (EngineType::Vllm, "http://a:8000".to_string());
        let stale_key = (EngineType::Vllm, "http://b:8001".to_string());
        let mut seen = state();
        seen.pids = vec![100];
        let mut stale = state();
        stale.pids = vec![200];
        map.insert(seen_key.clone(), seen);
        map.insert(stale_key.clone(), stale);

        let detected_keys = std::collections::HashSet::from([seen_key.clone()]);
        clear_stale_pids(&mut map, &detected_keys);

        assert_eq!(map[&seen_key].pids, vec![100], "detected engine keeps PIDs");
        assert!(map[&stale_key].pids.is_empty(), "undetected engine cleared");
    }

    #[test]
    fn create_adapter_accepts_optional_key() {
        let client = reqwest::Client::new();
        let _with = create_adapter(
            EngineType::Vllm,
            "http://a:8000".into(),
            client.clone(),
            None,
            Some("k".into()),
        );
        let _without = create_adapter(EngineType::Vllm, "http://a:8000".into(), client, None, None);
    }

    /// The wire name of each group. Exhaustive on purpose: a new group does not
    /// compile here until it is given the name `METRIC_GROUPS` in
    /// `frontend/src/types/metrics.ts` mirrors.
    fn wire_name(group: MetricGroup) -> &'static str {
        match group {
            MetricGroup::Throughput => "Throughput",
            MetricGroup::BatchSize => "BatchSize",
            MetricGroup::ActiveRequests => "ActiveRequests",
            MetricGroup::RequestTotal => "RequestTotal",
            MetricGroup::Preemptions => "Preemptions",
            MetricGroup::QueueTime => "QueueTime",
            MetricGroup::KvCache => "KvCache",
            MetricGroup::PrefixCache => "PrefixCache",
            MetricGroup::SpeculativeDecoding => "SpeculativeDecoding",
            MetricGroup::TtftMean => "TtftMean",
            MetricGroup::TtftPercentiles => "TtftPercentiles",
            MetricGroup::E2eMean => "E2eMean",
            MetricGroup::E2ePercentiles => "E2ePercentiles",
            MetricGroup::ItlMean => "ItlMean",
            MetricGroup::ItlPercentiles => "ItlPercentiles",
            MetricGroup::TpotMean => "TpotMean",
            MetricGroup::TpotPercentiles => "TpotPercentiles",
        }
    }

    #[test]
    fn metric_groups_travel_under_the_names_the_frontend_mirrors() {
        for group in MetricGroup::ALL {
            assert_eq!(
                serde_json::to_value(group).unwrap(),
                serde_json::json!(wire_name(group)),
            );
        }
        // The seventeen, in the wire order `METRIC_GROUPS` mirrors.
        assert_eq!(
            serde_json::to_value(MetricGroup::ALL).unwrap(),
            serde_json::json!([
                "Throughput",
                "BatchSize",
                "ActiveRequests",
                "RequestTotal",
                "Preemptions",
                "QueueTime",
                "KvCache",
                "PrefixCache",
                "SpeculativeDecoding",
                "TtftMean",
                "TtftPercentiles",
                "E2eMean",
                "E2ePercentiles",
                "ItlMean",
                "ItlPercentiles",
                "TpotMean",
                "TpotPercentiles",
            ]),
        );
        assert_eq!(
            MetricGroup::all().len(),
            MetricGroup::ALL.len(),
            "ALL names each group exactly once",
        );
        // A set travels in declaration order, so `ALL` must list the groups
        // in that order too, or the two copies of the wire order disagree.
        assert_eq!(
            MetricGroup::ALL.to_vec(),
            MetricGroup::all().into_iter().collect::<Vec<_>>(),
            "ALL is in declaration order",
        );
    }

    /// The fields of each group as they travel on the wire, written out from
    /// the table in #142 rather than read back from `reported_only`, so the
    /// test pins the table instead of restating it. Exhaustive on purpose: a
    /// new group does not compile here until it is given its fields.
    fn fields_of(group: MetricGroup) -> &'static [&'static str] {
        match group {
            MetricGroup::Throughput => &[
                "tokens_per_sec",
                "avg_tokens_per_sec",
                "prompt_tokens_per_sec",
                "avg_prompt_tokens_per_sec",
                "total_prompt_tokens",
                "total_generation_tokens",
            ],
            MetricGroup::BatchSize => &["avg_batch_size"],
            MetricGroup::ActiveRequests => &["active_requests", "queued_requests"],
            MetricGroup::RequestTotal => &["total_requests"],
            MetricGroup::Preemptions => &["preemptions_total", "swapped_requests"],
            MetricGroup::QueueTime => &["queue_time_ms"],
            MetricGroup::KvCache => &["kv_cache_percent", "kv_cache_is_estimated"],
            MetricGroup::PrefixCache => &["prefix_cache_hit_rate", "prefix_cache_queries_total"],
            MetricGroup::SpeculativeDecoding => &[
                "spec_decode_draft_tokens_total",
                "spec_decode_accepted_tokens_total",
                "spec_decode_drafts_total",
                "spec_decode_acceptance_rate",
                "spec_decode_acceptance_rate_live",
                "spec_decode_mean_acceptance_length",
            ],
            MetricGroup::TtftMean => &["ttft_ms", "per_request_prompt_tps"],
            MetricGroup::TtftPercentiles => {
                &["ttft_percentiles", "ttft_buckets", "ttft_goodput_pct"]
            }
            MetricGroup::E2eMean => &["e2e_latency_ms"],
            MetricGroup::E2ePercentiles => &["e2e_percentiles", "e2e_buckets", "e2e_goodput_pct"],
            MetricGroup::ItlMean => &["inter_token_latency_ms"],
            MetricGroup::ItlPercentiles => &["itl_percentiles", "itl_buckets", "itl_goodput_pct"],
            MetricGroup::TpotMean => &["tpot_ms", "per_request_tps"],
            MetricGroup::TpotPercentiles => {
                &["tpot_percentiles", "tpot_buckets", "tpot_goodput_pct"]
            }
        }
    }

    /// Metrics with every field filled — each `Option` holds a value and each
    /// flag is `true` — so a field that survives `reported_only` differs from
    /// its default and one that is blanked does not.
    fn full_metrics() -> EngineMetrics {
        let percentiles = || {
            Some(LatencyPercentiles {
                p50_ms: Some(10.0),
                p95_ms: Some(20.0),
                p99_ms: Some(30.0),
            })
        };
        let buckets = || {
            Some(vec![HistogramBucket {
                le_seconds: 0.1,
                cumulative_count: 4.0,
            }])
        };
        EngineMetrics {
            tokens_per_sec: Some(30.0),
            avg_tokens_per_sec: Some(25.0),
            per_request_tps: Some(40.0),
            ttft_ms: Some(120.0),
            active_requests: Some(3),
            queued_requests: Some(1),
            kv_cache_percent: Some(42.0),
            kv_cache_is_estimated: true,
            total_requests: Some(100),
            e2e_latency_ms: Some(900.0),
            prompt_tokens_per_sec: Some(300.0),
            avg_prompt_tokens_per_sec: Some(280.0),
            per_request_prompt_tps: Some(500.0),
            swapped_requests: Some(2),
            prefix_cache_hit_rate: Some(60.0),
            queue_time_ms: Some(5.0),
            inter_token_latency_ms: Some(9.0),
            preemptions_total: Some(7),
            total_prompt_tokens: Some(10_000),
            total_generation_tokens: Some(2_000),
            prefix_cache_queries_total: Some(8_000),
            avg_batch_size: Some(12.0),
            ttft_percentiles: percentiles(),
            itl_percentiles: percentiles(),
            e2e_percentiles: percentiles(),
            ttft_goodput_pct: Some(99.0),
            itl_goodput_pct: Some(98.0),
            e2e_goodput_pct: Some(97.0),
            ttft_buckets: buckets(),
            itl_buckets: buckets(),
            e2e_buckets: buckets(),
            tpot_ms: Some(8.0),
            tpot_percentiles: percentiles(),
            tpot_goodput_pct: Some(96.0),
            tpot_buckets: buckets(),
            spec_decode_draft_tokens_total: Some(50),
            spec_decode_accepted_tokens_total: Some(30),
            spec_decode_drafts_total: Some(20),
            spec_decode_acceptance_rate: Some(60.0),
            spec_decode_acceptance_rate_live: Some(55.0),
            spec_decode_mean_acceptance_length: Some(1.5),
            warming_up: true,
        }
    }

    fn metrics_json(metrics: &EngineMetrics) -> serde_json::Value {
        serde_json::to_value(metrics).unwrap()
    }

    /// The wire names of the metric fields `metrics` still fills — those
    /// that differ from `EngineMetrics::default()` — leaving out
    /// `warming_up`, which is engine state rather than a metric.
    fn filled_fields(metrics: &EngineMetrics) -> BTreeSet<String> {
        let blank = metrics_json(&EngineMetrics::default());
        let json = metrics_json(metrics);
        json.as_object()
            .unwrap()
            .iter()
            .filter(|(key, value)| key.as_str() != "warming_up" && blank[key.as_str()] != **value)
            .map(|(key, _)| key.clone())
            .collect()
    }

    #[test]
    fn every_metric_field_belongs_to_exactly_one_group() {
        let every_field: BTreeSet<String> = metrics_json(&full_metrics())
            .as_object()
            .unwrap()
            .keys()
            .filter(|key| key.as_str() != "warming_up")
            .cloned()
            .collect();
        assert_eq!(
            filled_fields(&full_metrics()),
            every_field,
            "the fixture fills every field"
        );

        // Each group keeps exactly its own fields…
        for group in MetricGroup::ALL {
            let masked = full_metrics().reported_only(&BTreeSet::from([group]));
            let expected: BTreeSet<String> =
                fields_of(group).iter().map(|f| f.to_string()).collect();
            assert_eq!(filled_fields(&masked), expected, "{group:?}");
            assert!(masked.warming_up, "{group:?} keeps the warmup flag");
        }

        // …and the groups between them name every field, each exactly once:
        // a field added without a group fails here.
        let named: Vec<&str> = MetricGroup::ALL
            .into_iter()
            .flat_map(|group| fields_of(group).iter().copied())
            .collect();
        let union: BTreeSet<String> = named.iter().map(|f| f.to_string()).collect();
        assert_eq!(union.len(), named.len(), "no field is in two groups");
        assert_eq!(union, every_field, "every field is in a group");

        // Every group reported changes nothing; none reported blanks every
        // metric, the estimated flag included, and keeps the warmup flag.
        assert_eq!(
            metrics_json(&full_metrics().reported_only(&MetricGroup::all())),
            metrics_json(&full_metrics()),
        );
        let nothing = full_metrics().reported_only(&BTreeSet::new());
        assert_eq!(
            metrics_json(&nothing),
            metrics_json(&EngineMetrics {
                warming_up: true,
                ..EngineMetrics::default()
            }),
        );
    }

    #[test]
    fn a_snapshot_carries_the_groups_its_adapter_declares() {
        let partial = BTreeSet::from([MetricGroup::ItlMean, MetricGroup::Throughput]);
        let snapshot = state_reporting(partial.clone()).snapshot(EngineStatus::Running, None, None);

        assert_eq!(snapshot.metric_groups, partial);
        // On the wire as a list in declaration order, whatever order the
        // adapter built its set in — the frontend reads it as a set either way.
        let json = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(
            json["metric_groups"],
            serde_json::json!(["Throughput", "ItlMean"])
        );
    }

    #[test]
    fn a_snapshot_blanks_fields_of_groups_its_adapter_does_not_declare() {
        // Whatever the adapter put in a field, a group it does not declare
        // goes on the wire empty — the tile reads "not reported", never a
        // stray value beside a declaration that says otherwise.
        let snapshot = state_reporting(BTreeSet::from([MetricGroup::Throughput])).snapshot(
            EngineStatus::Running,
            None,
            Some(full_metrics()),
        );
        let metrics = &serde_json_value(&snapshot)["metrics"];

        assert_eq!(metrics["tokens_per_sec"], serde_json::json!(30.0));
        assert_eq!(metrics["tpot_ms"], serde_json::Value::Null);
        assert_eq!(metrics["total_requests"], serde_json::Value::Null);
        assert_eq!(metrics["kv_cache_is_estimated"], serde_json::json!(false));
        assert_eq!(metrics["warming_up"], serde_json::json!(true));
    }

    #[test]
    fn a_running_engine_with_metrics_off_carries_the_flag_until_it_stops_running() {
        // The distinct wire state travels through the real snapshot path,
        // naming the flag — the same shape #137 gave `metric_groups`, so a
        // future adapter with a different toggle only supplies its own flag.
        let json =
            serde_json_value(&state_metrics_off().snapshot(EngineStatus::Running, None, None));
        assert_eq!(json["metrics_off"], serde_json::json!("--enable-metrics"));

        // …and the flag does not outlive the engine: once the health check
        // stops succeeding, a down engine reports offline, never "running
        // with metrics off" from a latch of its last live scrape.
        for status in [EngineStatus::Stopped, EngineStatus::Loading] {
            let json = serde_json_value(&state_metrics_off().snapshot(status, None, None));
            assert_eq!(json["metrics_off"], serde_json::Value::Null);
        }

        // An engine whose metrics are on never carries the field at all.
        let json = serde_json_value(&state().snapshot(EngineStatus::Running, None, None));
        assert_eq!(json["metrics_off"], serde_json::Value::Null);
    }

    #[test]
    fn a_running_engine_with_metrics_error_carries_it_until_it_stops_running() {
        // The refusal travels through the real snapshot path in the wire
        // shape `model_metadata_error` already has, so the frontend says the
        // same thing about it: a key is missing, not metrics switched off.
        let json =
            serde_json_value(&state_metrics_refused().snapshot(EngineStatus::Running, None, None));
        assert_eq!(json["metrics_error"], serde_json::json!("AuthRequired"));
        assert_eq!(json["metrics_off"], serde_json::Value::Null);

        // …and, like `metrics_off`, it does not outlive the engine: a down
        // engine reports offline, never "refused the key" from a latch of
        // its last live scrape.
        for status in [EngineStatus::Stopped, EngineStatus::Loading] {
            let json = serde_json_value(&state_metrics_refused().snapshot(status, None, None));
            assert_eq!(json["metrics_error"], serde_json::Value::Null);
        }

        // An engine whose metrics answer carries the field as `null`.
        let json = serde_json_value(&state().snapshot(EngineStatus::Running, None, None));
        assert_eq!(json["metrics_error"], serde_json::Value::Null);
    }

    #[test]
    fn metrics_error_serializes_like_model_metadata_error() {
        // One wire vocabulary for "the dashboard lacks the engine's key",
        // whichever endpoint refused it.
        assert_eq!(
            serde_json::to_value(MetricsError::AuthRequired).unwrap(),
            serde_json::to_value(ModelMetadataError::AuthRequired).unwrap(),
        );
    }

    fn serde_json_value(snapshot: &EngineSnapshot) -> serde_json::Value {
        serde_json::to_value(snapshot).unwrap()
    }

    /// A single-model engine type carries `loaded_models` as `null` — the
    /// field is there, so the frontend can tell "uses `model`" from a backend
    /// that predates the field — and its snapshot is otherwise the shape it
    /// always was, but for the `metrics_error` every engine carries (`null`
    /// for these: none has had its metrics refused). Through the real
    /// adapters, so a type that grows a list shows up here.
    #[test]
    fn single_model_engines_carry_a_null_model_list_and_nothing_else_new() {
        let client = reqwest::Client::new();
        let adapters: [Box<dyn EngineAdapter>; 4] = [
            Box::new(vllm::VllmAdapter::new(
                client.clone(),
                "http://127.0.0.1:8000".into(),
                None,
                None,
            )),
            Box::new(sglang::SglangAdapter::new(
                client.clone(),
                "http://127.0.0.1:30000".into(),
                None,
                None,
            )),
            Box::new(llamacpp::LlamaCppAdapter::new(
                client.clone(),
                "http://127.0.0.1:9931".into(),
                None,
                None,
            )),
            Box::new(tensorfold::TensorfoldAdapter::new(
                client,
                "http://127.0.0.1:8080".into(),
                None,
                None,
            )),
        ];
        for adapter in adapters {
            let engine_type = adapter.engine_type();
            let state = EngineState::new(adapter, DeploymentMode::Native);
            let json = serde_json_value(&state.snapshot(EngineStatus::Running, None, None));
            let keys: Vec<&str> = json
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect();
            assert_eq!(
                keys,
                [
                    "deployment_mode",
                    "endpoint",
                    "engine_type",
                    "gpu_indexes",
                    "loaded_models",
                    "metric_groups",
                    "metrics",
                    "metrics_error",
                    "metrics_off",
                    "model",
                    "model_metadata_error",
                    "recent_requests",
                    "status",
                ],
                "{engine_type}"
            );
            assert_eq!(
                json["loaded_models"],
                serde_json::Value::Null,
                "{engine_type}"
            );
            assert_eq!(
                json["metrics_error"],
                serde_json::Value::Null,
                "{engine_type}"
            );
        }
    }

    /// An engine that reports no metric group carries no metrics: whatever
    /// its adapter handed in — even a set still flagged as warming up — the
    /// wire says nothing that could read as "warming up" or "no data yet",
    /// and every metric tile reads "not reported".
    #[test]
    fn an_engine_reporting_no_group_carries_no_metrics() {
        let warming = EngineMetrics {
            warming_up: true,
            ..full_metrics()
        };
        let snapshot =
            state_reporting(BTreeSet::new()).snapshot(EngineStatus::Running, None, Some(warming));
        let json = serde_json_value(&snapshot);
        assert_eq!(json["metric_groups"], serde_json::json!([]));
        assert_eq!(json["metrics"], serde_json::Value::Null);
        assert_eq!(json["metrics_off"], serde_json::Value::Null);
    }

    #[test]
    fn an_engine_reporting_nothing_says_so_rather_than_omitting_the_field() {
        // An absent field means "a backend older than metric groups", which the
        // frontend reads as every group; an engine with no metrics at all must
        // not be mistaken for that.
        let snapshot = state_reporting(BTreeSet::new()).snapshot(EngineStatus::Running, None, None);
        let json = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(json["metric_groups"], serde_json::json!([]));
    }
}
