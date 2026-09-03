import { ArcGauge, type GaugeSegment } from '@/components/gauges/ArcGauge'
import { HBar } from '@/components/gauges/HBar'
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart'
import { formatGiB } from '@/lib/format'
import { gpuMemoryPercent } from '@/lib/metricsHistoryStore'
import { NVIDIA_THEME } from '@/lib/theme'
import { gpuLabel } from './gpuLabel'
import { GpuPanelNotice, PanelNotice } from './PanelNotice'
import { HardwarePanelBody } from './HardwarePanelBody'
import { useGpuPanelSeries } from './useGpuPanel'
import type { PanelContentProps } from '../panelRegistry'

/**
 * One GPU's own memory: the used share of the device pool, with the two figures
 * it is a share of.
 *
 * Distinct from the host `memory` panel, which is deliberately host-wide
 * because a unified-memory machine has one pool. This one reads the device's
 * NVML pool, which those machines do not report at all — hence the notice
 * rather than a gauge stuck at zero.
 */
export function GpuMemoryPanel({ panel }: PanelContentProps) {
  const { resolution, data } = useGpuPanelSeries(panel, 'gpuMemory')
  if (resolution.status !== 'resolved') return <GpuPanelNotice resolution={resolution} />

  const { gpu } = resolution
  const percent = gpuMemoryPercent(gpu)
  if (percent === null) {
    return <PanelNotice>This GPU does not report its own memory pool.</PanelNotice>
  }

  // Narrowed into locals: the guard above does not reach the render callbacks.
  const used = gpu.memory_used_bytes ?? 0
  const total = gpu.memory_total_bytes ?? 0
  // A single filled segment rather than a threshold gauge: the legend is where
  // the GB figures go, and "22.4 GB / 48.0 GB" is what an operator sizing a
  // model needs — a percentage alone does not say whether the next one fits.
  const segments: GaugeSegment[] = [
    {
      value: used,
      total,
      color: NVIDIA_THEME.accent,
      label: `${formatGiB(used, 1)} / ${formatGiB(total, 1)}`,
    },
  ]
  const label = gpuLabel(resolution, 'VRAM')

  return (
    <HardwarePanelBody
      device={gpu.name}
      compact={<HBar label={label} unit="%" segments={segments} />}
      gauge={(sizePx) => <ArcGauge label={label} unit="%" segments={segments} size={sizePx} />}
      chart={<TimeSeriesChart data={data} yDomain={[0, 100]} unit="%" seriesLabel="VRAM" />}
    />
  )
}
