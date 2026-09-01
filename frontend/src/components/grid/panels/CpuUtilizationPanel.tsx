import { ArcGauge } from '@/components/gauges/ArcGauge'
import { HBar } from '@/components/gauges/HBar'
import { CoreHeatmap } from '@/components/charts/CoreHeatmap'
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart'
import { useLatestSnapshot, useMetricSeries } from '@/hooks/useMetricsStore'
import { THRESHOLDS } from '@/lib/theme'
import { PanelNotice } from './PanelNotice'
import { HardwarePanelBody } from './HardwarePanelBody'
import type { PanelContentProps } from '../panelRegistry'

/**
 * Aggregate CPU utilization, with the per-core heatmap when the panel is tall
 * enough for the full rendering. Host-wide, so nothing needs binding.
 */
export function CpuUtilizationPanel({ panel }: PanelContentProps) {
  const snapshot = useLatestSnapshot()
  const data = useMetricSeries('cpuAggregate', panel.window)
  if (!snapshot) return <PanelNotice>Waiting for metrics</PanelNotice>

  const { cpu } = snapshot

  return (
    <HardwarePanelBody
      compact={
        <HBar value={cpu.aggregate_percent} label="CPU" unit="%" thresholds={THRESHOLDS.cpuUsage} />
      }
      gauge={(sizePx) => (
        <ArcGauge
          value={cpu.aggregate_percent}
          label="CPU"
          unit="%"
          thresholds={THRESHOLDS.cpuUsage}
          size={sizePx}
        />
      )}
      chart={
        <TimeSeriesChart data={data} yDomain={[0, 100]} unit="%" seriesLabel="CPU" height="100%" />
      }
      below={cpu.per_core.length > 0 ? <CoreHeatmap cores={cpu.per_core} /> : undefined}
    />
  )
}
