use std::collections::HashMap;
use std::io::BufRead;

/// Parsed Prometheus metrics separated by type.
pub struct ParsedMetrics {
    pub gauges: HashMap<String, f64>,
    pub counters: HashMap<String, f64>,
    /// Histogram bucket data, keyed by the base metric name (without the
    /// `_bucket` suffix). Each entry is a list of `(le, cumulative_count)`
    /// pairs sorted ascending by `le`, including the `+Inf` bucket if present.
    pub histograms: HashMap<String, Vec<(f64, f64)>>,
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
    let normalized = body.replace("vllm:", "vllm_");

    let reader = std::io::BufReader::new(normalized.as_bytes());
    let scrape = prometheus_parse::Scrape::parse(reader.lines()).ok()?;

    let mut gauges = HashMap::new();
    let mut counters = HashMap::new();
    let mut histograms: HashMap<String, Vec<(f64, f64)>> = HashMap::new();

    for sample in &scrape.samples {
        match &sample.value {
            prometheus_parse::Value::Gauge(v) => {
                gauges.insert(sample.metric.clone(), *v);
            }
            prometheus_parse::Value::Counter(v) => {
                counters.insert(sample.metric.clone(), *v);
            }
            prometheus_parse::Value::Histogram(buckets) => {
                // `prometheus-parse` aggregates `_bucket` lines into a single
                // sample keyed by the base metric name. Counts are cumulative
                // (Prometheus convention) and the `+Inf` bucket (if present)
                // carries the total. Sort defensively in case the exposition
                // order is non-monotonic.
                let mut bs: Vec<(f64, f64)> =
                    buckets.iter().map(|b| (b.less_than, b.count)).collect();
                bs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
                histograms.insert(sample.metric.clone(), bs);
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

    Some(ParsedMetrics {
        gauges,
        counters,
        histograms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// vLLM exposes prefix cache activity as two counters. The Prometheus
    /// client library auto-appends `_total` in the exposition format, and our
    /// normalizer rewrites `vllm:` to `vllm_`. Both names must land in
    /// `counters` for the hit-rate computation in vllm.rs to work.
    #[test]
    fn captures_prefix_cache_counters() {
        let body = "\
# HELP vllm:prefix_cache_queries Cached tokens queried.
# TYPE vllm:prefix_cache_queries counter
vllm:prefix_cache_queries_total 100.0
# HELP vllm:prefix_cache_hits Cached tokens hit.
# TYPE vllm:prefix_cache_hits counter
vllm:prefix_cache_hits_total 42.0
";
        let parsed = parse_prometheus_text(body).expect("parse");
        assert_eq!(
            parsed.counters.get("vllm_prefix_cache_queries_total"),
            Some(&100.0)
        );
        assert_eq!(
            parsed.counters.get("vllm_prefix_cache_hits_total"),
            Some(&42.0)
        );
    }

    /// vLLM exposes inter-token latency as a histogram. The `_sum` / `_count`
    /// samples come through as Untyped lines, and must land in `counters`
    /// under the colon-normalized name so the vllm adapter can compute
    /// `sum / count` for the average ITL tile.
    #[test]
    fn captures_inter_token_latency_histogram() {
        let body = "\
# HELP vllm:inter_token_latency_seconds Histogram of inter-token latency in seconds.
# TYPE vllm:inter_token_latency_seconds histogram
vllm:inter_token_latency_seconds_bucket{le=\"0.01\"} 10
vllm:inter_token_latency_seconds_bucket{le=\"+Inf\"} 100
vllm:inter_token_latency_seconds_sum 5.0
vllm:inter_token_latency_seconds_count 100.0
";
        let parsed = parse_prometheus_text(body).expect("parse");
        assert_eq!(
            parsed.counters.get("vllm_inter_token_latency_seconds_sum"),
            Some(&5.0)
        );
        assert_eq!(
            parsed
                .counters
                .get("vllm_inter_token_latency_seconds_count"),
            Some(&100.0)
        );
    }

    /// Histogram bucket lines must land in `histograms` keyed by the base
    /// metric name (no `_bucket` suffix), with cumulative counts preserved.
    /// Required for percentile computation in the vLLM adapter.
    #[test]
    fn captures_histogram_buckets() {
        let body = "\
# HELP vllm:time_to_first_token_seconds TTFT histogram.
# TYPE vllm:time_to_first_token_seconds histogram
vllm:time_to_first_token_seconds_bucket{le=\"0.1\"} 10
vllm:time_to_first_token_seconds_bucket{le=\"0.5\"} 50
vllm:time_to_first_token_seconds_bucket{le=\"1.0\"} 90
vllm:time_to_first_token_seconds_bucket{le=\"+Inf\"} 100
vllm:time_to_first_token_seconds_sum 25.0
vllm:time_to_first_token_seconds_count 100.0
";
        let parsed = parse_prometheus_text(body).expect("parse");
        let buckets = parsed
            .histograms
            .get("vllm_time_to_first_token_seconds")
            .expect("histogram captured");
        // Sorted ascending by le, +Inf last.
        assert_eq!(buckets.len(), 4);
        assert_eq!(buckets[0], (0.1, 10.0));
        assert_eq!(buckets[1], (0.5, 50.0));
        assert_eq!(buckets[2], (1.0, 90.0));
        assert!(buckets[3].0.is_infinite() && buckets[3].0 > 0.0);
        assert_eq!(buckets[3].1, 100.0);
    }

    #[test]
    fn missing_prefix_cache_counters_parse_cleanly() {
        let body = "\
# HELP vllm:num_requests_running Running requests.
# TYPE vllm:num_requests_running gauge
vllm:num_requests_running 0.0
";
        let parsed = parse_prometheus_text(body).expect("parse");
        assert!(!parsed.counters.contains_key("vllm_prefix_cache_hits_total"));
        assert!(!parsed
            .counters
            .contains_key("vllm_prefix_cache_queries_total"));
    }
}
