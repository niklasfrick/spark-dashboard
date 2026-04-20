mod engines;
mod metrics;
mod server;
mod ws;

use clap::Parser;
use engines::{EngineOverride, EngineType};
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};

/// Spark Dashboard - Real-time hardware metrics for the NVIDIA DGX Spark
#[derive(Parser, Debug)]
#[command(name = "spark-dashboard", version, about)]
struct Args {
    /// Port to listen on
    #[arg(short = 'p', long, default_value_t = 3000)]
    port: u16,

    /// Address to bind to
    #[arg(short = 'b', long, default_value = "0.0.0.0")]
    bind: String,

    /// Metrics polling interval in milliseconds
    #[arg(long, default_value_t = 1000)]
    poll_interval: u64,

    /// Manually specify engine type (use with --engine-url)
    #[arg(long, value_name = "TYPE")]
    engine: Vec<String>,

    /// Manually specify engine endpoint URL (use with --engine)
    #[arg(long, value_name = "URL")]
    engine_url: Vec<String>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    // Parse manual engine overrides: --engine ollama --engine-url http://localhost:11434
    // Both vectors must have the same length. Each pair creates an EngineOverride.
    let overrides: Vec<EngineOverride> = args
        .engine
        .iter()
        .zip(args.engine_url.iter())
        .filter_map(|(engine_str, url)| {
            let engine_type = match engine_str.to_lowercase().as_str() {
                "vllm" => EngineType::Vllm,
                unknown => {
                    tracing::warn!("Unknown engine type '{}', ignoring override", unknown);
                    return None;
                }
            };
            Some(EngineOverride {
                engine_type,
                endpoint: url.clone(),
            })
        })
        .collect();

    if !overrides.is_empty() {
        tracing::info!("Manual engine overrides: {:?}", overrides);
    }

    let (tx, _rx) = broadcast::channel::<String>(16);

    // Shared engine state: engine collector writes, metrics collector reads
    let engine_state: Arc<RwLock<Vec<engines::EngineSnapshot>>> =
        Arc::new(RwLock::new(Vec::new()));

    // Spawn engine collector loop as separate tokio task (Research Pitfall 7:
    // separate task so slow engine API calls don't block hardware metrics)
    tokio::spawn(engines::engine_collector_loop(
        engine_state.clone(),
        overrides,
    ));

    // Pass engine_state to metrics collector so it includes engines in snapshots
    tokio::spawn(metrics::metrics_collector(
        tx.clone(),
        args.poll_interval,
        engine_state.clone(),
    ));

    let app = server::create_router(tx);

    let addr = format!("{}:{}", args.bind, args.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("Spark Dashboard running at http://{}", addr);

    axum::serve(listener, app).await?;

    Ok(())
}
