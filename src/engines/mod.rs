pub mod detector;
pub mod histogram;
pub mod prometheus;
pub mod vllm;

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
    /// Average tokens processed per engine iteration step (batch size proxy).
    pub avg_batch_size: Option<f64>,
    /// Tail latency percentiles for time-to-first-token (ms).
    pub ttft_percentiles: Option<LatencyPercentiles>,
    /// Tail latency percentiles for inter-token latency during decode (ms).
    pub itl_percentiles: Option<LatencyPercentiles>,
    /// Tail latency percentiles for end-to-end request latency (ms).
    pub e2e_percentiles: Option<LatencyPercentiles>,
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

pub struct EngineState {
    pub adapter: Box<dyn EngineAdapter>,
    pub consecutive_failures: u32,
    pub last_seen: Instant,
    pub status: EngineStatus,
    pub stopped_at: Option<Instant>,
    pub deployment_mode: DeploymentMode,
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
        }
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

#[derive(Clone, Debug)]
pub struct EngineOverride {
    pub engine_type: EngineType,
    pub endpoint: String,
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

pub fn create_adapter(
    engine_type: EngineType,
    endpoint: String,
    client: reqwest::Client,
    model_hint: Option<String>,
) -> Box<dyn EngineAdapter> {
    match engine_type {
        EngineType::Vllm => Box::new(vllm::VllmAdapter::new(client, endpoint, model_hint)),
    }
}

// ---------------------------------------------------------------------------
// Engine collector loop
// ---------------------------------------------------------------------------

/// Runs the engine detection and metrics collection loop.
///
/// This function is spawned as a background tokio task. It:
/// 1. Detects engines every 5 seconds via process scan + Docker + API probe
/// 2. Polls each active engine every 2 seconds for health, model info, metrics
/// 3. Maintains grace period state (3 failures -> Stopped, 30s -> removed)
/// 4. Writes current snapshots into the shared `Arc<RwLock<Vec<EngineSnapshot>>>`
pub async fn engine_collector_loop(
    shared_snapshots: Arc<RwLock<Vec<EngineSnapshot>>>,
    overrides: Vec<EngineOverride>,
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

                        let model = if success {
                            state.adapter.get_model_info().await
                        } else {
                            None
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
