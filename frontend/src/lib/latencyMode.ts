/**
 * Global selector for which latency value the dashboard surfaces in TTFT,
 * E2E, and ITL tiles. "avg" matches the historical default; p50/p95/p99
 * pull from the histogram-derived percentiles exposed by the backend.
 *
 * Lives here rather than beside `LatencyModeControl` so the control file
 * exports only its component — a file mixing component and non-component
 * exports breaks Vite fast refresh (`react-refresh/only-export-components`).
 */

import type { LatencyPercentiles } from '@/types/metrics'

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

/** Title-friendly label for the active mode. */
export function latencyModeLabel(mode: LatencyMode): string {
  if (mode === 'avg') return 'avg'
  return mode
}
