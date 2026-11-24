//! Hibana (github.com/sharar-project/hibana), an OpenAI-compatible inference
//! server. SD1 introduces only the type and this stub: the adapter answers
//! nothing about the engine yet, and SD3 fills in the real metrics and model
//! resolution.

use super::common::EngineHttp;
use super::model_info::ModelResolver;
use super::prometheus::ParsedMetrics;
use super::LatencyPercentiles;
use super::{EngineAdapter, EngineMetrics, EngineStatus, EngineType, MetricGroup, ModelResolution};
use async_trait::async_trait;
use std::collections::BTreeSet;

/// Instantaneous figures plus the two lifetime token counters SD3 needs.
#[allow(dead_code)]
pub struct HibanaSnapshot {
    pub metrics: EngineMetrics,
    pub prefill_tokens: Option<u64>,
    pub decode_tokens: Option<u64>,
}

/// Map a parsed Hibana `/metrics` scrape; a missing metric is `None`, never
/// a fabricated 0.
#[allow(dead_code)]
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
    let metrics = EngineMetrics {
        active_requests: gauge("hibana_running")
            .zip(gauge("hibana_prefilling"))
            .map(|(r, p)| (r + p) as u64),
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
    /// The model named on the launch line, shown until `/v1/models` says
    /// better (SD3).
    model: ModelResolver,
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

    /// SD3 declares the groups Hibana actually scrapes.
    fn metric_groups(&self) -> BTreeSet<MetricGroup> {
        BTreeSet::new()
    }

    async fn health_check(&self) -> EngineStatus {
        self.http.health("/health").await
    }

    async fn get_model_info(&self) -> ModelResolution {
        self.model.resolve(&self.http).await
    }

    /// Nothing to scrape yet, so nothing is asked.
    async fn get_metrics(&self) -> Option<EngineMetrics> {
        None
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
        assert!(snap("hibana_running 1\n").metrics.active_requests.is_none());
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

    #[tokio::test]
    async fn the_stub_adapter_reports_nothing_yet() {
        let adapter = HibanaAdapter::new(
            reqwest::Client::new(),
            "http://127.0.0.1:8888".into(),
            None,
            None,
        );
        assert_eq!(adapter.engine_type(), EngineType::Hibana);
        assert_eq!(adapter.endpoint(), "http://127.0.0.1:8888");
        assert!(adapter.metric_groups().is_empty());
        assert!(adapter.get_metrics().await.is_none());
    }
}
