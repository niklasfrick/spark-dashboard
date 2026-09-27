//! Splunk HEC metrics exporter.
//!
//! Subscribes to the same metrics broadcast channel as the local WebSocket UI
//! and POSTs each active snapshot to a HEC endpoint as one event per snapshot
//! in a JSON array (plus any queued backlog and buffered GPU events). Design
//! decisions live in `docs/adr/0001-splunk-hec-export.md`; the load-bearing
//! ones:
//!
//! - The UI broadcast is never paused or throttled for the exporter; a lagging
//!   exporter just skips ticks (`Lagged`), exactly like the WebSocket handler.
//! - "Drop while down": once the endpoint is unreachable, new metric
//!   snapshots are dropped immediately (no RAM growth during outages) and the
//!   outage is a hole in the index by design. GPU events are the exception —
//!   they are the page-worthy data and are buffered (bounded), flushed on
//!   recovery.
//! - Idle hosts export nothing: the silent gap in the index is the record of
//!   idleness. GPU events and engine model events are never idle-gated; model
//!   events fire only on first detection or model change.
//! - Idle hosts export nothing: the silent gap in the index is the record of
//!   idleness. The exception is the liveness probe, which doubles as a
//!   connection heartbeat — in every state it POSTs a
//!   `spark_dashboard.connectivity.test` marker every probe interval, so a
//!   healthy endpoint always has recent connectivity data.
//! - GPU events and engine model events are never idle-gated; model events
//!   fire only on first detection or model change.

//! - 403 (bad token) and 400 code 7 (index not allowed) count as *reachable* —
//!   the network is up; the configuration problem is surfaced through the
//!   status instead of masquerading as an outage.

use crate::engines::{EngineSnapshot, EngineType};
use crate::metrics::{gpu::GpuEvent, MetricsSnapshot};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{broadcast, Mutex, RwLock};

/// Per-POST deadline. A slow or wedged HEC must not stall the exporter loop.
pub const POST_TIMEOUT: Duration = Duration::from_secs(5);
/// Liveness probe / connection heartbeat cadence. Runs in every exporter
/// state, not just `Down`. Fixed by ADR 0001 (no backoff).
pub const PROBE_INTERVAL: Duration = Duration::from_secs(60);
/// "Recent" window for the idle gate, in milliseconds. Fixed by ADR 0001.
const IDLE_WINDOW_MS: u64 = 60_000;
/// Metric-event backlog cap; oldest is dropped when exceeded.
const METRIC_BACKLOG_CAP: usize = 1000;
/// GPU-event backlog cap. ADR 0001 wants "cap 1000, never dropped"; a bounded
/// buffer cannot honor both clauses at once, so the bound wins at the cap —
/// overflowing a thousand GPU fault records in one outage is beyond
/// plausibility.
const EVENT_BACKLOG_CAP: usize = 1000;

const SOURCE: &str = "spark-dashboard";
const METRICS_SOURCTYPE: &str = "spark_dashboard";
const EVENTS_SOURCTYPE: &str = "spark_dashboard_gpu_event";
const MODEL_EVENT_SOURCTYPE: &str = "spark_dashboard_engine_model";

fn default_index() -> String {
    "metrics".to_string()
}

fn default_events_index() -> String {
    "main".to_string()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// The `export.hec` section of the dashboard document. Presence of the
/// section means export is enabled; there is no `enabled` boolean.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct HecTarget {
    pub url: String,
    pub token: String,
    #[serde(default = "default_index")]
    pub index: String,
    #[serde(default = "default_events_index")]
    pub events_index: String,
}

impl HecTarget {
    /// A target that cannot possibly ingest: missing or non-HTTP URL. Treated
    /// as configured-but-misconfigured rather than "not configured", so the
    /// status surface can tell the operator what is wrong.
    pub fn usable(&self) -> bool {
        self.url.starts_with("https://") || self.url.starts_with("http://")
    }
}

/// Reads the `export.hec` section out of raw dashboard-document bytes.
/// `None` when the section is absent (export disabled) or the document cannot
/// be parsed at all.
pub fn hec_target_from_document(document: &[u8]) -> Option<HecTarget> {
    let value: Value = serde_json::from_slice(document).ok()?;
    let hec = value.get("export")?.get("hec")?;
    serde_json::from_value(hec.clone()).ok()
}

/// Masks a stored HEC token for display: last four characters behind an
/// ellipsis, e.g. `…abcd`.
pub fn mask_token(token: &str) -> String {
    let tail: Vec<char> = token.chars().rev().take(4).collect();
    format!("…{}", tail.iter().rev().cloned().collect::<String>())
}

/// Re-serializes the document with `export.hec.token` masked. `None` when the
/// document is not parseable JSON or carries no non-empty token — callers
/// then serve the original bytes untouched.
pub fn mask_token_in_document(document: &[u8]) -> Option<Vec<u8>> {
    let mut value: Value = serde_json::from_slice(document).ok()?;
    let token = value
        .get("export")?
        .get("hec")?
        .get("token")?
        .as_str()?
        .to_string();
    if token.is_empty() {
        return None;
    }
    value["export"]["hec"]["token"] = Value::String(mask_token(&token));
    serde_json::to_vec(&value).ok()
}

/// Merges a stored token into a document whose `export.hec` section is
/// present but carries an empty token (the client's "keep the stored token"
/// encoding). `None` when nothing needs merging; callers then store the
/// incoming bytes unchanged.
pub fn retain_token_in_document(new_document: &[u8], stored_token: &str) -> Option<Vec<u8>> {
    if stored_token.is_empty() {
        return None;
    }
    let mut value: Value = serde_json::from_slice(new_document).ok()?;
    let hec = value.get_mut("export")?.get_mut("hec")?;
    let token = hec.get("token")?.as_str()?;
    if !token.is_empty() {
        return None;
    }
    hec["token"] = Value::String(stored_token.to_string());
    serde_json::to_vec(&value).ok()
}

/// Body of `POST /api/export/test`: overrides for an in-progress edit session
/// in the settings dialog that has not been saved yet. A field left `None` (or
/// empty, or the `…`-masked token placeholder) falls back to the stored
/// target — same "cannot see it, cannot re-send it" contract as a save (see
/// [`retain_token_in_document`]), so testing an unsaved edit never requires
/// re-typing a token the dialog cannot display.
#[derive(Debug, Default, Deserialize)]
pub struct TestOverride {
    pub url: Option<String>,
    pub token: Option<String>,
    pub index: Option<String>,
}

/// Merges a test override over the stored target. `None` when there is
/// neither an override URL nor a stored one to fall back to — the caller
/// reports that as "misconfigured".
pub fn resolve_test_target(
    override_: TestOverride,
    stored: Option<&HecTarget>,
) -> Option<HecTarget> {
    let url = override_
        .url
        .filter(|u| !u.trim().is_empty())
        .or_else(|| stored.map(|t| t.url.clone()))?;
    let token = override_
        .token
        .filter(|t| !t.is_empty() && !t.starts_with('…'))
        .or_else(|| stored.map(|t| t.token.clone()))
        .unwrap_or_default();
    let index = override_
        .index
        .filter(|i| !i.trim().is_empty())
        .or_else(|| stored.map(|t| t.index.clone()))
        .unwrap_or_else(default_index);
    let events_index = stored
        .map(|t| t.events_index.clone())
        .unwrap_or_else(default_events_index);
    Some(HecTarget {
        url,
        token,
        index,
        events_index,
    })
}

// ---------------------------------------------------------------------------
// Export status
// ---------------------------------------------------------------------------

/// What the exporter is doing right now, as reported by `GET /api/export-status`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportState {
    /// No `export.hec` section in the document.
    Disabled,
    /// Configured, but the host is idle and nothing is being sent.
    Idle,
    /// Configured, active, and sending (or retrying a backlog).
    Exporting,
    /// Endpoint unreachable; metrics are dropped, GPU events buffered.
    Down,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct ExportStatus {
    pub state: ExportState,
    /// Endpoint reachable: the last HEC contact (ingest or probe) got an HTTP
    /// response. Rejections (403 / 400-7) do not clear this.
    pub reachable: bool,
    pub last_ok_ms: Option<u64>,
    /// Short machine-readable reason (`"hec-403"`, `"hec-400-index-denied"`,
    /// `"connection-failed"`, …); the UI owns the operator-facing copy.
    /// Never contains the token.
    pub last_error: Option<String>,
    /// Snapshots dropped by the idle gate, the down state, or backlog
    /// overflow. Operator-facing, not a debug counter.
    pub dropped_count: u64,
}

impl ExportStatus {
    pub fn disabled() -> Self {
        Self {
            state: ExportState::Disabled,
            reachable: false,
            last_ok_ms: None,
            last_error: None,
            dropped_count: 0,
        }
    }
}

pub type SharedExportStatus = Arc<Mutex<ExportStatus>>;
pub type SharedHecConfig = Arc<RwLock<Option<HecTarget>>>;

// ---------------------------------------------------------------------------
// Event building (pure)
// ---------------------------------------------------------------------------

/// The one HEC metrics event for a snapshot: `metric_name:*` fields in the
/// Splunk Metrics data model (Splunk ≥ 8.0), identity carried in the metric
/// name because a single event cannot carry per-metric `instance` values.
pub fn build_metric_event(snapshot: &MetricsSnapshot, host: &str, index: &str) -> Value {
    let mut fields: Map<String, Value> = Map::new();

    for gpu in &snapshot.gpus {
        let prefix = format!("metric_name:gpu{}.{}", gpu.index.unwrap_or(0), "");
        if let Some(v) = gpu.utilization_percent {
            fields.insert(format!("{prefix}utilization_pct"), Value::from(v as f64));
        }
        if let Some(v) = gpu.memory_used_bytes {
            fields.insert(format!("{prefix}memory_used_bytes"), Value::from(v as f64));
        }
        if let Some(v) = gpu.memory_total_bytes {
            fields.insert(format!("{prefix}memory_total_bytes"), Value::from(v as f64));
        }
        if let Some(v) = gpu.temperature_celsius {
            fields.insert(
                format!("{prefix}temperature_celsius"),
                Value::from(v as f64),
            );
        }
        if let Some(v) = gpu.power_watts {
            fields.insert(format!("{prefix}power_watts"), Value::from(v));
        }
    }

    fields.insert(
        "metric_name:cpu.utilization_pct".to_string(),
        Value::from(f64::from(snapshot.cpu.aggregate_percent)),
    );
    fields.insert(
        "metric_name:memory.used_bytes".to_string(),
        Value::from(snapshot.memory.used_bytes as f64),
    );
    fields.insert(
        "metric_name:memory.available_bytes".to_string(),
        Value::from(snapshot.memory.available_bytes as f64),
    );
    fields.insert(
        "metric_name:disk.read_bytes_per_sec".to_string(),
        Value::from(snapshot.disk.read_bytes_per_sec as f64),
    );
    fields.insert(
        "metric_name:disk.write_bytes_per_sec".to_string(),
        Value::from(snapshot.disk.write_bytes_per_sec as f64),
    );
    fields.insert(
        "metric_name:network.rx_bytes_per_sec".to_string(),
        Value::from(snapshot.network.rx_bytes_per_sec as f64),
    );
    fields.insert(
        "metric_name:network.tx_bytes_per_sec".to_string(),
        Value::from(snapshot.network.tx_bytes_per_sec as f64),
    );

    for engine in &snapshot.engines {
        let Some(metrics) = &engine.metrics else {
            continue;
        };
        let prefix = engine_type_key(&engine.engine_type);
        push_opt(
            &mut fields,
            &format!("{prefix}req_running"),
            metrics.active_requests.map(|v| v as f64),
        );
        push_opt(
            &mut fields,
            &format!("{prefix}req_waiting"),
            metrics.queued_requests.map(|v| v as f64),
        );
        push_opt(
            &mut fields,
            &format!("{prefix}tokens_per_sec"),
            metrics.tokens_per_sec,
        );
        push_opt(&mut fields, &format!("{prefix}ttft_ms"), metrics.ttft_ms);
        push_opt(
            &mut fields,
            &format!("{prefix}e2e_latency_ms"),
            metrics.e2e_latency_ms,
        );
        push_opt(
            &mut fields,
            &format!("{prefix}inter_token_latency_ms"),
            metrics.inter_token_latency_ms,
        );
        // Requests card: cumulative and scheduling counters.
        push_opt(
            &mut fields,
            &format!("{prefix}total_requests"),
            metrics.total_requests.map(|v| v as f64),
        );
        push_opt(
            &mut fields,
            &format!("{prefix}swapped_requests"),
            metrics.swapped_requests.map(|v| v as f64),
        );
        push_opt(
            &mut fields,
            &format!("{prefix}preemptions_total"),
            metrics.preemptions_total.map(|v| v as f64),
        );
        // Cache & Speculative Decoding card.
        push_opt(
            &mut fields,
            &format!("{prefix}kv_cache_percent"),
            metrics.kv_cache_percent,
        );
        push_opt(
            &mut fields,
            &format!("{prefix}prefix_cache_hit_rate"),
            metrics.prefix_cache_hit_rate,
        );
        push_opt(
            &mut fields,
            &format!("{prefix}prefix_cache_queries_total"),
            metrics.prefix_cache_queries_total.map(|v| v as f64),
        );
        push_opt(
            &mut fields,
            &format!("{prefix}spec_decode_acceptance_rate"),
            metrics.spec_decode_acceptance_rate,
        );
        push_opt(
            &mut fields,
            &format!("{prefix}spec_decode_acceptance_rate_live"),
            metrics.spec_decode_acceptance_rate_live,
        );
        push_opt(
            &mut fields,
            &format!("{prefix}spec_decode_mean_acceptance_length"),
            metrics.spec_decode_mean_acceptance_length,
        );
        push_opt(
            &mut fields,
            &format!("{prefix}spec_decode_accepted_tokens_total"),
            metrics.spec_decode_accepted_tokens_total.map(|v| v as f64),
        );
        push_opt(
            &mut fields,
            &format!("{prefix}spec_decode_draft_tokens_total"),
            metrics.spec_decode_draft_tokens_total.map(|v| v as f64),
        );
        // Throughput cards: prefill (prompt) and decode (generation) live
        // rates, running averages, per-request averages, and cumulative totals
        // ("Processed" / "Generated" on the cards). The totals are raw
        // engine-lifetime counters: they reset only when the engine restarts.
        push_opt(
            &mut fields,
            &format!("{prefix}prompt_tokens_per_sec"),
            metrics.prompt_tokens_per_sec,
        );
        push_opt(
            &mut fields,
            &format!("{prefix}avg_prompt_tokens_per_sec"),
            metrics.avg_prompt_tokens_per_sec,
        );
        push_opt(
            &mut fields,
            &format!("{prefix}per_request_prompt_tps"),
            metrics.per_request_prompt_tps,
        );
        push_opt(
            &mut fields,
            &format!("{prefix}total_prompt_tokens"),
            metrics.total_prompt_tokens.map(|v| v as f64),
        );
        push_opt(
            &mut fields,
            &format!("{prefix}avg_tokens_per_sec"),
            metrics.avg_tokens_per_sec,
        );
        push_opt(
            &mut fields,
            &format!("{prefix}per_request_tps"),
            metrics.per_request_tps,
        );
        push_opt(
            &mut fields,
            &format!("{prefix}total_generation_tokens"),
            metrics.total_generation_tokens.map(|v| v as f64),
        );
        // Latency card fields not covered by the original six, plus the
        // SLO goodput card. Percentile and raw histogram fields stay UI-only
        // (the frontend recomputes goodput/latency mode from them).
        push_opt(
            &mut fields,
            &format!("{prefix}queue_time_ms"),
            metrics.queue_time_ms,
        );
        push_opt(&mut fields, &format!("{prefix}tpot_ms"), metrics.tpot_ms);
        push_opt(
            &mut fields,
            &format!("{prefix}avg_batch_size"),
            metrics.avg_batch_size,
        );
        push_opt(
            &mut fields,
            &format!("{prefix}ttft_goodput_pct"),
            metrics.ttft_goodput_pct,
        );
        push_opt(
            &mut fields,
            &format!("{prefix}itl_goodput_pct"),
            metrics.itl_goodput_pct,
        );
        push_opt(
            &mut fields,
            &format!("{prefix}tpot_goodput_pct"),
            metrics.tpot_goodput_pct,
        );
        push_opt(
            &mut fields,
            &format!("{prefix}e2e_goodput_pct"),
            metrics.e2e_goodput_pct,
        );
    }

    json!({
        // `_time` from the host clock (the snapshot's own timestamp), never
        // HEC receive time — a delayed flush must not land at "now".
        "time": snapshot.timestamp_ms / 1000,
        "host": host,
        "source": SOURCE,
        "sourcetype": METRICS_SOURCTYPE,
        "index": index,
        // Splunk's multiple-measurement metrics format: "event" must be the
        // literal string "metric" and the metric_name:* fields go under
        // "fields", not "event" — a metrics-type index silently fails to
        // index anything sent without this marker.
        "event": "metric",
        "fields": fields,
    })
}

/// `metric_name:engine.<type>.` prefix for engine metrics, e.g.
/// `metric_name:engine.vllm.req_running`.
fn engine_type_key(engine_type: &EngineType) -> String {
    format!(
        "metric_name:engine.{}.",
        serde_json::to_value(engine_type)
            .ok()
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_default()
            .to_lowercase()
    )
}

fn push_opt(map: &mut Map<String, Value>, key: &str, value: Option<f64>) {
    if let Some(v) = value {
        map.insert(key.to_string(), Value::from(v));
    }
}

/// A GPU event (XID fault, thermal, …) as a plain JSON event for the
/// conventional `events_index`. Never a metric, never idle-gated.
pub fn build_gpu_event(event: &GpuEvent, host: &str, events_index: &str) -> Value {
    json!({
        "time": event.timestamp_ms / 1000,
        "host": host,
        "source": SOURCE,
        "sourcetype": EVENTS_SOURCTYPE,
        "index": events_index,
        "event": {
            "gpu_index": event.gpu_index,
            "event_type": event.event_type,
            "detail": event.detail,
        },
    })
}

/// An engine model event as a plain JSON event for the conventional
/// `events_index`. Never a metric, never idle-gated; the exporter emits one
/// per distinct model per endpoint (first detection and model changes).
/// `model_metadata_error` is `null` when the engine's own `/v1/models`
/// metadata resolved; otherwise it names why the `model_id` is only a
/// command-line fallback (provisional) and the operator should act.
pub fn build_engine_model_event(
    engine: &EngineSnapshot,
    host: &str,
    events_index: &str,
    timestamp_ms: u64,
) -> Option<Value> {
    let model = engine.model.as_ref()?;
    let engine_type = serde_json::to_value(&engine.engine_type)
        .ok()?
        .as_str()?
        .to_lowercase();
    // `ModelMetadataError` serializes to its unit-variant name (or null);
    // serialize through serde so the wire spelling stays the single source
    // of truth shared with the frontend.
    let metadata_error = serde_json::to_value(engine.model_metadata_error).ok();
    Some(json!({
        "time": timestamp_ms / 1000,
        "host": host,
        "source": SOURCE,
        "sourcetype": MODEL_EVENT_SOURCTYPE,
        "index": events_index,
        "event": {
            "engine_type": engine_type,
            "endpoint": engine.endpoint,
            "model_id": model.name,
            "parameter_size": model.parameter_size,
            "quantization": model.quantization,
            "precision": model.precision,
            "tensor_type": model.tensor_type,
            "model_type": model.model_type,
            "pipeline_tag": model.pipeline_tag,
            "model_metadata_error": metadata_error,
        },
    }))
}

/// Stable identity of the served model: name plus the descriptive fields that
/// can change on a model swap, plus the metadata-error state — a name that
/// only becomes trustworthy once the engine's own answer arrives (or stops
/// being a fallback) is a new state worth its own event. One event per
/// distinct signature per endpoint.
fn model_signature(engine: &EngineSnapshot) -> String {
    let Some(model) = &engine.model else {
        return String::new();
    };
    format!(
        "{}/{:?}/{:?}/{:?}/{:?}/{:?}/{:?}/{:?}",
        model.name,
        model.parameter_size,
        model.quantization,
        model.precision,
        model.tensor_type,
        model.model_type,
        model.pipeline_tag,
        engine.model_metadata_error
    )
}

/// The connectivity test event the settings dialog's Test button ingests.
pub fn build_test_event(host: &str, index: &str, now_ms: u64) -> Value {
    json!({
        "time": now_ms / 1000,
        "host": host,
        "source": SOURCE,
        "sourcetype": METRICS_SOURCTYPE,
        "index": index,
        "event": "metric",
        "fields": { "metric_name:spark_dashboard.connectivity.test": 1 },
    })
}

// ---------------------------------------------------------------------------
// Idle gate
// ---------------------------------------------------------------------------

/// Whether the host is actively doing inference work, per ADR 0001: active
/// when any engine reports running or queued requests, or any request started
/// or ended within the idle window. Fail-open: an engine whose `/metrics`
/// scrape is broken (counts unknown) counts as active, because a scrape error
/// must never silently stop the export. A host with no engines at all is
/// idle — the gate answers "is inference active?", and it is not.
pub fn is_active(snapshot: &MetricsSnapshot) -> bool {
    let cutoff = snapshot.timestamp_ms.saturating_sub(IDLE_WINDOW_MS);

    for engine in &snapshot.engines {
        let (active, queued) = match &engine.metrics {
            Some(metrics) => (metrics.active_requests, metrics.queued_requests),
            None => return true,
        };
        match (active, queued) {
            (Some(a), Some(q)) if a == 0 && q == 0 => {
                if engine
                    .recent_requests
                    .iter()
                    .any(|request| request.start_ms >= cutoff || request.end_ms >= cutoff)
                {
                    return true;
                }
            }
            _ => return true,
        }
    }

    false
}

// ---------------------------------------------------------------------------
// HEC I/O
// ---------------------------------------------------------------------------

/// What a HEC POST answered with.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum SendOutcome {
    /// Ingested (or nothing was sent).
    Ok,
    /// 429 / 5xx: the endpoint is alive but will not take data right now —
    /// queue and retry next tick.
    Retry,
    /// 401/403/400: the network is up, the configuration is not. Queueing
    /// would only churn the cap; surface the error and drop the batch.
    Misconfigured(String),
    /// DNS failure, refused connection, timeout: the endpoint is unreachable.
    Unreachable,
}

/// HEC error codes worth dedicated UI copy. HEC answers failures with a JSON
/// body `{"text": …, "code": N}`; code 7 means the token's `indexes`
/// allowlist does not include the requested index.
fn misconfigured_reason(status: u16, body: &str) -> String {
    if status == 403 {
        return "hec-403".to_string();
    }
    if status == 400 {
        if let Ok(parsed) = serde_json::from_str::<Value>(body) {
            if parsed.get("code").and_then(Value::as_i64) == Some(7) {
                return "hec-400-index-denied".to_string();
            }
        }
        return "hec-400".to_string();
    }
    if status == 401 {
        return "hec-401".to_string();
    }
    "hec-other".to_string()
}

/// Sends an array of events to the HEC endpoint. Any HTTP response — even a
/// rejection — proves the endpoint is alive, which is what the liveness
/// probe relies on.
pub async fn post_events(
    client: &reqwest::Client,
    target: &HecTarget,
    events: &[Value],
) -> SendOutcome {
    let response = client
        .post(&target.url)
        .header("Authorization", format!("Splunk {}", target.token))
        .header("Content-Type", "application/json")
        .body(serde_json::to_string(&events).expect("events serialize"))
        .send()
        .await;

    match response {
        Ok(response) => {
            let status = response.status().as_u16();
            if (200..300).contains(&status) {
                return SendOutcome::Ok;
            }
            if status == 429 || status >= 500 {
                return SendOutcome::Retry;
            }
            let body = response.text().await.unwrap_or_default();
            SendOutcome::Misconfigured(misconfigured_reason(status, &body))
        }
        Err(_) => SendOutcome::Unreachable,
    }
}

// ---------------------------------------------------------------------------
// Exporter task
// ---------------------------------------------------------------------------

enum Tick {
    Json(String),
    Lagged,
    ProbeDue,
}

/// Mutable state of the exporter loop: where the state machine stands, what
/// the status surface publishes, and what waits to be sent.
struct Exporter {
    state: ExportState,
    reachable: bool,
    last_ok_ms: Option<u64>,
    last_error: Option<String>,
    dropped: u64,
    next_probe: Instant,
    /// Metric events awaiting retry on the next tick.
    backlog: VecDeque<Value>,
    /// GPU events awaiting send.
    events: VecDeque<Value>,
    /// (endpoint, model signature) pairs already recorded — model events
    /// fire once per distinct model per endpoint.
    known_models: Vec<(String, String)>,
}

impl Exporter {
    fn new(probe_interval: Duration) -> Self {
        Self {
            state: ExportState::Disabled,
            reachable: false,
            last_ok_ms: None,
            last_error: None,
            dropped: 0,
            next_probe: Instant::now() + probe_interval,
            backlog: VecDeque::new(),
            events: VecDeque::new(),
            known_models: Vec::new(),
        }
    }

    fn status(&self) -> ExportStatus {
        ExportStatus {
            state: self.state,
            reachable: self.reachable,
            last_ok_ms: self.last_ok_ms,
            last_error: self.last_error.clone(),
            dropped_count: self.dropped,
        }
    }

    /// Enters `Down`: the caller already attempted the best-effort final
    /// flush; from here new metric snapshots are dropped until a probe
    /// succeeds.
    fn enter_down(&mut self, probe_interval: Duration) {
        self.backlog.clear();
        self.state = ExportState::Down;
        self.reachable = false;
        self.last_error = Some("connection-failed".to_string());
        self.next_probe = Instant::now() + probe_interval;
        tracing::warn!("HEC endpoint unreachable; dropping metrics until the next liveness probe");
    }

    fn push_backlog(&mut self, batch: Vec<Value>) {
        for event in batch {
            if self.backlog.len() >= METRIC_BACKLOG_CAP {
                self.backlog.pop_front();
                self.dropped += 1;
            }
            self.backlog.push_back(event);
        }
    }

    fn push_event(&mut self, event: Value) {
        if self.events.len() >= EVENT_BACKLOG_CAP {
            self.events.pop_front();
        }
        self.events.push_back(event);
    }
}

/// Runs the exporter loop. Spawned once from `main` with a second subscriber
/// on the metrics broadcast channel. `probe_interval` is a parameter so tests
/// do not wait a minute between liveness probes; production passes
/// [`PROBE_INTERVAL`].
pub async fn run_exporter(
    mut rx: broadcast::Receiver<String>,
    config: SharedHecConfig,
    status: SharedExportStatus,
    host: String,
    probe_interval: Duration,
) {
    let client = reqwest::Client::builder()
        .timeout(POST_TIMEOUT)
        .build()
        .expect("reqwest client");
    let mut exporter = Exporter::new(probe_interval);

    loop {
        // The liveness probe competes with the tick stream in every state:
        // an idle host drops its ticks without POSTing, so a steady tick
        // stream alone would starve the probe, and a silent host must still
        // get probed.
        let wait = tokio::time::sleep_until(exporter.next_probe.into());
        tokio::pin!(wait);
        let tick = tokio::select! {
            res = rx.recv() => match res {
                Ok(json) => Tick::Json(json),
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    tracing::debug!(skipped, "HEC exporter lagged behind the metrics broadcast");
                    Tick::Lagged
                }
                Err(broadcast::error::RecvError::Closed) => {
                    tracing::info!("metrics broadcast closed, shutting down HEC exporter");
                    break;
                }
            },
            () = &mut wait => match rx.try_recv() {
                Ok(json) => Tick::Json(json),
                Err(broadcast::error::TryRecvError::Lagged(skipped)) => {
                    tracing::debug!(skipped, "HEC exporter lagged behind the metrics broadcast");
                    Tick::Lagged
                }
                Err(broadcast::error::TryRecvError::Empty) => Tick::ProbeDue,
                Err(broadcast::error::TryRecvError::Closed) => {
                    tracing::info!("metrics broadcast closed, shutting down HEC exporter");
                    break;
                }
            },
        };

        if let Tick::Json(json) = tick {
            let target = config.read().await.clone().filter(|t| t.usable());
            let Some(target) = target else {
                exporter.state = ExportState::Disabled;
                exporter.last_error = None;
                publish(&status, &exporter).await;
                continue;
            };

            let Ok(snapshot) = serde_json::from_str::<MetricsSnapshot>(&json) else {
                continue;
            };

            // GPU events are never idle-gated and are buffered even while
            // down — they are the page-worthy data.
            for event in &snapshot.gpu_events {
                exporter.push_event(build_gpu_event(event, &host, &target.events_index));
            }

            // Engine model events: same treatment as GPU events (never
            // idle-gated, buffered while down), but emitted only on first
            // detection or model change — the record of which model was
            // serving when.
            for engine in &snapshot.engines {
                let Some(event) = build_engine_model_event(
                    engine,
                    &host,
                    &target.events_index,
                    snapshot.timestamp_ms,
                ) else {
                    continue;
                };
                let signature = model_signature(engine);
                let known = exporter
                    .known_models
                    .iter()
                    .any(|(endpoint, sig)| *endpoint == engine.endpoint && *sig == signature);
                if !known {
                    exporter
                        .known_models
                        .push((engine.endpoint.clone(), signature));
                    exporter.push_event(event);
                    tracing::info!(endpoint = %engine.endpoint, "engine model detected or changed; recording to HEC");
                }
            }

            if !is_active(&snapshot) {
                // Idle: the snapshot is dropped before queueing; the gap in
                // the index is the record of idleness. A host that is idle
                // and Down stays Down — the outage is the more severe fact.
                if exporter.state != ExportState::Down {
                    exporter.state = ExportState::Idle;
                }
                exporter.dropped += 1;
                publish(&status, &exporter).await;
                continue;
            }

            if exporter.state == ExportState::Down {
                // Drop while down: no RAM growth during an outage.
                exporter.dropped += 1;
                publish(&status, &exporter).await;
                continue;
            }

            let mut batch: Vec<Value> = exporter.backlog.drain(..).collect();
            batch.push(build_metric_event(&snapshot, &host, &target.index));

            match post_events(&client, &target, &batch).await {
                SendOutcome::Ok => {
                    exporter.state = ExportState::Exporting;
                    exporter.reachable = true;
                    exporter.last_ok_ms = Some(now_ms());
                    exporter.last_error = None;
                    flush_events(&client, &target, &mut exporter, probe_interval).await;
                }
                SendOutcome::Retry => {
                    exporter.push_backlog(batch);
                    exporter.state = ExportState::Exporting;
                    exporter.reachable = true;
                    exporter.last_error = Some("hec-429-or-5xx".to_string());
                }
                SendOutcome::Misconfigured(reason) => {
                    // Configuration problem, not an outage: nothing queued
                    // will succeed until the operator fixes it.
                    exporter.state = ExportState::Exporting;
                    exporter.reachable = true;
                    exporter.last_error = Some(reason);
                    exporter.dropped += batch.len() as u64;
                }
                SendOutcome::Unreachable => {
                    // One best-effort final flush, then drop-while-down.
                    let _ = post_events(&client, &target, &batch).await;
                    exporter.enter_down(probe_interval);
                    exporter.dropped += batch.len() as u64;
                }
            }

            publish(&status, &exporter).await;
            continue;
        }

        if let Tick::ProbeDue = tick {
            // Liveness probe doubled as a connection heartbeat: it POSTs a
            // `spark_dashboard.connectivity.test` marker, so a healthy
            // endpoint ingests one every probe interval no matter how idle
            // the host is, and any HTTP response — even a rejection — proves
            // the endpoint is alive.
            let target = config.read().await.clone().filter(|t| t.usable());
            if let Some(target) = target {
                let heartbeat = build_test_event(&host, &target.index, now_ms());
                match post_events(&client, &target, &[heartbeat]).await {
                    SendOutcome::Unreachable => {
                        // While Down this is the expected repeat failure;
                        // from Exporting or Idle the probe is the first sign
                        // of an outage — nothing to flush, just drop.
                        if exporter.state != ExportState::Down {
                            exporter.enter_down(probe_interval);
                        }
                    }
                    SendOutcome::Ok => {
                        // A Down exporter recovers the data path; an Idle or
                        // Exporting one keeps its state — the heartbeat
                        // proves the connection, it does not claim to
                        // export metrics.
                        if exporter.state == ExportState::Down {
                            exporter.state = ExportState::Exporting;
                        }
                        exporter.reachable = true;
                        exporter.last_error = None;
                        exporter.last_ok_ms = Some(now_ms());
                        flush_events(&client, &target, &mut exporter, probe_interval).await;
                    }
                    // The endpoint answered, so it is reachable and no
                    // longer Down — but a 401/403/400-7/429/5xx is not a
                    // success. Recording it as one (the old blanket `_` arm
                    // here) cleared last_error and stamped last_ok_ms on a
                    // rejected probe, so the status surface reported healthy
                    // while every real ingest kept failing the same way.
                    SendOutcome::Retry => {
                        if exporter.state == ExportState::Down {
                            exporter.state = ExportState::Exporting;
                        }
                        exporter.reachable = true;
                        exporter.last_error = Some("hec-429-or-5xx".to_string());
                    }
                    SendOutcome::Misconfigured(reason) => {
                        if exporter.state == ExportState::Down {
                            exporter.state = ExportState::Exporting;
                        }
                        exporter.reachable = true;
                        exporter.last_error = Some(reason);
                    }
                }
            } else {
                exporter.state = ExportState::Disabled;
                exporter.last_error = None;
            }
            publish(&status, &exporter).await;
            exporter.next_probe = Instant::now() + probe_interval;
            continue;
        }

        // Tick::Lagged — nothing to do; the next snapshot is fresh data.
    }
}

async fn publish(status: &SharedExportStatus, exporter: &Exporter) {
    let mut current = status.lock().await;
    *current = exporter.status();
}

/// Sends buffered GPU events after a confirmed contact. Only a retryable
/// outcome requeues; a misconfiguration will not succeed on the next attempt
/// either, so the batch is dropped with the reason surfaced.
async fn flush_events(
    client: &reqwest::Client,
    target: &HecTarget,
    exporter: &mut Exporter,
    probe_interval: Duration,
) {
    if exporter.events.is_empty() {
        return;
    }
    let flushed: Vec<Value> = exporter.events.drain(..).collect();
    match post_events(client, target, &flushed).await {
        SendOutcome::Ok => {
            exporter.last_ok_ms = Some(now_ms());
        }
        SendOutcome::Retry => {
            for event in flushed {
                exporter.push_event(event);
            }
        }
        SendOutcome::Misconfigured(reason) => exporter.last_error = Some(reason),
        SendOutcome::Unreachable => exporter.enter_down(probe_interval),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engines::{
        EngineMetrics, EngineSnapshot, EngineStatus, EngineType, ModelInfo, ModelMetadataError,
        RecentRequest,
    };
    use crate::metrics::{CpuMetrics, DiskMetrics, GpuMetrics, MemoryMetrics, NetworkMetrics};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc as StdArc, Mutex as StdMutex};

    fn snapshot(overrides: impl FnOnce(&mut MetricsSnapshot)) -> MetricsSnapshot {
        let mut s = MetricsSnapshot {
            timestamp_ms: 1_723_800_000_000,
            gpu: empty_gpu(0),
            gpus: vec![empty_gpu(0)],
            cpu: CpuMetrics {
                name: None,
                aggregate_percent: 12.5,
                per_core: vec![],
            },
            memory: MemoryMetrics {
                total_bytes: 10,
                display_total_bytes: 10,
                used_bytes: 4,
                available_bytes: 6,
                cached_bytes: 0,
                gpu_estimated_bytes: None,
                gpu_memory_total_bytes: None,
                gpu_memory_used_bytes: None,
                is_unified: false,
            },
            disk: DiskMetrics {
                name: None,
                read_bytes_per_sec: 1,
                write_bytes_per_sec: 2,
            },
            network: NetworkMetrics {
                name: None,
                rx_bytes_per_sec: 3,
                tx_bytes_per_sec: 4,
            },
            engines: vec![],
            gpu_events: vec![],
        };
        overrides(&mut s);
        s
    }

    fn empty_gpu(index: u32) -> GpuMetrics {
        GpuMetrics {
            index: Some(index),
            name: None,
            utilization_percent: Some(87),
            memory_total_bytes: Some(96 << 30),
            memory_used_bytes: Some(10 << 30),
            temperature_celsius: Some(42),
            power_watts: Some(142.5),
            power_limit_watts: None,
            clock_graphics_mhz: None,
            clock_sm_mhz: None,
            clock_memory_mhz: None,
            fan_speed_percent: None,
        }
    }

    fn engine_with(active: Option<u64>, queued: Option<u64>) -> EngineSnapshot {
        EngineSnapshot {
            engine_type: EngineType::Vllm,
            endpoint: "http://127.0.0.1:8000".into(),
            status: EngineStatus::Running,
            model: None,
            model_metadata_error: None,
            metrics: Some(EngineMetrics {
                active_requests: active,
                queued_requests: queued,
                ..EngineMetrics::default()
            }),
            recent_requests: vec![],
            deployment_mode: crate::engines::DeploymentMode::Native,
            gpu_indexes: vec![],
            pids: vec![],
            container_id: None,
        }
    }

    fn target() -> HecTarget {
        HecTarget {
            url: "http://127.0.0.1:1/collector".into(),
            token: "secret-token".into(),
            index: "metrics".into(),
            events_index: "main".into(),
        }
    }

    // -- configuration document parsing ------------------------------------

    #[test]
    fn a_document_without_the_export_section_is_disabled() {
        assert_eq!(hec_target_from_document(b"{}"), None);
        assert_eq!(hec_target_from_document(b"not json at all"), None);
        assert_eq!(
            hec_target_from_document(b"{\"version\":1,\"pages\":[]}"),
            None
        );
    }

    #[test]
    fn the_export_section_parses_with_index_defaults() {
        let document = b"{\"export\":{\"hec\":{\"url\":\"https://splunk:8088/services/collector\",\"token\":\"t-123\"}}}";
        let target = hec_target_from_document(document).unwrap();
        assert_eq!(target.url, "https://splunk:8088/services/collector");
        assert_eq!(target.token, "t-123");
        assert_eq!(target.index, "metrics");
        assert_eq!(target.events_index, "main");
    }

    #[test]
    fn the_export_section_honors_explicit_index_overrides() {
        let document = b"{\"export\":{\"hec\":{\"url\":\"https://x\",\"token\":\"t\",\"index\":\"m2\",\"events_index\":\"ev2\"}}}";
        let target = hec_target_from_document(document).unwrap();
        assert_eq!(target.index, "m2");
        assert_eq!(target.events_index, "ev2");
    }

    // -- token masking / retention ------------------------------------------

    #[test]
    fn mask_token_keeps_the_last_four_characters() {
        assert_eq!(mask_token("secret-token-12345"), "…2345");
        assert_eq!(mask_token("ab"), "…ab");
    }

    #[test]
    fn mask_token_in_document_masks_only_the_token() {
        let document = b"{\"version\":1,\"pages\":[{\"name\":\"Overview\"}],\"export\":{\"hec\":{\"url\":\"https://x\",\"token\":\"super-secret\",\"index\":\"metrics\"}}}";
        let masked = mask_token_in_document(document).unwrap();
        let value: Value = serde_json::from_slice(&masked).unwrap();
        assert_eq!(value["export"]["hec"]["token"], "…cret");
        assert_eq!(value["export"]["hec"]["url"], "https://x");
        assert_eq!(value["pages"][0]["name"], "Overview");
        assert_eq!(value["version"], 1);
    }

    #[test]
    fn mask_token_in_document_leaves_other_documents_alone() {
        assert_eq!(mask_token_in_document(b"not json"), None);
        assert_eq!(mask_token_in_document(b"{}"), None);
        // Empty token: nothing to mask, and masking it would invent one.
        assert_eq!(
            mask_token_in_document(
                b"{\"export\":{\"hec\":{\"url\":\"https://x\",\"token\":\"\"}}}"
            ),
            None
        );
    }

    #[test]
    fn retain_token_in_document_fills_an_empty_token_from_the_stored_one() {
        let stored = "stored-token-abc";
        let incoming = b"{\"export\":{\"hec\":{\"url\":\"https://x\",\"token\":\"\"}}}";
        let merged = retain_token_in_document(incoming, stored).unwrap();
        let value: Value = serde_json::from_slice(&merged).unwrap();
        assert_eq!(value["export"]["hec"]["token"], stored);
    }

    #[test]
    fn retain_token_in_document_never_overwrites_a_fresh_token() {
        let incoming = b"{\"export\":{\"hec\":{\"url\":\"https://x\",\"token\":\"brand-new\"}}}";
        assert_eq!(retain_token_in_document(incoming, "old-token"), None);
    }

    #[test]
    fn retain_token_in_document_is_inert_without_a_stored_token_or_section() {
        let incoming = b"{\"export\":{\"hec\":{\"url\":\"https://x\",\"token\":\"\"}}}";
        assert_eq!(retain_token_in_document(incoming, ""), None);
        assert_eq!(
            retain_token_in_document(b"{\"version\":1}", "stored-token"),
            None
        );
    }

    // -- test-connection override merging ------------------------------------

    #[test]
    fn resolve_test_target_prefers_the_override_over_the_stored_target() {
        let stored = target();
        let override_ = TestOverride {
            url: Some("https://new-host:8088/services/collector".into()),
            token: Some("fresh-token".into()),
            index: Some("new-index".into()),
        };
        let resolved = resolve_test_target(override_, Some(&stored)).unwrap();
        assert_eq!(resolved.url, "https://new-host:8088/services/collector");
        assert_eq!(resolved.token, "fresh-token");
        assert_eq!(resolved.index, "new-index");
        // events_index has no dialog field to override; it always tracks storage.
        assert_eq!(resolved.events_index, stored.events_index);
    }

    #[test]
    fn resolve_test_target_falls_back_to_the_stored_token_when_masked_or_empty() {
        let stored = target();
        let masked = TestOverride {
            url: Some("https://new-host:8088/services/collector".into()),
            token: Some("…oken".into()),
            index: None,
        };
        assert_eq!(
            resolve_test_target(masked, Some(&stored)).unwrap().token,
            stored.token
        );

        let empty = TestOverride {
            url: Some("https://new-host:8088/services/collector".into()),
            token: Some(String::new()),
            index: None,
        };
        assert_eq!(
            resolve_test_target(empty, Some(&stored)).unwrap().token,
            stored.token
        );
    }

    #[test]
    fn resolve_test_target_is_misconfigured_without_any_url() {
        assert_eq!(resolve_test_target(TestOverride::default(), None), None);
    }

    #[test]
    fn resolve_test_target_uses_the_override_alone_when_nothing_is_stored() {
        let override_ = TestOverride {
            url: Some("https://fresh:8088/services/collector".into()),
            token: Some("t".into()),
            index: None,
        };
        let resolved = resolve_test_target(override_, None).unwrap();
        assert_eq!(resolved.url, "https://fresh:8088/services/collector");
        assert_eq!(resolved.token, "t");
        assert_eq!(resolved.index, "metrics"); // default_index()
    }

    // -- serialization -------------------------------------------------------

    #[test]
    fn metric_event_carries_identity_in_the_name_and_host_clock_time() {
        let snap = snapshot(|s| {
            s.gpus = vec![
                empty_gpu(0),
                GpuMetrics {
                    utilization_percent: Some(12),
                    ..empty_gpu(1)
                },
            ];
        });

        let event = build_metric_event(&snap, "dgx-01", "metrics");
        let inner = &event["fields"];

        assert_eq!(event["time"], 1_723_800_000);
        assert_eq!(event["host"], "dgx-01");
        assert_eq!(event["source"], "spark-dashboard");
        assert_eq!(event["sourcetype"], "spark_dashboard");
        assert_eq!(event["index"], "metrics");
        // Splunk's multiple-measurement metrics format: "event" must be the
        // literal string "metric", not the fields payload — a metrics-type
        // index silently drops anything sent without this exact marker.
        assert_eq!(event["event"], "metric");
        assert_eq!(inner["metric_name:gpu0.utilization_pct"], 87.0);
        assert_eq!(inner["metric_name:gpu0.power_watts"], 142.5);
        assert_eq!(inner["metric_name:gpu1.utilization_pct"], 12.0);
        assert_eq!(inner["metric_name:cpu.utilization_pct"], 12.5);
        assert_eq!(inner["metric_name:memory.used_bytes"], 4.0);
        assert_eq!(inner["metric_name:disk.read_bytes_per_sec"], 1.0);
        assert_eq!(inner["metric_name:network.tx_bytes_per_sec"], 4.0);
        assert!(inner
            .as_object()
            .unwrap()
            .keys()
            .all(|key| !key.starts_with("metric_name:engine.")));
    }

    #[test]
    fn engine_metrics_use_the_engine_type_prefix() {
        let snap = snapshot(|s| {
            s.engines = vec![EngineSnapshot {
                metrics: Some(EngineMetrics {
                    active_requests: Some(4),
                    queued_requests: Some(0),
                    tokens_per_sec: Some(120.0),
                    ttft_ms: Some(80.0),
                    e2e_latency_ms: Some(900.0),
                    ..EngineMetrics::default()
                }),
                ..engine_with(Some(4), Some(0))
            }];
        });

        let event = build_metric_event(&snap, "dgx-01", "metrics");
        let inner = &event["fields"];
        assert_eq!(inner["metric_name:engine.vllm.req_running"], 4.0);
        assert_eq!(inner["metric_name:engine.vllm.req_waiting"], 0.0);
        assert_eq!(inner["metric_name:engine.vllm.tokens_per_sec"], 120.0);
        assert_eq!(inner["metric_name:engine.vllm.e2e_latency_ms"], 900.0);
    }

    /// The Requests and Cache & Speculative Decoding cards are now part of
    /// the exported surface: every field they display must be present in the
    /// metric event when the engine reports it.
    #[test]
    fn requests_and_cache_spec_decode_fields_are_exported() {
        let snap = snapshot(|s| {
            s.engines = vec![EngineSnapshot {
                metrics: Some(EngineMetrics {
                    total_requests: Some(412),
                    swapped_requests: Some(0),
                    preemptions_total: Some(3),
                    kv_cache_percent: Some(72.5),
                    prefix_cache_hit_rate: Some(58.0),
                    prefix_cache_queries_total: Some(900),
                    spec_decode_acceptance_rate: Some(74.0),
                    spec_decode_acceptance_rate_live: Some(81.0),
                    spec_decode_mean_acceptance_length: Some(1.9),
                    spec_decode_accepted_tokens_total: Some(1500),
                    spec_decode_draft_tokens_total: Some(2000),
                    ..EngineMetrics::default()
                }),
                ..engine_with(Some(4), Some(0))
            }];
        });

        let event = build_metric_event(&snap, "dgx-01", "metrics");
        let inner = &event["fields"];
        assert_eq!(inner["metric_name:engine.vllm.total_requests"], 412.0);
        assert_eq!(inner["metric_name:engine.vllm.swapped_requests"], 0.0);
        assert_eq!(inner["metric_name:engine.vllm.preemptions_total"], 3.0);
        assert_eq!(inner["metric_name:engine.vllm.kv_cache_percent"], 72.5);
        assert_eq!(inner["metric_name:engine.vllm.prefix_cache_hit_rate"], 58.0);
        assert_eq!(
            inner["metric_name:engine.vllm.prefix_cache_queries_total"],
            900.0
        );
        assert_eq!(
            inner["metric_name:engine.vllm.spec_decode_acceptance_rate"],
            74.0
        );
        assert_eq!(
            inner["metric_name:engine.vllm.spec_decode_acceptance_rate_live"],
            81.0
        );
        assert_eq!(
            inner["metric_name:engine.vllm.spec_decode_mean_acceptance_length"],
            1.9
        );
        assert_eq!(
            inner["metric_name:engine.vllm.spec_decode_accepted_tokens_total"],
            1500.0
        );
        assert_eq!(
            inner["metric_name:engine.vllm.spec_decode_draft_tokens_total"],
            2000.0
        );
    }

    /// The Prefill/Decode throughput, Latency, and SLO Goodput cards are part
    /// of the exported surface too: live rates, running averages, per-request
    /// averages, cumulative totals, queue/TPOT/batch, and per-SLO goodput.
    #[test]
    fn throughput_latency_and_goodput_fields_are_exported() {
        let snap = snapshot(|s| {
            s.engines = vec![EngineSnapshot {
                metrics: Some(EngineMetrics {
                    prompt_tokens_per_sec: Some(1200.0),
                    avg_prompt_tokens_per_sec: Some(950.0),
                    per_request_prompt_tps: Some(1100.0),
                    total_prompt_tokens: Some(480_000),
                    avg_tokens_per_sec: Some(60.0),
                    per_request_tps: Some(72.0),
                    total_generation_tokens: Some(190_000),
                    queue_time_ms: Some(4.5),
                    tpot_ms: Some(15.2),
                    avg_batch_size: Some(3.5),
                    ttft_goodput_pct: Some(91.0),
                    itl_goodput_pct: Some(84.0),
                    tpot_goodput_pct: Some(96.0),
                    e2e_goodput_pct: Some(77.0),
                    ..EngineMetrics::default()
                }),
                ..engine_with(Some(4), Some(0))
            }];
        });

        let event = build_metric_event(&snap, "dgx-01", "metrics");
        let inner = &event["fields"];
        assert_eq!(
            inner["metric_name:engine.vllm.prompt_tokens_per_sec"],
            1200.0
        );
        assert_eq!(
            inner["metric_name:engine.vllm.avg_prompt_tokens_per_sec"],
            950.0
        );
        assert_eq!(
            inner["metric_name:engine.vllm.per_request_prompt_tps"],
            1100.0
        );
        assert_eq!(
            inner["metric_name:engine.vllm.total_prompt_tokens"],
            480_000.0
        );
        assert_eq!(inner["metric_name:engine.vllm.avg_tokens_per_sec"], 60.0);
        assert_eq!(inner["metric_name:engine.vllm.per_request_tps"], 72.0);
        assert_eq!(
            inner["metric_name:engine.vllm.total_generation_tokens"],
            190_000.0
        );
        assert_eq!(inner["metric_name:engine.vllm.queue_time_ms"], 4.5);
        assert_eq!(inner["metric_name:engine.vllm.tpot_ms"], 15.2);
        assert_eq!(inner["metric_name:engine.vllm.avg_batch_size"], 3.5);
        assert_eq!(inner["metric_name:engine.vllm.ttft_goodput_pct"], 91.0);
        assert_eq!(inner["metric_name:engine.vllm.itl_goodput_pct"], 84.0);
        assert_eq!(inner["metric_name:engine.vllm.tpot_goodput_pct"], 96.0);
        assert_eq!(inner["metric_name:engine.vllm.e2e_goodput_pct"], 77.0);
    }

    /// vLLM only emits `vllm:spec_decode_*` counters when speculative decoding
    /// is configured; the exporter must omit those fields (not send zeros) so
    /// a spec-decode-less engine does not fabricate data in the index.
    #[test]
    fn spec_decode_fields_are_omitted_when_the_engine_has_no_spec_decode() {
        let snap = snapshot(|s| {
            s.engines = vec![engine_with(Some(1), Some(0))];
        });

        let event = build_metric_event(&snap, "dgx-01", "metrics");
        let inner = &event["fields"];
        for key in [
            "spec_decode_acceptance_rate",
            "spec_decode_acceptance_rate_live",
            "spec_decode_mean_acceptance_length",
            "spec_decode_accepted_tokens_total",
            "spec_decode_draft_tokens_total",
        ] {
            assert!(
                inner
                    .as_object()
                    .unwrap()
                    .get(&format!("metric_name:engine.vllm.{key}"))
                    .is_none(),
                "{key} must be absent when the engine has no spec decode"
            );
        }
    }

    #[test]
    fn gpu_events_go_to_the_events_index_as_plain_events() {
        let event = GpuEvent {
            timestamp_ms: 1_723_800_001_500,
            gpu_index: Some(0),
            event_type: "XID".into(),
            detail: "XID 79".into(),
        };
        let value = build_gpu_event(&event, "dgx-01", "main");
        assert_eq!(value["time"], 1_723_800_001);
        assert_eq!(value["sourcetype"], "spark_dashboard_gpu_event");
        assert_eq!(value["index"], "main");
        assert_eq!(value["event"]["event_type"], "XID");
        assert_eq!(value["event"]["detail"], "XID 79");
    }

    // -- idle gate -----------------------------------------------------------

    #[test]
    fn known_zero_counts_and_only_old_requests_are_idle() {
        let snap = snapshot(|s| {
            s.engines = vec![EngineSnapshot {
                recent_requests: vec![RecentRequest {
                    start_ms: 0,
                    end_ms: 1_723_799_900_000, // 100 s before the snapshot
                    tokens_per_sec: 0.0,
                    ttft_ms: 0.0,
                }],
                ..engine_with(Some(0), Some(0))
            }];
        });
        assert!(!is_active(&snap));
    }

    #[test]
    fn a_recent_request_within_the_window_is_active() {
        let snap = snapshot(|s| {
            s.engines = vec![EngineSnapshot {
                recent_requests: vec![RecentRequest {
                    start_ms: 1_723_799_990_000, // 10 s before the snapshot
                    end_ms: 1_723_799_995_000,
                    tokens_per_sec: 0.0,
                    ttft_ms: 0.0,
                }],
                ..engine_with(Some(0), Some(0))
            }];
        });
        assert!(is_active(&snap));
    }

    #[test]
    fn a_request_exactly_at_the_window_edge_is_active() {
        let snap = snapshot(|s| {
            s.engines = vec![EngineSnapshot {
                recent_requests: vec![RecentRequest {
                    start_ms: 1_723_799_940_000, // exactly 60 s before
                    end_ms: 1_723_799_940_000,
                    tokens_per_sec: 0.0,
                    ttft_ms: 0.0,
                }],
                ..engine_with(Some(0), Some(0))
            }];
        });
        assert!(is_active(&snap));
    }

    #[test]
    fn unknown_counts_fail_open() {
        // Scrape broken: the whole metrics block is missing.
        let snap = snapshot(|s| {
            s.engines = vec![EngineSnapshot {
                metrics: None,
                ..engine_with(Some(0), Some(0))
            }];
        });
        assert!(is_active(&snap));

        // Scrape alive but the counters did not come back.
        let snap = snapshot(|s| {
            s.engines = vec![engine_with(None, Some(0))];
        });
        assert!(is_active(&snap));
    }

    #[test]
    fn queued_requests_count_as_active() {
        let snap = snapshot(|s| {
            s.engines = vec![engine_with(Some(0), Some(3))];
        });
        assert!(is_active(&snap));
    }

    #[test]
    fn a_host_with_no_engines_is_idle() {
        let snap = snapshot(|_| {});
        assert!(!is_active(&snap));
    }

    // -- state machine (mock HEC server) ------------------------------------

    #[derive(Clone)]
    struct MockState {
        posts: StdArc<StdMutex<Vec<String>>>,
        mode: u8,
        calls: StdArc<AtomicUsize>,
    }

    /// 0 = always 200, 1 = always 403, 2 = 429 on the first call, then 200.
    async fn mock_handler(
        axum::extract::State(st): axum::extract::State<MockState>,
        headers: axum::http::HeaderMap,
        body: axum::body::Bytes,
    ) -> (axum::http::StatusCode, &'static str) {
        // Splunk HEC uses the `Splunk <token>` auth scheme, not `Bearer`; a
        // real HEC endpoint answers a `Bearer` header with 401 regardless of
        // token validity. Assert it here so a regression fails loudly instead
        // of silently passing every other test in this module.
        let auth = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        if !auth.starts_with("Splunk ") {
            return (
                axum::http::StatusCode::UNAUTHORIZED,
                r#"{"text":"Invalid authorization","code":3}"#,
            );
        }
        st.posts
            .lock()
            .unwrap()
            .push(String::from_utf8_lossy(&body).into_owned());
        let call = st.calls.fetch_add(1, Ordering::SeqCst);
        match (st.mode, call) {
            (1, _) => (
                axum::http::StatusCode::FORBIDDEN,
                r#"{"text":"auth failed","code":8}"#,
            ),
            (2, 0) => (
                axum::http::StatusCode::TOO_MANY_REQUESTS,
                r#"{"text":"queue full"}"#,
            ),
            _ => (axum::http::StatusCode::OK, r#"{"text":"Success","code":2}"#),
        }
    }

    struct MockHec {
        url: String,
        posts: StdArc<StdMutex<Vec<String>>>,
        _server: tokio::task::JoinHandle<()>,
    }

    async fn start_mock(addr: Option<std::net::SocketAddr>, mode: u8) -> MockHec {
        let posts: StdArc<StdMutex<Vec<String>>> = StdArc::new(StdMutex::new(Vec::new()));
        let state = MockState {
            posts: posts.clone(),
            mode,
            calls: StdArc::new(AtomicUsize::new(0)),
        };
        let app = axum::Router::new()
            .route("/collector", axum::routing::post(mock_handler))
            .with_state(state);
        let listener = match addr {
            Some(addr) => tokio::net::TcpListener::bind(addr).await.unwrap(),
            None => tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap(),
        };
        let url = format!("http://{}/collector", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        MockHec {
            url,
            posts,
            _server: server,
        }
    }

    async fn wait_status(
        status: &SharedExportStatus,
        timeout: Duration,
        mut pred: impl FnMut(&ExportStatus) -> bool,
    ) -> ExportStatus {
        let start = Instant::now();
        loop {
            let current = status.lock().await.clone();
            if pred(&current) || start.elapsed() > timeout {
                return current;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn active_json() -> String {
        let snap = snapshot(|s| s.engines = vec![engine_with(Some(1), Some(0))]);
        serde_json::to_string(&snap).unwrap()
    }

    fn idle_json() -> String {
        let snap = snapshot(|s| s.engines = vec![engine_with(Some(0), Some(0))]);
        serde_json::to_string(&snap).unwrap()
    }

    fn active_json_with_gpu_event() -> String {
        let snap = snapshot(|s| {
            s.engines = vec![engine_with(Some(1), Some(0))];
            s.gpu_events = vec![GpuEvent {
                timestamp_ms: s.timestamp_ms,
                gpu_index: Some(0),
                event_type: "XID".into(),
                detail: "test-fault".into(),
            }];
        });
        serde_json::to_string(&snap).unwrap()
    }

    fn active_json_with_model(name: &str) -> String {
        let snap = snapshot(|s| {
            let mut engine = engine_with(Some(1), Some(0));
            engine.model = Some(ModelInfo {
                name: name.into(),
                parameter_size: Some("1B params".into()),
                quantization: None,
                precision: None,
                tensor_type: None,
                model_type: None,
                pipeline_tag: None,
            });
            s.engines = vec![engine];
        });
        serde_json::to_string(&snap).unwrap()
    }

    #[tokio::test]
    async fn the_exporter_reports_disabled_without_configuration() {
        let (tx, rx) = broadcast::channel::<String>(16);
        let config = SharedHecConfig::new(RwLock::new(None));
        let status = SharedExportStatus::new(Mutex::new(ExportStatus::disabled()));
        let task = tokio::spawn(run_exporter(
            rx,
            config,
            status.clone(),
            "test-host".into(),
            Duration::from_secs(60),
        ));

        tx.send(active_json()).unwrap();
        let st = wait_status(&status, Duration::from_secs(2), |s| {
            s.state == ExportState::Disabled
        })
        .await;
        assert_eq!(st.state, ExportState::Disabled);
        drop(task);
    }

    #[tokio::test]
    async fn the_exporter_sends_active_snapshots_and_reports_exporting() {
        let mock = start_mock(None, 0).await;
        let mut target = target();
        target.url = mock.url.clone();
        let (tx, rx) = broadcast::channel::<String>(16);
        let config = SharedHecConfig::new(RwLock::new(Some(target)));
        let status = SharedExportStatus::new(Mutex::new(ExportStatus::disabled()));
        let task = tokio::spawn(run_exporter(
            rx,
            config,
            status.clone(),
            "test-host".into(),
            Duration::from_secs(60), // keep the connection heartbeat out of this data-path test
        ));

        tx.send(active_json()).unwrap();

        let st = wait_status(&status, Duration::from_secs(2), |s| {
            s.state == ExportState::Exporting && s.last_ok_ms.is_some()
        })
        .await;
        assert_eq!(st.state, ExportState::Exporting);
        assert!(st.reachable);
        assert_eq!(st.last_error, None);

        let posts = mock.posts.lock().unwrap().clone();
        assert_eq!(posts.len(), 1, "one POST per tick, no extras");
        let array: Value = serde_json::from_str(&posts[0]).unwrap();
        let events = array.as_array().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["sourcetype"], "spark_dashboard");
        assert_eq!(events[0]["index"], "metrics");
        assert_eq!(events[0]["event"], "metric");
        assert!(events[0]["fields"]
            .as_object()
            .unwrap()
            .keys()
            .any(|k| k.starts_with("metric_name:")));
        drop(task);
    }

    #[tokio::test]
    async fn the_exporter_drops_idle_snapshots_without_posting() {
        let mock = start_mock(None, 0).await;
        let mut target = target();
        target.url = mock.url.clone();
        let (tx, rx) = broadcast::channel::<String>(16);
        let config = SharedHecConfig::new(RwLock::new(Some(target)));
        let status = SharedExportStatus::new(Mutex::new(ExportStatus::disabled()));
        let task = tokio::spawn(run_exporter(
            rx,
            config,
            status.clone(),
            "test-host".into(),
            // 60 s probe interval: this test asserts about the idle gate
            // only, and the connection heartbeat would otherwise add a
            // heartbeat POST inside the wait window.
            Duration::from_secs(60),
        ));

        tx.send(idle_json()).unwrap();

        let st = wait_status(&status, Duration::from_secs(2), |s| {
            s.state == ExportState::Idle
        })
        .await;
        assert_eq!(st.state, ExportState::Idle);
        assert!(st.dropped_count >= 1);
        assert!(
            mock.posts.lock().unwrap().is_empty(),
            "idle: nothing is posted"
        );
        drop(task);
    }

    #[tokio::test]
    async fn a_403_counts_as_reachable_with_a_configuration_error() {
        let mock = start_mock(None, 1).await;
        let mut target = target();
        target.url = mock.url.clone();
        let (tx, rx) = broadcast::channel::<String>(16);
        let config = SharedHecConfig::new(RwLock::new(Some(target)));
        let status = SharedExportStatus::new(Mutex::new(ExportStatus::disabled()));
        let task = tokio::spawn(run_exporter(
            rx,
            config,
            status.clone(),
            "test-host".into(),
            Duration::from_secs(60), // keep the connection heartbeat out of this data-path test
        ));

        tx.send(active_json()).unwrap();

        let st = wait_status(&status, Duration::from_secs(2), |s| {
            s.state == ExportState::Exporting && s.last_error.is_some()
        })
        .await;
        // The network is up: reachable stays true, the error is surfaced,
        // and the state is *not* Down.
        assert_eq!(st.state, ExportState::Exporting);
        assert!(st.reachable, "403 must not count as unreachable");
        assert_eq!(st.last_error.as_deref(), Some("hec-403"));

        // No backlog growth: a misconfigured target does not queue.
        tx.send(active_json()).unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        let posts = mock.posts.lock().unwrap().clone();
        assert_eq!(posts.len(), 2);
        for body in &posts {
            let array: Value = serde_json::from_str(body).unwrap();
            assert_eq!(array.as_array().unwrap().len(), 1);
        }
        drop(task);
    }

    #[tokio::test]
    async fn a_429_queues_the_batch_and_retries_on_the_next_tick() {
        let mock = start_mock(None, 2).await;
        let mut target = target();
        target.url = mock.url.clone();
        let (tx, rx) = broadcast::channel::<String>(16);
        let config = SharedHecConfig::new(RwLock::new(Some(target)));
        let status = SharedExportStatus::new(Mutex::new(ExportStatus::disabled()));
        let task = tokio::spawn(run_exporter(
            rx,
            config,
            status.clone(),
            "test-host".into(),
            Duration::from_secs(60), // keep the connection heartbeat out of this data-path test
        ));

        tx.send(active_json()).unwrap();

        let st = wait_status(&status, Duration::from_secs(2), |s| {
            s.last_error.as_deref() == Some("hec-429-or-5xx")
        })
        .await;
        assert_eq!(st.state, ExportState::Exporting);

        tx.send(active_json()).unwrap();

        let st = wait_status(&status, Duration::from_secs(2), |s| {
            s.state == ExportState::Exporting && s.last_ok_ms.is_some() && s.last_error.is_none()
        })
        .await;
        assert_eq!(st.state, ExportState::Exporting);

        let posts = mock.posts.lock().unwrap().clone();
        assert_eq!(posts.len(), 2, "first tick retried with the second");
        let first: Value = serde_json::from_str(&posts[0]).unwrap();
        let second: Value = serde_json::from_str(&posts[1]).unwrap();
        assert_eq!(first.as_array().unwrap().len(), 1);
        assert_eq!(
            second.as_array().unwrap().len(),
            2,
            "backlog + fresh snapshot"
        );
        drop(task);
    }

    #[tokio::test]
    async fn the_exporter_goes_down_drops_while_down_and_recovers_via_probe() {
        // Reserve a free port with nothing listening: connections are refused.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);

        let mut target = target();
        target.url = format!("http://{addr}/collector");
        let (tx, rx) = broadcast::channel::<String>(16);
        let config = SharedHecConfig::new(RwLock::new(Some(target)));
        let status = SharedExportStatus::new(Mutex::new(ExportStatus::disabled()));
        let task = tokio::spawn(run_exporter(
            rx,
            config,
            status.clone(),
            "test-host".into(),
            Duration::from_millis(100),
        ));

        // Tick 1: active with a GPU event. The POST is refused (twice: the
        // send and the best-effort final flush) and the exporter goes down.
        tx.send(active_json_with_gpu_event()).unwrap();

        let st = wait_status(&status, Duration::from_secs(2), |s| {
            s.state == ExportState::Down
        })
        .await;
        assert_eq!(st.state, ExportState::Down);
        assert!(!st.reachable);
        assert_eq!(st.last_error.as_deref(), Some("connection-failed"));
        assert!(st.dropped_count >= 1);

        // Tick 2: still down, so the snapshot is dropped (not queued).
        tx.send(active_json_with_gpu_event()).unwrap();
        let st = wait_status(&status, Duration::from_secs(2), |s| s.dropped_count >= 2).await;
        assert_eq!(st.state, ExportState::Down);

        // The endpoint comes back on the same port. The 100 ms liveness probe
        // notices within ~100 ms and flushes the two buffered GPU events.
        let mock = start_mock(Some(addr), 0).await;

        let st = wait_status(&status, Duration::from_secs(3), |s| {
            s.state == ExportState::Exporting
        })
        .await;
        assert_eq!(st.state, ExportState::Exporting);
        assert!(st.reachable);

        let posts = mock.posts.lock().unwrap().clone();
        assert!(!posts.is_empty());
        let last: Value = serde_json::from_str(posts.last().unwrap()).unwrap();
        let events = last.as_array().unwrap();
        assert!(events
            .iter()
            .all(|e| e["sourcetype"] == "spark_dashboard_gpu_event"));
        assert_eq!(events.len(), 2, "both GPU events survived the outage");
        drop(task);
    }

    #[tokio::test]
    async fn a_probe_rejected_with_403_reports_misconfigured_not_healthy() {
        // Regression test: the probe branch used to treat any non-network-
        // failure response (including a rejected token) as a success,
        // clearing last_error and stamping last_ok_ms. That masked a live
        // "bad token" outage as a healthy exporter.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);

        let mut target = target();
        target.url = format!("http://{addr}/collector");
        let (tx, rx) = broadcast::channel::<String>(16);
        let config = SharedHecConfig::new(RwLock::new(Some(target)));
        let status = SharedExportStatus::new(Mutex::new(ExportStatus::disabled()));
        let task = tokio::spawn(run_exporter(
            rx,
            config,
            status.clone(),
            "test-host".into(),
            Duration::from_millis(100),
        ));

        // Tick 1: refused connection puts the exporter Down.
        tx.send(active_json()).unwrap();
        let st = wait_status(&status, Duration::from_secs(2), |s| {
            s.state == ExportState::Down
        })
        .await;
        assert_eq!(st.state, ExportState::Down);

        // The endpoint comes back, but rejects the token (403) on every
        // request — the same shape as a stale/wrong HEC token.
        let _mock = start_mock(Some(addr), 1).await;

        let st = wait_status(&status, Duration::from_secs(3), |s| {
            s.state == ExportState::Exporting
        })
        .await;
        assert_eq!(st.state, ExportState::Exporting);
        assert!(st.reachable, "the endpoint answered, so it is reachable");
        assert_eq!(
            st.last_error.as_deref(),
            Some("hec-403"),
            "a rejected probe must surface the rejection, not clear it"
        );
        assert!(
            st.last_ok_ms.is_none(),
            "a 403 is not a success and must not stamp last_ok_ms"
        );
        drop(task);
    }

    #[test]
    fn the_model_event_carries_the_identity_fields() {
        let mut engine = engine_with(Some(1), Some(0));
        engine.model = Some(ModelInfo {
            name: "org/model-x".into(),
            parameter_size: Some("19.9B params".into()),
            quantization: Some("compressed-tensors".into()),
            precision: None,
            tensor_type: Some("BF16".into()),
            model_type: Some("qwen3_5".into()),
            pipeline_tag: None,
        });
        let event = build_engine_model_event(&engine, "h", "main", 1_723_800_000_000).unwrap();
        assert_eq!(event["sourcetype"], "spark_dashboard_engine_model");
        assert_eq!(event["index"], "main");
        assert_eq!(event["time"], 1_723_800_000);
        assert_eq!(event["event"]["engine_type"], "vllm");
        assert_eq!(event["event"]["endpoint"], "http://127.0.0.1:8000");
        assert_eq!(event["event"]["model_id"], "org/model-x");
        assert_eq!(event["event"]["parameter_size"], "19.9B params");
        assert_eq!(event["event"]["tensor_type"], "BF16");
        // Metadata resolved normally: the field is present and null, so the
        // column exists in the index even when there is nothing to flag.
        assert!(event["event"]["model_metadata_error"].is_null());
        // No model info: no event.
        assert!(build_engine_model_event(&engine_with(Some(1), None), "h", "main", 0).is_none());
    }

    #[test]
    fn the_model_event_flags_a_provisional_name_and_the_signature_tracks_it() {
        let mut engine = engine_with(Some(1), Some(0));
        engine.model = Some(ModelInfo {
            name: "fallback-from-cli".into(),
            parameter_size: None,
            quantization: None,
            precision: None,
            tensor_type: None,
            model_type: None,
            pipeline_tag: None,
        });
        // Unresolved metadata: the event carries the reason, so a query can
        // tell a fallback name from the engine's own answer.
        engine.model_metadata_error = Some(ModelMetadataError::AuthRequired);
        let event = build_engine_model_event(&engine, "h", "main", 0).unwrap();
        assert_eq!(event["event"]["model_id"], "fallback-from-cli");
        assert_eq!(event["event"]["model_metadata_error"], "AuthRequired");

        // Same name, metadata now resolved: the signature must change so the
        // exporter emits a fresh event for the trustworthy state.
        let provisional = model_signature(&engine);
        engine.model_metadata_error = None;
        assert_ne!(model_signature(&engine), provisional);
        assert_eq!(
            build_engine_model_event(&engine, "h", "main", 0).unwrap()["event"]
                ["model_metadata_error"],
            Value::Null
        );
    }

    #[tokio::test]
    async fn the_engine_model_event_is_emitted_once_and_again_on_model_change() {
        // The exporter must record a model event on first detection, stay
        // silent while the model is unchanged, and emit again when the
        // served model changes — without re-emitting for the old model.
        let mock = start_mock(None, 0).await;
        let mut target = target();
        target.url = mock.url.clone();
        let (tx, rx) = broadcast::channel::<String>(16);
        let config = SharedHecConfig::new(RwLock::new(Some(target)));
        let status = SharedExportStatus::new(Mutex::new(ExportStatus::disabled()));
        let task = tokio::spawn(run_exporter(
            rx,
            config,
            status.clone(),
            "test-host".into(),
            Duration::from_secs(60), // keep the liveness probe out of this test
        ));

        tx.send(active_json_with_model("org/model-a")).unwrap();
        let st = wait_status(&status, Duration::from_secs(2), |s| {
            s.state == ExportState::Exporting
        })
        .await;
        assert_eq!(st.state, ExportState::Exporting);

        // Unchanged model: no new model event.
        tx.send(active_json_with_model("org/model-a")).unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;

        // Model changed: a second model event.
        tx.send(active_json_with_model("org/model-b")).unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;

        let posts = mock.posts.lock().unwrap().clone();
        let model_events: Vec<Value> = posts
            .iter()
            .filter_map(|body| serde_json::from_str::<Value>(body).ok())
            .flat_map(|value| value.as_array().unwrap().clone())
            .filter(|event| event["sourcetype"] == "spark_dashboard_engine_model")
            .collect();
        assert_eq!(
            model_events.len(),
            2,
            "one model event per distinct model, not per tick"
        );
        assert_eq!(model_events[0]["event"]["model_id"], "org/model-a");
        assert_eq!(model_events[1]["event"]["model_id"], "org/model-b");
        drop(task);
    }
    #[tokio::test]
    async fn an_idle_host_still_heartbeats_the_connectivity_test_event() {
        // The liveness probe doubles as a connection heartbeat: even when
        // the idle gate drops every metric snapshot, a healthy endpoint
        // must still ingest a `spark_dashboard.connectivity.test` marker
        // every probe interval, or the dashboard's connectivity panel sees
        // nothing but stale data.
        let mock = start_mock(None, 0).await;
        let mut target = target();
        target.url = mock.url.clone();
        let (tx, rx) = broadcast::channel::<String>(16);
        let config = SharedHecConfig::new(RwLock::new(Some(target)));
        let status = SharedExportStatus::new(Mutex::new(ExportStatus::disabled()));
        let task = tokio::spawn(run_exporter(
            rx,
            config,
            status.clone(),
            "test-host".into(),
            Duration::from_millis(100),
        ));

        // Keep the host idle: every snapshot is dropped by the idle gate.
        for _ in 0..5 {
            tx.send(idle_json()).unwrap();
        }

        let st = wait_status(&status, Duration::from_secs(3), |s| s.last_ok_ms.is_some()).await;
        assert!(st.last_ok_ms.is_some(), "the heartbeat must succeed");
        assert!(
            st.state == ExportState::Idle,
            "a heartbeat proves the connection, it does not claim to export metrics"
        );
        assert!(st.reachable);

        let posts = mock.posts.lock().unwrap().clone();
        let heartbeat: Value = serde_json::from_str(
            posts
                .iter()
                .find(|body| body.contains("spark_dashboard.connectivity.test"))
                .expect("a heartbeat POST must have been recorded"),
        )
        .unwrap();
        let event = heartbeat.as_array().unwrap()[0].clone();
        assert_eq!(event["sourcetype"], "spark_dashboard");
        assert_eq!(event["event"], "metric");
        assert_eq!(
            event["fields"]["metric_name:spark_dashboard.connectivity.test"],
            1
        );
        drop(task);
    }
}

/// What the settings dialog's Test-connection probe found. Fine-grained where
/// the UI has dedicated copy (per ADR 0001), generic elsewhere.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TestOutcome {
    /// 200 — the test event was ingested.
    Ok,
    /// 403 — the HEC token is invalid or disabled.
    InvalidToken,
    /// 400 with HEC code 7 — the token's `indexes` allowlist does not include
    /// the configured index.
    IndexDenied,
    /// 429 — the HEC queue is full.
    QueueFull,
    /// 401 / 400 (other codes) — a configuration problem without dedicated
    /// copy.
    Misconfigured,
    /// 5xx — the HEC server itself is failing.
    ServerError,
    /// DNS failure, refused connection, or timeout.
    Unreachable,
}

/// POSTs the single connectivity test event and reports what the HEC endpoint
/// answered. Like the exporter, this runs with the per-POST deadline, so a
/// wedged HEC cannot wedge the settings dialog.
pub async fn run_test(client: &reqwest::Client, target: &HecTarget, host: &str) -> TestOutcome {
    let event = build_test_event(host, &target.index, now_ms());
    let response = client
        .post(&target.url)
        .header("Authorization", format!("Splunk {}", target.token))
        .header("Content-Type", "application/json")
        .body(serde_json::to_string(&[event]).expect("test event serializes"))
        .send()
        .await;

    match response {
        Ok(response) => {
            let status = response.status().as_u16();
            if (200..300).contains(&status) {
                TestOutcome::Ok
            } else if status == 429 {
                TestOutcome::QueueFull
            } else if status == 403 || status == 401 {
                // 403 and 401 are both the endpoint rejecting the token;
                // which one a given deployment answers with varies.
                TestOutcome::InvalidToken
            } else if status >= 500 {
                TestOutcome::ServerError
            } else if status == 400 {
                let body = response.text().await.unwrap_or_default();
                let code = serde_json::from_str::<Value>(&body)
                    .ok()
                    .and_then(|value| value.get("code").and_then(Value::as_i64));
                if code == Some(7) {
                    TestOutcome::IndexDenied
                } else {
                    TestOutcome::Misconfigured
                }
            } else {
                TestOutcome::Misconfigured
            }
        }
        Err(_) => TestOutcome::Unreachable,
    }
}
