import { ArcGauge } from '@/components/gauges/ArcGauge'
import { HBar } from '@/components/gauges/HBar'
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart'
import { gpuLabel } from './gpuLabel'
import { GpuPanelNotice } from './PanelNotice'
import { HardwarePanelBody } from './HardwarePanelBody'
import { MultiGpuPanelBody } from './MultiGpuPanelBody'
import { useGpuPanelSeries, useGpuColumns } from './useGpuPanel'
import type { PanelContentProps } from '../panelRegistry'

/** One GPU's utilization: gauge plus trend over the panel's own window. */
export function GpuUtilizationPanel({ panel }: PanelContentProps) {
  const { resolution, data } = useGpuPanelSeries(panel, 'gpuUtil')
  const columns = useGpuColumns(panel, 'gpuUtil')
  if (resolution.status === 'aggregate') {
    return (
      <MultiGpuPanelBody
        seriesLabel="Util"
        columns={(columns ?? []).map((c) => ({
          index: c.index,
          name: c.name,
          engines: c.engines,
          value: c.gpu.utilization_percent,
          unit: '%',
          yDomain: [0, 100] as [number, number],
          data: c.data,
        }))}
      />
    )
  }
  if (resolution.status !== 'resolved') return <GpuPanelNotice resolution={resolution} />

  const value = resolution.gpu.utilization_percent ?? 0
  const label = gpuLabel(resolution, 'GPU Util')

  return (
    <HardwarePanelBody
      device={resolution.gpu.name}
      compact={<HBar value={value} label={label} unit="%" />}
      gauge={(sizePx) => <ArcGauge value={value} label={label} unit="%" size={sizePx} />}
      chart={
        <TimeSeriesChart data={data} yDomain={[0, 100]} unit="%" seriesLabel="GPU" />
      }
    />
  )
}
