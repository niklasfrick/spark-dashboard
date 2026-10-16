use super::common::EngineHttp;
use super::ollama::OllamaHost;
use super::{ApiKeyResolver, DeploymentMode, EngineType};
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;

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
    /// Host-namespace PIDs belonging to this engine: the detected process and
    /// its descendants (native scan), or every process `docker top` reports
    /// for the container. Matched against NVML's per-device compute-process
    /// lists to attribute the engine to the GPU(s) it runs on.
    pub pids: Vec<u32>,
    /// Docker container id (full) when discovered via the Docker scan layer;
    /// `None` for natively-detected engines. Used by the log viewer to stream
    /// the same container the dashboard is showing metrics for, rather than
    /// re-scanning and potentially picking a different one.
    pub container_id: Option<String>,
}

/// The port vLLM serves on when it is not told otherwise. Used wherever a
/// candidate is found but its port cannot be read off the command line.
const VLLM_DEFAULT_PORT: u16 = 8000;

/// SGLang's default HTTP port (`--port` unset), same role as above.
const SGLANG_DEFAULT_PORT: u16 = 30000;

/// The port an engine type serves on when it is not told otherwise.
fn default_port(engine_type: &EngineType) -> u16 {
    match engine_type {
        EngineType::Vllm => VLLM_DEFAULT_PORT,
        EngineType::Sglang => SGLANG_DEFAULT_PORT,
        EngineType::Ollama => super::ollama::DEFAULT_PORT,
        EngineType::LlamaCpp => super::llamacpp::default_ports(&DeploymentMode::Native)[0],
    }
}

// ---------------------------------------------------------------------------
// Public detection entry point
// ---------------------------------------------------------------------------

/// Run three-layer detection: process scan, Docker query, API health probe.
///
/// Returns only engines whose API health probe succeeded (ready to serve).
pub async fn detect_engines(
    sys: &sysinfo::System,
    client: &reqwest::Client,
    api_keys: &ApiKeyResolver,
) -> Vec<DetectedEngine> {
    // Layer 1: process scan
    let mut candidates = detect_by_process(sys);

    // Layer 2: Docker scan (Linux-only)
    let docker_candidates = detect_docker_engines().await;
    merge_docker_candidates(&mut candidates, docker_candidates);

    // Layer 3: API health probe -- verify each candidate is actually reachable
    let mut verified = Vec::new();
    for candidate in candidates {
        let http = EngineHttp::new(
            client.clone(),
            candidate.endpoint.clone(),
            api_keys.resolve(&candidate.endpoint),
        );
        if probe_engine(&http, &candidate.engine_type).await {
            verified.push(candidate);
        }
    }

    verified
}

/// Merge Docker results into the process-scan candidates.
///
/// First, every container claims its own processes
/// (`absorb_container_processes`): a process that belongs to a container is
/// never a native engine of its own, the container is the engine.
///
/// Then key by (engine_type, endpoint) so multiple instances of the same
/// engine on different ports are preserved as distinct entries. When a
/// Docker candidate matches an existing process-scan entry by exact
/// endpoint, upgrade its deployment_mode to Docker (Docker detection is
/// authoritative for container metadata) and union the PID sets — `docker
/// top` and the host process scan may each see processes the other missed.
/// This is also what still joins a container whose processes could not be
/// listed to the host scan's view of it.
fn merge_docker_candidates(
    candidates: &mut Vec<DetectedEngine>,
    mut docker_candidates: Vec<DetectedEngine>,
) {
    for container in &mut docker_candidates {
        absorb_container_processes(candidates, container);
    }

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
                for pid in &dc.pids {
                    if !existing.pids.contains(pid) {
                        existing.pids.push(*pid);
                    }
                }
                existing.pids.sort_unstable();
                // Docker discovery is authoritative for container identity.
                if existing.container_id.is_none() && dc.container_id.is_some() {
                    existing.container_id = dc.container_id.clone();
                }
            }
        } else {
            seen.insert(key);
            candidates.push(dc);
        }
    }
}

/// Take a container's processes out of the host-scan candidates: whatever
/// engine type and endpoint the host scan made of them, they are the
/// container's engine.
///
/// The host scan sees a container's processes like any other's — on the
/// host network and in `ps` alike — and reads an endpoint off their command
/// line, which need not be the string the Docker scan builds for the same
/// server: `--host 127.0.0.1 --port 8000` where the Docker scan says
/// `localhost:8000`, or the port inside the container where Docker publishes
/// another. Matched on the endpoint alone, one containerized engine was two,
/// a native one beside the container's. The container's `docker top` PIDs
/// (host-namespace, as the host scan's are) say which processes are its.
///
/// An Ollama server's address the host scan reads from its environment
/// instead, which it usually cannot read for a containerized server (it
/// runs as root), so it takes Ollama's default address: on a host that
/// also runs Ollama natively, the native server's, and the container's
/// server and runners would join the native engine and its GPU
/// association. The Docker scan reads the container's own `OLLAMA_HOST`
/// and published ports, so its endpoint stands, and the native engine
/// keeps only its own processes.
///
/// A candidate made only of the container's processes is absorbed, not
/// kept beside it: its PIDs are the container's already, so GPU association
/// loses none, and the model it read off the command line fills in where
/// the container's own command showed none (only for the same engine type;
/// the Docker scan's view of the container stands). A candidate that keeps
/// some processes stays native with them: a native server the host scan
/// grouped with a container's on one endpoint. A container whose processes
/// could not be listed claims none, and is joined by endpoint as before.
fn absorb_container_processes(
    candidates: &mut Vec<DetectedEngine>,
    container: &mut DetectedEngine,
) {
    candidates.retain_mut(|c| {
        if !c.pids.iter().any(|pid| container.pids.contains(pid)) {
            return true;
        }
        c.pids.retain(|pid| !container.pids.contains(pid));
        if !c.pids.is_empty() {
            return true;
        }
        if container.served_model.is_none() && c.engine_type == container.engine_type {
            container.served_model = c.served_model.take();
        }
        false
    });
}

/// Which engine's server an argument names, if any. The launch forms:
///   * vLLM: the `vllm` CLI (`vllm serve ...`, also by path), and
///     `python -m vllm.entrypoints.openai.api_server ...`;
///   * SGLang: the `sglang` CLI (`sglang serve ...`, also by path), and
///     `python -m sglang.launch_server ...` (the documented one) or a
///     `sglang.srt` module.
///
/// Deliberately token-precise: a proxy named "sglang-sidecar" runs nothing
/// until a command line proves otherwise, and an argument that merely
/// contains an engine's name (a log file, a config file) is not the server
/// itself.
fn server_named_by(arg: &str) -> Option<EngineType> {
    if arg == "vllm" || arg.ends_with("/vllm") || arg.contains("vllm.entrypoints") {
        Some(EngineType::Vllm)
    } else if arg == "sglang"
        || arg.ends_with("/sglang")
        || arg.contains("sglang.launch_server")
        || arg.contains("sglang.srt")
    {
        Some(EngineType::Sglang)
    } else {
        None
    }
}

/// Whether a command line is `ollama serve`, Ollama's server: the program
/// `ollama` (by any path; `ollama.exe` harmlessly too) with `serve` as its
/// subcommand. Token-exact on both counts: `serve` is a substring of
/// `llama-server`, the child Ollama runs each GGUF model in from v0.35, and
/// `ollama runner` — each model's child up to v0.19, and an MLX model's on
/// v0.40 — is the same program with another subcommand. No model appears on
/// the command line; Ollama loads them on demand.
fn is_ollama_server(args: &[&str]) -> bool {
    let program = args
        .first()
        .map(|arg| arg.rsplit(&['/', '\\'][..]).next().unwrap_or(arg));
    matches!(program, Some("ollama" | "ollama.exe")) && args.get(1) == Some(&"serve")
}

/// Which engine a command line runs, if any. Ollama's server is told by its
/// program and subcommand together (`is_ollama_server`); otherwise the first
/// argument that names an engine's server decides. The program comes before
/// its arguments, so a path or flag value that happens to name the other
/// engine — `python3 -m sglang.launch_server --download-dir /data/vllm` —
/// cannot turn the process into that engine too. A process is at most one
/// engine.
fn engine_of_command<'a>(args: impl IntoIterator<Item = &'a str>) -> Option<EngineType> {
    let args: Vec<&str> = args.into_iter().collect();
    if is_ollama_server(&args) {
        return Some(EngineType::Ollama);
    }
    args.into_iter().find_map(server_named_by)
}

/// The argv form of [`engine_of_command`], for the host process scan: each
/// argument is intact, so a model path with spaces cannot split into a false
/// match.
fn engine_of_process(cmd: &[OsString]) -> Option<EngineType> {
    engine_of_command(cmd.iter().filter_map(|arg| arg.to_str()))
}

/// Whether a whole command line (a `docker top` row) runs the given engine's
/// server rather than something that merely mentions it — the same evidence
/// a host process is judged by: the binary being run, not a name somebody
/// chose.
///
/// Like everything the container classification uses, only reachable from the
/// Linux Docker path in normal builds, but the unit tests exercise it on every
/// platform — hence the `test` cfg.
#[cfg(any(target_os = "linux", test))]
fn runs_engine(command: &str, engine_type: &EngineType) -> bool {
    engine_of_command(command.split_whitespace()).as_ref() == Some(engine_type)
}

/// The served model named on a pre-joined command line, read the way the
/// engine type's own launcher spells it.
#[cfg(any(target_os = "linux", test))]
fn parse_model_for(engine_type: &EngineType, cmd: &str) -> Option<String> {
    match engine_type {
        EngineType::Vllm => parse_model_from_command_str(cmd),
        EngineType::Sglang => parse_sglang_model_from_command_str(cmd),
        // Ollama loads models on demand; none is named at launch.
        EngineType::Ollama => None,
        EngineType::LlamaCpp => None,
    }
}

/// What a container's declared name, image and command say about which
/// engine (if any) it runs, and how far to trust that.
#[cfg(any(target_os = "linux", test))]
#[derive(Debug, PartialEq)]
struct ContainerClass {
    engine_type: EngineType,
    /// The image or command named this engine type — trusted as-is. A
    /// name-only match is not: an operator can name anything, so such a
    /// container must additionally be seen *running* the engine process.
    strong_signal: bool,
}

/// Whether an image is Ollama's own, `ollama/ollama`, from any registry and
/// under any tag or digest: `docker.io/ollama/ollama:0.40.5`,
/// `ollama/ollama:rocm`, `registry.local:5000/ollama/ollama@sha256:…`.
#[cfg(any(target_os = "linux", test))]
fn is_ollama_image(image: &str) -> bool {
    let name = image.split('@').next().unwrap_or(image);
    // A tag is a `:` after the last `/`; one before it is a registry port.
    let repository = match name.rfind(':') {
        Some(colon) if !name[colon..].contains('/') => &name[..colon],
        _ => name,
    };
    repository == "ollama/ollama" || repository.ends_with("/ollama/ollama")
}

/// Rank the signals by how much they say:
///   1. the **image** is what was pulled to run here — Ollama's own image is
///      Ollama, and an image that names exactly one of vLLM and SGLang is
///      that engine. An `lmsysorg/sglang` image whose command mentions vLLM
///      (an env var, a model path) is SGLang.
///   2. the **command** is what the entrypoint runs — its launch form, read
///      like a host process's (`ollama serve` by any path, or the first
///      argument naming a server), so
///      `python3 -m sglang.launch_server --model-path /models/x-vllm-awq`
///      is SGLang. Failing a launch form, a command that mentions exactly
///      one engine anywhere (a shell wrapper's quoted `"vllm serve ..."`)
///      still names it.
///   3. the **name** is what somebody typed — a weak signal the container's
///      processes must confirm.
///
/// What stays tied — both engines named and no launch form to decide — goes
/// to vLLM: no one builds a "vllm-sglang" image on purpose, and the
/// mismatched container is more plausibly a vLLM deployment with sglang in a
/// sidecar name than the reverse.
///
/// Only reachable from the Linux Docker path in normal builds, but the unit
/// tests exercise it on every platform, hence the `test` cfg.
#[cfg(any(target_os = "linux", test))]
fn classify_container(names: &[String], image: &str, command: &str) -> Option<ContainerClass> {
    let mentions = |text: &str| (text.contains("vllm"), text.contains("sglang"));
    let class = |engine_type, strong_signal| {
        Some(ContainerClass {
            engine_type,
            strong_signal,
        })
    };

    if is_ollama_image(image) {
        return class(EngineType::Ollama, true);
    }
    match mentions(image) {
        (true, false) => return class(EngineType::Vllm, true),
        (false, true) => return class(EngineType::Sglang, true),
        _ => {}
    }
    if let Some(engine_type) = engine_of_command(command.split_whitespace()) {
        return class(engine_type, true);
    }
    match mentions(command) {
        (false, true) => return class(EngineType::Sglang, true),
        (true, _) => return class(EngineType::Vllm, true),
        (false, false) => {}
    }
    // An image naming both engines, with a command naming neither: the tie.
    if image.contains("vllm") {
        return class(EngineType::Vllm, true);
    }

    let named = |needle: &str| names.iter().any(|n| n.to_lowercase().contains(needle));
    if named("vllm") {
        class(EngineType::Vllm, false)
    } else if named("sglang") {
        class(EngineType::Sglang, false)
    } else if named("ollama") {
        class(EngineType::Ollama, false)
    } else {
        None
    }
}

/// The endpoint to probe a container's vLLM on, and whether the port had to be
/// assumed.
///
/// No port anywhere — no published binding, no `--port` in the command, none in
/// the container's process list — means vLLM is on its own default. That is the
/// normal shape of a host-networked container: it publishes nothing, because it
/// is already on the host's ports.
///
/// Assuming is safe and dropping the container is not. The health probe rejects
/// a candidate whose `/health` does not answer, so a wrong assumption costs one
/// request and corrects itself — while a container dropped for having no
/// readable port is invisible to the dashboard for good, engine, metrics and
/// logs alike.
fn docker_endpoint(port: Option<&str>, default_port: u16) -> (String, bool) {
    match port {
        Some(p) => (format!("http://localhost:{}", p), false),
        None => (format!("http://localhost:{}", default_port), true),
    }
}

/// A port a container publishes, as the Docker API lists it.
#[cfg(any(target_os = "linux", test))]
#[derive(Clone, Copy, Debug)]
struct PublishedPort<'a> {
    /// The port inside the container.
    container: u16,
    /// The host port it is published on; `None` for an exposed port that is
    /// not published.
    host: Option<u16>,
    /// The host address it is published on; empty, `0.0.0.0` or `::` for
    /// every interface.
    host_ip: Option<&'a str>,
    tcp: bool,
}

/// The endpoint a containerized Ollama answers on from the host, given the
/// address it listens on inside the container (its `OLLAMA_HOST`, the image
/// sets `0.0.0.0:11434`), its network mode and its published ports:
///
/// - on the host network it listens on the host's own interfaces, read
///   like a native server's;
/// - otherwise the host port that publishes the listening port, on
///   127.0.0.1 when published on every interface;
/// - with nothing published there and a network mode the Docker API did
///   not report, or one shared with another container, the listening
///   address is assumed reachable as on the host network — the probe
///   rejects a wrong guess;
/// - on a bridge or other network with nothing published, `None`: the
///   server is unreachable from the host, and assuming its port would
///   point at whatever else is there, typically a native Ollama on the
///   default port.
#[cfg(any(target_os = "linux", test))]
fn ollama_container_endpoint(
    listen: &OllamaHost,
    network_mode: Option<&str>,
    published: &[PublishedPort<'_>],
) -> Option<String> {
    if network_mode == Some("host") {
        return Some(listen.endpoint());
    }
    let binding = published
        .iter()
        .filter(|p| p.tcp && p.container == listen.port)
        .find_map(|p| Some((p.host?, p.host_ip.unwrap_or_default())));
    if let Some((port, ip)) = binding {
        let host = match ip.parse::<std::net::IpAddr>() {
            Ok(ip) if !ip.is_unspecified() => ip.to_string(),
            Ok(_) => String::new(),
            Err(_) if ip.is_empty() => String::new(),
            Err(_) => ip.to_string(),
        };
        let published = OllamaHost {
            host,
            port,
            ..OllamaHost::from_env(None)
        };
        return Some(published.endpoint());
    }
    match network_mode {
        None => Some(listen.endpoint()),
        Some(mode) if mode.starts_with("container:") => Some(listen.endpoint()),
        Some(_) => None,
    }
}

// ---------------------------------------------------------------------------
// Layer 1: Process scan
// ---------------------------------------------------------------------------

/// Refresh the host process table the process scan reads: every process's
/// command line, and (always read, from `stat`) its parent — processes
/// only, not their threads.
///
/// The scan judges a process by its command line alone, and sysinfo's plain
/// `refresh_processes` reads memory, CPU, disk and executable figures but no
/// `cmdline` — which left every process looking like it ran nothing, so no
/// native engine was ever detected. The command line is re-read on every
/// refresh rather than once: a process can `exec` into a server under the
/// same PID (`sh -c "exec vllm serve ..."`), and SGLang's children rewrite
/// theirs with `setproctitle` after they start.
///
/// Threads are left out explicitly: sysinfo lists every thread as a process
/// of its own unless told not to — `ProcessRefreshKind::nothing()` keeps
/// `tasks` on, as `refresh_processes` does. A thread shares its process's
/// command line, so the scan would read a server once per thread and count
/// every thread ID among the engine's PIDs, which nothing else names: NVML
/// attributes GPU memory to processes, and `docker top` lists processes. A
/// containerized server's threads then stayed behind when the container
/// claimed its processes, and the host scan's view of the same server
/// lived on as a second, native engine.
pub fn refresh_process_table(sys: &mut sysinfo::System) {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, UpdateKind};
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .without_tasks()
            .with_cmd(UpdateKind::Always),
    );
}

fn detect_by_process(sys: &sysinfo::System) -> Vec<DetectedEngine> {
    // Every process is judged by its command line alone — not by its name:
    // SGLang's child processes rename themselves (`setproctitle` →
    // `sglang::scheduler`, `sglang::detokenizer`) and carry neither the
    // launch flags nor the serving `--port`, while the server itself is often
    // named `python3`. Sorted by PID so the candidates come out in a stable
    // order.
    let mut processes: Vec<HostProcess<'_>> = sys
        .processes()
        .iter()
        .map(|(pid, p)| (pid.as_u32(), p.parent().map(|pp| pp.as_u32()), p.cmd()))
        .collect();
    processes.sort_unstable_by_key(|&(pid, _, _)| pid);
    engines_from_processes(&processes, |pid| {
        let value = process_env_var(pid, "OLLAMA_HOST");
        if value.is_err() {
            note_unreadable_ollama_host(pid);
        }
        value
    })
}

/// One host process as the scan reads it: its PID, its parent's PID, and
/// its command line.
type HostProcess<'a> = (u32, Option<u32>, &'a [OsString]);

/// One candidate per engine endpoint from a host's process table.
///
/// Each process is at most one engine — the one its command line launches
/// (`engine_of_process`) — so a process is never polled as both: an SGLang
/// server with `/data/vllm` among its arguments is not also a vLLM candidate
/// whose `/health` probe would run a generation on SGLang every second. One
/// candidate per distinct endpoint, too: multi-instance native setups (three
/// `vllm serve --port 8000/8001/8002` processes) surface each port as its
/// own engine rather than collapsing to the first.
///
/// An Ollama server's own processes are never engines: the runner it starts
/// per loaded model — `ollama runner ...` up to v0.19 and for MLX models,
/// `llama-server ...` from v0.35 — serves Ollama on a random loopback port,
/// an interface Ollama does not promise. Every descendant of an
/// `ollama serve` is left out before any matcher sees it, so an engine type
/// that recognizes `llama-server` does not turn one into an engine. Its
/// PIDs belong to the Ollama engine instead, with every other candidate's
/// descendants: the GPU sees a server's children, not the server.
///
/// `ollama_host_of` reads a process's `OLLAMA_HOST`, which decides where an
/// Ollama server listens: unset, or an environment that cannot be read,
/// leaves Ollama's default.
fn engines_from_processes(
    processes: &[HostProcess<'_>],
    ollama_host_of: impl Fn(u32) -> std::io::Result<Option<String>>,
) -> Vec<DetectedEngine> {
    let tree: Vec<(u32, Option<u32>)> = processes
        .iter()
        .map(|&(pid, parent, _)| (pid, parent))
        .collect();
    let ollama_servers: Vec<u32> = processes
        .iter()
        .filter(|(_, _, cmd)| engine_of_process(cmd) == Some(EngineType::Ollama))
        .map(|&(pid, _, _)| pid)
        .collect();
    let ollamas_own: HashSet<u32> = expand_pid_tree(&ollama_servers, &tree)
        .into_iter()
        .filter(|pid| !ollama_servers.contains(pid))
        .collect();

    let mut detected: Vec<DetectedEngine> = Vec::new();
    let mut seen_endpoints: HashMap<(EngineType, String), usize> = HashMap::new();
    for &(pid, _, cmd) in processes {
        if ollamas_own.contains(&pid) {
            continue;
        }
        let Some(engine_type) = engine_of_process(cmd) else {
            continue;
        };
        let endpoint = match engine_type {
            EngineType::Ollama => {
                let host = OllamaHost::from_env(ollama_host_of(pid).ok().flatten().as_deref());
                tracing::debug!(
                    "ollama serve (pid {pid}) binds {}; probing {}",
                    host.url(),
                    host.endpoint()
                );
                host.endpoint()
            }
            _ => {
                let default_endpoint = format!("http://localhost:{}", default_port(&engine_type));
                parse_endpoint_from_args(cmd, &default_endpoint).unwrap_or(default_endpoint)
            }
        };
        let served_model = match engine_type {
            EngineType::Vllm => parse_model_from_args(cmd),
            EngineType::Sglang => parse_sglang_model_from_args(cmd),
            EngineType::Ollama => None,
            EngineType::LlamaCpp => None,
        };
        match seen_endpoints.get(&(engine_type.clone(), endpoint.clone())) {
            Some(&slot) => detected[slot].pids.push(pid),
            None => {
                seen_endpoints.insert((engine_type.clone(), endpoint.clone()), detected.len());
                detected.push(DetectedEngine {
                    engine_type,
                    endpoint,
                    deployment_mode: DeploymentMode::Native,
                    served_model,
                    pids: vec![pid],
                    container_id: None,
                });
            }
        }
    }

    // vLLM's API-server process rarely holds the CUDA context itself — the
    // engine-core / tensor-parallel worker child processes do, as Ollama's
    // runners do for each model it loads — so NVML's compute-process list
    // must be matched against the whole process tree, not just the detected
    // root PID. Re-read every detection tick, so a newly loaded model's
    // runner joins its engine.
    for d in &mut detected {
        d.pids = expand_pid_tree(&d.pids, &tree);
    }
    detected
}

/// `name` among `NAME=value` entries, as `/proc/<pid>/environ` and Docker's
/// `Env` list them; `None` when it is not set.
#[cfg(any(target_os = "linux", test))]
fn env_var_in<'a>(entries: impl IntoIterator<Item = &'a [u8]>, name: &str) -> Option<String> {
    entries
        .into_iter()
        .find_map(|entry| entry.strip_prefix(name.as_bytes())?.strip_prefix(b"="))
        .map(|value| String::from_utf8_lossy(value).into_owned())
}

/// A variable of a host process's environment, from `/proc/<pid>/environ`:
/// `Ok(None)` when it is not set, an error when the environment cannot be
/// read — it belongs to the process's own user, and Ollama typically runs
/// as `ollama` while the dashboard does not.
#[cfg(target_os = "linux")]
fn process_env_var(pid: u32, name: &str) -> std::io::Result<Option<String>> {
    let environ = std::fs::read(format!("/proc/{pid}/environ"))?;
    Ok(env_var_in(environ.split(|&b| b == 0), name))
}

/// Outside Linux there is no `/proc` to read another process's environment
/// from; the server is taken to be on its default address.
#[cfg(not(target_os = "linux"))]
fn process_env_var(_pid: u32, _name: &str) -> std::io::Result<Option<String>> {
    Err(std::io::ErrorKind::Unsupported.into())
}

/// Say once, at info, that an Ollama server's `OLLAMA_HOST` could not be
/// read, and what covers a server bound elsewhere than the default. Once,
/// not every detection tick: a dashboard that runs as another user than
/// Ollama meets this on every scan.
fn note_unreadable_ollama_host(pid: u32) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static NOTED: AtomicBool = AtomicBool::new(false);
    if !NOTED.swap(true, Ordering::Relaxed) {
        tracing::info!(
            "The environment of `ollama serve` (pid {pid}) is not readable — it runs as \
             another user — so its OLLAMA_HOST is unknown; probing Ollama's default {}. \
             If it binds elsewhere, configure it with --engine ollama --engine-url <url>.",
            OllamaHost::from_env(None).endpoint()
        );
    }
}

/// Expand root PIDs to the full set including every descendant process,
/// given `(pid, parent_pid)` pairs for all processes on the host. Returned
/// sorted and deduplicated; cycles in the parent data are tolerated.
fn expand_pid_tree(roots: &[u32], processes: &[(u32, Option<u32>)]) -> Vec<u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for &(pid, parent) in processes {
        if let Some(parent) = parent {
            children.entry(parent).or_default().push(pid);
        }
    }

    let mut seen: HashSet<u32> = HashSet::new();
    let mut queue: Vec<u32> = roots.iter().copied().filter(|&p| seen.insert(p)).collect();
    let mut result = queue.clone();
    while let Some(pid) = queue.pop() {
        for &child in children.get(&pid).map(Vec::as_slice).unwrap_or_default() {
            if seen.insert(child) {
                result.push(child);
                queue.push(child);
            }
        }
    }
    result.sort_unstable();
    result
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
        // A `--host` without a `--port` still means the engine's own default
        // port — taken from the per-type default endpoint, not hardcoded, so
        // SGLang does not get probed on vLLM's port.
        let p = port.unwrap_or_else(|| {
            default_endpoint
                .rsplit_once(':')
                .map(|(_, port)| port)
                .unwrap_or("8000")
        });
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

/// Parse the served model from an SGLang launch command line.
///
/// SGLang names the model with `--model-path` (`--model` is its alias) and
/// may rename what `/v1/models` reports with `--served-model-name`. The hint
/// wants the HuggingFace id — what enrichment can resolve — so `--model-path`
/// wins over the alias, and both win over the serve-name (which is often a
/// bare alias exactly when the HF id would help most).
fn parse_sglang_model_from_args(args: &[OsString]) -> Option<String> {
    let args: Vec<String> = args
        .iter()
        .filter_map(|a| a.to_str().map(String::from))
        .collect();
    parse_sglang_model_parts(&args)
}

/// Shared by the OsString and pre-joined-string forms.
fn parse_sglang_model_parts<S: AsRef<str>>(args: &[S]) -> Option<String> {
    let flags = ["--model-path", "--model", "--served-model-name"];
    for flag in flags {
        for (i, arg) in args.iter().enumerate() {
            let arg = arg.as_ref();
            if arg == flag {
                if let Some(val) = args.get(i + 1) {
                    let val = val.as_ref();
                    if !val.is_empty() && !val.starts_with('-') {
                        return Some(val.to_string());
                    }
                }
            } else if let Some(val) = arg.strip_prefix(&format!("{flag}=")) {
                if !val.is_empty() {
                    return Some(val.to_string());
                }
            }
        }
    }
    // `sglang serve <model>` takes the model as a positional argument, like
    // `vllm serve`; the CLI has no other positional, so the token after the
    // subcommand can only be it.
    if let Some(pos) = args.iter().position(|a| a.as_ref() == "serve") {
        if let Some(val) = args.get(pos + 1) {
            let val = val.as_ref();
            if !val.is_empty() && !val.starts_with('-') {
                return Some(val.to_string());
            }
        }
    }
    None
}

/// Pre-joined-command-string form of [`parse_sglang_model_from_args`] (Docker
/// `container.command` and `docker top` rows).
#[cfg(any(target_os = "linux", test))]
fn parse_sglang_model_from_command_str(cmd: &str) -> Option<String> {
    parse_sglang_model_parts(&cmd.split_whitespace().collect::<Vec<_>>())
}

// ---------------------------------------------------------------------------
// Layer 2: Docker scan
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
pub async fn detect_docker_engines() -> Vec<DetectedEngine> {
    use bollard::models::PortSummaryTypeEnum;
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

        // The image and the container's entrypoint are trustworthy signals on
        // their own. A container *name* is not: names are operator-chosen and
        // commonly include "vllm" for unrelated sidecars (an OpenResty reverse
        // proxy called "vllm-proxy"), so a name match is only a candidate —
        // confirmed below by finding an actual vLLM process inside it.
        //
        // The name has to count for something, though: a container built from a
        // private image, started with `sleep infinity` and given vLLM by hand is
        // otherwise invisible to the dashboard entirely, however plainly it is
        // named.
        let Some(class) = classify_container(
            container.names.as_deref().unwrap_or_default(),
            &image,
            &command,
        ) else {
            continue;
        };
        let ContainerClass {
            engine_type,
            strong_signal,
        } = class;

        let container_id = container.id.as_deref().unwrap_or_default();

        // The processes running inside the container, via `docker top`. Its
        // rows carry the *host-namespace* PIDs (the namespace NVML reports)
        // used for GPU association — an Ollama container's per-model runners
        // among them, re-listed every detection tick — prove that a
        // container matched only by name runs the engine, and are the
        // fallback source for a vLLM or SGLang port and model (host
        // networking + `sleep infinity` containers), since
        // `container.command` is just the container's *entrypoint* and often
        // omits the child vllm-serve args.
        let mut pids: Vec<u32> = Vec::new();
        let mut commands: Vec<String> = Vec::new();
        if !container_id.is_empty() {
            let top_opts = TopOptionsBuilder::default().ps_args("-eo pid,args").build();
            match docker.top_processes(container_id, Some(top_opts)).await {
                Ok(top) => {
                    for row in top.processes.iter().flatten() {
                        pids.extend(parse_pid_from_top_row(row));
                        commands.push(top_row_command(row));
                    }
                }
                Err(e) => tracing::debug!("docker top failed for {}: {}", container_id, e),
            }
        }
        pids.sort_unstable();
        pids.dedup();

        // A container that only matched by name has to prove itself. Nothing
        // that merely calls itself an engine becomes an engine.
        if !strong_signal && !commands.iter().any(|c| runs_engine(c, &engine_type)) {
            tracing::debug!(
                "Container named like an engine (image={}) runs no engine process; skipping",
                container.image.as_deref().unwrap_or("?"),
            );
            continue;
        }

        let (endpoint, served_model) = if engine_type == EngineType::Ollama {
            // Ollama listens where the container's OLLAMA_HOST says — the
            // image sets 0.0.0.0:11434 — and names no model at launch. Its
            // process list holds each loaded model's runner, `--port` and
            // all, which is not where Ollama serves, so no port is read off
            // it.
            let env = if container_id.is_empty() {
                Vec::new()
            } else {
                match docker.inspect_container(container_id, None).await {
                    Ok(info) => info.config.and_then(|c| c.env).unwrap_or_default(),
                    Err(e) => {
                        tracing::debug!("docker inspect failed for {}: {}", container_id, e);
                        Vec::new()
                    }
                }
            };
            let listen = OllamaHost::from_env(
                env_var_in(env.iter().map(|e| e.as_bytes()), "OLLAMA_HOST").as_deref(),
            );
            let published: Vec<PublishedPort<'_>> = container
                .ports
                .iter()
                .flatten()
                .map(|p| PublishedPort {
                    container: p.private_port,
                    host: p.public_port,
                    host_ip: p.ip.as_deref(),
                    tcp: !matches!(
                        p.typ,
                        Some(PortSummaryTypeEnum::UDP | PortSummaryTypeEnum::SCTP)
                    ),
                })
                .collect();
            let network_mode = container
                .host_config
                .as_ref()
                .and_then(|h| h.network_mode.as_deref());
            match ollama_container_endpoint(&listen, network_mode, &published) {
                Some(endpoint) => (endpoint, None),
                None => {
                    tracing::debug!(
                        "Ollama container (image={}) is not on the host network and publishes \
                         no port for {}; unreachable from the host. Publish the port, or \
                         configure it with --engine ollama --engine-url <url>.",
                        container.image.as_deref().unwrap_or("?"),
                        listen.port,
                    );
                    continue;
                }
            }
        } else {
            // The port from the container's port mappings (-p / port
            // forwarding), else its own command string, else its process
            // list; the model from the command string, else the process list.
            let container_cmd = container.command.as_deref().unwrap_or_default();
            let port = container
                .ports
                .iter()
                .flatten()
                .find_map(|p| p.public_port)
                .map(|p| p.to_string())
                .or_else(|| parse_port_from_command_str(container_cmd))
                .or_else(|| commands.iter().find_map(|c| parse_port_from_command_str(c)));
            let served_model = parse_model_for(&engine_type, container_cmd).or_else(|| {
                commands
                    .iter()
                    .find_map(|c| parse_model_for(&engine_type, c))
            });

            // No port anywhere — no published binding, no `--port` in the
            // command, none in the container's process list — means the
            // engine is on its own default. That is the normal shape of a
            // host-networked container: it publishes nothing, because it is
            // already on the host's ports.
            //
            // Guessing is safe here and dropping the container is not. The
            // health probe below rejects a candidate whose `/health` does not
            // answer, so a wrong guess costs one request and corrects itself,
            // while a container dropped for having no port is invisible to the
            // dashboard for good — engine, metrics and logs alike.
            let (endpoint, guessed) = docker_endpoint(port.as_deref(), default_port(&engine_type));
            if guessed {
                tracing::debug!("Docker engine on {endpoint}: no port found, assuming the default");
            }
            (endpoint, served_model)
        };
        tracing::debug!(
            "Docker engine candidate: image={}, endpoint={}, model={:?}",
            container.image.as_deref().unwrap_or("?"),
            endpoint,
            served_model,
        );
        detected.push(DetectedEngine {
            engine_type,
            endpoint,
            deployment_mode: DeploymentMode::Docker,
            served_model,
            pids,
            container_id: container.id.clone(),
        });
    }

    detected
}

/// The command line of a `docker top` row produced with
/// `ps_args("-eo pid,args")`: every column after the PID. Without the PID
/// in front, the program is the first token, as in a host process's argv —
/// which `ollama serve` is recognized by.
#[cfg(any(target_os = "linux", test))]
fn top_row_command(row: &[String]) -> String {
    row.get(1..).unwrap_or_default().join(" ")
}

/// Parse the host-namespace PID from a `docker top` row produced with
/// `ps_args("-eo pid,args")` — the PID is the first column. Returns `None`
/// for the header row ("PID") or malformed rows.
///
/// Only reachable from the Linux Docker path in normal builds, but the unit
/// tests exercise it on every platform — hence the `test` cfg.
#[cfg(any(target_os = "linux", test))]
fn parse_pid_from_top_row(row: &[String]) -> Option<u32> {
    row.first().and_then(|cell| cell.trim().parse::<u32>().ok())
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

/// Verify that a candidate engine's API is actually responding, and is the
/// engine type it was detected as. Every request carries the endpoint's
/// configured API key, as the adapter's own requests do.
async fn probe_engine(http: &EngineHttp, engine_type: &EngineType) -> bool {
    let answers = |path: &'static str| async move { http.get(path).send().await.ok() };
    match engine_type {
        // GET /health -- 200 = healthy
        EngineType::Vllm => answers("/health")
            .await
            .is_some_and(|r| r.status().is_success()),
        EngineType::Sglang => {
            // SGLang answers Ollama-compatible routes too, so "a route
            // exists" proves little — but `/model_info` is SGLang's own
            // (vLLM serves no such route), and so is `/ready` (vLLM's only
            // `/ready` is the data-parallel supervisor's, which has no
            // `/model_info`). Both are answered by the tokenizer manager
            // without a round trip through the scheduler, so probing every
            // detection tick costs the engine nothing — unlike
            // `/server_info`, which collects every scheduler's internal
            // state, or `/health`, which runs a generation.
            // `/ready` only exists from v0.5.20; a release without it (404)
            // is identified by `/model_info` answering 200 alone. Where
            // `/ready` exists it must say ready, and `/model_info` must
            // exist — a 200, or a 401 when the engine has an API key the
            // dashboard lacks (the route is there); only a 404 says this is
            // not SGLang.
            let model_info = || async { answers("/model_info").await.map(|r| r.status()) };
            match answers("/ready").await.map(|r| r.status()) {
                Some(ready) if ready.is_success() => model_info()
                    .await
                    .is_some_and(|s| s != reqwest::StatusCode::NOT_FOUND),
                Some(reqwest::StatusCode::NOT_FOUND) => {
                    model_info().await.is_some_and(|s| s.is_success())
                }
                _ => false,
            }
        }
        // By `/api/version` and `/api/ps`, the two routes only Ollama serves
        // — SGLang answers Ollama-compatible routes too (`ollama::identify`).
        EngineType::Ollama => super::ollama::identify(http).await,
        // By the `Server: llama.cpp` header every llama-server answer carries
        // (`llamacpp::identify`).
        EngineType::LlamaCpp => super::llamacpp::identify(http).await,
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

    /// The SGLang probe identifies the engine through its own cheap
    /// routes, `/ready` then `/model_info` — each asked with exactly one
    /// slash (a doubled one was answered 404, which rejected every real
    /// SGLang server) and with the endpoint's API key.
    #[tokio::test]
    async fn the_sglang_probe_asks_its_cheap_routes_with_the_api_key() {
        use super::super::test_server::TestServer;
        let server = TestServer::start(|_| (200, String::new())).await;
        let http = EngineHttp::new(reqwest::Client::new(), server.url.clone(), Some("k".into()));
        assert!(probe_engine(&http, &EngineType::Sglang).await);

        let asked = server.requests();
        let paths: Vec<_> = asked.iter().map(|r| r.path.as_str()).collect();
        assert_eq!(paths, vec!["/ready", "/model_info"]);
        assert!(asked
            .iter()
            .all(|r| r.authorization.as_deref() == Some("Bearer k")));
    }

    /// `/model_info` answering 401 is SGLang with an API key the dashboard
    /// does not hold — the route exists; a 404 is some other server.
    #[tokio::test]
    async fn the_sglang_probe_rejects_a_server_without_its_routes() {
        use super::super::test_server::TestServer;
        for (model_info, is_sglang) in [(401, true), (404, false)] {
            let server = TestServer::start(move |r| match r.path.as_str() {
                "/ready" => (200, String::new()),
                _ => (model_info, String::new()),
            })
            .await;
            let http = EngineHttp::new(reqwest::Client::new(), server.url.clone(), None);
            assert_eq!(
                probe_engine(&http, &EngineType::Sglang).await,
                is_sglang,
                "/model_info answering {model_info}"
            );
        }
    }

    /// A release without `/ready` (it arrived in v0.5.20) is still SGLang
    /// when `/model_info` answers 200 — and only then: a 401 there could be
    /// any server's auth wall, and a server serving neither route is not
    /// SGLang. A `/ready` that exists but is not ready (503) is a starting
    /// engine, not a fallback case.
    #[tokio::test]
    async fn the_sglang_probe_falls_back_to_model_info_without_ready() {
        use super::super::test_server::TestServer;
        for (ready, model_info, is_sglang) in [
            (404, 200, true),
            (404, 401, false),
            (404, 404, false),
            (503, 200, false),
        ] {
            let server = TestServer::start(move |r| match r.path.as_str() {
                "/ready" => (ready, String::new()),
                _ => (model_info, String::new()),
            })
            .await;
            let http =
                EngineHttp::new(reqwest::Client::new(), server.url.clone(), Some("k".into()));
            assert_eq!(
                probe_engine(&http, &EngineType::Sglang).await,
                is_sglang,
                "/ready {ready}, /model_info {model_info}"
            );
            assert!(server
                .requests()
                .iter()
                .all(|r| r.authorization.as_deref() == Some("Bearer k")));
        }
    }

    /// A vLLM-shaped server — `/health` and `/v1/models`, no SGLang route —
    /// is not SGLang, whether or not it has a `/ready` (the data-parallel
    /// supervisor's).
    #[tokio::test]
    async fn a_vllm_shaped_server_is_not_identified_as_sglang() {
        use super::super::test_server::TestServer;
        for ready in [404, 200] {
            let server = TestServer::start(move |r| match r.path.as_str() {
                "/health" | "/v1/models" => (200, String::new()),
                "/ready" => (ready, String::new()),
                _ => (404, String::new()),
            })
            .await;
            let http = EngineHttp::new(reqwest::Client::new(), server.url.clone(), None);
            assert!(
                !probe_engine(&http, &EngineType::Sglang).await,
                "/ready {ready}"
            );
            assert!(probe_engine(&http, &EngineType::Vllm).await);
        }
    }

    /// An Ollama server is neither vLLM nor SGLang: it serves no `/health`,
    /// `/ready` or `/model_info` — whatever process or container pointed a
    /// candidate of either type at it.
    #[tokio::test]
    async fn an_ollama_server_is_not_identified_as_vllm_or_sglang() {
        use super::super::test_server::TestServer;
        let server = TestServer::start(|r| match r.path.as_str() {
            "/" => (200, include_str!("fixtures/ollama_root.txt").into()),
            "/api/version" => (200, include_str!("fixtures/ollama_version.json").into()),
            "/api/ps" => (200, include_str!("fixtures/ollama_ps_loaded.json").into()),
            _ => (404, "404 page not found".into()),
        })
        .await;
        let http = EngineHttp::new(reqwest::Client::new(), server.url.clone(), None);
        assert!(!probe_engine(&http, &EngineType::Vllm).await);
        assert!(!probe_engine(&http, &EngineType::Sglang).await);
        assert!(probe_engine(&http, &EngineType::Ollama).await);
    }

    /// The vLLM probe carries the key too, like every request its adapter
    /// makes.
    #[tokio::test]
    async fn the_vllm_probe_sends_the_api_key() {
        use super::super::test_server::TestServer;
        let server = TestServer::start(|_| (200, String::new())).await;
        let http = EngineHttp::new(reqwest::Client::new(), server.url.clone(), Some("k".into()));
        assert!(probe_engine(&http, &EngineType::Vllm).await);
        let asked = server.requests();
        assert_eq!(asked.len(), 1);
        assert_eq!(asked[0].path, "/health");
        assert_eq!(asked[0].authorization.as_deref(), Some("Bearer k"));
    }

    /// The scan reads nothing but command lines, so the refresh that feeds
    /// it has to read them — the plain `refresh_processes` does not.
    #[test]
    fn the_process_table_carries_command_lines() {
        let mut sys = sysinfo::System::new();
        refresh_process_table(&mut sys);
        let me = sys
            .process(sysinfo::Pid::from_u32(std::process::id()))
            .expect("the test process is listed");
        assert!(!me.cmd().is_empty(), "no command line read");
    }

    /// sysinfo lists every thread as a process of its own unless told not
    /// to. The scan must not see them: a thread shares its process's
    /// command line and would be counted among the engine's PIDs, which
    /// neither NVML nor `docker top` ever names — so a containerized
    /// server's threads stayed behind when the container claimed its
    /// processes, and the host scan's view of it lived on as a second,
    /// native engine. Linux only: that is where sysinfo lists threads and
    /// where `/proc/self/task` says which they are.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_processs_threads_are_not_processes_in_the_table() {
        // One thread of this process that is certainly alive throughout.
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<()>();
        let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
        let worker = std::thread::spawn(move || {
            ready_tx.send(()).expect("the test is waiting");
            let _ = stop_rx.recv();
        });
        ready_rx.recv().expect("the worker started");

        let me = std::process::id();
        let threads: Vec<u32> = std::fs::read_dir("/proc/self/task")
            .expect("/proc/self/task is readable")
            .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse().ok())
            .filter(|&tid| tid != me)
            .collect();
        assert!(!threads.is_empty(), "the test process has no other thread");

        let mut sys = sysinfo::System::new();
        refresh_process_table(&mut sys);

        let listed: Vec<u32> = threads
            .iter()
            .copied()
            .filter(|&tid| sys.process(sysinfo::Pid::from_u32(tid)).is_some())
            .collect();
        assert!(listed.is_empty(), "threads listed as processes: {listed:?}");
        assert!(
            sys.process(sysinfo::Pid::from_u32(me)).is_some(),
            "the test process itself is listed"
        );

        stop_tx.send(()).expect("the worker is waiting");
        worker.join().expect("the worker exits");
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

    fn to_row(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn top_row_pid_is_parsed_from_first_column() {
        assert_eq!(
            parse_pid_from_top_row(&to_row(&["4242", "vllm serve --port 8000"])),
            Some(4242),
        );
    }

    #[test]
    fn top_row_header_and_malformed_rows_yield_none() {
        assert_eq!(parse_pid_from_top_row(&to_row(&["PID", "COMMAND"])), None);
        assert_eq!(parse_pid_from_top_row(&[]), None);
    }

    #[test]
    fn pid_tree_includes_children_and_grandchildren() {
        // 100 (root) -> 101 -> 102, plus unrelated 200 -> 201.
        let processes = vec![
            (100, Some(1)),
            (101, Some(100)),
            (102, Some(101)),
            (200, Some(1)),
            (201, Some(200)),
        ];
        assert_eq!(expand_pid_tree(&[100], &processes), vec![100, 101, 102]);
    }

    #[test]
    fn pid_tree_without_children_returns_only_roots() {
        let processes = vec![(100, Some(1)), (200, Some(1))];
        assert_eq!(expand_pid_tree(&[100], &processes), vec![100]);
    }

    #[test]
    fn pid_tree_tolerates_parent_cycles() {
        // Degenerate parent data forming a cycle must not loop forever.
        let processes = vec![(100, Some(101)), (101, Some(100))];
        assert_eq!(expand_pid_tree(&[100], &processes), vec![100, 101]);
    }

    fn candidate(endpoint: &str, mode: DeploymentMode, pids: &[u32]) -> DetectedEngine {
        DetectedEngine {
            engine_type: EngineType::Vllm,
            endpoint: endpoint.to_string(),
            deployment_mode: mode,
            served_model: None,
            pids: pids.to_vec(),
            container_id: None,
        }
    }

    #[test]
    fn a_vllm_server_process_is_recognized_in_its_several_launch_forms() {
        assert!(runs_engine(
            "/usr/bin/python3 /usr/local/bin/vllm serve Qwen/Qwen3-8B",
            &EngineType::Vllm
        ));
        assert!(runs_engine(
            "vllm serve mistralai/Mistral-7B",
            &EngineType::Vllm
        ));
        assert!(runs_engine(
            "python -m vllm.entrypoints.openai.api_server --port 8001",
            &EngineType::Vllm
        ));
    }

    #[test]
    fn a_process_that_merely_mentions_vllm_is_not_a_server() {
        // What the container-name signal has to be protected against: a proxy
        // or a shell that has the word in its arguments but serves nothing.
        assert!(!runs_engine(
            "nginx: master process /usr/sbin/nginx",
            &EngineType::Vllm
        ));
        assert!(!runs_engine("sleep infinity", &EngineType::Vllm));
        assert!(!runs_engine(
            "/bin/sh -c echo starting vllm-proxy",
            &EngineType::Vllm
        ));
        assert!(!runs_engine("tail -f /var/log/vllm.log", &EngineType::Vllm));
    }

    #[test]
    fn docker_endpoint_uses_the_port_detection_found() {
        assert_eq!(
            docker_endpoint(Some("8001"), VLLM_DEFAULT_PORT),
            ("http://localhost:8001".to_string(), false)
        );
    }

    #[test]
    fn docker_endpoint_assumes_vllms_default_when_no_port_is_readable() {
        // The host-networked container: it publishes no ports because it is
        // already on the host's, and it was started without an explicit
        // --port. Before this it was dropped from detection entirely, which
        // took its metrics and its logs with it.
        assert_eq!(
            docker_endpoint(None, VLLM_DEFAULT_PORT),
            ("http://localhost:8000".to_string(), true)
        );
    }

    fn argv(line: &str) -> Vec<std::ffi::OsString> {
        line.split(' ').map(std::ffi::OsString::from).collect()
    }

    /// The process scan over `(pid, parent, command line)` rows, with each
    /// process's `OLLAMA_HOST` read by `env`.
    fn scan_with(
        rows: &[(u32, Option<u32>, &str)],
        env: impl Fn(u32) -> std::io::Result<Option<String>>,
    ) -> Vec<DetectedEngine> {
        let argvs: Vec<Vec<OsString>> = rows.iter().map(|(_, _, line)| argv(line)).collect();
        let processes: Vec<HostProcess<'_>> = rows
            .iter()
            .zip(&argvs)
            .map(|(&(pid, parent, _), cmd)| (pid, parent, cmd.as_slice()))
            .collect();
        engines_from_processes(&processes, env)
    }

    /// The process scan where no environment can be read — the dashboard
    /// running as another user than every engine.
    fn scan(rows: &[(u32, Option<u32>, &str)]) -> Vec<DetectedEngine> {
        scan_with(rows, |_| Err(std::io::ErrorKind::PermissionDenied.into()))
    }

    #[test]
    fn container_classification_follows_image_then_command_then_name() {
        // The image is the strongest claim about what runs in a container:
        // an `lmsysorg/sglang` image whose command string mentions vLLM (an
        // env var, a mounted path) is SGLang, not vLLM.
        let class = classify_container(
            &["app".to_string()],
            "lmsysorg/sglang:latest",
            "python3 -m sglang.launch_server --load-prefix /vllm-cache",
        )
        .expect("classified");
        assert!(matches!(class.engine_type, EngineType::Sglang));
        assert!(class.strong_signal);

        // Without image evidence, vLLM still wins a mixed command.
        let class = classify_container(&[], "", "vllm serve --env SGLANG_MODE=1").expect("vllm");
        assert!(matches!(class.engine_type, EngineType::Vllm));

        // A launch form with no command string at all (`sleep infinity`) is
        // only a name — not a strong signal; `docker top` decides.
        let named = classify_container(&["sglang-lane".to_string()], "", "sleep infinity")
            .expect("name still classifies");
        assert!(matches!(named.engine_type, EngineType::Sglang));
        assert!(!named.strong_signal);

        assert!(classify_container(&["sidecar".to_string()], "", "nginx").is_none());
    }

    /// Without image evidence, an SGLang launch command wins: a vLLM-ish
    /// container name or a model path that merely contains "vllm" does not
    /// turn it into vLLM — which would make a weak vLLM candidate dropped by
    /// `docker top`, or a strong one polled on the wrong engine's routes.
    #[test]
    fn an_sglang_launch_command_beats_a_vllm_name_or_path() {
        let sglang = Some(ContainerClass {
            engine_type: EngineType::Sglang,
            strong_signal: true,
        });
        assert_eq!(
            classify_container(
                &["qwen-vllm-compat".to_string()],
                "my/inference",
                "python3 -m sglang.launch_server --port 30000",
            ),
            sglang
        );
        assert_eq!(
            classify_container(
                &[],
                "my/inference",
                "python3 -m sglang.launch_server --model-path /models/x-vllm-awq",
            ),
            sglang
        );
        // And the reverse: a vLLM launch with an SGLang path stays vLLM.
        assert_eq!(
            classify_container(&[], "", "vllm serve /models/sglang-distill"),
            Some(ContainerClass {
                engine_type: EngineType::Vllm,
                strong_signal: true,
            })
        );
    }

    #[test]
    fn a_renamed_sglang_child_is_not_mistaken_for_the_server() {
        // `setproctitle` children name themselves `sglang::scheduler` and
        // `sglang::detokenizer`; their argv proves no server and carries no
        // `--port`. Only the launching process may set the endpoint.
        let sglang = Some(EngineType::Sglang);
        assert_eq!(
            engine_of_process(&argv("python3 -m sglang.launch_server --port 30001")),
            sglang
        );
        assert_eq!(
            engine_of_process(&argv("/usr/local/bin/sglang serve Qwen/Qwen2.5-0.5B")),
            sglang
        );
        assert_eq!(engine_of_process(&argv("sglang::scheduler")), None);
        assert_eq!(engine_of_process(&argv("sglang::detokenizer")), None);
        // The same for vLLM children, and a model path containing the word
        // must not match (single-argument precision).
        assert_eq!(
            engine_of_process(&argv("vllm serve google/gemma-3-4b --port 8001")),
            Some(EngineType::Vllm)
        );
        assert_eq!(engine_of_process(&argv("tail -f /var/log/vllm.log")), None);
        // One argument holding the string whole: per-argument precision
        // means a path containing the word is not the binary being run.
        let whole_arg = ["python3", "serve", "/models/my vllm model"].map(std::ffi::OsString::from);
        assert_eq!(engine_of_process(&whole_arg), None);
    }

    /// A process is at most one engine. An SGLang server with a vLLM path
    /// among its arguments used to match both scans and become two
    /// candidates on its port — and the vLLM one polled SGLang's `/health`,
    /// a one-token generation, every second.
    #[test]
    fn a_process_is_detected_as_one_engine_only() {
        let detected = scan(&[
            (
                10,
                None,
                "python3 -m sglang.launch_server --download-dir /data/vllm --port 30000",
            ),
            (20, None, "vllm serve /models/sglang-distill --port 8001"),
        ]);
        let found: Vec<_> = detected
            .iter()
            .map(|d| (d.engine_type.clone(), d.endpoint.as_str(), d.pids.clone()))
            .collect();
        assert_eq!(
            found,
            vec![
                (EngineType::Sglang, "http://localhost:30000", vec![10]),
                (EngineType::Vllm, "http://localhost:8001", vec![20]),
            ]
        );
    }

    /// `--host` without `--port` still serves on the engine's own default
    /// port: SGLang's 30000, never vLLM's 8000.
    #[test]
    fn a_host_without_a_port_keeps_the_engines_default_port() {
        let endpoints: Vec<_> = scan(&[
            (1, None, "python3 -m sglang.launch_server --host 0.0.0.0"),
            (2, None, "vllm serve Qwen/Qwen3-8B --host 0.0.0.0"),
        ])
        .into_iter()
        .map(|d| d.endpoint)
        .collect();
        assert_eq!(
            endpoints,
            vec!["http://localhost:30000", "http://localhost:8000"]
        );
    }

    /// Several processes of one server on one endpoint (workers forked with
    /// the launch argv) are one engine, holding every PID.
    #[test]
    fn processes_on_one_endpoint_are_one_engine() {
        let detected = scan(&[
            (1, None, "vllm serve m --port 8000"),
            (2, None, "vllm serve m --port 8000"),
            (3, None, "vllm serve m --port 8001"),
        ]);
        assert_eq!(detected.len(), 2);
        assert_eq!(detected[0].pids, vec![1, 2]);
        assert_eq!(detected[1].pids, vec![3]);
    }

    #[test]
    fn a_sglang_server_process_is_recognized_in_its_launch_forms() {
        assert!(runs_engine(
            "python3 -m sglang.launch_server --model-path meta-llama/Llama-3.1-8B --port 30001",
            &EngineType::Sglang
        ));
        assert!(runs_engine(
            "sglang serve --model Qwen/Qwen2.5-3B-Instruct",
            &EngineType::Sglang
        ));
        assert!(runs_engine(
            "/usr/local/bin/sglang serve --model-path=google/gemma-3-4b",
            &EngineType::Sglang
        ));
        assert!(runs_engine(
            "python -m sglang.srt.server --host 127.0.0.1 --port 30000",
            &EngineType::Sglang
        ));
    }

    #[test]
    fn a_process_that_merely_mentions_sglang_is_not_a_server() {
        assert!(!runs_engine(
            "nginx: master process /usr/sbin/nginx",
            &EngineType::Sglang
        ));
        assert!(!runs_engine(
            "tail -f /var/log/sglang.log",
            &EngineType::Sglang
        ));
        assert!(!runs_engine(
            "/bin/sh -c echo starting sglang-proxy",
            &EngineType::Sglang
        ));
        assert!(!runs_engine("sleep infinity", &EngineType::Sglang));
    }

    /// A container's command is read with its engine's own model flags:
    /// `--model-path` for SGLang, `--model` or `serve <id>` for vLLM.
    #[test]
    fn a_container_command_is_read_with_its_engines_model_flags() {
        let cmd = "python3 -m sglang.launch_server --model-path Qwen/Qwen3-8B --port 30000";
        assert_eq!(
            parse_model_for(&EngineType::Sglang, cmd).as_deref(),
            Some("Qwen/Qwen3-8B")
        );
        assert_eq!(
            parse_model_for(&EngineType::Vllm, "vllm serve Qwen/Qwen3-8B").as_deref(),
            Some("Qwen/Qwen3-8B")
        );
    }

    #[test]
    fn sglang_model_parses_its_flags_with_the_right_precedence() {
        // --model-path is the HF id enrichment can resolve, so it wins over
        // the alias flag and over the serve-name flag.
        assert_eq!(
            parse_sglang_model_from_command_str(
                "sglang serve --model-path meta-llama/Llama-3.1-8B --served-model-name llama8b --port 30000",
            )
            .as_deref(),
            Some("meta-llama/Llama-3.1-8B"),
        );
        assert_eq!(
            parse_sglang_model_from_command_str(
                "python -m sglang.launch_server --model=Qwen/Qwen2.5-3B-Instruct"
            )
            .as_deref(),
            Some("Qwen/Qwen2.5-3B-Instruct"),
        );
        // Only an alias present: still better than nothing.
        assert_eq!(
            parse_sglang_model_from_command_str("sglang serve --served-model-name my-model")
                .as_deref(),
            Some("my-model"),
        );
        // `sglang serve <model>` — positional, no flag at all.
        assert_eq!(
            parse_sglang_model_from_command_str(
                "sglang serve Qwen/Qwen2.5-0.5B-Instruct --port 30000",
            )
            .as_deref(),
            Some("Qwen/Qwen2.5-0.5B-Instruct"),
        );
        assert_eq!(parse_sglang_model_from_command_str("sleep infinity"), None);
    }

    /// A host-networked vLLM container, `vllm serve ... --host 127.0.0.1
    /// --port 8000`, as it runs on the Spark. The host scan reads its
    /// endpoint off the command line, `127.0.0.1:8000`, and the Docker scan
    /// says `localhost:8000`: one server under two names, which made two
    /// engines once the host scan could read command lines. The container's
    /// processes are its engine's whatever endpoint the host scan read: one
    /// engine, the container's, carrying the PID for GPU association and
    /// the model the host scan read where the container's command showed
    /// none.
    #[test]
    fn a_containers_processes_are_its_engine_whatever_endpoint_the_host_read() {
        let mut candidates = scan(&[(
            500,
            None,
            "vllm serve Qwen/Qwen3-8B --host 127.0.0.1 --port 8000",
        )]);
        assert_eq!(candidates[0].endpoint, "http://127.0.0.1:8000");
        let container = DetectedEngine {
            container_id: Some("c0ffee".into()),
            ..candidate(
                "http://localhost:8000",
                DeploymentMode::Docker,
                &[480, 500, 501],
            )
        };
        merge_docker_candidates(&mut candidates, vec![container]);

        assert_eq!(candidates.len(), 1, "one engine");
        let engine = &candidates[0];
        assert_eq!(engine.endpoint, "http://localhost:8000");
        assert_eq!(engine.deployment_mode, DeploymentMode::Docker);
        assert_eq!(engine.container_id.as_deref(), Some("c0ffee"));
        assert!(engine.pids.contains(&500), "{:?}", engine.pids);
        assert_eq!(engine.served_model.as_deref(), Some("Qwen/Qwen3-8B"));
    }

    /// The container says what engine its processes are, as the Docker scan
    /// always has: one the host scan took for another engine type is no
    /// native engine either, and lends the container no model.
    #[test]
    fn a_containers_process_is_no_native_engine_of_any_type() {
        let mut candidates = scan(&[(
            500,
            None,
            "python3 -m sglang.launch_server --model-path m --port 30000",
        )]);
        merge_docker_candidates(
            &mut candidates,
            vec![candidate(
                "http://localhost:8000",
                DeploymentMode::Docker,
                &[480, 500],
            )],
        );
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].engine_type, EngineType::Vllm);
        assert_eq!(candidates[0].deployment_mode, DeploymentMode::Docker);
        assert_eq!(candidates[0].served_model, None);
    }

    /// Only a container's own processes leave the host scan. A native server
    /// stays native beside a container, and keeps its processes where the
    /// host scan put a container's on its endpoint too: `vllm serve --port
    /// 8000` natively, and a bridge container's `vllm serve --port 8000`
    /// published on 8001 (`-p 8001:8000`), which the host scan reads as
    /// port 8000.
    #[test]
    fn a_process_in_no_container_stays_native() {
        let mut candidates = scan(&[
            (100, None, "vllm serve m --port 8000"),
            (401, None, "vllm serve m --port 8000"),
        ]);
        assert_eq!(candidates.len(), 1, "one endpoint to the host scan");
        merge_docker_candidates(
            &mut candidates,
            vec![candidate(
                "http://localhost:8001",
                DeploymentMode::Docker,
                &[400, 401],
            )],
        );
        let found: Vec<_> = candidates
            .iter()
            .map(|c| {
                (
                    c.endpoint.as_str(),
                    c.deployment_mode.clone(),
                    c.pids.clone(),
                )
            })
            .collect();
        assert_eq!(
            found,
            vec![
                ("http://localhost:8000", DeploymentMode::Native, vec![100]),
                (
                    "http://localhost:8001",
                    DeploymentMode::Docker,
                    vec![400, 401]
                ),
            ]
        );
    }

    /// A container whose processes could not be listed (`docker top`
    /// failed) has no PIDs to claim a host-scan candidate by. An equal
    /// endpoint still makes the two one engine, the container's.
    #[test]
    fn a_container_whose_processes_are_unknown_merges_by_endpoint() {
        let mut candidates = scan(&[(500, None, "vllm serve m --port 8000")]);
        let container = DetectedEngine {
            container_id: Some("c0ffee".into()),
            ..candidate("http://localhost:8000", DeploymentMode::Docker, &[])
        };
        merge_docker_candidates(&mut candidates, vec![container]);

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].deployment_mode, DeploymentMode::Docker);
        assert_eq!(candidates[0].container_id.as_deref(), Some("c0ffee"));
        assert_eq!(candidates[0].pids, vec![500]);
    }

    #[test]
    fn docker_merge_unions_pids_and_upgrades_mode() {
        let mut candidates = vec![candidate(
            "http://localhost:8000",
            DeploymentMode::Native,
            &[100, 101],
        )];
        let docker = vec![candidate(
            "http://localhost:8000",
            DeploymentMode::Docker,
            &[101, 102],
        )];
        merge_docker_candidates(&mut candidates, docker);

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].deployment_mode, DeploymentMode::Docker);
        assert_eq!(candidates[0].pids, vec![100, 101, 102]);
    }

    #[test]
    fn docker_merge_keeps_distinct_endpoints_separate() {
        let mut candidates = vec![candidate(
            "http://localhost:8000",
            DeploymentMode::Native,
            &[100],
        )];
        let docker = vec![candidate(
            "http://localhost:8001",
            DeploymentMode::Docker,
            &[200],
        )];
        merge_docker_candidates(&mut candidates, docker);

        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].pids, vec![100]);
        assert_eq!(candidates[1].pids, vec![200]);
    }

    // -----------------------------------------------------------------------
    // Ollama
    // -----------------------------------------------------------------------

    /// The runner child of Ollama 0.19.0 on the Spark, verbatim from the
    /// live capture, and v0.40.5's `llama-server` child as its source builds
    /// the command line.
    const OLLAMA_RUNNER: &str = "/usr/local/bin/ollama runner --model /usr/share/ollama/.ollama/models/blobs/sha256-2af3b81862c6be03c769683af18efdadb2c33f60ff32ab6f83e42c043d6c7816 --port 45983";
    const LLAMA_SERVER: &str = "/usr/lib/ollama/llama-server --model /root/.ollama/models/blobs/sha256-2af3b81862c6be03c769683af18efdadb2c33f60ff32ab6f83e42c043d6c7816 --port 41234 --host 127.0.0.1 --no-webui --offline -c 4096";

    fn ollama_candidate(endpoint: &str, mode: DeploymentMode, pids: &[u32]) -> DetectedEngine {
        DetectedEngine {
            engine_type: EngineType::Ollama,
            ..candidate(endpoint, mode, pids)
        }
    }

    /// `ollama serve` by every path it is launched from: systemd's
    /// `/usr/local/bin/ollama`, the image's `/bin/ollama`, through `PATH`,
    /// Homebrew's, and Windows' `ollama.exe`.
    #[test]
    fn ollama_serve_is_recognized_in_its_launch_forms() {
        for line in [
            "/usr/local/bin/ollama serve",
            "/bin/ollama serve",
            "ollama serve",
            "/opt/homebrew/bin/ollama serve",
            "C:\\Ollama\\ollama.exe serve",
        ] {
            assert_eq!(
                engine_of_process(&argv(line)),
                Some(EngineType::Ollama),
                "{line}"
            );
            assert!(runs_engine(line, &EngineType::Ollama), "{line}");
        }
    }

    /// Only the server is: not Ollama's clients, not its per-model runners
    /// (`ollama runner` up to v0.19, `llama-server` from v0.35 — `serve` is a
    /// substring of it), not a program that is merely named like it.
    #[test]
    fn nothing_else_named_ollama_or_serve_is_the_server() {
        for line in [
            OLLAMA_RUNNER,
            LLAMA_SERVER,
            "ollama run tinyllama",
            "ollama run serve",
            "ollama ps",
            "ollama",
            "/usr/local/bin/ollama-serve",
            "my-ollama serve",
            "llama-server serve",
            "sh -c ollama serve",
            "tail -f /var/log/ollama serve",
        ] {
            assert_eq!(engine_of_process(&argv(line)), None, "{line}");
            assert!(!runs_engine(line, &EngineType::Ollama), "{line}");
        }
    }

    /// A native server is probed where its `OLLAMA_HOST` says it listens, and
    /// on Ollama's default when the variable is unset or the environment
    /// cannot be read (Ollama runs as `ollama`, the dashboard does not).
    #[test]
    fn a_native_ollama_is_probed_where_its_ollama_host_says() {
        let endpoint = |env: std::io::Result<Option<String>>| {
            let env = std::sync::Mutex::new(Some(env));
            let detected = scan_with(&[(100, Some(1), "/usr/local/bin/ollama serve")], |pid| {
                assert_eq!(pid, 100);
                env.lock().unwrap().take().expect("read once")
            });
            assert_eq!(detected.len(), 1);
            assert_eq!(detected[0].engine_type, EngineType::Ollama);
            assert_eq!(detected[0].deployment_mode, DeploymentMode::Native);
            assert_eq!(detected[0].served_model, None);
            detected[0].endpoint.clone()
        };
        assert_eq!(endpoint(Ok(None)), "http://127.0.0.1:11434");
        assert_eq!(
            endpoint(Err(std::io::ErrorKind::PermissionDenied.into())),
            "http://127.0.0.1:11434"
        );
        assert_eq!(
            endpoint(Ok(Some("0.0.0.0:8080".into()))),
            "http://127.0.0.1:8080"
        );
        assert_eq!(
            endpoint(Ok(Some("http://10.0.0.5".into()))),
            "http://10.0.0.5:80"
        );
        assert_eq!(endpoint(Ok(Some("[::]".into()))), "http://127.0.0.1:11434");
    }

    #[test]
    fn ollama_host_is_read_from_an_environment_listing() {
        let environ = b"HOME=/usr/share/ollama\0OLLAMA_HOSTNAME=x\0OLLAMA_HOST=0.0.0.0:11434\0PATH=/usr/bin\0";
        let entries = environ.split(|&b| b == 0);
        assert_eq!(
            env_var_in(entries, "OLLAMA_HOST").as_deref(),
            Some("0.0.0.0:11434")
        );
        // Docker's `Env`, as the image's Dockerfile sets it.
        let docker = [
            "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "NVIDIA_VISIBLE_DEVICES=all",
            "OLLAMA_HOST=0.0.0.0:11434",
        ];
        assert_eq!(
            env_var_in(docker.iter().map(|e| e.as_bytes()), "OLLAMA_HOST").as_deref(),
            Some("0.0.0.0:11434")
        );
        assert_eq!(
            env_var_in(b"OLLAMA_HOSTNAME=x\0".split(|&b| b == 0), "OLLAMA_HOST"),
            None
        );
    }

    /// One Ollama server is one engine, its runners inside it: a loaded
    /// model's runner neither becomes an engine nor gets its own endpoint,
    /// and its PID joins the server's — the GPU sees the runner, not the
    /// server. Before a load, after it and after the unload, the engine is
    /// the same `(type, endpoint)`; only its PIDs follow the runners.
    #[test]
    fn an_ollama_server_is_one_engine_with_its_runners_inside_it() {
        let serve = (100, Some(1), "/usr/local/bin/ollama serve");
        let identity = |d: &[DetectedEngine]| -> Vec<(EngineType, String, Vec<u32>)> {
            d.iter()
                .map(|d| (d.engine_type.clone(), d.endpoint.clone(), d.pids.clone()))
                .collect()
        };
        let engine = |pids: Vec<u32>| {
            vec![(
                EngineType::Ollama,
                "http://127.0.0.1:11434".to_string(),
                pids,
            )]
        };

        assert_eq!(identity(&scan(&[serve])), engine(vec![100]), "idle");
        assert_eq!(
            identity(&scan(&[
                serve,
                (101, Some(100), OLLAMA_RUNNER),
                (102, Some(100), LLAMA_SERVER),
                (103, Some(102), "/usr/lib/ollama/llama-server --worker"),
            ])),
            engine(vec![100, 101, 102, 103]),
            "two models loaded"
        );
        assert_eq!(identity(&scan(&[serve])), engine(vec![100]), "unloaded");
    }

    /// Whatever matcher claims a process, one that an Ollama server started
    /// is Ollama's and not an engine of its own. A `vllm serve` stands in
    /// here for the `llama-server` an engine type for llama.cpp (#126) will
    /// recognize: the exclusion applies before any matcher, so that type
    /// inherits it. The same command line outside Ollama is an engine.
    #[test]
    fn a_process_ollama_started_is_never_an_engine_of_its_own() {
        let detected = scan(&[
            (100, Some(1), "/usr/local/bin/ollama serve"),
            (101, Some(100), "vllm serve /models/x --port 45999"),
            (
                102,
                Some(101),
                "python3 -m sglang.launch_server --port 46000",
            ),
            (200, Some(1), "vllm serve /models/x --port 8001"),
        ]);
        let found: Vec<_> = detected
            .iter()
            .map(|d| (d.engine_type.clone(), d.endpoint.as_str(), d.pids.clone()))
            .collect();
        assert_eq!(
            found,
            vec![
                (
                    EngineType::Ollama,
                    "http://127.0.0.1:11434",
                    vec![100, 101, 102]
                ),
                (EngineType::Vllm, "http://localhost:8001", vec![200]),
            ]
        );
    }

    /// Two servers bound to different addresses are two engines.
    #[test]
    fn ollama_servers_on_different_addresses_are_different_engines() {
        let detected = scan_with(
            &[
                (100, Some(1), "/usr/local/bin/ollama serve"),
                (200, Some(1), "/usr/local/bin/ollama serve"),
            ],
            |pid| Ok((pid == 200).then(|| "127.0.0.1:11500".to_string())),
        );
        let endpoints: Vec<_> = detected.iter().map(|d| d.endpoint.as_str()).collect();
        assert_eq!(
            endpoints,
            ["http://127.0.0.1:11434", "http://127.0.0.1:11500"]
        );
    }

    #[test]
    fn ollamas_image_is_recognized_from_any_registry_and_tag() {
        for image in [
            "ollama/ollama",
            "ollama/ollama:latest",
            "ollama/ollama:0.40.5",
            "ollama/ollama:rocm",
            "docker.io/ollama/ollama:0.19.0",
            "registry.local:5000/ollama/ollama@sha256:0123abcd",
            "registry.local:5000/ollama/ollama:0.40.5@sha256:0123abcd",
        ] {
            assert!(is_ollama_image(image), "{image}");
        }
        for image in [
            "ghcr.io/open-webui/open-webui:ollama",
            "ollama/ollama-webui",
            "myorg/ollama",
            "registry.local:5000/ollama",
            "vllm/vllm-openai:latest",
            "",
        ] {
            assert!(!is_ollama_image(image), "{image}");
        }
    }

    /// Image, then command, then name — as for the other engines. Ollama's
    /// image is enough; a private image running `ollama serve` is too; a
    /// container that is only named like Ollama must show the server in
    /// its process list.
    #[test]
    fn an_ollama_container_is_classified_by_image_command_then_name() {
        let ollama = |strong_signal| {
            Some(ContainerClass {
                engine_type: EngineType::Ollama,
                strong_signal,
            })
        };
        assert_eq!(
            classify_container(&[], "ollama/ollama:0.40.5", "/bin/ollama serve"),
            ollama(true)
        );
        // The image wins over a command that mentions another engine.
        assert_eq!(
            classify_container(&[], "docker.io/ollama/ollama", "/bin/ollama serve --vllm"),
            ollama(true)
        );
        assert_eq!(
            classify_container(&["llm".into()], "myorg/llm:1", "/usr/bin/ollama serve"),
            ollama(true)
        );
        assert_eq!(
            classify_container(&["/ollama".into()], "myorg/base", "sleep infinity"),
            ollama(false)
        );
        // Open WebUI is not an Ollama server, whatever its tag says.
        assert_eq!(
            classify_container(
                &["/open-webui".into()],
                "ghcr.io/open-webui/open-webui:ollama",
                "bash start.sh"
            ),
            None
        );
    }

    /// `docker top` rows lead with the PID; the command line after it is
    /// read like a host process's argv, so `ollama serve` is recognized in
    /// it and the runners are not.
    #[test]
    fn a_top_row_is_read_without_its_pid() {
        let row = to_row(&["4242", "/bin/ollama serve"]);
        assert_eq!(top_row_command(&row), "/bin/ollama serve");
        assert!(runs_engine(&top_row_command(&row), &EngineType::Ollama));
        let runner = to_row(&["4243", LLAMA_SERVER]);
        assert!(!runs_engine(&top_row_command(&runner), &EngineType::Ollama));
        assert_eq!(top_row_command(&to_row(&["PID"])), "");
    }

    fn published(container: u16, host: Option<u16>, host_ip: &str) -> PublishedPort<'_> {
        PublishedPort {
            container,
            host,
            host_ip: Some(host_ip),
            tcp: true,
        }
    }

    /// Where a container's Ollama answers from the host, for each way it can
    /// be run: published (`-p`), on the host network, or neither.
    #[test]
    fn an_ollama_container_is_probed_where_the_host_reaches_it() {
        let image = OllamaHost::from_env(Some("0.0.0.0:11434"));
        let resolve = |listen: &OllamaHost, mode: Option<&str>, ports: &[PublishedPort<'_>]| {
            ollama_container_endpoint(listen, mode, ports)
        };

        // `docker run -p 11434:11434 ollama/ollama` — Docker lists the
        // binding once per address family.
        let both = [
            published(11434, Some(11434), "0.0.0.0"),
            published(11434, Some(11434), "::"),
        ];
        assert_eq!(
            resolve(&image, Some("bridge"), &both).as_deref(),
            Some("http://127.0.0.1:11434")
        );
        // Published elsewhere, or on one address only.
        assert_eq!(
            resolve(
                &image,
                Some("default"),
                &[published(11434, Some(11500), "")]
            )
            .as_deref(),
            Some("http://127.0.0.1:11500")
        );
        assert_eq!(
            resolve(
                &image,
                Some("bridge"),
                &[published(11434, Some(11500), "192.168.1.5")]
            )
            .as_deref(),
            Some("http://192.168.1.5:11500")
        );
        assert_eq!(
            resolve(
                &image,
                Some("bridge"),
                &[published(11434, Some(11500), "127.0.0.1")]
            )
            .as_deref(),
            Some("http://127.0.0.1:11500")
        );
        // A UDP binding of the port, or an exposed port that is not
        // published, does not reach the server.
        let udp = PublishedPort {
            tcp: false,
            ..published(11434, Some(11434), "0.0.0.0")
        };
        assert_eq!(resolve(&image, Some("bridge"), &[udp]), None);
        assert_eq!(
            resolve(&image, Some("bridge"), &[published(11434, None, "")]),
            None
        );

        // The container's own OLLAMA_HOST moves the port that has to be
        // published: `-e OLLAMA_HOST=0.0.0.0:8080 -p 9000:8080`.
        let moved = OllamaHost::from_env(Some("0.0.0.0:8080"));
        assert_eq!(
            resolve(
                &moved,
                Some("bridge"),
                &[published(8080, Some(9000), "0.0.0.0")]
            )
            .as_deref(),
            Some("http://127.0.0.1:9000")
        );
        assert_eq!(
            resolve(
                &moved,
                Some("bridge"),
                &[published(11434, Some(11434), "0.0.0.0")]
            ),
            None
        );

        // `--network host` publishes nothing: the server is on the host's
        // interfaces, where its OLLAMA_HOST binds it — the image's, a
        // custom one, or none (a private image).
        assert_eq!(
            resolve(&image, Some("host"), &[]).as_deref(),
            Some("http://127.0.0.1:11434")
        );
        assert_eq!(
            resolve(
                &OllamaHost::from_env(Some("127.0.0.1:12000")),
                Some("host"),
                &[]
            )
            .as_deref(),
            Some("http://127.0.0.1:12000")
        );
        assert_eq!(
            resolve(&OllamaHost::from_env(None), Some("host"), &[]).as_deref(),
            Some("http://127.0.0.1:11434")
        );

        // On a bridge with nothing published it is unreachable from the
        // host; with the network unknown, or another container's, the
        // listening port is assumed and the probe decides.
        assert_eq!(resolve(&image, Some("bridge"), &[]), None);
        assert_eq!(resolve(&image, Some("my-network"), &[]), None);
        assert_eq!(
            resolve(&image, None, &[]).as_deref(),
            Some("http://127.0.0.1:11434")
        );
        assert_eq!(
            resolve(&image, Some("container:abc123"), &[]).as_deref(),
            Some("http://127.0.0.1:11434")
        );
    }

    /// The host scan sees a containerized server too, and — unable to read a
    /// root process's environment — puts it on Ollama's default address.
    /// Published there, it is the same engine as the container's and the
    /// two merge. Published elsewhere, its processes are the container's:
    /// they leave a native engine on the default address (here a native
    /// Ollama's, whose runner they must not join), and a host-scan
    /// candidate made only of them is dropped.
    #[test]
    fn an_ollama_containers_processes_belong_to_its_container() {
        // `-p 11434:11434`: one engine, from the container.
        let mut candidates = vec![ollama_candidate(
            "http://127.0.0.1:11434",
            DeploymentMode::Native,
            &[300, 301],
        )];
        merge_docker_candidates(
            &mut candidates,
            vec![ollama_candidate(
                "http://127.0.0.1:11434",
                DeploymentMode::Docker,
                &[300, 301],
            )],
        );
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].deployment_mode, DeploymentMode::Docker);
        assert_eq!(candidates[0].pids, vec![300, 301]);

        // A native Ollama on the default port, and a container published on
        // 11500 whose server the host scan also put on the default port.
        let mut candidates = vec![ollama_candidate(
            "http://127.0.0.1:11434",
            DeploymentMode::Native,
            &[100, 101, 300, 301],
        )];
        merge_docker_candidates(
            &mut candidates,
            vec![ollama_candidate(
                "http://127.0.0.1:11500",
                DeploymentMode::Docker,
                &[300, 301],
            )],
        );
        let found: Vec<_> = candidates
            .iter()
            .map(|c| {
                (
                    c.endpoint.as_str(),
                    c.deployment_mode.clone(),
                    c.pids.clone(),
                )
            })
            .collect();
        assert_eq!(
            found,
            vec![
                (
                    "http://127.0.0.1:11434",
                    DeploymentMode::Native,
                    vec![100, 101]
                ),
                (
                    "http://127.0.0.1:11500",
                    DeploymentMode::Docker,
                    vec![300, 301]
                ),
            ]
        );

        // The container alone: the host scan's guess has nothing left.
        let mut candidates = vec![ollama_candidate(
            "http://127.0.0.1:11434",
            DeploymentMode::Native,
            &[300, 301],
        )];
        merge_docker_candidates(
            &mut candidates,
            vec![ollama_candidate(
                "http://127.0.0.1:11500",
                DeploymentMode::Docker,
                &[300, 301],
            )],
        );
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].endpoint, "http://127.0.0.1:11500");
    }
}
