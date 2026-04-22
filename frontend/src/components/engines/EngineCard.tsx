import { TimeSeriesChart, type ChartSeries } from '@/components/charts/TimeSeriesChart'
import { formatTps, formatTtft, formatDurationMs } from '@/lib/format'
import type { EngineSnapshot } from '@/types/metrics'
import type { InferenceRequest } from '@/types/events'

interface ChartDataPoint {
  timestamp: number
  value: number
}

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

// --- Trend detection ---
type Trend = 'up' | 'down' | 'stable'

function computeTrend(data: ChartDataPoint[], threshold = 0.05): Trend {
  if (data.length < 6) return 'stable'
  const recent = data.slice(-3)
  const older = data.slice(Math.max(0, data.length - 15), data.length - 3)
  if (older.length < 3) return 'stable'
  const recentAvg = recent.reduce((s, p) => s + p.value, 0) / recent.length
  const olderAvg = older.reduce((s, p) => s + p.value, 0) / older.length
  if (olderAvg === 0) return recentAvg > 0 ? 'up' : 'stable'
  const change = (recentAvg - olderAvg) / Math.abs(olderAvg)
  if (change > threshold) return 'up'
  if (change < -threshold) return 'down'
  return 'stable'
}

function TrendArrow({ trend, invertColor }: { trend: Trend; invertColor?: boolean }) {
  if (trend === 'stable') {
    return <span className="text-zinc-600 text-[11px] ml-0.5">→</span>
  }
  const isUp = trend === 'up'
  const color = invertColor
    ? (isUp ? 'text-red-400' : 'text-[#76B900]')
    : (isUp ? 'text-[#76B900]' : 'text-red-400')
  return <span className={`${color} text-[11px] ml-0.5`}>{isUp ? '▲' : '▼'}</span>
}

/** Big metric tile with trend indicator */
function MetricTile({ label, value, unit, trend, invertTrend, warn }: {
  label: string
  value: string
  unit?: string
  trend?: Trend
  invertTrend?: boolean
  warn?: boolean
}) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className={`text-xs font-medium uppercase tracking-wider truncate ${warn ? 'text-red-400/70' : 'text-zinc-600'}`}>
        {label}
      </span>
      <div className="flex items-baseline">
        <span className={`text-2xl font-bold font-mono tabular-nums leading-none ${warn ? 'text-red-400' : 'text-zinc-100'}`}>
          {value}
        </span>
        {unit && <span className="text-xs text-zinc-500 ml-1">{unit}</span>}
        {trend && <TrendArrow trend={trend} invertColor={invertTrend} />}
      </div>
    </div>
  )
}

/** Mini KV cache bar */
function KvBar({ percent }: { percent: number }) {
  const color = percent > 90 ? 'bg-red-500' : percent > 70 ? 'bg-yellow-500' : 'bg-[#76B900]'
  return (
    <div className="flex h-1 rounded-full overflow-hidden bg-zinc-700/50 mt-1">
      <div className={`${color} transition-all duration-300`} style={{ width: `${percent}%` }} />
    </div>
  )
}

function fmtVal(v: number | null, fmt: (n: number) => string): string {
  return v === null ? '--' : fmt(v)
}

function fmtInt(v: number | null): string {
  return v === null ? '--' : String(Math.round(v))
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
    batchSize: ChartDataPoint[]
  }
  requests?: InferenceRequest[]
}

export function EngineCard({
  engine,
  showCharts = false,
  chartData,
  requests,
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
  const batchSize = v('avg_batch_size')
  const activeReqs = v('active_requests')
  const queuedReqs = v('queued_requests')
  const totalReqs = v('total_requests')
  const swappedReqs = v('swapped_requests')
  const kvPercent = v('kv_cache_percent')
  const prefixCacheHit = v('prefix_cache_hit_rate')
  const preemptions = v('preemptions_total')

  const e2eFmt = formatDurationMs(e2eLatency)

  // Compute trends from chart data
  const tpsTrend: Trend = chartData ? computeTrend(chartData.tps) : 'stable'
  const avgTpsTrend: Trend = chartData ? computeTrend(chartData.avgTps) : 'stable'
  const perReqTpsTrend: Trend = chartData ? computeTrend(chartData.perReqTps) : 'stable'
  const promptTpsTrend: Trend = chartData ? computeTrend(chartData.promptTps) : 'stable'
  const avgPromptTpsTrend: Trend = chartData ? computeTrend(chartData.avgPromptTps) : 'stable'
  const perReqPromptTpsTrend: Trend = chartData ? computeTrend(chartData.perReqPromptTps) : 'stable'
  const ttftTrend: Trend = chartData ? computeTrend(chartData.ttft) : 'stable'
  const e2eTrend: Trend = chartData ? computeTrend(chartData.e2eLatency) : 'stable'
  const queueTrend: Trend = chartData ? computeTrend(chartData.queueTime) : 'stable'
  const batchTrend: Trend = chartData ? computeTrend(chartData.batchSize) : 'stable'
  const kvTrend: Trend = chartData ? computeTrend(chartData.kv) : 'stable'

  const requestSpans = requests?.map(r => ({
    start: r.start_ms, end: r.end_ms, tps: r.tps, ttft: r.ttft_ms,
  }))

  return (
    <div className="flex flex-col h-full">
      {isWaitingForMetrics ? (
        <p className="text-sm text-zinc-500">Waiting for metrics...</p>
      ) : (
        <>
          {/* ── Grouped metrics with trend arrows — 4 categories ── */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 py-1.5">
            {/* Prefill Throughput */}
            <div className="bg-white/[0.02] rounded-md px-2.5 py-2">
              <div className="text-xs font-medium text-zinc-600 uppercase tracking-wider mb-2">Prompt Processing / Prefill Throughput</div>
              <div className="grid grid-cols-1 gap-2">
                <MetricTile label="Live" value={fmtVal(promptTps, formatTps)} unit="tok/s" trend={promptTpsTrend} />
                <MetricTile label="Global Average" value={fmtVal(avgPromptTps, formatTps)} unit="tok/s" trend={avgPromptTpsTrend} />
                <MetricTile label="Per-Request Average" value={fmtVal(perReqPromptTps, formatTps)} unit="tok/s" trend={perReqPromptTpsTrend} />
              </div>
            </div>

            {/* Decode Throughput */}
            <div className="bg-white/[0.02] rounded-md px-2.5 py-2">
              <div className="text-xs font-medium text-zinc-600 uppercase tracking-wider mb-2">Token Generation / Decode Throughput</div>
              <div className="grid grid-cols-1 gap-2">
                <MetricTile label="Live" value={fmtVal(tps, formatTps)} unit="tok/s" trend={tpsTrend} />
                <MetricTile label="Global Average" value={fmtVal(avgTps, formatTps)} unit="tok/s" trend={avgTpsTrend} />
                <MetricTile label="Per-Request Average" value={fmtVal(perReqTps, formatTps)} unit="tok/s" trend={perReqTpsTrend} />
              </div>
            </div>

            {/* Latency */}
            <div className="bg-white/[0.02] rounded-md px-2.5 py-2">
              <div className="text-xs font-medium text-zinc-600 uppercase tracking-wider mb-2">Latency</div>
              <div className="grid grid-cols-2 gap-2">
                <MetricTile label="TTFT" value={fmtVal(ttft, formatTtft)} unit="ms" trend={ttftTrend} invertTrend />
                <MetricTile label="E2E" value={e2eFmt.value} unit={e2eFmt.unit} trend={e2eTrend} invertTrend />
                <MetricTile label="Queue Wait" value={fmtVal(queueTime, formatTtft)} unit="ms" trend={queueTrend} invertTrend />
                <MetricTile label="Batch Size" value={batchSize !== null ? batchSize.toFixed(1) : '--'} unit="/step" trend={batchTrend} />
              </div>
            </div>

            {/* Requests */}
            <div className="bg-white/[0.02] rounded-md px-2.5 py-2">
              <div className="text-xs font-medium text-zinc-600 uppercase tracking-wider mb-2">Requests</div>
              <div className="grid grid-cols-2 gap-2">
                <MetricTile label="Active" value={fmtInt(activeReqs)} />
                <MetricTile label="Queued" value={fmtInt(queuedReqs)} />
                <MetricTile label="Total" value={fmtInt(totalReqs)} />
                {swappedReqs !== null && swappedReqs > 0 && (
                  <MetricTile label="Swapped" value={fmtInt(swappedReqs)} warn />
                )}
                {preemptions !== null && preemptions > 0 && (
                  <MetricTile label="Preemptions" value={fmtInt(preemptions)} warn />
                )}
              </div>
            </div>

            {/* Cache */}
            <div className="bg-white/[0.02] rounded-md px-2.5 py-2">
              <div className="text-xs font-medium text-zinc-600 uppercase tracking-wider mb-2">Cache</div>
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-xs font-medium text-zinc-600 uppercase tracking-wider truncate">KV Cache</span>
                  <div className="flex items-baseline">
                    <span className="text-2xl font-bold text-zinc-100 font-mono tabular-nums leading-none">
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

          {/* ── Charts pinned to bottom ── */}
          {showCharts && chartData && (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mt-auto pt-2">
              <TimeSeriesChart
                title="Prefill Throughput"
                series={prefillTokenSeries(chartData)}
                unit="tok/s"
                height={120}
                requests={requestSpans}
              />
              <TimeSeriesChart
                title="Decode Throughput"
                series={decodeTokenSeries(chartData)}
                unit="tok/s"
                height={120}
                requests={requestSpans}
              />
              <TimeSeriesChart
                title="TTFT & Queue"
                series={[
                  { data: chartData.ttft, label: 'TTFT', color: '#f59e0b' },
                  { data: chartData.queueTime, label: 'Queue', color: '#8b5cf6' },
                ]}
                unit="ms"
                height={120}
                requests={requestSpans}
              />
              <TimeSeriesChart
                title="E2E Latency"
                data={chartData.e2eLatency.map(p => ({ ...p, value: p.value / 1000 }))}
                unit="s"
                height={120}
                requests={requestSpans}
              />
              <TimeSeriesChart
                title="KV Cache"
                data={chartData.kv}
                yDomain={[0, 100]}
                unit="%"
                height={120}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}
