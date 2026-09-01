import { ArcGauge } from '@/components/gauges/ArcGauge'
import { HBar } from '@/components/gauges/HBar'
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart'
import { useLatestSnapshot, useMetricSeries } from '@/hooks/useMetricsStore'
import { memorySplit } from '@/lib/memorySplit'
import { PanelNotice } from './PanelNotice'
import { HardwarePanelBody } from './HardwarePanelBody'
import type { PanelContentProps } from '../panelRegistry'

/**
 * Used share of the host's memory pool, split into the product's segments
 * (GPU, CPU, cache, free). Host-wide: unified-memory machines report one pool
 * shared with the GPU, which is why this panel does not bind to a GPU.
 */
export function MemoryPanel({ panel }: PanelContentProps) {
  const snapshot = useLatestSnapshot()
  const data = useMetricSeries('memoryUsedPercent', panel.window)
  if (!snapshot) return <PanelNotice>Waiting for metrics</PanelNotice>

  const { usedPercent, segments } = memorySplit(snapshot.memory)

  return (
    <HardwarePanelBody
      compact={<HBar value={usedPercent} label="" unit="%" segments={segments} />}
      gauge={(sizePx) => (
        <ArcGauge value={usedPercent} label="" unit="%" segments={segments} size={sizePx} />
      )}
      chart={
        <TimeSeriesChart data={data} yDomain={[0, 100]} unit="%" seriesLabel="Used" height="100%" />
      }
    />
  )
}
