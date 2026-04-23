use super::{DeploymentMode, EngineType};
use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::time::Duration;

/// A candidate engine discovered by the detection layers.
#[derive(Clone, Debug)]
pub struct DetectedEngine {
    pub engine_type: EngineType,
    pub endpoint: String,
    pub deployment_mode: DeploymentMode,
    /// Model identity recovered from the launch command line (e.g. `vllm serve
    /// unsloth/Llama-3.2-1B-Instruct` or `--model Qwen/Qwen2.5-3B`). Used as a
    /// fallback when `/v1/models` returns a bare slug without the HF-style
    /// `Provider/` prefix that the operator actually started the server with.
    pub served_model: Option<String>,
}

/// Known engine binaries and their default ports.
const ENGINE_BINARIES: &[(&str, EngineType, &str)] =
    &[("vllm", EngineType::Vllm, "http://localhost:8000")];

// ---------------------------------------------------------------------------
// Public detection entry point
// ---------------------------------------------------------------------------

/// Run three-layer detection: process scan, Docker query, API health probe.
///
/// Returns only engines whose API health probe succeeded (ready to serve).
pub async fn detect_engines(
    sys: &sysinfo::System,
    client: &reqwest::Client,
) -> Vec<DetectedEngine> {
    // Layer 1: process scan
    let mut candidates = detect_by_process(sys);

    // Layer 2: Docker scan (Linux-only)
    let docker_candidates = detect_docker_engines().await;

    // Merge Docker results. Key by (engine_type, endpoint) so multiple
    // instances of the same engine on different ports are preserved as
    // distinct entries. When a Docker candidate matches an existing
    // process-scan entry by exact endpoint, upgrade its deployment_mode to
    // Docker (Docker detection is authoritative for container metadata).
    let mut seen: HashSet<(EngineType, String)> = candidates
        .iter()
        .map(|c| (c.engine_type.clone(), c.endpoint.clone()))
        .collect();

    for dc in docker_candidates {
        let key = (dc.engine_type.clone(), dc.endpoint.clone());
        if seen.contains(&key) {
            if let Some(existing) = candidates
                .iter_mut()
                .find(|c| c.engine_type == dc.engine_type && c.endpoint == dc.endpoint)
            {
                existing.deployment_mode = dc.deployment_mode;
                // Prefer a non-None served_model hint: Docker discovery often
                // sees the `--model` arg the operator launched with, while
                // native process scanning may not (e.g. when vLLM is launched
                // inside a container with host networking).
                if existing.served_model.is_none() && dc.served_model.is_some() {
                    existing.served_model = dc.served_model.clone();
                }
            }
        } else {
            seen.insert(key);
            candidates.push(dc);
        }
    }

    // Layer 3: API health probe -- verify each candidate is actually reachable
    let mut verified = Vec::new();
    for candidate in candidates {
        if probe_engine(client, &candidate).await {
            verified.push(candidate);
        }
    }

    verified
}

// ---------------------------------------------------------------------------
// Layer 1: Process scan
// ---------------------------------------------------------------------------

fn detect_by_process(sys: &sysinfo::System) -> Vec<DetectedEngine> {
    let mut detected = Vec::new();

    for &(binary, ref engine_type, default_endpoint) in ENGINE_BINARIES {
        // Direct binary match (e.g. process named "vllm")
        let mut procs: Vec<_> = sys.processes_by_name(OsStr::new(binary)).collect();

        // Also check all processes for vllm in their command-line args.
        // Covers: `python3 /usr/local/bin/vllm serve ...`  (Docker host-networking)
        //         `python -m vllm.entrypoints.openai.api_server ...`
        if procs.is_empty() {
            let vllm_procs: Vec<_> = sys
                .processes()
                .values()
                .filter(|p| {
                    p.cmd().iter().any(|arg| {
                        arg.to_str()
                            .map(|s| {
                                s.contains("vllm.entrypoints")
                                    || s.ends_with("/vllm")
                                    || s == "vllm"
                            })
                            .unwrap_or(false)
                    })
                })
                .collect();
            procs = vllm_procs;
        }

        // Emit one DetectedEngine per distinct endpoint. Multi-instance native
        // setups (three `vllm serve --port 8000/8001/8002` processes) need each
        // port to surface as its own engine rather than collapsing to the first.
        let mut seen_endpoints: HashSet<String> = HashSet::new();
        for p in &procs {
            if p.cmd().is_empty() {
                continue;
            }
            let endpoint = parse_endpoint_from_args(p.cmd(), default_endpoint)
                .unwrap_or_else(|| default_endpoint.to_string());
            let served_model = parse_model_from_args(p.cmd());
            if seen_endpoints.insert(endpoint.clone()) {
                detected.push(DetectedEngine {
                    engine_type: engine_type.clone(),
                    endpoint,
                    deployment_mode: DeploymentMode::Native,
                    served_model,
                });
            }
        }
    }

    detected
}

/// Parse `--port` and `--host` from a process's command-line arguments.
/// Returns a constructed endpoint if at least `--port` is found, otherwise
/// falls back to the default.
fn parse_endpoint_from_args(args: &[OsString], default_endpoint: &str) -> Option<String> {
    let args: Vec<String> = args
        .iter()
        .filter_map(|a| a.to_str().map(String::from))
        .collect();

    let mut host: Option<&str> = None;
    let mut port: Option<&str> = None;

    let mut i = 0;
    while i < args.len() {
        if args[i] == "--port" {
            if let Some(val) = args.get(i + 1) {
                port = Some(val.as_str());
                i += 2;
                continue;
            }
        } else if let Some(val) = args[i].strip_prefix("--port=") {
            port = Some(val);
        } else if args[i] == "--host" {
            if let Some(val) = args.get(i + 1) {
                host = Some(val.as_str());
                i += 2;
                continue;
            }
        } else if let Some(val) = args[i].strip_prefix("--host=") {
            host = Some(val);
        }
        i += 1;
    }

    // Only build a custom endpoint if we found at least one flag
    if port.is_some() || host.is_some() {
        let h = host.unwrap_or("localhost");
        // Treat 0.0.0.0 as localhost for probing purposes
        let h = if h == "0.0.0.0" { "localhost" } else { h };
        let p = port.unwrap_or("8000");
        Some(format!("http://{}:{}", h, p))
    } else {
        Some(default_endpoint.to_string())
    }
}

/// Parse the served model id from a vLLM process's command-line arguments.
///
/// Recognizes:
///   * `--model <id>` / `--model=<id>` (canonical vLLM flag)
///   * Positional `serve <id>` (matches `vllm serve unsloth/Llama-3.2-1B-Instruct`
///     and `python -m vllm.entrypoints.openai.api_server serve <id>`)
///
/// The `--model` flag is preferred when both forms appear — it is what vLLM
/// itself treats as authoritative.
fn parse_model_from_args(args: &[OsString]) -> Option<String> {
    let args: Vec<String> = args
        .iter()
        .filter_map(|a| a.to_str().map(String::from))
        .collect();

    // First pass: explicit --model flag.
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--model" {
            if let Some(val) = args.get(i + 1) {
                if !val.is_empty() && !val.starts_with('-') {
                    return Some(val.clone());
                }
            }
        } else if let Some(val) = args[i].strip_prefix("--model=") {
            if !val.is_empty() {
                return Some(val.to_string());
            }
        }
        i += 1;
    }

    // Second pass: positional `serve <id>` after a vllm entrypoint token.
    for (idx, arg) in args.iter().enumerate() {
        let is_vllm_entry =
            arg == "vllm" || arg.ends_with("/vllm") || arg.contains("vllm.entrypoints");
        if !is_vllm_entry {
            continue;
        }
        // Find the `serve` subcommand after the entrypoint token.
        if let Some(serve_idx) = args.iter().enumerate().skip(idx + 1).find_map(|(j, a)| {
            if a == "serve" {
                Some(j)
            } else {
                None
            }
        }) {
            if let Some(val) = args.get(serve_idx + 1) {
                if !val.is_empty() && !val.starts_with('-') {
                    return Some(val.clone());
                }
            }
        }
    }

    None
}

/// Parse the served model id from a pre-joined command string (used by Docker
/// `container.command` and `docker top` output rows). Accepts the same shapes
/// as [`parse_model_from_args`].
///
/// Only reachable from the Linux Docker path in normal builds, but the unit
/// tests exercise it on every platform — hence the `test` cfg.
#[cfg(any(target_os = "linux", test))]
fn parse_model_from_command_str(cmd: &str) -> Option<String> {
    let parts: Vec<&str> = cmd.split_whitespace().collect();

    // First pass: explicit --model flag.
    for (i, part) in parts.iter().enumerate() {
        if *part == "--model" {
            if let Some(val) = parts.get(i + 1) {
                if !val.is_empty() && !val.starts_with('-') {
                    return Some((*val).to_string());
                }
            }
        } else if let Some(val) = part.strip_prefix("--model=") {
            if !val.is_empty() {
                return Some(val.to_string());
            }
        }
    }

    // Second pass: positional `serve <id>` after a vllm entrypoint token.
    for (idx, part) in parts.iter().enumerate() {
        let is_vllm_entry =
            *part == "vllm" || part.ends_with("/vllm") || part.contains("vllm.entrypoints");
        if !is_vllm_entry {
            continue;
        }
        if let Some(serve_idx) = parts.iter().enumerate().skip(idx + 1).find_map(|(j, a)| {
            if *a == "serve" {
                Some(j)
            } else {
                None
            }
        }) {
            if let Some(val) = parts.get(serve_idx + 1) {
                if !val.is_empty() && !val.starts_with('-') {
                    return Some((*val).to_string());
                }
            }
        }
    }

    None
}

// ---------------------------------------------------------------------------
// Layer 2: Docker scan
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
pub async fn detect_docker_engines() -> Vec<DetectedEngine> {
    use bollard::query_parameters::{ListContainersOptions, TopOptionsBuilder};
    use bollard::Docker;

    let docker = match Docker::connect_with_local_defaults() {
        Ok(d) => d,
        Err(e) => {
            // Elevated to info: if multi-instance containerized vLLM isn't being
            // picked up, the operator needs to know Docker discovery failed.
            // Common cause: spark-dashboard user not in `docker` group, or the
            // service was started before that group change took effect
            // (`sudo systemctl restart spark-dashboard` usually fixes it).
            tracing::info!(
                "Docker detection unavailable (is spark-dashboard in the `docker` group \
                 and is the socket at /var/run/docker.sock?): {}",
                e
            );
            return vec![];
        }
    };

    let opts = ListContainersOptions {
        all: false, // only running containers
        ..Default::default()
    };

    let containers = match docker.list_containers(Some(opts)).await {
        Ok(c) => c,
        Err(e) => {
            tracing::info!(
                "Failed to list Docker containers (permission/socket issue?): {}",
                e
            );
            return vec![];
        }
    };

    let mut detected = Vec::new();

    for container in &containers {
        let image = container
            .image
            .as_deref()
            .unwrap_or_default()
            .to_lowercase();
        let command = container
            .command
            .as_deref()
            .unwrap_or_default()
            .to_lowercase();

        // Match on image name OR container command only. Container *names*
        // are operator-chosen and commonly include "vllm" for unrelated
        // sidecars (e.g. an OpenResty reverse proxy named "vllm-proxy"),
        // so they are not a reliable signal and are deliberately excluded
        // to prevent false-positive engine detection.
        let is_vllm = image.contains("vllm") || command.contains("vllm");

        if !is_vllm {
            continue;
        }

        // 1. Try port from Docker port mappings (works for -p / port-forwarding)
        let mapped_port = container
            .ports
            .as_ref()
            .and_then(|ports| ports.iter().find_map(|p| p.public_port));

        // 2. Try port + model from the container's own command string
        let container_cmd = container.command.as_deref().unwrap_or_default();
        let cmd_port = parse_port_from_command_str(container_cmd);
        let cmd_model = parse_model_from_command_str(container_cmd);

        let port = mapped_port.map(|p| p.to_string()).or(cmd_port);

        // 3. If still no port (e.g. host networking + `sleep infinity` container),
        //    inspect the actual processes running inside the container via `docker top`.
        //    The same top output is also the best source for recovering the model
        //    argument, since `container.command` is just the container's *entrypoint*
        //    and often omits the child vllm-serve args.
        let (port, served_model) = {
            let container_id = container.id.as_deref().unwrap_or_default();
            let need_port = port.is_none();
            let need_model = cmd_model.is_none();
            if container_id.is_empty() || (!need_port && !need_model) {
                (port, cmd_model)
            } else {
                let top_opts = TopOptionsBuilder::default().ps_args("-eo pid,args").build();
                match docker.top_processes(container_id, Some(top_opts)).await {
                    Ok(top) => {
                        let mut found_port = port;
                        let mut found_model = cmd_model;
                        if let Some(procs) = top.processes.as_ref() {
                            for row in procs {
                                let line = row.join(" ");
                                if found_port.is_none() {
                                    if let Some(p) = parse_port_from_command_str(&line) {
                                        tracing::debug!(
                                            "Docker top: found port {} in: {}",
                                            p,
                                            line
                                        );
                                        found_port = Some(p);
                                    }
                                }
                                if found_model.is_none() {
                                    if let Some(m) = parse_model_from_command_str(&line) {
                                        tracing::debug!(
                                            "Docker top: found model {} in: {}",
                                            m,
                                            line
                                        );
                                        found_model = Some(m);
                                    }
                                }
                                if found_port.is_some() && found_model.is_some() {
                                    break;
                                }
                            }
                        }
                        (found_port, found_model)
                    }
                    Err(e) => {
                        tracing::debug!("docker top failed for {}: {}", container_id, e);
                        (port, cmd_model)
                    }
                }
            }
        };

        if let Some(p) = port {
            let endpoint = format!("http://localhost:{}", p);
            tracing::debug!(
                "Docker vLLM candidate: image={}, port={}, endpoint={}, model={:?}",
                container.image.as_deref().unwrap_or("?"),
                p,
                endpoint,
                served_model,
            );
            detected.push(DetectedEngine {
                engine_type: EngineType::Vllm,
                endpoint,
                deployment_mode: DeploymentMode::Docker,
                served_model,
            });
        } else {
            tracing::debug!(
                "Docker vLLM container found (image={}) but could not determine port",
                container.image.as_deref().unwrap_or("?"),
            );
        }
    }

    detected
}

/// Parse `--port` value from a command string (space-separated).
#[cfg(target_os = "linux")]
fn parse_port_from_command_str(cmd: &str) -> Option<String> {
    let parts: Vec<&str> = cmd.split_whitespace().collect();
    for (i, part) in parts.iter().enumerate() {
        if *part == "--port" {
            if let Some(val) = parts.get(i + 1) {
                if val.parse::<u16>().is_ok() {
                    return Some(val.to_string());
                }
            }
        } else if let Some(val) = part.strip_prefix("--port=") {
            if val.parse::<u16>().is_ok() {
                return Some(val.to_string());
            }
        }
    }
    None
}

#[cfg(not(target_os = "linux"))]
pub async fn detect_docker_engines() -> Vec<DetectedEngine> {
    tracing::debug!("Docker engine detection stubbed on non-Linux");
    vec![]
}

// ---------------------------------------------------------------------------
// Layer 3: API health probe
// ---------------------------------------------------------------------------

/// Verify that a candidate engine's API is actually responding.
async fn probe_engine(client: &reqwest::Client, candidate: &DetectedEngine) -> bool {
    let timeout = Duration::from_secs(2);

    match candidate.engine_type {
        EngineType::Vllm => {
            // GET /health -- 200 = healthy
            client
                .get(format!("{}/health", candidate.endpoint))
                .timeout(timeout)
                .send()
                .await
                .map(|r| r.status().is_success())
                .unwrap_or(false)
        }
    }
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn to_args(parts: &[&str]) -> Vec<OsString> {
        parts.iter().map(OsString::from).collect()
    }

    #[test]
    fn parses_positional_serve_arg() {
        let args = to_args(&["vllm", "serve", "unsloth/Llama-3.2-1B-Instruct"]);
        assert_eq!(
            parse_model_from_args(&args).as_deref(),
            Some("unsloth/Llama-3.2-1B-Instruct"),
        );
    }

    #[test]
    fn parses_explicit_model_flag() {
        let args = to_args(&[
            "python",
            "-m",
            "vllm.entrypoints.openai.api_server",
            "--model",
            "Qwen/Qwen2.5-3B-Instruct",
        ]);
        assert_eq!(
            parse_model_from_args(&args).as_deref(),
            Some("Qwen/Qwen2.5-3B-Instruct"),
        );
    }

    #[test]
    fn prefers_model_flag_over_positional_and_handles_equals_form() {
        // `--model=` wins and the trailing `--port` is not misread as a value.
        let args = to_args(&[
            "vllm",
            "serve",
            "--model=mistralai/Mistral-7B",
            "--port",
            "8001",
        ]);
        assert_eq!(
            parse_model_from_args(&args).as_deref(),
            Some("mistralai/Mistral-7B"),
        );
    }

    #[test]
    fn returns_none_when_serve_has_no_positional() {
        let args = to_args(&["vllm", "serve"]);
        assert_eq!(parse_model_from_args(&args), None);
    }

    #[test]
    fn command_str_parses_positional_serve() {
        assert_eq!(
            parse_model_from_command_str("vllm serve google/gemma-2-2b-it --port 8002").as_deref(),
            Some("google/gemma-2-2b-it"),
        );
    }

    #[test]
    fn command_str_parses_explicit_model_equals_flag() {
        assert_eq!(
            parse_model_from_command_str(
                "python -m vllm.entrypoints.openai.api_server --model=meta-llama/Llama-3.1-8B-Instruct",
            )
            .as_deref(),
            Some("meta-llama/Llama-3.1-8B-Instruct"),
        );
    }

    #[test]
    fn command_str_returns_none_for_unrelated_command() {
        assert_eq!(parse_model_from_command_str("sleep infinity"), None);
    }
}
