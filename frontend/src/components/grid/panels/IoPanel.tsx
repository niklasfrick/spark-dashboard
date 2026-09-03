import { MetricRow } from '@/components/MetricRow'
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart'
import { formatRate } from '@/lib/format'
import { sumSeries } from '@/lib/series'
import type { DataPoint } from '@/lib/metricsHistoryStore'
import { HardwarePanelBody } from './HardwarePanelBody'
import { PanelNotice } from './PanelNotice'

/** Chart color of the summed line on both I/O panels. */
const TOTAL_COLOR = '#A1A1AA'

interface IoDirection {
  /** The short tag in front of the rate: R, W, RX, TX. */
  tag: string
  /** The chart legend name: Read, Write, RX, TX. */
  label: string
  color: string
  /** Current rate in bytes/sec, or null before the first snapshot. */
  rate: number | null
  data: DataPoint[]
}

/**
 * The shape disk and network I/O share: two directional rates as the current
 * value, and a three-line chart (each direction plus their sum) as the trend.
 */
export function IoPanel({
  device,
  inbound,
  outbound,
}: {
  /** The disk or interface these rates were read from. */
  device?: string | null
  inbound: IoDirection
  outbound: IoDirection
}) {
  // Narrowed into locals: the guard's narrowing does not reach the render
  // callbacks below.
  const inRate = inbound.rate
  const outRate = outbound.rate
  if (inRate === null || outRate === null) {
    return <PanelNotice>Waiting for metrics</PanelNotice>
  }

  const chart = (
    <TimeSeriesChart
      series={[
        { data: sumSeries(inbound.data, outbound.data), label: 'Total', color: TOTAL_COLOR },
        { data: inbound.data, label: inbound.label, color: inbound.color },
        { data: outbound.data, label: outbound.label, color: outbound.color },
      ]}
      unit="B/s"
    />
  )

  return (
    <HardwarePanelBody
      device={device}
      compact={
        <div className="flex flex-col gap-0.5 min-w-0">
          <MetricRow label={inbound.tag} value={formatRate(inRate)} />
          <MetricRow label={outbound.tag} value={formatRate(outRate)} />
        </div>
      }
      gauge={(sizePx) => (
        <div
          className="flex flex-col items-center justify-center gap-0.5 shrink-0"
          style={{ width: sizePx, height: sizePx }}
        >
          <Rate tag={inbound.tag} rate={inRate} />
          <Rate tag={outbound.tag} rate={outRate} />
        </div>
      )}
      chart={chart}
    />
  )
}

function Rate({ tag, rate }: { tag: string; rate: number }) {
  return (
    <span className="flex items-baseline gap-1 min-w-0">
      <span className="text-[9px] lg:text-[10px] text-zinc-500">{tag}</span>
      <span className="text-xs lg:text-sm font-bold text-zinc-100 font-mono tabular-nums truncate">
        {formatRate(rate)}
      </span>
    </span>
  )
}
