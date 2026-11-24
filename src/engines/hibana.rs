//! Hibana (github.com/sharar-project/hibana), an OpenAI-compatible inference
//! server. SD1 introduces only the type and this stub: the adapter answers
//! nothing about the engine yet, and SD3 fills in the real metrics and model
//! resolution.

use super::common::EngineHttp;
use super::model_info::ModelResolver;
use super::{EngineAdapter, EngineMetrics, EngineStatus, EngineType, MetricGroup, ModelResolution};
use async_trait::async_trait;
use std::collections::BTreeSet;

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
