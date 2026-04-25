use super::histogram::percentile;
use super::prometheus::parse_prometheus_text;
use super::{
    EngineAdapter, EngineMetrics, EngineStatus, EngineType, LatencyPercentiles, ModelInfo,
};
use async_trait::async_trait;
use serde::Deserialize;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

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
        }
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

        Some(ModelInfo {
            name,
            parameter_size: None,
            quantization: None,
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

        let parsed = parse_prometheus_text(&body)?;

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

        let total_requests = ttft_count.map(|&c| c as u64);

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

        // Total preemptions
        let preemptions_total = parsed
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

        Some(EngineMetrics {
            tokens_per_sec,
            avg_tokens_per_sec,
            per_request_tps,
            ttft_ms,
            active_requests,
            queued_requests,
            kv_cache_percent,
            kv_cache_is_estimated: false,
            total_requests,
            e2e_latency_ms,
            prompt_tokens_per_sec,
            avg_prompt_tokens_per_sec,
            per_request_prompt_tps,
            swapped_requests,
            prefix_cache_hit_rate,
            queue_time_ms,
            inter_token_latency_ms,
            preemptions_total,
            avg_batch_size,
            ttft_percentiles,
            itl_percentiles,
            e2e_percentiles,
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
}
