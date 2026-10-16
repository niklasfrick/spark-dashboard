//! Ollama: one server, any number of models loaded on demand and unloaded
//! when idle. The engine is the server; what it has loaded is a list that
//! changes under it, read from Ollama's own API and nowhere else — never
//! from the runner processes it starts per model, whose ports and routes are
//! Ollama's internal interface.
//!
//! Ollama exposes no server-side metrics: no `/metrics` route in any release
//! (verified live on v0.19.0, in source on v0.40.5), and the token and timing
//! figures of a request go only to the client that made it. So the adapter
//! declares no metric group and reports server status and loaded models only.

use super::common::EngineHttp;
use super::{
    EngineAdapter, EngineMetrics, EngineStatus, EngineType, LoadedModel, MetricGroup,
    ModelResolution,
};
use async_trait::async_trait;
use std::collections::BTreeSet;
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

/// The port Ollama serves on when `OLLAMA_HOST` does not say otherwise.
pub const DEFAULT_PORT: u16 = 11434;

/// How long `/api/ps` may take before the adapter keeps its last list. The
/// route answers from memory in milliseconds — except while a model loads:
/// from v0.40 it waits on the loading runner's lock for as long as the load
/// takes, tens of seconds for a large model. Engines are polled one after
/// another, so this also bounds how long a loading Ollama holds up every
/// other engine's tick.
pub(crate) const PS_TIMEOUT: Duration = Duration::from_millis(500);

pub struct OllamaAdapter {
    /// The endpoint, and a configured bearer token. Ollama's local API needs
    /// no key and ignores one, but every engine request carries the
    /// endpoint's configured key alike.
    http: EngineHttp,
    /// What `/api/ps` listed when it last answered: empty until it has,
    /// which is also what an idle server lists.
    loaded: Mutex<Vec<LoadedModel>>,
}

impl OllamaAdapter {
    pub fn new(client: reqwest::Client, endpoint: String, api_key: Option<String>) -> Self {
        Self {
            http: EngineHttp::new(client, endpoint, api_key),
            loaded: Mutex::default(),
        }
    }

    /// The models `/api/ps` lists now, or `None` when it did not answer in
    /// time, answered with an error, or answered something else.
    async fn read_ps(&self) -> Option<Vec<LoadedModel>> {
        let response = self
            .http
            .get("/api/ps")
            .timeout(PS_TIMEOUT)
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        parse_ps(&response.text().await.ok()?)
    }
}

#[async_trait]
impl EngineAdapter for OllamaAdapter {
    fn engine_type(&self) -> EngineType {
        EngineType::Ollama
    }

    fn endpoint(&self) -> &str {
        self.http.endpoint()
    }

    /// None: there is nothing to report, and no launch flag that would change
    /// that — so `metrics_off` keeps its default, and every metric tile bound
    /// to an Ollama engine reads "not reported".
    fn metric_groups(&self) -> BTreeSet<MetricGroup> {
        BTreeSet::new()
    }

    fn loaded_models(&self) -> Option<Vec<LoadedModel>> {
        Some(
            self.loaded
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone(),
        )
    }

    async fn refresh_loaded_models(&self) {
        match self.read_ps().await {
            Some(models) => *self.loaded.lock().unwrap_or_else(PoisonError::into_inner) = models,
            None => tracing::debug!(
                endpoint = %self.http.endpoint(),
                "/api/ps gave no list (held up by a loading model, or failed); keeping the last one"
            ),
        }
    }

    /// Running whenever `/api/version` answers, whatever is loaded: an idle
    /// server is running. `/api/version` is answered straight from the
    /// router, so a model load does not hold it up the way it holds `/api/ps`.
    async fn health_check(&self) -> EngineStatus {
        self.http.health("/api/version").await
    }

    /// An Ollama server names no single model — what it has loaded is
    /// `loaded_models` — so `model` stays empty, without a request.
    async fn get_model_info(&self) -> ModelResolution {
        ModelResolution::default()
    }

    /// Nothing to scrape, so nothing is asked.
    async fn get_metrics(&self) -> Option<EngineMetrics> {
        None
    }
}

/// `/api/ps` as served (`api.ProcessResponse`), reading only what the
/// dashboard shows. Lenient on purpose: a field Ollama leaves out or empties
/// reads as absent, and fields a later release adds (v0.40's `runner`,
/// `details.context_length`) are ignored.
#[derive(serde::Deserialize)]
struct PsResponse {
    models: Vec<PsModel>,
}

#[derive(serde::Deserialize, Default)]
#[serde(default)]
struct PsModel {
    name: Option<String>,
    model: Option<String>,
    size: Option<i64>,
    size_vram: Option<i64>,
    details: Option<PsDetails>,
    expires_at: Option<String>,
    context_length: Option<i64>,
}

#[derive(serde::Deserialize, Default)]
#[serde(default)]
struct PsDetails {
    parameter_size: Option<String>,
    quantization_level: Option<String>,
}

/// The models an `/api/ps` body lists, sorted by name — Ollama orders them
/// by expiry, which reshuffles on every request, and labels built on the
/// list must not jump. `None` when the body is not `/api/ps`'s: a JSON
/// object with a `models` array.
fn parse_ps(body: &str) -> Option<Vec<LoadedModel>> {
    let response: PsResponse = serde_json::from_str(body).ok()?;
    let mut models: Vec<LoadedModel> = response
        .models
        .into_iter()
        .filter_map(loaded_model)
        .collect();
    models.sort_by(|a, b| a.name.cmp(&b.name));
    Some(models)
}

/// One `/api/ps` entry on the wire. Ollama writes Go zero values for what it
/// does not know — an empty string, a zero, the zero time — and each reads
/// as absent here. An entry without a name (or the `model` it duplicates)
/// cannot be shown and is left out.
fn loaded_model(entry: PsModel) -> Option<LoadedModel> {
    let present = |s: Option<String>| s.filter(|s| !s.trim().is_empty());
    let name = present(entry.name).or_else(|| present(entry.model))?;
    let details = entry.details.unwrap_or_default();
    let bytes = |n: Option<i64>| n.and_then(|n| u64::try_from(n).ok()).unwrap_or(0);
    Some(LoadedModel {
        name,
        parameter_size: present(details.parameter_size),
        quantization: present(details.quantization_level),
        size_bytes: bytes(entry.size),
        vram_bytes: bytes(entry.size_vram),
        context_length: entry
            .context_length
            .and_then(|n| u32::try_from(n).ok())
            .filter(|&n| n > 0),
        expires_at: present(entry.expires_at).filter(|t| !is_zero_time(t)),
    })
}

/// Whether a timestamp is Go's zero `time.Time` (`0001-01-01T00:00:00Z`),
/// which is what Ollama serializes for an expiry it has not set.
fn is_zero_time(timestamp: &str) -> bool {
    timestamp.starts_with("0001-01-01")
}

/// Whether the server behind `http` is Ollama, by the two routes only Ollama
/// serves: `/api/version` answers a JSON object with a string `version`, and
/// `/api/ps` a JSON object with a `models` array.
///
/// Neither a root that says "Ollama is running" nor `/api/tags` proves it:
/// SGLang serves Ollama-compatible `/api/tags`, `/api/chat`,
/// `/api/generate` and `/api/show`, and can be configured to answer `GET /`
/// with `"Ollama is running"`. SGLang and vLLM serve neither route asked
/// here.
///
/// A `/api/ps` that does not answer in time is a loading Ollama, which holds
/// that route until the load finishes, once `/api/version` has answered as
/// Ollama's: an engine that serves no `/api/ps` answers 404 at once. Taking
/// it for anything else would drop a known engine from detection for the
/// length of every model load, and its GPU association with it.
pub(crate) async fn identify(http: &EngineHttp) -> bool {
    let Some(version) = json_at(http.get("/api/version")).await else {
        return false;
    };
    if !version
        .get("version")
        .is_some_and(serde_json::Value::is_string)
    {
        return false;
    }
    match http.get("/api/ps").timeout(PS_TIMEOUT).send().await {
        Ok(response) if response.status().is_success() => response
            .text()
            .await
            .ok()
            .and_then(|body| serde_json::from_str::<serde_json::Value>(&body).ok())
            .is_some_and(|ps| ps.get("models").is_some_and(serde_json::Value::is_array)),
        Ok(_) => false,
        Err(e) => e.is_timeout(),
    }
}

/// The JSON a successful GET answered, if it answered with JSON.
async fn json_at(request: reqwest::RequestBuilder) -> Option<serde_json::Value> {
    let response = request.send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    serde_json::from_str(&response.text().await.ok()?).ok()
}

#[cfg(test)]
mod tests {
    use super::super::test_server::{Request, TestServer};
    use super::super::{DeploymentMode, EngineState};
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    // Byte-exact answers of Ollama 0.19.0 on a DGX Spark (dc1a8b4): `/`,
    // `/api/version`, and `/api/ps` idle and with tinyllama loaded.
    const ROOT: &str = include_str!("fixtures/ollama_root.txt");
    const VERSION: &str = include_str!("fixtures/ollama_version.json");
    const PS_EMPTY: &str = include_str!("fixtures/ollama_ps_empty.json");
    const PS_LOADED: &str = include_str!("fixtures/ollama_ps_loaded.json");

    fn tinyllama() -> LoadedModel {
        LoadedModel {
            name: "tinyllama:latest".into(),
            parameter_size: Some("1B".into()),
            quantization: Some("Q4_0".into()),
            size_bytes: 800_454_656,
            vram_bytes: 800_454_656,
            context_length: Some(2048),
            expires_at: Some("2026-10-16T10:54:20.322299928+02:00".into()),
        }
    }

    /// The captured loaded `/api/ps`, with its one entry edited by `edit` —
    /// for the shapes the capture does not hold.
    fn ps_loaded_with(edit: impl Fn(&mut serde_json::Value)) -> String {
        let mut ps: serde_json::Value = serde_json::from_str(PS_LOADED).unwrap();
        edit(&mut ps["models"][0]);
        ps.to_string()
    }

    /// An Ollama server answering from the captures, with `/api/ps` answered
    /// by `ps` and every route Ollama does not serve a 404.
    async fn ollama(
        ps: impl Fn() -> (u16, String, Duration) + Send + Sync + 'static,
    ) -> TestServer {
        TestServer::start_delayed(move |r: &Request| match r.path.as_str() {
            "/" => (200, ROOT.into(), Duration::ZERO),
            "/api/version" => (200, VERSION.into(), Duration::ZERO),
            "/api/ps" => ps(),
            _ => (404, "404 page not found".into(), Duration::ZERO),
        })
        .await
    }

    fn answer(body: &str) -> (u16, String, Duration) {
        (200, body.into(), Duration::ZERO)
    }

    fn adapter(url: &str) -> OllamaAdapter {
        OllamaAdapter::new(reqwest::Client::new(), url.into(), None)
    }

    fn http(url: &str) -> EngineHttp {
        EngineHttp::new(reqwest::Client::new(), url.into(), None)
    }

    #[test]
    fn an_idle_server_lists_no_models() {
        assert_eq!(parse_ps(PS_EMPTY), Some(vec![]));
    }

    #[test]
    fn a_loaded_model_carries_what_ollama_says_about_it() {
        assert_eq!(parse_ps(PS_LOADED), Some(vec![tinyllama()]));
    }

    /// Ollama lists the longest-lived model first, an order that reshuffles
    /// on every request; the wire carries them by name.
    #[test]
    fn loaded_models_are_sorted_by_name() {
        let mut ps: serde_json::Value = serde_json::from_str(PS_LOADED).unwrap();
        let mut qwen = ps["models"][0].clone();
        qwen["name"] = "qwen3:8b".into();
        let mut gemma = ps["models"][0].clone();
        gemma["name"] = "gemma3:4b".into();
        let models = ps["models"].as_array_mut().unwrap();
        models.insert(0, qwen);
        models.push(gemma);

        let names: Vec<String> = parse_ps(&ps.to_string())
            .expect("parses")
            .into_iter()
            .map(|m| m.name)
            .collect();
        assert_eq!(names, ["gemma3:4b", "qwen3:8b", "tinyllama:latest"]);
    }

    /// Go writes zero values for what it does not know; none of them is a
    /// fact about the model, so each reads as absent rather than as "", 0 or
    /// year one.
    #[test]
    fn zero_values_read_as_absent() {
        let body = ps_loaded_with(|m| {
            m["details"]["parameter_size"] = "".into();
            m["details"]["quantization_level"] = "".into();
            m["context_length"] = 0.into();
            m["expires_at"] = "0001-01-01T00:00:00Z".into();
        });
        let model = &parse_ps(&body).expect("parses")[0];
        assert_eq!(model.parameter_size, None);
        assert_eq!(model.quantization, None);
        assert_eq!(model.context_length, None);
        assert_eq!(model.expires_at, None);

        // Absent altogether — `context_length` predates nothing we read, but
        // a field left out reads the same as one zeroed.
        let body = ps_loaded_with(|m| {
            let m = m.as_object_mut().unwrap();
            m.remove("context_length");
            m.remove("expires_at");
            m.remove("details");
        });
        let model = &parse_ps(&body).expect("parses")[0];
        assert_eq!(model.name, "tinyllama:latest");
        assert_eq!(
            (model.context_length, model.expires_at.as_deref()),
            (None, None)
        );
        assert_eq!(
            (
                model.parameter_size.as_deref(),
                model.quantization.as_deref()
            ),
            (None, None)
        );
    }

    /// v0.40 adds `runner` to each entry and `context_length` and
    /// `embedding_length` to its details; the list reads the same.
    #[test]
    fn fields_a_later_release_adds_are_ignored() {
        let body = ps_loaded_with(|m| {
            m["runner"] = "llamacpp".into();
            m["details"]["context_length"] = 2048.into();
            m["details"]["embedding_length"] = 2048.into();
            m["details"]["families"] = serde_json::Value::Null;
        });
        assert_eq!(parse_ps(&body), Some(vec![tinyllama()]));
    }

    #[test]
    fn an_entry_without_a_name_falls_back_to_its_model_or_is_left_out() {
        let body = ps_loaded_with(|m| m["name"] = "".into());
        assert_eq!(parse_ps(&body).expect("parses")[0].name, "tinyllama:latest");

        let body = ps_loaded_with(|m| {
            m["name"] = "".into();
            m["model"] = "".into();
        });
        assert_eq!(parse_ps(&body), Some(vec![]));
    }

    #[test]
    fn a_body_that_is_not_api_ps_lists_nothing() {
        for body in [
            ROOT,
            VERSION,
            "404 page not found",
            "\"SGLang is running\"",
            r#"{"object":"list","data":[{"id":"tinyllama:latest"}]}"#,
            r#"{"models":null}"#,
        ] {
            assert_eq!(parse_ps(body), None, "{body}");
        }
    }

    /// Running on `/api/version` alone — the root is never asked, and an
    /// error there is the engine's status.
    #[tokio::test]
    async fn health_is_api_version() {
        let server = ollama(|| answer(PS_EMPTY)).await;
        assert_eq!(
            adapter(&server.url).health_check().await,
            EngineStatus::Running
        );
        let asked: Vec<_> = server.requests().into_iter().map(|r| r.path).collect();
        assert_eq!(asked, ["/api/version"]);

        let down = TestServer::start(|_| (500, String::new())).await;
        assert!(matches!(
            adapter(&down.url).health_check().await,
            EngineStatus::Error(_)
        ));
    }

    /// No metric group, no metrics-off flag, no single model — and none of
    /// them costs a request.
    #[tokio::test]
    async fn ollama_reports_no_metrics_and_no_single_model() {
        let server = ollama(|| answer(PS_LOADED)).await;
        let adapter = adapter(&server.url);
        assert_eq!(adapter.engine_type(), EngineType::Ollama);
        assert!(adapter.metric_groups().is_empty());
        assert_eq!(adapter.metrics_launch_flag(), None);
        assert!(!adapter.metrics_off());
        assert!(adapter.get_metrics().await.is_none());
        let resolution = adapter.get_model_info().await;
        assert!(resolution.model.is_none());
        assert_eq!(resolution.metadata_error, None);
        assert!(server.requests().is_empty());
    }

    async fn snapshot_json(state: &mut EngineState) -> serde_json::Value {
        serde_json::to_value(state.poll().await).unwrap()
    }

    /// The whole wire state of an Ollama engine, through the real poll tick:
    /// running, no single model, its loaded list beside it, no metric group,
    /// metrics off never — so every metric tile reads "not reported" and
    /// none says it is warming up or has no data yet.
    #[tokio::test]
    async fn an_ollama_snapshot_is_running_with_its_list_and_no_metrics() {
        let server = ollama(|| answer(PS_LOADED)).await;
        let mut state = EngineState::new(Box::new(adapter(&server.url)), DeploymentMode::Native);
        let json = snapshot_json(&mut state).await;

        assert_eq!(json["engine_type"], "Ollama");
        assert_eq!(json["status"], serde_json::json!({"type": "Running"}));
        assert_eq!(json["model"], serde_json::Value::Null);
        assert_eq!(json["model_metadata_error"], serde_json::Value::Null);
        assert_eq!(json["metric_groups"], serde_json::json!([]));
        assert_eq!(json["metrics_off"], serde_json::Value::Null);
        assert_eq!(json["metrics"], serde_json::Value::Null);
        assert_eq!(
            json["loaded_models"],
            serde_json::json!([{
                "name": "tinyllama:latest",
                "parameter_size": "1B",
                "quantization": "Q4_0",
                "size_bytes": 800454656u64,
                "vram_bytes": 800454656u64,
                "context_length": 2048,
                "expires_at": "2026-10-16T10:54:20.322299928+02:00",
            }])
        );
    }

    /// Before `/api/ps` has ever answered, the list is empty — an array, as
    /// it always is for Ollama — never `null`, which reads as a
    /// single-model engine type.
    #[test]
    fn the_list_is_an_array_before_the_first_read() {
        assert_eq!(adapter("http://127.0.0.1:1").loaded_models(), Some(vec![]));
    }

    /// One engine across a model's life: idle, loaded, unloaded again. The
    /// identity (type and endpoint) never moves, the engine stays running
    /// throughout, and each tick shows what is loaded at that tick.
    #[tokio::test]
    async fn one_engine_follows_its_models_from_idle_to_loaded_and_back() {
        let phase = Arc::new(AtomicUsize::new(0));
        let served = phase.clone();
        let server = ollama(move || match served.load(Ordering::SeqCst) {
            1 => answer(PS_LOADED),
            _ => answer(PS_EMPTY),
        })
        .await;
        let mut state = EngineState::new(Box::new(adapter(&server.url)), DeploymentMode::Native);

        let mut seen = Vec::new();
        for step in [0, 1, 0] {
            phase.store(step, Ordering::SeqCst);
            let snapshot = state.poll().await;
            assert_eq!(snapshot.status, EngineStatus::Running, "step {step}");
            assert!(snapshot.model.is_none());
            seen.push((
                snapshot.engine_type,
                snapshot.endpoint,
                snapshot
                    .loaded_models
                    .expect("an Ollama engine always has a list"),
            ));
        }
        let identity = (EngineType::Ollama, server.url.clone());
        assert_eq!(
            seen,
            [
                (identity.0.clone(), identity.1.clone(), vec![]),
                (identity.0.clone(), identity.1.clone(), vec![tinyllama()]),
                (identity.0, identity.1, vec![]),
            ]
        );
    }

    /// While a model loads, v0.40's `/api/ps` waits on it. A tick whose read
    /// times out — or meets an error — keeps the last list rather than
    /// emptying it, and the engine stays running on `/api/version`.
    #[tokio::test]
    async fn a_held_up_or_failed_api_ps_keeps_the_last_list() {
        let phase = Arc::new(AtomicUsize::new(0));
        let served = phase.clone();
        let server = ollama(move || match served.load(Ordering::SeqCst) {
            0 => answer(PS_LOADED),
            1 => (200, PS_EMPTY.into(), PS_TIMEOUT * 4),
            _ => (500, "internal error".into(), Duration::ZERO),
        })
        .await;
        let mut state = EngineState::new(Box::new(adapter(&server.url)), DeploymentMode::Native);

        for step in [0, 1, 2] {
            phase.store(step, Ordering::SeqCst);
            let started = std::time::Instant::now();
            let snapshot = state.poll().await;
            assert_eq!(snapshot.status, EngineStatus::Running, "step {step}");
            assert_eq!(
                snapshot.loaded_models,
                Some(vec![tinyllama()]),
                "step {step}"
            );
            assert!(
                started.elapsed() < PS_TIMEOUT * 3,
                "a held-up /api/ps costs the tick at most its timeout"
            );
        }
    }

    #[tokio::test]
    async fn an_ollama_server_is_identified_by_its_own_routes() {
        let server = ollama(|| answer(PS_EMPTY)).await;
        assert!(identify(&http(&server.url)).await);
        let asked: Vec<_> = server.requests().into_iter().map(|r| r.path).collect();
        assert_eq!(asked, ["/api/version", "/api/ps"]);

        let loaded = ollama(|| answer(PS_LOADED)).await;
        assert!(identify(&http(&loaded.url)).await);
    }

    /// SGLang serves Ollama's `/api/tags` (and chat, generate, show), and
    /// with `SGLANG_OLLAMA_ROOT_ROUTE=/` answers its root with a quoted
    /// `"Ollama is running"`. None of that is Ollama: it serves neither
    /// `/api/version` nor `/api/ps`.
    #[tokio::test]
    async fn an_sglang_server_with_ollama_routes_is_not_ollama() {
        let sglang = TestServer::start(|r| match r.path.as_str() {
            "/" => (200, "\"Ollama is running\"".into()),
            "/api/tags" => (
                200,
                r#"{"models":[{"name":"m","model":"m","size":0,"digest":"sha256:sglang000","details":{"format":"sglang","parameter_size":"unknown"}}]}"#.into(),
            ),
            "/health" | "/ready" | "/model_info" | "/v1/models" => (200, "{}".into()),
            _ => (404, "{\"detail\":\"Not Found\"}".into()),
        })
        .await;
        assert!(!identify(&http(&sglang.url)).await);
        assert!(!sglang
            .requests()
            .iter()
            .any(|r| r.path == "/" || r.path == "/api/tags"));
    }

    /// Each half of the evidence is needed, in its shape.
    #[tokio::test]
    async fn identification_needs_both_routes_in_their_shapes() {
        let cases = [
            ("no /api/ps", (200, VERSION), (404, "404 page not found")),
            ("no /api/version", (404, "Not Found"), (200, PS_EMPTY)),
            ("version not JSON", (200, "0.19.0"), (200, PS_EMPTY)),
            (
                "version not a string",
                (200, r#"{"version":19}"#),
                (200, PS_EMPTY),
            ),
            (
                "ps without models",
                (200, VERSION),
                (200, r#"{"object":"list"}"#),
            ),
            (
                "ps models not a list",
                (200, VERSION),
                (200, r#"{"models":{}}"#),
            ),
        ];
        for (case, version, ps) in cases {
            let server = TestServer::start(move |r| match r.path.as_str() {
                "/api/version" => (version.0, version.1.into()),
                "/api/ps" => (ps.0, ps.1.into()),
                _ => (404, String::new()),
            })
            .await;
            assert!(!identify(&http(&server.url)).await, "{case}");
        }
    }

    /// A loading v0.40 holds `/api/ps` until the load is done; with
    /// `/api/version` answered as Ollama's, that is a loading Ollama, and
    /// it stays detected through the load.
    #[tokio::test]
    async fn a_loading_ollama_is_still_identified() {
        let server = ollama(|| (200, PS_EMPTY.into(), PS_TIMEOUT * 4)).await;
        assert!(identify(&http(&server.url)).await);
    }
}
