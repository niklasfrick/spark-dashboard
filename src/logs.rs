//! Docker container log streaming via the bollard API.
//!
//! Instead of shelling out to `docker logs -f` (which fails on distroless
//! runtimes that have no shell or `docker` CLI), this module talks directly to
//! the Docker daemon over its Unix socket via bollard.
//!
//! Stream characteristics:
//! - stdout/stderr are multiplexed in real-time (not drained sequentially).
//! - One Docker log stream per container is shared across all WebSocket
//!   clients watching that container (same fan-out pattern as the metrics
//!   broadcast in `ws.rs`): a background task per container owns the Docker
//!   stream and publishes line-buffered log lines over a `broadcast` channel;
//!   each WS handler subscribes to the channel for its container.
//! - Clients select an engine with `/ws/logs?engine=<endpoint>`. The endpoint
//!   is matched against the shared engine state populated by
//!   `engine_collector_loop`, so only containers the dashboard tracks as
//!   engines can be streamed — a client can never request an arbitrary
//!   container. Without the parameter the first tracked engine container is
//!   used (single-engine hosts don't need to select anything).
//! - Both stdout and stderr are buffered by lines — bollard frames can split a
//!   log line mid-way, so partial frames are accumulated until a newline
//!   arrives before being forwarded. The trailing partial line is flushed when
//!   the Docker stream ends.
//! - When a container's stream ends (container stopped, Docker error, or the
//!   last viewer disconnected), its registry entry is removed, so the next
//!   client connect starts a fresh stream instead of subscribing to a dead
//!   channel. Streams therefore only run while someone is actually watching.

#![cfg(target_os = "linux")]

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::Query;
use axum::response::IntoResponse;
use bollard::container::LogOutput;
use bollard::query_parameters::LogsOptionsBuilder;
use bollard::Docker;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{broadcast, RwLock};
use tracing::{debug, warn};

use crate::engines::EngineSnapshot;
use crate::hec;

/// Flag set at startup when `--enable-log-viewer` is passed.
/// Read by `server.rs` to decide whether to register the `/ws/logs` route.
static LOG_VIEWER_ENABLED: AtomicBool = AtomicBool::new(false);

/// Shared engine state, set at startup when the log viewer is enabled.
/// WS handlers resolve engine endpoints to container ids against it, so the
/// stream always follows the engine the dashboard is showing.
static ENGINE_STATE: OnceLock<Arc<RwLock<Vec<EngineSnapshot>>>> = OnceLock::new();

/// One shared log stream per container: container id → broadcast sender.
/// An entry exists while the container's background stream task is alive; the
/// task removes its own entry on exit so a later connect restarts the stream.
static STREAMS: OnceLock<Mutex<HashMap<String, broadcast::Sender<String>>>> = OnceLock::new();

/// Capacity of each log broadcast channel. Sized so a slow WS client can fall
/// a few seconds behind (log lines are small) without being dropped; lagged
/// clients simply skip missed lines (see [`handle_logs_socket`]).
const LOG_CHANNEL_CAPACITY: usize = 256;

/// Enable the log viewer feature. Called from `main.rs` when
/// `--enable-log-viewer` is set. Captures the shared engine state so WS
/// handlers can resolve engine endpoints to container ids.
pub fn enable_log_viewer(engine_state: Arc<RwLock<Vec<EngineSnapshot>>>) {
    // Setting the engine state first avoids a race where a client connects and
    // the stream task starts before the state pointer is available.
    let _ = ENGINE_STATE.set(engine_state);
    LOG_VIEWER_ENABLED.store(true, Ordering::Relaxed);
}

/// Returns whether the log viewer was enabled at startup.
pub fn is_log_viewer_enabled() -> bool {
    LOG_VIEWER_ENABLED.load(Ordering::Relaxed)
}

/// Query parameters for `/ws/logs`.
#[derive(serde::Deserialize)]
pub struct LogsQuery {
    /// Engine endpoint (as serialized in `EngineSnapshot.endpoint`) selecting
    /// which engine's container to stream. Absent → first tracked container.
    engine: Option<String>,
}

/// WebSocket upgrade handler for `/ws/logs`.
///
/// A container's Docker log stream is started only when the first client for
/// that container connects (lazy connect — no background resource consumption
/// while the viewer is unused). Subsequent clients subscribe to the same
/// broadcast.
pub async fn ws_logs_handler(
    Query(query): Query<LogsQuery>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_logs_socket(socket, query.engine))
}

async fn handle_logs_socket(mut socket: WebSocket, engine: Option<String>) {
    debug!("Logs WebSocket client connected (engine: {engine:?})");

    let container_id = match resolve_container_id(engine.as_deref()).await {
        Some(id) => id,
        None => {
            let msg = match engine {
                Some(e) => format!("ERR:No container found for engine {e}"),
                None => "ERR:No engine container found".to_string(),
            };
            let _ = socket.send(Message::Text(msg.into())).await;
            return;
        }
    };

    let mut rx = subscribe_container(&container_id);

    // Replay a marker so the client knows streaming has begun.
    if socket
        .send(Message::Text("LOG:stream attached".into()))
        .await
        .is_err()
    {
        debug!("Logs client disconnected before first message");
        return;
    }

    loop {
        tokio::select! {
            line = rx.recv() => {
                match line {
                    Ok(msg) => {
                        if socket.send(Message::Text(msg.into())).await.is_err() {
                            debug!("Logs client disconnected");
                            return;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        debug!("Logs client lagged, skipped {} lines", n);
                        continue;
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        debug!("Logs broadcast channel closed");
                        return;
                    }
                }
            }
            ws_msg = socket.recv() => {
                match ws_msg {
                    Some(Ok(Message::Close(_))) | None => {
                        debug!("Logs client disconnected via close frame");
                        return;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => {
                        debug!("Logs WebSocket error: {e}");
                        return;
                    }
                }
            }
        }
    }
}

/// Subscribe to `container_id`'s log stream, lazily spawning the container's
/// background stream task if it isn't running. The registry lock serializes
/// concurrent first-connects so exactly one task is spawned per container, and
/// the receiver is created before the task starts so the stream never observes
/// zero subscribers while its first client is still attaching.
fn subscribe_container(container_id: &str) -> broadcast::Receiver<String> {
    let streams = STREAMS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = streams.lock().expect("log stream registry poisoned");
    if let Some(tx) = map.get(container_id) {
        return tx.subscribe();
    }
    let (tx, rx) = broadcast::channel::<String>(LOG_CHANNEL_CAPACITY);
    map.insert(container_id.to_string(), tx.clone());
    tokio::spawn(log_stream_task(container_id.to_string(), tx));
    rx
}

/// Remove a finished stream's registry entry so the next client connect starts
/// a fresh Docker stream instead of subscribing to a dead channel.
fn remove_stream(container_id: &str) {
    if let Some(streams) = STREAMS.get() {
        streams
            .lock()
            .expect("log stream registry poisoned")
            .remove(container_id);
    }
}

/// Background task that owns the Docker log stream for one container and
/// publishes line-buffered log lines to its subscribers. Deregisters itself on
/// every exit path so the stream can be restarted by a later connect.
async fn log_stream_task(container_id: String, tx: broadcast::Sender<String>) {
    stream_container_logs(&container_id, &tx).await;
    remove_stream(&container_id);
}

async fn stream_container_logs(container_id: &str, tx: &broadcast::Sender<String>) {
    let docker = match Docker::connect_with_local_defaults() {
        Ok(d) => d,
        Err(e) => {
            let _ = tx.send(format!("ERR:Could not connect to Docker daemon: {e}"));
            return;
        }
    };

    debug!("Streaming logs for container: {container_id}");

    let options = LogsOptionsBuilder::new()
        .follow(true)
        .stdout(true)
        .stderr(true)
        .tail("100")
        .build();

    let mut stream = docker.logs(container_id, Some(options));
    let mut stdout_buf = String::with_capacity(1024);
    let mut stderr_buf = String::with_capacity(1024);

    loop {
        match stream.next().await {
            Some(Ok(LogOutput::StdOut { message })) => {
                for line in buffer_lines(&mut stdout_buf, &message, None) {
                    // Err means no live subscribers: the last viewer left, so
                    // stop the Docker stream — a later connect restarts it
                    // through the registry.
                    if tx.send(line).is_err() {
                        debug!("No log subscribers left for {container_id}; stopping stream");
                        return;
                    }
                }
            }
            Some(Ok(LogOutput::StdErr { message })) => {
                // Stderr is buffered by lines the same way stdout is: frames
                // can split a line mid-way, so accumulate until a newline.
                for line in buffer_lines(&mut stderr_buf, &message, Some("[stderr] ")) {
                    if tx.send(line).is_err() {
                        debug!("No log subscribers left for {container_id}; stopping stream");
                        return;
                    }
                }
            }
            Some(Ok(LogOutput::Console { message })) => {
                // Console frames are whole lines from the Docker daemon itself.
                let text = String::from_utf8_lossy(&message).to_string();
                if tx.send(text).is_err() {
                    debug!("No log subscribers left for {container_id}; stopping stream");
                    return;
                }
            }
            Some(Ok(LogOutput::StdIn { .. })) => {
                // We don't write to stdin, so ignore.
            }
            Some(Err(e)) => {
                let _ = tx.send(format!("ERR:Log stream error: {e}"));
                return;
            }
            None => {
                // Stream ended (container stopped). Flush any trailing partial
                // lines that never received a newline.
                flush_trailing(&mut stdout_buf, None, tx);
                flush_trailing(&mut stderr_buf, Some("[stderr] "), tx);
                let _ = tx.send("LOG:Stream ended - container stopped".to_string());
                return;
            }
        }
    }
}

/// Resolve an engine selection to a container id against the shared engine
/// state. Waits up to ~10s for detection to populate container ids, since the
/// log viewer may connect before the first detection sweep completes.
async fn resolve_container_id(engine: Option<&str>) -> Option<String> {
    let state = ENGINE_STATE.get()?;
    for _ in 0..100 {
        {
            let lock = state.read().await;
            if let Some(id) = find_container(&lock, engine) {
                return Some(id);
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    warn!(
        "Log viewer could not resolve a container id from engine state after 10s (engine: {engine:?})"
    );
    None
}

/// Pick the container id for an engine selection from a snapshot list.
/// With `engine` given, only that endpoint's container matches — an unknown
/// endpoint yields `None` rather than falling back to a different engine's
/// logs. Without it, the first snapshot with a container id wins.
fn find_container(snapshots: &[EngineSnapshot], engine: Option<&str>) -> Option<String> {
    match engine {
        Some(endpoint) => snapshots
            .iter()
            .find(|s| s.endpoint == endpoint)
            .and_then(|s| s.container_id.clone()),
        None => snapshots.iter().find_map(|s| s.container_id.clone()),
    }
}

// ---------------------------------------------------------------------------
// Line buffering helpers (pure -- exercised by unit tests)
// ---------------------------------------------------------------------------

/// Accumulate `chunk` into `buffer`, then emit and drain every complete line
/// (text up to and including a `\n`). Any trailing partial line (no newline
/// yet) remains in `buffer` for the next chunk. `prefix` is prepended to each
/// emitted line (used to tag stderr lines with `[stderr] `).
///
/// This is the core line-buffering behavior shared by stdout and stderr: a
/// single log line may arrive split across several bollard frames, so we only
/// forward text once we have a complete line.
fn buffer_lines(buffer: &mut String, chunk: &[u8], prefix: Option<&str>) -> Vec<String> {
    buffer.push_str(&String::from_utf8_lossy(chunk));
    let mut out = Vec::new();
    while let Some(pos) = buffer.find('\n') {
        let line: String = buffer.drain(..=pos).collect();
        // Strip the trailing newline (already drained) and emit the line
        // body, with the optional prefix.
        let body = line.trim_end_matches('\n');
        let prefixed = match prefix {
            Some(p) => format!("{p}{body}"),
            None => body.to_string(),
        };
        out.push(prefixed);
    }
    out
}

/// Emit whatever remains in `buffer` as a single final line (no trailing
/// newline was ever received), then clear it. Called when the Docker stream
/// ends so a partial last line isn't silently dropped.
fn flush_trailing(buffer: &mut String, prefix: Option<&str>, tx: &broadcast::Sender<String>) {
    if buffer.is_empty() {
        return;
    }
    let body = std::mem::take(buffer);
    let prefixed = match prefix {
        Some(p) => format!("{p}{body}"),
        None => body,
    };
    let _ = tx.send(prefixed);
}

// ---------------------------------------------------------------------------
// HEC forwarding for engine container logs
// ---------------------------------------------------------------------------

/// Engine log lines are *events*, never metrics: they go to the target's
/// `events_index` (the same destination as GPU events) under their own
/// sourcetype, and must never be pointed at the metrics index.
const LOG_HEC_SOURCETYPE: &str = "spark_dashboard_engine_log";

/// Bounded wait-for-sending buffer; the oldest line is dropped when the cap
/// is exceeded. Engine logs are not the page-worthy data GPU events are,
/// and an unbounded buffer would defeat the drop-while-down contract.
const LOG_HEC_BUFFER_CAP: usize = 1000;

/// Forwarder tick: lines are drained from the container streams and a
/// non-empty buffer is flushed at most once per tick.
const LOG_HEC_TICK: Duration = Duration::from_secs(1);

/// One HEC event for a single engine log line. `time` is the send time —
/// the Docker stream carries no per-line timestamps.
pub fn build_log_event(
    line: &str,
    container: &str,
    host: &str,
    index: &str,
    time_ms: u64,
) -> Value {
    json!({
        "time": time_ms / 1000,
        "host": host,
        "source": "spark-dashboard",
        "sourcetype": LOG_HEC_SOURCETYPE,
        "index": index,
        "event": {
            "container": container,
            "line": line,
        },
    })
}

/// Control lines the log viewer protocol puts on the shared channel
/// (`ERR:…` / `LOG:…`) are UI messaging, not engine output — they never
/// reach HEC. (An engine line that literally starts with `ERR:` is
/// sacrificed to the filter; the prefixes are distinct enough in practice.)
pub fn is_control_line(line: &str) -> bool {
    line.starts_with("ERR:") || line.starts_with("LOG:")
}

/// Best-effort container id → display name; falls back to the short id when
/// the daemon cannot be reached or the container vanished mid-flight.
async fn container_display_name(container_id: &str) -> String {
    if let Ok(docker) = Docker::connect_with_local_defaults() {
        if let Ok(info) = docker.inspect_container(container_id, None).await {
            if let Some(name) = info
                .name
                .and_then(|name| name.strip_prefix('/').map(str::to_string))
            {
                return name;
            }
        }
    }
    container_id.chars().take(12).collect()
}

/// Forwards tracked engine containers' log lines to the `export.hec`
/// target's `events_index`. Spawned from `main.rs` only when
/// `--enable-log-viewer` is set; the document's target is read live every
/// tick, so toggling the export section in the UI turns forwarding on and
/// off without a restart.
///
/// Reuses the per-container stream registry: the forwarder's receivers keep
/// each container's Docker stream alive even while no UI viewer is
/// connected, so the index stays continuous; a UI viewer just shares the
/// same stream. Failure handling mirrors the metrics exporter: 429/5xx and
/// unreachability keep the (bounded) buffer and back off one probe interval,
/// 401/403/400 drop it — re-sending the same bad token cannot succeed.
pub async fn run_log_exporter(hec_config: hec::SharedHecConfig, host: String) {
    let client = reqwest::Client::builder()
        .timeout(hec::POST_TIMEOUT)
        .build()
        .expect("reqwest client");
    // container id → (display name, receiver)
    let mut streams: HashMap<String, (String, broadcast::Receiver<String>)> = HashMap::new();
    // (container, line) pairs waiting to be sent.
    let mut buffer: VecDeque<(String, String)> = VecDeque::new();
    let mut next_attempt = Instant::now();

    loop {
        let target = hec_config.read().await.clone().filter(|t| t.usable());

        // Follow the tracked engine containers: subscribe to new ones, drop
        // receivers whose container left the engine state (with the last UI
        // viewer gone, the stream task stops on its own).
        let wanted: Vec<String> = match ENGINE_STATE.get() {
            Some(state) => {
                let snapshots = state.read().await;
                snapshots
                    .iter()
                    .filter_map(|s| s.container_id.clone())
                    .collect()
            }
            None => Vec::new(),
        };
        for id in &wanted {
            if !streams.contains_key(id) {
                let name = container_display_name(id).await;
                let rx = subscribe_container(id);
                streams.insert(id.clone(), (name, rx));
            }
        }
        streams.retain(|id, _| wanted.iter().any(|w| w == id));

        // Drain fresh lines from every stream (non-blocking).
        for (id, entry) in streams.iter_mut() {
            let mut dropped = 0usize;
            loop {
                match entry.1.try_recv() {
                    Ok(line) if !is_control_line(&line) => {
                        // No target: nothing to send to — discard. The line
                        // is still delivered to UI viewers on their own
                        // receivers; a broadcast receiver only lags for
                        // itself.
                        if target.is_some() {
                            if buffer.len() >= LOG_HEC_BUFFER_CAP {
                                buffer.pop_front();
                                dropped += 1;
                            }
                            buffer.push_back((entry.0.clone(), line));
                        }
                    }
                    Ok(_) => {}
                    // Missed lines are gone; keep draining what remains.
                    Err(broadcast::error::TryRecvError::Lagged(_)) => {}
                    Err(broadcast::error::TryRecvError::Empty)
                    | Err(broadcast::error::TryRecvError::Closed) => break,
                }
            }
            if dropped > 0 {
                warn!(container = %id, dropped, "engine log buffer overflow; oldest lines dropped");
            }
        }

        tokio::time::sleep(LOG_HEC_TICK).await;

        // Flush.
        let Some(target) = target else { continue };
        if buffer.is_empty() || Instant::now() < next_attempt {
            continue;
        }
        let time_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let batch: Vec<(String, String)> = buffer.iter().cloned().collect();
        let events: Vec<Value> = batch
            .iter()
            .map(|(container, line)| {
                build_log_event(line, container, &host, &target.events_index, time_ms)
            })
            .collect();

        match hec::post_events(&client, &target, &events).await {
            hec::SendOutcome::Ok => {
                buffer.clear();
                next_attempt = Instant::now();
            }
            // Retryable (429/5xx) or unreachable: keep the buffer and back
            // off one probe interval; the next attempt re-sends the same
            // lines.
            hec::SendOutcome::Retry | hec::SendOutcome::Unreachable => {
                next_attempt = Instant::now() + hec::PROBE_INTERVAL;
            }
            // 401/403/400: a configuration problem, not an outage — re-sending
            // the same token cannot succeed, so drop the batch and back off.
            hec::SendOutcome::Misconfigured(reason) => {
                warn!(%reason, lines = events.len(), "HEC rejected engine log events; backing off");
                buffer.clear();
                next_attempt = Instant::now() + hec::PROBE_INTERVAL;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engines::{DeploymentMode, EngineStatus, EngineType};

    fn snapshot(endpoint: &str, container_id: Option<&str>) -> EngineSnapshot {
        EngineSnapshot {
            engine_type: EngineType::Vllm,
            endpoint: endpoint.to_string(),
            status: EngineStatus::Running,
            model: None,
            model_metadata_error: None,
            metrics: None,
            recent_requests: Vec::new(),
            deployment_mode: match container_id {
                Some(_) => DeploymentMode::Docker,
                None => DeploymentMode::Native,
            },
            gpu_indexes: Vec::new(),
            pids: Vec::new(),
            container_id: container_id.map(str::to_string),
        }
    }

    /// With an engine endpoint given, only that engine's container matches.
    #[test]
    fn find_container_matches_selected_endpoint() {
        let snaps = vec![
            snapshot("http://localhost:8000", Some("aaa")),
            snapshot("http://localhost:8100", Some("bbb")),
        ];
        assert_eq!(
            find_container(&snaps, Some("http://localhost:8100")),
            Some("bbb".to_string())
        );
    }

    /// An unknown endpoint yields None — never another engine's logs.
    #[test]
    fn find_container_unknown_endpoint_yields_none() {
        let snaps = vec![snapshot("http://localhost:8000", Some("aaa"))];
        assert_eq!(find_container(&snaps, Some("http://localhost:9999")), None);
    }

    /// A selected engine without a container (native deployment) yields None
    /// rather than falling back to a different container.
    #[test]
    fn find_container_selected_native_engine_yields_none() {
        let snaps = vec![
            snapshot("http://localhost:8000", None),
            snapshot("http://localhost:8100", Some("bbb")),
        ];
        assert_eq!(find_container(&snaps, Some("http://localhost:8000")), None);
    }

    /// Without a selection, the first snapshot with a container id wins —
    /// native engines (no container) are skipped.
    #[test]
    fn find_container_default_picks_first_with_container() {
        let snaps = vec![
            snapshot("http://localhost:8000", None),
            snapshot("http://localhost:8100", Some("bbb")),
            snapshot("http://localhost:8200", Some("ccc")),
        ];
        assert_eq!(find_container(&snaps, None), Some("bbb".to_string()));
    }

    /// No containers at all → None.
    #[test]
    fn find_container_empty_state_yields_none() {
        assert_eq!(find_container(&[], None), None);
        assert_eq!(
            find_container(&[snapshot("http://localhost:8000", None)], None),
            None
        );
    }

    /// A finished stream deregisters itself, so a later connect gets a fresh
    /// channel instead of the dead one (restart-on-reconnect).
    #[tokio::test]
    async fn finished_stream_is_removed_from_registry() {
        // Bogus container id: the task fails fast (no such container / no
        // daemon), which is exactly the "stream died" path we want to observe.
        let mut rx = subscribe_container("test-nonexistent-container");
        // First message is an ERR from either the daemon connect or the log
        // stream; after that the task deregisters.
        let msg = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
            .await
            .expect("stream task should emit an error quickly")
            .expect("channel closed before error message");
        assert!(msg.starts_with("ERR:"), "expected error line, got: {msg}");
        // Poll until the registry entry is gone (deregistration runs after the
        // error send, so give it a moment).
        for _ in 0..50 {
            let gone = STREAMS
                .get()
                .map(|s| !s.lock().unwrap().contains_key("test-nonexistent-container"))
                .unwrap_or(false);
            if gone {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("finished stream task did not deregister itself");
    }

    /// A complete line arriving in one frame is emitted immediately, and the
    /// buffer is left empty (no partial line retained).
    #[test]
    fn stdout_single_complete_line_is_emitted() {
        let mut buf = String::new();
        let lines = buffer_lines(&mut buf, b"hello world\n", None);
        assert_eq!(lines, vec!["hello world".to_string()]);
        assert!(buf.is_empty(), "no partial line should remain");
    }

    /// A line split across two frames is only emitted once the newline arrives.
    /// The first frame leaves a partial line buffered; the second completes it.
    #[test]
    fn stdout_split_line_is_buffered_until_newline() {
        let mut buf = String::new();

        // First frame: no newline yet -- nothing emitted, partial buffered.
        let lines = buffer_lines(&mut buf, b"partial", None);
        assert!(lines.is_empty(), "no complete line yet");
        assert_eq!(buf, "partial");

        // Second frame: completes the line.
        let lines = buffer_lines(&mut buf, b" line\n", None);
        assert_eq!(lines, vec!["partial line".to_string()]);
        assert!(buf.is_empty());
    }

    /// Multiple complete lines in a single frame are all emitted, in order.
    #[test]
    fn stdout_multiple_lines_in_one_frame() {
        let mut buf = String::new();
        let lines = buffer_lines(&mut buf, b"a\nb\nc\n", None);
        assert_eq!(
            lines,
            vec!["a".to_string(), "b".to_string(), "c".to_string()]
        );
        assert!(buf.is_empty());
    }

    /// Stderr is buffered by lines the same way stdout is: a frame without a
    /// newline is retained, and each emitted line is tagged with the prefix.
    #[test]
    fn stderr_is_line_buffered_and_prefixed() {
        let mut buf = String::new();

        // Split stderr frame: no newline in the first chunk.
        let lines = buffer_lines(&mut buf, b"err ", Some("[stderr] "));
        assert!(lines.is_empty());
        assert_eq!(buf, "err ");

        // Completing chunk emits the tagged line.
        let lines = buffer_lines(&mut buf, b"half\n", Some("[stderr] "));
        assert_eq!(lines, vec!["[stderr] err half".to_string()]);
        assert!(buf.is_empty());
    }

    /// A partial stdout line that never receives a trailing newline is flushed
    /// when the stream ends, so it is not silently lost.
    #[tokio::test]
    async fn trailing_partial_stdout_line_is_flushed_on_stream_end() {
        let (tx, mut rx) = broadcast::channel::<String>(16);
        let mut buf = String::new();

        // Buffer a partial line with no newline.
        let lines = buffer_lines(&mut buf, b"trailing partial", None);
        assert!(lines.is_empty());

        // Stream ends -> flush the leftover.
        flush_trailing(&mut buf, None, &tx);
        assert!(buf.is_empty());
        assert_eq!(rx.recv().await.unwrap(), "trailing partial");
    }

    /// A trailing partial stderr line is flushed with its prefix on stream end.
    #[tokio::test]
    async fn trailing_partial_stderr_line_is_flushed_with_prefix() {
        let (tx, mut rx) = broadcast::channel::<String>(16);
        let mut buf = String::new();

        let _ = buffer_lines(&mut buf, b"leftover stderr", Some("[stderr] "));
        flush_trailing(&mut buf, Some("[stderr] "), &tx);
        assert_eq!(rx.recv().await.unwrap(), "[stderr] leftover stderr");
    }

    /// A log line becomes a plain JSON event aimed at the given index —
    /// never a metrics event (no `event: "metric"` marker, no `metric_name:`
    /// fields, no `fields` object).
    #[test]
    fn log_event_is_a_plain_event_for_the_events_index() {
        let event = build_log_event(
            "INFO: engine started",
            "vllm-openai",
            "splunk-ai",
            "main",
            1_723_800_000_123,
        );
        assert_eq!(event["time"], 1_723_800_000);
        assert_eq!(event["host"], "splunk-ai");
        assert_eq!(event["source"], "spark-dashboard");
        assert_eq!(event["sourcetype"], "spark_dashboard_engine_log");
        assert_eq!(event["index"], "main");
        assert_eq!(event["event"]["container"], "vllm-openai");
        assert_eq!(event["event"]["line"], "INFO: engine started");
        assert!(
            event.get("fields").is_none(),
            "log events carry no metric fields"
        );
        assert!(
            event["event"] != serde_json::json!("metric"),
            "log events must not use the metrics marker"
        );
    }

    /// Protocol lines are filtered out, engine lines (including ones that
    /// merely start with `ERROR:`) pass through.
    #[test]
    fn control_lines_are_recognized() {
        assert!(is_control_line("ERR:No container found for engine x"));
        assert!(is_control_line("LOG:stream attached"));
        assert!(is_control_line("LOG:Stream ended - container stopped"));
        assert!(!is_control_line(
            "INFO:     127.0.0.1:60870 - \"GET /health HTTP/1.1\" 200 OK"
        ));
        assert!(!is_control_line("ERROR: something the engine logged"));
    }

    /// `flush_trailing` on an empty buffer is a no-op (no spurious empty line).
    #[test]
    fn flush_trailing_empty_buffer_emits_nothing() {
        let (tx, mut rx) = broadcast::channel::<String>(16);
        let mut buf = String::new();
        flush_trailing(&mut buf, None, &tx);
        // No message should be available.
        assert!(
            rx.try_recv().is_err(),
            "flush of empty buffer must not emit a line"
        );
    }

    /// Mixed complete-and-partial frame: the complete line is emitted, the
    /// trailing partial is retained for the next chunk.
    #[test]
    fn stdout_complete_line_then_partial_in_same_frame() {
        let mut buf = String::new();
        let lines = buffer_lines(&mut buf, b"done\nstart of next", None);
        assert_eq!(lines, vec!["done".to_string()]);
        assert_eq!(buf, "start of next");
    }
}
