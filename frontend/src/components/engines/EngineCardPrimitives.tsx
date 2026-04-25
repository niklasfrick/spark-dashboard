/**
 * Shared primitives used by both EngineCard (per-engine view) and
 * GlobalEngineCard (aggregate view). Extracted so the two cards can share
 * one visual vocabulary without duplicating logic.
 */

import type { LatencyPercentiles } from '@/types/metrics'

export interface ChartDataPoint {
  timestamp: number
  value: number
}

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

export type Trend = 'up' | 'down' | 'stable'

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

interface TrendArrowProps {
  trend: Trend
  invertColor?: boolean
}

export function TrendArrow({ trend, invertColor }: TrendArrowProps) {
  if (trend === 'stable') {
    return <span className="text-zinc-600 text-[11px] ml-0.5">→</span>
  }
  const isUp = trend === 'up'
  const color = invertColor
    ? (isUp ? 'text-red-400' : 'text-[#76B900]')
    : (isUp ? 'text-[#76B900]' : 'text-red-400')
  return <span className={`${color} text-[11px] ml-0.5`}>{isUp ? '▲' : '▼'}</span>
}

interface MetricTileProps {
  label: string
  value: string
  unit?: string
  trend?: Trend
  invertTrend?: boolean
  warn?: boolean
  /** Optional small line under the value — used for latency percentiles. */
  subline?: string
}

/** Big metric tile with optional trend indicator. */
export function MetricTile({ label, value, unit, trend, invertTrend, warn, subline }: MetricTileProps) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className={`text-xs font-medium uppercase tracking-wider truncate ${warn ? 'text-red-400/70' : 'text-zinc-400'}`}>
        {label}
      </span>
      <div className="flex items-baseline">
        <span className={`text-2xl font-bold font-mono tabular-nums leading-none ${warn ? 'text-red-400' : 'text-zinc-100'}`}>
          {value}
        </span>
        {unit && <span className="text-xs text-zinc-500 ml-1">{unit}</span>}
        {trend && <TrendArrow trend={trend} invertColor={invertTrend} />}
      </div>
      {subline && (
        <span className="text-[10px] text-zinc-500 font-mono tabular-nums tracking-tight truncate">
          {subline}
        </span>
      )}
    </div>
  )
}

interface KvBarProps {
  percent: number
}

/** Mini KV cache utilization bar. Green <70, yellow 70–90, red >90. */
export function KvBar({ percent }: KvBarProps) {
  const color = percent > 90 ? 'bg-red-500' : percent > 70 ? 'bg-yellow-500' : 'bg-[#76B900]'
  return (
    <div className="flex h-1 rounded-full overflow-hidden bg-zinc-700/50 mt-1">
      <div className={`${color} transition-all duration-300`} style={{ width: `${percent}%` }} />
    </div>
  )
}

export function fmtVal(v: number | null, fmt: (n: number) => string): string {
  return v === null ? '--' : fmt(v)
}

export function fmtInt(v: number | null): string {
  return v === null ? '--' : String(Math.round(v))
}
