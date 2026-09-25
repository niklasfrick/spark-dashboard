import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart'
import { MetricTile } from '@/components/engines/EnginePanelPrimitives'
import { fmtInt } from '@/lib/format'
import { EnginePanelBody } from './EnginePanelBody'
import { engineIdentity } from './engineLabel'
import { EnginePanelNotice } from './PanelNotice'
import { MultiEnginePanelBody } from './MultiEnginePanelBody'
import { useEnginePanel, useEngineRows } from './useEnginePanel'
import type { PanelContentProps } from '../panelRegistry'

/**
 * What the engine has in flight: active, queued and lifetime request counts.
 *
 * Swapped and preempted requests appear only once they have happened. They are
 * both signs of an engine under memory pressure, so a zero would be noise on a
 * healthy engine and the tile appearing at all is the signal.
 */
export function EngineRequestsPanel({ panel }: PanelContentProps) {
  const rows = useEngineRows(panel)
  const resolution = useEnginePanel(panel)
  if (rows.status === 'rows') {
    // One row per engine, each on its own in-flight count and trend.
    return (
      <MultiEnginePanelBody
        seriesLabel="Active requests"
        rows={rows.rows}
        pick={(row) => {
          const metric = row.metric
          const swapped = metric ? metric('swapped_requests') : null
          const preemptions = metric ? metric('preemptions_total') : null
          return {
            value: metric ? metric('active_requests') : null,
            displayValue: metric ? fmtInt(metric('active_requests')) : undefined,
            unit: '',
            data: row.series ? row.series('activeRequests') : [],
            // The counts the single view tiles beside Active; swapped and
            // preempted appear only once they have happened, as there.
            stats: metric
              ? [
                  { label: 'Queued', value: fmtInt(metric('queued_requests')) },
                  { label: 'Total', value: fmtInt(metric('total_requests')) },
                  ...(swapped !== null && swapped > 0
                    ? [{ label: 'Swapped', value: fmtInt(swapped) }]
                    : []),
                  ...(preemptions !== null && preemptions > 0
                    ? [{ label: 'Preempt', value: fmtInt(preemptions) }]
                    : []),
                ]
              : undefined,
          }
        }}
      />
    )
  }
  if (resolution.status !== 'resolved' && resolution.status !== 'aggregate') {
    return <EnginePanelNotice resolution={resolution} />
  }

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
        />
      }
    />
  )
}
