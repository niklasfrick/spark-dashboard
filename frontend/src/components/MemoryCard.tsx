import { MetricCard } from './MetricCard'
import { StackedBar } from './StackedBar'
import { ArcGauge } from './gauges/ArcGauge'
import { TimeSeriesChart } from './charts/TimeSeriesChart'
import { formatBytes } from '../lib/format'
import { THRESHOLDS } from '../lib/theme'
import type { MemoryMetrics } from '../types/metrics'

interface ChartDataPoint {
  timestamp: number
  value: number
}

interface MemoryCardProps {
  metrics: MemoryMetrics | null
  chartData?: ChartDataPoint[]
  showCharts?: boolean
  gaugeSize?: number
}

export function MemoryCard({ metrics, chartData, showCharts = false, gaugeSize }: MemoryCardProps) {
  if (!metrics) return <MetricCard title="Unified Memory"><p className="text-zinc-500">Waiting for data...</p></MetricCard>

  const totalGB = (metrics.total_bytes / 1_000_000_000).toFixed(0)
  const usedPercent = metrics.total_bytes > 0
    ? (metrics.used_bytes / metrics.total_bytes) * 100
    : 0

  // Memory segments: GPU estimated, CPU (used minus GPU), Cached (reclaimable), Free
  // Note: used_bytes = total - available (already excludes reclaimable cache on Linux),
  // so cached must be shown as a sub-segment of available, not subtracted from used.
  const gpuUsed = metrics.gpu_estimated_bytes ?? 0
  const cpuUsed = Math.max(0, metrics.used_bytes - gpuUsed)
  const cached = Math.min(metrics.cached_bytes, metrics.available_bytes)
  const free = Math.max(0, metrics.available_bytes - cached)

  const segments = [
    { value: gpuUsed, total: metrics.total_bytes, color: 'bg-[#76B900]', label: `GPU (est.): ${formatBytes(gpuUsed)}` },
    { value: cpuUsed, total: metrics.total_bytes, color: 'bg-blue-500', label: `CPU: ${formatBytes(cpuUsed)}` },
    { value: cached, total: metrics.total_bytes, color: 'bg-zinc-500', label: `Cached: ${formatBytes(cached)}` },
    { value: free, total: metrics.total_bytes, color: 'bg-zinc-700', label: `Free: ${formatBytes(free)}` },
  ]

  return (
    <MetricCard
      title="Unified Memory"
      subtitle={`${totalGB} GB shared CPU + GPU (LPDDR5X)`}
    >
      <div className="flex justify-center py-2">
        <ArcGauge
          value={usedPercent}
          label="Memory"
          unit="%"
          thresholds={THRESHOLDS.memoryUsage}
          size={gaugeSize}
        />
      </div>

      <StackedBar segments={segments} />

      {!metrics.gpu_estimated_bytes && (
        <p className="text-sm text-zinc-500 mt-2">GPU memory estimation unavailable</p>
      )}

      {showCharts && chartData && (
        <div className="mt-2">
          <TimeSeriesChart
            title="Memory Usage"
            data={chartData}
            yDomain={[0, 100]}
            unit="%"
          />
        </div>
      )}
    </MetricCard>
  )
}
