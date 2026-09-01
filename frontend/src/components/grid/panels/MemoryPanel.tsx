import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart'
import { useMetricSeries } from '@/hooks/useMetricsStore'
import type { PanelContentProps } from '../panelRegistry'

/**
 * Used share of the host's memory pool over the panel's own time window. The
 * second tracer panel — host-wide on unified-memory machines, so unbound.
 */
export function MemoryPanel({ panel }: PanelContentProps) {
  const data = useMetricSeries('memoryUsedPercent', panel.window)

  return (
    <TimeSeriesChart data={data} yDomain={[0, 100]} unit="%" seriesLabel="Used" height="100%" />
  )
}
