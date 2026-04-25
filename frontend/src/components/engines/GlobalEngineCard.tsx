import { formatTps, formatTtft, formatDurationMs } from '@/lib/format'
import type { AggregateSnapshot } from '@/lib/engineAggregate'
import { MetricTile, KvBar, GoodputTile, fmtVal, fmtInt } from './EngineCardPrimitives'
import { type LatencyMode, latencyModeLabel, pickLatencyValue } from './LatencyModeControl'
import { SLO, combinedGoodput } from '@/lib/slo'

interface GlobalEngineCardProps {
  snapshot: AggregateSnapshot
  latencyMode?: LatencyMode
}

/** Styled to match the metric-group tiles below (same bg/radius/padding idiom). */
function RunningCountCard({ count }: { count: number }) {
  return (
    <div className="bg-white/[0.02] rounded-md px-4 py-3.5 w-fit">
      <div className="text-sm font-semibold text-zinc-300 tracking-tight mb-2">
        Engines Running
      </div>
      <span className="text-5xl font-bold font-mono tabular-nums leading-none text-[#76B900]">
        {count}
      </span>
    </div>
  )
}

export function GlobalEngineCard({ snapshot, latencyMode = 'avg' }: GlobalEngineCardProps) {
  const {
    running_count,
    total_count,
    tokens_per_sec,
    avg_tokens_per_sec,
    per_request_tps,
    prompt_tokens_per_sec,
    avg_prompt_tokens_per_sec,
    per_request_prompt_tps,
    ttft_ms,
    e2e_latency_ms,
    queue_time_ms,
    inter_token_latency_ms,
    avg_batch_size,
    active_requests,
    queued_requests,
    total_requests,
    swapped_requests,
    preemptions_total,
    kv_cache_percent,
    prefix_cache_hit_rate,
    ttft_percentiles,
    itl_percentiles,
    e2e_percentiles,
    ttft_goodput_pct,
    itl_goodput_pct,
    e2e_goodput_pct,
  } = snapshot
  const overallGoodput = combinedGoodput(ttft_goodput_pct, itl_goodput_pct, e2e_goodput_pct)

  const ttftDisplay = pickLatencyValue(latencyMode, ttft_ms, ttft_percentiles)
  const itlDisplay = pickLatencyValue(latencyMode, inter_token_latency_ms, itl_percentiles)
  const e2eDisplay = pickLatencyValue(latencyMode, e2e_latency_ms, e2e_percentiles)
  const e2eFmt = formatDurationMs(e2eDisplay)
  const latencyHeading = `Latency · ${latencyModeLabel(latencyMode)}`

  if (running_count === 0) {
    return (
      <div className="flex flex-col h-full gap-3">
        <RunningCountCard count={0} />
        <p className="text-sm text-zinc-500">
          {total_count === 0
            ? 'No inference engines detected. Start vLLM and it will appear here automatically.'
            : 'No engines are currently running. Waiting for inference servers to come online.'}
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full gap-3">
      <RunningCountCard count={running_count} />

      {/* ── Grouped aggregate metrics — matches EngineCard layout ── */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2 py-1">
        {/* Prefill Throughput */}
        <div className="bg-white/[0.02] rounded-md px-3 py-2.5 2xl:px-4 2xl:py-3 min-w-0">
          <div className="text-[11px] 2xl:text-xs min-[1920px]:text-sm font-semibold text-zinc-300 tracking-tight mb-1.5 truncate">
            Prompt Processing / Prefill Throughput
            <span className="ml-1 text-[9px] font-normal text-zinc-500">(sum)</span>
          </div>
          <div className="grid grid-cols-1 gap-1.5">
            <MetricTile label="Live" value={fmtVal(prompt_tokens_per_sec, formatTps)} unit="tok/s" />
            <MetricTile label="Avg" value={fmtVal(avg_prompt_tokens_per_sec, formatTps)} unit="tok/s" />
            <MetricTile label="Per-Req Avg" value={fmtVal(per_request_prompt_tps, formatTps)} unit="tok/s" />
          </div>
        </div>

        {/* Decode Throughput */}
        <div className="bg-white/[0.02] rounded-md px-3 py-2.5 2xl:px-4 2xl:py-3 min-w-0">
          <div className="text-[11px] 2xl:text-xs min-[1920px]:text-sm font-semibold text-zinc-300 tracking-tight mb-1.5 truncate">
            Token Generation / Decode Throughput
            <span className="ml-1 text-[9px] font-normal text-zinc-500">(sum)</span>
          </div>
          <div className="grid grid-cols-1 gap-1.5">
            <MetricTile label="Live" value={fmtVal(tokens_per_sec, formatTps)} unit="tok/s" />
            <MetricTile label="Avg" value={fmtVal(avg_tokens_per_sec, formatTps)} unit="tok/s" />
            <MetricTile label="Per-Req Avg" value={fmtVal(per_request_tps, formatTps)} unit="tok/s" />
          </div>
        </div>

        {/* Latency */}
        <div className="bg-white/[0.02] rounded-md px-3 py-2.5 2xl:px-4 2xl:py-3 min-w-0">
          <div className="text-[11px] 2xl:text-xs min-[1920px]:text-sm font-semibold text-zinc-300 tracking-tight mb-1.5 truncate">
            {latencyHeading}
            <span className="ml-1 text-[9px] font-normal text-zinc-500">(weighted)</span>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <MetricTile label="TTFT" value={fmtVal(ttftDisplay, formatTtft)} unit="ms" />
            <MetricTile label="E2E" value={e2eFmt.value} unit={e2eFmt.unit} />
            <MetricTile label="Queue" value={fmtVal(queue_time_ms, formatTtft)} unit="ms" />
            <MetricTile label="ITL" value={fmtVal(itlDisplay, formatTtft)} unit="ms" />
            <MetricTile label="Batch" value={avg_batch_size !== null ? avg_batch_size.toFixed(1) : '--'} unit="/step" />
          </div>
        </div>

        {/* SLO Goodput */}
        <div className="bg-white/[0.02] rounded-md px-3 py-2.5 2xl:px-4 2xl:py-3 min-w-0">
          <div className="text-[11px] 2xl:text-xs min-[1920px]:text-sm font-semibold text-zinc-300 tracking-tight mb-1.5 truncate">
            SLO Goodput
            <span className="ml-1 text-[9px] font-normal text-zinc-500">(weighted)</span>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <div className="col-span-2"><GoodputTile label="Combined" pct={overallGoodput} emphasize /></div>
            <GoodputTile label={`TTFT ≤ ${SLO.ttftMs}ms`} pct={ttft_goodput_pct} />
            <GoodputTile label={`ITL ≤ ${SLO.itlMs}ms`} pct={itl_goodput_pct} />
            <div className="col-span-2"><GoodputTile label={`E2E ≤ ${(SLO.e2eMs / 1000).toFixed(0)}s`} pct={e2e_goodput_pct} /></div>
          </div>
        </div>

        {/* Requests */}
        <div className="bg-white/[0.02] rounded-md px-3 py-2.5 2xl:px-4 2xl:py-3 min-w-0">
          <div className="text-[11px] 2xl:text-xs min-[1920px]:text-sm font-semibold text-zinc-300 tracking-tight mb-1.5 truncate">
            Requests
            <span className="ml-1 text-[9px] font-normal text-zinc-500">(sum)</span>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <MetricTile label="Active" value={fmtInt(active_requests)} />
            <MetricTile label="Queued" value={fmtInt(queued_requests)} />
            <MetricTile label="Total" value={fmtInt(total_requests)} />
            {swapped_requests !== null && swapped_requests > 0 && (
              <MetricTile label="Swapped" value={fmtInt(swapped_requests)} warn />
            )}
            {preemptions_total !== null && preemptions_total > 0 && (
              <MetricTile label="Preempt" value={fmtInt(preemptions_total)} warn />
            )}
          </div>
        </div>

        {/* Cache */}
        <div className="bg-white/[0.02] rounded-md px-3 py-2.5 2xl:px-4 2xl:py-3 min-w-0">
          <div className="text-[11px] 2xl:text-xs min-[1920px]:text-sm font-semibold text-zinc-300 tracking-tight mb-1.5 truncate">
            Cache
            <span className="ml-1 text-[9px] font-normal text-zinc-500">(avg)</span>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-[10px] font-medium text-zinc-400 uppercase tracking-wider truncate">KV Cache</span>
              <div className="flex items-baseline">
                <span className="text-lg xl:text-xl 2xl:text-2xl min-[1920px]:text-3xl min-[2560px]:text-4xl font-bold text-zinc-100 font-mono tabular-nums leading-none">
                  {kv_cache_percent !== null ? Math.round(kv_cache_percent) : '--'}
                </span>
                <span className="text-xs text-zinc-500 ml-1">%</span>
              </div>
              {kv_cache_percent !== null && <KvBar percent={kv_cache_percent} />}
            </div>
            <MetricTile
              label="Prefix Hit"
              value={prefix_cache_hit_rate !== null ? `${Math.round(prefix_cache_hit_rate)}` : '--'}
              unit="%"
            />
          </div>
        </div>
      </div>
    </div>
  )
}
