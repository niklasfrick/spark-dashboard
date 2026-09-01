import { ArcGauge, type GaugeSegment } from '@/components/gauges/ArcGauge'
import { HBar } from '@/components/gauges/HBar'
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart'
import { useLatestSnapshot, useMetricSeries } from '@/hooks/useMetricsStore'
import { formatBytes } from '@/lib/format'
import { PanelNotice } from './PanelNotice'
import { HardwarePanelBody } from './HardwarePanelBody'
import type { PanelContentProps } from '../panelRegistry'

/**
 * Used share of the host's memory pool, split into the product's segments
 * (GPU, CPU, cache, free). Host-wide: unified-memory machines report one pool
 * shared with the GPU, which is why this panel does not bind to a GPU.
 */
export function MemoryPanel({ panel }: PanelContentProps) {
  const snapshot = useLatestSnapshot()
  const data = useMetricSeries('memoryUsedPercent', panel.window)
  if (!snapshot) return <PanelNotice>Waiting for metrics</PanelNotice>

  const { memory } = snapshot
  const usedPercent =
    memory.total_bytes > 0 ? (memory.used_bytes / memory.total_bytes) * 100 : 0

  const gpuUsed = memory.gpu_estimated_bytes ?? 0
  const cpuUsed = Math.max(0, memory.used_bytes - gpuUsed)
  const cached = Math.min(memory.cached_bytes, memory.available_bytes)
  const free = Math.max(0, memory.available_bytes - cached)

  const segments: GaugeSegment[] = [
    { value: gpuUsed, total: memory.total_bytes, color: '#76B900', label: `GPU: ${formatBytes(gpuUsed)}` },
    { value: cpuUsed, total: memory.total_bytes, color: '#3B82F6', label: `CPU: ${formatBytes(cpuUsed)}` },
    { value: cached, total: memory.total_bytes, color: '#71717A', label: `Cache: ${formatBytes(cached)}` },
    { value: free, total: memory.total_bytes, color: '#27272A', label: `Free: ${formatBytes(free)}` },
  ]

  return (
    <HardwarePanelBody
      compact={<HBar value={usedPercent} label="" unit="%" segments={segments} />}
      gauge={(sizePx) => (
        <ArcGauge value={usedPercent} label="" unit="%" segments={segments} size={sizePx} />
      )}
      chart={
        <TimeSeriesChart data={data} yDomain={[0, 100]} unit="%" seriesLabel="Used" height="100%" />
      }
    />
  )
}
