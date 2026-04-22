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
  if (!metrics) return <MetricCard title="Memory"><p className="text-zinc-500">Waiting for data...</p></MetricCard>

  const totalGB = (metrics.total_bytes / 1_000_000_000).toFixed(0)
  const usedPercent = metrics.total_bytes > 0
    ? (metrics.used_bytes / metrics.total_bytes) * 100
    : 0

  const title = metrics.is_unified ? 'Unified Memory' : 'Memory'
  const subtitle = metrics.is_unified
    ? `${totalGB} GB shared CPU + GPU`
    : `${totalGB} GB system RAM`

  // CPU RAM segments (used / cached / free). Mirrors the original layout.
  // Note: used_bytes = total - available on Linux (already excludes reclaimable
  // cache), so cached must be shown as a sub-segment of available, not
  // subtracted from used. On unified systems, the GPU-estimated slice is drawn
  // as a sub-segment of `used` to show per-process GPU attribution.
  const gpuEst = metrics.is_unified ? (metrics.gpu_estimated_bytes ?? 0) : 0
  const cpuUsed = Math.max(0, metrics.used_bytes - gpuEst)
  const cached = Math.min(metrics.cached_bytes, metrics.available_bytes)
  const free = Math.max(0, metrics.available_bytes - cached)

  const systemSegments = metrics.is_unified
    ? [
        { value: gpuEst, total: metrics.total_bytes, color: 'bg-[#76B900]', label: `GPU (est.): ${formatBytes(gpuEst)}` },
        { value: cpuUsed, total: metrics.total_bytes, color: 'bg-blue-500', label: `CPU: ${formatBytes(cpuUsed)}` },
        { value: cached, total: metrics.total_bytes, color: 'bg-zinc-500', label: `Cached: ${formatBytes(cached)}` },
        { value: free, total: metrics.total_bytes, color: 'bg-zinc-700', label: `Free: ${formatBytes(free)}` },
      ]
    : [
        { value: cpuUsed, total: metrics.total_bytes, color: 'bg-blue-500', label: `Used: ${formatBytes(cpuUsed)}` },
        { value: cached, total: metrics.total_bytes, color: 'bg-zinc-500', label: `Cached: ${formatBytes(cached)}` },
        { value: free, total: metrics.total_bytes, color: 'bg-zinc-700', label: `Free: ${formatBytes(free)}` },
      ]

  const vramTotal = metrics.gpu_memory_total_bytes ?? 0
  const vramUsed = metrics.gpu_memory_used_bytes ?? 0
  const hasDiscreteVram = !metrics.is_unified && vramTotal > 0
  const vramFree = Math.max(0, vramTotal - vramUsed)
  const vramPercent = vramTotal > 0 ? (vramUsed / vramTotal) * 100 : 0
  const vramTotalGB = (vramTotal / 1_000_000_000).toFixed(0)

  const vramSegments = [
    { value: vramUsed, total: vramTotal, color: 'bg-[#76B900]', label: `Used: ${formatBytes(vramUsed)}` },
    { value: vramFree, total: vramTotal, color: 'bg-zinc-700', label: `Free: ${formatBytes(vramFree)}` },
  ]

  return (
    <MetricCard
      title={title}
      subtitle={subtitle}
    >
      <div className="flex justify-center py-2">
        <ArcGauge
          value={usedPercent}
          label={metrics.is_unified ? 'Memory' : 'RAM'}
          unit="%"
          thresholds={THRESHOLDS.memoryUsage}
          size={gaugeSize}
        />
      </div>

      <StackedBar segments={systemSegments} />

      {metrics.is_unified && !metrics.gpu_estimated_bytes && (
        <p className="text-sm text-zinc-500 mt-2">GPU memory estimation unavailable</p>
      )}

      {hasDiscreteVram && (
        <div className="mt-4 pt-4 border-t border-white/[0.04]">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-zinc-300">GPU VRAM</span>
            <span className="text-xs text-zinc-500">{vramTotalGB} GB total</span>
          </div>
          <div className="flex justify-center py-2">
            <ArcGauge
              value={vramPercent}
              label="VRAM"
              unit="%"
              thresholds={THRESHOLDS.memoryUsage}
              size={gaugeSize}
            />
          </div>
          <StackedBar segments={vramSegments} />
        </div>
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
