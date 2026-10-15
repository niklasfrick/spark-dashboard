import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart'
import { LiveWithTotal, MetricTile } from '@/components/engines/EnginePanelPrimitives'
import { computeTrend } from '@/lib/engineStats'
import { formatTps, fmtVal } from '@/lib/format'
import type { NumericEngineMetric } from '@/lib/engineMetrics'
import type { EngineSeriesName } from '@/lib/metricsHistoryStore'
import type { MetricGroup } from '@/types/metrics'
import { reportedLines } from './reportedLines'
import { EnginePanelBody } from './EnginePanelBody'
import { engineIdentity } from './engineLabel'
import { EnginePanelNotice } from './PanelNotice'
import { useEnginePanel } from './useEnginePanel'
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
  /** The group the per-request rate is reported in: it is derived from the
   *  phase's latency mean, so it is reported exactly when that mean is. */
  perRequestGroup: MetricGroup
  series: { live: EngineSeriesName; average: EngineSeriesName; perRequest: EngineSeriesName }
}

const PREFILL: ThroughputFields = {
  live: 'prompt_tokens_per_sec',
  average: 'avg_prompt_tokens_per_sec',
  perRequest: 'per_request_prompt_tps',
  total: 'total_prompt_tokens',
  totalLabel: 'Processed',
  perRequestGroup: 'TtftMean',
  series: { live: 'promptTps', average: 'avgPromptTps', perRequest: 'perReqPromptTps' },
}

const DECODE: ThroughputFields = {
  live: 'tokens_per_sec',
  average: 'avg_tokens_per_sec',
  perRequest: 'per_request_tps',
  total: 'total_generation_tokens',
  totalLabel: 'Generated',
  perRequestGroup: 'TpotMean',
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
  const resolution = useEnginePanel(panel)
  if (resolution.status !== 'resolved' && resolution.status !== 'aggregate') {
    return <EnginePanelNotice resolution={resolution} />
  }

  // A tile whose group the engine does not report keeps its slot and says so,
  // and draws no line (ADR-0004).
  const { metric, series, reports } = resolution
  const throughput = reports('Throughput')
  const perRequestReported = reports(fields.perRequestGroup)
  const live = throughput ? series(fields.series.live) : []
  const average = throughput ? series(fields.series.average) : []
  const perRequest = perRequestReported ? series(fields.series.perRequest) : []

  const chartSeries = reportedLines([
    throughput && { data: live, label: 'Live', color: '#76B900' },
    throughput && { data: average, label: 'Avg', color: '#3b82f6' },
    perRequestReported && { data: perRequest, label: 'Per-req', color: '#a855f7' },
  ])

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
            notReported={!throughput}
          />
          <MetricTile
            label="Avg"
            value={fmtVal(metric(fields.average), formatTps)}
            unit="tok/s"
            trend={computeTrend(average)}
            notReported={!throughput}
          />
          <MetricTile
            label="Per-Req Avg"
            value={fmtVal(metric(fields.perRequest), formatTps)}
            unit="tok/s"
            trend={computeTrend(perRequest)}
            notReported={!perRequestReported}
          />
        </div>
      }
      chart={
        chartSeries.length > 0 ? (
          <TimeSeriesChart hideTooltipLabel series={chartSeries} unit="tok/s" />
        ) : undefined
      }
    />
  )
}
