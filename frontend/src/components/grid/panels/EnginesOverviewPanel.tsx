import { useMemo } from 'react'
import { MetricTile } from '@/components/engines/EnginePanelPrimitives'
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart'
import { useLatestSnapshot, useMetricsStore } from '@/hooks/useMetricsStore'
import { aggregateEngines, groupRunningByProvider } from '@/lib/engineAggregate'
import { fmtInt, fmtVal, formatTps, formatTtft } from '@/lib/format'
import { engineKey } from '@/lib/identity'
import { engineSeries, type DataPoint } from '@/lib/metricsHistoryStore'
import { sumSeries } from '@/lib/series'
import { NVIDIA_THEME } from '@/lib/theme'
import { EngineChip } from './engineIdentity'
import { EnginePanelBody } from './EnginePanelBody'
import { PanelNotice } from './PanelNotice'
import type { PanelContentProps } from '../panelRegistry'

/**
 * Every engine on the host at once: how many are running, what they are
 * serving between them, and the totals across all of them.
 *
 * The one engine panel that binds to nothing — it is about the host, not about
 * a target — which is also why it is the panel an operator running several
 * models puts at the top of a page and then reads the per-engine panels under.
 *
 * Aggregation semantics are per field and live in `lib/engineAggregate`:
 * throughput and counts sum, because concurrent workers compose additively;
 * latencies are weighted by request volume; cache percentages are simple means,
 * since each engine has its own KV pool and summing them would be nonsense.
 */
export function EnginesOverviewPanel({ panel }: PanelContentProps) {
  const snapshot = useLatestSnapshot()
  const store = useMetricsStore()
  const window = panel.window

  const engines = useMemo(() => snapshot?.engines ?? [], [snapshot])

  // Summed decode throughput. Read straight off the store rather than through
  // `useMetricSeries`, because the number of engines is not known until a
  // snapshot arrives and a hook per engine would change the hook count.
  const decode = useMemo((): DataPoint[] => {
    return engines
      .map((engine) => store.getChartData(engineSeries('tps', engineKey(engine)), window))
      .reduce<DataPoint[]>((total, series) => sumSeries(total, series), [])
  }, [engines, store, window])

  if (!snapshot) return <PanelNotice>Waiting for metrics</PanelNotice>
  if (engines.length === 0) return <PanelNotice>No inference engine running.</PanelNotice>

  const totals = aggregateEngines(engines)
  const providers = groupRunningByProvider(engines)

  return (
    <EnginePanelBody
      tiles={
        <div className="flex flex-col gap-1.5 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <EngineChip label={`${totals.running_count}/${totals.total_count} running`} />
            {/* One chip per provider being served, so a page of engines can be
                read as "two Qwen and a Llama" without counting panels. */}
            {providers.map((group) => (
              <EngineChip
                key={group.key}
                label={`${group.label} (${group.count})`}
                iconSrc={group.logo?.url}
              />
            ))}
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 min-w-0">
            <MetricTile label="Decode" value={fmtVal(totals.tokens_per_sec, formatTps)} unit="tok/s" />
            <MetricTile
              label="Prefill"
              value={fmtVal(totals.prompt_tokens_per_sec, formatTps)}
              unit="tok/s"
            />
            <MetricTile label="Active" value={fmtInt(totals.active_requests)} />
            <MetricTile label="Queued" value={fmtInt(totals.queued_requests)} />
            {/* Weighted by request volume, not a mean of means — a quiet engine
                must not drag the number the busy one earned. */}
            <MetricTile label="TTFT" value={fmtVal(totals.ttft_ms, formatTtft)} unit="ms" />
            <MetricTile label="E2E" value={fmtVal(totals.e2e_latency_ms, formatTtft)} unit="ms" />
          </div>
        </div>
      }
      chart={
        <TimeSeriesChart
          data={decode}
          unit="tok/s"
          seriesLabel="All engines"
          color={NVIDIA_THEME.chartLine}
        />
      }
    />
  )
}
