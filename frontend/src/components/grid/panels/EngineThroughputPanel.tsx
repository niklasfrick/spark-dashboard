import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart'
import { LiveWithTotal, MetricTile } from '@/components/engines/EnginePanelPrimitives'
import { computeTrend } from '@/lib/engineStats'
import { formatCompactTokens, formatTps, fmtVal } from '@/lib/format'
import type { NumericEngineMetric } from '@/lib/engineMetrics'
import type { EngineSeriesName } from '@/lib/metricsHistoryStore'
import { EnginePanelBody } from './EnginePanelBody'
import { engineIdentity } from './engineLabel'
import { EnginePanelNotice } from './PanelNotice'
import { MultiEnginePanelBody } from './MultiEnginePanelBody'
import { useEnginePanel, useEngineRows } from './useEnginePanel'
import type { PanelContentProps } from '../panelRegistry'

/**
 * The two throughput panels are the same panel over different fields: prefill
 * measures the prompt the engine is reading, decode the tokens it is writing.
 * Keeping them one component keeps the pair honest — a change to how live,
 * average and per-request throughput are laid out cannot land on one of them.
 */
interface ThroughputFields {
  live: NumericEngineMetric
  average: NumericEngineMetric
  perRequest: NumericEngineMetric
  total: NumericEngineMetric
  /** What the cumulative total counts, as the tile labels it. */
  totalLabel: string
  /** The panel's row-view caption, one per engine on an all-models page. */
  rowLabel: string
  series: { live: EngineSeriesName; average: EngineSeriesName; perRequest: EngineSeriesName }
}

const PREFILL: ThroughputFields = {
  live: 'prompt_tokens_per_sec',
  average: 'avg_prompt_tokens_per_sec',
  perRequest: 'per_request_prompt_tps',
  total: 'total_prompt_tokens',
  totalLabel: 'Processed',
  rowLabel: 'Prompt throughput',
  series: { live: 'promptTps', average: 'avgPromptTps', perRequest: 'perReqPromptTps' },
}

const DECODE: ThroughputFields = {
  live: 'tokens_per_sec',
  average: 'avg_tokens_per_sec',
  perRequest: 'per_request_tps',
  total: 'total_generation_tokens',
  totalLabel: 'Generated',
  rowLabel: 'Decode throughput',
  series: { live: 'tps', average: 'avgTps', perRequest: 'perReqTps' },
}

/** Prompt processing: how fast the engine is reading its prompts. */
export function EnginePrefillThroughputPanel({ panel }: PanelContentProps) {
  return <ThroughputPanel panel={panel} fields={PREFILL} />
}

/** Token generation: how fast the engine is producing output. */
export function EngineDecodeThroughputPanel({ panel }: PanelContentProps) {
  return <ThroughputPanel panel={panel} fields={DECODE} />
}

function ThroughputPanel({ panel, fields }: PanelContentProps & { fields: ThroughputFields }) {
  const rows = useEngineRows(panel)
  const resolution = useEnginePanel(panel)
  if (rows.status === 'rows') {
    // One row per engine, each on its own live figure and trend line — the
    // combined figure the panel wore on an all-models page is gone.
    return (
      <MultiEnginePanelBody
        seriesLabel={fields.rowLabel}
        rows={rows.rows}
        pick={(row) => {
          const metric = row.metric
          // The figures the single view tiles, one per row: live up top, the
          // average and per-request beside it, the lifetime total kept
          // visible. The row's chart wears the single view's three lines.
          return {
            value: metric ? metric(fields.live) : null,
            displayValue: metric
              ? `${fmtVal(metric(fields.live), formatTps)} tok/s`
              : undefined,
            unit: 'tok/s',
            data: row.series ? row.series(fields.series.live) : [],
            stats: metric
              ? [
                  { label: 'Avg', value: `${fmtVal(metric(fields.average), formatTps)} tok/s` },
                  {
                    label: 'Per-Req Avg',
                    value: `${fmtVal(metric(fields.perRequest), formatTps)} tok/s`,
                  },
                  {
                    label: fields.totalLabel,
                    value: `${formatCompactTokens(metric(fields.total))} tok`,
                  },
                ]
              : undefined,
            series: row.series
              ? [
                  { data: row.series(fields.series.average), label: 'Avg', color: '#3b82f6' },
                  { data: row.series(fields.series.perRequest), label: 'Per-req', color: '#a855f7' },
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
  const live = series(fields.series.live)
  const average = series(fields.series.average)
  const perRequest = series(fields.series.perRequest)

  return (
    <EnginePanelBody
      identity={engineIdentity(resolution)}
      tiles={
        <div className="grid grid-cols-1 gap-1.5">
          <LiveWithTotal
            liveValue={fmtVal(metric(fields.live), formatTps)}
            liveUnit="tok/s"
            trend={computeTrend(live)}
            totalLabel={fields.totalLabel}
            total={metric(fields.total)}
          />
          <MetricTile
            label="Avg"
            value={fmtVal(metric(fields.average), formatTps)}
            unit="tok/s"
            trend={computeTrend(average)}
          />
          <MetricTile
            label="Per-Req Avg"
            value={fmtVal(metric(fields.perRequest), formatTps)}
            unit="tok/s"
            trend={computeTrend(perRequest)}
          />
        </div>
      }
      chart={
        <TimeSeriesChart
          hideTooltipLabel
          series={[
            { data: live, label: 'Live', color: '#76B900' },
            { data: average, label: 'Avg', color: '#3b82f6' },
            { data: perRequest, label: 'Per-req', color: '#a855f7' },
          ]}
          unit="tok/s"
        />
      }
    />
  )
}
