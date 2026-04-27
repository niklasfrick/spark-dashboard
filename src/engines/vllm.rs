use super::histogram::{fraction_le, percentile};
use super::prometheus::parse_prometheus_text;
use super::warmup::WarmupTracker;
use super::{
    EngineAdapter, EngineMetrics, EngineStatus, EngineType, LatencyPercentiles, ModelInfo,
    E2E_SLO_MS, ITL_SLO_MS, TTFT_SLO_MS,
};
use async_trait::async_trait;
use serde::Deserialize;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

/// Default number of requests to skip on engine startup before baselining.
/// vLLM's first inference is dominated by CUDA kernel JIT and KV cache
/// allocation; excluding one request consistently removes the outlier.
const DEFAULT_WARMUP_SKIP_REQUESTS: u64 = 1;

/// Read the warmup-skip threshold from the environment. Falls back silently
/// to the default on parse failure or when the variable is unset.
fn warmup_skip_from_env() -> u64 {
    std::env::var("SPARK_WARMUP_SKIP_REQUESTS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(DEFAULT_WARMUP_SKIP_REQUESTS)
}

/// Format a raw parameter count into a compact human-readable string.
fn format_param_size(count: u64) -> String {
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

pub struct VllmAdapter {
    client: reqwest::Client,
    endpoint: String,
    /// Model identity recovered from the launch command line (e.g.
    /// `unsloth/Llama-3.2-1B-Instruct`). Used as a fallback when
    /// `/v1/models` returns a bare slug without the HF-style `Provider/`
    /// prefix — see `get_model_info` for the precedence rules.
    served_model: Option<String>,
    /// Previous generation_tokens_total counter reading for rate computation.
    prev_gen_tokens: Mutex<Option<(f64, Instant)>>,
    /// Previous prompt_tokens_total counter reading for rate computation.
    prev_prompt_tokens: Mutex<Option<(f64, Instant)>>,
    /// Running average for generation: (sum_of_tps_readings, count_of_readings)
    avg_accum: Mutex<(f64, u64)>,
    /// Running average for prompt: (sum_of_tps_readings, count_of_readings)
    avg_prompt_accum: Mutex<(f64, u64)>,
    /// Warmup baseline tracker — drops the first `SPARK_WARMUP_SKIP_REQUESTS`
    /// observations from histogram-derived metrics so the slow first inference
    /// does not skew steady-state percentiles and averages.
    warmup: Mutex<WarmupTracker>,
    /// Cached HuggingFace model metadata. Once successfully fetched, this
    /// lives for the lifetime of the adapter (model params and quantization
    /// do not change at runtime).
    hf_model_cache: Mutex<Option<ModelInfo>>,
    /// Wall-clock time of the most recent failed HF API attempt. Used to
    /// enforce a cooldown so a transient HF outage does not trigger a
    /// request on every 1-second poll cycle.
    last_hf_error: Mutex<Option<Instant>>,
}

impl VllmAdapter {
    pub fn new(client: reqwest::Client, endpoint: String, served_model: Option<String>) -> Self {
        Self {
            client,
            endpoint,
            served_model,
            prev_gen_tokens: Mutex::new(None),
            prev_prompt_tokens: Mutex::new(None),
            avg_accum: Mutex::new((0.0, 0)),
            avg_prompt_accum: Mutex::new((0.0, 0)),
            warmup: Mutex::new(WarmupTracker::new(warmup_skip_from_env())),
            hf_model_cache: Mutex::new(None),
            last_hf_error: Mutex::new(None),
        }
    }

    /// Cooldown between HF API retries after a failed request.
    const HF_RETRY_COOLDOWN: Duration = Duration::from_secs(60);

    /// Fetch model metadata from the HuggingFace model-info API.
    ///
    /// Uses an internal cache so the API is called at most once per engine
    /// lifetime. On failure, a 60-second cooldown prevents hammering the HF
    /// API on every 1-second poll cycle.
    async fn fetch_hf_model_info(&self, model_id: &str) -> Option<ModelInfo> {
        // Cache hit — model metadata never changes at runtime.
        {
            let cache = self.hf_model_cache.lock().await;
            if let Some(cached) = cache.as_ref() {
                return Some(cached.clone());
            }
        }

        // Cooldown check — don't retry on every 1-second poll.
        {
            let last = self.last_hf_error.lock().await;
            if let Some(when) = *last {
                if when.elapsed() < Self::HF_RETRY_COOLDOWN {
                    return None;
                }
            }
        }

        // Only HF-format names can be resolved.
        if !model_id.contains('/') {
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
                tracing::warn!(
                    endpoint = %self.endpoint,
                    model_id = %model_id,
                    status = %r.status(),
                    "HF model info API returned non-success",
                );
                *self.last_hf_error.lock().await = Some(Instant::now());
                return None;
            }
            Err(e) => {
                tracing::warn!(
                    endpoint = %self.endpoint,
                    model_id = %model_id,
                    error = %e,
                    "HF model info API request failed",
                );
                *self.last_hf_error.lock().await = Some(Instant::now());
                return None;
            }
        };

        let hf: HfModelResponse = match resp.json().await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(
                    endpoint = %self.endpoint,
                    model_id = %model_id,
                    error = %e,
                    "HF model info response deserialization failed",
                );
                *self.last_hf_error.lock().await = Some(Instant::now());
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

        let model_type = hf
            .config
            .as_ref()
            .and_then(|c| c.model_type.clone());

        let result = ModelInfo {
            name: model_id.to_string(),
            parameter_size,
            quantization,
            precision,
            tensor_type,
            model_type,
            pipeline_tag: hf.pipeline_tag,
        };

        *self.hf_model_cache.lock().await = Some(result.clone());

        tracing::info!(
            endpoint = %self.endpoint,
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

#[async_trait]
impl EngineAdapter for VllmAdapter {
    fn engine_type(&self) -> EngineType {
        EngineType::Vllm
    }

    fn endpoint(&self) -> &str {
        &self.endpoint
    }

    async fn health_check(&self) -> EngineStatus {
        match self
            .client
            .get(format!("{}/health", self.endpoint))
            .timeout(Duration::from_secs(2))
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => EngineStatus::Running,
            Ok(r) => EngineStatus::Error(format!("HTTP {}", r.status())),
            Err(e) => EngineStatus::Error(e.to_string()),
        }
    }

    async fn get_model_info(&self) -> Option<ModelInfo> {
        // Try the OpenAI-compatible models endpoint first. vLLM returns
        // whatever id it was launched with, but downstream model routers can
        // strip the HF-style `Provider/` prefix before replying — which is
        // exactly the case we want to recover from via the command-line hint.
        let api_id: Option<String> = async {
            let resp = self
                .client
                .get(format!("{}/v1/models", self.endpoint))
                .timeout(Duration::from_secs(2))
                .send()
                .await
                .ok()?;
            let models: OpenAIModelsResponse = resp.json().await.ok()?;
            models.data.first().map(|m| m.id.clone())
        }
        .await;

        // Precedence:
        //   1. API id, if it already carries a `Provider/` prefix.
        //   2. Command-line hint captured during detection.
        //   3. API id as-is (bare slug).
        //   4. None (nothing resolved).
        let name = match (&api_id, &self.served_model) {
            (Some(id), _) if id.contains('/') => Some(id.clone()),
            (_, Some(hint)) => Some(hint.clone()),
            (Some(id), None) => Some(id.clone()),
            (None, None) => None,
        }?;

        // Try HF enrichment — fetch_hf_model_info caches successes and
        // throttles retries internally.
        if let Some(enriched) = self.fetch_hf_model_info(&name).await {
            return Some(enriched);
        }

        Some(ModelInfo {
            name,
            parameter_size: None,
            quantization: None,
            precision: None,
            tensor_type: None,
            model_type: None,
            pipeline_tag: None,
        })
    }

    async fn get_metrics(&self) -> Option<EngineMetrics> {
        let body = self
            .client
            .get(format!("{}/metrics", self.endpoint))
            .timeout(Duration::from_secs(2))
            .send()
            .await
            .ok()?
            .text()
            .await
            .ok()?;

        let raw = parse_prometheus_text(&body)?;

        // Run the parsed metrics through the warmup tracker. While warming, the
        // tracker hands back gauges and counters as-is so pass-through fields
        // (active/queued/kv_cache) stay populated; histogram-derived fields
        // are then forced to None below. After baselining, `adjusted` contains
        // counter and histogram deltas — feeding them into the existing
        // `percentile`/`fraction_le` helpers yields warmup-free metrics.
        let warmup_out = {
            let mut tracker = self.warmup.lock().await;
            tracker.observe(&raw)
        };

        // On baseline transition, the per-poll rate state captured during
        // warmup refers to absolute counter values. Post-transition the
        // tracker hands back deltas, so a stale `prev_*` reading would yield
        // a hugely negative rate on the next tick. Reset everything that
        // depends on the previous reading before computing rates below.
        if warmup_out.just_transitioned {
            *self.prev_gen_tokens.lock().await = None;
            *self.prev_prompt_tokens.lock().await = None;
            *self.avg_accum.lock().await = (0.0, 0);
            *self.avg_prompt_accum.lock().await = (0.0, 0);
            tracing::info!(
                endpoint = %self.endpoint,
                "warmup complete — baseline captured, steady-state metrics now reported"
            );
        }

        let parsed = &warmup_out.adjusted;
        let warming_up = warmup_out.warming_up;

        let active_requests = parsed
            .gauges
            .get("vllm_num_requests_running")
            .map(|v| *v as u64);
        let queued_requests = parsed
            .gauges
            .get("vllm_num_requests_waiting")
            .map(|v| *v as u64);
        // v1 uses vllm_kv_cache_usage_perc, v0.6 uses vllm_gpu_cache_usage_perc
        let kv_cache_percent = parsed
            .gauges
            .get("vllm_kv_cache_usage_perc")
            .or_else(|| parsed.gauges.get("vllm_gpu_cache_usage_perc"))
            .map(|v| v * 100.0);

        // TTFT from histogram sum/count (average)
        let ttft_count = parsed
            .counters
            .get("vllm_time_to_first_token_seconds_count");
        let ttft_ms = {
            let sum = parsed.counters.get("vllm_time_to_first_token_seconds_sum");
            match (sum, ttft_count) {
                (Some(&s), Some(&c)) if c > 0.0 => Some((s / c) * 1000.0),
                _ => None,
            }
        };

        // total_requests is a pass-through display field — show the engine's
        // absolute lifetime request count, not the post-baseline delta. Read
        // from `raw` so the value stays continuous across the warmup→active
        // transition rather than snapping back to zero.
        let total_requests = raw
            .counters
            .get("vllm_time_to_first_token_seconds_count")
            .map(|&c| c as u64);

        // Per-request avg TPS from time_per_output_token histogram: 1 / avg_TPOT
        // v1: vllm_request_time_per_output_token_seconds, v0.6: vllm_time_per_output_token_seconds
        let per_request_tps = {
            let sum = parsed
                .counters
                .get("vllm_request_time_per_output_token_seconds_sum")
                .or_else(|| {
                    parsed
                        .counters
                        .get("vllm_time_per_output_token_seconds_sum")
                });
            let count = parsed
                .counters
                .get("vllm_request_time_per_output_token_seconds_count")
                .or_else(|| {
                    parsed
                        .counters
                        .get("vllm_time_per_output_token_seconds_count")
                });
            match (sum, count) {
                (Some(&s), Some(&c)) if c > 0.0 && s > 0.0 => Some(c / s),
                _ => None,
            }
        };

        // TPS from generation_tokens_total counter (rate = delta / elapsed)
        let current_gen = parsed.counters.get("vllm_generation_tokens_total").copied();
        let now = Instant::now();

        let tokens_per_sec = {
            let mut prev_lock = self.prev_gen_tokens.lock().await;
            let tps = match (current_gen, prev_lock.as_ref()) {
                (Some(current), Some(&(prev_val, prev_time))) => {
                    let elapsed = now.duration_since(prev_time).as_secs_f64();
                    if elapsed > 0.0 {
                        Some((current - prev_val) / elapsed)
                    } else {
                        None
                    }
                }
                _ => None,
            };
            if let Some(val) = current_gen {
                *prev_lock = Some((val, now));
            }
            tps
        };

        // Prompt tokens/sec from prompt_tokens_total counter (rate = delta / elapsed)
        let current_prompt = parsed.counters.get("vllm_prompt_tokens_total").copied();
        let prompt_tokens_per_sec = {
            let mut prev_lock = self.prev_prompt_tokens.lock().await;
            let tps = match (current_prompt, prev_lock.as_ref()) {
                (Some(current), Some(&(prev_val, prev_time))) => {
                    let elapsed = now.duration_since(prev_time).as_secs_f64();
                    if elapsed > 0.0 {
                        Some((current - prev_val) / elapsed)
                    } else {
                        None
                    }
                }
                _ => None,
            };
            if let Some(val) = current_prompt {
                *prev_lock = Some((val, now));
            }
            tps
        };

        // Avg TPS = sum of non-zero TPS readings / count of readings.
        // Only accumulates when there's actual throughput. Stays stable when idle.
        let avg_tokens_per_sec = {
            let mut accum = self.avg_accum.lock().await;
            if let Some(tps) = tokens_per_sec {
                if tps > 0.0 {
                    accum.0 += tps;
                    accum.1 += 1;
                }
            }
            if accum.1 > 0 {
                Some(accum.0 / accum.1 as f64)
            } else {
                None
            }
        };

        // Avg prompt TPS (same pattern as generation avg)
        let avg_prompt_tokens_per_sec = {
            let mut accum = self.avg_prompt_accum.lock().await;
            if let Some(tps) = prompt_tokens_per_sec {
                if tps > 0.0 {
                    accum.0 += tps;
                    accum.1 += 1;
                }
            }
            if accum.1 > 0 {
                Some(accum.0 / accum.1 as f64)
            } else {
                None
            }
        };

        // Per-request prompt TPS: prompt_tokens_total / ttft_total_seconds
        // Approximates average prefill throughput per request
        let per_request_prompt_tps = {
            let prompt_total = parsed.counters.get("vllm_prompt_tokens_total");
            let ttft_sum = parsed.counters.get("vllm_time_to_first_token_seconds_sum");
            match (prompt_total, ttft_sum) {
                (Some(&p), Some(&t)) if t > 0.0 => Some(p / t),
                _ => None,
            }
        };

        // --- New metrics ---

        // End-to-end request latency (avg from histogram)
        let e2e_latency_ms = {
            let sum = parsed.counters.get("vllm_e2e_request_latency_seconds_sum");
            let count = parsed
                .counters
                .get("vllm_e2e_request_latency_seconds_count");
            match (sum, count) {
                (Some(&s), Some(&c)) if c > 0.0 => Some((s / c) * 1000.0),
                _ => None,
            }
        };

        // Swapped requests (memory pressure indicator)
        let swapped_requests = parsed
            .gauges
            .get("vllm_num_requests_swapped")
            .map(|v| *v as u64);

        // Prefix cache hit rate as percentage, computed from the two counters
        // vLLM exposes (vllm:prefix_cache_hits / vllm:prefix_cache_queries).
        // Guard against queries == 0 so the tile stays blank until the engine
        // has served at least one prompt.
        let prefix_cache_hit_rate = {
            let hits = parsed.counters.get("vllm_prefix_cache_hits_total");
            let queries = parsed.counters.get("vllm_prefix_cache_queries_total");
            match (hits, queries) {
                (Some(&h), Some(&q)) if q > 0.0 => Some((h / q) * 100.0),
                _ => None,
            }
        };

        // Average queue wait time (from histogram)
        let queue_time_ms = {
            let sum = parsed.counters.get("vllm_request_queue_time_seconds_sum");
            let count = parsed.counters.get("vllm_request_queue_time_seconds_count");
            match (sum, count) {
                (Some(&s), Some(&c)) if c > 0.0 => Some((s / c) * 1000.0),
                _ => None,
            }
        };

        // Total preemptions — pass-through display field, read absolute value
        // from `raw` so the lifetime count stays continuous across baselining.
        let preemptions_total = raw
            .counters
            .get("vllm_num_preemptions_total")
            .map(|v| *v as u64);

        // Average batch size (tokens per iteration step)
        let avg_batch_size = {
            let sum = parsed.counters.get("vllm_iteration_tokens_total_sum");
            let count = parsed.counters.get("vllm_iteration_tokens_total_count");
            match (sum, count) {
                (Some(&s), Some(&c)) if c > 0.0 => Some(s / c),
                _ => None,
            }
        };

        // Average inter-token latency during decode (from histogram).
        // Guard against count == 0 so the tile stays blank until the engine
        // has streamed at least one inter-token gap.
        let inter_token_latency_ms = {
            let sum = parsed.counters.get("vllm_inter_token_latency_seconds_sum");
            let count = parsed
                .counters
                .get("vllm_inter_token_latency_seconds_count");
            match (sum, count) {
                (Some(&s), Some(&c)) if c > 0.0 => Some((s / c) * 1000.0),
                _ => None,
            }
        };

        // Tail latency percentiles. vLLM exposes `_bucket{le="..."}` lines for
        // each request-level histogram. We linearly interpolate p50/p95/p99 in
        // milliseconds (engine emits seconds). Returns `None` for the whole
        // struct when no buckets exist or the engine has not observed any
        // requests yet — the UI then renders dashes.
        let percentiles_ms = |metric: &str| -> Option<LatencyPercentiles> {
            let buckets = parsed.histograms.get(metric)?;
            let to_ms = |q: f64| percentile(buckets, q).map(|s| s * 1000.0);
            let p = LatencyPercentiles {
                p50_ms: to_ms(0.50),
                p95_ms: to_ms(0.95),
                p99_ms: to_ms(0.99),
            };
            // If every quantile is None (e.g. only +Inf bucket present),
            // collapse to None so the JSON payload stays compact.
            if p.p50_ms.is_none() && p.p95_ms.is_none() && p.p99_ms.is_none() {
                None
            } else {
                Some(p)
            }
        };
        let ttft_percentiles = percentiles_ms("vllm_time_to_first_token_seconds");
        let itl_percentiles = percentiles_ms("vllm_inter_token_latency_seconds");
        let e2e_percentiles = percentiles_ms("vllm_e2e_request_latency_seconds");

        // Goodput: % of histogram observations meeting the SLO. Thresholds
        // come in milliseconds; the histograms are in seconds, so divide by
        // 1000 before passing to fraction_le.
        let goodput_pct = |metric: &str, slo_ms: f64| -> Option<f64> {
            let buckets = parsed.histograms.get(metric)?;
            fraction_le(buckets, slo_ms / 1000.0).map(|f| f * 100.0)
        };
        let ttft_goodput_pct = goodput_pct("vllm_time_to_first_token_seconds", TTFT_SLO_MS);
        let itl_goodput_pct = goodput_pct("vllm_inter_token_latency_seconds", ITL_SLO_MS);
        let e2e_goodput_pct = goodput_pct("vllm_e2e_request_latency_seconds", E2E_SLO_MS);

        // While warming, histogram-derived metrics still compute from raw
        // pass-through counters/buckets (the tracker doesn't yet have a
        // baseline), so they would carry the slow first observation. Force
        // those fields to None until the tracker transitions to Active. Pass-
        // through fields (gauges + total/preemptions/prefix-cache-rate) stay
        // populated so the UI keeps showing live engine state during warmup.
        let blank = warming_up;
        Some(EngineMetrics {
            tokens_per_sec: if blank { None } else { tokens_per_sec },
            avg_tokens_per_sec: if blank { None } else { avg_tokens_per_sec },
            per_request_tps: if blank { None } else { per_request_tps },
            ttft_ms: if blank { None } else { ttft_ms },
            active_requests,
            queued_requests,
            kv_cache_percent,
            kv_cache_is_estimated: false,
            total_requests,
            e2e_latency_ms: if blank { None } else { e2e_latency_ms },
            prompt_tokens_per_sec: if blank { None } else { prompt_tokens_per_sec },
            avg_prompt_tokens_per_sec: if blank {
                None
            } else {
                avg_prompt_tokens_per_sec
            },
            per_request_prompt_tps: if blank { None } else { per_request_prompt_tps },
            swapped_requests,
            prefix_cache_hit_rate,
            queue_time_ms: if blank { None } else { queue_time_ms },
            inter_token_latency_ms: if blank { None } else { inter_token_latency_ms },
            preemptions_total,
            avg_batch_size: if blank { None } else { avg_batch_size },
            ttft_percentiles: if blank { None } else { ttft_percentiles },
            itl_percentiles: if blank { None } else { itl_percentiles },
            e2e_percentiles: if blank { None } else { e2e_percentiles },
            ttft_goodput_pct: if blank { None } else { ttft_goodput_pct },
            itl_goodput_pct: if blank { None } else { itl_goodput_pct },
            e2e_goodput_pct: if blank { None } else { e2e_goodput_pct },
            warming_up,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sanity check: percentiles flow from the parser through the adapter.
    /// We don't spin up an HTTP mock here — `parse_prometheus_text` is the
    /// boundary we care about, so we assert the percentile pipeline against
    /// a representative `/metrics` body. p50 < p95 < p99 must hold.
    #[test]
    fn ttft_percentiles_roundtrip_from_metrics_body() {
        let body = "\
# HELP vllm:time_to_first_token_seconds TTFT histogram.
# TYPE vllm:time_to_first_token_seconds histogram
vllm:time_to_first_token_seconds_bucket{le=\"0.05\"} 50
vllm:time_to_first_token_seconds_bucket{le=\"0.1\"} 80
vllm:time_to_first_token_seconds_bucket{le=\"0.5\"} 95
vllm:time_to_first_token_seconds_bucket{le=\"1.0\"} 99
vllm:time_to_first_token_seconds_bucket{le=\"+Inf\"} 100
vllm:time_to_first_token_seconds_sum 12.0
vllm:time_to_first_token_seconds_count 100.0
";
        let parsed = parse_prometheus_text(body).expect("parse");
        let buckets = parsed
            .histograms
            .get("vllm_time_to_first_token_seconds")
            .expect("histogram");
        let p50 = percentile(buckets, 0.5).expect("p50") * 1000.0;
        let p95 = percentile(buckets, 0.95).expect("p95") * 1000.0;
        let p99 = percentile(buckets, 0.99).expect("p99") * 1000.0;
        assert!(p50 < p95, "p50 {p50} < p95 {p95}");
        assert!(p95 < p99, "p95 {p95} < p99 {p99}");
        // p50 lands at the 0.05 boundary (cumulative count exactly 50).
        // p99 lands inside the (0.5, 1.0] bucket.
        assert!((40.0..=60.0).contains(&p50), "p50 {p50} near 50ms");
        assert!(p99 > 500.0 && p99 <= 1000.0, "p99 {p99} in (500, 1000]");
    }

    /// Integration check: the warmup tracker baselines after the first
    /// observation, and percentiles computed from the second `/metrics` body
    /// reflect *only* the post-baseline observations — proving that the slow
    /// first inference does not pollute steady-state percentiles.
    #[test]
    fn warmup_tracker_excludes_first_observation_from_percentiles() {
        use super::super::warmup::WarmupTracker;

        // Body 1: a single slow observation in the (1.0, +Inf] bucket.
        let body_warmup = "\
# HELP vllm:time_to_first_token_seconds TTFT histogram.
# TYPE vllm:time_to_first_token_seconds histogram
vllm:time_to_first_token_seconds_bucket{le=\"0.05\"} 0
vllm:time_to_first_token_seconds_bucket{le=\"0.1\"} 0
vllm:time_to_first_token_seconds_bucket{le=\"0.5\"} 0
vllm:time_to_first_token_seconds_bucket{le=\"1.0\"} 0
vllm:time_to_first_token_seconds_bucket{le=\"+Inf\"} 1
vllm:time_to_first_token_seconds_sum 8.0
vllm:time_to_first_token_seconds_count 1.0
";
        // Body 2: 100 fast observations all in [0, 0.05] on top of the warmup.
        let body_steady = "\
# HELP vllm:time_to_first_token_seconds TTFT histogram.
# TYPE vllm:time_to_first_token_seconds histogram
vllm:time_to_first_token_seconds_bucket{le=\"0.05\"} 100
vllm:time_to_first_token_seconds_bucket{le=\"0.1\"} 100
vllm:time_to_first_token_seconds_bucket{le=\"0.5\"} 100
vllm:time_to_first_token_seconds_bucket{le=\"1.0\"} 100
vllm:time_to_first_token_seconds_bucket{le=\"+Inf\"} 101
vllm:time_to_first_token_seconds_sum 9.0
vllm:time_to_first_token_seconds_count 101.0
";

        // Body 0: simulates the first poll right after the dashboard attaches
        // — no requests yet. The tracker captures count=0 as its initial
        // cursor here; it transitions to Active only once the cursor advances
        // by `skip_requests`.
        let body_idle = "\
# HELP vllm:time_to_first_token_seconds TTFT histogram.
# TYPE vllm:time_to_first_token_seconds histogram
vllm:time_to_first_token_seconds_bucket{le=\"0.05\"} 0
vllm:time_to_first_token_seconds_bucket{le=\"0.1\"} 0
vllm:time_to_first_token_seconds_bucket{le=\"0.5\"} 0
vllm:time_to_first_token_seconds_bucket{le=\"1.0\"} 0
vllm:time_to_first_token_seconds_bucket{le=\"+Inf\"} 0
vllm:time_to_first_token_seconds_sum 0.0
vllm:time_to_first_token_seconds_count 0.0
";

        let mut tracker = WarmupTracker::new(1);

        let parsed_idle = parse_prometheus_text(body_idle).expect("parse idle");
        let out_idle = tracker.observe(&parsed_idle);
        assert!(out_idle.warming_up);
        assert!(!out_idle.just_transitioned);

        let parsed_warmup = parse_prometheus_text(body_warmup).expect("parse warmup");
        let out_warmup = tracker.observe(&parsed_warmup);
        // After the warmup request lands, the tracker baselines and emits
        // warming_up=false, just_transitioned=true. The adjusted histogram
        // contains (current - baseline) where current == baseline → all zeros.
        assert!(!out_warmup.warming_up);
        assert!(out_warmup.just_transitioned);

        let parsed_steady = parse_prometheus_text(body_steady).expect("parse steady");
        let out_steady = tracker.observe(&parsed_steady);
        assert!(!out_steady.warming_up);
        assert!(!out_steady.just_transitioned);

        let buckets = out_steady
            .adjusted
            .histograms
            .get("vllm_time_to_first_token_seconds")
            .expect("histogram");
        let p50 = percentile(buckets, 0.5).expect("p50") * 1000.0;
        let p95 = percentile(buckets, 0.95).expect("p95") * 1000.0;
        // All 100 post-baseline observations live in [0, 0.05]; p50 and p95
        // must land inside that bucket. Without the tracker the slow warmup
        // observation would push p99 (and the +Inf overflow) into the tail.
        assert!(p50 <= 50.0, "p50 {p50} should be in fast bucket (<=50ms)");
        assert!(p95 <= 50.0, "p95 {p95} should be in fast bucket (<=50ms)");
        // Sum and count deltas: 1.0 sum across 100 fast observations.
        let sum = out_steady
            .adjusted
            .counters
            .get("vllm_time_to_first_token_seconds_sum")
            .copied()
            .expect("sum delta");
        let count = out_steady
            .adjusted
            .counters
            .get("vllm_time_to_first_token_seconds_count")
            .copied()
            .expect("count delta");
        assert!((sum - 1.0).abs() < 1e-9, "sum delta {sum}");
        assert!((count - 100.0).abs() < 1e-9, "count delta {count}");
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
