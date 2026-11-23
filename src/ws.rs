use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::header::{HOST, ORIGIN};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use tokio::sync::broadcast;

/// Browsers send `Origin` on a WebSocket handshake but apply no CORS to it, so
/// without this check any page open on a LAN machine could read the stream.
/// Clients that send no `Origin` (curl, native tools) are not browsers and pass.
/// Only host and port are compared: a TLS-terminating proxy changes the scheme.
pub fn same_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(ORIGIN) else {
        return true;
    };
    let origin_authority = origin
        .to_str()
        .ok()
        .and_then(|o| o.parse::<Uri>().ok())
        .filter(|uri| uri.scheme().is_some())
        .and_then(|uri| uri.authority().map(|a| a.as_str().to_owned()));
    let host = headers.get(HOST).and_then(|h| h.to_str().ok());
    matches!((origin_authority, host), (Some(o), Some(h)) if o.eq_ignore_ascii_case(h))
}

pub async fn ws_handler(
    headers: HeaderMap,
    ws: WebSocketUpgrade,
    State(tx): State<broadcast::Sender<String>>,
) -> Response {
    if !same_origin(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, tx))
        .into_response()
}

async fn handle_socket(mut socket: WebSocket, tx: broadcast::Sender<String>) {
    let mut rx = tx.subscribe();
    tracing::debug!("WebSocket client connected");

    loop {
        match rx.recv().await {
            Ok(msg) => {
                if socket.send(Message::Text(msg.into())).await.is_err() {
                    tracing::debug!("WebSocket client disconnected");
                    break;
                }
            }
            Err(broadcast::error::RecvError::Lagged(n)) => {
                tracing::warn!("WebSocket client lagged, skipped {} messages", n);
                continue;
            }
            Err(broadcast::error::RecvError::Closed) => {
                tracing::info!("Broadcast channel closed, shutting down WebSocket");
                break;
            }
        }
    }
}
