//! llama.cpp's `llama-server`: one model per server — or, started with no
//! model, a router that spawns a child server for each model it loads.
//!
//! What it reports comes from `/metrics`, which it serves only when started
//! with `--metrics`: counters of prompt and generated tokens and the seconds
//! spent on each, the requests processing and deferred, and the speculative
//! decoding counters. It has no histograms, no request counter, no time to
//! first token, no end-to-end latency, no queue time and no KV or prefix
//! cache figure, and the adapter fills none of those with a stand-in
//! (ADR-0004).
//!
//! **Idle sleep.** A server started with `--sleep-idle-seconds` unloads its
//! model once idle. `/health`, `/metrics`, `/props` and `/models` neither
//! reset the idle timer nor wake a sleeping server, and they are all an idle
//! tick asks. `/slots` does both: polled, it keeps the server from ever going
//! to sleep, and it wakes (reloads) one that has. So it is asked only on a
//! tick whose scrape shows a request in flight — a server that is not idle
//! anyway (verified live on v0.7.0 / b11669).

use super::common::{
    spec_acceptance_rate, spec_live_acceptance_rate, spec_mean_acceptance_length, CounterRate,
    EngineHttp,
};
use super::histogram::mean_ms;
use super::model_info::{classify_models_error_status, format_param_size};
use super::prometheus::{parse_prometheus_text, ParsedMetrics};
use super::warmup::WarmupTracker;
use super::{
    DeploymentMode, EngineAdapter, EngineMetrics, EngineStatus, EngineType, MetricGroup,
    MetricsError, ModelInfo, ModelMetadataError, ModelResolution,
};
use async_trait::async_trait;
use reqwest::StatusCode;
use serde_json::Value;
use std::collections::BTreeSet;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

/// The launch flag that turns llama-server's `/metrics` on. Without it the
/// server answers 501 there — the state the dashboard names on the wire
/// (`metrics_off`), so the panels say which flag to restart with.
pub const METRICS_LAUNCH_FLAG: &str = "--metrics";

/// The ports a native llama-server listens on when neither `--port` nor
/// `LLAMA_ARG_PORT` says otherwise, newest release first: 9931 from v0.7.0
/// (upstream #30159), 8080 before it. The first one that identifies wins.
pub const NATIVE_DEFAULT_PORTS: [u16; 2] = [9931, 8080];

/// The same for a container with no readable port. The official images set
/// `LLAMA_ARG_PORT=8080` in their environment and declare no exposed port, so
/// 8080 comes first; 9931 covers an image built without that variable.
pub const CONTAINER_DEFAULT_PORTS: [u16; 2] = [8080, 9931];

/// The default ports to try, in order, for a llama-server deployed `mode`.
pub(crate) fn default_ports(mode: &DeploymentMode) -> [u16; 2] {
    match mode {
        DeploymentMode::Native => NATIVE_DEFAULT_PORTS,
        DeploymentMode::Docker => CONTAINER_DEFAULT_PORTS,
    }
}

/// The counter the warmup baseline watches for a restart. llama-server
/// counts no requests, so "skip the first N requests"
/// (`SPARK_WARMUP_SKIP_REQUESTS`) cannot be honoured: the baseline is taken
/// on the first scrape, which still keeps the history from before the
/// dashboard attached out of the means, and a counter that drops below it
/// re-baselines.
const WARMUP_TRIGGER_KEY: &str = "llamacpp_tokens_predicted_total";

/// What every llama-server route answers, with 503, while the model loads.
const LOADING_MESSAGE: &str = "Loading model";

/// How long `/slots` may take before the tick falls back to the counters.
/// The route is answered from the server's task loop, which a long prompt
/// batch can hold up, and engines are polled one after another.
const SLOTS_TIMEOUT: Duration = Duration::from_millis(500);

/// Whether a llama-server serves one model or routes to child servers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Role {
    /// It serves a model of its own, and has metrics of its own.
    SingleModel,
    /// Started with no model: it spawns one child server per model and has
    /// no metrics of its own — its `/metrics` asks which model.
    Router,
}

/// What `/props` says that the adapter acts on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ServerFacts {
    role: Role,
    /// Whether `/slots` is served (`--no-slots` turns it off).
    slots_endpoint: bool,
}

/// What the adapter has learned of the server, from `/props` and from the
/// shape of its other answers.
#[derive(Clone, Copy, Debug, Default)]
struct Learned {
    role: Option<Role>,
    slots_endpoint: Option<bool>,
    /// Whether a drafter is configured, as `/slots` said on the last tick it
    /// was asked. `/props` does not say (its `speculative.types` reads
    /// `"none"` with `--spec-type draft-simple` too), and `/slots` is asked
    /// only while busy.
    drafter: Option<bool>,
}

pub struct LlamaCppAdapter {
    /// The endpoint, and the bearer token of a launch with `--api-key`, which
    /// gates every route but `/health`.
    http: EngineHttp,
    /// The model named on the launch command line, shown when `/models`
    /// cannot be read.
    served_model: Option<String>,
    /// Generation tokens/s and its running average.
    gen_rate: Mutex<CounterRate>,
    /// Prompt tokens/s and its running average.
    prompt_rate: Mutex<CounterRate>,
    warmup: Mutex<WarmupTracker>,
    /// The generated-token count last fed to `gen_rate`, which the next one
    /// may not fall below (`live_generated`).
    generated: Mutex<Option<f64>>,
    /// The `(accepted, draft)` token counters of the last scrape, for the
    /// live acceptance rate.
    prev_spec: Mutex<Option<(f64, f64)>>,
    learned: Mutex<Learned>,
    /// Latched by each answered scrape (`latched`). An unreachable or loading
    /// server leaves it alone — offline is not off.
    metrics_access: Mutex<MetricsAccess>,
}

impl LlamaCppAdapter {
    pub fn new(
        client: reqwest::Client,
        endpoint: String,
        served_model: Option<String>,
        api_key: Option<String>,
    ) -> Self {
        Self {
            http: EngineHttp::new(client, endpoint, api_key),
            served_model,
            gen_rate: Mutex::default(),
            prompt_rate: Mutex::default(),
            warmup: Mutex::new(WarmupTracker::new(0, WARMUP_TRIGGER_KEY)),
            generated: Mutex::default(),
            prev_spec: Mutex::default(),
            learned: Mutex::default(),
            metrics_access: Mutex::default(),
        }
    }

    fn learned(&self) -> Learned {
        *lock(&self.learned)
    }

    fn metrics_access(&self) -> MetricsAccess {
        *lock(&self.metrics_access)
    }

    fn learn_role(&self, role: Option<Role>) {
        if let Some(role) = role {
            lock(&self.learned).role = Some(role);
        }
    }

    /// The `(status, body)` `request` was answered with, or `None` when the
    /// server could not be reached.
    async fn answer(&self, request: reqwest::RequestBuilder) -> Option<(u16, String)> {
        let response = request.send().await.ok()?;
        let status = response.status().as_u16();
        Some((status, response.text().await.unwrap_or_default()))
    }

    /// The model fallback, and why it is only that.
    fn fallback(&self, error: ModelMetadataError) -> ModelResolution {
        resolution(ModelsAnswer::Failed(error), self.served_model.as_deref())
    }

    fn warn_refused(&self, path: &str) {
        tracing::warn!(
            endpoint = %self.http.endpoint(),
            "{path} refused the dashboard's API key — \
             configure a provider API key to read model metadata",
        );
    }

    /// What `/slots` says now, or `None` when it did not answer in time or
    /// answered something else.
    async fn read_slots(&self) -> Option<Slots> {
        let (status, body) = self
            .answer(self.http.get("/slots").timeout(SLOTS_TIMEOUT))
            .await?;
        (200..300)
            .contains(&status)
            .then(|| parse_slots(&body))
            .flatten()
    }

    /// Record what an answered scrape says about the metrics endpoint.
    fn latch(&self, answer: MetricsAnswer) {
        let role = self.learned().role;
        let (was, now) = {
            let mut access = lock(&self.metrics_access);
            let was = *access;
            *access = latched(answer, was, role);
            (was, *access)
        };
        if now == MetricsAccess::Refused && was != MetricsAccess::Refused {
            tracing::warn!(
                endpoint = %self.http.endpoint(),
                "/metrics refused the dashboard's API key — \
                 configure a provider API key to read its metrics",
            );
        }
        self.learn_role(match answer {
            MetricsAnswer::On => Some(Role::SingleModel),
            MetricsAnswer::NeedsModel => Some(Role::Router),
            _ => None,
        });
    }
}

/// A lock that outlives a panic in another holder: every value guarded here
/// is a reading that the next poll overwrites.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The metric groups a llama-server with a model of its own reports
/// (`Role::SingleModel`). Its counters give throughput, the running and
/// deferred requests, speculative decoding and — seconds over tokens — the
/// mean inter-token latency. There is no histogram for a percentile, no
/// request count, no time to first token, end-to-end latency or queue time,
/// no batch-size counter and no KV or prefix cache gauge.
fn single_model_groups() -> BTreeSet<MetricGroup> {
    BTreeSet::from([
        MetricGroup::Throughput,
        MetricGroup::ActiveRequests,
        MetricGroup::SpeculativeDecoding,
        MetricGroup::ItlMean,
    ])
}

#[async_trait]
impl EngineAdapter for LlamaCppAdapter {
    fn engine_type(&self) -> EngineType {
        EngineType::LlamaCpp
    }

    fn endpoint(&self) -> &str {
        self.http.endpoint()
    }

    /// One with a model of its own reports `single_model_groups`. A router
    /// reports none: it has no metrics of its own, only its children's
    /// behind `?model=`, and those are out of scope — so it shows as a
    /// running engine at the floor.
    fn metric_groups(&self) -> BTreeSet<MetricGroup> {
        match self.learned().role {
            Some(Role::Router) => BTreeSet::new(),
            _ => single_model_groups(),
        }
    }

    fn metrics_launch_flag(&self) -> Option<&'static str> {
        Some(METRICS_LAUNCH_FLAG)
    }

    fn metrics_off(&self) -> bool {
        self.metrics_access() == MetricsAccess::Off
    }

    fn metrics_error(&self) -> Option<MetricsError> {
        (self.metrics_access() == MetricsAccess::Refused).then_some(MetricsError::AuthRequired)
    }

    /// `/health` is public (no key) and leaves the idle timer alone: 200 is
    /// running, 503 "Loading model" is loading.
    async fn health_check(&self) -> EngineStatus {
        match self.http.get("/health").send().await {
            Ok(response) => {
                let status = response.status();
                health_status(status, &response.text().await.unwrap_or_default())
            }
            Err(e) => EngineStatus::Error(e.to_string()),
        }
    }

    /// `/props` first, for the role and whether `/slots` is served, then
    /// `/models` for the model's name, parameter count and quantization —
    /// both sleep-exempt, unlike `/v1/models` on paper. A router names no
    /// model. A refused key reads as `AuthRequired` beside the command-line
    /// name, as on vLLM.
    async fn get_model_info(&self) -> ModelResolution {
        let props = match self.answer(self.http.get("/props")).await {
            Some((status, body)) => classify_props_answer(status, &body),
            None => PropsAnswer::Failed,
        };
        match props {
            PropsAnswer::Facts(facts) => {
                let mut learned = lock(&self.learned);
                learned.role = Some(facts.role);
                learned.slots_endpoint = Some(facts.slots_endpoint);
            }
            PropsAnswer::Refused => {
                self.warn_refused("/props");
                return self.fallback(ModelMetadataError::AuthRequired);
            }
            PropsAnswer::Failed => {}
        }
        if self.learned().role == Some(Role::Router) {
            return ModelResolution::default();
        }
        let answer = match self.answer(self.http.get("/models")).await {
            Some((status, body)) => classify_models_answer(status, &body),
            None => ModelsAnswer::Failed(ModelMetadataError::Unavailable),
        };
        match &answer {
            ModelsAnswer::Model(_) => self.learn_role(Some(Role::SingleModel)),
            ModelsAnswer::Router => self.learn_role(Some(Role::Router)),
            ModelsAnswer::Failed(ModelMetadataError::AuthRequired) => self.warn_refused("/models"),
            ModelsAnswer::Failed(_) => {}
        }
        resolution(answer, self.served_model.as_deref())
    }

    async fn get_metrics(&self) -> Option<EngineMetrics> {
        // A server that cannot be reached is offline, not off: nothing is
        // latched before it answers.
        let (status, body) = self.answer(self.http.get("/metrics")).await?;
        let answer = metrics_answer(status);
        self.latch(answer);
        if answer != MetricsAnswer::On {
            return None;
        }
        let raw = parse_llamacpp(&body)?;

        let warmup_out = lock(&self.warmup).observe(&raw);
        if warmup_out.just_transitioned {
            lock(&self.gen_rate).reset();
            lock(&self.prompt_rate).reset();
            *lock(&self.generated) = None;
            *lock(&self.prev_spec) = None;
        }
        let warming_up = warmup_out.warming_up;

        // The generated-token counter moves only when a request finishes, so
        // while one runs, the slots' own counts say how far it has got —
        // asked only now, with a request in flight (see the module docs).
        let slots = if should_read_slots(
            raw.gauge_sum("llamacpp_requests_processing"),
            self.learned().slots_endpoint,
        ) {
            self.read_slots().await
        } else {
            None
        };
        if let Some(slots) = &slots {
            lock(&self.learned).drafter = Some(slots.speculative);
        }
        let generated = {
            let mut prev = lock(&self.generated);
            let now = live_generated(
                raw.counters.get("llamacpp_tokens_predicted_total").copied(),
                slots.map(|s| s.decoded_in_flight),
                *prev,
            );
            if now.is_some() {
                *prev = now;
            }
            now
        };
        let now = Instant::now();
        let (tokens_per_sec, avg_tokens_per_sec) = lock(&self.gen_rate).observe(generated, now);
        let (prompt_tokens_per_sec, avg_prompt_tokens_per_sec) = lock(&self.prompt_rate).observe(
            raw.counters.get("llamacpp_prompt_tokens_total").copied(),
            now,
        );

        let spec = spec_counters(&raw);
        let spec_live = {
            let mut prev = lock(&self.prev_spec);
            let now = spec.map(|c| (c.accepted, c.draft));
            let live = spec_live_acceptance_rate(*prev, now);
            *prev = now;
            live
        };

        Some(engine_metrics(
            &warmup_out.adjusted,
            &raw,
            RateInputs {
                tokens_per_sec,
                prompt_tokens_per_sec,
                avg_tokens_per_sec,
                avg_prompt_tokens_per_sec,
            },
            warming_up,
            SpecInputs {
                drafter: self.learned().drafter,
                live_rate: spec_live,
            },
        ))
    }
}

// ---------------------------------------------------------------------------
// Identification
// ---------------------------------------------------------------------------

/// Whether the server behind `http` is a llama-server. Every answer it gives
/// — `/health` included, the 503 of a loading model too — carries
/// `Server: llama.cpp`, which neither vLLM nor SGLang (`uvicorn`) nor Ollama
/// (none) sends. `/health` is public and sleep-exempt, so asking it costs
/// the server nothing.
///
/// Where something in between strips the header, the answers' shapes decide
/// instead: `/health`'s own body, and a `/props` that is llama-server's or
/// that the key gates.
pub(crate) async fn identify(http: &EngineHttp) -> bool {
    let Ok(health) = http.get("/health").send().await else {
        return false;
    };
    let status = health.status().as_u16();
    let server = health
        .headers()
        .get(reqwest::header::SERVER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    if let Some(named) = server_names_llamacpp(server.as_deref()) {
        return named && matches!(status, 200 | 503);
    }
    let body = health.text().await.unwrap_or_default();
    if !health_answers_like_llamacpp(status, &body) {
        return false;
    }
    match http.get("/props").send().await {
        Ok(props) => {
            let status = props.status().as_u16();
            props_answers_like_llamacpp(status, &props.text().await.unwrap_or_default())
        }
        Err(_) => false,
    }
}

/// What a `Server` header says: `Some(true)` for llama-server's, also with a
/// version after a slash; `Some(false)` for any other server's; `None` when
/// there is no header to go by.
fn server_names_llamacpp(server: Option<&str>) -> Option<bool> {
    let server = server?.trim().to_ascii_lowercase();
    Some(server == "llama.cpp" || server.starts_with("llama.cpp/"))
}

/// Whether `/health` answered the way llama-server's does: 200
/// `{"status":"ok"}`, or 503 "Loading model".
fn health_answers_like_llamacpp(status: u16, body: &str) -> bool {
    match status {
        200 => serde_json::from_str::<Value>(body)
            .ok()
            .is_some_and(|v| v.get("status").and_then(Value::as_str) == Some("ok")),
        503 => is_loading(body),
        _ => false,
    }
}

/// Whether `/props` answered the way llama-server's does: its own object
/// (`build_info`, `total_slots`, or a router's `role`), the refusal of a
/// server started with `--api-key`, or "Loading model".
fn props_answers_like_llamacpp(status: u16, body: &str) -> bool {
    match status {
        200 => serde_json::from_str::<Value>(body).ok().is_some_and(|v| {
            v.get("build_info").is_some_and(Value::is_string)
                || v.get("total_slots").is_some_and(Value::is_u64)
                || v.get("role").and_then(Value::as_str) == Some("router")
        }),
        401 | 403 => true,
        503 => is_loading(body),
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/// The `error.message` of a llama-server error body.
fn error_message(body: &str) -> Option<String> {
    let v: Value = serde_json::from_str(body).ok()?;
    v.get("error")?.get("message")?.as_str().map(str::to_owned)
}

/// Whether a body is the 503 every route answers while the model loads.
fn is_loading(body: &str) -> bool {
    error_message(body).as_deref() == Some(LOADING_MESSAGE)
}

/// The engine status a `/health` answer gives: 2xx running, 503 "Loading
/// model" loading, anything else an error naming the status. A sleeping
/// server answers 200 — it is running, with its model unloaded until the
/// next request.
fn health_status(status: StatusCode, body: &str) -> EngineStatus {
    if status.is_success() {
        EngineStatus::Running
    } else if status == StatusCode::SERVICE_UNAVAILABLE && is_loading(body) {
        EngineStatus::Loading
    } else {
        EngineStatus::Error(format!("HTTP {status}"))
    }
}

// ---------------------------------------------------------------------------
// The metrics endpoint
// ---------------------------------------------------------------------------

/// What one answered `/metrics` request says about the endpoint. llama-server
/// checks a loading model first, then the API key, then whether metrics are
/// on, so each answer means one thing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MetricsAnswer {
    /// 2xx: metrics are on.
    On,
    /// 501: started without `--metrics`.
    Off,
    /// 401/403: the key is missing or wrong — whether metrics are on cannot
    /// be told until the dashboard has it.
    Refused,
    /// 400: a router, whose `/metrics` asks which model (`?model=`), with or
    /// without `--metrics`.
    NeedsModel,
    /// Anything else, a loading model's 503 among them: says nothing about
    /// the endpoint.
    Transient,
}

fn metrics_answer(status: u16) -> MetricsAnswer {
    match status {
        200..=299 => MetricsAnswer::On,
        501 => MetricsAnswer::Off,
        401 | 403 => MetricsAnswer::Refused,
        400 => MetricsAnswer::NeedsModel,
        _ => MetricsAnswer::Transient,
    }
}

/// What the answered scrapes have said about the metrics endpoint: one
/// state, so that it is never off and refused at once.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum MetricsAccess {
    /// Neither off nor refused: it answered with metrics, asked a router's
    /// question, or has not answered yet.
    #[default]
    Open,
    /// It answered 501: started without `--metrics` — metrics off, the
    /// panels naming the flag.
    Off,
    /// It refused the dashboard's key (401/403) — metrics refused, the
    /// panels asking for the key.
    Refused,
}

/// The state after `answer`, from `was`, for a server whose role is `role`
/// as far as the adapter knows it. A refusal is never metrics off — the
/// remedy is a key, not a flag — and a transient answer leaves the state as
/// it was. A router is never metrics off at all, whatever it answers (a 501
/// without `--metrics`, say): it reports no metric group with the flag or
/// without, so there is no flag to name.
fn latched(answer: MetricsAnswer, was: MetricsAccess, role: Option<Role>) -> MetricsAccess {
    let now = match answer {
        MetricsAnswer::On | MetricsAnswer::NeedsModel => MetricsAccess::Open,
        MetricsAnswer::Off => MetricsAccess::Off,
        MetricsAnswer::Refused => MetricsAccess::Refused,
        MetricsAnswer::Transient => was,
    };
    match (now, role) {
        (MetricsAccess::Off, Some(Role::Router)) => MetricsAccess::Open,
        _ => now,
    }
}

/// A scrape parsed with the shared parser, or `None` when it carries no
/// `llamacpp:` series — a proxy's or an exporter's, not the engine's.
fn parse_llamacpp(body: &str) -> Option<ParsedMetrics> {
    parse_prometheus_text(body).filter(|parsed| {
        parsed
            .counters
            .keys()
            .chain(parsed.gauges.keys())
            .any(|name| name.starts_with("llamacpp_"))
    })
}

// ---------------------------------------------------------------------------
// /props and /models
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
enum PropsAnswer {
    Facts(ServerFacts),
    /// 401/403: the key is missing or wrong.
    Refused,
    Failed,
}

fn classify_props_answer(status: u16, body: &str) -> PropsAnswer {
    match status {
        200..=299 => parse_props(body).map_or(PropsAnswer::Failed, PropsAnswer::Facts),
        401 | 403 => PropsAnswer::Refused,
        _ => PropsAnswer::Failed,
    }
}

/// The facts a `/props` body holds: a router says `"role": "router"` (a
/// server, a router's child included, has no `role`), and `endpoint_slots`
/// says whether `/slots` is served — absent on a router and on releases that
/// predate the field, and then read as not served.
fn parse_props(body: &str) -> Option<ServerFacts> {
    let props: Value = serde_json::from_str(body).ok()?;
    let props = props.as_object()?;
    let role = match props.get("role").and_then(Value::as_str) {
        Some("router") => Role::Router,
        _ => Role::SingleModel,
    };
    Some(ServerFacts {
        role,
        slots_endpoint: props
            .get("endpoint_slots")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

#[derive(Debug, PartialEq)]
enum ModelsAnswer {
    Model(ModelInfo),
    /// A router's list: every model it can load, each with a `status`.
    Router,
    Failed(ModelMetadataError),
}

/// What a `/models` answer says. A server lists its one model: `id` is its
/// first alias, or the `-m` path or `-hf` repo as given, and `meta` carries
/// the parameter count and the GGUF file type. Its body also holds an
/// Ollama-shaped `models` array, which is not read.
fn classify_models_answer(status: u16, body: &str) -> ModelsAnswer {
    if !(200..300).contains(&status) {
        return ModelsAnswer::Failed(classify_models_error_status(status));
    }
    let Some(data) = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.get("data").and_then(Value::as_array).cloned())
    else {
        return ModelsAnswer::Failed(ModelMetadataError::Unavailable);
    };
    if data
        .iter()
        .any(|entry| entry.get("status").is_some_and(Value::is_object))
    {
        return ModelsAnswer::Router;
    }
    match data.first().and_then(model_of) {
        Some(model) => ModelsAnswer::Model(model),
        None => ModelsAnswer::Failed(ModelMetadataError::Unavailable),
    }
}

fn model_of(entry: &Value) -> Option<ModelInfo> {
    let name = entry.get("id")?.as_str()?.trim();
    if name.is_empty() {
        return None;
    }
    let meta = entry.get("meta");
    Some(ModelInfo {
        parameter_size: meta
            .and_then(|m| m.get("n_params"))
            .and_then(Value::as_u64)
            .filter(|&n| n > 0)
            .map(format_param_size),
        quantization: meta
            .and_then(|m| m.get("ftype"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|ftype| !ftype.is_empty())
            .map(str::to_string),
        ..ModelInfo::named(name)
    })
}

/// The model resolution an answer gives: the server's own model, nothing
/// for a router, or the command-line name with the reason it is only that.
fn resolution(answer: ModelsAnswer, hint: Option<&str>) -> ModelResolution {
    match answer {
        ModelsAnswer::Model(model) => ModelResolution {
            model: Some(model),
            metadata_error: None,
        },
        ModelsAnswer::Router => ModelResolution::default(),
        ModelsAnswer::Failed(error) => ModelResolution {
            model: hint.map(ModelInfo::named),
            metadata_error: Some(error),
        },
    }
}

// ---------------------------------------------------------------------------
// /slots and the live generation rate
// ---------------------------------------------------------------------------

/// What `/slots` says that the adapter acts on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Slots {
    /// Tokens the requests in flight have generated so far, which
    /// `tokens_predicted_total` does not count until each one finishes.
    decoded_in_flight: u64,
    /// Whether any slot speculates — a drafter is configured.
    speculative: bool,
}

/// A `/slots` body: an array of slots, each saying whether it is processing
/// and — while it is — how many tokens it has decoded (`next_token[0]`).
fn parse_slots(body: &str) -> Option<Slots> {
    let slots: Value = serde_json::from_str(body).ok()?;
    let slots = slots.as_array()?;
    let flag = |slot: &Value, name: &str| slot.get(name).and_then(Value::as_bool) == Some(true);
    Some(Slots {
        decoded_in_flight: slots
            .iter()
            .filter(|slot| flag(slot, "is_processing"))
            .filter_map(|slot| slot.pointer("/next_token/0/n_decoded")?.as_u64())
            .sum(),
        speculative: slots.iter().any(|slot| flag(slot, "speculative")),
    })
}

/// Whether this tick asks `/slots`: only when the scrape just taken shows a
/// request processing — a busy server is not idle, so the ask cannot keep it
/// from sleeping — and `/props` said the route is served.
fn should_read_slots(requests_processing: Option<f64>, slots_endpoint: Option<bool>) -> bool {
    requests_processing.is_some_and(|n| n > 0.0) && slots_endpoint == Some(true)
}

/// The generated-token count the generation rate is taken from: the counter,
/// plus what the requests in flight have decoded when `/slots` was read. It
/// never falls below `prev`: a request that finishes between the scrape and
/// `/slots` is briefly in neither, and a rate must not go negative for it.
/// `None` when the scrape has no counter.
fn live_generated(counted: Option<f64>, in_flight: Option<u64>, prev: Option<f64>) -> Option<f64> {
    let now = counted? + in_flight.unwrap_or(0) as f64;
    Some(prev.map_or(now, |prev| now.max(prev)))
}

// ---------------------------------------------------------------------------
// Speculative decoding
// ---------------------------------------------------------------------------

/// llama-server's three speculative-decoding counters, which it serves with
/// or without a drafter (all `0` without one).
#[derive(Clone, Copy, Debug, PartialEq)]
struct SpecCounters {
    draft: f64,
    accepted: f64,
    /// Verification steps — one per draft checked.
    drafts: f64,
}

fn spec_counters(raw: &ParsedMetrics) -> Option<SpecCounters> {
    let counter = |name: &str| raw.counters.get(name).copied();
    Some(SpecCounters {
        draft: counter("llamacpp_spec_decode_num_draft_tokens_total")?,
        accepted: counter("llamacpp_spec_decode_num_accepted_tokens_total")?,
        drafts: counter("llamacpp_spec_decode_num_drafts_total")?,
    })
}

// ---------------------------------------------------------------------------
// The mapping
// ---------------------------------------------------------------------------

/// The rates are the adapter's stateful derivation; they arrive as inputs so
/// the mapping is pure over one scrape.
#[derive(Debug, Default, Clone, Copy)]
struct RateInputs {
    tokens_per_sec: Option<f64>,
    prompt_tokens_per_sec: Option<f64>,
    avg_tokens_per_sec: Option<f64>,
    avg_prompt_tokens_per_sec: Option<f64>,
}

/// What the speculative-decoding fields need besides the scrape.
#[derive(Debug, Default, Clone, Copy)]
struct SpecInputs {
    /// Whether `/slots` last said a drafter is configured; `None` before it
    /// has been asked.
    drafter: Option<bool>,
    /// The live acceptance rate between this scrape and the last.
    live_rate: Option<f64>,
}

/// Map one llama-server scrape onto the engine snapshot. Pure: `parsed` is
/// the scrape after the warmup baseline is subtracted, `raw` the same scrape
/// as read, for the speculative-decoding counters. `warming_up` blanks what
/// a delta needs, as on vLLM.
///
/// Filled: the four throughput figures (from the adapter's rates) and the
/// two token totals, counted from the baseline like vLLM's (the engine's own
/// count while warming); the requests processing and deferred; the
/// mean inter-token latency, seconds over tokens of the requests finished
/// since the baseline (the seconds are summed per slot, so this is the time
/// between one request's tokens); and the six speculative-decoding fields.
/// Everything else stays `None` — llama-server has no series for it.
fn engine_metrics(
    parsed: &ParsedMetrics,
    raw: &ParsedMetrics,
    rates: RateInputs,
    warming_up: bool,
    spec: SpecInputs,
) -> EngineMetrics {
    let counter = |name: &str| parsed.counters.get(name).copied();
    let tokens = |name: &str| counter(name).map(|v| v.max(0.0) as u64);
    let requests = |name: &str| parsed.gauge_sum(name).map(|v| v.max(0.0) as u64);
    let blank = warming_up;

    let inter_token_latency_ms = mean_ms(
        counter("llamacpp_tokens_predicted_seconds_total"),
        counter("llamacpp_tokens_predicted_total"),
    );

    // The three spec counters are served with or without a drafter, all `0`
    // without one, so a zero reading means "not speculating" unless `/slots`
    // has said a drafter is configured — then it is "drafted nothing yet".
    let speculating = spec_counters(raw).filter(|c| {
        c.draft > 0.0 || c.accepted > 0.0 || c.drafts > 0.0 || spec.drafter == Some(true)
    });
    let spec_total =
        |value: fn(&SpecCounters) -> f64| speculating.map(|c| value(&c).max(0.0) as u64);

    EngineMetrics {
        tokens_per_sec: if blank { None } else { rates.tokens_per_sec },
        avg_tokens_per_sec: if blank {
            None
        } else {
            rates.avg_tokens_per_sec
        },
        per_request_tps: None,
        ttft_ms: None,
        active_requests: requests("llamacpp_requests_processing"),
        queued_requests: requests("llamacpp_requests_deferred"),
        kv_cache_percent: None,
        kv_cache_is_estimated: false,
        total_requests: None,
        e2e_latency_ms: None,
        prompt_tokens_per_sec: if blank {
            None
        } else {
            rates.prompt_tokens_per_sec
        },
        avg_prompt_tokens_per_sec: if blank {
            None
        } else {
            rates.avg_prompt_tokens_per_sec
        },
        per_request_prompt_tps: None,
        swapped_requests: None,
        prefix_cache_hit_rate: None,
        queue_time_ms: None,
        inter_token_latency_ms: if blank { None } else { inter_token_latency_ms },
        preemptions_total: None,
        total_prompt_tokens: tokens("llamacpp_prompt_tokens_total"),
        total_generation_tokens: tokens("llamacpp_tokens_predicted_total"),
        prefix_cache_queries_total: None,
        avg_batch_size: None,
        ttft_percentiles: None,
        itl_percentiles: None,
        e2e_percentiles: None,
        ttft_goodput_pct: None,
        itl_goodput_pct: None,
        e2e_goodput_pct: None,
        ttft_buckets: None,
        itl_buckets: None,
        e2e_buckets: None,
        tpot_ms: None,
        tpot_percentiles: None,
        tpot_goodput_pct: None,
        tpot_buckets: None,
        spec_decode_draft_tokens_total: spec_total(|c| c.draft),
        spec_decode_accepted_tokens_total: spec_total(|c| c.accepted),
        spec_decode_drafts_total: spec_total(|c| c.drafts),
        spec_decode_acceptance_rate: speculating
            .and_then(|c| spec_acceptance_rate(Some(c.accepted), Some(c.draft))),
        spec_decode_acceptance_rate_live: speculating.and(spec.live_rate).filter(|_| !blank),
        spec_decode_mean_acceptance_length: speculating
            .and_then(|c| spec_mean_acceptance_length(Some(c.accepted), Some(c.drafts))),
        warming_up,
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_server::{Headers, Request, TestServer};
    use super::super::{DeploymentMode, EngineState};
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
    use std::sync::Arc;

    // Byte-exact answers of llama-server v0.7.0 (build b11669) on a DGX Spark
    // (9e926ef); a status other than 200 is in the file name.
    const HEALTH: &str = include_str!("fixtures/llamacpp_health.json");
    const HEALTH_LOADING: &str = include_str!("fixtures/llamacpp_health_loading_503.json");
    const METRICS: &str = include_str!("fixtures/llamacpp_metrics.txt");
    const METRICS_ZERO: &str = include_str!("fixtures/llamacpp_metrics_zero.txt");
    const METRICS_BUSY: &str = include_str!("fixtures/llamacpp_metrics_busy.txt");
    const METRICS_SPEC_DRAFT: &str = include_str!("fixtures/llamacpp_metrics_spec_draft.txt");
    const METRICS_SPEC_NGRAM: &str = include_str!("fixtures/llamacpp_metrics_spec_ngram.txt");
    const METRICS_OFF: &str = include_str!("fixtures/llamacpp_metrics_off_501.json");
    const NO_KEY: &str = include_str!("fixtures/llamacpp_metrics_no_key_401.json");
    const PROPS: &str = include_str!("fixtures/llamacpp_props.json");
    const PROPS_SLEEPING: &str = include_str!("fixtures/llamacpp_props_sleeping.json");
    const SLOTS_IDLE: &str = include_str!("fixtures/llamacpp_slots_idle.json");
    const SLOTS_BUSY: &str = include_str!("fixtures/llamacpp_slots_busy.json");
    const MODELS: &str = include_str!("fixtures/llamacpp_v1_models.json");
    const MODELS_ALIAS: &str = include_str!("fixtures/llamacpp_v1_models_alias.json");
    const ROUTER_PROPS: &str = include_str!("fixtures/llamacpp_router_props.json");
    const ROUTER_METRICS: &str = include_str!("fixtures/llamacpp_router_metrics_400.json");
    const ROUTER_MODELS: &str = include_str!("fixtures/llamacpp_router_models.json");
    const ROUTER_MODELS_LOADED: &str = include_str!("fixtures/llamacpp_router_models_loaded.json");

    /// The routes that neither reset llama-server's idle timer nor wake it
    /// from sleep — the README's list, confirmed live by polling each every
    /// 2 s against a 10 s `--sleep-idle-seconds`. `/slots` is not among them.
    const SLEEP_EXEMPT: [&str; 4] = ["/health", "/metrics", "/props", "/models"];

    /// The model `MODELS` names: the `-m` path as given, no alias.
    const MODEL_PATH: &str =
        "/home/niklas/llamacpp-capture/models/qwen2.5-1.5b-instruct-q4_k_m.gguf";

    fn parsed(body: &str) -> ParsedMetrics {
        parse_llamacpp(body).expect("a llama-server scrape")
    }

    /// `engine_metrics` for a scrape no baseline has been subtracted from.
    fn map(body: &str, rates: RateInputs, warming: bool, spec: SpecInputs) -> EngineMetrics {
        let p = parsed(body);
        engine_metrics(&p, &p, rates, warming, spec)
    }

    fn some_rates() -> RateInputs {
        RateInputs {
            tokens_per_sec: Some(150.0),
            prompt_tokens_per_sec: Some(1000.0),
            avg_tokens_per_sec: Some(140.0),
            avg_prompt_tokens_per_sec: Some(900.0),
        }
    }

    fn assert_close(got: Option<f64>, want: f64) {
        let got = got.expect("a value");
        assert!((got - want).abs() < 1e-9, "got {got}, want {want}");
    }

    fn json(metrics: &EngineMetrics) -> serde_json::Value {
        serde_json::to_value(metrics).unwrap()
    }

    /// The wire names of the fields `metrics` fills — those that differ from
    /// a blank `EngineMetrics`.
    fn filled(metrics: &EngineMetrics) -> BTreeSet<String> {
        let blank = json(&EngineMetrics::default());
        json(metrics)
            .as_object()
            .unwrap()
            .iter()
            .filter(|(key, value)| blank[key.as_str()] != **value)
            .map(|(key, _)| key.clone())
            .collect()
    }

    fn adapter(url: &str) -> LlamaCppAdapter {
        LlamaCppAdapter::new(reqwest::Client::new(), url.into(), None, None)
    }

    fn http(url: &str, key: Option<&str>) -> EngineHttp {
        EngineHttp::new(reqwest::Client::new(), url.into(), key.map(str::to_owned))
    }

    fn named(server: &str) -> Headers {
        vec![("Server", server.to_string())]
    }

    /// A llama-server answering each path as `routes` says, every reply
    /// carrying the `Server: llama.cpp` header the real one sends.
    async fn llama_server(
        routes: impl Fn(&str) -> (u16, String) + Send + Sync + 'static,
    ) -> TestServer {
        TestServer::start_with_headers(move |r: &Request| {
            let (status, body) = routes(r.path.as_str());
            (status, body, named("llama.cpp"))
        })
        .await
    }

    /// A ready server started with `--metrics`, idle, as captured.
    fn idle(path: &str) -> (u16, String) {
        match path {
            "/health" => (200, HEALTH.into()),
            "/metrics" => (200, METRICS.into()),
            "/props" => (200, PROPS.into()),
            "/models" | "/v1/models" => (200, MODELS.into()),
            "/slots" => (200, SLOTS_IDLE.into()),
            _ => (404, "File Not Found".into()),
        }
    }

    /// The same server with two requests in its slots and one deferred.
    fn busy(path: &str) -> (u16, String) {
        match path {
            "/metrics" => (200, METRICS_BUSY.into()),
            "/slots" => (200, SLOTS_BUSY.into()),
            _ => idle(path),
        }
    }

    /// A router (`--models-dir`, no model), as captured.
    fn router(path: &str) -> (u16, String) {
        match path {
            "/health" => (200, HEALTH.into()),
            "/props" => (200, ROUTER_PROPS.into()),
            "/metrics" | "/slots" => (400, ROUTER_METRICS.into()),
            "/models" | "/v1/models" => (200, ROUTER_MODELS.into()),
            _ => (404, "File Not Found".into()),
        }
    }

    /// A server started with `--api-key` the dashboard was not given: every
    /// route but `/health` refuses it, the same way.
    fn keyed(path: &str) -> (u16, String) {
        match path {
            "/health" => (200, HEALTH.into()),
            _ => (401, NO_KEY.into()),
        }
    }

    fn paths(server: &TestServer) -> Vec<String> {
        server.requests().into_iter().map(|r| r.path).collect()
    }

    // --- engine type ------------------------------------------------------

    #[test]
    fn llama_cpp_travels_as_llamacpp_and_reads_as_llama_dot_cpp() {
        assert_eq!(
            serde_json::to_value(EngineType::LlamaCpp).unwrap(),
            serde_json::json!("LlamaCpp")
        );
        assert_eq!(EngineType::LlamaCpp.to_string(), "llama.cpp");
        assert_eq!(
            adapter("http://127.0.0.1:1").engine_type(),
            EngineType::LlamaCpp
        );
    }

    /// v0.7.0 listens on 9931 by default, every release before it on 8080,
    /// and the official images set `LLAMA_ARG_PORT=8080`.
    #[test]
    fn default_ports_put_the_likelier_one_first_for_each_deployment() {
        assert_eq!(default_ports(&DeploymentMode::Native), [9931, 8080]);
        assert_eq!(default_ports(&DeploymentMode::Docker), [8080, 9931]);
    }

    // --- identification ---------------------------------------------------

    #[test]
    fn a_server_header_of_llama_cpp_names_it_and_any_other_rules_it_out() {
        assert_eq!(server_names_llamacpp(Some("llama.cpp")), Some(true));
        assert_eq!(server_names_llamacpp(Some(" Llama.CPP ")), Some(true));
        assert_eq!(server_names_llamacpp(Some("llama.cpp/0.7.0")), Some(true));
        assert_eq!(server_names_llamacpp(Some("uvicorn")), Some(false));
        assert_eq!(server_names_llamacpp(Some("llama.cpp-proxy")), Some(false));
        assert_eq!(server_names_llamacpp(None), None);
    }

    #[test]
    fn without_a_header_health_and_props_must_answer_in_llama_servers_shapes() {
        assert!(health_answers_like_llamacpp(200, HEALTH));
        assert!(health_answers_like_llamacpp(503, HEALTH_LOADING));
        // vLLM's and SGLang's `/health` answer 200 with an empty body.
        assert!(!health_answers_like_llamacpp(200, ""));
        assert!(!health_answers_like_llamacpp(404, "404 page not found"));
        assert!(!health_answers_like_llamacpp(503, ""));

        assert!(props_answers_like_llamacpp(200, PROPS));
        assert!(props_answers_like_llamacpp(200, ROUTER_PROPS));
        assert!(props_answers_like_llamacpp(401, NO_KEY));
        assert!(props_answers_like_llamacpp(503, HEALTH_LOADING));
        assert!(!props_answers_like_llamacpp(200, "{}"));
        assert!(!props_answers_like_llamacpp(404, "Not Found"));
    }

    /// One request, to the public `/health`, with the endpoint's key like
    /// every other probe; the 503 of a loading model identifies as well.
    #[tokio::test]
    async fn a_llama_server_is_identified_by_its_server_header() {
        let server = llama_server(idle).await;
        assert!(identify(&http(&server.url, Some("k"))).await);
        assert_eq!(
            server.requests(),
            [Request {
                path: "/health".into(),
                authorization: Some("Bearer k".into()),
            }]
        );

        let loading = llama_server(|_| (503, HEALTH_LOADING.into())).await;
        assert!(identify(&http(&loading.url, None)).await);
    }

    /// A proxy that strips `Server` leaves the bodies to decide: llama-server's
    /// `/health`, then its own `/props` or a key-gated one.
    #[tokio::test]
    async fn without_the_header_the_answers_identify_it() {
        let cases: [(&str, u16, &str, bool); 4] = [
            ("props", 200, PROPS, true),
            ("keyed", 401, NO_KEY, true),
            ("loading", 503, HEALTH_LOADING, true),
            ("no props", 404, "Not Found", false),
        ];
        for (case, props_status, props, expected) in cases {
            let server = TestServer::start(move |r| match r.path.as_str() {
                "/health" if props_status == 503 => (503, HEALTH_LOADING.into()),
                "/health" => (200, HEALTH.into()),
                "/props" => (props_status, props.into()),
                _ => (404, String::new()),
            })
            .await;
            assert_eq!(
                identify(&http(&server.url, Some("k"))).await,
                expected,
                "{case}"
            );
            assert!(
                server
                    .requests()
                    .iter()
                    .all(|r| r.authorization.as_deref() == Some("Bearer k")),
                "{case}"
            );
        }
    }

    /// vLLM and SGLang (uvicorn, which names itself) and Ollama (no header,
    /// no `/health`) are not llama.cpp — nor are vLLM and SGLang behind a
    /// proxy that strips the header, whose empty `/health` is not
    /// llama-server's. A llama.cpp-shaped `/props` does not outvote a
    /// `Server` header naming someone else.
    #[tokio::test]
    async fn vllm_sglang_and_ollama_servers_are_not_llama_cpp() {
        type Route = fn(&str) -> (u16, String);
        let vllm: Route = |path| match path {
            "/health" => (200, String::new()),
            "/v1/models" => (200, r#"{"object":"list","data":[{"id":"m"}]}"#.into()),
            _ => (404, r#"{"detail":"Not Found"}"#.into()),
        };
        // SGLang with `--api-key` gates `/props` like llama-server does.
        let sglang: Route = |path| match path {
            "/health" | "/ready" => (200, String::new()),
            _ => (401, r#"{"error":"Unauthorized"}"#.into()),
        };
        let lookalike: Route = |path| match path {
            "/health" => (200, HEALTH.into()),
            "/props" => (200, PROPS.into()),
            _ => (404, String::new()),
        };
        let ollama: Route = |path| match path {
            "/api/version" => (200, r#"{"version":"0.19.0"}"#.into()),
            "/" => (200, "Ollama is running".into()),
            _ => (404, "404 page not found".into()),
        };
        let cases: [(&str, Route, Option<&str>); 6] = [
            ("vLLM", vllm, Some("uvicorn")),
            ("SGLang", sglang, Some("uvicorn")),
            ("vLLM behind a proxy", vllm, None),
            ("SGLang behind a proxy", sglang, None),
            (
                "uvicorn serving llama-shaped bodies",
                lookalike,
                Some("uvicorn"),
            ),
            ("Ollama", ollama, None),
        ];
        for (case, route, server_header) in cases {
            let server = TestServer::start_with_headers(move |r| {
                let (status, body) = route(r.path.as_str());
                (status, body, server_header.map(named).unwrap_or_default())
            })
            .await;
            assert!(!identify(&http(&server.url, None)).await, "{case}");
        }
    }

    // --- health -----------------------------------------------------------

    #[test]
    fn health_reads_running_loading_or_the_error() {
        assert_eq!(health_status(StatusCode::OK, HEALTH), EngineStatus::Running);
        assert_eq!(
            health_status(StatusCode::SERVICE_UNAVAILABLE, HEALTH_LOADING),
            EngineStatus::Loading
        );
        assert_eq!(
            health_status(
                StatusCode::SERVICE_UNAVAILABLE,
                r#"{"error":{"code":503,"message":"no slot available","type":"unavailable_error"}}"#
            ),
            EngineStatus::Error("HTTP 503 Service Unavailable".into())
        );
        assert_eq!(
            health_status(StatusCode::INTERNAL_SERVER_ERROR, ""),
            EngineStatus::Error("HTTP 500 Internal Server Error".into())
        );
    }

    #[tokio::test]
    async fn health_is_asked_of_health_alone() {
        let server = llama_server(idle).await;
        assert_eq!(
            adapter(&server.url).health_check().await,
            EngineStatus::Running
        );
        assert_eq!(paths(&server), ["/health"]);

        let loading = llama_server(|_| (503, HEALTH_LOADING.into())).await;
        assert_eq!(
            adapter(&loading.url).health_check().await,
            EngineStatus::Loading
        );
    }

    // --- the metrics endpoint ---------------------------------------------

    #[test]
    fn each_metrics_answer_means_one_thing() {
        assert_eq!(metrics_answer(200), MetricsAnswer::On);
        assert_eq!(metrics_answer(501), MetricsAnswer::Off);
        assert_eq!(metrics_answer(401), MetricsAnswer::Refused);
        assert_eq!(metrics_answer(403), MetricsAnswer::Refused);
        assert_eq!(metrics_answer(400), MetricsAnswer::NeedsModel);
        for status in [503, 500, 404, 429] {
            assert_eq!(metrics_answer(status), MetricsAnswer::Transient, "{status}");
        }
    }

    /// The state after each answer, from every state, for a server with a
    /// model of its own or one whose role is not known yet. A refused key is
    /// never metrics off, and metrics off is never a refused key; a router's
    /// question is neither; a transient answer changes nothing.
    #[test]
    fn a_refused_key_never_latches_metrics_off() {
        use MetricsAccess::{Off, Open, Refused};
        for role in [None, Some(Role::SingleModel)] {
            for was in [Open, Off, Refused] {
                let after = |answer| latched(answer, was, role);
                assert_eq!(after(MetricsAnswer::Refused), Refused, "{role:?} {was:?}");
                assert_eq!(after(MetricsAnswer::Off), Off, "{role:?} {was:?}");
                assert_eq!(after(MetricsAnswer::On), Open, "{role:?} {was:?}");
                assert_eq!(after(MetricsAnswer::NeedsModel), Open, "{role:?} {was:?}");
                assert_eq!(after(MetricsAnswer::Transient), was, "{role:?} {was:?}");
            }
        }
    }

    /// Once the role is known to be a router's, no answer from any state is
    /// metrics off — a 501 included, and a transient answer after an off
    /// latched before the role was known. A refused key stays refused.
    #[test]
    fn a_known_router_never_latches_metrics_off() {
        use MetricsAccess::{Off, Open, Refused};
        let router = Some(Role::Router);
        for was in [Open, Off, Refused] {
            for answer in [
                MetricsAnswer::On,
                MetricsAnswer::Off,
                MetricsAnswer::Refused,
                MetricsAnswer::NeedsModel,
                MetricsAnswer::Transient,
            ] {
                assert_ne!(latched(answer, was, router), Off, "{answer:?} {was:?}");
            }
            assert_eq!(latched(MetricsAnswer::Off, was, router), Open, "{was:?}");
            assert_eq!(latched(MetricsAnswer::Refused, was, router), Refused);
        }
    }

    /// Started without `--metrics`: running, with metrics off naming the
    /// flag — until it answers with metrics.
    #[tokio::test]
    async fn metrics_off_latches_on_501_and_clears_once_metrics_answer() {
        let relaunched = Arc::new(AtomicBool::new(false));
        let flag = relaunched.clone();
        let server = llama_server(move |path| match path {
            "/metrics" if !flag.load(Ordering::SeqCst) => (501, METRICS_OFF.into()),
            _ => idle(path),
        })
        .await;
        let adapter = adapter(&server.url);
        assert!(adapter.get_metrics().await.is_none());
        assert!(adapter.metrics_off());
        assert_eq!(adapter.metrics_error(), None);
        assert_eq!(adapter.metrics_launch_flag(), Some("--metrics"));

        // A model loading after a restart answers 503 everywhere: that says
        // nothing about the flag.
        let loading = llama_server(|_| (503, HEALTH_LOADING.into())).await;
        let reloading =
            LlamaCppAdapter::new(reqwest::Client::new(), loading.url.clone(), None, None);
        *lock(&reloading.metrics_access) = MetricsAccess::Off;
        assert!(reloading.get_metrics().await.is_none());
        assert!(reloading.metrics_off());

        relaunched.store(true, Ordering::SeqCst);
        assert!(adapter.get_metrics().await.is_some());
        assert!(!adapter.metrics_off());
    }

    /// `--api-key` without the key here: `/metrics` refuses it (whether or
    /// not `--metrics` was given — the key is checked first), and that is
    /// metrics refused, never metrics off. Once the key is accepted the
    /// refusal clears.
    #[tokio::test]
    async fn a_refused_key_reads_as_metrics_refused_not_metrics_off() {
        let key_given = Arc::new(AtomicBool::new(false));
        let given = key_given.clone();
        let server = llama_server(move |path| {
            if given.load(Ordering::SeqCst) {
                idle(path)
            } else {
                keyed(path)
            }
        })
        .await;
        let mut state = EngineState::new(Box::new(adapter(&server.url)), DeploymentMode::Native);
        let json = serde_json::to_value(state.poll().await).unwrap();
        assert_eq!(json["status"], serde_json::json!({"type": "Running"}));
        assert_eq!(json["metrics_error"], "AuthRequired");
        assert_eq!(json["metrics_off"], serde_json::Value::Null);
        assert_eq!(json["metrics"], serde_json::Value::Null);
        assert_eq!(json["model_metadata_error"], "AuthRequired");

        key_given.store(true, Ordering::SeqCst);
        let json = serde_json::to_value(state.poll().await).unwrap();
        assert_eq!(json["metrics_error"], serde_json::Value::Null);
        assert_eq!(json["metrics_off"], serde_json::Value::Null);
        assert!(json["metrics"].is_object());
    }

    // --- /props and /models -----------------------------------------------

    #[test]
    fn props_say_the_role_and_whether_slots_are_served() {
        let server = ServerFacts {
            role: Role::SingleModel,
            slots_endpoint: true,
        };
        assert_eq!(
            classify_props_answer(200, PROPS),
            PropsAnswer::Facts(server)
        );
        // Asleep, `/props` is the same but for `is_sleeping`.
        assert_eq!(
            classify_props_answer(200, PROPS_SLEEPING),
            PropsAnswer::Facts(server)
        );
        assert_eq!(
            classify_props_answer(200, ROUTER_PROPS),
            PropsAnswer::Facts(ServerFacts {
                role: Role::Router,
                slots_endpoint: false,
            })
        );
        assert_eq!(classify_props_answer(401, NO_KEY), PropsAnswer::Refused);
        assert_eq!(
            classify_props_answer(503, HEALTH_LOADING),
            PropsAnswer::Failed
        );
        assert_eq!(classify_props_answer(200, "not json"), PropsAnswer::Failed);
    }

    fn model(name: &str, parameter_size: &str) -> ModelInfo {
        ModelInfo {
            parameter_size: Some(parameter_size.into()),
            quantization: Some("Q4_K - Medium".into()),
            ..ModelInfo::named(name)
        }
    }

    #[test]
    fn models_name_the_model_its_size_and_its_quantization() {
        assert_eq!(
            classify_models_answer(200, MODELS),
            ModelsAnswer::Model(model(MODEL_PATH, "1.8B params"))
        );
        // `-hf … -a qwen-small,qwen-tiny`: the first alias.
        assert_eq!(
            classify_models_answer(200, MODELS_ALIAS),
            ModelsAnswer::Model(model("qwen-small", "630.2M params"))
        );
        // A router lists every model it can load, each with a status.
        assert_eq!(
            classify_models_answer(200, ROUTER_MODELS),
            ModelsAnswer::Router
        );
        assert_eq!(
            classify_models_answer(200, ROUTER_MODELS_LOADED),
            ModelsAnswer::Router
        );

        assert_eq!(
            classify_models_answer(401, NO_KEY),
            ModelsAnswer::Failed(ModelMetadataError::AuthRequired)
        );
        for (status, body) in [
            (503, HEALTH_LOADING),
            (200, r#"{"object":"list","data":[]}"#),
            // The Ollama-shaped array alone names nothing.
            (200, r#"{"models":[{"name":"m","model":"m"}]}"#),
            (200, "not json"),
        ] {
            assert_eq!(
                classify_models_answer(status, body),
                ModelsAnswer::Failed(ModelMetadataError::Unavailable),
                "{status} {body}"
            );
        }
    }

    #[test]
    fn a_failed_models_answer_falls_back_to_the_command_line_name_and_says_why() {
        let fallback = resolution(
            ModelsAnswer::Failed(ModelMetadataError::AuthRequired),
            Some("qwen-small"),
        );
        assert_eq!(
            fallback.model.map(|m| m.name).as_deref(),
            Some("qwen-small")
        );
        assert_eq!(
            fallback.metadata_error,
            Some(ModelMetadataError::AuthRequired)
        );

        let router = resolution(ModelsAnswer::Router, Some("qwen-small"));
        assert!(router.model.is_none());
        assert_eq!(router.metadata_error, None);
    }

    /// A key-gated `/props` ends the lookup: `/models` would refuse alike.
    #[tokio::test]
    async fn a_refused_props_names_the_command_line_model_and_says_why() {
        let server = llama_server(keyed).await;
        let adapter = LlamaCppAdapter::new(
            reqwest::Client::new(),
            server.url.clone(),
            Some("qwen-small".into()),
            None,
        );
        let resolution = adapter.get_model_info().await;
        assert_eq!(
            resolution.metadata_error,
            Some(ModelMetadataError::AuthRequired)
        );
        assert_eq!(
            resolution.model.map(|m| m.name).as_deref(),
            Some("qwen-small")
        );
        assert_eq!(paths(&server), ["/props"]);
    }

    // --- /slots and the live generation rate ------------------------------

    #[test]
    fn slots_count_what_the_requests_in_flight_have_decoded() {
        // Two requests at 222 and 221 tokens, which `tokens_predicted_total`
        // (0 in the scrape taken beside it) does not count yet.
        assert_eq!(
            parse_slots(SLOTS_BUSY),
            Some(Slots {
                decoded_in_flight: 443,
                speculative: false,
            })
        );
        assert_eq!(
            parse_slots(SLOTS_IDLE),
            Some(Slots {
                decoded_in_flight: 0,
                speculative: false,
            })
        );
        // `--spec-type draft-simple`, idle.
        assert_eq!(
            parse_slots(r#"[{"id":0,"n_ctx":4096,"speculative":true,"is_processing":false}]"#),
            Some(Slots {
                decoded_in_flight: 0,
                speculative: true,
            })
        );
        assert_eq!(parse_slots(ROUTER_METRICS), None);
        assert_eq!(parse_slots("not json"), None);
    }

    #[test]
    fn slots_are_asked_only_while_a_request_is_processing_and_the_route_is_served() {
        assert!(should_read_slots(Some(2.0), Some(true)));
        assert!(!should_read_slots(Some(0.0), Some(true)));
        assert!(!should_read_slots(None, Some(true)));
        assert!(!should_read_slots(Some(2.0), Some(false)));
        assert!(!should_read_slots(Some(2.0), None));
    }

    #[test]
    fn the_generated_count_adds_the_requests_in_flight_and_never_goes_back() {
        assert_eq!(live_generated(Some(0.0), Some(443), None), Some(443.0));
        assert_eq!(
            live_generated(Some(1803.0), None, Some(1700.0)),
            Some(1803.0)
        );
        // A request finished between the scrape and `/slots`: in neither,
        // for one tick.
        assert_eq!(
            live_generated(Some(100.0), Some(0), Some(300.0)),
            Some(300.0)
        );
        assert_eq!(live_generated(None, Some(443), Some(300.0)), None);
    }

    // --- the mapping ------------------------------------------------------

    /// The whole ADR-0004 contract over a real scrape: each field llama-server
    /// has a series for carries the captured value, and every other field
    /// stays empty — no zero, no estimate, no stand-in.
    #[test]
    fn the_real_scrape_maps_onto_the_fields_llama_cpp_reports() {
        let m = map(METRICS, some_rates(), false, SpecInputs::default());
        assert_eq!(m.tokens_per_sec, Some(150.0));
        assert_eq!(m.avg_tokens_per_sec, Some(140.0));
        assert_eq!(m.prompt_tokens_per_sec, Some(1000.0));
        assert_eq!(m.avg_prompt_tokens_per_sec, Some(900.0));
        assert_eq!(m.total_prompt_tokens, Some(152));
        assert_eq!(m.total_generation_tokens, Some(1803));
        assert_eq!(m.active_requests, Some(0));
        assert_eq!(m.queued_requests, Some(0));
        // 11.4002 s over 1803 tokens.
        assert_close(m.inter_token_latency_ms, 11.4002 / 1803.0 * 1000.0);

        // Absent, enumerated: the moment one gains a value from a stand-in,
        // this is where a reviewer sees it.
        assert_eq!(m.ttft_ms, None, "mean prefill time is not TTFT");
        assert_eq!(m.e2e_latency_ms, None);
        assert_eq!(m.total_requests, None, "llama-server counts no requests");
        assert_eq!(m.queue_time_ms, None);
        assert_eq!(m.tpot_ms, None);
        assert_eq!(m.per_request_tps, None);
        assert_eq!(m.per_request_prompt_tps, None);
        assert_eq!(m.avg_batch_size, None);
        assert_eq!(m.kv_cache_percent, None);
        assert!(!m.kv_cache_is_estimated);
        assert_eq!(m.prefix_cache_hit_rate, None);
        assert_eq!(m.prefix_cache_queries_total, None);
        assert_eq!(m.preemptions_total, None);
        assert_eq!(m.swapped_requests, None);
        assert!(m.ttft_percentiles.is_none() && m.ttft_buckets.is_none());
        assert!(m.itl_percentiles.is_none() && m.itl_buckets.is_none());
        assert!(m.e2e_percentiles.is_none() && m.e2e_buckets.is_none());
        assert!(m.tpot_percentiles.is_none() && m.tpot_buckets.is_none());
        assert_eq!(m.ttft_goodput_pct, None);
        assert_eq!(m.itl_goodput_pct, None);
        assert_eq!(m.e2e_goodput_pct, None);
        assert_eq!(m.tpot_goodput_pct, None);
        // No drafter: the three counters read 0, which is not speculating.
        assert_eq!(m.spec_decode_draft_tokens_total, None);
        assert_eq!(m.spec_decode_accepted_tokens_total, None);
        assert_eq!(m.spec_decode_drafts_total, None);
        assert_eq!(m.spec_decode_acceptance_rate, None);
        assert_eq!(m.spec_decode_acceptance_rate_live, None);
        assert_eq!(m.spec_decode_mean_acceptance_length, None);
        assert!(!m.warming_up);

        // …and nothing else is filled at all.
        assert_eq!(
            filled(&m),
            [
                "active_requests",
                "avg_prompt_tokens_per_sec",
                "avg_tokens_per_sec",
                "inter_token_latency_ms",
                "prompt_tokens_per_sec",
                "queued_requests",
                "tokens_per_sec",
                "total_generation_tokens",
                "total_prompt_tokens",
            ]
            .map(String::from)
            .into(),
        );
    }

    /// The `*_tokens_seconds` gauges are a window that every scrape resets —
    /// any other scraper steals it — so the rates come from the counters,
    /// and a mapping given no rates invents none.
    #[test]
    fn the_per_scrape_throughput_gauges_are_not_read() {
        let m = map(METRICS, RateInputs::default(), false, SpecInputs::default());
        assert_eq!(m.tokens_per_sec, None);
        assert_eq!(m.prompt_tokens_per_sec, None);
        assert_eq!(m.avg_tokens_per_sec, None);
        assert_eq!(m.avg_prompt_tokens_per_sec, None);
    }

    #[test]
    fn a_busy_scrape_counts_the_requests_running_and_deferred() {
        let m = map(
            METRICS_BUSY,
            RateInputs::default(),
            false,
            SpecInputs::default(),
        );
        assert_eq!(m.active_requests, Some(2));
        assert_eq!(m.queued_requests, Some(1));
        // Nothing finished yet: no tokens, so no mean.
        assert_eq!(m.total_generation_tokens, Some(0));
        assert_eq!(m.inter_token_latency_ms, None);
    }

    #[test]
    fn a_drafters_counters_fill_the_speculative_decoding_group() {
        let spec = SpecInputs {
            drafter: None,
            live_rate: Some(90.0),
        };
        // `-md … --spec-type draft-simple`, after six completions.
        let m = map(METRICS_SPEC_DRAFT, RateInputs::default(), false, spec);
        assert_eq!(m.spec_decode_draft_tokens_total, Some(244));
        assert_eq!(m.spec_decode_accepted_tokens_total, Some(238));
        assert_eq!(m.spec_decode_drafts_total, Some(83));
        assert_close(m.spec_decode_acceptance_rate, 238.0 / 244.0 * 100.0);
        assert_close(m.spec_decode_mean_acceptance_length, 238.0 / 83.0);
        assert_eq!(m.spec_decode_acceptance_rate_live, Some(90.0));
        assert_close(m.inter_token_latency_ms, 1.67528 / 328.0 * 1000.0);

        // `--spec-type ngram-mod`: long drafts, few of them.
        let m = map(METRICS_SPEC_NGRAM, RateInputs::default(), false, spec);
        assert_eq!(m.spec_decode_draft_tokens_total, Some(192));
        assert_eq!(m.spec_decode_accepted_tokens_total, Some(111));
        assert_eq!(m.spec_decode_drafts_total, Some(3));
        assert_close(m.spec_decode_acceptance_rate, 111.0 / 192.0 * 100.0);
        assert_close(m.spec_decode_mean_acceptance_length, 37.0);
    }

    /// llama-server serves its spec counters at 0 without a drafter. Zero is
    /// "not using speculative decoding" — unless `/slots` has said a slot
    /// speculates, and then it is "drafted nothing yet".
    #[test]
    fn zero_spec_counters_speculate_only_when_slots_said_a_drafter_is_configured() {
        for drafter in [None, Some(false)] {
            let spec = SpecInputs {
                drafter,
                live_rate: None,
            };
            let m = map(METRICS_ZERO, RateInputs::default(), false, spec);
            assert_eq!(m.spec_decode_draft_tokens_total, None, "{drafter:?}");
            assert_eq!(m.spec_decode_drafts_total, None, "{drafter:?}");
        }
        let spec = SpecInputs {
            drafter: Some(true),
            live_rate: None,
        };
        let m = map(METRICS_ZERO, RateInputs::default(), false, spec);
        assert_eq!(m.spec_decode_draft_tokens_total, Some(0));
        assert_eq!(m.spec_decode_accepted_tokens_total, Some(0));
        assert_eq!(m.spec_decode_drafts_total, Some(0));
        assert_eq!(m.spec_decode_acceptance_rate, None);
        assert_eq!(m.spec_decode_mean_acceptance_length, None);
    }

    #[test]
    fn warming_blanks_what_a_delta_needs_and_nothing_else() {
        let spec = SpecInputs {
            drafter: None,
            live_rate: Some(90.0),
        };
        let m = map(METRICS_SPEC_DRAFT, some_rates(), true, spec);
        assert!(m.warming_up);
        assert_eq!(m.tokens_per_sec, None);
        assert_eq!(m.avg_tokens_per_sec, None);
        assert_eq!(m.prompt_tokens_per_sec, None);
        assert_eq!(m.avg_prompt_tokens_per_sec, None);
        assert_eq!(m.inter_token_latency_ms, None);
        assert_eq!(m.spec_decode_acceptance_rate_live, None);
        // Readings of the scrape itself pass through.
        assert_eq!(m.active_requests, Some(0));
        assert_eq!(m.total_generation_tokens, Some(328));
        assert_eq!(m.spec_decode_draft_tokens_total, Some(244));
        assert!(m.spec_decode_acceptance_rate.is_some());
    }

    /// The declaration and the mapping agree both ways, over the real
    /// scrapes: nothing the mapping fills is outside a declared group, and
    /// each declared group is one a real scrape fills.
    #[test]
    fn a_server_declares_exactly_the_groups_its_scrape_fills() {
        let groups = adapter("http://127.0.0.1:1").metric_groups();
        assert_eq!(
            groups,
            BTreeSet::from([
                MetricGroup::Throughput,
                MetricGroup::ActiveRequests,
                MetricGroup::SpeculativeDecoding,
                MetricGroup::ItlMean,
            ])
        );
        let spec = SpecInputs {
            drafter: Some(true),
            live_rate: Some(90.0),
        };
        for body in [
            METRICS,
            METRICS_BUSY,
            METRICS_SPEC_DRAFT,
            METRICS_SPEC_NGRAM,
        ] {
            let m = map(body, some_rates(), false, spec);
            assert_eq!(json(&m.clone().reported_only(&groups)), json(&m));
        }
        let m = map(METRICS_SPEC_DRAFT, some_rates(), false, spec);
        for group in &groups {
            assert_ne!(
                json(&m.clone().reported_only(&BTreeSet::from([*group]))),
                json(&EngineMetrics::default()),
                "the real scrape fills {group:?}"
            );
        }
    }

    #[test]
    fn only_llamacpp_series_count_as_the_engines() {
        assert!(parse_llamacpp("# only a comment\n").is_none());
        assert!(parse_llamacpp("process_open_fds 12\n").is_none());
        assert!(parse_llamacpp(METRICS).is_some());
    }

    // --- whole ticks --------------------------------------------------------

    async fn snapshot_json(state: &mut EngineState) -> serde_json::Value {
        serde_json::to_value(state.poll().await).unwrap()
    }

    #[tokio::test]
    async fn a_server_snapshot_names_its_model_and_the_groups_it_reports() {
        let server = llama_server(idle).await;
        let mut state = EngineState::new(Box::new(adapter(&server.url)), DeploymentMode::Native);
        let json = snapshot_json(&mut state).await;

        assert_eq!(json["engine_type"], "LlamaCpp");
        assert_eq!(json["status"], serde_json::json!({"type": "Running"}));
        assert_eq!(json["model"]["name"], MODEL_PATH);
        assert_eq!(json["model"]["parameter_size"], "1.8B params");
        assert_eq!(json["model"]["quantization"], "Q4_K - Medium");
        assert_eq!(json["model_metadata_error"], serde_json::Value::Null);
        assert_eq!(
            json["metric_groups"],
            serde_json::json!([
                "Throughput",
                "ActiveRequests",
                "SpeculativeDecoding",
                "ItlMean"
            ])
        );
        assert_eq!(json["metrics_off"], serde_json::Value::Null);
        assert_eq!(json["metrics_error"], serde_json::Value::Null);
        assert_eq!(json["loaded_models"], serde_json::Value::Null);
        assert_eq!(json["metrics"]["active_requests"], 0);
        // The first poll is the warmup baseline, so the totals count from 0.
        assert_eq!(json["metrics"]["total_generation_tokens"], 0);
        assert_eq!(json["metrics"]["total_prompt_tokens"], 0);
        assert_eq!(json["metrics"]["ttft_ms"], serde_json::Value::Null);
    }

    /// A router is a running engine at the floor: no metric group, no model,
    /// and its `/metrics` asking which model is not metrics off. Neither its
    /// model list nor `/slots` is asked.
    #[tokio::test]
    async fn a_router_runs_with_no_group_no_model_and_metrics_not_off() {
        let server = llama_server(router).await;
        let mut state = EngineState::new(Box::new(adapter(&server.url)), DeploymentMode::Native);
        for _ in 0..2 {
            let json = snapshot_json(&mut state).await;
            assert_eq!(json["engine_type"], "LlamaCpp");
            assert_eq!(json["status"], serde_json::json!({"type": "Running"}));
            assert_eq!(json["metric_groups"], serde_json::json!([]));
            assert_eq!(json["metrics"], serde_json::Value::Null);
            assert_eq!(json["metrics_off"], serde_json::Value::Null);
            assert_eq!(json["metrics_error"], serde_json::Value::Null);
            assert_eq!(json["model"], serde_json::Value::Null);
            assert_eq!(json["model_metadata_error"], serde_json::Value::Null);
        }
        assert!(paths(&server)
            .iter()
            .all(|p| p != "/models" && p != "/slots"));

        // Its `/metrics` alone says it is a router, before `/props` has.
        let unread = adapter(&server.url);
        assert!(unread.get_metrics().await.is_none());
        assert!(unread.metric_groups().is_empty());
        assert!(!unread.metrics_off());
    }

    /// The capture's router has `--metrics` and asks which model; one
    /// without it may answer 501, as a server does. Once `/props` has said it
    /// is a router, that is not metrics off either: a router reports no
    /// group with the flag or without, so naming the flag would promise
    /// panels a restart cannot fill.
    #[tokio::test]
    async fn a_router_never_reads_as_metrics_off() {
        let server = llama_server(|path| match path {
            "/metrics" => (501, METRICS_OFF.into()),
            _ => router(path),
        })
        .await;
        let mut state = EngineState::new(Box::new(adapter(&server.url)), DeploymentMode::Native);
        for _ in 0..2 {
            let json = snapshot_json(&mut state).await;
            assert_eq!(json["status"], serde_json::json!({"type": "Running"}));
            assert_eq!(json["metric_groups"], serde_json::json!([]));
            assert_eq!(json["metrics_off"], serde_json::Value::Null);
            assert_eq!(json["metrics_error"], serde_json::Value::Null);
        }
    }

    /// The idle-sleep rule: tick after tick, an idle server is asked only
    /// what does not reset its idle timer — never `/slots`, never
    /// `/v1/models`.
    #[tokio::test]
    async fn idle_ticks_ask_only_sleep_exempt_routes() {
        for props in [PROPS, PROPS_SLEEPING] {
            let server = llama_server(move |path| match path {
                "/props" => (200, props.into()),
                _ => idle(path),
            })
            .await;
            let mut state =
                EngineState::new(Box::new(adapter(&server.url)), DeploymentMode::Native);
            for _ in 0..5 {
                state.poll().await;
            }
            let asked = paths(&server);
            assert!(asked.contains(&"/metrics".to_string()));
            for path in &asked {
                assert!(SLEEP_EXEMPT.contains(&path.as_str()), "asked {path}");
            }
        }
    }

    /// `/slots` is asked on the ticks whose scrape shows a request in flight,
    /// and on no other.
    #[tokio::test]
    async fn slots_are_asked_only_on_busy_ticks() {
        let working = Arc::new(AtomicBool::new(false));
        let flag = working.clone();
        let server = llama_server(move |path| {
            if flag.load(Ordering::SeqCst) {
                busy(path)
            } else {
                idle(path)
            }
        })
        .await;
        let mut state = EngineState::new(Box::new(adapter(&server.url)), DeploymentMode::Native);
        let slots_asked = || paths(&server).iter().filter(|p| *p == "/slots").count();

        let mut seen = Vec::new();
        for busy_tick in [false, true, true, false, false] {
            working.store(busy_tick, Ordering::SeqCst);
            state.poll().await;
            seen.push(slots_asked());
        }
        assert_eq!(seen, [0, 1, 2, 2, 2]);
    }

    /// Started with `--no-slots`, `/props` says so, and a busy server is not
    /// asked a route it does not serve.
    #[tokio::test]
    async fn a_server_without_slots_is_never_asked_for_them() {
        let props = PROPS.replace(r#""endpoint_slots":true"#, r#""endpoint_slots":false"#);
        assert_ne!(props, PROPS, "the fixture names endpoint_slots");
        let server = llama_server(move |path| match path {
            "/props" => (200, props.clone()),
            _ => busy(path),
        })
        .await;
        let mut state = EngineState::new(Box::new(adapter(&server.url)), DeploymentMode::Native);
        for _ in 0..3 {
            state.poll().await;
        }
        assert!(paths(&server).iter().all(|p| p != "/slots"));
    }

    /// While the model loads every route answers 503: the engine reads as
    /// loading, and its model is asked for once it is ready rather than
    /// recorded as unavailable for the retry cooldown.
    #[tokio::test]
    async fn a_loading_server_is_asked_for_its_model_once_it_is_ready() {
        let ready = Arc::new(AtomicBool::new(false));
        let flag = ready.clone();
        let server = llama_server(move |path| {
            if flag.load(Ordering::SeqCst) {
                idle(path)
            } else {
                (503, HEALTH_LOADING.into())
            }
        })
        .await;
        let mut state = EngineState::new(Box::new(adapter(&server.url)), DeploymentMode::Native);

        let json = snapshot_json(&mut state).await;
        assert_eq!(json["status"], serde_json::json!({"type": "Loading"}));
        assert_eq!(json["model_metadata_error"], serde_json::Value::Null);
        assert!(paths(&server)
            .iter()
            .all(|p| p != "/props" && p != "/models"));

        ready.store(true, Ordering::SeqCst);
        let json = snapshot_json(&mut state).await;
        assert_eq!(json["status"], serde_json::json!({"type": "Running"}));
        assert_eq!(json["model"]["name"], MODEL_PATH);
    }

    /// `tokens_predicted_total` moves only when a request finishes, so a
    /// long generation would read 0 tokens/s until it ends. While it runs,
    /// the slots' decoded counts carry the rate; the token total, counted
    /// since the baseline, moves only when a request finishes.
    #[tokio::test]
    async fn the_generation_rate_moves_while_a_request_runs() {
        let decoded = Arc::new(AtomicU64::new(100));
        let served = decoded.clone();
        let server = llama_server(move |path| match path {
            "/slots" => (
                200,
                format!(
                    r#"[{{"id":0,"speculative":false,"is_processing":true,"next_token":[{{"n_decoded":{}}}]}}]"#,
                    served.load(Ordering::SeqCst)
                ),
            ),
            _ => busy(path),
        })
        .await;
        let adapter = adapter(&server.url);
        adapter.get_model_info().await;

        let first = adapter.get_metrics().await.expect("metrics");
        assert_eq!(first.tokens_per_sec, None, "a rate needs two readings");
        decoded.store(300, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(20)).await;
        let second = adapter.get_metrics().await.expect("metrics");
        assert!(
            second.tokens_per_sec.is_some_and(|tps| tps > 0.0),
            "{second:?}"
        );
        assert_eq!(second.total_generation_tokens, Some(0));
    }

    /// The mean ITL is the requests' own: seconds over tokens of the
    /// requests finished since the first scrape.
    #[tokio::test]
    async fn the_mean_itl_comes_from_the_counters_since_the_first_scrape() {
        let scrapes = Arc::new(AtomicUsize::new(0));
        let served = scrapes.clone();
        let later = METRICS
            .replace(
                "llamacpp:tokens_predicted_total 1803",
                "llamacpp:tokens_predicted_total 1903",
            )
            .replace(
                "llamacpp:tokens_predicted_seconds_total 11.4002",
                "llamacpp:tokens_predicted_seconds_total 12.0002",
            );
        assert_ne!(later, METRICS);
        let server = llama_server(move |path| match path {
            "/metrics" if served.fetch_add(1, Ordering::SeqCst) > 0 => (200, later.clone()),
            _ => idle(path),
        })
        .await;
        let adapter = adapter(&server.url);
        let first = adapter.get_metrics().await.expect("metrics");
        assert_eq!(first.inter_token_latency_ms, None);
        assert_eq!(first.total_generation_tokens, Some(0));
        let second = adapter.get_metrics().await.expect("metrics");
        assert_close(second.inter_token_latency_ms, 6.0);
        assert_eq!(second.total_generation_tokens, Some(100));
    }

    /// A `/metrics` body whose prompt and generated token counters stand at
    /// `prompt` and `generated`.
    fn scrape_at(prompt: u64, generated: u64) -> String {
        METRICS
            .replace(
                "llamacpp:prompt_tokens_total 152",
                &format!("llamacpp:prompt_tokens_total {prompt}"),
            )
            .replace(
                "llamacpp:tokens_predicted_total 1803",
                &format!("llamacpp:tokens_predicted_total {generated}"),
            )
    }

    /// Both token totals count from the first scrape, the baseline, as on
    /// vLLM and SGLang: the combined inter-token latency is weighted by
    /// them, so they must cover the window the latency does (#151). The
    /// tokens/s rate still comes from the raw counter's deltas.
    #[tokio::test]
    async fn generation_tokens_count_from_the_first_scrape_baseline() {
        let scrapes = Arc::new(AtomicUsize::new(0));
        let served = scrapes.clone();
        let later = scrape_at(252, 1903);
        assert_ne!(later, METRICS);
        let server = llama_server(move |path| match path {
            "/metrics" if served.fetch_add(1, Ordering::SeqCst) > 0 => (200, later.clone()),
            _ => idle(path),
        })
        .await;
        let adapter = adapter(&server.url);
        let t0 = Instant::now();
        let first = adapter.get_metrics().await.expect("metrics");
        assert!(!first.warming_up);
        assert_eq!(first.total_generation_tokens, Some(0));
        assert_eq!(first.total_prompt_tokens, Some(0));
        assert_eq!(first.tokens_per_sec, None);

        tokio::time::sleep(Duration::from_millis(20)).await;
        let second = adapter.get_metrics().await.expect("metrics");
        let elapsed = t0.elapsed().as_secs_f64();
        assert_eq!(second.total_generation_tokens, Some(100));
        assert_ne!(
            second.total_generation_tokens,
            Some(1903),
            "not the engine's lifetime count"
        );
        assert_eq!(second.total_prompt_tokens, Some(100));
        // The rate still reads the 100 tokens over the interval between the
        // scrapes, so the switch of the totals left it alone. It cannot tell
        // the raw counter's delta from the since-baseline total's (both
        // give 100 here); `the_generation_rate_moves_while_a_request_runs`
        // does, by keeping the total at 0 while the rate moves.
        let rate = second.tokens_per_sec.expect("a rate after two scrapes");
        assert!(
            rate >= 100.0 / elapsed && rate <= 100.0 / 0.020,
            "{rate} tokens/s"
        );
    }

    /// A restarted server's counters fall back to zero. That scrape is
    /// warming up (the engine's own count, rates blanked), the next one
    /// re-baselines, and the total counts from it again.
    #[tokio::test]
    async fn a_restarted_server_rebaselines_its_generated_tokens() {
        const GENERATED: [u64; 5] = [1803, 1903, 50, 150, 250];
        let scrapes = Arc::new(AtomicUsize::new(0));
        let served = scrapes.clone();
        let server = llama_server(move |path| match path {
            "/metrics" => {
                let i = served
                    .fetch_add(1, Ordering::SeqCst)
                    .min(GENERATED.len() - 1);
                (200, scrape_at(152, GENERATED[i]))
            }
            _ => idle(path),
        })
        .await;
        let adapter = adapter(&server.url);
        let mut seen = Vec::new();
        for _ in 0..GENERATED.len() {
            seen.push(adapter.get_metrics().await.expect("metrics"));
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let totals: Vec<_> = seen.iter().map(|m| m.total_generation_tokens).collect();
        assert_eq!(totals, [Some(0), Some(100), Some(50), Some(0), Some(100)]);
        assert!(seen[2].warming_up, "the restart is a warmup tick");
        assert_eq!(seen[2].tokens_per_sec, None);
        assert!(!seen[3].warming_up);
        assert!(seen[4].tokens_per_sec.is_some_and(|tps| tps > 0.0));
    }
}
