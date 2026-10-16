//! Model identity for engines that serve the OpenAI-compatible API: the name
//! `/v1/models` answers — or the launch command line's, when it cannot — and
//! the HuggingFace metadata behind it. Shared by every such adapter: vLLM and
//! SGLang answer `/v1/models` identically, down to the 401 of a launch with an
//! API key the dashboard was not given.

use super::common::EngineHttp;
use super::{ModelInfo, ModelMetadataError, ModelResolution};
use serde::Deserialize;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

/// Resolves one engine's model identity, and caches the HuggingFace half of
/// it for the engine's lifetime.
pub(crate) struct ModelResolver {
    /// Model identity recovered from the launch command line (e.g.
    /// `unsloth/Llama-3.2-1B-Instruct`). Used as a fallback when
    /// `/v1/models` returns a bare slug without the HF-style `Provider/`
    /// prefix — see `resolve` for the precedence rules.
    served_model: Option<String>,
    /// Cached HuggingFace model metadata. Once successfully fetched, this
    /// lives for the lifetime of the adapter (model params and quantization
    /// do not change at runtime).
    hf_model_cache: Mutex<Option<ModelInfo>>,
    /// Wall-clock time of the most recent failed HF API attempt. Used to
    /// enforce a cooldown so a transient HF outage does not trigger a
    /// request on every 1-second poll cycle.
    last_hf_error: Mutex<Option<Instant>>,
}

impl ModelResolver {
    pub(crate) fn new(served_model: Option<String>) -> Self {
        Self {
            served_model,
            hf_model_cache: Mutex::new(None),
            last_hf_error: Mutex::new(None),
        }
    }

    /// The engine's model, resolved through `/v1/models` with `http`, and why
    /// the engine's own answer is missing when it is.
    pub(crate) async fn resolve(&self, http: &EngineHttp) -> ModelResolution {
        // Try the OpenAI-compatible models endpoint first. The engine returns
        // whatever id it was launched with, but downstream model routers can
        // strip the HF-style `Provider/` prefix before replying — which is
        // exactly the case we want to recover from via the command-line hint.
        // The status is inspected rather than piped through "parse or None":
        // an auth-gated deployment answers 401/403 here while `/metrics`
        // keeps working, and that rejection must reach the operator instead
        // of silently degrading to the command-line fallback (issue #90).
        let reply = match http.get("/v1/models").send().await {
            Ok(resp) if resp.status().is_success() => {
                match resp.json::<OpenAIModelsResponse>().await {
                    Ok(models) => match models.data.first() {
                        Some(m) => ModelsEndpointReply::Resolved(m.id.clone()),
                        None => ModelsEndpointReply::Empty,
                    },
                    Err(e) => {
                        tracing::debug!(
                            endpoint = %http.endpoint(),
                            error = %e,
                            "/v1/models response deserialization failed",
                        );
                        ModelsEndpointReply::Failed(ModelMetadataError::Unavailable)
                    }
                }
            }
            Ok(resp) => {
                let status = resp.status();
                let error = classify_models_error_status(status.as_u16());
                if error == ModelMetadataError::AuthRequired {
                    tracing::warn!(
                        endpoint = %http.endpoint(),
                        status = %status,
                        "/v1/models rejected the request as unauthorized — \
                         configure a provider API key to read model metadata",
                    );
                } else {
                    tracing::debug!(
                        endpoint = %http.endpoint(),
                        status = %status,
                        "/v1/models returned non-success",
                    );
                }
                ModelsEndpointReply::Failed(error)
            }
            Err(e) => {
                tracing::debug!(
                    endpoint = %http.endpoint(),
                    error = %e,
                    "/v1/models request failed",
                );
                ModelsEndpointReply::Failed(ModelMetadataError::Unavailable)
            }
        };

        let (name, metadata_error) = resolve_model_name(&reply, self.served_model.as_deref());
        let Some(name) = name else {
            return ModelResolution {
                model: None,
                metadata_error,
            };
        };

        // An offline launch (`HF_HUB_OFFLINE` + `--model <local dir>`) makes
        // the engine report the filesystem path as its model id. Recover the real
        // repo id from the hub-cache layout so the UI never shows a snapshot
        // commit hash as the model name.
        let name = normalize_model_id(&name);

        // Try HF enrichment — fetch_hf_model_info caches successes and
        // throttles retries internally.
        let model = match self.fetch_hf_model_info(http.endpoint(), &name).await {
            Some(enriched) => enriched,
            None => ModelInfo::named(name),
        };

        ModelResolution {
            model: Some(model),
            metadata_error,
        }
    }

    /// Cooldown and caching live in `fetch_hf_model_info`; this is the
    /// engine-scoped view of it.
    async fn fetch_hf_model_info(&self, endpoint: &str, model_id: &str) -> Option<ModelInfo> {
        fetch_hf_model_info(
            endpoint,
            model_id,
            &self.hf_model_cache,
            &self.last_hf_error,
        )
        .await
    }
}

/// Format a raw parameter count into a compact human-readable string.
pub(crate) fn format_param_size(count: u64) -> String {
    if count >= 1_000_000_000 {
        format!("{:.1}B params", count as f64 / 1_000_000_000.0)
    } else if count >= 1_000_000 {
        format!("{:.1}M params", count as f64 / 1_000_000.0)
    } else {
        format!("{} params", count)
    }
}

/// Format quantization method name into a human-readable label.
fn format_quant_method(method: &str) -> String {
    match method {
        "auto-round" => "AutoRound".into(),
        "gptq" => "GPTQ".into(),
        "awq" => "AWQ".into(),
        "bitsandbytes" => "BitsAndBytes".into(),
        "fp8" => "FP8".into(),
        other => other.to_string(),
    }
}

/// Format quantization bits into a precision label.
fn format_precision(bits: u64) -> String {
    format!("{}-bit precision", bits)
}

/// Format the primary tensor dtype from safetensors parameter keys.
/// Picks the key with the largest parameter count, excluding integer
/// storage formats that represent packed quantized weights.
fn format_tensor_type(params: &std::collections::HashMap<String, u64>) -> Option<String> {
    // Prefer float dtypes over integer storage formats.
    let float_keys: [&str; 5] = ["BF16", "F16", "F32", "F64", "FP8"];
    for key in &float_keys {
        if params.contains_key(*key) {
            return Some(key.to_string());
        }
    }
    params.keys().next().cloned()
}

/// Cooldown between HF API retries after a failed request.
const HF_RETRY_COOLDOWN: Duration = Duration::from_secs(60);

/// Fetch model metadata from the HuggingFace model-info API.
///
/// Uses an internal cache so the API is called at most once per engine
/// lifetime. On failure, a 60-second cooldown prevents hammering the HF
/// API on every 1-second poll cycle.
async fn fetch_hf_model_info(
    endpoint: &str,
    model_id: &str,
    cache: &Mutex<Option<ModelInfo>>,
    last_error: &Mutex<Option<Instant>>,
) -> Option<ModelInfo> {
    // Cache hit — model metadata never changes at runtime. Only for the
    // same id, though: the name can legitimately change once, when an
    // auth-gated `/v1/models` starts answering and replaces the
    // command-line fallback the cache was filled from. A stale entry
    // must not keep renaming the model back.
    {
        let cache = cache.lock().await;
        if let Some(cached) = cache.as_ref() {
            if cached.name == model_id {
                return Some(cached.clone());
            }
        }
    }

    // Cooldown check — don't retry on every 1-second poll.
    {
        let last = last_error.lock().await;
        if let Some(when) = *last {
            if when.elapsed() < HF_RETRY_COOLDOWN {
                return None;
            }
        }
    }

    // Only HF-format names can be resolved — bare serve names have no
    // `org/name` shape, and a filesystem path (a local-directory launch
    // that `normalize_model_id` could not map back to a repo id) is not
    // an HF repo either.
    if !model_id.contains('/') || model_id.starts_with(['/', '.', '~']) {
        return None;
    }

    let url = format!("https://huggingface.co/api/models/{}", model_id);

    let hf_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .ok()?;

    let resp = match hf_client.get(&url).send().await {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            let status = r.status();
            if is_expected_hf_miss(status.as_u16()) {
                // Not a public HF repo (local/custom serve name or gated
                // model without a token) — expected, enrichment is optional.
                tracing::debug!(
                    endpoint = %endpoint,
                    model_id = %model_id,
                    status = %status,
                    "HF model info unavailable (model not public on HuggingFace); skipping enrichment",
                );
            } else {
                tracing::warn!(
                    endpoint = %endpoint,
                    model_id = %model_id,
                    status = %status,
                    "HF model info API returned non-success",
                );
            }
            *last_error.lock().await = Some(Instant::now());
            return None;
        }
        Err(e) => {
            tracing::warn!(
                endpoint = %endpoint,
                model_id = %model_id,
                error = %e,
                "HF model info API request failed",
            );
            *last_error.lock().await = Some(Instant::now());
            return None;
        }
    };

    let hf: HfModelResponse = match resp.json().await {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(
                endpoint = %endpoint,
                model_id = %model_id,
                error = %e,
                "HF model info response deserialization failed",
            );
            *last_error.lock().await = Some(Instant::now());
            return None;
        }
    };

    let parameter_size = hf
        .safetensors
        .as_ref()
        .and_then(|s| s.total)
        .map(format_param_size);

    let quant_config = hf
        .config
        .as_ref()
        .and_then(|c| c.quantization_config.as_ref());

    let quantization = quant_config
        .and_then(|q| q.quant_method.as_deref())
        .map(format_quant_method);

    let precision = quant_config.and_then(|q| q.bits).map(format_precision);

    let tensor_type = hf
        .safetensors
        .as_ref()
        .and_then(|s| s.parameters.as_ref())
        .and_then(format_tensor_type);

    let model_type = hf.config.as_ref().and_then(|c| c.model_type.clone());

    let result = ModelInfo {
        name: model_id.to_string(),
        parameter_size,
        quantization,
        precision,
        tensor_type,
        model_type,
        pipeline_tag: hf.pipeline_tag,
    };

    *cache.lock().await = Some(result.clone());

    tracing::info!(
        endpoint = %endpoint,
        model_id = %model_id,
        parameter_size = ?result.parameter_size,
        quantization = ?result.quantization,
        precision = ?result.precision,
        tensor_type = ?result.tensor_type,
        model_type = ?result.model_type,
        pipeline_tag = ?result.pipeline_tag,
        "Fetched model info from HuggingFace",
    );

    Some(result)
}

/// Recover a human-readable model id from a filesystem path.
///
/// vLLM launched against a local directory (the `HF_HUB_OFFLINE` workflow)
/// reports that path as its model id — typically a hub-cache snapshot like
/// `~/.cache/huggingface/hub/models--Qwen--Qwen3-32B/snapshots/<commit>`,
/// whose last segment is a bare git commit hash and would end up displayed
/// as the model name.
///
/// * A path containing a hub-cache `models--{org}--{name}` segment is
///   de-mangled back to `org/name`. Splitting on `--` is unambiguous: the
///   hub encodes the one `/` of a repo id as `--`, and HuggingFace forbids
///   consecutive dashes inside org and repo names.
/// * Otherwise a trailing `snapshots/<commit-hash>` is dropped, so the
///   display name falls back to the containing directory instead of the hash.
/// * Anything else — HF ids, custom serve names, plain paths — passes
///   through unchanged.
fn normalize_model_id(id: &str) -> String {
    if !id.contains('/') {
        return id.to_string();
    }

    for segment in id.split('/') {
        if let Some(repo) = segment.strip_prefix("models--") {
            if let Some((org, name)) = repo.split_once("--") {
                if !org.is_empty() && !name.is_empty() {
                    return format!("{org}/{name}");
                }
            }
        }
    }

    let trimmed = id.trim_end_matches('/');
    if let Some((parent, last)) = trimmed.rsplit_once('/') {
        let is_commit_hash = last.len() == 40 && last.bytes().all(|b| b.is_ascii_hexdigit());
        if is_commit_hash {
            if let Some((grandparent, "snapshots")) = parent.rsplit_once('/') {
                if !grandparent.trim_matches('/').is_empty() {
                    return grandparent.to_string();
                }
            }
        }
    }

    id.to_string()
}

/// HuggingFace returns these statuses when a model id isn't publicly
/// resolvable — local/custom serve names (e.g. a vLLM `--served-model-name`),
/// or gated/private repos accessed without a token. Metadata enrichment is
/// best-effort, so these are expected and logged at debug rather than warn.
fn is_expected_hf_miss(status: u16) -> bool {
    matches!(status, 401 | 403 | 404)
}

/// What the engine's `/v1/models` endpoint had to say, reduced to the cases
/// the name resolution cares about.
enum ModelsEndpointReply {
    /// A model id was returned.
    Resolved(String),
    /// The endpoint answered successfully but listed no models.
    Empty,
    /// The endpoint could not be read; the error says why.
    Failed(ModelMetadataError),
}

/// Classify a non-success `/v1/models` status. 401/403 mean the dashboard
/// lacks the engine's API key — the one failure an operator fixes on the
/// dashboard's side (configure a provider API key), so it gets its own
/// reason; everything else is generic unavailability. Shared by every
/// adapter that reads a model list, whatever the route is called.
pub(crate) fn classify_models_error_status(status: u16) -> ModelMetadataError {
    match status {
        401 | 403 => ModelMetadataError::AuthRequired,
        _ => ModelMetadataError::Unavailable,
    }
}

/// Resolve the display name from the `/v1/models` reply and the command-line
/// hint, and say why the engine's own answer is missing when it is.
///
/// Precedence on a successful reply (unchanged from before the error
/// plumbing):
///   1. API id, if it already carries a `Provider/` prefix.
///   2. Command-line hint captured during detection.
///   3. API id as-is (bare slug).
///   4. None (nothing resolved).
///
/// When the endpoint failed or listed nothing, the hint is all there is, and
/// the metadata error travels with it — the fallback name is shown, but the
/// frontend can say it is only a fallback.
fn resolve_model_name(
    reply: &ModelsEndpointReply,
    hint: Option<&str>,
) -> (Option<String>, Option<ModelMetadataError>) {
    match reply {
        ModelsEndpointReply::Resolved(id) => {
            let name = if id.contains('/') {
                id.clone()
            } else {
                hint.map(str::to_string).unwrap_or_else(|| id.clone())
            };
            (Some(name), None)
        }
        ModelsEndpointReply::Empty => (
            hint.map(str::to_string),
            Some(ModelMetadataError::Unavailable),
        ),
        ModelsEndpointReply::Failed(error) => (hint.map(str::to_string), Some(*error)),
    }
}

#[derive(Deserialize)]
struct OpenAIModelsResponse {
    #[serde(default)]
    data: Vec<OpenAIModel>,
}

#[derive(Deserialize)]
struct OpenAIModel {
    id: String,
}

/// Response shape for GET https://huggingface.co/api/models/{model_id}
#[derive(Deserialize)]
struct HfModelResponse {
    pipeline_tag: Option<String>,
    safetensors: Option<HfSafetensors>,
    #[serde(default)]
    config: Option<HfConfig>,
}

#[derive(Deserialize)]
struct HfSafetensors {
    total: Option<u64>,
    #[serde(default)]
    parameters: Option<std::collections::HashMap<String, u64>>,
}

#[derive(Deserialize)]
struct HfConfig {
    #[serde(default)]
    model_type: Option<String>,
    quantization_config: Option<HfQuantizationConfig>,
}

#[derive(Deserialize)]
struct HfQuantizationConfig {
    bits: Option<u64>,
    quant_method: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENDPOINT: &str = "http://localhost:8000";

    /// HF enrichment misses for non-public model ids (401/403/404) are
    /// expected and must stay quiet; other non-success statuses (e.g. 5xx,
    /// 429) still surface as warnings.
    #[test]
    fn expected_hf_misses_are_quiet() {
        for status in [401, 403, 404] {
            assert!(is_expected_hf_miss(status), "{status} should be quiet");
        }
        for status in [200, 429, 500, 502, 503] {
            assert!(!is_expected_hf_miss(status), "{status} should warn");
        }
    }

    /// Offline launches (`HF_HUB_OFFLINE` + `--model <local dir>`) make vLLM
    /// report a filesystem path as its model id. The hub-cache layout must be
    /// de-mangled back to the repo id, and a bare snapshot dir must not leave
    /// the commit hash as the display name; everything else passes through.
    #[test]
    fn normalize_model_id_recovers_repo_id_from_local_paths() {
        // Hub-cache snapshot path → repo id (the reported bug).
        assert_eq!(
            normalize_model_id(
                "/root/.cache/huggingface/hub/models--Qwen--Qwen3-32B\
                 /snapshots/7b719225242aacd3dbd3f9407468c2ee9a9d2594"
            ),
            "Qwen/Qwen3-32B"
        );
        // Single dashes inside org/name survive; only the `--` separator splits.
        assert_eq!(
            normalize_model_id("/data/hub/models--meta-llama--Llama-3.1-8B-Instruct/snapshots/abc"),
            "meta-llama/Llama-3.1-8B-Instruct"
        );
        // A snapshot dir outside the hub-cache layout: drop `snapshots/<hash>`
        // so the containing directory names the model, not the hash.
        assert_eq!(
            normalize_model_id("/mnt/qwen3-32b/snapshots/7b719225242aacd3dbd3f9407468c2ee9a9d2594"),
            "/mnt/qwen3-32b"
        );
        // HF ids, bare serve names, and plain paths pass through unchanged.
        assert_eq!(normalize_model_id("Qwen/Qwen3-32B"), "Qwen/Qwen3-32B");
        assert_eq!(normalize_model_id("my-alias"), "my-alias");
        assert_eq!(
            normalize_model_id("/models/custom-llm"),
            "/models/custom-llm"
        );
        // A 40-char last segment that isn't hex is a name, not a commit hash.
        assert_eq!(
            normalize_model_id("/srv/snapshots/this-is-a-forty-char-model-name-not-hex"),
            "/srv/snapshots/this-is-a-forty-char-model-name-not-hex"
        );
    }

    /// `/v1/models` auth rejections (401/403) get their own reason — the one
    /// failure the operator fixes on the dashboard's side. Everything else
    /// (missing endpoint, throttling, server errors) is generic
    /// unavailability.
    #[test]
    fn models_auth_statuses_classified_apart_from_other_failures() {
        for status in [401, 403] {
            assert_eq!(
                classify_models_error_status(status),
                ModelMetadataError::AuthRequired,
                "{status} should read as an auth rejection"
            );
        }
        for status in [404, 429, 500, 502, 503] {
            assert_eq!(
                classify_models_error_status(status),
                ModelMetadataError::Unavailable,
                "{status} should read as generic unavailability"
            );
        }
    }

    /// A rejected `/v1/models` falls back to the command-line hint, and the
    /// auth reason travels with the fallback name — the warning accompanies
    /// the name rather than replacing it. Without a hint, the reason stands
    /// alone.
    #[test]
    fn auth_rejection_reports_reason_beside_fallback_name() {
        let reply = ModelsEndpointReply::Failed(ModelMetadataError::AuthRequired);
        assert_eq!(
            resolve_model_name(&reply, Some("google/gemma-4-31B-it")),
            (
                Some("google/gemma-4-31B-it".into()),
                Some(ModelMetadataError::AuthRequired)
            )
        );
        assert_eq!(
            resolve_model_name(&reply, None),
            (None, Some(ModelMetadataError::AuthRequired))
        );
    }

    /// A connection failure / non-auth error status resolves the same way but
    /// with the non-auth reason, so the frontend never tells an operator to
    /// configure a key that would not help.
    #[test]
    fn non_auth_failure_reports_unavailable() {
        let reply = ModelsEndpointReply::Failed(ModelMetadataError::Unavailable);
        assert_eq!(
            resolve_model_name(&reply, Some("org/model")),
            (
                Some("org/model".into()),
                Some(ModelMetadataError::Unavailable)
            )
        );
        // A successful reply listing no models is not an auth problem either.
        assert_eq!(
            resolve_model_name(&ModelsEndpointReply::Empty, None),
            (None, Some(ModelMetadataError::Unavailable))
        );
    }

    /// A successful `/v1/models` reply carries no error and keeps the
    /// long-standing precedence: a `Provider/`-prefixed API id wins, the hint
    /// beats a bare slug, and a bare slug still resolves without a hint.
    #[test]
    fn successful_reply_keeps_precedence_and_reports_no_error() {
        let prefixed = ModelsEndpointReply::Resolved("google/gemma-4-31B-it_FP16".into());
        assert_eq!(
            resolve_model_name(&prefixed, Some("hint/model")),
            (Some("google/gemma-4-31B-it_FP16".into()), None)
        );

        let bare = ModelsEndpointReply::Resolved("gemma".into());
        assert_eq!(
            resolve_model_name(&bare, Some("google/gemma-4-31B-it")),
            (Some("google/gemma-4-31B-it".into()), None)
        );
        assert_eq!(
            resolve_model_name(&bare, None),
            (Some("gemma".into()), None)
        );
    }

    /// The HF enrichment cache is keyed by model id: it serves the same id
    /// without a refetch, but must not hand a different id the stale entry —
    /// the id legitimately changes once, when an auth-gated `/v1/models`
    /// starts answering and replaces the command-line fallback the cache was
    /// filled from. Both calls run inside the retry cooldown, so neither can
    /// touch the network: whatever comes back is the cache's answer.
    #[tokio::test]
    async fn hf_cache_serves_only_the_id_it_was_filled_from() {
        let resolver = ModelResolver::new(None);
        *resolver.hf_model_cache.lock().await = Some(ModelInfo {
            name: "google/gemma-4-31B-it".into(),
            parameter_size: Some("31.0B params".into()),
            quantization: None,
            precision: None,
            tensor_type: None,
            model_type: None,
            pipeline_tag: None,
        });
        *resolver.last_hf_error.lock().await = Some(Instant::now());

        let hit = resolver
            .fetch_hf_model_info(ENDPOINT, "google/gemma-4-31B-it")
            .await;
        assert_eq!(
            hit.map(|m| m.name),
            Some("google/gemma-4-31B-it".to_string()),
            "same id is served from the cache"
        );

        let miss = resolver
            .fetch_hf_model_info(ENDPOINT, "google/gemma-4-31B-it_FP16")
            .await;
        assert!(
            miss.is_none(),
            "a different id must not be renamed to the stale cache entry"
        );
    }

    #[test]
    fn format_param_size_formats_billions() {
        assert_eq!(format_param_size(11_823_991_872), "11.8B params");
        assert_eq!(format_param_size(7_000_000_000), "7.0B params");
    }

    #[test]
    fn format_param_size_formats_millions() {
        assert_eq!(format_param_size(500_000_000), "500.0M params");
        assert_eq!(format_param_size(1_000_000), "1.0M params");
    }

    #[test]
    fn format_quant_method_formats_known_methods() {
        assert_eq!(format_quant_method("auto-round"), "AutoRound");
        assert_eq!(format_quant_method("gptq"), "GPTQ");
        assert_eq!(format_quant_method("awq"), "AWQ");
        assert_eq!(format_quant_method("bitsandbytes"), "BitsAndBytes");
        assert_eq!(format_quant_method("fp8"), "FP8");
    }

    #[test]
    fn format_quant_method_passes_through_unknown() {
        assert_eq!(format_quant_method("some-new-method"), "some-new-method");
    }

    #[test]
    fn format_precision_produces_label() {
        assert_eq!(format_precision(4), "4-bit precision");
        assert_eq!(format_precision(8), "8-bit precision");
    }

    #[test]
    fn format_tensor_type_prefers_float_dtypes() {
        let mut params = std::collections::HashMap::new();
        params.insert("BF16".into(), 1000);
        params.insert("I32".into(), 5000);
        assert_eq!(format_tensor_type(&params), Some("BF16".into()));
    }

    #[test]
    fn format_tensor_type_falls_back_to_first_key() {
        let mut params = std::collections::HashMap::new();
        params.insert("I32".into(), 5000);
        assert_eq!(format_tensor_type(&params), Some("I32".into()));
    }

    #[test]
    fn format_tensor_type_returns_none_for_empty() {
        let params = std::collections::HashMap::new();
        assert_eq!(format_tensor_type(&params), None);
    }
}
