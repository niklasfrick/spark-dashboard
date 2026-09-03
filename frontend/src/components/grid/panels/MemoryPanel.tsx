import { ArcGauge } from '@/components/gauges/ArcGauge'
import { HBar } from '@/components/gauges/HBar'
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart'
import { useLatestSnapshot, useMetricSeries } from '@/hooks/useMetricsStore'
import { formatGiB } from '@/lib/format'
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
  const { memory } = snapshot
  // The pool's size is the panel's "which hardware": on a unified host it is
  // the one pool the GPU also draws from, which is why this panel is host-wide.
  const pool = formatGiB(memory.display_total_bytes ?? memory.total_bytes)

  return (
    <HardwarePanelBody
      device={memory.is_unified ? `${pool} Unified` : pool}
      compact={<HBar value={usedPercent} label="" unit="%" segments={segments} />}
      gauge={(sizePx) => (
        <ArcGauge value={usedPercent} label="" unit="%" segments={segments} size={sizePx} />
      )}
      chart={
        <TimeSeriesChart data={data} yDomain={[0, 100]} unit="%" seriesLabel="Used" />
      }
    />
  )
}
