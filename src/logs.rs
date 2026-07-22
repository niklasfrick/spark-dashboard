//! Docker container log streaming via the bollard API.
//!
//! Instead of shelling out to `docker logs -f` (which fails on distroless
//! runtimes that have no shell or `docker` CLI), this module talks directly to
//! the Docker daemon over its Unix socket via bollard.
//!
//! Stream characteristics:
//! - stdout/stderr are multiplexed in real-time (not drained sequentially).
//! - One Docker log stream is shared across all connected WebSocket clients
//!   (same fan-out pattern as the metrics broadcast in `ws.rs`): a single
//!   background task owns the Docker stream and publishes line-buffered log
//!   lines over a `broadcast` channel; each WS handler subscribes to it.
//! - Both stdout and stderr are buffered by lines — bollard frames can split a
//!   log line mid-way, so partial frames are accumulated until a newline arrives
//!   before being forwarded. The trailing partial line is flushed when the
//!   Docker stream ends.
//! - The container to stream is read from the shared engine state populated by
//!   `engine_collector_loop`, so the dashboard streams the exact container it is
//!   showing metrics for rather than re-scanning and potentially picking a
//!   different one.

#![cfg(target_os = "linux")]

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::IntoResponse;
use bollard::container::LogOutput;
use bollard::query_parameters::LogsOptionsBuilder;
use bollard::Docker;
use futures_util::StreamExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use tokio::sync::{broadcast, RwLock};
use tracing::{debug, warn};

use crate::engines::EngineSnapshot;

/// Flag set at startup when `--enable-log-viewer` is passed.
/// Read by `server.rs` to decide whether to register the `/ws/logs` route.
static LOG_VIEWER_ENABLED: AtomicBool = AtomicBool::new(false);

/// Broadcast channel carrying line-buffered log lines to all connected WS
/// clients. Lazily initialized by [`start_log_stream`] the first time a client
/// connects. Mirrors the `broadcast::Sender<String>` used for metrics in
/// [`crate::metrics`] / [`crate::ws`]: one producer (the background stream
/// task) fans out to N subscribers (the WS handlers).
static LOG_TX: OnceLock<broadcast::Sender<String>> = OnceLock::new();

/// Shared engine state, set at startup when the log viewer is enabled.
/// The background stream task reads the tracked container id from here so it
/// streams the same container the dashboard is reporting metrics for.
static ENGINE_STATE: OnceLock<Arc<RwLock<Vec<EngineSnapshot>>>> = OnceLock::new();

/// Capacity of the log broadcast channel. Sized so a slow WS client can fall a
/// few seconds behind (log lines are small) without being dropped; lagged
/// clients simply skip missed lines (see [`handle_logs_socket`]).
const LOG_CHANNEL_CAPACITY: usize = 256;

/// Enable the log viewer feature. Called from `main.rs` when
/// `--enable-log-viewer` is set. Captures the shared engine state so the
/// background stream can resolve the tracked container id.
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

/// WebSocket upgrade handler for `/ws/logs`.
///
/// The Docker log stream is started only when the first client actually
/// connects (lazy connect -- no background resource consumption while
/// collapsed). Subsequent clients subscribe to the same broadcast.
pub async fn ws_logs_handler(ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(handle_logs_socket)
}

async fn handle_logs_socket(mut socket: WebSocket) {
    debug!("Logs WebSocket client connected");

    let tx = start_log_stream().await;
    let mut rx = tx.subscribe();

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

/// Lazily start the shared Docker log stream (if not already running) and
/// return a clone of the broadcast sender. Idempotent: the first caller to
/// populate `LOG_TX` wins; `STREAM_TASK_STARTED` then ensures the background
/// task is spawned exactly once. Later callers just subscribe.
async fn start_log_stream() -> broadcast::Sender<String> {
    let tx = LOG_TX
        .get_or_init(|| broadcast::channel::<String>(LOG_CHANNEL_CAPACITY).0)
        .clone();

    // Only one caller wins this CAS; it spawns the single stream task.
    if STREAM_TASK_STARTED
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        tokio::spawn(log_stream_task(tx.clone()));
    }

    tx
}

/// Guarantees the background Docker-stream task is spawned exactly once.
static STREAM_TASK_STARTED: AtomicBool = AtomicBool::new(false);

/// Background task that owns the single Docker log stream and publishes
/// line-buffered log lines to all WS clients via the broadcast channel.
async fn log_stream_task(tx: broadcast::Sender<String>) {
    let docker = match Docker::connect_with_local_defaults() {
        Ok(d) => d,
        Err(e) => {
            let _ = tx.send(format!("ERR:Could not connect to Docker daemon: {e}"));
            return;
        }
    };

    // Resolve the tracked container id from shared engine state. Poll briefly
    // in case detection hasn't completed yet at first connect.
    let container_id = match resolve_container_id().await {
        Some(id) => id,
        None => {
            let _ = tx.send("ERR:No engine container found".to_string());
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

    let mut stream = docker.logs(&container_id, Some(options));
    let mut stdout_buf = String::with_capacity(1024);
    let mut stderr_buf = String::with_capacity(1024);

    loop {
        match stream.next().await {
            Some(Ok(LogOutput::StdOut { message })) => {
                for line in buffer_lines(&mut stdout_buf, &message, None) {
                    // No subscribers is fine — a client may reconnect; keep streaming.
                    let _ = tx.send(line);
                }
            }
            Some(Ok(LogOutput::StdErr { message })) => {
                // Stderr is buffered by lines the same way stdout is: frames
                // can split a line mid-way, so accumulate until a newline.
                for line in buffer_lines(&mut stderr_buf, &message, Some("[stderr] ")) {
                    let _ = tx.send(line);
                }
            }
            Some(Ok(LogOutput::Console { message })) => {
                // Console frames are whole lines from the Docker daemon itself.
                let text = String::from_utf8_lossy(&message).to_string();
                let _ = tx.send(text);
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
                flush_trailing(&mut stdout_buf, None, &tx);
                flush_trailing(&mut stderr_buf, Some("[stderr] "), &tx);
                let _ = tx.send("LOG:Stream ended - container stopped".to_string());
                return;
            }
        }
    }
}

/// Read the tracked container id from shared engine state. Waits up to ~10s for
/// detection to populate a container id, since the log viewer may be connected
/// before the first detection sweep completes.
async fn resolve_container_id() -> Option<String> {
    let state = ENGINE_STATE.get()?;
    for _ in 0..100 {
        {
            let lock = state.read().await;
            for snap in lock.iter() {
                if let Some(id) = &snap.container_id {
                    return Some(id.clone());
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    warn!("Log viewer could not resolve a container id from engine state after 10s");
    None
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

#[cfg(test)]
mod tests {
    use super::*;

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
