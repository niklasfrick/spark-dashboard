//! Helpers for working with Prometheus-style histogram buckets.
//!
//! vLLM (and most other engines that expose Prometheus metrics) emits latency
//! histograms with cumulative bucket counts and `le` upper bounds. To surface
//! tail latency in the dashboard we need percentiles, which the engine itself
//! does not pre-compute.

/// Linear-interpolate a percentile from cumulative Prometheus histogram buckets.
///
/// `buckets` must be sorted ascending by `le` and contain cumulative counts
/// (Prometheus convention). The final bucket is typically `+Inf`. Returns
/// `None` when the histogram is empty, when the total observation count is
/// zero, or when `q` is outside `[0.0, 1.0]`.
///
/// The interpolation linearly distributes observations between the previous
/// finite bucket boundary (or `0.0`) and the selected bucket's `le`. If the
/// chosen bucket is `+Inf`, the previous finite `le` is returned (Prometheus
/// `histogram_quantile` convention) since the actual upper bound is unknown.
pub fn percentile(buckets: &[(f64, f64)], q: f64) -> Option<f64> {
    if buckets.is_empty() || !(0.0..=1.0).contains(&q) {
        return None;
    }

    let total = buckets.last().map(|(_, c)| *c)?;
    if total <= 0.0 {
        return None;
    }

    let target = total * q;

    // Find the first bucket whose cumulative count is >= target.
    let idx = buckets.iter().position(|&(_, c)| c >= target)?;
    let (le, cum) = buckets[idx];

    // If the chosen bucket is +Inf we cannot interpolate — fall back to the
    // previous finite le (or None if every bucket is +Inf).
    if le.is_infinite() {
        return buckets[..idx]
            .iter()
            .rev()
            .find(|(b_le, _)| !b_le.is_infinite())
            .map(|&(b_le, _)| b_le);
    }

    let (lower_le, lower_cum) = if idx == 0 {
        (0.0_f64, 0.0_f64)
    } else {
        buckets[idx - 1]
    };

    let bucket_width = le - lower_le;
    let bucket_count = cum - lower_cum;
    if bucket_count <= 0.0 || bucket_width <= 0.0 {
        return Some(le);
    }

    let frac = (target - lower_cum) / bucket_count;
    Some(lower_le + frac * bucket_width)
}

/// Estimate the fraction of observations whose value is `<= threshold` from
/// cumulative Prometheus histogram buckets. Linearly interpolates inside the
/// bucket that straddles the threshold.
///
/// Returns a value in `[0.0, 1.0]`, or `None` when the histogram is empty or
/// the total observation count is zero. A threshold beyond the largest finite
/// `le` is treated as the cumulative count at that finite boundary divided by
/// the total — anything in the `+Inf` overflow bucket is *not* counted as
/// meeting the SLO. This is the standard "goodput" interpretation: requests
/// past the largest known bound are assumed to have missed.
pub fn fraction_le(buckets: &[(f64, f64)], threshold: f64) -> Option<f64> {
    if buckets.is_empty() || threshold.is_nan() {
        return None;
    }
    let total = buckets.last().map(|(_, c)| *c)?;
    if total <= 0.0 {
        return None;
    }

    // Threshold below the smallest bucket: linearly interpolate from 0.
    let first = buckets[0];
    if threshold <= first.0 && !first.0.is_infinite() {
        if first.0 <= 0.0 {
            return Some(0.0);
        }
        let frac = (threshold / first.0).clamp(0.0, 1.0);
        return Some((first.1 * frac / total).clamp(0.0, 1.0));
    }

    // Walk buckets to find the first finite bucket whose `le` >= threshold.
    let mut prev_le = 0.0_f64;
    let mut prev_cum = 0.0_f64;
    for &(le, cum) in buckets {
        if le.is_infinite() {
            // Threshold exceeds all finite bounds → cap at the last finite cum.
            return Some((prev_cum / total).clamp(0.0, 1.0));
        }
        if le >= threshold {
            let bucket_width = le - prev_le;
            let bucket_count = cum - prev_cum;
            if bucket_width <= 0.0 || bucket_count <= 0.0 {
                return Some((prev_cum / total).clamp(0.0, 1.0));
            }
            let frac = (threshold - prev_le) / bucket_width;
            let interp = prev_cum + frac * bucket_count;
            return Some((interp / total).clamp(0.0, 1.0));
        }
        prev_le = le;
        prev_cum = cum;
    }

    // Threshold beyond all buckets and no +Inf — saturate at total.
    Some(1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn returns_none_for_empty_buckets() {
        assert_eq!(percentile(&[], 0.5), None);
    }

    #[test]
    fn returns_none_when_total_count_is_zero() {
        let buckets = vec![(0.1, 0.0), (0.5, 0.0), (f64::INFINITY, 0.0)];
        assert_eq!(percentile(&buckets, 0.5), None);
    }

    #[test]
    fn returns_none_for_invalid_quantile() {
        let buckets = vec![(0.1, 50.0), (1.0, 100.0)];
        assert_eq!(percentile(&buckets, -0.1), None);
        assert_eq!(percentile(&buckets, 1.1), None);
    }

    #[test]
    fn p50_interpolates_in_first_bucket() {
        // 50 observations in [0, 0.1], 50 more up to 1.0. p50 target = 50.
        // Sits exactly at the boundary of bucket 0, returns its le.
        let buckets = vec![(0.1, 50.0), (1.0, 100.0)];
        let p50 = percentile(&buckets, 0.5).expect("some");
        assert!(approx(p50, 0.1), "expected 0.1, got {p50}");
    }

    #[test]
    fn p50_interpolates_within_bucket() {
        // total=100, target=50. Bucket 0 has 0..0.1 with count 25,
        // bucket 1 has 0.1..1.0 with count 75 (cumulative 100).
        // 50 - 25 = 25 of 75 in bucket 1 → 0.1 + (25/75)*0.9 = 0.4
        let buckets = vec![(0.1, 25.0), (1.0, 100.0)];
        let p50 = percentile(&buckets, 0.5).expect("some");
        assert!(approx(p50, 0.4), "expected 0.4, got {p50}");
    }

    #[test]
    fn p99_falls_back_to_finite_le_when_inf_selected() {
        // 99 obs in [0, 1.0], 1 more in (1.0, +Inf]. p99 target = 99.
        // Bucket 0 is exactly at 99 cumulative — that's where we land,
        // returns 1.0 (finite le). Push p99.5 to force +Inf bucket.
        let buckets = vec![(1.0, 99.0), (f64::INFINITY, 100.0)];
        let p995 = percentile(&buckets, 0.995).expect("some");
        assert!(approx(p995, 1.0), "expected fallback to 1.0, got {p995}");
    }

    #[test]
    fn returns_none_when_only_inf_bucket() {
        let buckets = vec![(f64::INFINITY, 10.0)];
        assert_eq!(percentile(&buckets, 0.5), None);
    }

    #[test]
    fn handles_single_finite_bucket() {
        // total=100, all in [0, 0.5]. p50 target = 50.
        // 50 of 100 in bucket → 0.0 + (50/100)*0.5 = 0.25
        let buckets = vec![(0.5, 100.0)];
        let p50 = percentile(&buckets, 0.5).expect("some");
        assert!(approx(p50, 0.25), "expected 0.25, got {p50}");
    }

    #[test]
    fn p95_lands_in_tail_bucket() {
        // total=1000. 900 by 0.5s, 990 by 1.0s, 1000 by +Inf.
        // p95 target = 950. In bucket 1.0: 950 - 900 = 50 of 90 →
        // 0.5 + (50/90) * 0.5 = 0.5 + 0.27777... = 0.77777...
        let buckets = vec![(0.5, 900.0), (1.0, 990.0), (f64::INFINITY, 1000.0)];
        let p95 = percentile(&buckets, 0.95).expect("some");
        assert!(approx(p95, 0.5 + (50.0 / 90.0) * 0.5));
    }

    // ---------- fraction_le tests ----------

    #[test]
    fn fraction_le_returns_none_for_empty() {
        assert_eq!(fraction_le(&[], 0.5), None);
    }

    #[test]
    fn fraction_le_returns_none_when_total_zero() {
        let buckets = vec![(0.1, 0.0), (1.0, 0.0), (f64::INFINITY, 0.0)];
        assert_eq!(fraction_le(&buckets, 0.5), None);
    }

    #[test]
    fn fraction_le_at_bucket_boundary() {
        // 50 obs at <= 0.1, 100 total. Threshold == 0.1 → 50/100 = 0.5.
        let buckets = vec![(0.1, 50.0), (1.0, 100.0)];
        let f = fraction_le(&buckets, 0.1).expect("some");
        assert!(approx(f, 0.5), "expected 0.5, got {f}");
    }

    #[test]
    fn fraction_le_interpolates_within_bucket() {
        // 25 by 0.1s, 100 by 1.0s. Threshold 0.4 sits inside bucket 1.
        // bucket has 75 obs over (0.1, 1.0]; (0.4 - 0.1) / 0.9 = 1/3
        // → cum = 25 + (1/3)*75 = 50 → 50/100 = 0.5.
        let buckets = vec![(0.1, 25.0), (1.0, 100.0)];
        let f = fraction_le(&buckets, 0.4).expect("some");
        assert!(approx(f, 0.5), "expected 0.5, got {f}");
    }

    #[test]
    fn fraction_le_below_first_bucket_is_linear_from_zero() {
        // 100 obs in [0, 0.1]. Threshold 0.05 → assume uniform within bucket
        // → 50/100 = 0.5.
        let buckets = vec![(0.1, 100.0), (1.0, 100.0)];
        let f = fraction_le(&buckets, 0.05).expect("some");
        assert!(approx(f, 0.5), "expected 0.5, got {f}");
    }

    #[test]
    fn fraction_le_above_finite_bounds_caps_at_finite_cum() {
        // 99 in (0, 1.0], 1 in (1.0, +Inf]. Threshold 5.0 → can only count
        // observations <= last finite le → 99/100 = 0.99 (overflow misses).
        let buckets = vec![(1.0, 99.0), (f64::INFINITY, 100.0)];
        let f = fraction_le(&buckets, 5.0).expect("some");
        assert!(approx(f, 0.99), "expected 0.99, got {f}");
    }

    #[test]
    fn fraction_le_threshold_well_above_finite_no_inf_saturates() {
        let buckets = vec![(0.1, 10.0), (1.0, 100.0)];
        let f = fraction_le(&buckets, 5.0).expect("some");
        assert!(approx(f, 1.0), "expected 1.0, got {f}");
    }

    #[test]
    fn fraction_le_threshold_below_first_le_with_zero_or_negative_le() {
        // Pathological: first le == 0 means we cannot interpolate below it.
        let buckets = vec![(0.0, 0.0), (1.0, 100.0)];
        let f = fraction_le(&buckets, -1.0).expect("some");
        assert!(approx(f, 0.0), "expected 0.0, got {f}");
    }
}
