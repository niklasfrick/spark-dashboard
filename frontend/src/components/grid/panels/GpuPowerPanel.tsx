import { ArcGauge } from '@/components/gauges/ArcGauge'
import { HBar } from '@/components/gauges/HBar'
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart'
import { computePowerScale, powerPeak } from '@/lib/gpuPower'
import { THRESHOLDS } from '@/lib/theme'
import { gpuLabel } from './gpuLabel'
import { GpuPanelNotice } from './PanelNotice'
import { HardwarePanelBody } from './HardwarePanelBody'
import { useGpuPanelSeries } from './useGpuPanel'
import type { PanelContentProps } from '../panelRegistry'

/**
 * One GPU's power draw. The gauge scales against the hardware limit when the
 * GPU reports one, and against the observed peak in this panel's own history
 * window otherwise (unified-memory SoCs expose no cap — see `lib/gpuPower`).
 */
export function GpuPowerPanel({ panel }: PanelContentProps) {
  const { resolution, data } = useGpuPanelSeries(panel, 'gpuPower')
  if (resolution.status !== 'resolved') return <GpuPanelNotice resolution={resolution} />

  const { gpu } = resolution
  const { percent } = computePowerScale(
    gpu.power_watts,
    gpu.power_limit_watts,
    powerPeak(data, gpu.power_watts),
  )
  const watts = gpu.power_watts !== null ? Math.round(gpu.power_watts) : 0
  const label = gpuLabel(resolution, 'GPU Power')

  return (
    <HardwarePanelBody
      device={resolution.gpu.name}
      compact={
        <HBar
          value={percent}
          label={label}
          unit="W"
          thresholds={THRESHOLDS.gpuPower}
          displayValue={watts}
        />
      }
      gauge={(sizePx) => (
        <ArcGauge
          value={percent}
          label={label}
          unit="W"
          thresholds={THRESHOLDS.gpuPower}
          displayValue={watts}
          size={sizePx}
        />
      )}
      chart={<TimeSeriesChart data={data} unit="W" seriesLabel="Power" />}
    />
  )
}
