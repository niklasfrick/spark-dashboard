import { MetricCard } from './MetricCard'
import { MetricRow } from './MetricRow'
import { TimeSeriesChart } from './charts/TimeSeriesChart'

interface ChartDataPoint {
  timestamp: number
  value: number
}

export function SystemCard({
  title,
  subtitle,
  rows,
  chartData,
  showCharts = false,
}: {
  title: string
  subtitle?: string
  rows: Array<{ label: string; value: string }>
  chartData?: ChartDataPoint[]
  showCharts?: boolean
}) {
  return (
    <MetricCard title={title} subtitle={subtitle}>
      {rows.map((row, i) => (
        <MetricRow key={i} label={row.label} value={row.value} />
      ))}
      {showCharts && chartData && (
        <div className="mt-2">
          <TimeSeriesChart title={title} data={chartData} />
        </div>
      )}
    </MetricCard>
  )
}
