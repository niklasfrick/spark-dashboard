import { TimeSeriesChart, type ChartSeries } from '@/components/charts/TimeSeriesChart'
import { formatTps, formatTtft, formatDurationMs } from '@/lib/format'
import type { EngineSnapshot } from '@/types/metrics'
import type { InferenceRequest } from '@/types/events'
import {
  type ChartDataPoint,
  type Trend,
  MetricTile,
  KvBar,
  TrendArrow,
  GoodputTile,
  computeTrend,
  fmtVal,
  fmtInt,
} from './EngineCardPrimitives'
import { type LatencyMode, latencyModeLabel, pickLatencyValue } from './LatencyModeControl'
import { SLO, combinedGoodput } from '@/lib/slo'

function decodeTokenSeries(chartData: {
  tps: ChartDataPoint[]
  avgTps: ChartDataPoint[]
  perReqTps: ChartDataPoint[]
}): ChartSeries[] {
  return [
    { data: chartData.tps, label: 'Live tok/s', color: '#76B900' },
    { data: chartData.avgTps, label: 'Avg tok/s', color: '#3b82f6' },
    { data: chartData.perReqTps, label: 'Per-req tok/s', color: '#a855f7' },
  ]
}

function prefillTokenSeries(chartData: {
  promptTps: ChartDataPoint[]
  avgPromptTps: ChartDataPoint[]
  perReqPromptTps: ChartDataPoint[]
}): ChartSeries[] {
  return [
    { data: chartData.promptTps, label: 'Live tok/s', color: '#76B900' },
    { data: chartData.avgPromptTps, label: 'Avg tok/s', color: '#3b82f6' },
    { data: chartData.perReqPromptTps, label: 'Per-req tok/s', color: '#a855f7' },
  ]
}

interface EngineCardProps {
  engine: EngineSnapshot
  tpsHistory?: number[]
  ttftHistory?: number[]
  kvHistory?: number[]
  showCharts?: boolean
  chartData?: {
    tps: ChartDataPoint[]
    avgTps: ChartDataPoint[]
    perReqTps: ChartDataPoint[]
    ttft: ChartDataPoint[]
    kv: ChartDataPoint[]
    e2eLatency: ChartDataPoint[]
    promptTps: ChartDataPoint[]
    avgPromptTps: ChartDataPoint[]
    perReqPromptTps: ChartDataPoint[]
    queueTime: ChartDataPoint[]
    interTokenLatency: ChartDataPoint[]
    batchSize: ChartDataPoint[]
    ttftP50: ChartDataPoint[]
    ttftP95: ChartDataPoint[]
    ttftP99: ChartDataPoint[]
    itlP50: ChartDataPoint[]
    itlP95: ChartDataPoint[]
    itlP99: ChartDataPoint[]
    e2eP50: ChartDataPoint[]
    e2eP95: ChartDataPoint[]
    e2eP99: ChartDataPoint[]
  }
  requests?: InferenceRequest[]
  latencyMode?: LatencyMode
}

export function EngineCard({
  engine,
  showCharts = false,
  chartData,
  requests,
  latencyMode = 'avg',
}: EngineCardProps) {
  const noModel = engine.model === null
  const isWaitingForMetrics = engine.metrics === null
    && (engine.status.type === 'Running' || engine.status.type === 'Loading')
    && !noModel

  const m = engine.metrics
  const v = (key: keyof NonNullable<typeof m>) => noModel ? null : (m?.[key] ?? null) as number | null

  const tps = v('tokens_per_sec')
  const avgTps = v('avg_tokens_per_sec')
  const perReqTps = v('per_request_tps')
  const promptTps = v('prompt_tokens_per_sec')
  const avgPromptTps = v('avg_prompt_tokens_per_sec')
  const perReqPromptTps = v('per_request_prompt_tps')
  const ttft = v('ttft_ms')
  const e2eLatency = v('e2e_latency_ms')
  const queueTime = v('queue_time_ms')
  const interTokenLatency = v('inter_token_latency_ms')
  const batchSize = v('avg_batch_size')
  const activeReqs = v('active_requests')
  const queuedReqs = v('queued_requests')
  const totalReqs = v('total_requests')
  const swappedReqs = v('swapped_requests')
  const kvPercent = v('kv_cache_percent')
  const prefixCacheHit = v('prefix_cache_hit_rate')
  const preemptions = v('preemptions_total')
  const ttftGoodput = v('ttft_goodput_pct')
  const itlGoodput = v('itl_goodput_pct')
  const e2eGoodput = v('e2e_goodput_pct')
  const overallGoodput = combinedGoodput(ttftGoodput, itlGoodput, e2eGoodput)

  // Resolve latency tile values according to the global mode setting
  // (avg / p50 / p95 / p99). Avg falls back to the histogram-derived
  // sum/count means; percentile modes pull from the histograms struct.
  const ttftPctl = noModel ? null : (m?.ttft_percentiles ?? null)
  const itlPctl = noModel ? null : (m?.itl_percentiles ?? null)
  const e2ePctl = noModel ? null : (m?.e2e_percentiles ?? null)
  const ttftDisplay = pickLatencyValue(latencyMode, ttft, ttftPctl)
  const itlDisplay = pickLatencyValue(latencyMode, interTokenLatency, itlPctl)
  const e2eDisplay = pickLatencyValue(latencyMode, e2eLatency, e2ePctl)
  const e2eFmt = formatDurationMs(e2eDisplay)
  const latencyHeading = `Latency · ${latencyModeLabel(latencyMode)}`

  // Compute trends from chart data
  const tpsTrend: Trend = chartData ? computeTrend(chartData.tps) : 'stable'
  const avgTpsTrend: Trend = chartData ? computeTrend(chartData.avgTps) : 'stable'
  const perReqTpsTrend: Trend = chartData ? computeTrend(chartData.perReqTps) : 'stable'
  const promptTpsTrend: Trend = chartData ? computeTrend(chartData.promptTps) : 'stable'
  const avgPromptTpsTrend: Trend = chartData ? computeTrend(chartData.avgPromptTps) : 'stable'
  const perReqPromptTpsTrend: Trend = chartData ? computeTrend(chartData.perReqPromptTps) : 'stable'
  const ttftSeries = chartData
    ? (latencyMode === 'p50' ? chartData.ttftP50
       : latencyMode === 'p95' ? chartData.ttftP95
       : latencyMode === 'p99' ? chartData.ttftP99
       : chartData.ttft)
    : []
  const itlSeries = chartData
    ? (latencyMode === 'p50' ? chartData.itlP50
       : latencyMode === 'p95' ? chartData.itlP95
       : latencyMode === 'p99' ? chartData.itlP99
       : chartData.interTokenLatency)
    : []
  const e2eSeries = chartData
    ? (latencyMode === 'p50' ? chartData.e2eP50
       : latencyMode === 'p95' ? chartData.e2eP95
       : latencyMode === 'p99' ? chartData.e2eP99
       : chartData.e2eLatency)
    : []
  const ttftTrend: Trend = chartData ? computeTrend(ttftSeries) : 'stable'
  const e2eTrend: Trend = chartData ? computeTrend(e2eSeries) : 'stable'
  const queueTrend: Trend = chartData ? computeTrend(chartData.queueTime) : 'stable'
  const itlTrend: Trend = chartData ? computeTrend(itlSeries) : 'stable'
  const batchTrend: Trend = chartData ? computeTrend(chartData.batchSize) : 'stable'
  const kvTrend: Trend = chartData ? computeTrend(chartData.kv) : 'stable'

  const requestSpans = requests?.map(r => ({
    start: r.start_ms, end: r.end_ms, tps: r.tps, ttft: r.ttft_ms,
  }))

  return (
    <div className="flex flex-col">
      {isWaitingForMetrics ? (
        <p className="text-sm text-zinc-500">Waiting for metrics...</p>
      ) : (
        <>
          {/* ── Grouped metrics with trend arrows — 6 categories ── */}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2 py-1">
            {/* Prefill Throughput */}
            <div className="bg-white/[0.02] rounded-md px-3 py-2.5 2xl:px-4 2xl:py-3 min-w-0">
              <div className="text-[11px] 2xl:text-xs min-[1920px]:text-sm font-semibold text-zinc-300 tracking-tight mb-1.5 truncate">Prompt Processing / Prefill Throughput</div>
              <div className="grid grid-cols-1 gap-1.5">
                <MetricTile label="Live" value={fmtVal(promptTps, formatTps)} unit="tok/s" trend={promptTpsTrend} />
                <MetricTile label="Avg" value={fmtVal(avgPromptTps, formatTps)} unit="tok/s" trend={avgPromptTpsTrend} />
                <MetricTile label="Per-Req Avg" value={fmtVal(perReqPromptTps, formatTps)} unit="tok/s" trend={perReqPromptTpsTrend} />
              </div>
            </div>

            {/* Decode Throughput */}
            <div className="bg-white/[0.02] rounded-md px-3 py-2.5 2xl:px-4 2xl:py-3 min-w-0">
              <div className="text-[11px] 2xl:text-xs min-[1920px]:text-sm font-semibold text-zinc-300 tracking-tight mb-1.5 truncate">Token Generation / Decode Throughput</div>
              <div className="grid grid-cols-1 gap-1.5">
                <MetricTile label="Live" value={fmtVal(tps, formatTps)} unit="tok/s" trend={tpsTrend} />
                <MetricTile label="Avg" value={fmtVal(avgTps, formatTps)} unit="tok/s" trend={avgTpsTrend} />
                <MetricTile label="Per-Req Avg" value={fmtVal(perReqTps, formatTps)} unit="tok/s" trend={perReqTpsTrend} />
              </div>
            </div>

            {/* Latency */}
            <div className="bg-white/[0.02] rounded-md px-3 py-2.5 2xl:px-4 2xl:py-3 min-w-0">
              <div className="text-[11px] 2xl:text-xs min-[1920px]:text-sm font-semibold text-zinc-300 tracking-tight mb-1.5 truncate">{latencyHeading}</div>
              <div className="grid grid-cols-2 gap-1.5">
                <MetricTile label="TTFT" value={fmtVal(ttftDisplay, formatTtft)} unit="ms" trend={ttftTrend} invertTrend />
                <MetricTile label="E2E" value={e2eFmt.value} unit={e2eFmt.unit} trend={e2eTrend} invertTrend />
                <MetricTile label="Queue" value={fmtVal(queueTime, formatTtft)} unit="ms" trend={queueTrend} invertTrend />
                <MetricTile label="ITL" value={fmtVal(itlDisplay, formatTtft)} unit="ms" trend={itlTrend} invertTrend />
                <MetricTile label="Batch" value={batchSize !== null ? batchSize.toFixed(1) : '--'} unit="/step" trend={batchTrend} />
              </div>
            </div>

            {/* SLO Goodput */}
            <div className="bg-white/[0.02] rounded-md px-3 py-2.5 2xl:px-4 2xl:py-3 min-w-0">
              <div className="text-[11px] 2xl:text-xs min-[1920px]:text-sm font-semibold text-zinc-300 tracking-tight mb-1.5 truncate">SLO Goodput</div>
              <div className="grid grid-cols-2 gap-1.5">
                <div className="col-span-2"><GoodputTile label="Combined" pct={overallGoodput} emphasize /></div>
                <GoodputTile label={`TTFT ≤ ${SLO.ttftMs}ms`} pct={ttftGoodput} />
                <GoodputTile label={`ITL ≤ ${SLO.itlMs}ms`} pct={itlGoodput} />
                <div className="col-span-2"><GoodputTile label={`E2E ≤ ${(SLO.e2eMs / 1000).toFixed(0)}s`} pct={e2eGoodput} /></div>
              </div>
            </div>

            {/* Requests */}
            <div className="bg-white/[0.02] rounded-md px-3 py-2.5 2xl:px-4 2xl:py-3 min-w-0">
              <div className="text-[11px] 2xl:text-xs min-[1920px]:text-sm font-semibold text-zinc-300 tracking-tight mb-1.5 truncate">Requests</div>
              <div className="grid grid-cols-2 gap-1.5">
                <MetricTile label="Active" value={fmtInt(activeReqs)} />
                <MetricTile label="Queued" value={fmtInt(queuedReqs)} />
                <MetricTile label="Total" value={fmtInt(totalReqs)} />
                {swappedReqs !== null && swappedReqs > 0 && (
                  <MetricTile label="Swapped" value={fmtInt(swappedReqs)} warn />
                )}
                {preemptions !== null && preemptions > 0 && (
                  <MetricTile label="Preempt" value={fmtInt(preemptions)} warn />
                )}
              </div>
            </div>

            {/* Cache */}
            <div className="bg-white/[0.02] rounded-md px-3 py-2.5 2xl:px-4 2xl:py-3 min-w-0">
              <div className="text-[11px] 2xl:text-xs min-[1920px]:text-sm font-semibold text-zinc-300 tracking-tight mb-1.5 truncate">Cache</div>
              <div className="grid grid-cols-2 gap-1.5">
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-[10px] font-medium text-zinc-400 uppercase tracking-wider truncate">KV Cache</span>
                  <div className="flex items-baseline">
                    <span className="text-lg xl:text-xl 2xl:text-2xl min-[1920px]:text-3xl min-[2560px]:text-4xl font-bold text-zinc-100 font-mono tabular-nums leading-none">
                      {kvPercent !== null ? Math.round(kvPercent) : '--'}
                    </span>
                    <span className="text-xs text-zinc-500 ml-1">%</span>
                    <TrendArrow trend={kvTrend} invertColor />
                  </div>
                  {kvPercent !== null && <KvBar percent={kvPercent} />}
                </div>
                <MetricTile label="Prefix Hit" value={prefixCacheHit !== null ? `${Math.round(prefixCacheHit)}` : '--'} unit="%" />
              </div>
            </div>
          </div>

          {/* ── Charts sit directly under the metric grid (no flex spacer) ── */}
          {showCharts && chartData && (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 pt-1">
              <TimeSeriesChart
                title="Prefill Throughput"
                series={prefillTokenSeries(chartData)}
                unit="tok/s"
                height="clamp(72px, 13vh, 200px)"
                requests={requestSpans}
              />
              <TimeSeriesChart
                title="Decode Throughput"
                series={decodeTokenSeries(chartData)}
                unit="tok/s"
                height="clamp(72px, 13vh, 200px)"
                requests={requestSpans}
              />
              <TimeSeriesChart
                title={`Latency · ${latencyModeLabel(latencyMode)}`}
                series={[
                  // TTFT lives on the left axis (typically hundreds of ms).
                  // Queue + ITL share a right axis (often single/double digits)
                  // so small variations remain visible against the TTFT scale.
                  { data: ttftSeries, label: 'TTFT', color: '#f59e0b', axis: 'left' },
                  { data: chartData.queueTime, label: 'Queue', color: '#8b5cf6', axis: 'right' },
                  { data: itlSeries, label: 'ITL', color: '#14b8a6', axis: 'right' },
                ]}
                unit="ms"
                height="clamp(72px, 13vh, 200px)"
                requests={requestSpans}
              />
              <TimeSeriesChart
                title={`E2E Latency · ${latencyModeLabel(latencyMode)}`}
                data={e2eSeries.map(p => ({ ...p, value: p.value / 1000 }))}
                unit="s"
                height="clamp(72px, 13vh, 200px)"
                requests={requestSpans}
              />
              <TimeSeriesChart
                title="KV Cache"
                data={chartData.kv}
                yDomain={[0, 100]}
                unit="%"
                height="clamp(72px, 13vh, 200px)"
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}
