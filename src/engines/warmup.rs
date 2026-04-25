//! Warmup-aware baseline tracker for engine metrics.
//!
//! vLLM (and most Prometheus-style engines) exposes cumulative histograms and
//! counters. The first inference after a model start is typically much slower
//! than steady-state due to CUDA kernel JIT, KV cache allocation, and CUDA
//! graph capture. Because the histograms are cumulative, those outlier
//! observations pollute every percentile and average forever — until the
//! engine restarts. Subtracting a baseline snapshot of counters and bucket
//! counts from every subsequent poll removes the warmup observations from the
//! computed metrics, the same way Prometheus's `rate()` operates over a time
//! range.
//!
//! See `WarmupTracker` for the state machine and `observe()` contract.
use super::prometheus::ParsedMetrics;
use std::collections::HashMap;

/// Counter name used to gauge "how many requests has this engine handled" —
/// shared with `VllmAdapter::get_metrics`. Every vLLM request emits exactly one
/// observation into this histogram, so its `_count` doubles as a request
/// counter without needing a separate gauge.
const TRIGGER_COUNT_KEY: &str = "vllm_time_to_first_token_seconds_count";

/// Cumulative-metric snapshot taken at the moment warmup completes. All
/// subsequent polls compute `current - baseline` for every counter and
/// histogram bucket so the warmup observations stop polluting averages and
/// percentiles.
#[derive(Clone, Debug, Default)]
pub struct HistogramBaseline {
    pub counters: HashMap<String, f64>,
    pub histograms: HashMap<String, Vec<(f64, f64)>>,
}

/// Internal state of the warmup state machine. `Warming` until the engine has
/// served `skip_requests` requests since we started watching it; `Active`
/// thereafter, with a frozen baseline for delta computation.
#[derive(Clone, Debug)]
enum WarmupState {
    Warming { initial_total: Option<u64> },
    Active { baseline: HistogramBaseline },
}

/// Per-engine warmup tracker. One instance lives inside each engine adapter,
/// guarded by a `Mutex` for the async polling loop.
///
/// The tracker is engine-agnostic — it only depends on `ParsedMetrics` and a
/// well-known counter key (`vllm_time_to_first_token_seconds_count`). Future
/// adapters that emit a different trigger key can be supported by parameterizing
/// the constructor.
pub struct WarmupTracker {
    skip_requests: u64,
    state: WarmupState,
}

/// Result of a single `observe()` call. Callers should:
///   1. Use `adjusted` for all downstream metric extraction (gauges pass
///      through untouched; counters and histograms are baseline-subtracted).
///   2. If `just_transitioned` is true, clear any per-poll rate state (e.g.
///      previous-counter-reading caches and running-average accumulators) so
///      the first post-baseline rate is computed against a clean slate.
///   3. Surface `warming_up` to the UI so histogram-derived fields can be
///      blanked while the engine is still warming.
pub struct WarmupOutput {
    pub warming_up: bool,
    pub just_transitioned: bool,
    pub adjusted: ParsedMetrics,
}

impl WarmupTracker {
    /// Construct a tracker that excludes the first `skip_requests` requests
    /// the engine handles after we start watching it.
    ///
    /// **Already-running engines:** if the dashboard attaches to a vLLM that
    /// has already served thousands of requests, we cannot tell which of those
    /// were warmup. The tracker treats the first poll's `total_requests` as
    /// the initial cursor and only baselines after another `skip_requests`
    /// requests arrive. This excludes one extra request per attach, which is
    /// harmless and keeps the code path uniform.
    ///
    /// **`skip_requests = 0`:** baselines on the first poll. Useful as an
    /// override but does not skip any warmup observations — only filters out
    /// pre-attach cumulative pollution for already-running engines.
    pub fn new(skip_requests: u64) -> Self {
        Self {
            skip_requests,
            state: WarmupState::Warming {
                initial_total: None,
            },
        }
    }

    /// Process a single `/metrics` poll and return the metrics adjusted for
    /// warmup. Mutates internal state (initial cursor, baseline snapshot,
    /// regression resets).
    pub fn observe(&mut self, parsed: &ParsedMetrics) -> WarmupOutput {
        let current_total = parsed
            .counters
            .get(TRIGGER_COUNT_KEY)
            .map(|v| *v as u64)
            .unwrap_or(0);

        match &self.state {
            WarmupState::Warming { initial_total } => {
                // First poll captures the cursor; subsequent polls measure
                // progress against it. With `skip_requests = 0` the cursor is
                // captured and the threshold check below transitions the
                // tracker to Active in the same poll.
                let initial = match initial_total {
                    Some(i) => *i,
                    None => {
                        self.state = WarmupState::Warming {
                            initial_total: Some(current_total),
                        };
                        current_total
                    }
                };

                // Counter regression while still warming → engine restarted
                // before we finished warmup. Reset the cursor.
                if current_total < initial {
                    self.state = WarmupState::Warming {
                        initial_total: Some(current_total),
                    };
                    return WarmupOutput {
                        warming_up: true,
                        just_transitioned: false,
                        adjusted: clone_passthrough(parsed),
                    };
                }

                if current_total - initial >= self.skip_requests {
                    let baseline = HistogramBaseline {
                        counters: parsed.counters.clone(),
                        histograms: parsed.histograms.clone(),
                    };
                    let adjusted = subtract_baseline(parsed, &baseline);
                    self.state = WarmupState::Active { baseline };
                    return WarmupOutput {
                        warming_up: false,
                        just_transitioned: true,
                        adjusted,
                    };
                }

                WarmupOutput {
                    warming_up: true,
                    just_transitioned: false,
                    adjusted: clone_passthrough(parsed),
                }
            }
            WarmupState::Active { baseline } => {
                if counter_regression(parsed, baseline) {
                    // Engine restarted (counter dropped). Re-enter warming
                    // with a fresh cursor so the next `skip_requests` are
                    // treated as warmup.
                    self.state = WarmupState::Warming {
                        initial_total: Some(current_total),
                    };
                    return WarmupOutput {
                        warming_up: true,
                        just_transitioned: false,
                        adjusted: clone_passthrough(parsed),
                    };
                }

                let adjusted = subtract_baseline(parsed, baseline);
                WarmupOutput {
                    warming_up: false,
                    just_transitioned: false,
                    adjusted,
                }
            }
        }
    }
}

/// Clone `parsed` without baseline subtraction — used while warming, where the
/// caller treats histogram-derived fields as `None` regardless. We still hand
/// over the gauges and counters so pass-through fields (active/queued/kv_cache)
/// remain populated.
fn clone_passthrough(parsed: &ParsedMetrics) -> ParsedMetrics {
    ParsedMetrics {
        gauges: parsed.gauges.clone(),
        counters: parsed.counters.clone(),
        histograms: parsed.histograms.clone(),
    }
}

/// Returns true if any baselined counter has dropped below its baseline value
/// — the canonical "engine restarted" signal. We compare every baselined key,
/// not just the trigger, because a partial restart that resets only some
/// counters is still a restart and still warrants re-baselining.
fn counter_regression(parsed: &ParsedMetrics, baseline: &HistogramBaseline) -> bool {
    for (key, baseline_val) in &baseline.counters {
        if let Some(current) = parsed.counters.get(key) {
            if *current < *baseline_val {
                return true;
            }
        }
    }
    false
}

/// Compute `parsed - baseline` for every counter and histogram while leaving
/// gauges untouched. Histograms whose `le` schema no longer matches the
/// baseline (rare — vLLM config reload) are dropped from the result; the
/// existing `None`-fallbacks in the adapter handle absence cleanly and the
/// histogram will be re-baselined on the next tick (well, technically the
/// state machine waits until a true restart to re-baseline; in practice this
/// means a config-reload-with-bucket-change requires an engine restart to
/// fully recover, which is acceptable since it is exceedingly rare).
fn subtract_baseline(parsed: &ParsedMetrics, baseline: &HistogramBaseline) -> ParsedMetrics {
    let mut counters = HashMap::with_capacity(parsed.counters.len());
    for (key, current) in &parsed.counters {
        let delta = match baseline.counters.get(key) {
            Some(b) => (current - b).max(0.0),
            None => *current,
        };
        counters.insert(key.clone(), delta);
    }

    let mut histograms = HashMap::with_capacity(parsed.histograms.len());
    for (key, current_buckets) in &parsed.histograms {
        match baseline.histograms.get(key) {
            Some(baseline_buckets) if same_schema(current_buckets, baseline_buckets) => {
                let delta = current_buckets
                    .iter()
                    .zip(baseline_buckets.iter())
                    .map(|((le, c), (_, b))| (*le, (c - b).max(0.0)))
                    .collect::<Vec<_>>();
                histograms.insert(key.clone(), delta);
            }
            Some(_) => {
                // Schema drift — drop this histogram for the current poll.
            }
            None => {
                // Histogram appeared after the baseline snapshot. Pass through
                // as-is so a brand-new request type is not penalized; the next
                // restart will fold it into the baseline.
                histograms.insert(key.clone(), current_buckets.clone());
            }
        }
    }

    ParsedMetrics {
        gauges: parsed.gauges.clone(),
        counters,
        histograms,
    }
}

fn same_schema(a: &[(f64, f64)], b: &[(f64, f64)]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b.iter()).all(|((le_a, _), (le_b, _))| {
        // Treat +Inf as equal to +Inf; finite bounds compared bit-exact.
        if le_a.is_infinite() && le_b.is_infinite() {
            le_a.is_sign_positive() == le_b.is_sign_positive()
        } else {
            le_a == le_b
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metrics(
        counters: &[(&str, f64)],
        histograms: &[(&str, &[(f64, f64)])],
        gauges: &[(&str, f64)],
    ) -> ParsedMetrics {
        ParsedMetrics {
            counters: counters
                .iter()
                .map(|(k, v)| ((*k).to_string(), *v))
                .collect(),
            histograms: histograms
                .iter()
                .map(|(k, v)| ((*k).to_string(), v.to_vec()))
                .collect(),
            gauges: gauges.iter().map(|(k, v)| ((*k).to_string(), *v)).collect(),
        }
    }

    #[test]
    fn first_poll_captures_initial_total_and_warms_up() {
        let mut t = WarmupTracker::new(1);
        let m = metrics(&[(TRIGGER_COUNT_KEY, 0.0)], &[], &[]);
        let out = t.observe(&m);
        assert!(out.warming_up);
        assert!(!out.just_transitioned);
        assert!(matches!(
            t.state,
            WarmupState::Warming {
                initial_total: Some(0)
            }
        ));
    }

    #[test]
    fn transitions_to_active_when_skip_threshold_reached() {
        let mut t = WarmupTracker::new(1);
        // First poll: cursor at 0, still warming.
        let _ = t.observe(&metrics(&[(TRIGGER_COUNT_KEY, 0.0)], &[], &[]));
        // Second poll: 1 request arrived → transition.
        let m2 = metrics(
            &[
                (TRIGGER_COUNT_KEY, 1.0),
                ("vllm_time_to_first_token_seconds_sum", 2.5),
                ("vllm_generation_tokens_total", 100.0),
            ],
            &[(
                "vllm_time_to_first_token_seconds",
                &[(0.5, 0.0), (1.0, 0.0), (5.0, 1.0), (f64::INFINITY, 1.0)],
            )],
            &[],
        );
        let out = t.observe(&m2);
        assert!(!out.warming_up);
        assert!(out.just_transitioned);
        // First adjusted poll uses (current - baseline) where baseline ==
        // current, so all delta values are zero. That's correct: the warmup
        // observation is now wholly inside the baseline.
        let buckets = out
            .adjusted
            .histograms
            .get("vllm_time_to_first_token_seconds")
            .expect("histogram present");
        assert!(buckets.iter().all(|(_, c)| *c == 0.0));
        assert_eq!(
            out.adjusted
                .counters
                .get("vllm_time_to_first_token_seconds_sum"),
            Some(&0.0)
        );
    }

    #[test]
    fn post_baseline_yields_correct_deltas() {
        let mut t = WarmupTracker::new(1);
        // Warmup
        let _ = t.observe(&metrics(&[(TRIGGER_COUNT_KEY, 0.0)], &[], &[]));
        // Baseline at count=1, slow observation in tail
        let _ = t.observe(&metrics(
            &[
                (TRIGGER_COUNT_KEY, 1.0),
                ("vllm_time_to_first_token_seconds_sum", 4.0),
                ("vllm_generation_tokens_total", 50.0),
            ],
            &[(
                "vllm_time_to_first_token_seconds",
                &[(0.05, 0.0), (1.0, 0.0), (5.0, 1.0), (f64::INFINITY, 1.0)],
            )],
            &[("vllm_num_requests_running", 1.0)],
        ));
        // Steady state: 100 fast observations land in the [0, 0.05] bucket.
        let m = metrics(
            &[
                (TRIGGER_COUNT_KEY, 101.0),
                ("vllm_time_to_first_token_seconds_sum", 5.0), // +1.0 across 100 obs
                ("vllm_generation_tokens_total", 10050.0),
            ],
            &[(
                "vllm_time_to_first_token_seconds",
                &[
                    (0.05, 100.0),
                    (1.0, 100.0),
                    (5.0, 101.0),
                    (f64::INFINITY, 101.0),
                ],
            )],
            &[("vllm_num_requests_running", 2.0)],
        );
        let out = t.observe(&m);
        assert!(!out.warming_up);
        assert!(!out.just_transitioned);
        let buckets = out
            .adjusted
            .histograms
            .get("vllm_time_to_first_token_seconds")
            .expect("histogram present");
        // Expect 100 observations in [0, 0.05], 0 elsewhere — baseline removed
        // the slow warmup observation entirely.
        assert_eq!(buckets[0], (0.05, 100.0));
        assert_eq!(buckets[1], (1.0, 100.0));
        assert_eq!(buckets[2], (5.0, 100.0));
        assert!(buckets[3].0.is_infinite());
        assert_eq!(buckets[3].1, 100.0);
        // Counter delta: total tokens since baseline.
        assert_eq!(
            out.adjusted.counters.get("vllm_generation_tokens_total"),
            Some(&10000.0)
        );
        // Sum delta: 1.0 across 100 fast observations.
        let sum = out
            .adjusted
            .counters
            .get("vllm_time_to_first_token_seconds_sum")
            .copied()
            .expect("sum");
        assert!((sum - 1.0).abs() < 1e-9, "sum delta {sum}");
        // Gauges pass through untouched.
        assert_eq!(
            out.adjusted.gauges.get("vllm_num_requests_running"),
            Some(&2.0)
        );
    }

    #[test]
    fn warming_regression_resets_initial_cursor() {
        let mut t = WarmupTracker::new(3);
        let _ = t.observe(&metrics(&[(TRIGGER_COUNT_KEY, 10.0)], &[], &[]));
        // Restart while still warming: count drops below initial.
        let _ = t.observe(&metrics(&[(TRIGGER_COUNT_KEY, 0.0)], &[], &[]));
        match &t.state {
            WarmupState::Warming { initial_total } => assert_eq!(*initial_total, Some(0)),
            _ => panic!("should still be warming after regression"),
        }
    }

    #[test]
    fn active_regression_resets_to_warming() {
        let mut t = WarmupTracker::new(0);
        // Skip=0 → first poll baselines immediately.
        let _ = t.observe(&metrics(
            &[
                (TRIGGER_COUNT_KEY, 5.0),
                ("vllm_generation_tokens_total", 500.0),
            ],
            &[],
            &[],
        ));
        assert!(matches!(t.state, WarmupState::Active { .. }));
        // Restart: counters drop.
        let out = t.observe(&metrics(
            &[
                (TRIGGER_COUNT_KEY, 1.0),
                ("vllm_generation_tokens_total", 10.0),
            ],
            &[],
            &[],
        ));
        assert!(out.warming_up);
        match &t.state {
            WarmupState::Warming { initial_total } => assert_eq!(*initial_total, Some(1)),
            _ => panic!("should be warming again"),
        }
    }

    #[test]
    fn schema_drift_drops_only_affected_histogram() {
        let mut t = WarmupTracker::new(1);
        let _ = t.observe(&metrics(&[(TRIGGER_COUNT_KEY, 0.0)], &[], &[]));
        let _ = t.observe(&metrics(
            &[(TRIGGER_COUNT_KEY, 1.0)],
            &[
                ("histA", &[(0.1, 0.0), (1.0, 1.0), (f64::INFINITY, 1.0)]),
                ("histB", &[(0.5, 1.0), (f64::INFINITY, 1.0)]),
            ],
            &[],
        ));
        // Now histA gets a new bucket — schema drift.
        let out = t.observe(&metrics(
            &[(TRIGGER_COUNT_KEY, 2.0)],
            &[
                (
                    "histA",
                    &[(0.1, 0.0), (0.5, 1.0), (1.0, 2.0), (f64::INFINITY, 2.0)],
                ),
                ("histB", &[(0.5, 2.0), (f64::INFINITY, 2.0)]),
            ],
            &[],
        ));
        assert!(!out.adjusted.histograms.contains_key("histA"));
        let b = out.adjusted.histograms.get("histB").expect("histB kept");
        assert_eq!(b[0], (0.5, 1.0));
    }

    #[test]
    fn skip_zero_baselines_on_first_poll() {
        let mut t = WarmupTracker::new(0);
        let m = metrics(
            &[
                (TRIGGER_COUNT_KEY, 5.0),
                ("vllm_generation_tokens_total", 500.0),
            ],
            &[],
            &[],
        );
        let out = t.observe(&m);
        assert!(!out.warming_up);
        assert!(out.just_transitioned);
        assert!(matches!(t.state, WarmupState::Active { .. }));
    }
}
