mod cli;
mod config_store;
/// Test-only: asserts the deployment files agree with [`DEFAULT_STATE_DIR`].
#[cfg(test)]
mod deploy_files;
mod engines;
mod hec;
mod metrics;
mod server;
mod ws;

#[cfg(target_os = "linux")]
mod logs;

use clap::{Args, Parser, Subcommand};
use cli::service::ServiceCommand;
use engines::{ApiKeyResolver, EngineOverride, EngineType};
use std::process::ExitCode;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex, RwLock};

/// Default directory for mutable state.
///
/// Both deployments are arranged to hand the service exactly this path, so the
/// binary needs no deployment-specific default: the systemd unit's
/// `StateDirectory=spark-dashboard` grant resolves here, and the container image
/// creates it owned by its non-root user for a named volume to be mounted over.
/// `src/deploy_files.rs` holds the tests that keep those files and this constant
/// in agreement.
const DEFAULT_STATE_DIR: &str = "/var/lib/spark-dashboard";

/// Spark Dashboard — Real-time hardware and LLM monitoring for Linux hosts with NVIDIA GPUs.
#[derive(Parser, Debug)]
#[command(name = "spark-dashboard", version, about)]
struct Cli {
    #[command(flatten)]
    run: RunArgs,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Manage the systemd service (install, uninstall, status).
    #[command(subcommand)]
    Service(ServiceCommand),
    /// Probe the local /healthz endpoint and exit 0 (healthy) or 1.
    ///
    /// Used as the container HEALTHCHECK: the distroless runtime has no shell or
    /// `wget`, so the image execs the binary itself to check liveness.
    Healthcheck(HealthcheckArgs),
}

#[derive(Args, Debug)]
struct HealthcheckArgs {
    /// Port the server listens on (probed over 127.0.0.1).
    #[arg(
        short = 'p',
        long,
        env = "SPARK_DASHBOARD_PORT",
        default_value_t = 3000
    )]
    port: u16,
}

#[derive(Args, Debug)]
struct RunArgs {
    /// Port to listen on
    #[arg(
        short = 'p',
        long,
        env = "SPARK_DASHBOARD_PORT",
        default_value_t = 3000
    )]
    port: u16,

    /// Address to bind to
    #[arg(
        short = 'b',
        long,
        env = "SPARK_DASHBOARD_BIND",
        default_value = "0.0.0.0"
    )]
    bind: String,

    /// Metrics polling interval in milliseconds
    #[arg(long, env = "SPARK_DASHBOARD_POLL_INTERVAL", default_value_t = 1000)]
    poll_interval: u64,

    /// Directory holding mutable state, currently the dashboard configuration
    /// document (`<state-dir>/dashboards.json`). The default is the path the
    /// unit's `StateDirectory=` grant yields; the container image points it at
    /// the same path, backed by a named volume.
    /// An unwritable directory is not fatal — the dashboard runs read-only.
    #[arg(
        long,
        value_name = "DIR",
        env = "SPARK_DASHBOARD_STATE_DIR",
        default_value = DEFAULT_STATE_DIR
    )]
    state_dir: String,

    /// Optional NVML GPU index to monitor. By default, all available NVIDIA GPUs
    /// are monitored; set this to keep the dashboard focused on one device.
    /// Out-of-range values log a warning and fall back to empty GPU metrics.
    #[arg(long, env = "SPARK_DASHBOARD_GPU_INDEX")]
    gpu_index: Option<u32>,

    /// Number of fictive GPUs to append after the real ones (development aid).
    /// Each emits plausible oscillating metrics and occasional thermal events
    /// through the normal snapshot pipeline, so multi-GPU UI paths can be
    /// exercised on single-GPU (or GPU-less) hosts.
    #[arg(long, env = "SPARK_DASHBOARD_SIMULATE_GPUS", default_value_t = 0)]
    simulate_gpus: u32,

    /// Manually specify engine type (use with --engine-url)
    #[arg(
        long,
        value_name = "TYPE",
        env = "SPARK_DASHBOARD_ENGINE",
        value_delimiter = ','
    )]
    engine: Vec<String>,

    /// Manually specify engine endpoint URL (use with --engine)
    #[arg(
        long,
        value_name = "URL",
        env = "SPARK_DASHBOARD_ENGINE_URL",
        value_delimiter = ','
    )]
    engine_url: Vec<String>,

    /// API key for an engine endpoint, paired by index with --engine-url.
    /// For auth-gated deployments (e.g. vLLM started with --api-key) this
    /// lets the initial /v1/models lookup succeed instead of 401-spamming.
    #[arg(
        long,
        value_name = "KEY",
        env = "SPARK_DASHBOARD_ENGINE_API_KEY",
        value_delimiter = ','
    )]
    engine_api_key: Vec<String>,

    /// Fallback API key applied to any engine endpoint without an explicit
    /// --engine-api-key (also covers auto-detected engines).
    #[arg(long, env = "SPARK_DASHBOARD_PROVIDER_API_KEY")]
    provider_api_key: Option<String>,

    /// Enable the experimental log viewer at /ws/logs (Linux only).
    ///
    /// When set, the dashboard streams container logs from the Docker daemon
    /// using the bollard API. This is opt-in because engine logs can contain
    /// prompts and request payloads; the dashboard binds 0.0.0.0 by default
    /// and /ws/logs is unauthenticated.
    #[cfg(target_os = "linux")]
    #[arg(
        long,
        env = "SPARK_DASHBOARD_ENABLE_LOG_VIEWER",
        // BoolishValueParser accepts 1/0, yes/no, on/off besides true/false,
        // matching the =1 convention of the other SPARK_DASHBOARD_* env vars.
        value_parser = clap::builder::BoolishValueParser::new(),
        num_args = 0..=1,
        default_value_t = false,
        default_missing_value = "true"
    )]
    enable_log_viewer: bool,
}

fn main() -> ExitCode {
    let cli = Cli::parse();

    let result = match cli.command {
        Some(Command::Service(cmd)) => cli::service::dispatch(cmd),
        Some(Command::Healthcheck(args)) => return cli::healthcheck::run(args.port),
        None => run_server(cli.run),
    };

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("error: {err}");
            ExitCode::FAILURE
        }
    }
}

fn run_server(args: RunArgs) -> Result<(), Box<dyn std::error::Error>> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(async move { run_server_inner(args).await })
}

async fn run_server_inner(args: RunArgs) -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    // Parse manual engine overrides: --engine ollama --engine-url http://localhost:11434
    // Both vectors must have the same length. Each pair creates an EngineOverride.
    let api_keys = ApiKeyResolver::from_pairs(
        &args.engine_url,
        &args.engine_api_key,
        args.provider_api_key.clone(),
    );

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
                api_key: api_keys.resolve(url),
            })
        })
        .collect();

    if !overrides.is_empty() {
        tracing::info!("Manual engine overrides: {:?}", overrides);
    }

    let (tx, _rx) = broadcast::channel::<String>(16);

    // Shared engine state: engine collector writes, metrics collector reads
    let engine_state: Arc<RwLock<Vec<engines::EngineSnapshot>>> = Arc::new(RwLock::new(Vec::new()));

    // Spawn engine collector loop as separate tokio task (Research Pitfall 7:
    // separate task so slow engine API calls don't block hardware metrics)
    tokio::spawn(engines::engine_collector_loop(
        engine_state.clone(),
        overrides,
        api_keys,
    ));

    // Pass engine_state to metrics collector so it includes engines in snapshots
    tokio::spawn(metrics::metrics_collector(
        tx.clone(),
        args.poll_interval,
        args.gpu_index,
        args.simulate_gpus,
        engine_state.clone(),
    ));

    // Enable the log viewer if the opt-in flag was passed (Linux only).
    // This registers /ws/logs in the router; nothing is exposed by default.
    #[cfg(target_os = "linux")]
    if args.enable_log_viewer {
        logs::enable_log_viewer(engine_state.clone());
        tracing::info!(
            "Log viewer enabled at /ws/logs - unauthenticated, container logs are exposed"
        );
    }

    // Persistence is always on: writing one small document is not the kind of
    // capability the opt-in flags gate (a Docker socket, an unbounded database).
    let config =
        Arc::new(config_store::ConfigStore::new(std::path::Path::new(&args.state_dir)).await);
    tracing::info!(
        "Dashboard configuration state directory: {}",
        args.state_dir
    );

    // Splunk HEC export: the exporter subscribes to the metrics broadcast as a
    // second consumer and sends whatever the document's `export.hec` section
    // tells it to. Absent section = disabled; nothing is sent, nothing is
    // polled. The UI broadcast keeps running at full rate regardless (ADR 0001).
    let hec_config: hec::SharedHecConfig = Arc::new(RwLock::new(
        config
            .load()
            .await
            .ok()
            .flatten()
            .as_deref()
            .and_then(hec::hec_target_from_document),
    ));
    if hec_config.read().await.is_some() {
        tracing::info!("Splunk HEC export enabled from the stored dashboard document");
    }
    let export_status: hec::SharedExportStatus =
        Arc::new(Mutex::new(hec::ExportStatus::disabled()));
    let hec_rx = tx.subscribe();
    let hostname = sysinfo::System::host_name().unwrap_or_else(|| "unknown".to_string());
    tokio::spawn(hec::run_exporter(
        hec_rx,
        hec_config.clone(),
        export_status.clone(),
        hostname.clone(),
        hec::PROBE_INTERVAL,
    ));

    // Engine container logs → HEC: only when the log viewer flag is set
    // (Linux only). The document's `export.hec` target is read live per
    // tick, so the same enable/disable path as the metrics exporter applies.
    #[cfg(target_os = "linux")]
    if args.enable_log_viewer {
        tokio::spawn(logs::run_log_exporter(hec_config.clone(), hostname.clone()));
    }

    let app = server::create_router(server::AppState {
        metrics_tx: tx,
        config,
        hec_config,
        export_status,
        hostname,
    });

    let addr = format!("{}:{}", args.bind, args.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("Spark Dashboard running at http://{}", addr);

    axum::serve(listener, app).await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Clap reads the environment on every parse, so any test in this module
    /// could observe the SPARK_DASHBOARD_* variables another test set.
    /// Every test takes this lock; env-setting tests clean up before releasing.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn parse(args: &[&str]) -> RunArgs {
        Cli::try_parse_from(std::iter::once("spark-dashboard").chain(args.iter().copied()))
            .expect("args should parse")
            .run
    }

    fn with_env_vars(vars: &[(&str, &str)], f: impl FnOnce()) {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let saved: Vec<_> = vars
            .iter()
            .map(|(key, value)| {
                let prior = std::env::var_os(key);
                std::env::set_var(key, value);
                (*key, prior)
            })
            .collect();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
        for (key, prior) in saved {
            match prior {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
        if let Err(panic) = result {
            std::panic::resume_unwind(panic);
        }
    }

    #[test]
    fn engine_flags_split_on_commas_and_pair_by_position() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let args = parse(&[
            "--engine",
            "vllm,vllm",
            "--engine-url",
            "http://127.0.0.1:8000,http://127.0.0.1:8001",
            "--engine-api-key",
            "key-a,key-b",
        ]);
        assert_eq!(args.engine, vec!["vllm", "vllm"]);
        assert_eq!(
            args.engine_url,
            vec!["http://127.0.0.1:8000", "http://127.0.0.1:8001"]
        );
        assert_eq!(args.engine_api_key, vec!["key-a", "key-b"]);
    }

    #[test]
    fn repeated_engine_flags_accumulate_in_order() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let args = parse(&[
            "--engine",
            "vllm",
            "--engine-url",
            "http://127.0.0.1:8000",
            "--engine",
            "vllm",
            "--engine-url",
            "http://127.0.0.1:8001",
        ]);
        assert_eq!(args.engine, vec!["vllm", "vllm"]);
        assert_eq!(
            args.engine_url,
            vec!["http://127.0.0.1:8000", "http://127.0.0.1:8001"]
        );
        assert!(args.engine_api_key.is_empty());
    }

    #[test]
    fn engine_env_vars_split_on_commas_and_pair_by_position() {
        with_env_vars(
            &[
                ("SPARK_DASHBOARD_ENGINE", "vllm,vllm"),
                (
                    "SPARK_DASHBOARD_ENGINE_URL",
                    "http://127.0.0.1:8000,http://127.0.0.1:8001",
                ),
                ("SPARK_DASHBOARD_ENGINE_API_KEY", "key-a,key-b"),
            ],
            || {
                let args = parse(&[]);
                assert_eq!(args.engine, vec!["vllm", "vllm"]);
                assert_eq!(
                    args.engine_url,
                    vec!["http://127.0.0.1:8000", "http://127.0.0.1:8001"]
                );
                assert_eq!(args.engine_api_key, vec!["key-a", "key-b"]);
            },
        );
    }

    #[test]
    fn state_dir_defaults_to_the_systemd_state_directory() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(parse(&[]).state_dir, "/var/lib/spark-dashboard");
    }

    #[test]
    fn state_dir_reads_its_env_var() {
        with_env_vars(&[("SPARK_DASHBOARD_STATE_DIR", "/srv/spark/state")], || {
            assert_eq!(parse(&[]).state_dir, "/srv/spark/state");
        });
    }

    #[test]
    fn state_dir_flag_takes_precedence_over_its_env_var() {
        with_env_vars(&[("SPARK_DASHBOARD_STATE_DIR", "/srv/spark/state")], || {
            let args = parse(&["--state-dir", "/tmp/override"]);
            assert_eq!(args.state_dir, "/tmp/override");
        });
    }

    #[test]
    fn engine_flags_take_precedence_over_env_vars() {
        with_env_vars(
            &[
                ("SPARK_DASHBOARD_ENGINE", "vllm"),
                ("SPARK_DASHBOARD_ENGINE_URL", "http://127.0.0.1:8000"),
            ],
            || {
                let args = parse(&["--engine-url", "http://127.0.0.1:9000"]);
                assert_eq!(args.engine, vec!["vllm"]);
                assert_eq!(args.engine_url, vec!["http://127.0.0.1:9000"]);
            },
        );
    }
}
