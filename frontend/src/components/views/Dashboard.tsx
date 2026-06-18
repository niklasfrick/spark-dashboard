import { ArcGauge, type GaugeSegment } from '@/components/gauges/ArcGauge'
import { HBar } from '@/components/gauges/HBar'
import { CoreHeatmap } from '@/components/charts/CoreHeatmap'
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart'
import { EngineSection } from '@/components/engines/EngineSection'
import { useElementSize } from '@/hooks/useElementSize'
import { THRESHOLDS } from '@/lib/theme'
import { formatBytes, formatGiB, formatMhz, formatRate } from '@/lib/format'
import { computePowerScale, powerPeak } from '@/lib/gpuPower'
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
    <div className="bg-[#111115] rounded-md sm:rounded-lg border border-white/[0.04] px-1.5 pt-1 pb-0.5 lg:px-2 lg:pt-1.5 lg:pb-1 2xl:px-2.5 2xl:pt-2 2xl:pb-1.5 flex flex-col min-h-0 min-w-0 overflow-hidden transition-colors duration-200 hover:border-[#76B900]/10">
      {(title || subtitle) && (
        <div className="mb-0.5 2xl:mb-1 flex items-baseline gap-1.5 min-w-0 shrink-0">
          {title && <span className="text-[10px] lg:text-[11px] 2xl:text-xs min-[1920px]:text-sm font-semibold text-zinc-200 tracking-tight shrink-0">{title}</span>}
          {title && subtitle && <span className="text-zinc-600 shrink-0 hidden lg:inline">·</span>}
          {subtitle && <span className="hidden lg:inline text-[10px] 2xl:text-[11px] min-[1920px]:text-xs text-zinc-400 truncate min-w-0" title={subtitle}>{subtitle}</span>}
        </div>
      )}
      {children}
    </div>
  )
}

/** Shared responsive height for hardware mini-charts and gauges.
 *  Aggressive lower bounds keep the heatmap and memory split visible on
 *  cramped screens (13" laptops); upper bounds let big monitors breathe. */
const HW_CHART_HEIGHT = 'clamp(28px, 7vh, 140px)'
const HW_GAUGE_PX = 'clamp(36px, 5vw, 96px)'

/** Number of hardware cards in the grid (used to estimate per-card height). */
const HW_CARD_COUNT = 8
/** Below this per-card height (px) the cards drop their line charts and swap
 *  square gauges for compact horizontal bars, so the dashboard stays a
 *  one-pager when vertical space is tight. */
const HW_COMPACT_HEIGHT_PX = 124
/** Below this dashboard-content height (px) the engine section drops its
 *  per-metric trend charts. The engine block is content-sized (shrink-0), so on
 *  short viewports its charts would otherwise crowd the hardware grid off-screen
 *  — hiding them frees the room the hardware cards need to stay visible. Keyed
 *  off the (viewport-driven, content-independent) root height so it cannot
 *  feedback-loop with the hardware per-card measurement below. */
const ENGINE_CHARTS_MIN_HEIGHT_PX = 640

export function Dashboard({
  metrics,
  history,
  events,
  requests,
}: DashboardProps) {
  if (!metrics) return null

  // No hardware power cap is exposed on the GB10 (unified-memory SoC), so scale
  // the gauge against the observed peak draw when the limit is absent.
  const powerHistory = history.getChartData('gpuPower')
  const powerPercent = computePowerScale(
    metrics.gpu.power_watts,
    metrics.gpu.power_limit_watts,
    powerPeak(powerHistory, metrics.gpu.power_watts),
  ).percent

  const memUsedPercent = metrics.memory.total_bytes > 0
    ? (metrics.memory.used_bytes / metrics.memory.total_bytes) * 100
    : 0

  const gpuUsed = metrics.memory.gpu_estimated_bytes ?? 0
  const cpuUsed = Math.max(0, metrics.memory.used_bytes - gpuUsed)
  const cached = Math.min(metrics.memory.cached_bytes, metrics.memory.available_bytes)
  const free = Math.max(0, metrics.memory.available_bytes - cached)
  const totalGB = formatGiB(metrics.memory.display_total_bytes ?? metrics.memory.total_bytes)

  const memorySegments: GaugeSegment[] = [
    { value: gpuUsed, total: metrics.memory.total_bytes, color: '#76B900', label: `GPU: ${formatBytes(gpuUsed)}` },
    { value: cpuUsed, total: metrics.memory.total_bytes, color: '#3B82F6', label: `CPU: ${formatBytes(cpuUsed)}` },
    { value: cached, total: metrics.memory.total_bytes, color: '#71717A', label: `Cache: ${formatBytes(cached)}` },
    { value: free, total: metrics.memory.total_bytes, color: '#27272A', label: `Free: ${formatBytes(free)}` },
  ]

  const allEvents = events.map(e => ({
    timestamp: e.timestamp_ms, type: e.event_type, detail: e.detail,
  }))
  const requestSpans = requests.map(r => ({
    start: r.start_ms, end: r.end_ms, tps: r.tps, ttft: r.ttft_ms,
  }))

  // Compute totals as sum of two series, aligned by timestamp.
  const sumSeries = (
    a: Array<{ timestamp: number; value: number }>,
    b: Array<{ timestamp: number; value: number }>,
  ): Array<{ timestamp: number; value: number }> => {
    const map = new Map<number, number>()
    for (const p of a) map.set(p.timestamp, p.value)
    for (const p of b) map.set(p.timestamp, (map.get(p.timestamp) ?? 0) + p.value)
    return Array.from(map.entries())
      .sort((x, y) => x[0] - y[0])
      .map(([timestamp, value]) => ({ timestamp, value }))
  }

  const diskRead = history.getChartData('diskRead')
  const diskWrite = history.getChartData('diskWrite')
  const diskTotal = sumSeries(diskRead, diskWrite)
  const networkRx = history.getChartData('networkRx')
  const networkTx = history.getChartData('networkTx')
  const networkTotal = sumSeries(networkRx, networkTx)

  const DISK_READ_COLOR = '#76B900'
  const DISK_WRITE_COLOR = '#F59E0B'
  const TOTAL_COLOR = '#A1A1AA'
  const NET_RX_COLOR = '#3B82F6'
  const NET_TX_COLOR = '#A855F7'

  // Measure the hardware grid to adapt to available *vertical* space. The grid
  // uses auto-rows-fr, so per-card height depends only on the container height
  // and the column count (2 below the `sm` breakpoint, 4 at/above it) — not on
  // card content, which keeps this free of layout feedback loops. `compact`
  // stays false until measured (height 0) so the full layout renders first.
  const [hwGridRef, hwGridSize] = useElementSize<HTMLDivElement>()
  const hwCols = hwGridSize.width >= 640 ? 4 : 2
  const hwRows = Math.ceil(HW_CARD_COUNT / hwCols)
  const perCardHeight =
    hwGridSize.height > 0 ? (hwGridSize.height - (hwRows - 1) * 6) / hwRows : 0
  const compact = perCardHeight > 0 && perCardHeight < HW_COMPACT_HEIGHT_PX

  // Engine trend charts collapse on short viewports (see constant). Default to
  // showing them until the root is measured (height 0).
  const [rootRef, rootSize] = useElementSize<HTMLDivElement>()
  const showEngineCharts = rootSize.height === 0 || rootSize.height >= ENGINE_CHARTS_MIN_HEIGHT_PX

  return (
    <div ref={rootRef} className="flex flex-col flex-1 min-h-0 gap-2">
      {/* ── LLM Engines — auto-height, fits content; hardware fills remainder ── */}
      <div className="shrink-0 min-h-0">
        <EngineSection
          engines={metrics.engines}
          showCharts={showEngineCharts}
          getChartData={history.getChartData}
          requests={requests}
        />
      </div>

      {/* ── Hardware Overview — fills the rest of the viewport ── */}
      <div className="flex-1 min-h-0 bg-[#0a0a0d]/80 rounded-xl border border-white/[0.03] p-1 lg:p-1.5 2xl:p-2 flex flex-col">
        <div ref={hwGridRef} className="flex-1 min-h-0 grid grid-cols-2 sm:grid-cols-4 gap-1 lg:gap-1.5 auto-rows-fr">

          {/* GPU Utilization */}
          <HwCard title="GPU Utilization" subtitle={metrics.gpu.name ?? undefined}>
            {compact ? (
              <HBar value={metrics.gpu.utilization_percent ?? 0} label="GPU Util" unit="%" />
            ) : (
              <div className="flex items-center gap-2 min-w-0 min-h-0 flex-1 overflow-hidden">
                <ArcGauge value={metrics.gpu.utilization_percent ?? 0} label="GPU Util" unit="%" size={HW_GAUGE_PX} />
                <div className="flex-1 min-w-0">
                  <TimeSeriesChart data={history.getChartData('gpuUtil')} yDomain={[0, 100]} unit="%" events={allEvents} requests={requestSpans} height={HW_CHART_HEIGHT} />
                </div>
              </div>
            )}
          </HwCard>

          {/* GPU Temperature */}
          <HwCard title="GPU Temp" subtitle={metrics.gpu.name ?? undefined}>
            {compact ? (
              <HBar value={metrics.gpu.temperature_celsius ?? 0} label="GPU Temp" unit="°C" thresholds={THRESHOLDS.gpuTemp} />
            ) : (
              <div className="flex items-center gap-2 min-w-0 min-h-0 flex-1 overflow-hidden">
                <ArcGauge value={metrics.gpu.temperature_celsius ?? 0} label="GPU Temp" unit="°C" thresholds={THRESHOLDS.gpuTemp} size={HW_GAUGE_PX} />
                <div className="flex-1 min-w-0">
                  <TimeSeriesChart data={history.getChartData('gpuTemp')} yDomain={[0, 100]} unit="°C" height={HW_CHART_HEIGHT} />
                </div>
              </div>
            )}
          </HwCard>

          {/* GPU Power */}
          <HwCard title="GPU Power" subtitle={metrics.gpu.name ?? undefined}>
            {compact ? (
              <HBar
                value={powerPercent}
                label="GPU Power"
                unit="W"
                thresholds={THRESHOLDS.gpuPower}
                displayValue={metrics.gpu.power_watts !== null ? Math.round(metrics.gpu.power_watts) : 0}
              />
            ) : (
              <div className="flex items-center gap-2 min-w-0 min-h-0 flex-1 overflow-hidden">
                <ArcGauge
                  value={powerPercent}
                  label="GPU Power"
                  unit="W"
                  thresholds={THRESHOLDS.gpuPower}
                  displayValue={metrics.gpu.power_watts !== null ? Math.round(metrics.gpu.power_watts) : 0}
                  size={HW_GAUGE_PX}
                />
                <div className="flex-1 min-w-0">
                  <TimeSeriesChart data={history.getChartData('gpuPower')} unit="W" height={HW_CHART_HEIGHT} />
                </div>
              </div>
            )}
          </HwCard>

          {/* GPU Clock */}
          <HwCard title="GPU Clock" subtitle={metrics.gpu.name ?? undefined}>
            {compact ? (
              <div className="flex items-baseline justify-between gap-2 min-w-0">
                <span className="text-[9px] lg:text-[10px] text-zinc-400 uppercase tracking-wider truncate">Graphics</span>
                <span className="ml-auto shrink-0 text-xs lg:text-sm 2xl:text-base font-bold text-zinc-100 font-mono tabular-nums">{formatMhz(metrics.gpu.clock_graphics_mhz)}</span>
              </div>
            ) : (
              <div className="flex items-center gap-2 min-w-0 min-h-0 flex-1 overflow-hidden">
                <div className="flex flex-col items-center justify-center shrink-0" style={{ width: HW_GAUGE_PX, height: HW_GAUGE_PX }}>
                  <span className="text-sm 2xl:text-base min-[1920px]:text-lg font-bold text-zinc-100 font-mono">{formatMhz(metrics.gpu.clock_graphics_mhz)}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <TimeSeriesChart data={history.getChartData('gpuClockGraphics')} unit="MHz" height={HW_CHART_HEIGHT} />
                </div>
              </div>
            )}
          </HwCard>

          {/* CPU */}
          <HwCard title="CPU" subtitle={metrics.cpu.name ?? undefined}>
            {compact ? (
              <HBar value={metrics.cpu.aggregate_percent} label="CPU" unit="%" thresholds={THRESHOLDS.cpuUsage} />
            ) : (
              <div className="flex items-center gap-2 min-w-0 min-h-0 flex-1 overflow-hidden">
                <ArcGauge value={metrics.cpu.aggregate_percent} label="CPU" unit="%" thresholds={THRESHOLDS.cpuUsage} size={HW_GAUGE_PX} />
                <div className="flex-1 min-w-0">
                  <TimeSeriesChart data={history.getChartData('cpuAggregate')} yDomain={[0, 100]} unit="%" height={HW_CHART_HEIGHT} />
                </div>
              </div>
            )}
            {!compact && metrics.cpu.per_core.length > 0 && <CoreHeatmap cores={metrics.cpu.per_core} />}
          </HwCard>

          {/* Memory */}
          <HwCard title="Memory" subtitle={`${totalGB} Unified`}>
            {compact ? (
              <HBar value={memUsedPercent} label="" unit="%" segments={memorySegments} />
            ) : (
              <div className="flex items-center justify-center min-h-0 flex-1 overflow-hidden">
                <ArcGauge value={memUsedPercent} label="" unit="%" segments={memorySegments} size={HW_GAUGE_PX} />
              </div>
            )}
          </HwCard>

          {/* Disk I/O */}
          <HwCard title="Disk I/O" subtitle={metrics.disk.name ?? undefined}>
            {compact ? (
              <div className="flex items-baseline justify-between gap-2 min-w-0 font-mono">
                <span className="flex items-baseline gap-1 min-w-0">
                  <span className="text-[9px] lg:text-[10px] text-zinc-500">R</span>
                  <span className="text-xs lg:text-sm font-bold text-zinc-100 tabular-nums truncate">{formatRate(metrics.disk.read_bytes_per_sec)}</span>
                </span>
                <span className="flex items-baseline gap-1 min-w-0">
                  <span className="text-[9px] lg:text-[10px] text-zinc-500">W</span>
                  <span className="text-xs lg:text-sm font-bold text-zinc-100 tabular-nums truncate">{formatRate(metrics.disk.write_bytes_per_sec)}</span>
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2 min-w-0 min-h-0 flex-1 overflow-hidden">
                <div className="flex flex-col items-center justify-center gap-0.5 shrink-0" style={{ width: HW_GAUGE_PX, height: HW_GAUGE_PX }}>
                  <div className="flex items-baseline gap-1">
                    <span className="text-[9px] 2xl:text-[10px] min-[1920px]:text-xs text-zinc-500">R</span>
                    <span className="text-xs 2xl:text-sm min-[1920px]:text-base font-bold text-zinc-100 font-mono">{formatRate(metrics.disk.read_bytes_per_sec)}</span>
                  </div>
                  <div className="flex items-baseline gap-1">
                    <span className="text-[9px] 2xl:text-[10px] min-[1920px]:text-xs text-zinc-500">W</span>
                    <span className="text-xs 2xl:text-sm min-[1920px]:text-base font-bold text-zinc-100 font-mono">{formatRate(metrics.disk.write_bytes_per_sec)}</span>
                  </div>
                </div>
                <div className="flex-1 min-w-0">
                  <TimeSeriesChart
                    series={[
                      { data: diskTotal, label: 'Total', color: TOTAL_COLOR },
                      { data: diskRead, label: 'Read', color: DISK_READ_COLOR },
                      { data: diskWrite, label: 'Write', color: DISK_WRITE_COLOR },
                    ]}
                    unit="B/s"
                    height={HW_CHART_HEIGHT}
                  />
                </div>
              </div>
            )}
          </HwCard>

          {/* Network I/O */}
          <HwCard title="Network" subtitle={metrics.network.name ?? undefined}>
            {compact ? (
              <div className="flex items-baseline justify-between gap-2 min-w-0 font-mono">
                <span className="flex items-baseline gap-1 min-w-0">
                  <span className="text-[9px] lg:text-[10px] text-zinc-500">RX</span>
                  <span className="text-xs lg:text-sm font-bold text-zinc-100 tabular-nums truncate">{formatRate(metrics.network.rx_bytes_per_sec)}</span>
                </span>
                <span className="flex items-baseline gap-1 min-w-0">
                  <span className="text-[9px] lg:text-[10px] text-zinc-500">TX</span>
                  <span className="text-xs lg:text-sm font-bold text-zinc-100 tabular-nums truncate">{formatRate(metrics.network.tx_bytes_per_sec)}</span>
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2 min-w-0 min-h-0 flex-1 overflow-hidden">
                <div className="flex flex-col items-center justify-center gap-0.5 shrink-0" style={{ width: HW_GAUGE_PX, height: HW_GAUGE_PX }}>
                  <div className="flex items-baseline gap-1">
                    <span className="text-[9px] 2xl:text-[10px] min-[1920px]:text-xs text-zinc-500">RX</span>
                    <span className="text-xs 2xl:text-sm min-[1920px]:text-base font-bold text-zinc-100 font-mono">{formatRate(metrics.network.rx_bytes_per_sec)}</span>
                  </div>
                  <div className="flex items-baseline gap-1">
                    <span className="text-[9px] 2xl:text-[10px] min-[1920px]:text-xs text-zinc-500">TX</span>
                    <span className="text-xs 2xl:text-sm min-[1920px]:text-base font-bold text-zinc-100 font-mono">{formatRate(metrics.network.tx_bytes_per_sec)}</span>
                  </div>
                </div>
                <div className="flex-1 min-w-0">
                  <TimeSeriesChart
                    series={[
                      { data: networkTotal, label: 'Total', color: TOTAL_COLOR },
                      { data: networkRx, label: 'RX', color: NET_RX_COLOR },
                      { data: networkTx, label: 'TX', color: NET_TX_COLOR },
                    ]}
                    unit="B/s"
                    height={HW_CHART_HEIGHT}
                  />
                </div>
              </div>
            )}
          </HwCard>

        </div>
      </div>
    </div>
  )
}
