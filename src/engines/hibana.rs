//! Hibana (github.com/sharar-project/hibana), an OpenAI-compatible inference
//! server. SD3 fills the SD1 stub: `/metrics` rates, warmup and totals, and
//! the model from `/v1/models`, which answers as vLLM does.

use super::common::{warmup_skip_from_env, CounterRate, EngineHttp};
use super::model_info::ModelResolver;
use super::prometheus::{parse_prometheus_text, ParsedMetrics};
use super::warmup::WarmupTracker;
use super::LatencyPercentiles;
use super::{EngineAdapter, EngineMetrics, EngineStatus, EngineType, MetricGroup, ModelResolution};
use async_trait::async_trait;
use std::collections::BTreeSet;
use std::time::Instant;
use tokio::sync::Mutex;

// Hibana's request counter (warmup trigger) and its two token counters,
// which Hibana files as unlabeled gauges.
const WARMUP_TRIGGER_KEY: &str = "hibana_finished";
const GEN_TOKEN_KEY: &str = "hibana_decode_tokens";
const PROMPT_TOKEN_KEY: &str = "hibana_prefill_tokens";

/// Instantaneous figures plus the two lifetime token counters SD3 needs.
pub struct HibanaSnapshot {
    pub metrics: EngineMetrics,
    pub prefill_tokens: Option<u64>,
    pub decode_tokens: Option<u64>,
}

/// Map a parsed Hibana `/metrics` scrape; a missing metric is `None`, never
/// a fabricated 0. `active_requests` is the running gauge plus the prefilling
/// gauge: both present is their sum, either one alone answers the count.
pub fn hibana_metrics(parsed: &ParsedMetrics) -> HibanaSnapshot {
    let counter = |name: &str| {
        parsed
            .counters
            .get(name)
            .copied()
            .or_else(|| parsed.gauge_sum(name))
    };
    let gauge = |name: &str| parsed.gauge_sum(name);

    let (p50, p95) = (gauge("hibana_ttft_p50"), gauge("hibana_ttft_p95"));
    let (running, prefilling) = (gauge("hibana_running"), gauge("hibana_prefilling"));
    let metrics = EngineMetrics {
        active_requests: running
            .zip(prefilling)
            .map(|(r, p)| r + p)
            .or(running)
            .or(prefilling)
            .map(|v| v as u64),
        queued_requests: gauge("hibana_queued").map(|v| v as u64),
        total_requests: counter("hibana_finished").map(|v| v as u64),
        ttft_ms: p50.map(|v| v * 1000.0),
        ttft_percentiles: (p50.is_some() || p95.is_some()).then(|| LatencyPercentiles {
            p50_ms: p50.map(|v| v * 1000.0),
            p95_ms: p95.map(|v| v * 1000.0),
            p99_ms: None,
        }),
        inter_token_latency_ms: gauge("hibana_avg_step_ms")
            .zip(counter("hibana_decode_steps"))
            .and_then(|(a, s)| {
                let t = counter("hibana_decode_tokens")?;
                (t > 0.0).then_some(a * s / t)
            }),
        ..Default::default()
    };
    HibanaSnapshot {
        metrics,
        prefill_tokens: counter("hibana_prefill_tokens").map(|v| v as u64),
        decode_tokens: counter("hibana_decode_tokens").map(|v| v as u64),
    }
}

pub struct HibanaAdapter {
    /// The endpoint, and the bearer token of a launch that asks for one.
    http: EngineHttp,
    /// Model identity: `/v1/models`, the command-line hint, HF enrichment.
    model: ModelResolver,
    gen_rate: Mutex<CounterRate>,
    prompt_rate: Mutex<CounterRate>,
    warmup: Mutex<WarmupTracker>,
}

impl HibanaAdapter {
    pub fn new(
        client: reqwest::Client,
        endpoint: String,
        served_model: Option<String>,
        api_key: Option<String>,
    ) -> Self {
        Self {
            http: EngineHttp::new(client, endpoint, api_key),
            model: ModelResolver::new(served_model),
            gen_rate: Mutex::default(),
            prompt_rate: Mutex::default(),
            warmup: Mutex::new(WarmupTracker::new(
                warmup_skip_from_env(),
                WARMUP_TRIGGER_KEY,
            )),
        }
    }
}

#[async_trait]
impl EngineAdapter for HibanaAdapter {
    fn engine_type(&self) -> EngineType {
        EngineType::Hibana
    }

    fn endpoint(&self) -> &str {
        self.http.endpoint()
    }

    /// The groups whose fields the scrape fills; the tiles it leaves out —
    /// the KV and prefix cache among them — read "not reported" (ADR-0004).
    fn metric_groups(&self) -> BTreeSet<MetricGroup> {
        [
            MetricGroup::Throughput,
            MetricGroup::ActiveRequests,
            MetricGroup::RequestTotal,
            MetricGroup::TtftMean,
            MetricGroup::TtftPercentiles,
            MetricGroup::ItlMean,
        ]
        .into_iter()
        .collect()
    }

    async fn health_check(&self) -> EngineStatus {
        self.http.health("/health").await
    }

    async fn get_model_info(&self) -> ModelResolution {
        self.model.resolve(&self.http).await
    }

    /// The rates and warmup state; the pure `hibana_metrics` does the mapping.
    async fn get_metrics(&self) -> Option<EngineMetrics> {
        let resp = self.http.get("/metrics").send().await.ok()?;
        let status = resp.status();
        let body = resp.text().await.ok()?;
        let mut raw = match (status.is_success(), parse_prometheus_text(&body)) {
            (true, Some(parsed)) => parsed,
            _ => return None,
        };
        // Hibana files its token counters as unlabeled gauges; the tracker
        // reads counters, so they go in as pseudo-counters. A drop in any of
        // them is a restart, which the tracker detects the same way.
        for name in [WARMUP_TRIGGER_KEY, GEN_TOKEN_KEY, PROMPT_TOKEN_KEY] {
            if let Some(v) = raw.gauge_sum(name) {
                raw.counters.insert(name.to_string(), v);
            }
        }
        let out = self.warmup.lock().await.observe(&raw);
        if out.just_transitioned {
            self.gen_rate.lock().await.reset();
            self.prompt_rate.lock().await.reset();
        }
        // The tile and the rate share one span: the raw snapshot while
        // warming, the since-baseline counts after it.
        let snap = hibana_metrics(&raw);
        let adj = |key: &str| out.adjusted.counters.get(key).copied().map(|v| v as u64);
        let (gen, prompt) = if out.warming_up {
            (snap.decode_tokens, snap.prefill_tokens)
        } else {
            (adj(GEN_TOKEN_KEY), adj(PROMPT_TOKEN_KEY))
        };
        let now = Instant::now();
        let (tps, avg_tps) = self
            .gen_rate
            .lock()
            .await
            .observe(gen.map(|v| v as f64), now);
        let (p_tps, avg_p_tps) = self
            .prompt_rate
            .lock()
            .await
            .observe(prompt.map(|v| v as f64), now);

        let mut m = snap.metrics;
        m.total_generation_tokens = gen;
        m.total_prompt_tokens = prompt;
        m.tokens_per_sec = tps.filter(|_| !out.warming_up);
        m.avg_tokens_per_sec = avg_tps.filter(|_| !out.warming_up);
        m.prompt_tokens_per_sec = p_tps.filter(|_| !out.warming_up);
        m.avg_prompt_tokens_per_sec = avg_p_tps.filter(|_| !out.warming_up);
        m.warming_up = out.warming_up;
        Some(m)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engines::prometheus::parse_prometheus_text;

    /// A live capture from a Hibana server, kept verbatim.
    const REAL: &str = include_str!("fixtures/hibana_metrics.txt");

    fn snap(text: &str) -> HibanaSnapshot {
        hibana_metrics(&parse_prometheus_text(text).expect("parses"))
    }

    #[test]
    fn real_scrape_maps_to_the_expected_figures() {
        let s = snap(REAL);
        let m = &s.metrics;
        assert_eq!(m.active_requests, Some(0));
        assert_eq!(m.queued_requests, Some(0));
        assert_eq!(m.total_requests, Some(31));
        assert_eq!(m.ttft_ms, Some(94.32393498718739));
        let p = m.ttft_percentiles.as_ref().expect("percentiles");
        assert_eq!(p.p50_ms, Some(94.32393498718739));
        assert_eq!(p.p95_ms, Some(795.9507370251231));
        assert_eq!(p.p99_ms, None);
        assert_eq!(m.inter_token_latency_ms, Some(7.803612112330116));
        assert_eq!(s.prefill_tokens, Some(929));
        assert_eq!(s.decode_tokens, Some(15841));
        assert!(m.kv_cache_percent.is_none() && m.e2e_latency_ms.is_none());
    }

    /// Either gauge alone is the count, and both together are their sum.
    #[test]
    fn one_gauge_of_a_kind_is_enough() {
        assert_eq!(snap("hibana_running 1\n").metrics.active_requests, Some(1));
        assert_eq!(
            snap("hibana_prefilling 2\n").metrics.active_requests,
            Some(2)
        );
        assert_eq!(
            snap("hibana_running 1\nhibana_prefilling 2\n")
                .metrics
                .active_requests,
            Some(3),
        );
    }

    #[test]
    fn an_empty_body_gives_no_figures() {
        let s = snap("");
        assert!(s.metrics.active_requests.is_none() && s.metrics.queued_requests.is_none());
        assert!(s.metrics.total_requests.is_none() && s.metrics.ttft_ms.is_none());
        assert!(s.metrics.ttft_percentiles.is_none() && s.metrics.inter_token_latency_ms.is_none());
        assert!(s.prefill_tokens.is_none() && s.decode_tokens.is_none());
    }

    #[test]
    fn zero_decode_tokens_gives_no_itl() {
        let s = snap("hibana_avg_step_ms 10\nhibana_decode_steps 5\nhibana_decode_tokens 0\n");
        assert!(s.metrics.inter_token_latency_ms.is_none());
        let p = snap("hibana_ttft_p50 0.1\n")
            .metrics
            .ttft_percentiles
            .unwrap();
        assert_eq!(p.p50_ms, Some(100.0));
        assert_eq!(p.p95_ms, None);
    }

    #[test]
    fn hibana_engine_type_round_trips_through_its_wire_name() {
        let value = serde_json::to_value(EngineType::Hibana).unwrap();
        assert_eq!(value, "Hibana");
        assert_eq!(
            serde_json::from_str::<EngineType>("\"Hibana\"").unwrap(),
            EngineType::Hibana
        );
        assert_eq!(EngineType::Hibana.to_string(), "Hibana");
    }

    /// The declared set is the one that keeps every figure the scrape fills.
    #[test]
    fn hibana_declares_only_the_groups_its_scrape_fills() {
        let adapter = HibanaAdapter::new(
            reqwest::Client::new(),
            "http://127.0.0.1:1".into(),
            None,
            None,
        );
        assert_eq!(
            adapter.metric_groups(),
            [
                MetricGroup::Throughput,
                MetricGroup::ActiveRequests,
                MetricGroup::RequestTotal,
                MetricGroup::TtftMean,
                MetricGroup::TtftPercentiles,
                MetricGroup::ItlMean,
            ]
            .into_iter()
            .collect::<BTreeSet<_>>(),
        );
    }

    /// A scrape with the request total and token counters grown to `n`.
    fn scrape(n: u64) -> String {
        format!(
            "hibana_running 2\nhibana_queued 1\nhibana_finished {}\n\
             hibana_prefill_tokens {}\nhibana_decode_tokens {}\n\
             hibana_ttft_p50 0.1\nhibana_avg_step_ms 4\nhibana_decode_steps 100\n",
            2 + n,
            100 + 20 * n,
            500 + 100 * n,
        )
    }

    /// The three checks in one live-server test: the SD2 fixture and a
    /// vLLM-shaped `/v1/models` body report the model and the gauges; two
    /// scrapes with a growing `hibana_decode_tokens` (skip=0, so the first is
    /// the baseline) read as a positive rate; a 500 on `/metrics` is no
    /// metrics, not a panic.
    #[tokio::test]
    async fn model_rates_and_failures_against_a_test_server() {
        use crate::engines::test_server::TestServer;
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::sync::Arc;

        let dead = TestServer::start(|_| (500, "Internal Server Error".into())).await;
        let adapter = HibanaAdapter::new(reqwest::Client::new(), dead.url.clone(), None, None);
        assert!(adapter.get_metrics().await.is_none());

        let live = TestServer::start(|r| match r.path.as_str() {
            "/metrics" => (200, REAL.to_string()),
            "/v1/models" => (
                200,
                r#"{"data":[{"id":"RadixArk/Qwen3.8-Flash-Next-NVFP4","owned_by":"hibana"}]}"#
                    .to_string(),
            ),
            _ => (404, String::new()),
        })
        .await;
        let adapter = HibanaAdapter::new(reqwest::Client::new(), live.url.clone(), None, None);
        assert_eq!(adapter.engine_type(), EngineType::Hibana);
        assert_eq!(
            adapter.get_model_info().await.model.expect("a model").name,
            "RadixArk/Qwen3.8-Flash-Next-NVFP4"
        );
        let m = adapter.get_metrics().await.expect("a scrape");
        assert_eq!(m.active_requests, Some(0));
        assert_eq!(m.total_requests, Some(31));
        assert!(m.tokens_per_sec.is_none(), "the first read has no span");

        let calls = Arc::new(AtomicU64::new(0));
        let growing = TestServer::start(move |r| {
            if r.path != "/metrics" {
                return (404, String::new());
            }
            (200, scrape(calls.fetch_add(1, Ordering::SeqCst)))
        })
        .await;
        let adapter = HibanaAdapter::new(reqwest::Client::new(), growing.url.clone(), None, None);
        *adapter.warmup.lock().await = WarmupTracker::new(0, WARMUP_TRIGGER_KEY);
        assert!(!adapter.get_metrics().await.expect("a scrape").warming_up);

        tokio::time::sleep(std::time::Duration::from_millis(15)).await;
        let second = adapter.get_metrics().await.expect("a scrape");
        assert_eq!(
            second.total_generation_tokens,
            Some(100),
            "since the baseline"
        );
        assert_eq!(second.total_prompt_tokens, Some(20));
        assert_eq!(second.total_requests, Some(3), "the lifetime count");
        assert!(second.tokens_per_sec.unwrap() > 0.0);
        assert!(second.avg_tokens_per_sec.unwrap() > 0.0);
        assert!(second.prompt_tokens_per_sec.unwrap() > 0.0);
    }
}
