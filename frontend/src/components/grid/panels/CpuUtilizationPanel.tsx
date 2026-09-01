import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart'
import { useMetricSeries } from '@/hooks/useMetricsStore'
import type { PanelContentProps } from '../panelRegistry'

/**
 * Aggregate CPU utilization over the panel's own time window. One of the two
 * tracer panels: host-wide, so nothing needs binding, and the interesting part
 * is the plumbing it proves rather than the chart it draws.
 */
export function CpuUtilizationPanel({ panel }: PanelContentProps) {
  const data = useMetricSeries('cpuAggregate', panel.window)

  return <TimeSeriesChart data={data} yDomain={[0, 100]} unit="%" seriesLabel="CPU" height="100%" />
}
