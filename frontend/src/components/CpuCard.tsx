import { MetricCard } from './MetricCard'
import { MetricRow } from './MetricRow'
import { ArcGauge } from './gauges/ArcGauge'
import { TimeSeriesChart } from './charts/TimeSeriesChart'
import { CoreHeatmap } from './charts/CoreHeatmap'
import { formatPercent } from '../lib/format'
import { THRESHOLDS } from '../lib/theme'
import type { CpuMetrics } from '../types/metrics'

interface ChartDataPoint {
  timestamp: number
  value: number
}

interface CpuCardProps {
  metrics: CpuMetrics | null
  chartData?: ChartDataPoint[]
  showCharts?: boolean
  showCores?: boolean
}

export function CpuCard({ metrics, chartData, showCharts = false, showCores = true }: CpuCardProps) {
  if (!metrics) return <MetricCard title="CPU"><p className="text-zinc-500">Waiting for data...</p></MetricCard>

  return (
    <MetricCard title="CPU" subtitle={metrics.name ?? undefined}>
      <div className="flex flex-col w-full">
        <div className="flex justify-center py-2">
          <ArcGauge
            value={metrics.aggregate_percent}
            label="CPU"
            unit="%"
            thresholds={THRESHOLDS.cpuUsage}
            size={100}
          />
        </div>

        {metrics.per_core.length > 0 && (
          <div className="mt-2 w-full">
            <CoreHeatmap cores={metrics.per_core} />
          </div>
        )}
      </div>

      {showCores && metrics.per_core.map((core) => (
        <MetricRow
          key={core.id}
          label={`Core ${core.id}`}
          value={formatPercent(core.usage_percent)}
        />
      ))}

      {showCharts && chartData && (
        <div className="mt-2">
          <TimeSeriesChart
            title="CPU Usage"
            data={chartData}
            yDomain={[0, 100]}
            unit="%"
          />
        </div>
      )}
    </MetricCard>
  )
}
