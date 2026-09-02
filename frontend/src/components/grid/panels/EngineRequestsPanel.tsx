import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart'
import { MetricTile } from '@/components/engines/EnginePanelPrimitives'
import { fmtInt } from '@/lib/format'
import { EnginePanelBody } from './EnginePanelBody'
import { engineIdentity } from './engineLabel'
import { EnginePanelNotice } from './PanelNotice'
import { useEnginePanel } from './useEnginePanel'
import type { PanelContentProps } from '../panelRegistry'

/**
 * What the engine has in flight: active, queued and lifetime request counts.
 *
 * Swapped and preempted requests appear only once they have happened. They are
 * both signs of an engine under memory pressure, so a zero would be noise on a
 * healthy engine and the tile appearing at all is the signal.
 */
export function EngineRequestsPanel({ panel }: PanelContentProps) {
  const resolution = useEnginePanel(panel)
  if (resolution.status !== 'resolved') return <EnginePanelNotice resolution={resolution} />

  const { metric, series } = resolution
  const swapped = metric('swapped_requests')
  const preemptions = metric('preemptions_total')

  return (
    <EnginePanelBody
      identity={engineIdentity(resolution)}
      tiles={
        <div className="grid grid-cols-2 gap-1.5">
          <MetricTile label="Active" value={fmtInt(metric('active_requests'))} />
          <MetricTile label="Queued" value={fmtInt(metric('queued_requests'))} />
          <MetricTile label="Total" value={fmtInt(metric('total_requests'))} />
          {swapped !== null && swapped > 0 && (
            <MetricTile label="Swapped" value={fmtInt(swapped)} warn />
          )}
          {preemptions !== null && preemptions > 0 && (
            <MetricTile label="Preempt" value={fmtInt(preemptions)} warn />
          )}
        </div>
      }
      chart={
        <TimeSeriesChart
          hideTooltipLabel
          series={[
            { data: series('activeRequests'), label: 'Active', color: '#76B900', axis: 'left' },
            { data: series('queuedRequests'), label: 'Queued', color: '#f59e0b', axis: 'left' },
            // The lifetime counter only climbs, so it needs its own axis or it
            // flattens the two live counts against it.
            { data: series('totalRequests'), label: 'Total', color: '#3b82f6', axis: 'right' },
          ]}
          unit=""
          height="100%"
        />
      }
    />
  )
}
