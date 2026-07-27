/**
 * Pure derivations over engine chart data and histogram percentiles.
 *
 * Lives here rather than beside `EngineCardPrimitives` so that file exports
 * only components — a file mixing component and non-component exports breaks
 * Vite fast refresh (`react-refresh/only-export-components`).
 */

import type { LatencyPercentiles } from '@/types/metrics'

export interface ChartDataPoint {
  timestamp: number
  value: number
}

export type Trend = 'up' | 'down' | 'stable'

/**
 * Compact one-line "p50 X · p95 Y · p99 Z" rendering of histogram-derived
 * percentiles in milliseconds. Returns undefined when every quantile is
 * missing so the tile renders without a trailing line.
 */
export function percentileSubline(p: LatencyPercentiles | null | undefined): string | undefined {
  if (!p) return undefined
  const fmt = (v: number | null) => (v === null ? null : Math.round(v).toString())
  const p50 = fmt(p.p50_ms)
  const p95 = fmt(p.p95_ms)
  const p99 = fmt(p.p99_ms)
  if (p50 === null && p95 === null && p99 === null) return undefined
  return `p50 ${p50 ?? '—'} · p95 ${p95 ?? '—'} · p99 ${p99 ?? '—'}`
}

export function computeTrend(data: ChartDataPoint[], threshold = 0.05): Trend {
  if (data.length < 6) return 'stable'
  const recent = data.slice(-3)
  const older = data.slice(Math.max(0, data.length - 15), data.length - 3)
  if (older.length < 3) return 'stable'
  const recentAvg = recent.reduce((s, p) => s + p.value, 0) / recent.length
  const olderAvg = older.reduce((s, p) => s + p.value, 0) / older.length
  if (olderAvg === 0) return recentAvg > 0 ? 'up' : 'stable'
  const change = (recentAvg - olderAvg) / Math.abs(olderAvg)
  if (change > threshold) return 'up'
  if (change < -threshold) return 'down'
  return 'stable'
}
