import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart'
import { engineDisplayName, engineIconSrc, formatEndpoint, shortModelName } from '@/lib/format'
import { readEngineLabel } from '@/lib/engineLabelStore'
import { getProviderLogo } from '@/lib/providerLogo'
import { engineKey } from '@/lib/identity'
import type { DataPoint } from '@/lib/metricsHistoryStore'
import { EngineChip, ProviderMark } from './engineIdentity'
import type { EngineRowTarget } from './useEnginePanel'

/** What one row's pick supplies: the row's headline figure and its line. */
export interface MultiEngineRowValue {
  value: number | null
  /** The big number to show (defaults to `value` + `unit`). */
  displayValue?: string
  unit: string
  /** Names the metric beside the value, for a row that may show one of
   *  several (cache: KV versus prefix hit). */
  valueLabel?: string
  /** Replaces the row's `note` — e.g. a serving engine this panel has no
   *  number for. */
  note?: string
  /** Extra lines the row's chart wears beside the primary one, the way the
   *  single view wears avg and per-request beside live. */
  series?: { data: DataPoint[]; label: string; color: string }[]
  /** The figures the single view tiles beside the headline, kept on the row
   *  as one small line so a row reads like a card, not just a big number. */
  stats?: { label: string; value: string }[]
  yDomain?: [number, number]
  data: DataPoint[]
}

/**
 * The all-models body a panel renders for a page configured for every engine:
 * one labelled row per engine, each with its value and its own trend — the
 * engine counterpart of `MultiGpuPanelBody`. Rows (not columns) so a wide
 * panel gives every engine a full-width chart instead of N cramped
 * side-by-side ones. A row whose engine cannot serve numbers shows its reason
 * instead of a chart, so a starting engine reads as starting.
 */
export function MultiEnginePanelBody({
  rows,
  pick,
  seriesLabel,
}: {
  rows: EngineRowTarget[]
  pick: (row: EngineRowTarget) => MultiEngineRowValue
  seriesLabel: string
}) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-1.5 overflow-hidden">
      {rows.map((row) => {
        const value = pick(row)
        const display = value.displayValue ?? (value.value === null ? '—' : `${value.value}${value.unit}`)
        const note = value.note ?? row.note
        const { engine } = row
        const key = engineKey(engine)
        const label =
          readEngineLabel(key) ??
          (engine.model?.name ? shortModelName(engine.model.name) : null) ??
          engineDisplayName(engine.engine_type)
        const logo = getProviderLogo(engine.model?.name)

        return (
          <div key={key} className="flex min-h-0 min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5">
                {logo && <ProviderMark logo={logo} />}
                <EngineChip
                  label={engineDisplayName(engine.engine_type)}
                  iconSrc={engineIconSrc(engine.engine_type)}
                />
                <span
                  className="truncate text-[11px] font-medium text-zinc-400"
                  title={engine.model?.name ?? engine.endpoint}
                >
                  {label}
                </span>
                <span
                  className="truncate text-[10px] text-zinc-600"
                  title={engine.endpoint}
                >
                  {formatEndpoint(engine.endpoint)}
                </span>
              </span>
              <span className="shrink-0 text-sm font-semibold tabular-nums text-zinc-100">
                {value.valueLabel && (
                  <span className="mr-1 text-[10px] font-normal text-zinc-500">
                    {value.valueLabel}
                  </span>
                )}
                {display}
              </span>
            </div>
            {value.stats && value.stats.length > 0 && (
              <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 px-0.5 text-[10px] tabular-nums text-zinc-500">
                {value.stats.map((stat) => (
                  <span key={stat.label} className="whitespace-nowrap">
                    <span className="text-zinc-600">{stat.label}</span> {stat.value}
                  </span>
                ))}
              </div>
            )}
            <div className="min-h-0 min-w-0 flex-1">
              {note ? (
                <p className="px-1 text-[11px] leading-snug text-zinc-500">{note}</p>
              ) : value.series && value.series.length > 0 ? (
                <TimeSeriesChart
                  series={[
                    { data: value.data, label: seriesLabel, color: '#76B900' },
                    ...value.series,
                  ]}
                  unit={value.unit}
                  yDomain={value.yDomain}
                  hideTooltipLabel
                />
              ) : (
                <TimeSeriesChart
                  data={value.data}
                  unit={value.unit}
                  yDomain={value.yDomain}
                  seriesLabel={seriesLabel}
                  hideTooltipLabel
                />
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
