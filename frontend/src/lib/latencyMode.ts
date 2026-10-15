/**
 * Global selector for which latency value the dashboard surfaces in TTFT,
 * E2E, and ITL tiles. "avg" matches the historical default; p50/p95/p99
 * pull from the histogram-derived percentiles exposed by the backend.
 *
 * Lives here rather than beside `LatencyModeControl` so the control file
 * exports only its component — a file mixing component and non-component
 * exports breaks Vite fast refresh (`react-refresh/only-export-components`).
 */

import type { LatencyPercentiles, MetricGroup } from '@/types/metrics'

export type LatencyMode = 'avg' | 'p50' | 'p95' | 'p99'

export const DEFAULT_LATENCY_MODE: LatencyMode = 'avg'

export function isLatencyMode(v: string): v is LatencyMode {
  return v === 'avg' || v === 'p50' || v === 'p95' || v === 'p99'
}

export function parseLatencyMode(raw: string | null | undefined): LatencyMode {
  if (raw && isLatencyMode(raw)) return raw
  return DEFAULT_LATENCY_MODE
}

export function serializeLatencyMode(mode: LatencyMode): string {
  return mode
}

/**
 * Resolve the millisecond value to display for a given latency dimension.
 * Returns null when the requested mode has no data (e.g. percentiles not
 * yet observed) so consumers render a dash.
 */
export function pickLatencyValue(
  mode: LatencyMode,
  avgMs: number | null,
  percentiles: LatencyPercentiles | null,
): number | null {
  if (mode === 'avg') return avgMs
  if (!percentiles) return null
  if (mode === 'p50') return percentiles.p50_ms
  if (mode === 'p95') return percentiles.p95_ms
  return percentiles.p99_ms
}

/** Which of the latency statistics an engine reports (ADR-0004). */
export interface ReportedLatencyStatistics {
  /** The latency means group. */
  means: boolean
  /** The latency percentiles group. */
  percentiles: boolean
}

/**
 * The two metric groups each latency dimension is reported in (ADR-0004): its
 * mean, and its percentiles with the goodput and buckets derived from the same
 * histogram.
 */
export const LATENCY_GROUPS = {
  ttft: { mean: 'TtftMean', percentiles: 'TtftPercentiles' },
  e2e: { mean: 'E2eMean', percentiles: 'E2ePercentiles' },
  itl: { mean: 'ItlMean', percentiles: 'ItlPercentiles' },
  tpot: { mean: 'TpotMean', percentiles: 'TpotPercentiles' },
} as const satisfies Record<string, { mean: MetricGroup; percentiles: MetricGroup }>

/** A latency dimension: time to first token, end to end, inter-token, per output token. */
export type LatencyDimension = keyof typeof LATENCY_GROUPS

/** Which statistics of one latency dimension an engine reports, given the
 *  panel's `reports` predicate. */
export function reportedLatencyStatistics(
  dimension: LatencyDimension,
  reports: (group: MetricGroup) => boolean,
): ReportedLatencyStatistics {
  const { mean, percentiles } = LATENCY_GROUPS[dimension]
  return { means: reports(mean), percentiles: reports(percentiles) }
}

/**
 * The statistic a latency panel can actually show in the chosen mode, given
 * what its engine reports — null when it reports none it could.
 *
 * A percentile mode on an engine that reports means but no percentiles falls
 * back to the mean, and the caller **labels it as the mean**: a mean under a
 * percentile heading is exactly how a tail-latency problem gets read as a
 * healthy average. The reverse never happens — the average mode does not borrow
 * a percentile, because a p50 under "avg" would be the same misreading turned
 * around.
 */
export function shownLatencyStatistic(
  mode: LatencyMode,
  reported: ReportedLatencyStatistics,
): LatencyMode | null {
  if (mode !== 'avg' && reported.percentiles) return mode
  return reported.means ? 'avg' : null
}

/** Title-friendly label for the active mode. */
export function latencyModeLabel(mode: LatencyMode): string {
  if (mode === 'avg') return 'avg'
  return mode
}
