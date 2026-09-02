import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart'
import { MetricTile } from '@/components/engines/EnginePanelPrimitives'
import { LatencyModeControl } from '@/components/engines/LatencyModeControl'
import { useLatencyMode } from '@/hooks/useLatencyMode'
import { computeTrend } from '@/lib/engineStats'
import { formatDurationMs, formatTtft, fmtVal } from '@/lib/format'
import { pickLatencyValue, type LatencyMode } from '@/lib/latencyMode'
import type { EngineSeriesName } from '@/lib/metricsHistoryStore'
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
 */
export function EngineLatencyPanel({ panel }: PanelContentProps) {
  const resolution = useEnginePanel(panel)
  const [mode, setMode] = useLatencyMode()
  if (resolution.status !== 'resolved') return <EnginePanelNotice resolution={resolution} />

  const { metric, series } = resolution
  const ttft = pickLatencyValue(mode, metric('ttft_ms'), metric('ttft_percentiles'))
  const itl = pickLatencyValue(mode, metric('inter_token_latency_ms'), metric('itl_percentiles'))
  const e2e = pickLatencyValue(mode, metric('e2e_latency_ms'), metric('e2e_percentiles'))
  const tpot = pickLatencyValue(mode, metric('tpot_ms'), metric('tpot_percentiles'))
  const batchSize = metric('avg_batch_size')
  const e2eDisplay = formatDurationMs(e2e)

  const ttftSeries = series(LATENCY_SERIES.ttft[mode])
  const itlSeries = series(LATENCY_SERIES.itl[mode])
  const tpotSeries = series(LATENCY_SERIES.tpot[mode])
  const e2eSeries = series(LATENCY_SERIES.e2e[mode])
  const queueSeries = series('queueTime')

  return (
    <EnginePanelBody
      identity={engineIdentity(resolution)}
      actions={<LatencyModeControl mode={mode} onModeChange={setMode} />}
      tiles={
        <div className="grid grid-cols-2 gap-1.5">
          <MetricTile
            label="TTFT"
            value={fmtVal(ttft, formatTtft)}
            unit="ms"
            trend={computeTrend(ttftSeries)}
            invertTrend
          />
          <MetricTile
            label="E2E"
            value={e2eDisplay.value}
            unit={e2eDisplay.unit}
            trend={computeTrend(e2eSeries)}
            invertTrend
          />
          <MetricTile
            label="Queue"
            value={fmtVal(metric('queue_time_ms'), formatTtft)}
            unit="ms"
            trend={computeTrend(queueSeries)}
            invertTrend
          />
          <MetricTile
            label="ITL"
            value={fmtVal(itl, formatTtft)}
            unit="ms"
            trend={computeTrend(itlSeries)}
            invertTrend
          />
          <MetricTile
            label="TPOT"
            value={fmtVal(tpot, formatTtft)}
            unit="ms"
            trend={computeTrend(tpotSeries)}
            invertTrend
          />
          <MetricTile
            label="Batch"
            value={batchSize !== null ? batchSize.toFixed(1) : '--'}
            unit="/step"
            trend={computeTrend(series('batchSize'))}
          />
        </div>
      }
      chart={
        <TimeSeriesChart
          hideTooltipLabel
          series={[
            // TTFT lives on the left axis (typically hundreds of ms); queue,
            // ITL and TPOT share a right axis (often single or double digits)
            // so their variation stays visible against the TTFT scale.
            { data: ttftSeries, label: 'TTFT', color: '#f59e0b', axis: 'left' },
            { data: queueSeries, label: 'Queue', color: '#8b5cf6', axis: 'right' },
            { data: itlSeries, label: 'ITL', color: '#14b8a6', axis: 'right' },
            { data: tpotSeries, label: 'TPOT', color: '#ec4899', axis: 'right' },
          ]}
          unit="ms"
          height="100%"
        />
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
} as const satisfies Record<string, Record<LatencyMode, EngineSeriesName>>
