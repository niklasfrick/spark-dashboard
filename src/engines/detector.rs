use super::common::EngineHttp;
use super::llamacpp;
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
    /// Where else to probe, in order, when `endpoint` does not answer as
    /// this engine type: a llama-server whose launch names no port is on
    /// one of llama.cpp's default ports (`llamacpp::default_ports`), and
    /// only the probe can tell which. Empty for every other candidate, and
    /// once verified — `endpoint` is then the one that answered.
    pub fallback_endpoints: Vec<String>,
}

/// The port vLLM serves on when it is not told otherwise. Used wherever a
/// candidate is found but its port cannot be read off the command line.
const VLLM_DEFAULT_PORT: u16 = 8000;

/// SGLang's default HTTP port (`--port` unset), same role as above.
const SGLANG_DEFAULT_PORT: u16 = 30000;

/// TensorFold's default HTTP port: `tensorfold-native serve` listens on
/// 127.0.0.1:8080 unless `--host`/`--port` say otherwise.
const TENSORFOLD_DEFAULT_PORT: u16 = 8080;

/// The port an engine type serves on when it is not told otherwise. A
/// llama-server has two, by release, which its candidates carry whole
/// (`llamacpp::default_ports`); this is only the first a native one is
/// tried on.
fn default_port(engine_type: &EngineType) -> u16 {
    match engine_type {
        EngineType::Vllm => VLLM_DEFAULT_PORT,
        EngineType::Sglang => SGLANG_DEFAULT_PORT,
        EngineType::Ollama => super::ollama::DEFAULT_PORT,
        EngineType::LlamaCpp => llamacpp::default_ports(&DeploymentMode::Native)[0],
        EngineType::Tensorfold => TENSORFOLD_DEFAULT_PORT,
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
    verify_candidates(candidates, client, api_keys).await
}

/// The candidates whose API answers as their engine type, each on the first
/// of its endpoints that does (`endpoint`, then `fallback_endpoints`).
///
/// Two candidates verified on one endpoint are one server, and become one
/// engine (`join_on_endpoint`) on the container's view of it — its model
/// too, where it names one. The host scan's guess at a llama-server's
/// default port and a container whose processes could not be listed can
/// meet there, though they had no endpoint in common before the probe.
async fn verify_candidates(
    candidates: Vec<DetectedEngine>,
    client: &reqwest::Client,
    api_keys: &ApiKeyResolver,
) -> Vec<DetectedEngine> {
    let mut verified = Vec::new();
    for mut candidate in candidates {
        let fallbacks = std::mem::take(&mut candidate.fallback_endpoints);
        for endpoint in std::iter::once(candidate.endpoint.clone()).chain(fallbacks) {
            let http = EngineHttp::new(
                client.clone(),
                endpoint.clone(),
                api_keys.resolve(&endpoint),
            );
            if probe_engine(&http, &candidate.engine_type).await {
                if endpoint != candidate.endpoint {
                    tracing::debug!(
                        "{} candidate is not on {}; it answers on {endpoint}",
                        candidate.engine_type,
                        candidate.endpoint,
                    );
                }
                candidate.endpoint = endpoint;
                join_on_endpoint(&mut verified, candidate);
                break;
            }
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
/// engine on different ports are preserved as distinct entries: a Docker
/// candidate on an endpoint the process scan has too joins that entry
/// (`join_on_endpoint`). This is also what still joins a container whose
/// processes could not be listed to the host scan's view of it.
fn merge_docker_candidates(
    candidates: &mut Vec<DetectedEngine>,
    mut docker_candidates: Vec<DetectedEngine>,
) {
    for container in &mut docker_candidates {
        absorb_container_processes(candidates, container);
    }
    for dc in docker_candidates {
        join_on_endpoint(candidates, dc);
    }
}

/// Add `candidate`, or fold it into the candidate of its engine type already
/// on its endpoint: one server is one engine.
///
/// The PID sets are united — `docker top` and the host process scan may each
/// see processes the other missed — and a container's view wins: Docker
/// detection is authoritative for the deployment mode and container
/// identity, and for the served model when it names one. The host scan
/// reads a containerized server's command line but not its environment (it
/// runs as root), so a llama.cpp container that names its model by
/// `LLAMA_ARG_ALIAS` is, to the host scan, only its `-m` path. Otherwise a
/// served-model hint fills in where there was none: Docker discovery often
/// sees the `--model` arg the operator launched with, while native process
/// scanning may not (e.g. when vLLM is launched inside a container with host
/// networking).
fn join_on_endpoint(candidates: &mut Vec<DetectedEngine>, candidate: DetectedEngine) {
    let Some(existing) = candidates
        .iter_mut()
        .find(|c| c.engine_type == candidate.engine_type && c.endpoint == candidate.endpoint)
    else {
        candidates.push(candidate);
        return;
    };
    let container_names_model =
        candidate.deployment_mode == DeploymentMode::Docker && candidate.served_model.is_some();
    if container_names_model || existing.served_model.is_none() {
        existing.served_model = candidate.served_model;
    }
    if candidate.deployment_mode == DeploymentMode::Docker {
        existing.deployment_mode = DeploymentMode::Docker;
    }
    for pid in candidate.pids {
        if !existing.pids.contains(&pid) {
            existing.pids.push(pid);
        }
    }
    existing.pids.sort_unstable();
    if existing.container_id.is_none() {
        existing.container_id = candidate.container_id;
    }
    for endpoint in candidate.fallback_endpoints {
        if endpoint != existing.endpoint && !existing.fallback_endpoints.contains(&endpoint) {
            existing.fallback_endpoints.push(endpoint);
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

/// Whether a command line runs llama.cpp's server: the program `llama-server`
/// by any path (the official images' `/app/llama-server`, a release
/// tarball's, Ollama's own child from v0.35). Only the program counts —
/// nothing runs llama-server as a module or a subcommand — so a process that
/// names it among its arguments (`journalctl -u llama-server`, `tmux new -s
/// llama-server`) is not one. That matters more than for vLLM or SGLang: a
/// llama-server's descendants are its own (`engines_from_processes`), and a
/// tmux session named after it would otherwise hide every server started
/// inside it. Docker Desktop's renamed `com.docker.llama-server` serves its
/// model runner on a Unix socket and is not one either.
fn is_llama_server(args: &[&str]) -> bool {
    let program = args
        .first()
        .map(|arg| arg.rsplit(&['/', '\\'][..]).next().unwrap_or(arg));
    matches!(program, Some("llama-server" | "llama-server.exe"))
}

/// Whether a command line runs TensorFold's server: the program
/// `tensorfold-native` by any path, or the Homebrew `tensorfold` binary,
/// either with `.exe`. Only the program counts — a log file named after the
/// engine is not the server.
///
/// The one module launch TensorFold documents, `python -m tensorfold[.…]`, is
/// recognized by the module token *after* `-m`, and by nothing else: a Python
/// process that merely passes a path or a flag value containing "tensorfold."
/// — `--served-model-name tensorfold.v1`, `--download-dir
/// /data/tensorfold.models` — stays whatever its module names, and
/// `server_named_by` can still name it vLLM or SGLang.
fn is_tensorfold_server(args: &[&str]) -> bool {
    let program = args
        .first()
        .map(|arg| arg.rsplit(&['/', '\\'][..]).next().unwrap_or(arg));
    if matches!(
        program,
        Some("tensorfold-native" | "tensorfold-native.exe" | "tensorfold" | "tensorfold.exe")
    ) {
        return true;
    }
    program.is_some_and(|program| program.starts_with("python"))
        && args
            .windows(2)
            .any(|pair| pair[0] == "-m" && is_tensorfold_module(pair[1]))
}

/// Whether a `python -m` module names TensorFold: `tensorfold` itself or a
/// submodule of it.
fn is_tensorfold_module(module: &str) -> bool {
    module == "tensorfold" || module.starts_with("tensorfold.")
}

/// Which engine a command line runs, if any. Ollama's server is told by its
/// program and subcommand together (`is_ollama_server`), llama.cpp's and
/// TensorFold's by their programs (`is_llama_server`, `is_tensorfold_server`);
/// otherwise the first argument that names an engine's server decides. The
/// program comes before its arguments, so a path or flag value that happens
/// to name the other engine — `python3 -m sglang.launch_server --download-dir
/// /data/vllm` — cannot turn the process into that engine too. A process is at
/// most one engine.
fn engine_of_command<'a>(args: impl IntoIterator<Item = &'a str>) -> Option<EngineType> {
    let args: Vec<&str> = args.into_iter().collect();
    if is_ollama_server(&args) {
        return Some(EngineType::Ollama);
    }
    if is_llama_server(&args) {
        return Some(EngineType::LlamaCpp);
    }
    if is_tensorfold_server(&args) {
        return Some(EngineType::Tensorfold);
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
        // The command line alone: the Docker scan reads a llama.cpp
        // container with its environment too (`llamacpp_launch`).
        EngineType::LlamaCpp => {
            llamacpp_launch(&cmd.split_whitespace().collect::<Vec<_>>(), |_| None).served_model()
        }
        // TensorFold names the model it serves with `--name`, and `/v1/models`
        // answers that name; the model path is the positional argument and
        // names a file, not the served id, so only `--name` is read.
        EngineType::Tensorfold => parse_tensorfold_model_from_command_str(cmd),
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
    let repository = image_repository(image);
    repository == "ollama/ollama" || repository.ends_with("/ollama/ollama")
}

/// An image reference without its tag and digest:
/// `registry.local:5000/ollama/ollama:0.40.5@sha256:…` is
/// `registry.local:5000/ollama/ollama`.
#[cfg(any(target_os = "linux", test))]
fn image_repository(image: &str) -> &str {
    let name = image.split('@').next().unwrap_or(image);
    // A tag is a `:` after the last `/`; one before it is a registry port.
    match name.rfind(':') {
        Some(colon) if !name[colon..].contains('/') => &name[..colon],
        _ => name,
    }
}

/// How llama.cpp is spelled where people name things after it.
#[cfg(any(target_os = "linux", test))]
const LLAMACPP_SPELLINGS: [&str; 3] = ["llama.cpp", "llama-cpp", "llamacpp"];

/// Whether an image is a llama.cpp build: its repository — not its tag —
/// names llama.cpp, as the official `ghcr.io/ggml-org/llama.cpp` does, in
/// any of its spellings. Neither Ollama's image, which runs llama.cpp inside
/// but serves Ollama's API, nor `docker/model-runner`, which serves its
/// bundled llama-server on a Unix socket, names it.
#[cfg(any(target_os = "linux", test))]
fn is_llamacpp_image(image: &str) -> bool {
    let repository = image_repository(image);
    LLAMACPP_SPELLINGS
        .iter()
        .any(|spelling| repository.contains(spelling))
}

/// Whether an image is a TensorFold build: its repository — not its tag —
/// names tensorfold, as `ghcr.io/ashhart/tensorfold` does, in any tag or
/// digest. The official image runs `tensorfold-native`, so the image is a
/// strong signal on its own.
#[cfg(any(target_os = "linux", test))]
fn is_tensorfold_image(image: &str) -> bool {
    image_repository(image).contains("tensorfold")
}

/// Rank the signals by how much they say:
///   1. the **image** is what was pulled to run here — Ollama's own image is
///      Ollama, one whose repository names llama.cpp is llama.cpp, and an
///      image that names exactly one of vLLM and SGLang is that engine. An
///      `lmsysorg/sglang` image whose command mentions vLLM (an env var, a
///      model path) is SGLang.
///   2. the **command** is what the entrypoint runs — its launch form, read
///      like a host process's (`ollama serve` or `llama-server` by any path,
///      or the first argument naming a server), so
///      `python3 -m sglang.launch_server --model-path /models/x-vllm-awq`
///      is SGLang. Failing a launch form, a command that mentions exactly
///      one engine anywhere (a shell wrapper's quoted `"vllm serve ..."`)
///      still names it.
///   3. the **name** is what somebody typed — a weak signal the container's
///      processes must confirm. "llama" alone is no llama.cpp name: it is in
///      "ollama".
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
    if is_llamacpp_image(image) {
        return class(EngineType::LlamaCpp, true);
    }
    if is_tensorfold_image(image) {
        return class(EngineType::Tensorfold, true);
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
    } else if LLAMACPP_SPELLINGS
        .iter()
        .chain(&["llama-server"])
        .any(|spelling| named(spelling))
    {
        class(EngineType::LlamaCpp, false)
    } else if named("tensorfold") {
        class(EngineType::Tensorfold, false)
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

/// A setting of a llama-server's launch that detection reads
/// (`llamacpp_launch`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum LlamaCppSetting {
    Host,
    Port,
    Alias,
    HfRepo,
    DockerRepo,
    Model,
}

impl LlamaCppSetting {
    const ALL: [Self; 6] = [
        Self::Host,
        Self::Port,
        Self::Alias,
        Self::HfRepo,
        Self::DockerRepo,
        Self::Model,
    ];

    /// The launch flags that set it.
    fn flags(self) -> &'static [&'static str] {
        match self {
            Self::Host => &["--host"],
            Self::Port => &["--port"],
            Self::Alias => &["-a", "--alias"],
            Self::HfRepo => &["-hf", "-hfr", "--hf-repo"],
            Self::DockerRepo => &["-dr", "--docker-repo"],
            Self::Model => &["-m", "--model"],
        }
    }

    /// The environment variable that sets it when no flag does.
    fn env_var(self) -> &'static str {
        match self {
            Self::Host => "LLAMA_ARG_HOST",
            Self::Port => "LLAMA_ARG_PORT",
            Self::Alias => "LLAMA_ARG_ALIAS",
            Self::HfRepo => "LLAMA_ARG_HF_REPO",
            Self::DockerRepo => "LLAMA_ARG_DOCKER_REPO",
            Self::Model => "LLAMA_ARG_MODEL",
        }
    }
}

/// What a llama-server's launch says about where it listens and which model
/// it serves (`llamacpp_launch`).
#[derive(Debug, Default, PartialEq)]
struct LlamaCppLaunch {
    /// `--host`: an address, a comma-separated list of them, or Unix socket
    /// paths (`….sock`).
    host: Option<String>,
    /// `--port`, when it is a port number.
    port: Option<u16>,
    /// `-a`/`--alias`: comma-separated names for the model.
    alias: Option<String>,
    /// `-hf`/`-hfr`/`--hf-repo`: `<user>/<model>[:quant]`.
    hf_repo: Option<String>,
    /// `-dr`/`--docker-repo`.
    docker_repo: Option<String>,
    /// `-m`/`--model`: the GGUF path.
    model: Option<String>,
}

/// Read a llama-server's launch as llama-server reads it: each setting from
/// its flag, else from its `LLAMA_ARG_*` variable (`env`), else left to
/// llama-server's default — the official image's `LLAMA_ARG_PORT=8080` with
/// `--port 18091` listens on 18091. A flag given twice counts its last
/// value, and a long flag may be spelled with `_` for `-` (`--hf_repo`), as
/// llama-server allows; `--flag=value` is read too. Arguments that are not
/// these flags or their values are passed over, the program among them, so
/// a wrapper's command line (`/app/tools.sh --server -m …`) reads the same.
fn llamacpp_launch<S: AsRef<str>>(
    args: &[S],
    env: impl Fn(&str) -> Option<String>,
) -> LlamaCppLaunch {
    let mut flags: HashMap<LlamaCppSetting, String> = HashMap::new();
    let mut args = args.iter().map(AsRef::as_ref);
    while let Some(arg) = args.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((flag, value)) if flag.starts_with("--") => (flag, Some(value)),
            _ => (arg, None),
        };
        let flag = if flag.starts_with("--") {
            flag.replace('_', "-")
        } else {
            flag.to_string()
        };
        let Some(setting) = LlamaCppSetting::ALL
            .into_iter()
            .find(|setting| setting.flags().contains(&flag.as_str()))
        else {
            continue;
        };
        if let Some(value) = inline.or_else(|| args.next()) {
            flags.insert(setting, value.to_string());
        }
    }
    let read = |setting: LlamaCppSetting| {
        flags
            .get(&setting)
            .cloned()
            .or_else(|| env(setting.env_var()))
            .filter(|value| !value.trim().is_empty())
    };
    LlamaCppLaunch {
        host: read(LlamaCppSetting::Host),
        port: read(LlamaCppSetting::Port).and_then(|port| port.trim().parse().ok()),
        alias: read(LlamaCppSetting::Alias),
        hf_repo: read(LlamaCppSetting::HfRepo),
        docker_repo: read(LlamaCppSetting::DockerRepo),
        model: read(LlamaCppSetting::Model),
    }
}

impl LlamaCppLaunch {
    /// The name llama-server serves its model under, which `/models`
    /// reports: the alias that sorts first (it keeps its aliases in a sorted
    /// set), else the Hugging Face repository, else the Docker one, else the
    /// model path, as given. `None` for a router, which has no model of its
    /// own.
    fn served_model(&self) -> Option<String> {
        let alias = self.alias.as_deref().and_then(|aliases| {
            aliases
                .split(',')
                .map(str::trim)
                .filter(|alias| !alias.is_empty())
                .min()
        });
        alias
            .or(self.hf_repo.as_deref())
            .or(self.docker_repo.as_deref())
            .or(self.model.as_deref())
            .map(str::to_string)
    }

    /// Where it listens over TCP: the first TCP address of its `--host`,
    /// and its `--port` — or, naming none, `default_ports`, to be tried in
    /// order. `None` when the launch names no TCP port to reach: a server
    /// bound only to Unix sockets (docker-model-runner's child, `--host
    /// <path>.sock`), or to `--port 0`, a port picked when it binds.
    fn listen(&self, default_ports: [u16; 2]) -> Option<LlamaCppListen<'_>> {
        let host = match self.host.as_deref() {
            None => None,
            Some(hosts) => Some(hosts.split(',').map(str::trim).find(|h| is_tcp_host(h))?),
        };
        let (port, fallback_ports) = match self.port {
            Some(0) => return None,
            Some(port) => (port, Vec::new()),
            None => {
                let [first, others @ ..] = default_ports;
                (first, others.to_vec())
            }
        };
        Some(LlamaCppListen {
            host,
            port,
            fallback_ports,
        })
    }
}

/// Whether a `--host` entry is a TCP address rather than a Unix socket path,
/// which llama-server tells by the `.sock` ending; nothing with a `/` in it
/// is an address either.
fn is_tcp_host(host: &str) -> bool {
    !host.is_empty() && !host.ends_with(".sock") && !host.contains('/')
}

/// Where a llama-server listens over TCP, as its launch says: on the port it
/// names, or — naming none — on one of llama.cpp's defaults, so there is
/// always a port to try first.
#[derive(Debug, PartialEq)]
struct LlamaCppListen<'a> {
    /// The address; `None` for llama-server's own default, the loopback.
    host: Option<&'a str>,
    /// The port to try first: the one its launch names, else the likelier
    /// of llama.cpp's defaults.
    port: u16,
    /// The ports to try after `port`, in order: the other defaults when its
    /// launch names no port, else none.
    fallback_ports: Vec<u16>,
}

impl LlamaCppListen<'_> {
    /// Every port it may be on, in the order to try them, `port` first.
    #[cfg(any(target_os = "linux", test))]
    fn ports(&self) -> impl Iterator<Item = u16> + '_ {
        std::iter::once(self.port).chain(self.fallback_ports.iter().copied())
    }

    /// The endpoint on its address to probe first, on `port`, and those to
    /// fall back on, one for each of `fallback_ports` in order.
    fn endpoints(&self) -> (String, Vec<String>) {
        let on = |port| llamacpp_endpoint(self.host, port);
        (
            on(self.port),
            self.fallback_ports.iter().copied().map(on).collect(),
        )
    }
}

/// The endpoint for a llama-server on `host`: one bound to every interface
/// (`0.0.0.0`, `::`), or to the default, is probed on localhost, as the
/// other engines' are; an IPv6 address goes in brackets.
fn llamacpp_endpoint(host: Option<&str>, port: u16) -> String {
    let host = host.unwrap_or_default().trim_matches(['[', ']']);
    let host = match host.parse::<std::net::IpAddr>() {
        Ok(ip) if ip.is_unspecified() => "localhost".to_string(),
        Ok(std::net::IpAddr::V6(ip)) => format!("[{ip}]"),
        Ok(ip) => ip.to_string(),
        Err(_) if host.is_empty() => "localhost".to_string(),
        Err(_) => host.to_string(),
    };
    format!("http://{host}:{port}")
}

/// The endpoints a containerized llama-server answers on from the host, in
/// the order to probe them, given where it listens inside the container,
/// its network mode and its published ports:
///
/// - on the host network it listens on the host's own interfaces, read
///   like a native server's;
/// - otherwise the host ports that publish the ports it may listen on, in
///   their order, then any other published port: a port set where neither
///   its command nor its environment shows it (a wrapper script's) can
///   still be published, and the probe rejects what is not llama-server;
/// - with nothing published there and a network mode the Docker API did not
///   report, or one shared with another container, the listening ports are
///   assumed reachable as on the host network;
/// - on a bridge or other network with nothing published, none: the server
///   is unreachable from the host, and assuming its port would point at
///   whatever else is there — a native llama-server on 8080, say, whose
///   engine would then take this container for its own.
#[cfg(any(target_os = "linux", test))]
fn llamacpp_container_endpoints(
    listen: &LlamaCppListen<'_>,
    network_mode: Option<&str>,
    published: &[PublishedPort<'_>],
) -> Vec<String> {
    let listening = || {
        let (endpoint, fallbacks) = listen.endpoints();
        std::iter::once(endpoint).chain(fallbacks).collect()
    };
    if network_mode == Some("host") {
        return listening();
    }
    let mut bindings: Vec<(u16, u16, Option<&str>)> = published
        .iter()
        .filter(|p| p.tcp)
        .filter_map(|p| Some((p.container, p.host?, p.host_ip)))
        .collect();
    bindings.sort_by_key(|&(container, _, _)| {
        listen
            .ports()
            .position(|port| port == container)
            .unwrap_or(usize::MAX)
    });
    let mut endpoints: Vec<String> = Vec::new();
    for (_, host_port, host_ip) in bindings {
        let endpoint = llamacpp_endpoint(host_ip, host_port);
        if !endpoints.contains(&endpoint) {
            endpoints.push(endpoint);
        }
    }
    if !endpoints.is_empty() {
        return endpoints;
    }
    match network_mode {
        None => listening(),
        Some(mode) if mode.starts_with("container:") => listening(),
        Some(_) => Vec::new(),
    }
}

/// The command line a llama.cpp container's server was launched with: the
/// container's own command when it runs llama-server (the official images'
/// entrypoint is `/app/llama-server`), else the first llama-server among its
/// processes — a wrapper entrypoint's child (`/app/tools.sh --server`).
/// A router's children come after it, with the random ports it gave them.
/// Failing both, the container's command, for whatever it shows.
#[cfg(any(target_os = "linux", test))]
fn llamacpp_container_command<'a>(command: &'a str, processes: &'a [String]) -> &'a str {
    if runs_engine(command, &EngineType::LlamaCpp) {
        return command;
    }
    processes
        .iter()
        .find(|process| runs_engine(process, &EngineType::LlamaCpp))
        .map_or(command, String::as_str)
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
    engines_from_processes(&processes, process_env_var)
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
/// A server's own processes are never engines, whatever matcher would claim
/// them: every descendant of a server whose engine type runs servers of its
/// own (`owns_its_descendants`) is left out before any matcher sees it.
/// Their PIDs belong to that server's engine instead, with every other
/// candidate's descendants: the GPU sees a server's children, not the
/// server.
///
/// `env_of` reads a variable of a process's environment, which decides
/// where Ollama and llama.cpp servers listen and, for llama.cpp, the model:
/// unset, or an environment that cannot be read, leaves the default.
fn engines_from_processes(
    processes: &[HostProcess<'_>],
    env_of: impl Fn(u32, &str) -> std::io::Result<Option<String>>,
) -> Vec<DetectedEngine> {
    let tree: Vec<(u32, Option<u32>)> = processes
        .iter()
        .map(|&(pid, parent, _)| (pid, parent))
        .collect();
    let engines: Vec<Option<EngineType>> = processes
        .iter()
        .map(|(_, _, cmd)| engine_of_process(cmd))
        .collect();
    let owners: HashSet<u32> = processes
        .iter()
        .zip(&engines)
        .filter(|(_, engine)| engine.as_ref().is_some_and(owns_its_descendants))
        .map(|(&(pid, _, _), _)| pid)
        .collect();
    let owners_children: Vec<u32> = processes
        .iter()
        .filter(|(_, parent, _)| parent.is_some_and(|parent| owners.contains(&parent)))
        .map(|&(pid, _, _)| pid)
        .collect();
    let owned: HashSet<u32> = expand_pid_tree(&owners_children, &tree)
        .into_iter()
        .collect();

    let mut detected: Vec<DetectedEngine> = Vec::new();
    let mut seen_endpoints: HashMap<(EngineType, String), usize> = HashMap::new();
    for (&(pid, _, cmd), engine_type) in processes.iter().zip(engines) {
        if owned.contains(&pid) {
            continue;
        }
        let Some(engine_type) = engine_type else {
            continue;
        };
        let (endpoint, fallback_endpoints, served_model) = match engine_type {
            EngineType::Ollama => {
                let value = env_of(pid, "OLLAMA_HOST");
                if value.is_err() {
                    note_unreadable_ollama_host(pid);
                }
                let host = OllamaHost::from_env(value.ok().flatten().as_deref());
                tracing::debug!(
                    "ollama serve (pid {pid}) binds {}; probing {}",
                    host.url(),
                    host.endpoint()
                );
                // Ollama loads models on demand; none is named at launch.
                (host.endpoint(), Vec::new(), None)
            }
            EngineType::LlamaCpp => {
                let args: Vec<_> = cmd.iter().map(|arg| arg.to_string_lossy()).collect();
                let launch = llamacpp_launch(&args, |name| env_of(pid, name).ok().flatten());
                let Some(listen) = launch.listen(llamacpp::default_ports(&DeploymentMode::Native))
                else {
                    tracing::debug!(
                        "llama-server (pid {pid}) listens on no TCP port its launch names \
                         (a Unix socket, or --port 0); not an endpoint"
                    );
                    continue;
                };
                let (endpoint, fallback_endpoints) = listen.endpoints();
                (endpoint, fallback_endpoints, launch.served_model())
            }
            EngineType::Vllm | EngineType::Sglang | EngineType::Tensorfold => {
                let default_endpoint = format!("http://localhost:{}", default_port(&engine_type));
                let endpoint =
                    parse_endpoint_from_args(cmd, &default_endpoint).unwrap_or(default_endpoint);
                let served_model = match engine_type {
                    EngineType::Vllm => parse_model_from_args(cmd),
                    EngineType::Sglang => parse_sglang_model_from_args(cmd),
                    // TensorFold: `--name` on its `serve` launch.
                    _ => parse_tensorfold_model_from_args(cmd),
                };
                (endpoint, Vec::new(), served_model)
            }
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
                    fallback_endpoints,
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

/// Whether an engine type's server runs servers of its own, which are its
/// and never engines themselves:
///
/// - Ollama starts a runner per loaded model — `ollama runner ...` up to
///   v0.19 and for MLX models, `llama-server ...` from v0.35 — serving
///   Ollama on a random loopback port, an interface Ollama does not promise.
///   llama.cpp's engine type recognizes that `llama-server`, so it is left
///   out by its ancestry.
/// - A llama.cpp router (started with no model) spawns one child per model
///   it loads: an ordinary-looking `llama-server --host 127.0.0.1 --port
///   <random> --alias <id> --model <path>`, whose environment carries
///   `LLAMA_SERVER_ROUTER_PORT`. The router is the engine.
fn owns_its_descendants(engine_type: &EngineType) -> bool {
    matches!(engine_type, EngineType::Ollama | EngineType::LlamaCpp)
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
/// as `ollama`, a container's llama-server as root, while the dashboard
/// does not.
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

/// Parse the served model from a TensorFold launch command line:
/// `tensorfold-native serve MODEL --name NAME` serves it under `--name`, and
/// that is the id `/v1/models` reports. The `MODEL` positional names the
/// weights on disk, not the served id, so it is not used as a hint.
fn parse_tensorfold_model_from_args(args: &[OsString]) -> Option<String> {
    let args: Vec<String> = args
        .iter()
        .filter_map(|a| a.to_str().map(String::from))
        .collect();
    parse_tensorfold_model_parts(&args)
}

/// Shared by the OsString and pre-joined-string forms.
fn parse_tensorfold_model_parts<S: AsRef<str>>(args: &[S]) -> Option<String> {
    let flags = ["--name"];
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
    None
}

/// Pre-joined-command-string form of [`parse_tensorfold_model_from_args`]
/// (Docker `container.command` and `docker top` rows).
#[cfg(any(target_os = "linux", test))]
fn parse_tensorfold_model_from_command_str(cmd: &str) -> Option<String> {
    parse_tensorfold_model_parts(&cmd.split_whitespace().collect::<Vec<_>>())
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

        // Where the host reaches the container: its published ports and its
        // network mode. Ollama and llama.cpp read where they listen inside
        // it from the container's environment (`docker inspect`'s
        // Config.Env, the image's merged with the run's): its server runs as
        // root, so the host cannot read that process's environment.
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
        let env = match engine_type {
            EngineType::Ollama | EngineType::LlamaCpp => container_env(&docker, container_id).await,
            EngineType::Vllm | EngineType::Sglang | EngineType::Tensorfold => Vec::new(),
        };
        let env_var = |name: &str| env_var_in(env.iter().map(|e| e.as_bytes()), name);

        let (endpoint, fallback_endpoints, served_model) = if engine_type == EngineType::Ollama {
            // Ollama listens where the container's OLLAMA_HOST says — the
            // image sets 0.0.0.0:11434 — and names no model at launch. Its
            // process list holds each loaded model's runner, `--port` and
            // all, which is not where Ollama serves, so no port is read off
            // it.
            let listen = OllamaHost::from_env(env_var("OLLAMA_HOST").as_deref());
            match ollama_container_endpoint(&listen, network_mode, &published) {
                Some(endpoint) => (endpoint, Vec::new(), None),
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
        } else if engine_type == EngineType::LlamaCpp {
            // llama-server listens where its command line says, else its
            // LLAMA_ARG_* environment — the official images set
            // LLAMA_ARG_PORT=8080 and LLAMA_ARG_HOST=0.0.0.0 — else on
            // llama.cpp's own defaults for a container. A router's children
            // in its process list carry the random ports it gave them, which
            // is not where it serves.
            let launch_command = llamacpp_container_command(
                container.command.as_deref().unwrap_or_default(),
                &commands,
            );
            let args: Vec<&str> = launch_command.split_whitespace().collect();
            let launch = llamacpp_launch(&args, env_var);
            let Some(listen) = launch.listen(llamacpp::default_ports(&DeploymentMode::Docker))
            else {
                tracing::debug!(
                    "llama.cpp container (image={}) listens on no TCP port its launch names \
                     (a Unix socket, or --port 0); skipping",
                    container.image.as_deref().unwrap_or("?"),
                );
                continue;
            };
            let mut endpoints =
                llamacpp_container_endpoints(&listen, network_mode, &published).into_iter();
            let Some(endpoint) = endpoints.next() else {
                tracing::debug!(
                    "llama.cpp container (image={}) is not on the host network and publishes \
                     no port for {:?}; unreachable from the host. Publish the port, or \
                     configure it with --engine llamacpp --engine-url <url>.",
                    container.image.as_deref().unwrap_or("?"),
                    listen.ports().collect::<Vec<_>>(),
                );
                continue;
            };
            (endpoint, endpoints.collect(), launch.served_model())
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
            (endpoint, Vec::new(), served_model)
        };
        tracing::debug!(
            "Docker engine candidate: image={}, endpoint={}, then {:?}, model={:?}",
            container.image.as_deref().unwrap_or("?"),
            endpoint,
            fallback_endpoints,
            served_model,
        );
        detected.push(DetectedEngine {
            engine_type,
            endpoint,
            deployment_mode: DeploymentMode::Docker,
            served_model,
            pids,
            container_id: container.id.clone(),
            fallback_endpoints,
        });
    }

    detected
}

/// A container's environment as `docker inspect` reports it (Config.Env:
/// the image's variables merged with the run's), or none when it cannot be
/// inspected.
#[cfg(target_os = "linux")]
async fn container_env(docker: &bollard::Docker, container_id: &str) -> Vec<String> {
    if container_id.is_empty() {
        return Vec::new();
    }
    match docker.inspect_container(container_id, None).await {
        Ok(info) => info.config.and_then(|c| c.env).unwrap_or_default(),
        Err(e) => {
            tracing::debug!("docker inspect failed for {}: {}", container_id, e);
            Vec::new()
        }
    }
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
        // By its `Server: TensorFold` header and the health JSON only it
        // answers (`tensorfold::identify`).
        EngineType::Tensorfold => super::tensorfold::identify(http).await,
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
            fallback_endpoints: Vec::new(),
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

    /// A variable of a process's environment, as `env` reads it: unset, set,
    /// or unreadable.
    type EnvRead = std::io::Result<Option<String>>;

    /// The process scan over `(pid, parent, argv)` rows, with each process's
    /// environment variables read by `env`.
    fn scan_argvs(
        rows: &[(u32, Option<u32>, Vec<OsString>)],
        env: impl Fn(u32, &str) -> EnvRead,
    ) -> Vec<DetectedEngine> {
        let processes: Vec<HostProcess<'_>> = rows
            .iter()
            .map(|(pid, parent, cmd)| (*pid, *parent, cmd.as_slice()))
            .collect();
        engines_from_processes(&processes, env)
    }

    /// The process scan over `(pid, parent, command line)` rows, with each
    /// process's environment variables read by `env`.
    fn scan_with(
        rows: &[(u32, Option<u32>, &str)],
        env: impl Fn(u32, &str) -> EnvRead,
    ) -> Vec<DetectedEngine> {
        let rows: Vec<_> = rows
            .iter()
            .map(|&(pid, parent, line)| (pid, parent, argv(line)))
            .collect();
        scan_argvs(&rows, env)
    }

    /// An environment that cannot be read — the dashboard running as another
    /// user than the engine.
    fn unreadable(_pid: u32, _name: &str) -> EnvRead {
        Err(std::io::ErrorKind::PermissionDenied.into())
    }

    /// The process scan where no environment can be read.
    fn scan(rows: &[(u32, Option<u32>, &str)]) -> Vec<DetectedEngine> {
        scan_with(rows, unreadable)
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

    /// A `/proc/<pid>/cmdline` fixture as sysinfo reads it: one argument per
    /// NUL-terminated piece.
    fn cmdline(bytes: &[u8]) -> Vec<OsString> {
        bytes
            .strip_suffix(b"\0")
            .unwrap_or(bytes)
            .split(|&b| b == 0)
            .map(|arg| OsString::from(String::from_utf8_lossy(arg).into_owned()))
            .collect()
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
    /// substring of it), not a program that is merely named like it. (A
    /// `llama-server` is llama.cpp's, which is why Ollama's own are kept out
    /// by their ancestry.)
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
            assert_ne!(
                engine_of_process(&argv(line)),
                Some(EngineType::Ollama),
                "{line}"
            );
            assert!(!runs_engine(line, &EngineType::Ollama), "{line}");
        }
        assert_eq!(
            engine_of_process(&cmdline(include_bytes!(
                "fixtures/ollama_proc_runner.cmdline"
            ))),
            None
        );
    }

    /// A native server is probed where its `OLLAMA_HOST` says it listens, and
    /// on Ollama's default when the variable is unset or the environment
    /// cannot be read (Ollama runs as `ollama`, the dashboard does not).
    #[test]
    fn a_native_ollama_is_probed_where_its_ollama_host_says() {
        let endpoint = |env: EnvRead| {
            let env = std::sync::Mutex::new(Some(env));
            let detected = scan_with(
                &[(100, Some(1), "/usr/local/bin/ollama serve")],
                |pid, name| {
                    assert_eq!((pid, name), (100, "OLLAMA_HOST"));
                    env.lock().unwrap().take().expect("read once")
                },
            );
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
    /// is Ollama's and not an engine of its own: the `llama-server` child
    /// each GGUF model runs in from v0.35 (as its source builds the command
    /// line), which llama.cpp's engine type recognizes; 0.19.0's `ollama
    /// runner` child (verbatim from the Spark), which no type does; and
    /// anything further down. The same `llama-server` outside Ollama is an
    /// engine.
    #[test]
    fn a_process_ollama_started_is_never_an_engine_of_its_own() {
        let runner = cmdline(include_bytes!("fixtures/ollama_proc_runner.cmdline"));
        let detected = scan_argvs(
            &[
                (100, Some(1), argv("/usr/local/bin/ollama serve")),
                (101, Some(100), runner),
                (102, Some(100), argv(LLAMA_SERVER)),
                (
                    103,
                    Some(102),
                    argv("python3 -m sglang.launch_server --port 46000"),
                ),
                (104, Some(100), argv("vllm serve /models/x --port 45999")),
                (
                    200,
                    Some(1),
                    argv("/opt/llama.cpp/llama-server -m /models/x.gguf --port 8001"),
                ),
            ],
            unreadable,
        );
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
                    vec![100, 101, 102, 103, 104]
                ),
                (EngineType::LlamaCpp, "http://localhost:8001", vec![200]),
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
            |pid, _| Ok((pid == 200).then(|| "127.0.0.1:11500".to_string())),
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

    // -----------------------------------------------------------------------
    // TensorFold
    // -----------------------------------------------------------------------

    /// The endpoint and key the probe is called with.
    fn tensorfold_http(url: &str, key: Option<&str>) -> EngineHttp {
        EngineHttp::new(
            reqwest::Client::new(),
            url.to_string(),
            key.map(str::to_string),
        )
    }

    /// TensorFold's server is `tensorfold-native` (and Homebrew's
    /// `tensorfold`), whichever path it was started from. Only the program
    /// counts: a log file, a proxy or a tmux session named after it serves
    /// nothing. The python module launch is the one documented exception.
    #[test]
    fn tensorfold_servers_are_recognized_and_mentions_are_not() {
        for line in [
            "tensorfold-native serve /models/x.gguf --name x",
            "/opt/tensorfold/tensorfold-native serve /models/x.gguf --name x --port 8090",
            "/usr/local/bin/tensorfold serve /models/x.gguf --name x",
            "./tensorfold.exe serve C:\\models\\x.gguf",
            "python3 -m tensorfold.cli serve /models/x.gguf --name x",
        ] {
            assert_eq!(
                engine_of_process(&argv(line)),
                Some(EngineType::Tensorfold),
                "{line}"
            );
            assert!(runs_engine(line, &EngineType::Tensorfold), "{line}");
        }
        for line in [
            "tail -f /var/log/tensorfold.log",
            "journalctl -fu tensorfold-native",
            "tmux new -s tensorfold",
            "pgrep -f tensorfold-native",
            "/opt/my-tensorfold-proxy --port 8080",
            "my-tensorfold --port 8080",
            "sleep infinity",
        ] {
            assert_eq!(engine_of_process(&argv(line)), None, "{line}");
            assert!(!runs_engine(line, &EngineType::Tensorfold), "{line}");
        }

        // A python module that *mentions* tensorfold. in a flag value is not
        // TensorFold: the engine its module names must still be found, or the
        // probe drops a real vLLM/SGLang and the engine disappears.
        assert_eq!(
            engine_of_process(&argv(
                "python3 -m vllm.entrypoints.openai.api_server --served-model-name tensorfold.v1"
            )),
            Some(EngineType::Vllm),
            "a served-model-name containing tensorfold. stays vLLM"
        );
        assert_eq!(
            engine_of_process(&argv(
                "python3 -m sglang.launch_server --download-dir /data/tensorfold.models"
            )),
            Some(EngineType::Sglang),
            "a download dir containing tensorfold. stays SGLang"
        );
        // The module token itself is what decides, so the bare module and a
        // submodule both identify TensorFold.
        for line in [
            "python3 -m tensorfold serve /models/x.gguf --name x",
            "python3 -m tensorfold.cli serve /models/x.gguf --name x",
        ] {
            assert_eq!(
                engine_of_process(&argv(line)),
                Some(EngineType::Tensorfold),
                "{line}"
            );
        }
    }

    /// A native launch is probed where `--host` and `--port` say — in both
    /// flag forms — and named by the `--name` it serves under. With neither,
    /// TensorFold's own default, 8080.
    #[test]
    fn a_tensorfold_launch_is_probed_where_it_listens_and_named_by_its_name() {
        let detected = scan(&[(
            10,
            Some(1),
            "tensorfold-native serve /models/x.gguf --name qwen-small --host 0.0.0.0 --port 8090",
        )]);
        assert_eq!(detected.len(), 1);
        assert_eq!(detected[0].engine_type, EngineType::Tensorfold);
        assert_eq!(detected[0].endpoint, "http://localhost:8090");
        assert_eq!(detected[0].served_model.as_deref(), Some("qwen-small"));
        assert!(detected[0].fallback_endpoints.is_empty());

        let equal_form = scan(&[(
            11,
            Some(1),
            "tensorfold-native serve /models/x.gguf --name=qwen-small --host=127.0.0.1 --port=8091",
        )]);
        assert_eq!(equal_form.len(), 1);
        assert_eq!(equal_form[0].endpoint, "http://127.0.0.1:8091");
        assert_eq!(equal_form[0].served_model.as_deref(), Some("qwen-small"));

        // No flags: the engine's default listen address.
        let default = scan(&[(
            12,
            Some(1),
            "/usr/local/bin/tensorfold serve /models/x.gguf --name qwen-small",
        )]);
        assert_eq!(default.len(), 1);
        assert_eq!(default[0].endpoint, "http://localhost:8080");
        assert_eq!(default[0].served_model.as_deref(), Some("qwen-small"));
        assert_eq!(default_port(&EngineType::Tensorfold), 8080);
    }

    /// The model hint is `--name` in the host and the docker command-string
    /// forms; the positional model path names a file, not the served id.
    #[test]
    fn tensorfold_model_parse_reads_name_flag_only() {
        assert_eq!(
            parse_model_for(
                &EngineType::Tensorfold,
                "tensorfold-native serve /models/x.gguf --name qwen-small --port 8090",
            )
            .as_deref(),
            Some("qwen-small")
        );
        assert_eq!(
            parse_model_for(
                &EngineType::Tensorfold,
                "tensorfold-native serve /models/x.gguf --name=qwen-small",
            )
            .as_deref(),
            Some("qwen-small")
        );
        // The positional is only a path; without `--name` there is no hint.
        assert_eq!(
            parse_model_for(
                &EngineType::Tensorfold,
                "tensorfold-native serve /models/x.gguf",
            ),
            None
        );
        assert_eq!(
            parse_tensorfold_model_parts(&["serve", "--name", "--port", "8080"]),
            None,
            "a flag value is not a model name"
        );
    }

    /// The docker signals: an image repository naming tensorfold (any
    /// registry, tag or digest) is a strong claim by itself, a command running
    /// `tensorfold-native` is too, and a name only is not — it must be
    /// confirmed by the container's processes, like the other engines' weak
    /// signal.
    #[test]
    fn a_tensorfold_container_is_classified_by_image_command_then_name() {
        for image in [
            "ghcr.io/ashhart/tensorfold:1.1.3",
            "tensorfold/tensorfold:latest",
            "registry.local:5000/tensorfold@sha256:abc",
        ] {
            assert_eq!(
                classify_container(&strings(&["tf-lane"]), image, "sleep infinity",),
                Some(ContainerClass {
                    engine_type: EngineType::Tensorfold,
                    strong_signal: true,
                }),
                "{image}"
            );
        }
        // The image beats the command: a wrapper mentioning vllm does not
        // make an image that is TensorFold's anything else.
        assert_eq!(
            classify_container(
                strings(&[]).as_slice(),
                "ghcr.io/ashhart/tensorfold:1.1.3",
                "/bin/sh -c 'exec vllm serve'"
            ),
            Some(ContainerClass {
                engine_type: EngineType::Tensorfold,
                strong_signal: true,
            })
        );
        // The command's launch form.
        assert_eq!(
            classify_container(
                strings(&[]).as_slice(),
                "my/inference:1",
                "/app/tensorfold-native serve /models/x.gguf --name x",
            ),
            Some(ContainerClass {
                engine_type: EngineType::Tensorfold,
                strong_signal: true,
            })
        );
        // A name alone is weak, like every engine's.
        assert_eq!(
            classify_container(
                strings(&["tensorfold-lane"]).as_slice(),
                "my/inference:1",
                "sleep infinity"
            ),
            Some(ContainerClass {
                engine_type: EngineType::Tensorfold,
                strong_signal: false,
            })
        );
        assert_eq!(
            classify_container(
                strings(&["proxy"]).as_slice(),
                "my/inference:1",
                "sleep infinity"
            ),
            None
        );
    }

    /// The identify arm: only TensorFold's own answers are accepted. A vLLM
    /// shaped empty 200 `/health`, SGLang's 200 ready body, llama.cpp's
    /// status-only JSON and Ollama's missing route all stay out.
    #[tokio::test]
    async fn the_tensorfold_probe_accepts_only_tensorfold() {
        use super::super::test_server::{Headers, Request, TestServer};

        let tensorfold = |status: u16, body: &'static str, headers: Headers| async move {
            TestServer::start_with_headers(move |_: &Request| {
                (status, body.to_string(), headers.clone())
            })
            .await
        };

        let named = tensorfold(200, "", vec![("Server", "TensorFold/1.1.3".to_string())]).await;
        assert!(probe_engine(&tensorfold_http(&named.url, None), &EngineType::Tensorfold).await);

        let body = tensorfold(
            200,
            r#"{"status":"ok","model":"m","model_ids":["m"],"warming":false}"#,
            vec![("Server", "uvicorn".to_string())],
        )
        .await;
        assert!(probe_engine(&tensorfold_http(&body.url, None), &EngineType::Tensorfold).await);

        let rejected = [
            (200, "", vec![("Server", "uvicorn".to_string())]),
            (200, "OK", vec![("Server", "uvicorn".to_string())]),
            (
                200,
                r#"{"status":"ok"}"#,
                vec![("Server", "llama.cpp".to_string())],
            ),
            (404, "Not Found", vec![("Server", "uvicorn".to_string())]),
        ];
        for (status, body, headers) in rejected {
            let server = tensorfold(status, body, headers.clone()).await;
            assert!(
                !probe_engine(&tensorfold_http(&server.url, None), &EngineType::Tensorfold).await,
                "{status} {body:?} {headers:?}"
            );
        }
    }

    // -----------------------------------------------------------------------
    // llama.cpp
    // -----------------------------------------------------------------------

    /// The models the capture served, by their absolute paths on the Spark.
    const M15: &str = "/home/niklas/llamacpp-capture/models/qwen2.5-1.5b-instruct-q4_k_m.gguf";
    const M05: &str = "/home/niklas/llamacpp-capture/models/qwen2.5-0.5b-instruct-q4_k_m.gguf";
    /// The same 0.5B model mounted into the captured containers.
    const IN_CONTAINER: &str = "/models/qwen2.5-0.5b-instruct-q4_k_m.gguf";

    /// Every `llama-server` command line the capture recorded, verbatim
    /// from `/proc/<pid>/cmdline` (llama.cpp v0.7.0, build b11669, on the
    /// Spark): natively, as a router and its child, and the containers' as
    /// the host sees them.
    const LLAMACPP_CMDLINES: [(&str, &[u8]); 13] = [
        (
            "m_port_metrics",
            include_bytes!("fixtures/llamacpp_proc_m_port_metrics.cmdline"),
        ),
        (
            "model_host_port",
            include_bytes!("fixtures/llamacpp_proc_model_host_port.cmdline"),
        ),
        (
            "api_key",
            include_bytes!("fixtures/llamacpp_proc_api_key.cmdline"),
        ),
        (
            "api_key_file",
            include_bytes!("fixtures/llamacpp_proc_api_key_file.cmdline"),
        ),
        (
            "hf_alias",
            include_bytes!("fixtures/llamacpp_proc_hf_alias.cmdline"),
        ),
        ("env", include_bytes!("fixtures/llamacpp_proc_env.cmdline")),
        (
            "spec_draft",
            include_bytes!("fixtures/llamacpp_proc_spec_draft.cmdline"),
        ),
        (
            "sleep_idle",
            include_bytes!("fixtures/llamacpp_proc_sleep_idle.cmdline"),
        ),
        (
            "router",
            include_bytes!("fixtures/llamacpp_proc_router.cmdline"),
        ),
        (
            "router_child",
            include_bytes!("fixtures/llamacpp_proc_router_child.cmdline"),
        ),
        (
            "docker_published",
            include_bytes!("fixtures/llamacpp_proc_docker_published.cmdline"),
        ),
        (
            "docker_host",
            include_bytes!("fixtures/llamacpp_proc_docker_host.cmdline"),
        ),
        (
            "docker_env",
            include_bytes!("fixtures/llamacpp_proc_docker_env.cmdline"),
        ),
    ];

    fn llamacpp_cmdline(name: &str) -> Vec<OsString> {
        let (_, bytes) = LLAMACPP_CMDLINES
            .iter()
            .find(|(fixture, _)| *fixture == name)
            .expect("a captured command line");
        cmdline(bytes)
    }

    /// An environment read from a `/proc/<pid>/environ` fixture.
    fn environ(bytes: &'static [u8]) -> impl Fn(u32, &str) -> EnvRead {
        move |_: u32, name: &str| Ok(env_var_in(bytes.split(|&b| b == 0), name))
    }

    /// Every endpoint a candidate is to be probed on, in order.
    fn endpoints_of(engine: &DetectedEngine) -> Vec<String> {
        std::iter::once(engine.endpoint.clone())
            .chain(engine.fallback_endpoints.iter().cloned())
            .collect()
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    /// llama-server by its binary, whichever path it was started from.
    #[test]
    fn every_captured_llama_server_is_llamacpp() {
        for (name, bytes) in LLAMACPP_CMDLINES {
            assert_eq!(
                engine_of_process(&cmdline(bytes)),
                Some(EngineType::LlamaCpp),
                "{name}"
            );
        }
        for line in [
            "llama-server -m /models/x.gguf",
            "/app/llama-server -m /models/x.gguf --metrics",
            "./llama-server --port 8000",
        ] {
            assert!(runs_engine(line, &EngineType::LlamaCpp), "{line}");
        }
    }

    /// Only the program counts. A process that names llama-server among its
    /// arguments serves nothing — and since a llama-server's descendants
    /// are its own, a tmux session named after it would otherwise hide the
    /// server started inside it.
    #[test]
    fn a_process_that_merely_mentions_llama_server_is_not_a_server() {
        for line in [
            "tail -f /var/log/llama-server.log",
            "journalctl -fu llama-server",
            "tmux new -s llama-server",
            "pgrep -f /opt/llama.cpp/llama-server",
            "/opt/llama-server.sh --port 8080",
            "/usr/local/bin/llama-server-proxy --port 8080",
            "my-llama-server --port 8080",
            "/app/model-runner",
        ] {
            assert_eq!(engine_of_process(&argv(line)), None, "{line}");
            assert!(!runs_engine(line, &EngineType::LlamaCpp), "{line}");
        }

        let detected = scan(&[
            (10, Some(1), "tmux new -s llama-server"),
            (11, Some(10), "-bash"),
            (
                12,
                Some(11),
                "/opt/llama.cpp/llama-server -m /models/x.gguf --port 18080",
            ),
        ]);
        assert_eq!(detected.len(), 1);
        assert_eq!(detected[0].endpoint, "http://localhost:18080");
        assert_eq!(detected[0].pids, vec![12]);
    }

    /// Each captured launch, as the native scan reads it: the endpoint from
    /// `--host`/`--port`, else its environment, else the default ports in
    /// the order a native server is tried on (9931 from v0.7.0, 8080
    /// before); and the model by the name llama-server serves it under.
    /// The containers' processes are read here as the host sees them — their
    /// environment is root's, unreadable — which the container's own
    /// engine then absorbs.
    #[test]
    fn each_captured_launch_is_probed_where_it_listens_and_named_by_what_it_serves() {
        let defaults = ["http://localhost:9931", "http://localhost:8080"];
        let env_launch = environ(include_bytes!("fixtures/llamacpp_proc_env.environ"));
        type Env = Box<dyn Fn(u32, &str) -> EnvRead>;
        let cases: Vec<(&str, Env, Vec<&str>, Option<&str>)> = vec![
            (
                "m_port_metrics",
                Box::new(unreadable),
                vec!["http://localhost:18080"],
                Some(M15),
            ),
            (
                "model_host_port",
                Box::new(unreadable),
                vec!["http://127.0.0.1:18081"],
                Some(M05),
            ),
            (
                "api_key",
                Box::new(unreadable),
                vec!["http://localhost:18082"],
                Some(M05),
            ),
            (
                "api_key_file",
                Box::new(unreadable),
                vec!["http://localhost:18083"],
                Some(M05),
            ),
            (
                "hf_alias",
                Box::new(unreadable),
                vec!["http://127.0.0.1:18084"],
                Some("qwen-small"),
            ),
            (
                "env",
                Box::new(env_launch),
                vec!["http://localhost:18085"],
                Some("env-alias"),
            ),
            ("env", Box::new(unreadable), defaults.to_vec(), None),
            (
                "spec_draft",
                Box::new(unreadable),
                vec!["http://localhost:18086"],
                Some(M15),
            ),
            (
                "sleep_idle",
                Box::new(unreadable),
                vec!["http://localhost:18089"],
                Some(M05),
            ),
            (
                "router",
                Box::new(unreadable),
                vec!["http://localhost:18088"],
                None,
            ),
            (
                "router_child",
                Box::new(unreadable),
                vec!["http://127.0.0.1:52649"],
                Some("qwen2.5-0.5b-instruct-q4_k_m"),
            ),
            (
                "docker_host",
                Box::new(unreadable),
                vec!["http://localhost:18091"],
                Some(IN_CONTAINER),
            ),
            (
                "docker_published",
                Box::new(unreadable),
                defaults.to_vec(),
                Some(IN_CONTAINER),
            ),
            ("docker_env", Box::new(unreadable), defaults.to_vec(), None),
        ];
        for (name, env, endpoints, model) in cases {
            let detected = scan_argvs(&[(42, Some(1), llamacpp_cmdline(name))], env);
            assert_eq!(detected.len(), 1, "{name}");
            let engine = &detected[0];
            assert_eq!(engine.engine_type, EngineType::LlamaCpp, "{name}");
            assert_eq!(engine.deployment_mode, DeploymentMode::Native, "{name}");
            assert_eq!(endpoints_of(engine), strings(&endpoints), "{name}");
            assert_eq!(engine.served_model.as_deref(), model, "{name}");
            assert_eq!(engine.pids, vec![42], "{name}");
        }
    }

    /// Each setting comes from its flag, else its `LLAMA_ARG_*` variable,
    /// else llama-server's default — as llama-server applies them: the
    /// environment first, the command line over it, a repeated flag's last
    /// value, `_` for `-` in a long flag.
    #[test]
    fn launch_settings_take_the_flag_then_the_environment_then_the_default() {
        let env = |vars: &'static [(&'static str, &'static str)]| {
            move |name: &str| {
                vars.iter()
                    .find(|(var, _)| *var == name)
                    .map(|(_, value)| value.to_string())
            }
        };
        let listen = |args: &[&str], vars: &'static [(&'static str, &'static str)]| {
            let launch = llamacpp_launch(args, env(vars));
            launch.listen(llamacpp::NATIVE_DEFAULT_PORTS).map(|listen| {
                let (endpoint, fallbacks) = listen.endpoints();
                std::iter::once(endpoint)
                    .chain(fallbacks)
                    .collect::<Vec<_>>()
            })
        };
        let one = |endpoint: &str| Some(vec![endpoint.to_string()]);

        assert_eq!(
            listen(&["llama-server"], &[("LLAMA_ARG_PORT", "18085")]),
            one("http://localhost:18085")
        );
        assert_eq!(
            listen(
                &["llama-server", "--port", "18091"],
                &[("LLAMA_ARG_PORT", "8080"), ("LLAMA_ARG_HOST", "0.0.0.0")]
            ),
            one("http://localhost:18091")
        );
        assert_eq!(
            listen(
                &["llama-server", "--host", "127.0.0.1"],
                &[("LLAMA_ARG_HOST", "0.0.0.0"), ("LLAMA_ARG_PORT", "18092")]
            ),
            one("http://127.0.0.1:18092")
        );
        assert_eq!(
            listen(&["llama-server", "--port=18093", "--host=10.0.0.5"], &[]),
            one("http://10.0.0.5:18093")
        );
        assert_eq!(
            listen(&["llama-server", "--port", "18080", "--port", "18081"], &[]),
            one("http://localhost:18081")
        );
        assert_eq!(
            listen(
                &["llama-server", "--host", "0.0.0.0", "--port", "8081"],
                &[]
            ),
            one("http://localhost:8081")
        );
        // An empty variable or a port that is not one says nothing.
        assert_eq!(
            listen(&["llama-server"], &[("LLAMA_ARG_PORT", "")]),
            Some(strings(&["http://localhost:9931", "http://localhost:8080"]))
        );
        assert_eq!(
            listen(&["llama-server", "--port", "auto"], &[]),
            Some(strings(&["http://localhost:9931", "http://localhost:8080"]))
        );
        assert_eq!(
            llamacpp_launch(&["llama-server", "--hf_repo", "ggml-org/x-GGUF"], |_| None)
                .served_model()
                .as_deref(),
            Some("ggml-org/x-GGUF")
        );
    }

    /// The model hint is what `/models` would call the model: the alias
    /// that sorts first (llama-server keeps its aliases in a sorted set),
    /// else the Hugging Face repository, else the Docker one, else the
    /// model path — each setting from its flag, else its variable.
    #[test]
    fn the_served_model_is_the_name_llama_server_serves_it_under() {
        let model = |args: &[&str], vars: &[(&str, &str)]| {
            llamacpp_launch(args, |name| {
                vars.iter()
                    .find(|(var, _)| *var == name)
                    .map(|(_, value)| value.to_string())
            })
            .served_model()
        };
        let named = |name: &str| Some(name.to_string());

        assert_eq!(
            model(&["llama-server", "-a", "qwen-tiny,qwen-small"], &[]),
            named("qwen-small")
        );
        assert_eq!(
            model(&["llama-server", "--alias", " , x "], &[]),
            named("x")
        );
        assert_eq!(
            model(
                &["llama-server", "-m", "/m.gguf", "-hf", "org/repo:Q4_K_M"],
                &[]
            ),
            named("org/repo:Q4_K_M")
        );
        assert_eq!(
            model(&["llama-server", "-m", "/m.gguf", "-dr", "gemma3"], &[]),
            named("gemma3")
        );
        assert_eq!(
            model(&["llama-server", "-dr", "gemma3", "-hfr", "org/repo"], &[]),
            named("org/repo")
        );
        assert_eq!(
            model(
                &["llama-server", "-m", "/m.gguf"],
                &[("LLAMA_ARG_ALIAS", "env-alias")]
            ),
            named("env-alias")
        );
        assert_eq!(
            model(
                &["llama-server", "-hf", "org/repo"],
                &[("LLAMA_ARG_MODEL", "/m.gguf")]
            ),
            named("org/repo")
        );
        assert_eq!(
            model(&["llama-server"], &[("LLAMA_ARG_HF_REPO", "org/repo")]),
            named("org/repo")
        );
        // A draft model is not the model; a router serves none of its own.
        assert_eq!(model(&["llama-server", "-md", "/draft.gguf"], &[]), None);
        assert_eq!(
            model(&["llama-server", "--models-dir", "/models"], &[]),
            None
        );
    }

    /// A llama-server bound only to a Unix socket — docker-model-runner's
    /// child, `--host <path>.sock` — has no TCP endpoint, nor has one on
    /// `--port 0`; neither is a candidate. Of several addresses, the first
    /// TCP one is probed.
    #[test]
    fn a_llama_server_without_a_tcp_port_it_names_is_no_endpoint() {
        let model_runner_child = "/app/llama-server -ngl 999 --metrics --model /models/x.gguf --host /var/run/docker-model-runner/inference-llama.cpp-0.sock --ctx-size 4096";
        assert!(scan(&[
            (300, Some(1), "/app/model-runner"),
            (301, Some(300), model_runner_child),
        ])
        .is_empty());
        assert!(
            scan_with(&[(1, None, "/app/llama-server -m /m.gguf")], |_, name| {
                Ok((name == "LLAMA_ARG_HOST").then(|| "/tmp/llama.sock".to_string()))
            })
            .is_empty()
        );
        assert!(scan(&[(1, None, "llama-server -m /m.gguf --port 0")]).is_empty());

        let endpoint = |line: &str| {
            scan(&[(1, None, line)])
                .first()
                .map(|engine| engine.endpoint.clone())
        };
        assert_eq!(
            endpoint("llama-server --host /tmp/a.sock,127.0.0.1 --port 8081").as_deref(),
            Some("http://127.0.0.1:8081")
        );
        assert_eq!(
            endpoint("llama-server --host ::1 --port 8081").as_deref(),
            Some("http://[::1]:8081")
        );
        assert_eq!(
            endpoint("llama-server --host :: --port 8081").as_deref(),
            Some("http://localhost:8081")
        );
    }

    /// A router (started with no model) is an engine; the child it spawns
    /// per model — an ordinary-looking `llama-server --port <random>`
    /// carrying `LLAMA_SERVER_ROUTER_PORT` — is not one of its own. The
    /// children's PIDs are the router's, so the GPU they run on is its.
    #[test]
    fn a_routers_children_are_never_engines_of_their_own() {
        let child_env = include_bytes!("fixtures/llamacpp_proc_router_child.environ");
        let detected = scan_argvs(
            &[
                (300, Some(1), llamacpp_cmdline("router")),
                (301, Some(300), llamacpp_cmdline("router_child")),
                (
                    302,
                    Some(300),
                    argv("/opt/llama-server --host 127.0.0.1 --port 41234 --alias other --model /m2.gguf"),
                ),
            ],
            |pid, name| match pid {
                301 => environ(child_env)(pid, name),
                _ => unreadable(pid, name),
            },
        );
        assert_eq!(detected.len(), 1);
        assert_eq!(detected[0].engine_type, EngineType::LlamaCpp);
        assert_eq!(
            endpoints_of(&detected[0]),
            strings(&["http://localhost:18088"])
        );
        assert_eq!(detected[0].served_model, None);
        assert_eq!(detected[0].pids, vec![300, 301, 302]);

        // A bare router names nothing at all — the binary, no argument — so
        // it is probed on the default ports, children and all.
        let bare = llamacpp_cmdline("env")[0].to_string_lossy().into_owned();
        let detected = scan(&[
            (400, Some(1), bare.as_str()),
            (
                401,
                Some(400),
                "/opt/llama-server --host 127.0.0.1 --port 50000 --model /m.gguf",
            ),
        ]);
        assert_eq!(detected.len(), 1);
        assert_eq!(
            endpoints_of(&detected[0]),
            strings(&["http://localhost:9931", "http://localhost:8080"])
        );
        assert_eq!(detected[0].pids, vec![400, 401]);
    }

    /// Image, then command, then name, as for the other engines: a
    /// repository named after llama.cpp (any spelling) or a command that
    /// runs llama-server is enough; a name must be confirmed by the
    /// container's processes. Ollama — "llama" is in its name, llama.cpp in
    /// its runners — and docker-model-runner, which serves its bundled
    /// llama-server on a Unix socket, are not llama.cpp containers.
    #[test]
    fn a_llamacpp_container_is_classified_by_image_command_then_name() {
        let llamacpp = |strong_signal| {
            Some(ContainerClass {
                engine_type: EngineType::LlamaCpp,
                strong_signal,
            })
        };
        assert_eq!(
            classify_container(
                &["/llamacpp-cap-pub".into()],
                "ghcr.io/ggml-org/llama.cpp:server-cuda13-b11669",
                "/app/llama-server -m /models/x.gguf --metrics"
            ),
            llamacpp(true)
        );
        for image in [
            "ghcr.io/ggml-org/llama.cpp:full",
            "local/llama-cpp:cuda",
            "myorg/llamacpp-server:1",
            "registry.local:5000/ggml/llama.cpp@sha256:0123abcd",
        ] {
            assert_eq!(
                classify_container(&[], image, "/app/tools.sh --server"),
                llamacpp(true),
                "{image}"
            );
        }
        assert_eq!(
            classify_container(
                &[],
                "myorg/inference:1",
                "/usr/local/bin/llama-server --port 9000"
            ),
            llamacpp(true)
        );
        for name in [
            "/llama-server",
            "/llamacpp-qwen",
            "/my-llama.cpp",
            "/Llama-CPP-box",
        ] {
            assert_eq!(
                classify_container(&[name.to_string()], "myorg/base", "sleep infinity"),
                llamacpp(false),
                "{name}"
            );
        }
        // A weak match is confirmed by the processes `docker top` lists.
        let server = to_row(&["4242", "/app/llama-server -m /models/x.gguf"]);
        assert!(runs_engine(
            &top_row_command(&server),
            &EngineType::LlamaCpp
        ));
        let idle = to_row(&["4243", "sleep infinity"]);
        assert!(!runs_engine(&top_row_command(&idle), &EngineType::LlamaCpp));

        let ollama = |strong_signal| {
            Some(ContainerClass {
                engine_type: EngineType::Ollama,
                strong_signal,
            })
        };
        assert_eq!(
            classify_container(
                &["/ollama".into()],
                "ollama/ollama:0.40.5",
                "/bin/ollama serve"
            ),
            ollama(true)
        );
        assert_eq!(
            classify_container(&["/ollama".into()], "myorg/base", "sleep infinity"),
            ollama(false)
        );
        assert_eq!(
            classify_container(
                &["/docker-model-runner".into()],
                "docker/model-runner:latest-cuda",
                "/app/model-runner"
            ),
            None
        );
        // A tag is not the repository.
        assert_eq!(
            classify_container(&["/web".into()], "myorg/inference:llamacpp", "nginx"),
            None
        );
    }

    /// What `docker inspect` says of a captured container: its command
    /// (entrypoint and arguments, joined as the container list shows it),
    /// its environment (the image's merged with the run's), its network
    /// mode and its published TCP ports.
    struct Inspected {
        command: String,
        env: Vec<String>,
        network_mode: Option<String>,
        published: Vec<(u16, u16, String)>,
    }

    fn inspected(json: &str) -> Inspected {
        let v: serde_json::Value = serde_json::from_str(json).expect("inspect JSON");
        let words = |value: &serde_json::Value| -> Vec<String> {
            value
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default()
        };
        let config = &v["Config"];
        let command = [words(&config["Entrypoint"]), words(&config["Cmd"])]
            .concat()
            .join(" ");
        let mut published = Vec::new();
        for (port, bindings) in v["NetworkSettings"]["Ports"]
            .as_object()
            .into_iter()
            .flatten()
        {
            let Some(container) = port
                .strip_suffix("/tcp")
                .and_then(|p| p.parse::<u16>().ok())
            else {
                continue;
            };
            for binding in bindings.as_array().into_iter().flatten() {
                let host = binding["HostPort"]
                    .as_str()
                    .and_then(|p| p.parse::<u16>().ok());
                let ip = binding["HostIp"].as_str().unwrap_or_default().to_string();
                published.extend(host.map(|host| (container, host, ip)));
            }
        }
        Inspected {
            command,
            env: words(&config["Env"]),
            network_mode: v["HostConfig"]["NetworkMode"].as_str().map(String::from),
            published,
        }
    }

    /// Where a container's llama-server is probed from the host and what its
    /// model is called, from its command, environment, network and ports —
    /// `None` when it listens on no TCP port.
    fn container_engine(container: &Inspected) -> Option<(Vec<String>, Option<String>)> {
        let args: Vec<&str> = container.command.split_whitespace().collect();
        let launch = llamacpp_launch(&args, |name| {
            env_var_in(container.env.iter().map(|e| e.as_bytes()), name)
        });
        let listen = launch.listen(llamacpp::default_ports(&DeploymentMode::Docker))?;
        let published: Vec<PublishedPort<'_>> = container
            .published
            .iter()
            .map(|(port, host, ip)| PublishedPort {
                container: *port,
                host: Some(*host),
                host_ip: Some(ip.as_str()),
                tcp: true,
            })
            .collect();
        let endpoints =
            llamacpp_container_endpoints(&listen, container.network_mode.as_deref(), &published);
        Some((endpoints, launch.served_model()))
    }

    /// The three captured containers: published on a bridge (`-p
    /// 18090:8080`, the image's `LLAMA_ARG_PORT=8080`), on the host network
    /// with `--port 18091` over the image's 8080, and on the host network
    /// configured by environment alone.
    #[test]
    fn a_captured_llamacpp_container_is_read_from_its_command_and_environment() {
        let model = Some(IN_CONTAINER.to_string());
        assert_eq!(
            container_engine(&inspected(include_str!(
                "fixtures/llamacpp_docker_published.json"
            ))),
            Some((strings(&["http://localhost:18090"]), model.clone()))
        );
        assert_eq!(
            container_engine(&inspected(include_str!(
                "fixtures/llamacpp_docker_host.json"
            ))),
            Some((strings(&["http://localhost:18091"]), model))
        );
        assert_eq!(
            container_engine(&inspected(include_str!(
                "fixtures/llamacpp_docker_env.json"
            ))),
            Some((
                strings(&["http://localhost:18092"]),
                Some("docker-env".to_string())
            ))
        );
    }

    /// Every other way a llama.cpp container can be run. No readable port
    /// means llama.cpp's own defaults for a container — 8080, which the
    /// official images set, then 9931 — never vLLM's 8000. A bridge
    /// container publishing nothing is unreachable from the host: probing
    /// its port there would reach whatever else is on it.
    #[test]
    fn a_llamacpp_container_is_probed_where_the_host_reaches_it() {
        let custom =
            |command: &str, env: &[&str], mode: Option<&str>, published: &[(u16, u16, &str)]| {
                container_engine(&Inspected {
                    command: command.to_string(),
                    env: strings(env),
                    network_mode: mode.map(String::from),
                    published: published
                        .iter()
                        .map(|&(port, host, ip)| (port, host, ip.to_string()))
                        .collect(),
                })
                .map(|(endpoints, _)| endpoints)
            };
        let official = ["LLAMA_ARG_HOST=0.0.0.0", "LLAMA_ARG_PORT=8080"];

        let defaults = custom("/usr/bin/llama-server -m /m.gguf", &[], Some("host"), &[]);
        assert_eq!(
            defaults,
            Some(strings(&["http://localhost:8080", "http://localhost:9931"]))
        );
        assert!(!defaults.unwrap().iter().any(|e| e.ends_with(":8000")));

        assert_eq!(
            custom(
                "/app/llama-server -m /m.gguf",
                &official,
                Some("bridge"),
                &[]
            ),
            Some(vec![])
        );
        assert_eq!(
            custom(
                "/app/llama-server -m /m.gguf",
                &official,
                Some("my-network"),
                &[]
            ),
            Some(vec![])
        );
        // With the network unknown, or another container's, the listening
        // port is assumed reachable and the probe decides.
        for mode in [None, Some("container:abc123")] {
            assert_eq!(
                custom("/app/llama-server -m /m.gguf", &official, mode, &[]),
                Some(strings(&["http://localhost:8080"])),
                "{mode:?}"
            );
        }
        // The binding of the port it listens on comes first; any other
        // published port after it, for a port set where neither the command
        // nor the environment shows it.
        assert_eq!(
            custom(
                "/app/llama-server -m /m.gguf",
                &official,
                Some("bridge"),
                &[
                    (9100, 9100, "0.0.0.0"),
                    (8080, 9000, "0.0.0.0"),
                    (8080, 9000, "::")
                ]
            ),
            Some(strings(&["http://localhost:9000", "http://localhost:9100"]))
        );
        assert_eq!(
            custom(
                "/app/llama-server -m /m.gguf --port 9001",
                &official,
                Some("bridge"),
                &[(9001, 19001, "127.0.0.1")]
            ),
            Some(strings(&["http://127.0.0.1:19001"]))
        );
        // A Unix socket only: no TCP endpoint at all.
        assert_eq!(
            custom(
                "/app/llama-server -m /m.gguf --host /sockets/llama.sock",
                &official,
                Some("host"),
                &[]
            ),
            None
        );
    }

    /// A llama.cpp container's launch is its server's: the container's own
    /// command when that runs llama-server, else the first llama-server
    /// among its processes (a wrapper entrypoint's child). A router's
    /// children come after it, with the random ports it gave them.
    #[test]
    fn a_llamacpp_containers_launch_is_its_servers() {
        let router = "/app/llama-server --models-dir /models";
        let processes = strings(&[
            router,
            "/app/llama-server --host 127.0.0.1 --port 41234 --alias x --model /models/x.gguf",
        ]);
        assert_eq!(llamacpp_container_command(router, &processes), router);

        let wrapped = strings(&["./llama-server -m /models/x.gguf --port 8000"]);
        assert_eq!(
            llamacpp_container_command(
                "/app/tools.sh --server -m /models/x.gguf --port 8000",
                &wrapped
            ),
            wrapped[0]
        );
        assert_eq!(
            llamacpp_container_command("sleep infinity", &strings(&["sleep infinity"])),
            "sleep infinity"
        );
    }

    /// The host scan sees a container's server too — its environment
    /// unreadable, so on the default ports — and the container's engine
    /// absorbs it, as for every engine type.
    #[test]
    fn a_llamacpp_containers_server_is_its_engine_not_a_native_one() {
        let mut candidates = scan_argvs(
            &[(700, Some(690), llamacpp_cmdline("docker_env"))],
            unreadable,
        );
        assert_eq!(candidates[0].endpoint, "http://localhost:9931");
        let container = DetectedEngine {
            engine_type: EngineType::LlamaCpp,
            served_model: Some("docker-env".into()),
            container_id: Some("c0ffee".into()),
            ..candidate("http://localhost:18092", DeploymentMode::Docker, &[700])
        };
        merge_docker_candidates(&mut candidates, vec![container]);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].endpoint, "http://localhost:18092");
        assert_eq!(candidates[0].deployment_mode, DeploymentMode::Docker);
        assert_eq!(candidates[0].served_model.as_deref(), Some("docker-env"));
        assert_eq!(candidates[0].pids, vec![700]);
    }

    /// A llama-server's answer to `/health`, header and all.
    async fn llamacpp_server() -> super::super::test_server::TestServer {
        super::super::test_server::TestServer::start_with_headers(|_| {
            (
                200,
                r#"{"status":"ok"}"#.to_string(),
                vec![("Server", "llama.cpp".to_string())],
            )
        })
        .await
    }

    /// Nothing listens on port 1 of the loopback: a refused connection.
    const NOTHING_THERE: &str = "http://127.0.0.1:1";

    fn no_keys() -> ApiKeyResolver {
        ApiKeyResolver::from_pairs(&[], &[], None)
    }

    /// A candidate with more than one endpoint is kept on the first that
    /// answers as its engine type — a refused port, or another engine's
    /// server, does not — and the endpoints after that one are not asked.
    /// One that answers nowhere is dropped.
    #[tokio::test]
    async fn a_candidate_is_kept_on_the_first_of_its_endpoints_that_identifies() {
        use super::super::test_server::TestServer;
        let vllm = TestServer::start(|_| (200, String::new())).await;
        let llama = llamacpp_server().await;
        let unasked = llamacpp_server().await;
        let native = DetectedEngine {
            engine_type: EngineType::LlamaCpp,
            fallback_endpoints: vec![vllm.url.clone(), llama.url.clone(), unasked.url.clone()],
            ..candidate(NOTHING_THERE, DeploymentMode::Native, &[10])
        };
        let verified = verify_candidates(vec![native], &reqwest::Client::new(), &no_keys()).await;
        assert_eq!(verified.len(), 1);
        assert_eq!(verified[0].endpoint, llama.url);
        assert!(verified[0].fallback_endpoints.is_empty());
        assert_eq!(vllm.requests().len(), 1, "the vLLM server was asked once");
        assert!(unasked.requests().is_empty());

        let nowhere = DetectedEngine {
            engine_type: EngineType::LlamaCpp,
            fallback_endpoints: vec![vllm.url.clone()],
            ..candidate(NOTHING_THERE, DeploymentMode::Native, &[10])
        };
        assert!(
            verify_candidates(vec![nowhere], &reqwest::Client::new(), &no_keys())
                .await
                .is_empty()
        );
    }

    /// Two candidates verified on one endpoint are one server, one engine —
    /// the host scan's guess at a default port and a container whose
    /// processes could not be listed, say — and the container's view of it
    /// wins, whichever came first: its model too, which the host scan read
    /// off the command line alone.
    #[tokio::test]
    async fn candidates_verified_on_one_endpoint_are_one_engine() {
        let llama = llamacpp_server().await;
        let host_view = DetectedEngine {
            engine_type: EngineType::LlamaCpp,
            served_model: Some("/models/qwen.gguf".into()),
            fallback_endpoints: vec![llama.url.clone()],
            ..candidate(NOTHING_THERE, DeploymentMode::Native, &[500])
        };
        let container = DetectedEngine {
            engine_type: EngineType::LlamaCpp,
            served_model: Some("docker-env".into()),
            container_id: Some("c0ffee".into()),
            ..candidate(&llama.url, DeploymentMode::Docker, &[])
        };
        for candidates in [
            vec![host_view.clone(), container.clone()],
            vec![container.clone(), host_view.clone()],
        ] {
            let verified = verify_candidates(candidates, &reqwest::Client::new(), &no_keys()).await;
            assert_eq!(verified.len(), 1);
            let engine = &verified[0];
            assert_eq!(engine.endpoint, llama.url);
            assert_eq!(engine.deployment_mode, DeploymentMode::Docker);
            assert_eq!(engine.container_id.as_deref(), Some("c0ffee"));
            assert_eq!(engine.served_model.as_deref(), Some("docker-env"));
            assert_eq!(engine.pids, vec![500]);
        }
    }

    /// The host scan cannot read a root container's environment, so where a
    /// llama.cpp container names its model by `LLAMA_ARG_ALIAS` the host
    /// scan has only the `-m` path, which `/models` does not report. Where
    /// the two join, the container's served model wins when it names one,
    /// whichever came first; the host scan's fills in when it names none.
    #[test]
    fn a_containers_served_model_wins_where_candidates_join() {
        let joined = |order: [&DetectedEngine; 2]| {
            let mut candidates = Vec::new();
            for candidate in order {
                join_on_endpoint(&mut candidates, candidate.clone());
            }
            assert_eq!(candidates.len(), 1);
            candidates.remove(0).served_model
        };
        let host_view = DetectedEngine {
            engine_type: EngineType::LlamaCpp,
            served_model: Some("/models/qwen2.5-1.5b-instruct-q4_k_m.gguf".into()),
            ..candidate("http://localhost:8080", DeploymentMode::Native, &[500])
        };
        let container = DetectedEngine {
            engine_type: EngineType::LlamaCpp,
            served_model: Some("qwen-small".into()),
            container_id: Some("c0ffee".into()),
            ..candidate("http://localhost:8080", DeploymentMode::Docker, &[])
        };
        let alias = Some("qwen-small".to_string());
        assert_eq!(joined([&host_view, &container]), alias);
        assert_eq!(joined([&container, &host_view]), alias);

        let unnamed = DetectedEngine {
            served_model: None,
            ..container
        };
        assert_eq!(joined([&host_view, &unnamed]), host_view.served_model);
        assert_eq!(joined([&unnamed, &host_view]), host_view.served_model);
    }
}
