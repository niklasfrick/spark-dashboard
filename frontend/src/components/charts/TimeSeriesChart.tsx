import React from 'react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
  ReferenceArea,
} from 'recharts'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'
import { NVIDIA_THEME } from '@/lib/theme'

interface DataPoint {
  timestamp: number
  value: number
}

export interface ChartSeries {
  data: DataPoint[]
  label: string
  color: string
  /**
   * Axis to plot the series against. Defaults to "left". Set "right" on
   * series with a different magnitude (e.g. ITL ~10ms vs TTFT ~300ms) so
   * each line gets its own y-scale and small variations stay visible.
   */
  axis?: 'left' | 'right'
}

interface TimeSeriesChartProps {
  /** Single-line mode (backward compat) */
  data?: DataPoint[]
  color?: string
  /** Multi-line mode — when provided, `data` and `color` are ignored */
  series?: ChartSeries[]
  events?: Array<{ timestamp: number; type: string; detail: string }>
  requests?: Array<{ start: number; end: number; tps: number; ttft: number }>
  yDomain?: [number, number]
  unit?: string
  height?: number
  title?: string
}

function formatTime(timestamp: number): string {
  const d = new Date(timestamp)
  return d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

function eventStrokeColor(type: string): string {
  if (type === 'thermal' || type === 'xid') return NVIDIA_THEME.critical
  return NVIDIA_THEME.warning
}

// Pad data to a fixed number of points so the SVG path always has the same
// number of commands, enabling smooth CSS `d` transitions between frames.
const CHART_POINTS = 60

function padData(data: DataPoint[]): DataPoint[] {
  if (data.length === 0) return []
  if (data.length >= CHART_POINTS) return data.slice(-CHART_POINTS)

  const first = data[0]
  const interval = data.length > 1 ? data[1].timestamp - data[0].timestamp : 1000
  const padding = Array.from(
    { length: CHART_POINTS - data.length },
    (_, i) => ({
      timestamp: first.timestamp - (CHART_POINTS - data.length - i) * interval,
      value: first.value,
    }),
  )
  return [...padding, ...data]
}

/**
 * Merge multiple series into a single array keyed by timestamp.
 * Each entry has `timestamp` plus one field per series index: `s0`, `s1`, ...
 */
function mergeSeries(
  seriesList: ChartSeries[],
): Array<Record<string, number>> {
  // Pad each series individually
  const paddedAll = seriesList.map((s) => padData(s.data))

  // Build a map of timestamp → merged row
  const map = new Map<number, Record<string, number>>()
  for (let si = 0; si < paddedAll.length; si++) {
    for (const pt of paddedAll[si]) {
      let row = map.get(pt.timestamp)
      if (!row) {
        row = { timestamp: pt.timestamp }
        map.set(pt.timestamp, row)
      }
      row[`s${si}`] = pt.value
    }
  }

  return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp)
}

export const TimeSeriesChart = React.memo(function TimeSeriesChart({
  data,
  series,
  events,
  requests,
  color,
  yDomain,
  unit,
  height = 160,
  title,
}: TimeSeriesChartProps) {
  const isMulti = series && series.length > 0

  // Build chart config and data depending on mode
  let chartData: Array<Record<string, number>>
  let chartConfig: Record<string, { label: string; color: string }>
  let lineKeys: Array<{ key: string; color: string; axis: 'left' | 'right' }>

  if (isMulti) {
    chartData = mergeSeries(series)
    chartConfig = {}
    lineKeys = []
    for (let i = 0; i < series.length; i++) {
      const key = `s${i}`
      chartConfig[key] = { label: series[i].label, color: series[i].color }
      lineKeys.push({ key, color: series[i].color, axis: series[i].axis ?? 'left' })
    }
  } else {
    const lineColor = color ?? NVIDIA_THEME.chartLine
    const paddedData = padData(data ?? [])
    chartData = paddedData.map((d) => ({ timestamp: d.timestamp, value: d.value }))
    chartConfig = { value: { label: unit ?? '', color: lineColor } }
    lineKeys = [{ key: 'value', color: lineColor, axis: 'left' }]
  }
  const hasRightAxis = lineKeys.some((l) => l.axis === 'right')

  return (
    <div>
      {/* Reserve a fixed header band so charts with wrapping multi-series
          legends (Prefill / Decode / Latency) line up with single-title
          charts (KV / E2E) along the bottom. */}
      <div className="flex items-start gap-4 mb-1 flex-wrap min-h-[2.25rem]">
        {title && (
          <h3 className="text-xs font-medium text-zinc-500">{title}</h3>
        )}
        {isMulti && (
          <div className="flex items-center gap-3 flex-wrap">
            {series.map((s, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <span
                  className="inline-block w-2.5 h-[2px] rounded-full"
                  style={{ backgroundColor: s.color }}
                />
                <span className="text-[11px] text-zinc-500">{s.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <ChartContainer config={chartConfig} style={{ height: `${height}px` }} className="w-full">
        <LineChart data={chartData}>
          <CartesianGrid
            stroke={NVIDIA_THEME.chartGrid}
            strokeDasharray="3 3"
            vertical={false}
          />
          <XAxis
            dataKey="timestamp"
            stroke={NVIDIA_THEME.chartAxis}
            fontSize={11}
            tickLine={false}
            axisLine={false}
            tickFormatter={formatTime}
            minTickGap={60}
          />
          <YAxis
            yAxisId="left"
            stroke={NVIDIA_THEME.chartAxis}
            fontSize={11}
            tickLine={false}
            axisLine={false}
            domain={yDomain}
          />
          {hasRightAxis && (
            <YAxis
              yAxisId="right"
              orientation="right"
              stroke={NVIDIA_THEME.chartAxis}
              fontSize={11}
              tickLine={false}
              axisLine={false}
            />
          )}
          <ChartTooltip content={<ChartTooltipContent />} />
          {requests?.map((req, i) => (
            <ReferenceArea
              key={`req-${i}`}
              yAxisId="left"
              x1={req.start}
              x2={req.end}
              fill={NVIDIA_THEME.accent}
              fillOpacity={0.15}
            />
          ))}
          {events?.map((evt, i) => (
            <ReferenceLine
              key={`evt-${i}`}
              yAxisId="left"
              x={evt.timestamp}
              stroke={eventStrokeColor(evt.type)}
              strokeDasharray="4 4"
              strokeWidth={2}
              label={{
                value: evt.type.charAt(0).toUpperCase(),
                position: 'top',
                fill: '#fafafa',
                fontSize: 10,
              }}
            />
          ))}
          {lineKeys.map(({ key, color: c, axis }) => (
            <Line
              key={key}
              yAxisId={axis}
              type="monotone"
              dataKey={key}
              stroke={c}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
              connectNulls
            />
          ))}
        </LineChart>
      </ChartContainer>
    </div>
  )
})
