//! A throwaway HTTP server for engine tests: it answers every request from a
//! handler, records what was asked, and closes the connection after each
//! reply, so an adapter's real request path runs without a real engine.

use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// What a test server was asked: the request path and, when one was sent,
/// the `Authorization` header.
#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    pub path: String,
    pub authorization: Option<String>,
}

type Handler = dyn Fn(&Request) -> (u16, String, Duration) + Send + Sync;

pub struct TestServer {
    /// `http://127.0.0.1:<port>` — what an adapter takes as its endpoint.
    pub url: String,
    requests: Arc<Mutex<Vec<Request>>>,
}

impl TestServer {
    /// Serve `handler`'s `(status, body)` for every request, on a free port.
    pub async fn start(
        handler: impl Fn(&Request) -> (u16, String) + Send + Sync + 'static,
    ) -> Self {
        Self::start_delayed(move |request| {
            let (status, body) = handler(request);
            (status, body, Duration::ZERO)
        })
        .await
    }

    /// Like [`start`](Self::start), but each reply waits for the duration the
    /// handler gives before it is sent — a server that holds a route up.
    pub async fn start_delayed(
        handler: impl Fn(&Request) -> (u16, String, Duration) + Send + Sync + 'static,
    ) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind a free port");
        let url = format!("http://{}", listener.local_addr().expect("local addr"));
        let requests: Arc<Mutex<Vec<Request>>> = Arc::default();
        let handler: Arc<Handler> = Arc::new(handler);

        let recorded = requests.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                let recorded = recorded.clone();
                let handler = handler.clone();
                tokio::spawn(async move {
                    let Some(request) = read_request(&mut sock).await else {
                        return;
                    };
                    recorded.lock().unwrap().push(request.clone());
                    let (status, body, delay) = handler(&request);
                    tokio::time::sleep(delay).await;
                    let response = format!(
                        "HTTP/1.1 {status} X\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(response.as_bytes()).await;
                });
            }
        });

        Self { url, requests }
    }

    /// Every request served so far, in arrival order.
    pub fn requests(&self) -> Vec<Request> {
        self.requests.lock().unwrap().clone()
    }
}

/// Read a bodiless request up to the end of its headers.
async fn read_request(sock: &mut tokio::net::TcpStream) -> Option<Request> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = sock.read(&mut chunk).await.ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let head = String::from_utf8_lossy(&buf);
    let mut lines = head.lines();
    let path = lines.next()?.split_whitespace().nth(1)?.to_string();
    let authorization = lines
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case("authorization"))
        .map(|(_, value)| value.trim().to_string());
    Some(Request {
        path,
        authorization,
    })
}
