import { MetricCard } from './MetricCard'
import { ArcGauge, type GaugeSegment } from './gauges/ArcGauge'
import { formatBytes, formatGiB } from '../lib/format'
import type { MemoryMetrics } from '../types/metrics'

interface MemoryCardProps {
  metrics: MemoryMetrics | null
  gaugeSize?: number
}

const GPU_COLOR = '#76B900'
const CPU_COLOR = '#3B82F6'
const CACHE_COLOR = '#71717A'
const FREE_COLOR = '#27272A'

export function MemoryCard({ metrics, gaugeSize }: MemoryCardProps) {
  if (!metrics) return <MetricCard title="Memory"><p className="text-zinc-500">Waiting for data...</p></MetricCard>

  const headlineTotal = metrics.display_total_bytes ?? metrics.total_bytes
  const totalGB = formatGiB(headlineTotal)
  const usedPercent = metrics.total_bytes > 0
    ? (metrics.used_bytes / metrics.total_bytes) * 100
    : 0

  const title = metrics.is_unified ? 'Unified Memory' : 'Memory'
  const subtitle = metrics.is_unified
    ? `${totalGB} shared CPU + GPU`
    : `${totalGB} system RAM`

  const gpuEst = metrics.is_unified ? (metrics.gpu_estimated_bytes ?? 0) : 0
  const cpuUsed = Math.max(0, metrics.used_bytes - gpuEst)
  const cached = Math.min(metrics.cached_bytes, metrics.available_bytes)
  const free = Math.max(0, metrics.available_bytes - cached)

  const systemSegments: GaugeSegment[] = metrics.is_unified
    ? [
        { value: gpuEst, total: metrics.total_bytes, color: GPU_COLOR, label: `GPU (est.): ${formatBytes(gpuEst)}` },
        { value: cpuUsed, total: metrics.total_bytes, color: CPU_COLOR, label: `CPU: ${formatBytes(cpuUsed)}` },
        { value: cached, total: metrics.total_bytes, color: CACHE_COLOR, label: `Cached: ${formatBytes(cached)}` },
        { value: free, total: metrics.total_bytes, color: FREE_COLOR, label: `Free: ${formatBytes(free)}` },
      ]
    : [
        { value: cpuUsed, total: metrics.total_bytes, color: CPU_COLOR, label: `Used: ${formatBytes(cpuUsed)}` },
        { value: cached, total: metrics.total_bytes, color: CACHE_COLOR, label: `Cached: ${formatBytes(cached)}` },
        { value: free, total: metrics.total_bytes, color: FREE_COLOR, label: `Free: ${formatBytes(free)}` },
      ]

  const vramTotal = metrics.gpu_memory_total_bytes ?? 0
  const vramUsed = metrics.gpu_memory_used_bytes ?? 0
  const hasDiscreteVram = !metrics.is_unified && vramTotal > 0
  const vramFree = Math.max(0, vramTotal - vramUsed)
  const vramTotalGB = formatGiB(vramTotal)

  const vramSegments: GaugeSegment[] = [
    { value: vramUsed, total: vramTotal, color: GPU_COLOR, label: `Used: ${formatBytes(vramUsed)}` },
    { value: vramFree, total: vramTotal, color: FREE_COLOR, label: `Free: ${formatBytes(vramFree)}` },
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
          segments={systemSegments}
          size={gaugeSize}
        />
      </div>

      {metrics.is_unified && !metrics.gpu_estimated_bytes && (
        <p className="text-sm text-zinc-500 mt-2">GPU memory estimation unavailable</p>
      )}

      {hasDiscreteVram && (
        <div className="mt-4 pt-4 border-t border-white/[0.04]">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-zinc-300">GPU VRAM</span>
            <span className="text-xs text-zinc-500">{vramTotalGB} total</span>
          </div>
          <div className="flex justify-center py-2">
            <ArcGauge
              label="VRAM"
              unit="%"
              segments={vramSegments}
              size={gaugeSize}
            />
          </div>
        </div>
      )}

    </MetricCard>
  )
}
