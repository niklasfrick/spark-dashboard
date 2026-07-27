use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, FromRef, State};
use axum::response::IntoResponse;
use axum::{routing::get, Router};
use rust_embed::Embed;
use std::sync::Arc;
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;

use crate::config_store::{ConfigStore, MAX_DOCUMENT_BYTES};

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

/// Returns the stored document verbatim, or `204 No Content` when nothing has
/// been stored. Absence is not an error — it is what a fresh install and a reset
/// both look like, and the client renders the default preset for it.
async fn get_dashboard(State(state): State<AppState>) -> impl IntoResponse {
    match state.config.load().await {
        Ok(Some(document)) => (
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
            document,
        )
            .into_response(),
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

/// Replaces the document wholesale. The body is stored exactly as received —
/// no parsing, no validation, no schema knowledge on this side of the wire.
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

    match state.config.store(&body).await {
        Ok(()) => no_content(&state),
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
        Ok(()) => no_content(&state),
        Err(err) => {
            tracing::error!("deleting the dashboard configuration failed: {err}");
            write_failed_response(&state)
        }
    }
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

    /// Spawns the server over a fresh state directory and returns its address
    /// alongside the directory guard, which must stay alive for the test.
    async fn spawn(state_dir: &std::path::Path) -> String {
        let (tx, _rx) = broadcast::channel::<String>(16);
        let state = AppState {
            metrics_tx: tx,
            config: Arc::new(ConfigStore::new(state_dir).await),
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
