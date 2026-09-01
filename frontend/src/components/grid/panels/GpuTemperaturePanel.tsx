import { ArcGauge } from '@/components/gauges/ArcGauge'
import { HBar } from '@/components/gauges/HBar'
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart'
import { THRESHOLDS } from '@/lib/theme'
import { gpuLabel } from './gpuLabel'
import { GpuPanelNotice } from './PanelNotice'
import { HardwarePanelBody } from './HardwarePanelBody'
import { useGpuPanelSeries } from './useGpuPanel'
import type { PanelContentProps } from '../panelRegistry'

/** One GPU's temperature, colored by the product's thermal thresholds. */
export function GpuTemperaturePanel({ panel }: PanelContentProps) {
  const { resolution, data } = useGpuPanelSeries(panel, 'gpuTemp')
  if (resolution.status !== 'resolved') return <GpuPanelNotice resolution={resolution} />

  const value = resolution.gpu.temperature_celsius ?? 0
  const label = gpuLabel(resolution, 'GPU Temp')

  return (
    <HardwarePanelBody
      compact={<HBar value={value} label={label} unit="°C" thresholds={THRESHOLDS.gpuTemp} />}
      gauge={(sizePx) => (
        <ArcGauge value={value} label={label} unit="°C" thresholds={THRESHOLDS.gpuTemp} size={sizePx} />
      )}
      chart={
        <TimeSeriesChart data={data} yDomain={[0, 100]} unit="°C" seriesLabel="Temp" height="100%" />
      }
    />
  )
}
