use axum::response::IntoResponse;
use axum::{routing::get, Router};
use rust_embed::Embed;
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;

#[derive(Embed)]
#[folder = "frontend/dist"]
struct FrontendAssets;

pub fn create_router(tx: broadcast::Sender<String>) -> Router {
    Router::new()
        .route("/ws", get(crate::ws::ws_handler))
        // Liveness probe for container HEALTHCHECK / orchestrators. Intentionally
        // dependency-free: it reports that the HTTP server is up, not that any
        // engine/GPU is healthy (that's surfaced over /ws).
        .route("/healthz", get(healthz))
        .fallback(static_handler)
        .with_state(tx)
        .layer(CorsLayer::permissive())
}

async fn healthz() -> &'static str {
    "ok"
}

async fn static_handler(uri: axum::http::Uri) -> impl IntoResponse {
    let mut path = uri.path().trim_start_matches('/');
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

    #[tokio::test]
    async fn healthz_returns_ok() {
        let (tx, _rx) = broadcast::channel::<String>(16);
        let app = create_router(tx);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let resp = reqwest::get(format!("http://{addr}/healthz"))
            .await
            .expect("request to /healthz");
        assert_eq!(resp.status(), reqwest::StatusCode::OK);
        assert_eq!(resp.text().await.unwrap(), "ok");
    }
}
