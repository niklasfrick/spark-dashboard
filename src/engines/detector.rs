use super::EngineType;
use std::ffi::{OsStr, OsString};
use std::time::Duration;

/// A candidate engine discovered by the detection layers.
#[derive(Clone, Debug)]
pub struct DetectedEngine {
    pub engine_type: EngineType,
    pub endpoint: String,
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

    // Merge Docker results -- prefer Docker endpoint when duplicate engine type
    for dc in docker_candidates {
        if let Some(existing) = candidates
            .iter_mut()
            .find(|c| c.engine_type == dc.engine_type)
        {
            // Docker has actual port mapping, prefer it
            existing.endpoint = dc.endpoint;
        } else {
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

        if !procs.is_empty() {
            // Try to extract --host and --port from the process command line.
            // Skip processes with empty cmd() (e.g. container processes where
            // sysinfo can't read /proc/<pid>/cmdline).
            let endpoint = procs
                .iter()
                .filter(|p| !p.cmd().is_empty())
                .filter_map(|p| parse_endpoint_from_args(p.cmd(), default_endpoint))
                .next()
                .unwrap_or_else(|| default_endpoint.to_string());

            detected.push(DetectedEngine {
                engine_type: engine_type.clone(),
                endpoint,
            });
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
            tracing::debug!(
                "Docker not available for engine detection (permission denied?): {}",
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
            tracing::debug!("Failed to list Docker containers: {}", e);
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
        let names = container
            .names
            .as_ref()
            .map(|n| n.join(" ").to_lowercase())
            .unwrap_or_default();

        // Match on image name, container command, or container names
        let is_vllm = image.contains("vllm") || command.contains("vllm") || names.contains("vllm");

        if !is_vllm {
            continue;
        }

        // 1. Try port from Docker port mappings (works for -p / port-forwarding)
        let mapped_port = container
            .ports
            .as_ref()
            .and_then(|ports| ports.iter().find_map(|p| p.public_port));

        // 2. Try port from the container's own command string
        let cmd_port =
            parse_port_from_command_str(container.command.as_deref().unwrap_or_default());

        let port = mapped_port.map(|p| p.to_string()).or(cmd_port);

        // 3. If still no port (e.g. host networking + `sleep infinity` container),
        //    inspect the actual processes running inside the container via `docker top`
        let port = match port {
            Some(p) => Some(p),
            None => {
                let container_id = container.id.as_deref().unwrap_or_default();
                if container_id.is_empty() {
                    None
                } else {
                    let top_opts = TopOptionsBuilder::default().ps_args("-eo pid,args").build();
                    match docker.top_processes(container_id, Some(top_opts)).await {
                        Ok(top) => {
                            top.processes.as_ref().and_then(|procs| {
                                for row in procs {
                                    // Each row is a Vec<String> of column values
                                    let line = row.join(" ");
                                    if let Some(p) = parse_port_from_command_str(&line) {
                                        tracing::debug!(
                                            "Docker top: found port {} in: {}",
                                            p,
                                            line
                                        );
                                        return Some(p);
                                    }
                                }
                                None
                            })
                        }
                        Err(e) => {
                            tracing::debug!("docker top failed for {}: {}", container_id, e);
                            None
                        }
                    }
                }
            }
        };

        if let Some(p) = port {
            let endpoint = format!("http://localhost:{}", p);
            tracing::debug!(
                "Docker vLLM candidate: image={}, port={}, endpoint={}",
                container.image.as_deref().unwrap_or("?"),
                p,
                endpoint
            );
            detected.push(DetectedEngine {
                engine_type: EngineType::Vllm,
                endpoint,
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
