import { ArcGauge } from '@/components/gauges/ArcGauge'
import { HBar } from '@/components/gauges/HBar'
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart'
import { gpuLabel } from './gpuLabel'
import { GpuPanelNotice, PanelNotice } from './PanelNotice'
import { HardwarePanelBody } from './HardwarePanelBody'
import { MultiGpuPanelBody } from './MultiGpuPanelBody'
import { useGpuPanelSeries, useGpuColumns } from './useGpuPanel'
import type { PanelContentProps } from '../panelRegistry'

/**
 * One GPU's fan speed, as a percentage of its maximum.
 *
 * No thresholds on the gauge: a fan at 100% is the cooling working, not a
 * fault, and colouring it red would say the opposite. The temperature panel is
 * where the alarming number lives — this one is read beside it, to tell a GPU
 * that is hot because it is working from one that is hot because it is not
 * being cooled.
 *
 * Passively cooled accelerators report no fan at all (NVML answers
 * `NotSupported`), which the panel says rather than drawing a zero.
 */
export function GpuFanPanel({ panel }: PanelContentProps) {
  const { resolution, data } = useGpuPanelSeries(panel, 'gpuFan')
  const columns = useGpuColumns(panel, 'gpuFan')
  if (resolution.status === 'aggregate') {
    return (
      <MultiGpuPanelBody
        seriesLabel="Fan"
        columns={(columns ?? []).map((c) => ({
          index: c.index,
          name: c.name,
          engines: c.engines,
          value: c.gpu.fan_speed_percent,
          unit: '%',
          yDomain: [0, 100] as [number, number],
          data: c.data,
        }))}
      />
    )
  }
  if (resolution.status !== 'resolved') return <GpuPanelNotice resolution={resolution} />

  const { gpu } = resolution
  const percent = gpu.fan_speed_percent
  if (percent === null) return <PanelNotice>This GPU has no fan to report.</PanelNotice>

  const label = gpuLabel(resolution, 'Fan')

  return (
    <HardwarePanelBody
      device={gpu.name}
      compact={<HBar value={percent} label={label} unit="%" />}
      gauge={(sizePx) => <ArcGauge value={percent} label={label} unit="%" size={sizePx} />}
      chart={<TimeSeriesChart data={data} yDomain={[0, 100]} unit="%" seriesLabel="Fan" />}
    />
  )
}
