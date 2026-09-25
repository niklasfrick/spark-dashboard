import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart'
import { MetricTile } from '@/components/engines/EnginePanelPrimitives'
import { LatencyModeControl } from '@/components/engines/LatencyModeControl'
import { useLatencyMode } from '@/hooks/useLatencyMode'
import { computeTrend } from '@/lib/engineStats'
import { formatDurationMs, formatTtft, fmtVal } from '@/lib/format'
import { pickLatencyValue, type LatencyMode } from '@/lib/latencyMode'
import { supportsCapability } from '@/lib/engineCapabilities'
import type { EngineSeriesName } from '@/lib/metricsHistoryStore'
import { EnginePanelBody } from './EnginePanelBody'
import { engineIdentity } from './engineLabel'
import { EnginePanelNotice } from './PanelNotice'
import { MultiEnginePanelBody } from './MultiEnginePanelBody'
import { useEnginePanel, useEngineRows } from './useEnginePanel'
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
  const rows = useEngineRows(panel)
  const resolution = useEnginePanel(panel)
  const [mode, setMode] = useLatencyMode()
  if (rows.status === 'rows') {
    // One row per engine, each on its own TTFT. A row follows the panel's
    // statistic unless its engine ships no histograms — llama.cpp rows fall
    // back to the mean, exactly as a pinned panel for it does.
    return (
      <MultiEnginePanelBody
        seriesLabel="TTFT"
        rows={rows.rows}
        pick={(row) => {
          const metric = row.metric
          const rowMode =
            metric && supportsCapability(row.engine.engine_type, 'latencyPercentiles')
              ? mode
              : 'avg'
          const value = metric
            ? pickLatencyValue(rowMode, metric('ttft_ms'), metric('ttft_percentiles'))
            : null
          // The tiles the single view shows beside TTFT, kept on the row so a
          // row reads like a card: E2E, queue time, ITL, TPOT and batch size.
          const e2eDisplay = formatDurationMs(metric ? metric('e2e_latency_ms') : null)
          const batch = metric ? metric('avg_batch_size') : null
          return {
            value,
            displayValue: metric ? `${fmtVal(value, formatTtft)} ms` : undefined,
            unit: 'ms',
            data: row.series ? row.series(LATENCY_SERIES.ttft[rowMode]) : [],
            stats: metric
              ? [
                  {
                    label: 'E2E',
                    value: e2eDisplay.unit
                      ? `${e2eDisplay.value} ${e2eDisplay.unit}`
                      : e2eDisplay.value,
                  },
                  ...(supportsCapability(row.engine.engine_type, 'queueTime')
                    ? [
                        {
                          label: 'Queue',
                          value: `${fmtVal(metric('queue_time_ms'), formatTtft)} ms`,
                        },
                      ]
                    : []),
                  {
                    label: 'ITL',
                    value: `${fmtVal(
                      pickLatencyValue(
                        rowMode,
                        metric('inter_token_latency_ms'),
                        metric('itl_percentiles'),
                      ),
                      formatTtft,
                    )} ms`,
                  },
                  {
                    label: 'TPOT',
                    value: `${fmtVal(
                      pickLatencyValue(rowMode, metric('tpot_ms'), metric('tpot_percentiles')),
                      formatTtft,
                    )} ms`,
                  },
                  {
                    label: 'Batch',
                    value: batch !== null ? batch.toFixed(1) : '--',
                  },
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
  // llama.cpp ships no latency histograms and no queue-time metric: fall back
  // to the mean (and hide the percentile options) and drop the queue tile/line.
  const engineType = resolution.status === 'resolved' ? resolution.engine.engine_type : null
  const hasPercentiles = supportsCapability(engineType, 'latencyPercentiles')
  const hasQueue = supportsCapability(engineType, 'queueTime')
  const statMode: LatencyMode = hasPercentiles ? mode : 'avg'

  const ttft = pickLatencyValue(statMode, metric('ttft_ms'), metric('ttft_percentiles'))
  const itl = pickLatencyValue(statMode, metric('inter_token_latency_ms'), metric('itl_percentiles'))
  const e2e = pickLatencyValue(statMode, metric('e2e_latency_ms'), metric('e2e_percentiles'))
  const tpot = pickLatencyValue(statMode, metric('tpot_ms'), metric('tpot_percentiles'))
  const batchSize = metric('avg_batch_size')
  const e2eDisplay = formatDurationMs(e2e)

  const ttftSeries = series(LATENCY_SERIES.ttft[statMode])
  const itlSeries = series(LATENCY_SERIES.itl[statMode])
  const tpotSeries = series(LATENCY_SERIES.tpot[statMode])
  const e2eSeries = series(LATENCY_SERIES.e2e[statMode])
  const queueSeries = series('queueTime')

  return (
    <EnginePanelBody
      identity={engineIdentity(resolution)}
      actions={
        <LatencyModeControl
          mode={statMode}
          onModeChange={setMode}
          percentilesSupported={hasPercentiles}
        />
      }
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
          {hasQueue && (
            <MetricTile
              label="Queue"
              value={fmtVal(metric('queue_time_ms'), formatTtft)}
              unit="ms"
              trend={computeTrend(queueSeries)}
              invertTrend
            />
          )}
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
            ...(hasQueue
              ? [{ data: queueSeries, label: 'Queue', color: '#8b5cf6', axis: 'right' as const }]
              : []),
            { data: itlSeries, label: 'ITL', color: '#14b8a6', axis: 'right' },
            { data: tpotSeries, label: 'TPOT', color: '#ec4899', axis: 'right' },
          ]}
          unit="ms"
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
