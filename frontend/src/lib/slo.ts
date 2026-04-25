/**
 * Service Level Objective thresholds, mirrored from the Rust backend
 * (`src/engines/mod.rs`). Keep these values in sync with the backend
 * constants — the `*_goodput_pct` fields on `EngineMetrics` are computed
 * server-side using these thresholds.
 */
export const SLO = {
  /** TTFT must be at most this many milliseconds to count as on-SLO. */
  ttftMs: 500,
  /** ITL must be at most this many milliseconds to count as on-SLO. */
  itlMs: 50,
  /** E2E latency must be at most this many milliseconds to count as on-SLO. */
  e2eMs: 5000,
} as const

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
