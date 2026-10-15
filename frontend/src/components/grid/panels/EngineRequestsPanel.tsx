import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart'
import { MetricTile } from '@/components/engines/EnginePanelPrimitives'
import { fmtInt } from '@/lib/format'
import { reportedLines } from './reportedLines'
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
 * healthy engine and the tile appearing at all is the signal. An engine that
 * keeps no such counter is different: its tiles keep their slots and say "not
 * reported", like every tile whose group an engine does not report (ADR-0004).
 */
export function EngineRequestsPanel({ panel }: PanelContentProps) {
  const resolution = useEnginePanel(panel)
  if (resolution.status !== 'resolved' && resolution.status !== 'aggregate') {
    return <EnginePanelNotice resolution={resolution} />
  }

  const { metric, series, reports } = resolution
  const active = reports('ActiveRequests')
  const total = reports('RequestTotal')
  const preemptions = reports('Preemptions')
  /** A memory-pressure tile: shown once its count is above zero, or — on an
   *  engine that keeps no such counter — to say it is not reported. */
  const pressure = (label: string, count: number | null) => {
    if (!preemptions) return <MetricTile label={label} value={fmtInt(count)} notReported />
    return count !== null && count > 0 && <MetricTile label={label} value={fmtInt(count)} warn />
  }

  const chartSeries = reportedLines([
    active && { data: series('activeRequests'), label: 'Active', color: '#76B900', axis: 'left' },
    active && { data: series('queuedRequests'), label: 'Queued', color: '#f59e0b', axis: 'left' },
    // The lifetime counter only climbs, so it needs its own axis or it
    // flattens the two live counts against it.
    total && { data: series('totalRequests'), label: 'Total', color: '#3b82f6', axis: 'right' },
  ])

  return (
    <EnginePanelBody
      identity={engineIdentity(resolution)}
      tiles={
        <div className="grid grid-cols-2 gap-1.5">
          <MetricTile
            label="Active"
            value={fmtInt(metric('active_requests'))}
            notReported={!active}
          />
          <MetricTile
            label="Queued"
            value={fmtInt(metric('queued_requests'))}
            notReported={!active}
          />
          <MetricTile label="Total" value={fmtInt(metric('total_requests'))} notReported={!total} />
          {pressure('Swapped', metric('swapped_requests'))}
          {pressure('Preempt', metric('preemptions_total'))}
        </div>
      }
      chart={
        chartSeries.length > 0 ? (
          <TimeSeriesChart hideTooltipLabel series={chartSeries} unit="" />
        ) : undefined
      }
    />
  )
}
