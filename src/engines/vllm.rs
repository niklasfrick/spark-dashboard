use super::prometheus::parse_prometheus_text;
use super::{EngineAdapter, EngineMetrics, EngineStatus, EngineType, ModelInfo};
use async_trait::async_trait;
use serde::Deserialize;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

pub struct VllmAdapter {
    client: reqwest::Client,
    endpoint: String,
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
    pub fn new(client: reqwest::Client, endpoint: String) -> Self {
        Self {
            client,
            endpoint,
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
        let resp = self
            .client
            .get(format!("{}/v1/models", self.endpoint))
            .timeout(Duration::from_secs(2))
            .send()
            .await
            .ok()?;
        let models: OpenAIModelsResponse = resp.json().await.ok()?;
        let model = models.data.first()?;
        Some(ModelInfo {
            name: model.id.clone(),
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
                .or_else(|| parsed.counters.get("vllm_time_per_output_token_seconds_sum"));
            let count = parsed
                .counters
                .get("vllm_request_time_per_output_token_seconds_count")
                .or_else(|| parsed.counters.get("vllm_time_per_output_token_seconds_count"));
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
            let count = parsed.counters.get("vllm_e2e_request_latency_seconds_count");
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

        // GPU prefix cache hit rate (0.0-1.0 gauge → 0-100%)
        let prefix_cache_hit_rate = parsed
            .gauges
            .get("vllm_gpu_prefix_cache_hit_rate")
            .map(|v| v * 100.0);

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
            preemptions_total,
            avg_batch_size,
        })
    }
}
