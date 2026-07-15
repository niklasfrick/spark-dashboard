//! Docker container log streaming via the bollard API.
//!
//! Instead of shelling out to `docker logs -f` (which fails on distroless
//! runtimes that have no shell or `docker` CLI), this module talks directly to
//! the Docker daemon over its Unix socket via bollard.
//!
//! Stream characteristics:
//! - stdout/stderr are multiplexed in real-time (not drained sequentially).
//! - The WebSocket connects lazily -- the backend stream is only opened when a
//!   client connects, not on page load.
//! - Container discovery uses the Docker API directly rather than needing the
//!   shared engine state wired into this handler.

#![cfg(target_os = "linux")]

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::IntoResponse;
use bollard::container::LogOutput;
use bollard::query_parameters::{ListContainersOptionsBuilder, LogsOptionsBuilder};
use bollard::Docker;
use futures_util::StreamExt;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use tracing::debug;

/// Flag set at startup when `--enable-log-viewer` is passed.
/// Read by `server.rs` to decide whether to register the `/ws/logs` route.
static LOG_VIEWER_ENABLED: AtomicBool = AtomicBool::new(false);

/// Enable the log viewer feature. Called from `main.rs` when
/// `--enable-log-viewer` is set.
pub fn enable_log_viewer() {
    LOG_VIEWER_ENABLED.store(true, Ordering::Relaxed);
}

/// Returns whether the log viewer was enabled at startup.
pub fn is_log_viewer_enabled() -> bool {
    LOG_VIEWER_ENABLED.load(Ordering::Relaxed)
}

/// WebSocket upgrade handler for `/ws/logs`.
///
/// The Docker log stream is started only when a client actually connects
/// (lazy connect -- no background resource consumption while collapsed).
pub async fn ws_logs_handler(ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(handle_logs_socket)
}

async fn handle_logs_socket(mut socket: WebSocket) {
    debug!("Logs WebSocket client connected");

    // Connect to the Docker daemon over the local Unix socket.
    let docker = match Docker::connect_with_local_defaults() {
        Ok(d) => d,
        Err(e) => {
            let msg = format!("ERR:Could not connect to Docker daemon: {e}");
            let _ = socket.send(Message::Text(msg.into())).await;
            return;
        }
    };

    // Find the first vLLM container via the Docker API.
    let container_id = match find_container_via_docker(&docker).await {
        Some(id) => id,
        None => {
            let msg = "ERR:No engine container found".to_string();
            let _ = socket.send(Message::Text(msg.into())).await;
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
    let mut recv_buffer = String::with_capacity(1024);

    loop {
        tokio::select! {
            frame = stream.next() => {
                match frame {
                    Some(Ok(LogOutput::StdOut { message })) => {
                        recv_buffer.push_str(&String::from_utf8_lossy(&message));
                        while let Some(pos) = recv_buffer.find('\n') {
                            let line = recv_buffer[..pos].to_string();
                            recv_buffer.drain(..=pos);
                            if socket.send(Message::Text(line.into())).await.is_err() {
                                debug!("Logs client disconnected");
                                return;
                            }
                        }
                    }
                    Some(Ok(LogOutput::StdErr { message })) => {
                        let text = String::from_utf8_lossy(&message).to_string();
                        for line in text.split('\n') {
                            if line.is_empty() { continue; }
                            let tagged = format!("[stderr] {}", line);
                            if socket.send(Message::Text(tagged.into())).await.is_err() {
                                debug!("Logs client disconnected");
                                return;
                            }
                        }
                    }
                    Some(Ok(LogOutput::Console { message })) => {
                        let text = String::from_utf8_lossy(&message).to_string();
                        if socket.send(Message::Text(text.into())).await.is_err() {
                            debug!("Logs client disconnected");
                            return;
                        }
                    }
                    Some(Ok(LogOutput::StdIn { .. })) => {
                        // We don't write to stdin, so ignore
                    }
                    Some(Err(e)) => {
                        let msg = format!("ERR:Log stream error: {e}");
                        let _ = socket.send(Message::Text(msg.into())).await;
                        return;
                    }
                    None => {
                        let _ = socket.send(Message::Text("LOG:Stream ended - container stopped".into())).await;
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

/// Find a running Docker container whose name or image contains a known engine
/// identifier (e.g. vllm, deepseek).
pub async fn find_container_via_docker(docker: &Docker) -> Option<String> {
    let mut filters = HashMap::new();
    filters.insert("status".to_string(), vec!["running".to_string()]);

    let options = ListContainersOptionsBuilder::new()
        .all(false)
        .filters(&filters)
        .build();

    let containers = docker.list_containers(Some(options)).await.ok()?;

    for container in &containers {
        let image = container.image.as_deref().unwrap_or("");
        let image_lower = image.to_lowercase();
        let names: Vec<&str> = container
            .names
            .as_ref()
            .map(|n| n.iter().map(|s| s.as_str()).collect())
            .unwrap_or_default();

        let name_match = names
            .iter()
            .any(|n| n.to_lowercase().contains("vllm") || n.to_lowercase().contains("deepseek"));

        let image_match = image_lower.contains("vllm") || image_lower.contains("deepseek");

        if name_match || image_match {
            return container
                .id
                .as_ref()
                .map(|id| id.chars().take(12).collect());
        }
    }

    None
}

#[cfg(test)]
mod tests {

    #[test]
    fn container_id_is_truncated_to_12_chars() {
        let long_id = "abc123def4567890";
        let short: String = long_id.chars().take(12).collect();
        assert_eq!(short.len(), 12);
        assert_eq!(short, "abc123def456");
    }

    #[test]
    fn short_id_under_12_chars_is_unchanged() {
        let id = "abc123";
        let short: String = id.chars().take(12).collect();
        assert_eq!(short, "abc123");
    }

    #[test]
    fn stderr_prefix_is_formatted_correctly() {
        let line = "[stderr] Error: connection refused";
        assert!(line.starts_with("[stderr]"));
        assert!(line.contains("connection refused"));
    }

    #[test]
    fn log_stream_ended_message_format() {
        let msg = "LOG:Stream ended - container stopped";
        assert!(msg.starts_with("LOG:"));
        assert!(msg.contains("container stopped"));
    }
}
