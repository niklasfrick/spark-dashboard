//! Liveness-probe subcommand.
//!
//! The runtime container is distroless (no shell, no `wget`), so the image
//! `HEALTHCHECK` cannot shell out to an HTTP client. Instead it execs the binary
//! itself: `spark-dashboard healthcheck` probes the local `/healthz` endpoint and
//! maps the result to a process exit code Docker can read.

use std::process::ExitCode;

/// Probe the local `/healthz` endpoint over loopback.
///
/// Returns `true` iff the server answers with a success status. The probe always
/// targets `127.0.0.1` regardless of `SPARK_DASHBOARD_BIND`: liveness is checked
/// from inside the container, so the bind address is irrelevant.
pub async fn probe(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}/healthz");
    match reqwest::get(&url).await {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

/// Run the probe on a short-lived current-thread runtime and map it to an exit
/// code: `SUCCESS` when healthy, `FAILURE` otherwise.
pub fn run(port: u16) -> ExitCode {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(_) => return ExitCode::FAILURE,
    };

    if runtime.block_on(probe(port)) {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::broadcast;

    #[tokio::test]
    async fn probe_succeeds_against_running_server() {
        let (tx, _rx) = broadcast::channel::<String>(16);
        let app = crate::server::create_router(tx);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        assert!(probe(port).await);
    }

    #[tokio::test]
    async fn probe_fails_when_nothing_listening() {
        // Bind then drop to obtain a port that is (almost certainly) free.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        assert!(!probe(port).await);
    }
}
