import { MetricRow } from '@/components/MetricRow'
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart'
import { formatMhz } from '@/lib/format'
import { gpuLabel } from './gpuLabel'
import { GpuPanelNotice } from './PanelNotice'
import { HardwarePanelBody } from './HardwarePanelBody'
import { MultiGpuPanelBody } from './MultiGpuPanelBody'
import { useGpuPanelSeries, useGpuColumns } from './useGpuPanel'
import type { PanelContentProps } from '../panelRegistry'

/** One GPU's graphics clock: the current speed as a headline, plus its trend. */
export function GpuClockPanel({ panel }: PanelContentProps) {
  const { resolution, data } = useGpuPanelSeries(panel, 'gpuClockGraphics')
  const columns = useGpuColumns(panel, 'gpuClockGraphics')
  if (resolution.status === 'aggregate') {
    return (
      <MultiGpuPanelBody
        seriesLabel="Clock"
        columns={(columns ?? []).map((c) => ({
          index: c.index,
          name: c.name,
          engines: c.engines,
          value: c.gpu.clock_graphics_mhz === null ? null : Math.round(c.gpu.clock_graphics_mhz),
          unit: 'MHz',
          data: c.data,
        }))}
      />
    )
  }
  if (resolution.status !== 'resolved') return <GpuPanelNotice resolution={resolution} />

  const mhz = resolution.gpu.clock_graphics_mhz
  const label = gpuLabel(resolution, 'Graphics')

  return (
    <HardwarePanelBody
      device={resolution.gpu.name}
      compact={
        <MetricRow label={label} value={mhz === null ? null : String(Math.round(mhz))} unit="MHz" />
      }
      gauge={(sizePx) => (
        <div
          className="flex flex-col items-center justify-center shrink-0"
          style={{ width: sizePx, height: sizePx }}
        >
          <span className="text-sm 2xl:text-base font-bold text-zinc-100 font-mono">
            {formatMhz(mhz)}
          </span>
        </div>
      )}
      chart={<TimeSeriesChart data={data} unit="MHz" seriesLabel="Clock" />}
    />
  )
}
