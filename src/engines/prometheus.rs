use std::collections::HashMap;
use std::io::BufRead;

/// One label series of a gauge: the labels that tell it apart, and its value.
#[derive(Clone, Debug, PartialEq)]
pub struct GaugeSeries {
    pub labels: HashMap<String, String>,
    pub value: f64,
}

/// Parsed Prometheus metrics separated by type, each metric name holding its
/// label series combined — see `parse_prometheus_text` for how.
#[derive(Clone, Debug, Default)]
pub struct ParsedMetrics {
    /// Every label series of each gauge, in exposition order. Kept apart, not
    /// combined at parse time, because how a gauge combines depends on what it
    /// measures: read a count through `gauge_sum` and a ratio through
    /// `gauge_mean`.
    pub gauges: HashMap<String, Vec<GaugeSeries>>,
    /// Counters, and histogram `_sum`/`_count` samples, summed across their
    /// label series.
    pub counters: HashMap<String, f64>,
    /// Histogram bucket data, keyed by the base metric name (without the
    /// `_bucket` suffix). Each entry is a list of `(le, cumulative_count)`
    /// pairs sorted ascending by `le`, including the `+Inf` bucket if present,
    /// with the counts of every label series summed per `le`.
    pub histograms: HashMap<String, Vec<(f64, f64)>>,
}

impl ParsedMetrics {
    /// A gauge summed across its label series — for a count whose series
    /// partition the engine's work, one per data-parallel rank or engine core:
    /// requests running, requests waiting. `None` when the gauge is absent.
    pub fn gauge_sum(&self, name: &str) -> Option<f64> {
        let series = self.gauges.get(name).filter(|s| !s.is_empty())?;
        Some(series.iter().map(|g| g.value).sum())
    }

    /// A gauge averaged across its label series — for a ratio, which a sum
    /// would push past 1: KV cache usage. Each series is one replica's own
    /// pool, and the replicas of one engine serve the same model with pools
    /// sized alike, so the mean of their usage ratios is the engine-wide
    /// used-over-capacity. `None` when the gauge is absent.
    pub fn gauge_mean(&self, name: &str) -> Option<f64> {
        let series = self.gauges.get(name).filter(|s| !s.is_empty())?;
        Some(series.iter().map(|g| g.value).sum::<f64>() / series.len() as f64)
    }
}

/// Parse a Prometheus text exposition format body into typed metrics.
///
/// Gauges keep every label series. Counters are stored separately so callers
/// can compute rates (delta / elapsed). Histogram `_sum` and `_count` suffixed
/// samples are stored in counters for average computation (e.g. avg TTFT =
/// sum / count). Untyped samples are treated as gauges.
///
/// One logical metric is often split across label series: vLLM labels each
/// data-parallel engine core (`engine="0"`, `engine="1"`), SGLang splits
/// request counters and histograms by `is_streaming` and labels each rank.
/// Every series is a share of the engine's total, so counters, histogram
/// sums and counts, and bucket counts per `le` are summed — keeping one
/// series, as a plain name-keyed map would, reports a fraction of the engine
/// that depends on exposition order.
pub fn parse_prometheus_text(body: &str) -> Option<ParsedMetrics> {
    // Normalize colons in metric name prefixes to underscores. vLLM, SGLang,
    // llama.cpp and TensorFold use colons (e.g. "vllm:kv_cache_usage_perc",
    // "sglang:num_running_reqs", "llamacpp:tokens_predicted_total",
    // "tensorfold:requests_running") which are reserved for Prometheus
    // recording rules and get silently dropped by prometheus-parse. Replace in
    // both metric lines and # TYPE/# HELP lines so the parser can match
    // samples to their type declarations.
    let normalized = body
        .replace("vllm:", "vllm_")
        .replace("sglang:", "sglang_")
        .replace("llamacpp:", "llamacpp_")
        .replace("tensorfold:", "tensorfold_");

    let reader = std::io::BufReader::new(normalized.as_bytes());
    let scrape = prometheus_parse::Scrape::parse(reader.lines()).ok()?;

    let mut gauges: HashMap<String, Vec<GaugeSeries>> = HashMap::new();
    let mut counters: HashMap<String, f64> = HashMap::new();
    let mut histograms: HashMap<String, Vec<(f64, f64)>> = HashMap::new();

    for sample in &scrape.samples {
        match &sample.value {
            prometheus_parse::Value::Gauge(v) => {
                gauges
                    .entry(sample.metric.clone())
                    .or_default()
                    .push(GaugeSeries {
                        labels: (*sample.labels).clone(),
                        value: *v,
                    });
            }
            prometheus_parse::Value::Counter(v) => {
                *counters.entry(sample.metric.clone()).or_insert(0.0) += *v;
            }
            prometheus_parse::Value::Histogram(buckets) => {
                // `prometheus-parse` aggregates `_bucket` lines into one
                // sample per label set (the `le` label read off wherever it
                // sits), keyed by the base metric name. Counts are cumulative
                // (Prometheus convention) and the `+Inf` bucket (if present)
                // carries the total, so the label sets merge by adding counts
                // bucket for bucket.
                let merged = histograms.entry(sample.metric.clone()).or_default();
                for b in buckets {
                    match merged.iter_mut().find(|(le, _)| *le == b.less_than) {
                        Some((_, count)) => *count += b.count,
                        None => merged.push((b.less_than, b.count)),
                    }
                }
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
                    *counters.entry(name.clone()).or_insert(0.0) += *v;
                } else {
                    gauges.entry(name.clone()).or_default().push(GaugeSeries {
                        labels: (*sample.labels).clone(),
                        value: *v,
                    });
                }
            }
        }
    }

    // Sort defensively in case the exposition order is non-monotonic, and
    // because merged label sets append their buckets in arrival order.
    for buckets in histograms.values_mut() {
        buckets.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
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

    /// llama-server prefixes every series `llamacpp:`, in samples and in
    /// `# TYPE` lines alike. The colon is normalized like vLLM's and SGLang's,
    /// so each sample keeps the type its declaration gives it — a counter
    /// lands in `counters`, a gauge in `gauges` — and a labelled counter's
    /// series sum.
    #[test]
    fn llamacpp_series_arrive_under_underscored_names_with_their_types() {
        let body = "\
# HELP llamacpp:tokens_predicted_total Number of generation tokens processed
# TYPE llamacpp:tokens_predicted_total counter
llamacpp:tokens_predicted_total 1803
# HELP llamacpp:n_tokens_max Largest observed sequence length (prompt + generation)
# TYPE llamacpp:n_tokens_max counter
llamacpp:n_tokens_max 642
# HELP llamacpp:requests_processing Number of requests processing
# TYPE llamacpp:requests_processing gauge
llamacpp:requests_processing 2
# TYPE llamacpp:spec_decode_num_accepted_tokens_per_pos_total counter
llamacpp:spec_decode_num_accepted_tokens_per_pos_total{position=\"0\"} 82
llamacpp:spec_decode_num_accepted_tokens_per_pos_total{position=\"1\"} 80
";
        let parsed = parse_prometheus_text(body).expect("parse");
        assert_eq!(
            parsed.counters.get("llamacpp_tokens_predicted_total"),
            Some(&1803.0)
        );
        assert_eq!(parsed.counters.get("llamacpp_n_tokens_max"), Some(&642.0));
        assert_eq!(parsed.gauge_sum("llamacpp_requests_processing"), Some(2.0));
        assert_eq!(
            parsed
                .counters
                .get("llamacpp_spec_decode_num_accepted_tokens_per_pos_total"),
            Some(&162.0)
        );
        assert!(parsed.gauges.keys().all(|name| !name.contains(':')));
    }

    /// TensorFold prefixes every series `tensorfold:`, in samples and in
    /// `# TYPE` lines alike. The colon is normalized like the other engines'
    /// prefixes, so each sample keeps the type its declaration gives it — a
    /// counter lands in `counters`, a gauge in `gauges`, a histogram under its
    /// base name — and the adapter can read them under the underscored names.
    #[test]
    fn tensorfold_series_arrive_under_underscored_names_with_their_types() {
        let body = "\
# HELP tensorfold:requests_running Requests in prefill or decode.
# TYPE tensorfold:requests_running gauge
tensorfold:requests_running 2
# HELP tensorfold:prompt_tokens_total Prompt tokens of finished requests.
# TYPE tensorfold:prompt_tokens_total counter
tensorfold:prompt_tokens_total 1203686
# HELP tensorfold:time_to_first_token_seconds Seconds from arrival to the first generated token.
# TYPE tensorfold:time_to_first_token_seconds histogram
tensorfold:time_to_first_token_seconds_bucket{le=\"0.5\"} 1
tensorfold:time_to_first_token_seconds_bucket{le=\"+Inf\"} 2
tensorfold:time_to_first_token_seconds_sum 3.0
tensorfold:time_to_first_token_seconds_count 2
# TYPE tensorfold:kv_cache_usage_ratio gauge
tensorfold:kv_cache_usage_ratio{pool=\"0\"} 0.5
tensorfold:kv_cache_usage_ratio{pool=\"1\"} 0.3
";
        let parsed = parse_prometheus_text(body).expect("parse");
        assert_eq!(parsed.gauge_sum("tensorfold_requests_running"), Some(2.0));
        assert_eq!(
            parsed.counters.get("tensorfold_prompt_tokens_total"),
            Some(&1_203_686.0)
        );
        assert_eq!(
            parsed
                .counters
                .get("tensorfold_time_to_first_token_seconds_sum"),
            Some(&3.0)
        );
        assert_eq!(
            parsed
                .counters
                .get("tensorfold_time_to_first_token_seconds_count"),
            Some(&2.0)
        );
        let buckets = parsed
            .histograms
            .get("tensorfold_time_to_first_token_seconds")
            .expect("histogram captured under its base name");
        assert_eq!(buckets.len(), 2);
        assert!(buckets[1].0.is_infinite());
        assert_eq!(
            parsed.gauge_mean("tensorfold_kv_cache_usage_ratio"),
            Some(0.4)
        );
        assert!(parsed
            .gauges
            .keys()
            .chain(parsed.counters.keys())
            .chain(parsed.histograms.keys())
            .all(|name| !name.contains(':')));
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

    /// A counter split across label series — vLLM's per-engine-core series
    /// under data parallelism, SGLang's `is_streaming` split — is the sum of
    /// its series, never whichever line came last.
    #[test]
    fn counters_split_across_label_series_are_summed() {
        let body = "\
# TYPE vllm:prompt_tokens counter
vllm:prompt_tokens_total{engine=\"0\",model_name=\"m\"} 100.0
vllm:prompt_tokens_total{engine=\"1\",model_name=\"m\"} 50.0
# TYPE vllm:time_to_first_token_seconds histogram
vllm:time_to_first_token_seconds_bucket{engine=\"0\",le=\"+Inf\"} 4
vllm:time_to_first_token_seconds_bucket{engine=\"1\",le=\"+Inf\"} 6
vllm:time_to_first_token_seconds_sum{engine=\"0\"} 1.5
vllm:time_to_first_token_seconds_sum{engine=\"1\"} 2.5
vllm:time_to_first_token_seconds_count{engine=\"0\"} 4
vllm:time_to_first_token_seconds_count{engine=\"1\"} 6
";
        let parsed = parse_prometheus_text(body).expect("parse");
        assert_eq!(
            parsed.counters.get("vllm_prompt_tokens_total"),
            Some(&150.0)
        );
        assert_eq!(
            parsed.counters.get("vllm_time_to_first_token_seconds_sum"),
            Some(&4.0)
        );
        assert_eq!(
            parsed
                .counters
                .get("vllm_time_to_first_token_seconds_count"),
            Some(&10.0)
        );
    }

    /// Histogram buckets of every label series merge per `le`, wherever the
    /// `le` label sits in the set — first, last, or between labels whose own
    /// names end in "le" — so percentiles interpolate over every observation.
    #[test]
    fn histogram_label_series_merge_per_le_wherever_le_sits() {
        let body = "\
# TYPE x histogram
x_bucket{le=\"0.5\",role=\"decode\"} 1
x_bucket{le=\"1\",role=\"decode\"} 3
x_bucket{le=\"+Inf\",role=\"decode\"} 4
x_bucket{role=\"prefill\",scale=\"wide\",le=\"0.5\"} 2
x_bucket{role=\"prefill\",scale=\"wide\",le=\"1\"} 2
x_bucket{role=\"prefill\",scale=\"wide\",le=\"+Inf\"} 6
x_sum{role=\"decode\"} 2.0
x_count{role=\"decode\"} 4
";
        let parsed = parse_prometheus_text(body).expect("parse");
        let buckets = parsed.histograms.get("x").expect("histogram");
        assert_eq!(buckets.len(), 3, "one bucket per le, not per label set");
        assert_eq!(buckets[0], (0.5, 3.0));
        assert_eq!(buckets[1], (1.0, 5.0));
        assert!(buckets[2].0.is_infinite());
        assert_eq!(buckets[2].1, 10.0);
    }

    /// Gauges keep their series, and the caller says how they combine: a
    /// count sums across data-parallel ranks, a ratio averages.
    #[test]
    fn gauges_keep_their_series_for_the_caller_to_combine() {
        let body = "\
# TYPE vllm:num_requests_running gauge
vllm:num_requests_running{engine=\"0\"} 8.0
vllm:num_requests_running{engine=\"1\"} 7.0
# TYPE vllm:kv_cache_usage_perc gauge
vllm:kv_cache_usage_perc{engine=\"0\"} 0.5
vllm:kv_cache_usage_perc{engine=\"1\"} 0.3
";
        let parsed = parse_prometheus_text(body).expect("parse");
        assert_eq!(parsed.gauges["vllm_num_requests_running"].len(), 2);
        assert_eq!(parsed.gauge_sum("vllm_num_requests_running"), Some(15.0));
        let kv = parsed.gauge_mean("vllm_kv_cache_usage_perc").expect("kv");
        assert!((kv - 0.4).abs() < 1e-12, "mean usage {kv}");
        assert_eq!(parsed.gauge_sum("vllm_absent"), None);
        assert_eq!(parsed.gauge_mean("vllm_absent"), None);
    }
}
