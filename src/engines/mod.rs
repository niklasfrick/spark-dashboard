pub mod detector;
pub mod histogram;
pub mod prometheus;
pub mod vllm;
pub mod warmup;

use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq, Hash)]
pub enum EngineType {
    Vllm,
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

#[derive(Clone, Debug, serde::Serialize)]
pub struct ModelInfo {
    pub name: String,
    pub parameter_size: Option<String>,
    pub quantization: Option<String>,
    pub precision: Option<String>,
    pub tensor_type: Option<String>,
    pub model_type: Option<String>,
    pub pipeline_tag: Option<String>,
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
    /// True while the engine is still in warmup — histogram-derived fields
    /// (averages, percentiles, goodput, rates) are intentionally `None` so the
    /// first slow inference does not pollute steady-state metrics. See
    /// `engines::warmup` for the state machine.
    pub warming_up: bool,
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
    pub metrics: Option<EngineMetrics>,
    pub recent_requests: Vec<RecentRequest>,
    pub deployment_mode: DeploymentMode,
}

// ---------------------------------------------------------------------------
// Trait
// ---------------------------------------------------------------------------

#[async_trait]
pub trait EngineAdapter: Send + Sync {
    fn engine_type(&self) -> EngineType;
    fn endpoint(&self) -> &str;
    async fn health_check(&self) -> EngineStatus;
    async fn get_model_info(&self) -> Option<ModelInfo>;
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
    /// When `cached_model` was last populated — drives the 10-minute refresh.
    pub model_fetched_at: Option<Instant>,
    /// When a fetch was last attempted (success or unresolved) — drives the
    /// unresolved-retry cooldown.
    pub model_attempted_at: Option<Instant>,
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
            model_fetched_at: None,
            model_attempted_at: None,
        }
    }

    /// Whether `/v1/models` should be hit on this poll tick. Returns `true`
    /// only when there is no cached model and the unresolved cooldown has
    /// elapsed, or when the cached model is older than the refresh interval.
    pub fn should_fetch_model(&self) -> bool {
        match (&self.cached_model, self.model_fetched_at) {
            (Some(_), Some(fetched)) => fetched.elapsed() >= MODEL_REFRESH_INTERVAL,
            (Some(_), None) => true,
            (None, _) => match self.model_attempted_at {
                None => true,
                Some(attempted) => attempted.elapsed() >= MODEL_UNRESOLVED_RETRY,
            },
        }
    }

    /// Record the outcome of a model-info fetch. Always stamps the attempt;
    /// only updates the cache + refresh clock when something resolved.
    pub fn cache_model(&mut self, model: Option<ModelInfo>) {
        let now = Instant::now();
        self.model_attempted_at = Some(now);
        if model.is_some() {
            self.cached_model = model;
            self.model_fetched_at = Some(now);
        }
    }

    /// Drop the cached model so the next successful probe re-resolves it.
    fn invalidate_model_cache(&mut self) {
        self.cached_model = None;
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
    }
}

// ---------------------------------------------------------------------------
// Engine collector loop
// ---------------------------------------------------------------------------

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
                sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

                let detected = detector::detect_engines(&sys, &client).await;

                // Add newly detected engines
                for d in &detected {
                    let key = (d.engine_type.clone(), d.endpoint.clone());
                    engine_map.entry(key).or_insert_with(|| {
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
                        EngineState::new(adapter, d.deployment_mode.clone())
                    });
                }
            }

            _ = poll_interval.tick() => {
                // Poll each active engine for health + metrics
                let mut snapshots = Vec::new();

                // Collect keys first to avoid borrow issues
                let keys: Vec<_> = engine_map.keys().cloned().collect();

                for key in &keys {
                    if let Some(state) = engine_map.get_mut(key) {
                        let health = state.adapter.health_check().await;
                        let success = matches!(health, EngineStatus::Running | EngineStatus::Loading);
                        state.record_probe_result(success);

                        // Use the health-check returned status for the snapshot
                        // (may be more specific, e.g. Loading vs Running)
                        let status = if success { health } else { state.status.clone() };

                        // Model identity is static for a running engine, so
                        // only re-resolve /v1/models on first success, after a
                        // restart, or on the 10-minute safety net. During a
                        // transient blip keep the last-known model visible.
                        let model = if success {
                            if state.should_fetch_model() {
                                let fetched = state.adapter.get_model_info().await;
                                state.cache_model(fetched);
                            }
                            state.cached_model.clone()
                        } else {
                            state.cached_model.clone()
                        };

                        let metrics = if success {
                            state.adapter.get_metrics().await
                        } else {
                            None
                        };

                        snapshots.push(EngineSnapshot {
                            engine_type: state.adapter.engine_type(),
                            endpoint: state.adapter.endpoint().to_string(),
                            status,
                            model,
                            metrics,
                            recent_requests: Vec::new(),
                            deployment_mode: state.deployment_mode.clone(),
                        });
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

    /// Minimal adapter so `EngineState` can be constructed in tests. None of
    /// these are exercised — the cache logic under test is pure.
    struct StubAdapter;

    #[async_trait]
    impl EngineAdapter for StubAdapter {
        fn engine_type(&self) -> EngineType {
            EngineType::Vllm
        }
        fn endpoint(&self) -> &str {
            "http://stub:8000"
        }
        async fn health_check(&self) -> EngineStatus {
            EngineStatus::Running
        }
        async fn get_model_info(&self) -> Option<ModelInfo> {
            None
        }
        async fn get_metrics(&self) -> Option<EngineMetrics> {
            None
        }
    }

    fn state() -> EngineState {
        EngineState::new(Box::new(StubAdapter), DeploymentMode::Native)
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
        s.cache_model(Some(model("a/b")));
        assert!(!s.should_fetch_model());
    }

    #[test]
    fn cached_model_refetched_after_refresh_interval() {
        let mut s = state();
        s.cache_model(Some(model("a/b")));
        s.model_fetched_at = Some(ago(MODEL_REFRESH_INTERVAL + Duration::from_secs(1)));
        assert!(s.should_fetch_model());
    }

    #[test]
    fn unresolved_model_respects_retry_cooldown() {
        let mut s = state();
        s.cache_model(None);
        assert!(!s.should_fetch_model(), "within cooldown");
        s.model_attempted_at = Some(ago(MODEL_UNRESOLVED_RETRY + Duration::from_secs(1)));
        assert!(s.should_fetch_model(), "cooldown elapsed");
    }

    #[test]
    fn restart_invalidates_cached_model() {
        let mut s = state();
        s.cache_model(Some(model("a/b")));
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
        s.cache_model(Some(model("a/b")));
        s.record_probe_result(true);
        assert!(s.cached_model.is_some());
        assert!(!s.should_fetch_model());
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
}
