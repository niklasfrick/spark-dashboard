use std::collections::HashMap;
use std::io::BufRead;

/// Parsed Prometheus metrics separated by type.
pub struct ParsedMetrics {
    pub gauges: HashMap<String, f64>,
    pub counters: HashMap<String, f64>,
}

/// Parse a Prometheus text exposition format body into typed metrics.
///
/// Gauges are stored directly. Counters are stored separately so callers can
/// compute rates (delta / elapsed). Histogram `_sum` and `_count` suffixed
/// samples are stored in counters for average computation (e.g. avg TTFT =
/// sum / count). Untyped samples are treated as gauges.
pub fn parse_prometheus_text(body: &str) -> Option<ParsedMetrics> {
    // Normalize colons in metric name prefixes to underscores. vLLM uses colons
    // (e.g. "vllm:kv_cache_usage_perc") which are reserved for Prometheus recording
    // rules and get silently dropped by prometheus-parse. Replace in both metric
    // lines and # TYPE/# HELP lines so the parser can match samples to their type
    // declarations.
    let normalized = body
        .replace("vllm:", "vllm_");

    let reader = std::io::BufReader::new(normalized.as_bytes());
    let scrape = prometheus_parse::Scrape::parse(reader.lines()).ok()?;

    let mut gauges = HashMap::new();
    let mut counters = HashMap::new();

    for sample in &scrape.samples {
        match &sample.value {
            prometheus_parse::Value::Gauge(v) => {
                gauges.insert(sample.metric.clone(), *v);
            }
            prometheus_parse::Value::Counter(v) => {
                counters.insert(sample.metric.clone(), *v);
            }
            prometheus_parse::Value::Histogram(_) => {
                // Histogram bucket data is aggregated by prometheus-parse.
                // The _sum and _count lines for histograms appear as Untyped
                // samples and are captured below.
            }
            prometheus_parse::Value::Summary(_) => {
                // Summary quantile data handled by prometheus-parse.
                // _sum and _count appear as Untyped and are captured below.
            }
            prometheus_parse::Value::Untyped(v) => {
                // Histogram _sum/_count lines and other untyped metrics
                // land here. Store in counters if the name ends with _sum
                // or _count (useful for rate/average computation), otherwise
                // treat as gauge.
                let name = &sample.metric;
                if name.ends_with("_sum") || name.ends_with("_count") || name.ends_with("_total") {
                    counters.insert(name.clone(), *v);
                } else {
                    gauges.insert(name.clone(), *v);
                }
            }
        }
    }

    Some(ParsedMetrics { gauges, counters })
}
