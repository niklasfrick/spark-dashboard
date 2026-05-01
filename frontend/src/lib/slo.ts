import type { HistogramBucket } from '@/types/metrics'

/**
 * Default Service Level Objective thresholds, mirrored from the Rust backend
 * (`src/engines/mod.rs`). The backend uses these constants to compute the
 * `*_goodput_pct` fields it ships in `EngineMetrics`. The frontend reuses
 * them as the seed for per-model customization (see `useSloSettings`).
 */
export const DEFAULT_SLO: SloThresholds = {
  ttftMs: 500,
  itlMs: 50,
  e2eMs: 5000,
} as const

/** Backwards-compatible alias for the default SLO seed. */
export const SLO = DEFAULT_SLO

/** Per-model SLO threshold configuration in milliseconds. */
export interface SloThresholds {
  ttftMs: number
  itlMs: number
  e2eMs: number
}

/**
 * Conservative combined goodput approximation: the worst-performing of the
 * three independently-measured goodput fractions. The true joint
 * "all-three-met" rate would require correlated per-request data, which
 * Prometheus histograms don't expose. Using min keeps the headline number
 * honest — we never claim better goodput than the slowest dimension.
 */
export function combinedGoodput(
  ttftPct: number | null,
  itlPct: number | null,
  e2ePct: number | null,
): number | null {
  const present = [ttftPct, itlPct, e2ePct].filter(
    (v): v is number => v !== null && Number.isFinite(v),
  )
  if (present.length === 0) return null
  return Math.min(...present)
}

/**
 * Sentinel the backend uses to encode `+Inf` in histogram buckets, since
 * `serde_json` cannot serialize non-finite floats. Anything at or above
 * this value is treated as the overflow bucket — observations beyond it
 * are not credited toward the SLO. Matches Rust `fraction_le` semantics
 * where `+Inf` caps at the previous finite cumulative count.
 */
const OVERFLOW_LE_SENTINEL = Number.MAX_VALUE

/**
 * Port of Rust `fraction_le` from `src/engines/histogram.rs`. Estimates
 * the fraction of observations whose value is `<= threshold` from
 * cumulative Prometheus histogram buckets. Linearly interpolates inside
 * the bucket that straddles the threshold.
 *
 * Returns a value in `[0, 1]`, or `null` when the histogram is empty or
 * the total observation count is zero. A threshold beyond the largest
 * finite `le` is capped at the cumulative count at that finite boundary
 * — anything in the overflow bucket is *not* counted as meeting the SLO.
 */
export function fractionLe(
  buckets: readonly HistogramBucket[] | null | undefined,
  thresholdSeconds: number,
): number | null {
  if (!buckets || buckets.length === 0 || Number.isNaN(thresholdSeconds)) {
    return null
  }
  const total = buckets[buckets.length - 1]?.cumulative_count
  if (total === undefined || total <= 0) {
    return null
  }

  // Threshold below the smallest bucket: linearly interpolate from 0.
  const first = buckets[0]
  if (
    thresholdSeconds <= first.le_seconds &&
    first.le_seconds < OVERFLOW_LE_SENTINEL
  ) {
    if (first.le_seconds <= 0) return 0
    const frac = clamp(thresholdSeconds / first.le_seconds, 0, 1)
    return clamp((first.cumulative_count * frac) / total, 0, 1)
  }

  // Walk buckets to find the first finite bucket whose `le` >= threshold.
  let prevLe = 0
  let prevCum = 0
  for (const { le_seconds: le, cumulative_count: cum } of buckets) {
    if (le >= OVERFLOW_LE_SENTINEL) {
      // Threshold exceeds all finite bounds → cap at last finite cum.
      return clamp(prevCum / total, 0, 1)
    }
    if (le >= thresholdSeconds) {
      const bucketWidth = le - prevLe
      const bucketCount = cum - prevCum
      if (bucketWidth <= 0 || bucketCount <= 0) {
        return clamp(prevCum / total, 0, 1)
      }
      const frac = (thresholdSeconds - prevLe) / bucketWidth
      const interp = prevCum + frac * bucketCount
      return clamp(interp / total, 0, 1)
    }
    prevLe = le
    prevCum = cum
  }

  // Threshold beyond all buckets and no overflow sentinel — saturate.
  return 1
}

/**
 * Recompute goodput percentage (0–100) from histogram buckets at a custom
 * threshold in milliseconds. Returns `null` when buckets are unavailable
 * (warmup, no traffic) — the caller should fall back to the backend
 * `*_goodput_pct` field in that case.
 */
export function recomputeGoodputPct(
  buckets: HistogramBucket[] | null | undefined,
  thresholdMs: number,
): number | null {
  const f = fractionLe(buckets, thresholdMs / 1000)
  return f === null ? null : f * 100
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi)
}
