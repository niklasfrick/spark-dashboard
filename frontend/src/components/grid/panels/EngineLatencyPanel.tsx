import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart'
import { MetricTile } from '@/components/engines/EnginePanelPrimitives'
import { LatencyModeControl } from '@/components/engines/LatencyModeControl'
import { useLatencyMode } from '@/hooks/useLatencyMode'
import { computeTrend } from '@/lib/engineStats'
import { formatDurationMs, formatTtft, fmtVal } from '@/lib/format'
import {
  pickLatencyValue,
  reportedLatencyStatistics,
  shownLatencyStatistic,
  type LatencyDimension,
  type LatencyMode,
} from '@/lib/latencyMode'
import type { EngineSeriesName } from '@/lib/metricsHistoryStore'
import type { LatencyPercentiles } from '@/types/metrics'
import { reportedLines } from './reportedLines'
import { EnginePanelBody } from './EnginePanelBody'
import { engineIdentity } from './engineLabel'
import { EnginePanelNotice } from './PanelNotice'
import { useEnginePanel } from './useEnginePanel'
import type { PanelContentProps } from '../panelRegistry'

/**
 * The latency an engine is serving at: time to first token, end to end, queue
 * wait, and the two per-token measures.
 *
 * Every value and every line follows the same statistic — average, or one of
 * the percentiles. Mixing them within a panel would be the quiet way to
 * misread a tail-latency problem as a healthy average, so the mode is one
 * choice made in the panel's own header.
 *
 * Each latency is reported as a mean and as percentiles, separately, so the
 * mode is applied to each one on its own: in a percentile mode, a latency whose
 * engine reports only its mean shows the mean, labelled as the mean rather than
 * shown under the percentile the header names. A tile the engine reports
 * nothing for — a latency in neither statistic, queue time, batch size — keeps
 * its slot and says "not reported", and draws no line: the panel's tiles are
 * the same whichever engine it shows (ADR-0004).
 */
export function EngineLatencyPanel({ panel }: PanelContentProps) {
  const resolution = useEnginePanel(panel)
  const [mode, setMode] = useLatencyMode()
  if (resolution.status !== 'resolved' && resolution.status !== 'aggregate') {
    return <EnginePanelNotice resolution={resolution} />
  }

  const { metric, series, reports } = resolution
  /** One latency figure in the statistic shown. One the engine reports in no
   *  statistic it could be shown in keeps its plain name and is not reported. */
  const dimension = (
    name: string,
    key: LatencyDimension,
    mean: number | null,
    percentiles: LatencyPercentiles | null,
  ) => {
    const statistic = shownLatencyStatistic(mode, reportedLatencyStatistics(key, reports))
    if (statistic === null) return { label: name, reported: false, value: null, series: [] }
    return {
      // A mean standing in for the percentile the header names says what it
      // is: under the percentile's heading it would read as a healthy tail.
      label: statistic === mode ? name : `${name} mean`,
      reported: true,
      value: pickLatencyValue(statistic, mean, percentiles),
      series: series(LATENCY_SERIES[key][statistic]),
    }
  }
  const ttft = dimension('TTFT', 'ttft', metric('ttft_ms'), metric('ttft_percentiles'))
  const e2e = dimension('E2E', 'e2e', metric('e2e_latency_ms'), metric('e2e_percentiles'))
  const itl = dimension('ITL', 'itl', metric('inter_token_latency_ms'), metric('itl_percentiles'))
  const tpot = dimension('TPOT', 'tpot', metric('tpot_ms'), metric('tpot_percentiles'))
  // Queue wait is a mean in every mode, as it always has been.
  const queueReported = reports('QueueTime')
  const queueSeries = queueReported ? series('queueTime') : []
  // Tokens per engine step is not a latency: it is its own group, and this
  // panel is only where it is shown.
  const batchReported = reports('BatchSize')
  const batchSize = metric('avg_batch_size')
  const e2eShown = formatDurationMs(e2e.value)

  // TTFT lives on the left axis (typically hundreds of ms); queue, ITL and
  // TPOT share a right axis (often single or double digits) so their variation
  // stays visible against the TTFT scale.
  const chartSeries = reportedLines([
    ttft.reported && { data: ttft.series, label: ttft.label, color: '#f59e0b', axis: 'left' },
    queueReported && { data: queueSeries, label: 'Queue', color: '#8b5cf6', axis: 'right' },
    itl.reported && { data: itl.series, label: itl.label, color: '#14b8a6', axis: 'right' },
    tpot.reported && { data: tpot.series, label: tpot.label, color: '#ec4899', axis: 'right' },
  ])

  return (
    <EnginePanelBody
      identity={engineIdentity(resolution)}
      actions={<LatencyModeControl mode={mode} onModeChange={setMode} />}
      tiles={
        <div className="grid grid-cols-2 gap-1.5">
          <MetricTile
            label={ttft.label}
            value={fmtVal(ttft.value, formatTtft)}
            unit="ms"
            trend={computeTrend(ttft.series)}
            invertTrend
            notReported={!ttft.reported}
          />
          <MetricTile
            label={e2e.label}
            value={e2eShown.value}
            unit={e2eShown.unit}
            trend={computeTrend(e2e.series)}
            invertTrend
            notReported={!e2e.reported}
          />
          <MetricTile
            label="Queue"
            value={fmtVal(metric('queue_time_ms'), formatTtft)}
            unit="ms"
            trend={computeTrend(queueSeries)}
            invertTrend
            notReported={!queueReported}
          />
          <MetricTile
            label={itl.label}
            value={fmtVal(itl.value, formatTtft)}
            unit="ms"
            trend={computeTrend(itl.series)}
            invertTrend
            notReported={!itl.reported}
          />
          <MetricTile
            label={tpot.label}
            value={fmtVal(tpot.value, formatTtft)}
            unit="ms"
            trend={computeTrend(tpot.series)}
            invertTrend
            notReported={!tpot.reported}
          />
          <MetricTile
            label="Batch"
            value={batchSize !== null ? batchSize.toFixed(1) : '--'}
            unit="/step"
            trend={batchReported ? computeTrend(series('batchSize')) : undefined}
            notReported={!batchReported}
          />
        </div>
      }
      chart={
        chartSeries.length > 0 ? (
          <TimeSeriesChart hideTooltipLabel series={chartSeries} unit="ms" />
        ) : undefined
      }
    />
  )
}

/**
 * Which series carries each latency dimension under each statistic. The
 * percentile series are ingested alongside the averages, so switching the mode
 * re-reads history rather than starting a new one.
 */
const LATENCY_SERIES = {
  ttft: { avg: 'ttft', p50: 'ttftP50', p95: 'ttftP95', p99: 'ttftP99' },
  itl: { avg: 'interTokenLatency', p50: 'itlP50', p95: 'itlP95', p99: 'itlP99' },
  e2e: { avg: 'e2eLatency', p50: 'e2eP50', p95: 'e2eP95', p99: 'e2eP99' },
  tpot: { avg: 'tpot', p50: 'tpotP50', p95: 'tpotP95', p99: 'tpotP99' },
} as const satisfies Record<LatencyDimension, Record<LatencyMode, EngineSeriesName>>
