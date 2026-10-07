import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart'
import { shortGpuName } from '@/lib/format'
import type { DataPoint } from '@/lib/metricsHistoryStore'

export interface MultiGpuColumn {
  index: number
  name: string | null
  /** The inference engine(s) observed running on this GPU, by display name. */
  engines: string[]
  /** The headline value, or null when this GPU reports none for the metric. */
  value: number | null
  /** The big number to show (defaults to `value` + `unit`). */
  displayValue?: string
  unit: string
  yDomain?: [number, number]
  data: DataPoint[]
}

/**
 * The all-GPUs body a multi-GPU host renders for a `follow` GPU panel: one
 * labelled row per GPU, each with its value and its own trend. Rows (not
 * columns) so a wide panel gives every GPU a full-width chart instead of N
 * cramped side-by-side ones. The division is by the number of GPUs the host
 * reports — a single-GPU host never reaches this rendering (it resolves to one
 * GPU instead).
 */
export function MultiGpuPanelBody({
  columns,
  seriesLabel,
}: {
  columns: MultiGpuColumn[]
  seriesLabel: string
}) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-1.5 overflow-hidden">
      {columns.map((c) => {
        const display =
          c.displayValue ?? (c.value === null ? '—' : `${c.value}${c.unit}`)
        return (
          <div key={c.index} className="flex min-h-0 min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="shrink-0 text-[11px] font-medium text-zinc-400">
                  GPU {c.index}
                </span>
                {c.engines.length > 0 && (
                  <span className="truncate text-[11px] text-amber-300/80" title={c.engines.join(', ')}>
                    {c.engines.join(', ')}
                  </span>
                )}
                {c.name && (
                  <span className="truncate text-[10px] text-zinc-600" title={c.name}>
                    {shortGpuName(c.name)}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-sm font-semibold tabular-nums text-zinc-100">
                {display}
              </span>
            </div>
            <div className="min-h-0 min-w-0 flex-1">
              <TimeSeriesChart
                data={c.data}
                unit={c.unit}
                yDomain={c.yDomain}
                seriesLabel={seriesLabel}
                hideTooltipLabel
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
