import { GpuCard } from '@/components/GpuCard'
import { CpuCard } from '@/components/CpuCard'
import { MemoryCard } from '@/components/MemoryCard'
import { EngineSection } from '@/components/engines/EngineSection'
import { SystemCard } from '@/components/SystemCard'
import { TimeWindowSelector } from '@/components/charts/TimeWindowSelector'
import { formatRate } from '@/lib/format'
import type { MetricsSnapshot } from '@/types/metrics'
import type { GpuEvent, InferenceRequest, TimeWindow } from '@/types/events'

interface DetailedViewProps {
  metrics: MetricsSnapshot | null
  history: {
    getChartData: (metric: string) => Array<{ timestamp: number; value: number }>
    getSparklineData: (metric: string, count?: number) => number[]
  }
  timeWindow: TimeWindow
  onTimeWindowChange: (w: TimeWindow) => void
  events: GpuEvent[]
  requests: InferenceRequest[]
}

export function DetailedView({
  metrics,
  history,
  timeWindow,
  onTimeWindowChange,
  events,
  requests,
}: DetailedViewProps) {
  if (!metrics) return null

  const diskRows = [
    { label: 'Read', value: formatRate(metrics.disk.read_bytes_per_sec) },
    { label: 'Write', value: formatRate(metrics.disk.write_bytes_per_sec) },
  ]

  const networkRows = [
    { label: 'RX', value: formatRate(metrics.network.rx_bytes_per_sec) },
    { label: 'TX', value: formatRate(metrics.network.tx_bytes_per_sec) },
  ]

  return (
    <div className="space-y-6">
      {/* Time Window Selector */}
      <div className="flex justify-end">
        <TimeWindowSelector value={timeWindow} onChange={onTimeWindowChange} />
      </div>

      {/* Row 1: GPU gauges + GPU charts in 3-col grid */}
      <GpuCard
        metrics={metrics.gpu}
        showCharts={true}
        chartData={{
          utilization: history.getChartData('gpuUtil'),
          temperature: history.getChartData('gpuTemp'),
          power: history.getChartData('gpuPower'),
          clockGraphics: history.getChartData('gpuClockGraphics'),
        }}
        events={events}
        requests={requests}
      />

      {/* Row 2: CPU, Memory, System side by side */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <CpuCard
          metrics={metrics.cpu}
          showCharts={true}
          chartData={history.getChartData('cpuAggregate')}
          showCores={false}
        />
        <MemoryCard
          metrics={metrics.memory}
          gaugeSize={100}
        />
        <div className="grid grid-rows-2 gap-4">
          <SystemCard
            title="Disk I/O"
            subtitle={metrics.disk.name ?? undefined}
            rows={diskRows}
            showCharts={true}
            chartData={history.getChartData('diskRead')}
          />
          <SystemCard
            title="Network I/O"
            subtitle={metrics.network.name ?? undefined}
            rows={networkRows}
            showCharts={true}
            chartData={history.getChartData('networkRx')}
          />
        </div>
      </div>

      {/* Row 3: Engine Section */}
      <EngineSection
        engines={metrics.engines}
        showCharts={true}
        getChartData={history.getChartData}
        requests={requests}
      />
    </div>
  )
}
