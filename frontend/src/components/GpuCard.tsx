import { MetricCard } from './MetricCard'
import { MetricRow } from './MetricRow'
import { ArcGauge } from './gauges/ArcGauge'
import { TimeSeriesChart } from './charts/TimeSeriesChart'
import { formatPercent, formatPower, formatMhz } from '../lib/format'
import { THRESHOLDS } from '../lib/theme'
import type { GpuMetrics } from '../types/metrics'
import type { GpuEvent, InferenceRequest } from '../types/events'

interface ChartDataPoint {
  timestamp: number
  value: number
}

interface GpuCardProps {
  metrics: GpuMetrics | null
  chartData?: {
    utilization: ChartDataPoint[]
    temperature: ChartDataPoint[]
    power: ChartDataPoint[]
    clockGraphics: ChartDataPoint[]
  }
  events?: GpuEvent[]
  requests?: InferenceRequest[]
  showCharts?: boolean
}

export function GpuCard({ metrics, chartData, events, requests, showCharts = false }: GpuCardProps) {
  if (!metrics) return <MetricCard title="GPU"><p className="text-zinc-500">Waiting for data...</p></MetricCard>

  const powerPercent = (metrics.power_watts !== null && metrics.power_limit_watts !== null && metrics.power_limit_watts > 0)
    ? (metrics.power_watts / metrics.power_limit_watts) * 100
    : 0

  // Map events for chart overlays
  const thermalEvents = events?.filter(e => e.event_type === 'thermal').map(e => ({
    timestamp: e.timestamp_ms, type: e.event_type, detail: e.detail,
  }))
  const throttleEvents = events?.filter(e => ['throttle', 'power_brake'].includes(e.event_type)).map(e => ({
    timestamp: e.timestamp_ms, type: e.event_type, detail: e.detail,
  }))
  const allEvents = events?.map(e => ({
    timestamp: e.timestamp_ms, type: e.event_type, detail: e.detail,
  }))
  const requestSpans = requests?.map(r => ({
    start: r.start_ms, end: r.end_ms, tps: r.tps, ttft: r.ttft_ms,
  }))

  return (
    <MetricCard title="GPU" subtitle={metrics.name ?? undefined}>
      {/* Compact layout: gauges left, key metrics right */}
      <div className="flex flex-wrap items-start gap-6">
        <div className="flex flex-wrap justify-center gap-4">
          <ArcGauge
            value={metrics.utilization_percent ?? 0}
            label="Util"
            unit="%"
            size={100}
          />
          <ArcGauge
            value={metrics.temperature_celsius ?? 0}
            label="Temp"
            unit="C"
            thresholds={THRESHOLDS.gpuTemp}
            size={100}
          />
          <ArcGauge
            value={powerPercent}
            label="Power"
            unit="W"
            thresholds={THRESHOLDS.gpuPower}
            displayValue={metrics.power_watts !== null ? Math.round(metrics.power_watts) : 0}
            size={100}
          />
        </div>
        <div className="flex-1 min-w-[200px] grid grid-cols-2 gap-x-6 gap-y-0 text-sm">
          <MetricRow label="Power" value={formatPower(metrics.power_watts, metrics.power_limit_watts)} />
          <MetricRow label="Clock (Graphics)" value={formatMhz(metrics.clock_graphics_mhz)} />
          <MetricRow label="Clock (SM)" value={formatMhz(metrics.clock_sm_mhz)} />
          <MetricRow label="Clock (Memory)" value={formatMhz(metrics.clock_memory_mhz)} />
          <MetricRow
            label="Fan Speed"
            value={formatPercent(metrics.fan_speed_percent)}
            tooltip="Fan speed is chassis-managed and not exposed via NVML on DGX Spark."
          />
        </div>
      </div>

      {/* Charts: 3-column grid with titles */}
      {showCharts && chartData && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 mt-4">
          <TimeSeriesChart
            title="Utilization"
            data={chartData.utilization}
            yDomain={[0, 100]}
            unit="%"
            events={allEvents}
            requests={requestSpans}
          />
          <TimeSeriesChart
            title="Temperature"
            data={chartData.temperature}
            yDomain={[0, 100]}
            unit="°C"
            events={thermalEvents}
          />
          <TimeSeriesChart
            title="Power"
            data={chartData.power}
            unit="W"
            events={throttleEvents}
          />
          <TimeSeriesChart
            title="Clock (Graphics)"
            data={chartData.clockGraphics}
            unit="MHz"
            events={events?.filter(e => e.event_type === 'throttle').map(e => ({
              timestamp: e.timestamp_ms, type: e.event_type, detail: e.detail,
            }))}
          />
        </div>
      )}
    </MetricCard>
  )
}
