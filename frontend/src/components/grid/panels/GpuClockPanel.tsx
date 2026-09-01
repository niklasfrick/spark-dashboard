import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart'
import { useMetricSeries } from '@/hooks/useMetricsStore'
import { formatMhz } from '@/lib/format'
import { gpuLabel } from './gpuLabel'
import { GpuPanelNotice } from './PanelNotice'
import { HardwarePanelBody } from './HardwarePanelBody'
import { useGpuPanel } from './useGpuPanel'
import type { PanelContentProps } from '../panelRegistry'

/** One GPU's graphics clock: the current speed as a headline, plus its trend. */
export function GpuClockPanel({ panel }: PanelContentProps) {
  const resolution = useGpuPanel(panel)
  const series =
    resolution.status === 'resolved' ? resolution.seriesFor('gpuClockGraphics') : 'gpuClockGraphics'
  const data = useMetricSeries(series, panel.window)
  if (resolution.status !== 'resolved') return <GpuPanelNotice resolution={resolution} />

  const clock = formatMhz(resolution.gpu.clock_graphics_mhz)
  const label = gpuLabel(resolution, 'Graphics')

  return (
    <HardwarePanelBody
      compact={
        <div className="flex items-baseline justify-between gap-2 min-w-0">
          <span className="text-[9px] lg:text-[10px] text-zinc-400 uppercase tracking-wider truncate">
            {label}
          </span>
          <span className="ml-auto shrink-0 text-xs lg:text-sm 2xl:text-base font-bold text-zinc-100 font-mono tabular-nums">
            {clock}
          </span>
        </div>
      }
      gauge={(sizePx) => (
        <div
          className="flex flex-col items-center justify-center shrink-0"
          style={{ width: sizePx, height: sizePx }}
        >
          <span className="text-sm 2xl:text-base font-bold text-zinc-100 font-mono">{clock}</span>
        </div>
      )}
      chart={<TimeSeriesChart data={data} unit="MHz" seriesLabel="Clock" height="100%" />}
    />
  )
}
