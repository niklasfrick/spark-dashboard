use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use tokio::sync::broadcast;

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(tx): State<broadcast::Sender<String>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, tx))
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
