/**
 * GPU power gauge scaling.
 *
 * The gauge fill is a 0–100 percentage of power draw against a denominator.
 * Ideally that denominator is the hardware power limit, but unified-memory SoCs
 * like the DGX Spark GB10 report no power cap via NVML (`power_limit_watts` is
 * null). In that case we fall back to an adaptive max derived from the observed
 * peak draw, rounded up to a human-readable step so the gauge moves and only
 * rescales in discrete jumps instead of pegging at full whenever the current
 * reading is itself the peak.
 */

export interface PowerScale {
  /** 0–100 for the gauge arc / horizontal bar. */
  percent: number
  /** Denominator actually used, in watts. Null when nothing usable is known. */
  effectiveMax: number | null
  /** Where `effectiveMax` came from. */
  source: 'limit' | 'peak' | null
}

/**
 * Round a value up to a "nice" 1–2–5×10ⁿ grid so an adaptive gauge max stays
 * human-readable and only steps between recognizable bands
 * (4→5, 5→5, 5.1→10, 130→200). Returns null for non-positive / non-finite input.
 */
export function niceCeiling(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null

  const magnitude = Math.pow(10, Math.floor(Math.log10(value)))
  const fraction = value / magnitude // in [1, 10)

  let niceFraction: number
  if (fraction <= 1) niceFraction = 1
  else if (fraction <= 2) niceFraction = 2
  else if (fraction <= 5) niceFraction = 5
  else niceFraction = 10

  return niceFraction * magnitude
}

/**
 * Highest power reading across the history window and the current sample.
 * Returns null when there is nothing usable (empty history and null current).
 */
export function powerPeak(
  history: ReadonlyArray<{ value: number }>,
  current: number | null,
): number | null {
  let peak = -Infinity
  if (current !== null && Number.isFinite(current)) peak = current
  for (const point of history) {
    if (Number.isFinite(point.value) && point.value > peak) peak = point.value
  }
  return peak > -Infinity ? peak : null
}

/**
 * Compute the gauge scale: prefer the real hardware limit when present,
 * otherwise fall back to a nice-rounded observed peak.
 */
export function computePowerScale(
  current: number | null,
  limit: number | null,
  peak: number | null,
): PowerScale {
  let effectiveMax: number | null = null
  let source: PowerScale['source'] = null

  if (limit !== null && limit > 0) {
    effectiveMax = limit
    source = 'limit'
  } else {
    const ceiling = peak !== null ? niceCeiling(peak) : null
    if (ceiling !== null && ceiling > 0) {
      effectiveMax = ceiling
      source = 'peak'
    }
  }

  const percent =
    current !== null && Number.isFinite(current) && effectiveMax !== null && effectiveMax > 0
      ? Math.min(Math.max((current / effectiveMax) * 100, 0), 100)
      : 0

  return { percent, effectiveMax, source }
}
