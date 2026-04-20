import { ArcGauge } from '@/components/gauges/ArcGauge'
import { CoreHeatmap } from '@/components/charts/CoreHeatmap'
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart'
import { StackedBar } from '@/components/StackedBar'
import { EngineSection } from '@/components/engines/EngineSection'
import { THRESHOLDS } from '@/lib/theme'
import { formatBytes, formatMhz, formatRate } from '@/lib/format'
import type { MetricsSnapshot } from '@/types/metrics'
import type { GpuEvent, InferenceRequest } from '@/types/events'

interface DashboardProps {
  metrics: MetricsSnapshot | null
  history: {
    getChartData: (metric: string) => Array<{ timestamp: number; value: number }>
    getSparklineData: (metric: string, count?: number) => number[]
  }
  events: GpuEvent[]
  requests: InferenceRequest[]
}

function HwCard({ title, subtitle, children }: { title?: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="bg-[#111115] rounded-lg border border-white/[0.04] px-3 pt-2.5 pb-2 flex flex-col transition-colors duration-200 hover:border-[#76B900]/10">
      {(title || subtitle) && (
        <div className="mb-1 min-h-[26px]">
          {title && <div className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">{title}</div>}
          {subtitle && <div className="text-[10px] text-zinc-600 truncate" title={subtitle}>{subtitle}</div>}
        </div>
      )}
      {children}
    </div>
  )
}

export function Dashboard({
  metrics,
  history,
  events,
  requests,
}: DashboardProps) {
  if (!metrics) return null

  const powerPercent = (metrics.gpu.power_watts !== null && metrics.gpu.power_limit_watts !== null && metrics.gpu.power_limit_watts > 0)
    ? (metrics.gpu.power_watts / metrics.gpu.power_limit_watts) * 100
    : 0

  const memUsedPercent = metrics.memory.total_bytes > 0
    ? (metrics.memory.used_bytes / metrics.memory.total_bytes) * 100
    : 0

  const gpuUsed = metrics.memory.gpu_estimated_bytes ?? 0
  const cpuUsed = Math.max(0, metrics.memory.used_bytes - gpuUsed)
  const cached = Math.min(metrics.memory.cached_bytes, metrics.memory.available_bytes)
  const free = Math.max(0, metrics.memory.available_bytes - cached)
  const totalGB = (metrics.memory.total_bytes / 1_000_000_000).toFixed(0)

  const memorySegments = [
    { value: gpuUsed, total: metrics.memory.total_bytes, color: 'bg-[#76B900]', label: `GPU: ${formatBytes(gpuUsed)}` },
    { value: cpuUsed, total: metrics.memory.total_bytes, color: 'bg-blue-500', label: `CPU: ${formatBytes(cpuUsed)}` },
    { value: cached, total: metrics.memory.total_bytes, color: 'bg-zinc-600', label: `Cache: ${formatBytes(cached)}` },
    { value: free, total: metrics.memory.total_bytes, color: 'bg-zinc-800', label: `Free: ${formatBytes(free)}` },
  ]

  const allEvents = events.map(e => ({
    timestamp: e.timestamp_ms, type: e.event_type, detail: e.detail,
  }))
  const requestSpans = requests.map(r => ({
    start: r.start_ms, end: r.end_ms, tps: r.tps, ttft: r.ttft_ms,
  }))

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-2">
      {/* ── LLM Engines — takes ~55% of viewport ── */}
      <div className="flex-[3] min-h-0">
        <EngineSection
          engines={metrics.engines}
          showCharts={true}
          getChartData={history.getChartData}
          requests={requests}
        />
      </div>

      {/* ── Hardware Overview — takes ~45% of viewport, 2 rows ── */}
      <div className="flex-[2] min-h-0 bg-[#0a0a0d]/80 rounded-xl border border-white/[0.03] p-2.5 flex flex-col">
        <h2 className="text-xs font-medium text-zinc-600 uppercase tracking-wider mb-1.5 shrink-0">Hardware</h2>
        <div className="flex-1 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-4 gap-1.5">

          {/* GPU Utilization */}
          <HwCard title="GPU Util" subtitle={metrics.gpu.name ?? undefined}>
            <div className="flex items-start gap-2 shrink-0">
              <ArcGauge value={metrics.gpu.utilization_percent ?? 0} label="GPU Util" unit="%" size={72} />
              <div className="flex-1 min-h-[60px]">
                <TimeSeriesChart data={history.getChartData('gpuUtil')} yDomain={[0, 100]} unit="%" events={allEvents} requests={requestSpans} height={72} />
              </div>
            </div>
          </HwCard>

          {/* GPU Temperature */}
          <HwCard title="GPU Temp" subtitle={metrics.gpu.name ?? undefined}>
            <div className="flex items-start gap-2 shrink-0">
              <ArcGauge value={metrics.gpu.temperature_celsius ?? 0} label="GPU Temp" unit="°C" thresholds={THRESHOLDS.gpuTemp} size={72} />
              <div className="flex-1 min-h-[60px]">
                <TimeSeriesChart data={history.getChartData('gpuTemp')} yDomain={[0, 100]} unit="°C" height={72} />
              </div>
            </div>
          </HwCard>

          {/* GPU Power */}
          <HwCard title="GPU Power" subtitle={metrics.gpu.name ?? undefined}>
            <div className="flex items-start gap-2 shrink-0">
              <ArcGauge
                value={powerPercent}
                label="GPU Power"
                unit="W"
                thresholds={THRESHOLDS.gpuPower}
                displayValue={metrics.gpu.power_watts !== null ? Math.round(metrics.gpu.power_watts) : 0}
                size={72}
              />
              <div className="flex-1 min-h-[60px]">
                <TimeSeriesChart data={history.getChartData('gpuPower')} unit="W" height={72} />
              </div>
            </div>
          </HwCard>

          {/* GPU Clock */}
          <HwCard title="GPU Clock" subtitle={metrics.gpu.name ?? undefined}>
            <div className="flex items-start gap-2 shrink-0">
              <div className="flex flex-col items-center justify-center w-[72px] h-[72px]">
                <span className="text-base font-bold text-zinc-100 font-mono">{formatMhz(metrics.gpu.clock_graphics_mhz)}</span>
              </div>
              <div className="flex-1 min-h-[60px]">
                <TimeSeriesChart data={history.getChartData('gpuClockGraphics')} unit="MHz" height={72} />
              </div>
            </div>
          </HwCard>

          {/* CPU */}
          <HwCard title="CPU" subtitle={metrics.cpu.name ?? undefined}>
            <div className="flex items-start gap-2 shrink-0">
              <ArcGauge value={metrics.cpu.aggregate_percent} label="CPU" unit="%" thresholds={THRESHOLDS.cpuUsage} size={72} />
              <div className="flex-1 min-h-[60px]">
                <TimeSeriesChart data={history.getChartData('cpuAggregate')} yDomain={[0, 100]} unit="%" height={72} />
              </div>
            </div>
            {metrics.cpu.per_core.length > 0 && <CoreHeatmap cores={metrics.cpu.per_core} />}
          </HwCard>

          {/* Memory */}
          <HwCard title="Memory" subtitle={`${totalGB} GB Unified`}>
            <div className="flex items-start gap-2 shrink-0">
              <ArcGauge value={memUsedPercent} label="Memory" unit="%" thresholds={THRESHOLDS.memoryUsage} size={72} />
              <div className="flex-1 min-w-0 flex flex-col gap-1">
                <div className="min-h-[60px]">
                  <TimeSeriesChart data={history.getChartData('memoryUsedPercent')} yDomain={[0, 100]} unit="%" height={72} />
                </div>
                <StackedBar segments={memorySegments} />
              </div>
            </div>
          </HwCard>

          {/* Disk I/O */}
          <HwCard title="Disk I/O" subtitle={metrics.disk.name ?? undefined}>
            <div className="flex items-start gap-2 shrink-0">
              <div className="flex flex-col items-center justify-center w-[72px] h-[72px] gap-0.5">
                <div className="flex items-baseline gap-1">
                  <span className="text-[10px] text-zinc-500">R</span>
                  <span className="text-sm font-bold text-zinc-100 font-mono">{formatRate(metrics.disk.read_bytes_per_sec)}</span>
                </div>
                <div className="flex items-baseline gap-1">
                  <span className="text-[10px] text-zinc-500">W</span>
                  <span className="text-sm font-bold text-zinc-100 font-mono">{formatRate(metrics.disk.write_bytes_per_sec)}</span>
                </div>
              </div>
              <div className="flex-1 min-h-[60px]">
                <TimeSeriesChart data={history.getChartData('diskRead')} unit="B/s" height={72} />
              </div>
            </div>
          </HwCard>

          {/* Network I/O */}
          <HwCard title="Network" subtitle={metrics.network.name ?? undefined}>
            <div className="flex items-start gap-2 shrink-0">
              <div className="flex flex-col items-center justify-center w-[72px] h-[72px] gap-0.5">
                <div className="flex items-baseline gap-1">
                  <span className="text-[10px] text-zinc-500">RX</span>
                  <span className="text-sm font-bold text-zinc-100 font-mono">{formatRate(metrics.network.rx_bytes_per_sec)}</span>
                </div>
                <div className="flex items-baseline gap-1">
                  <span className="text-[10px] text-zinc-500">TX</span>
                  <span className="text-sm font-bold text-zinc-100 font-mono">{formatRate(metrics.network.tx_bytes_per_sec)}</span>
                </div>
              </div>
              <div className="flex-1 min-h-[60px]">
                <TimeSeriesChart data={history.getChartData('networkRx')} unit="B/s" height={72} />
              </div>
            </div>
          </HwCard>

        </div>
      </div>
    </div>
  )
}
