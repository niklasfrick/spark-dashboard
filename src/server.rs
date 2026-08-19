use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, FromRef, State};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::Router;
use rust_embed::Embed;
use std::sync::Arc;
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;

use crate::config_store::{ConfigStore, MAX_DOCUMENT_BYTES};
use crate::hec::{self, SharedExportStatus, SharedHecConfig};

#[derive(Embed)]
#[folder = "frontend/dist"]
struct FrontendAssets;

/// Reports that the dashboard configuration cannot be saved, so the client can
/// show its read-only banner *before* the operator arranges panels and tries.
/// Sent on every configuration response; the document itself has to come back
/// byte-identical, so the status cannot ride along in the body.
const READ_ONLY_HEADER: &str = "x-spark-dashboard-read-only";

/// Everything the router's handlers need. The metrics sender was previously the
/// whole state; it is reachable through [`FromRef`] so existing handlers keep
/// extracting `State<broadcast::Sender<String>>` unchanged.
#[derive(Clone)]
pub struct AppState {
    pub metrics_tx: broadcast::Sender<String>,
    pub config: Arc<ConfigStore>,
    /// Live `export.hec` section of the stored document, kept warm so the
    /// exporter and the status endpoint do not re-read the file per tick.
    /// Updated by the dashboard write paths, which are the only writers.
    pub hec_config: SharedHecConfig,
    /// What the exporter is doing right now, published by the exporter task.
    pub export_status: SharedExportStatus,
    /// Hostname stamped into HEC events, so `_host` identifies this machine
    /// rather than the receiving Splunk host.
    pub hostname: String,
}

impl FromRef<AppState> for broadcast::Sender<String> {
    fn from_ref(state: &AppState) -> Self {
        state.metrics_tx.clone()
    }
}

pub fn create_router(state: AppState) -> Router {
    let api = Router::new()
        .route(
            "/dashboard",
            get(get_dashboard)
                .put(put_dashboard)
                .delete(delete_dashboard),
        )
        // Export status: polled by the settings dialog (5 s while open) and
        // the header status dot (10 s). A dedicated route on purpose — the
        // WebSocket channel is the metrics firehose and is not overloaded
        // with control-plane messages (ADR 0001).
        .route("/export-status", get(get_export_status))
        .route("/export/test", post(test_export))
        // One cap, enforced twice at the same threshold: the layer stops the
        // server buffering anything larger, and the handler rejects a body that
        // is exactly one byte over so the limit is ours rather than a tower
        // default that could drift.
        .layer(DefaultBodyLimit::max(MAX_DOCUMENT_BYTES + 1))
        // Without this, the SPA fallback below would answer a typo'd or
        // unregistered API path with the app shell and status 200 — a client bug
        // would look like success.
        .fallback(api_not_found);

    // `mut` is only exercised by the Linux-gated log-viewer block below.
    #[cfg_attr(not(target_os = "linux"), allow(unused_mut))]
    let mut router = Router::new()
        .route("/ws", get(crate::ws::ws_handler))
        // Liveness probe for container HEALTHCHECK / orchestrators. Intentionally
        // dependency-free: it reports that the HTTP server is up, not that any
        // engine/GPU is healthy (that's surfaced over /ws).
        .route("/healthz", get(healthz))
        .nest("/api", api)
        .fallback(static_handler)
        .with_state(state)
        .layer(CorsLayer::permissive());

    // Conditionally register the experimental log viewer endpoint.
    // Gated behind --enable-log-viewer so deployments can opt out of
    // exposing unauthenticated container logs.
    #[cfg(target_os = "linux")]
    if crate::logs::is_log_viewer_enabled() {
        router = router.route("/ws/logs", get(crate::logs::ws_logs_handler));
    }

    router
}

async fn healthz() -> &'static str {
    "ok"
}

/// Returns the stored document, or `204 No Content` when nothing has been
/// stored. Absence is not an error — it is what a fresh install and a reset
/// both look like, and the client renders the default preset for it.
///
/// One deliberate exception to "stored verbatim": a stored `export.hec.token`
/// comes back masked (`…abcd`). The token is write-only through the API —
/// the client cannot read it back, and a save that sends an empty token keeps
/// the stored one (see [`put_dashboard`]).
async fn get_dashboard(State(state): State<AppState>) -> impl IntoResponse {
    match state.config.load().await {
        Ok(Some(document)) => {
            let body = hec::mask_token_in_document(&document).unwrap_or(document);
            (
                axum::http::StatusCode::OK,
                [
                    (
                        axum::http::header::CONTENT_TYPE,
                        // The server does not parse the document; this describes the
                        // media type the resource is defined to carry, not a claim
                        // that these particular bytes were validated.
                        "application/json".to_string(),
                    ),
                    (
                        axum::http::HeaderName::from_static(READ_ONLY_HEADER),
                        state.config.is_read_only().to_string(),
                    ),
                ],
                body,
            )
                .into_response()
        }
        Ok(None) => no_content(&state),
        Err(err) => {
            tracing::error!("reading the dashboard configuration failed: {err}");
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                read_only_headers(&state),
                "Failed to read the dashboard configuration",
            )
                .into_response()
        }
    }
}

/// Replaces the document wholesale. The body is stored as received except
/// for one schema-aware merge: the `export.hec` token. The client receives
/// the token masked on read, so it cannot re-send it; a save with an empty
/// token therefore keeps the stored token, and a save that drops the section
/// drops the credential with it. Everything else stays opaque bytes.
async fn put_dashboard(State(state): State<AppState>, body: Bytes) -> impl IntoResponse {
    if body.len() > MAX_DOCUMENT_BYTES {
        return (
            axum::http::StatusCode::PAYLOAD_TOO_LARGE,
            read_only_headers(&state),
            "Dashboard configuration exceeds the size limit",
        )
            .into_response();
    }

    if state.config.is_read_only() {
        return read_only_response(&state);
    }

    let stored = state
        .config
        .load()
        .await
        .ok()
        .flatten()
        .as_deref()
        .and_then(hec::hec_target_from_document);
    let bytes = match &stored {
        Some(stored_target) => hec::retain_token_in_document(&body, &stored_target.token)
            .unwrap_or_else(|| body.to_vec()),
        None => body.to_vec(),
    };

    match state.config.store(&bytes).await {
        Ok(()) => {
            // Keep the shared view in sync — the exporter and the test route
            // read this, not the file.
            *state.hec_config.write().await = hec::hec_target_from_document(&bytes);
            no_content(&state)
        }
        Err(err) => {
            tracing::error!("writing the dashboard configuration failed: {err}");
            write_failed_response(&state)
        }
    }
}

/// Removes the document, which is how a reset works: "the default preset" *is*
/// "the file does not exist".
async fn delete_dashboard(State(state): State<AppState>) -> impl IntoResponse {
    if state.config.is_read_only() {
        return read_only_response(&state);
    }

    match state.config.delete().await {
        Ok(()) => {
            // No document, no export: the section is gone, including the
            // token.
            *state.hec_config.write().await = None;
            no_content(&state)
        }
        Err(err) => {
            tracing::error!("deleting the dashboard configuration failed: {err}");
            write_failed_response(&state)
        }
    }
}

/// What the exporter is doing right now: `state`, reachability, last success,
/// last error (a short machine-readable code — the UI owns the operator
/// copy) and the dropped-snapshot counter.
async fn get_export_status(State(state): State<AppState>) -> impl IntoResponse {
    let status = state.export_status.lock().await.clone();
    axum::Json(status).into_response()
}

/// Posts the connectivity test event (`metric_name:spark_dashboard.connectivity.test`)
/// and reports a fine-grained outcome the settings dialog maps to its
/// dedicated copy. A misconfigured or absent section is a normal answer, not
/// an HTTP error — the dialog needs a distinct line for it.
///
/// The body carries an optional override (`{url, token, index}`) so the
/// dialog can test an edit before saving it — an empty body (or one that
/// fails to parse) tests the stored target unchanged, which is also what a
/// pre-fix client still sends.
async fn test_export(State(state): State<AppState>, body: Bytes) -> impl IntoResponse {
    let override_ = serde_json::from_slice(&body).unwrap_or_default();
    let stored = state.hec_config.read().await.clone();
    let target = hec::resolve_test_target(override_, stored.as_ref()).filter(|t| t.usable());
    let Some(target) = target else {
        return axum::Json(serde_json::json!({
            "outcome": "misconfigured",
            "index": null,
        }))
        .into_response();
    };

    let client = reqwest::Client::builder()
        .timeout(hec::POST_TIMEOUT)
        .build()
        .expect("reqwest client");
    let outcome = hec::run_test(&client, &target, &state.hostname).await;
    axum::Json(serde_json::json!({
        "outcome": serde_json::to_value(outcome).expect("outcome serializes"),
        "index": target.index,
    }))
    .into_response()
}

async fn api_not_found() -> impl IntoResponse {
    not_found()
}

fn not_found() -> axum::response::Response {
    (axum::http::StatusCode::NOT_FOUND, "Not Found").into_response()
}

fn no_content(state: &AppState) -> axum::response::Response {
    (axum::http::StatusCode::NO_CONTENT, read_only_headers(state)).into_response()
}

/// This instance cannot save at all, and no retry will change that.
fn read_only_response(state: &AppState) -> axum::response::Response {
    (
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        read_only_headers(state),
        "Dashboard configuration storage is read-only",
    )
        .into_response()
}

/// The state directory was writable at startup but this write still failed — a
/// full or failing disk, say. Deliberately *not* the read-only response: that
/// one promises a permanent condition the client should surface as a banner,
/// and the read-only header would contradict it.
fn write_failed_response(state: &AppState) -> axum::response::Response {
    (
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        read_only_headers(state),
        "Failed to save the dashboard configuration",
    )
        .into_response()
}

fn read_only_headers(state: &AppState) -> [(axum::http::HeaderName, String); 1] {
    [(
        axum::http::HeaderName::from_static(READ_ONLY_HEADER),
        state.config.is_read_only().to_string(),
    )]
}

async fn static_handler(uri: axum::http::Uri) -> impl IntoResponse {
    let mut path = uri.path().trim_start_matches('/');

    // The nested API router's own fallback catches most unmatched API paths, but
    // not the bare prefix (`/api`, `/api/`), which never routes into the nest.
    // Those must not answer with the app shell either.
    if path == "api" || path.starts_with("api/") {
        return not_found();
    }

    if path.is_empty() {
        path = "index.html";
    }

    // Try exact file match first
    if let Some(file) = FrontendAssets::get(path) {
        let mime = mime_guess::from_path(path).first_or_octet_stream();
        return (
            axum::http::StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, mime.as_ref().to_string())],
            file.data.into_owned(),
        )
            .into_response();
    }

    // SPA fallback: serve index.html for any unmatched route
    if let Some(index) = FrontendAssets::get("index.html") {
        return (
            axum::http::StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "text/html".to_string())],
            index.data.into_owned(),
        )
            .into_response();
    }

    (axum::http::StatusCode::NOT_FOUND, "Not Found").into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hec::ExportStatus;
    use tokio::sync::{Mutex, RwLock};

    /// Spawns the server over a fresh state directory and returns its address
    /// alongside the directory guard, which must stay alive for the test.
    async fn spawn(state_dir: &std::path::Path) -> String {
        let (tx, _rx) = broadcast::channel::<String>(16);
        let state = AppState {
            metrics_tx: tx,
            config: Arc::new(ConfigStore::new(state_dir).await),
            hec_config: Arc::new(RwLock::new(None)),
            export_status: Arc::new(Mutex::new(ExportStatus::disabled())),
            hostname: "test-host".into(),
        };
        let app = create_router(state);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        format!("http://{addr}")
    }

    #[tokio::test]
    async fn healthz_returns_ok() {
        let dir = tempfile::tempdir().unwrap();
        let base = spawn(dir.path()).await;

        let resp = reqwest::get(format!("{base}/healthz"))
            .await
            .expect("request to /healthz");
        assert_eq!(resp.status(), reqwest::StatusCode::OK);
        assert_eq!(resp.text().await.unwrap(), "ok");
    }

    #[tokio::test]
    async fn reading_with_no_document_reports_absent() {
        let dir = tempfile::tempdir().unwrap();
        let base = spawn(dir.path()).await;

        let resp = reqwest::get(format!("{base}/api/dashboard")).await.unwrap();

        assert_eq!(resp.status(), reqwest::StatusCode::NO_CONTENT);
        assert_eq!(resp.text().await.unwrap(), "");
    }

    #[tokio::test]
    async fn write_then_read_returns_the_document_byte_identically() {
        let dir = tempfile::tempdir().unwrap();
        let base = spawn(dir.path()).await;
        let document = r#"{"schemaVersion":1,"pages":[{"name":"Overview"}]}"#;

        let put = reqwest::Client::new()
            .put(format!("{base}/api/dashboard"))
            .body(document)
            .send()
            .await
            .unwrap();
        assert_eq!(put.status(), reqwest::StatusCode::NO_CONTENT);

        let resp = reqwest::get(format!("{base}/api/dashboard")).await.unwrap();
        assert_eq!(resp.status(), reqwest::StatusCode::OK);
        assert_eq!(resp.text().await.unwrap(), document);
    }

    #[tokio::test]
    async fn a_document_the_server_cannot_interpret_round_trips_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let base = spawn(dir.path()).await;
        // Deliberately not JSON: the server must store bytes, not documents.
        let opaque: Vec<u8> = vec![0xff, 0xfe, 0x00, b'{', b'n', b'o', b'p', b'e'];

        let put = reqwest::Client::new()
            .put(format!("{base}/api/dashboard"))
            .body(opaque.clone())
            .send()
            .await
            .unwrap();
        assert_eq!(put.status(), reqwest::StatusCode::NO_CONTENT);

        let resp = reqwest::get(format!("{base}/api/dashboard")).await.unwrap();
        assert_eq!(resp.status(), reqwest::StatusCode::OK);
        assert_eq!(resp.bytes().await.unwrap().to_vec(), opaque);
    }

    #[tokio::test]
    async fn a_write_over_the_size_cap_is_rejected_and_leaves_the_document_alone() {
        let dir = tempfile::tempdir().unwrap();
        let base = spawn(dir.path()).await;
        let client = reqwest::Client::new();

        client
            .put(format!("{base}/api/dashboard"))
            .body("original")
            .send()
            .await
            .unwrap();

        let oversized = vec![b'x'; MAX_DOCUMENT_BYTES + 1];
        let put = client
            .put(format!("{base}/api/dashboard"))
            .body(oversized)
            .send()
            .await
            .unwrap();
        assert_eq!(put.status(), reqwest::StatusCode::PAYLOAD_TOO_LARGE);

        let resp = reqwest::get(format!("{base}/api/dashboard")).await.unwrap();
        assert_eq!(resp.text().await.unwrap(), "original");
    }

    #[tokio::test]
    async fn delete_removes_the_document_and_a_later_read_reports_absent() {
        let dir = tempfile::tempdir().unwrap();
        let base = spawn(dir.path()).await;
        let client = reqwest::Client::new();

        client
            .put(format!("{base}/api/dashboard"))
            .body("{}")
            .send()
            .await
            .unwrap();

        let deleted = client
            .delete(format!("{base}/api/dashboard"))
            .send()
            .await
            .unwrap();
        assert_eq!(deleted.status(), reqwest::StatusCode::NO_CONTENT);

        let resp = reqwest::get(format!("{base}/api/dashboard")).await.unwrap();
        assert_eq!(resp.status(), reqwest::StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn a_writable_instance_reports_that_it_is_not_read_only() {
        let dir = tempfile::tempdir().unwrap();
        let base = spawn(dir.path()).await;

        let resp = reqwest::get(format!("{base}/api/dashboard")).await.unwrap();

        assert_eq!(
            resp.headers().get(READ_ONLY_HEADER).unwrap(),
            "false",
            "read-only status must be discoverable from the read"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_unwritable_state_directory_serves_reads_and_refuses_writes() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let state_dir = dir.path().join("state");
        tokio::fs::create_dir(&state_dir).await.unwrap();
        tokio::fs::write(state_dir.join("dashboards.json"), b"{\"seeded\":true}")
            .await
            .unwrap();
        tokio::fs::set_permissions(&state_dir, std::fs::Permissions::from_mode(0o555))
            .await
            .unwrap();

        // Root ignores directory permissions; CI runs unprivileged, where this
        // exercises the real read-only path.
        let probe = state_dir.join(".privilege-check");
        if tokio::fs::write(&probe, b"").await.is_ok() {
            let _ = tokio::fs::remove_file(&probe).await;
            tokio::fs::set_permissions(&state_dir, std::fs::Permissions::from_mode(0o755))
                .await
                .unwrap();
            eprintln!("skipping: running privileged, directory permissions do not apply");
            return;
        }

        let base = spawn(&state_dir).await;

        // The server came up rather than refusing to start.
        let health = reqwest::get(format!("{base}/healthz")).await.unwrap();
        assert_eq!(health.status(), reqwest::StatusCode::OK);

        let read = reqwest::get(format!("{base}/api/dashboard")).await.unwrap();
        assert_eq!(read.status(), reqwest::StatusCode::OK);
        assert_eq!(read.headers().get(READ_ONLY_HEADER).unwrap(), "true");
        assert_eq!(read.text().await.unwrap(), "{\"seeded\":true}");

        let client = reqwest::Client::new();
        let write = client
            .put(format!("{base}/api/dashboard"))
            .body("{}")
            .send()
            .await
            .unwrap();
        assert_eq!(write.status(), reqwest::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            write.headers().get(READ_ONLY_HEADER).unwrap(),
            "true",
            "the refusal must agree with the read-only header it carries"
        );

        let deleted = client
            .delete(format!("{base}/api/dashboard"))
            .send()
            .await
            .unwrap();
        assert_eq!(deleted.status(), reqwest::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(deleted.headers().get(READ_ONLY_HEADER).unwrap(), "true");

        tokio::fs::set_permissions(&state_dir, std::fs::Permissions::from_mode(0o755))
            .await
            .unwrap();
    }

    /// A directory that was writable at startup but is not any more. This is a
    /// plain failure, not the permanent read-only condition — reporting it as
    /// read-only would contradict the header, which still says `false`.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_write_that_fails_after_startup_is_not_reported_as_read_only() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let state_dir = dir.path().join("state");
        tokio::fs::create_dir(&state_dir).await.unwrap();

        let base = spawn(&state_dir).await;
        let client = reqwest::Client::new();

        // Writable at startup, so the store probed clean.
        let first = client
            .put(format!("{base}/api/dashboard"))
            .body("original")
            .send()
            .await
            .unwrap();
        assert_eq!(first.status(), reqwest::StatusCode::NO_CONTENT);

        tokio::fs::set_permissions(&state_dir, std::fs::Permissions::from_mode(0o555))
            .await
            .unwrap();

        let probe = state_dir.join(".privilege-check");
        if tokio::fs::write(&probe, b"").await.is_ok() {
            let _ = tokio::fs::remove_file(&probe).await;
            tokio::fs::set_permissions(&state_dir, std::fs::Permissions::from_mode(0o755))
                .await
                .unwrap();
            eprintln!("skipping: running privileged, directory permissions do not apply");
            return;
        }

        let failed = client
            .put(format!("{base}/api/dashboard"))
            .body("replacement")
            .send()
            .await
            .unwrap();
        assert_eq!(failed.status(), reqwest::StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            failed.headers().get(READ_ONLY_HEADER).unwrap(),
            "false",
            "the instance is not read-only; this write just failed"
        );

        tokio::fs::set_permissions(&state_dir, std::fs::Permissions::from_mode(0o755))
            .await
            .unwrap();

        // The failed write left the previous document untouched.
        let resp = reqwest::get(format!("{base}/api/dashboard")).await.unwrap();
        assert_eq!(resp.text().await.unwrap(), "original");
    }

    #[tokio::test]
    async fn an_unmatched_api_path_returns_404_rather_than_the_app_shell() {
        let dir = tempfile::tempdir().unwrap();
        let base = spawn(dir.path()).await;

        for path in ["/api/nope", "/api/dashboard/extra", "/api/", "/api"] {
            let resp = reqwest::get(format!("{base}{path}")).await.unwrap();
            assert_eq!(
                resp.status(),
                reqwest::StatusCode::NOT_FOUND,
                "{path} should 404"
            );
        }
    }

    #[tokio::test]
    async fn a_legacy_document_without_the_export_section_loads_as_disabled() {
        let dir = tempfile::tempdir().unwrap();
        let state_dir = dir.path().join("state");
        std::fs::create_dir_all(&state_dir).unwrap();
        std::fs::write(
            state_dir.join("dashboards.json"),
            r#"{"version":1,"pages":[{"id":"p1","name":"Overview","panels":[]}]}"#,
        )
        .unwrap();

        let base = spawn(&state_dir).await;

        let read = reqwest::get(format!("{base}/api/dashboard"))
            .await
            .expect("read the document");
        assert_eq!(read.status(), reqwest::StatusCode::OK);

        let status: serde_json::Value = reqwest::get(format!("{base}/api/export-status"))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(status["state"], "disabled");
        assert_eq!(status["reachable"], false);
    }

    #[tokio::test]
    async fn export_status_reports_the_disabled_shape_by_default() {
        let dir = tempfile::tempdir().unwrap();
        let base = spawn(dir.path()).await;

        let status: serde_json::Value = reqwest::get(format!("{base}/api/export-status"))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(
            status,
            serde_json::json!({
                "state": "disabled",
                "reachable": false,
                "last_ok_ms": null,
                "last_error": null,
                "dropped_count": 0,
            })
        );
    }

    #[tokio::test]
    async fn the_stored_hec_token_is_masked_on_read_and_kept_on_empty_save() {
        let dir = tempfile::tempdir().unwrap();
        let base = spawn(dir.path()).await;
        let client = reqwest::Client::new();

        let with_token = r#"{"version":1,"pages":[],"export":{"hec":{"url":"https://splunk.example:8088/services/collector","token":"super-secret-token-abc","index":"metrics","events_index":"main"}}}"#;
        let put = client
            .put(format!("{base}/api/dashboard"))
            .body(with_token)
            .send()
            .await
            .unwrap();
        assert_eq!(put.status(), reqwest::StatusCode::NO_CONTENT);

        // Read: the token comes back masked, nothing else changes.
        let read = reqwest::get(format!("{base}/api/dashboard")).await.unwrap();
        let value: serde_json::Value = read.json().await.unwrap();
        assert_eq!(value["export"]["hec"]["token"], "…-abc");
        assert_eq!(
            value["export"]["hec"]["url"],
            "https://splunk.example:8088/services/collector"
        );

        // Save with the empty token keeps the stored one — the client never
        // re-sends what it cannot see.
        let empty_token = r#"{"version":1,"pages":[],"export":{"hec":{"url":"https://splunk.example:8088/services/collector","token":"","index":"metrics","events_index":"main"}}}"#;
        let put = client
            .put(format!("{base}/api/dashboard"))
            .body(empty_token)
            .send()
            .await
            .unwrap();
        assert_eq!(put.status(), reqwest::StatusCode::NO_CONTENT);
        let value: serde_json::Value = reqwest::get(format!("{base}/api/dashboard"))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(
            value["export"]["hec"]["token"], "…-abc",
            "empty save must keep the stored token"
        );

        // A fresh token replaces it.
        let fresh_token = r#"{"version":1,"pages":[],"export":{"hec":{"url":"https://splunk.example:8088/services/collector","token":"brand-new-token-xyz","index":"metrics","events_index":"main"}}}"#;
        client
            .put(format!("{base}/api/dashboard"))
            .body(fresh_token)
            .send()
            .await
            .unwrap();
        let value: serde_json::Value = reqwest::get(format!("{base}/api/dashboard"))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(value["export"]["hec"]["token"], "…-xyz");

        // Dropping the section disables the export and forgets the token: a
        // later save with an empty token must not resurrect it.
        client
            .put(format!("{base}/api/dashboard"))
            .body(r#"{"version":1,"pages":[]}"#)
            .send()
            .await
            .unwrap();
        client
            .put(format!("{base}/api/dashboard"))
            .body(empty_token)
            .send()
            .await
            .unwrap();
        let value: serde_json::Value = reqwest::get(format!("{base}/api/dashboard"))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(
            value["export"]["hec"]["token"], "",
            "the token is gone for good"
        );
    }

    #[tokio::test]
    async fn the_connectivity_test_reports_misconfigured_without_a_section() {
        let dir = tempfile::tempdir().unwrap();
        let base = spawn(dir.path()).await;

        let body: serde_json::Value = reqwest::Client::new()
            .post(format!("{base}/api/export/test"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(body["outcome"], "misconfigured");
    }

    #[tokio::test]
    async fn the_connectivity_test_reports_unreachable_for_a_refused_endpoint() {
        let dir = tempfile::tempdir().unwrap();
        let base = spawn(dir.path()).await;
        let client = reqwest::Client::new();

        // Port 1 on loopback is refused by any sensible machine.
        let doc = r#"{"version":1,"pages":[],"export":{"hec":{"url":"http://127.0.0.1:1/collector","token":"t","index":"metrics","events_index":"main"}}}"#;
        client
            .put(format!("{base}/api/dashboard"))
            .body(doc)
            .send()
            .await
            .unwrap();

        let body: serde_json::Value = client
            .post(format!("{base}/api/export/test"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(body["outcome"], "unreachable");
        assert_eq!(body["index"], "metrics");
    }

    #[tokio::test]
    async fn the_connectivity_test_uses_an_unsaved_override_instead_of_the_stored_target() {
        let dir = tempfile::tempdir().unwrap();
        let base = spawn(dir.path()).await;
        let client = reqwest::Client::new();

        // Stored target points at a refused port; the dialog is mid-edit with
        // a *different* (also refused, but distinguishably so) URL that was
        // never saved.
        let doc = r#"{"version":1,"pages":[],"export":{"hec":{"url":"http://127.0.0.1:1/collector","token":"stored-token","index":"metrics","events_index":"main"}}}"#;
        client
            .put(format!("{base}/api/dashboard"))
            .body(doc)
            .send()
            .await
            .unwrap();

        let override_body =
            r#"{"url":"http://127.0.0.1:2/collector","token":"typed-token","index":"typed-index"}"#;
        let body: serde_json::Value = client
            .post(format!("{base}/api/export/test"))
            .body(override_body)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        // Both ports are refused, so the outcome is the same either way — the
        // index in the response is what actually proves the override (not the
        // stored config) was tested.
        assert_eq!(body["outcome"], "unreachable");
        assert_eq!(body["index"], "typed-index");
    }

    #[tokio::test]
    async fn the_connectivity_test_falls_back_to_the_stored_token_for_a_masked_override() {
        let dir = tempfile::tempdir().unwrap();
        let base = spawn(dir.path()).await;
        let client = reqwest::Client::new();

        let doc = r#"{"version":1,"pages":[],"export":{"hec":{"url":"http://127.0.0.1:1/collector","token":"stored-token","index":"metrics","events_index":"main"}}}"#;
        client
            .put(format!("{base}/api/dashboard"))
            .body(doc)
            .send()
            .await
            .unwrap();

        // The dialog reseeds its token field with the masked value on open;
        // testing without touching it must not send that placeholder as a
        // literal token.
        let override_body = r#"{"url":"http://127.0.0.1:1/collector","token":"…oken"}"#;
        let body: serde_json::Value = client
            .post(format!("{base}/api/export/test"))
            .body(override_body)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(body["outcome"], "unreachable");
        assert_eq!(
            body["index"], "metrics",
            "falls back to the stored index too"
        );
    }

    #[tokio::test]
    async fn an_unsupported_method_on_the_config_route_is_not_the_app_shell() {
        let dir = tempfile::tempdir().unwrap();
        let base = spawn(dir.path()).await;

        let resp = reqwest::Client::new()
            .post(format!("{base}/api/dashboard"))
            .body("{}")
            .send()
            .await
            .unwrap();

        assert_eq!(resp.status(), reqwest::StatusCode::METHOD_NOT_ALLOWED);
    }
}
