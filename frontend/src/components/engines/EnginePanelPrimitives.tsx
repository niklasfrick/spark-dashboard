/**
 * The tiles every engine panel is built from — a labelled number, a pair of
 * them, a goodput percentage.
 *
 * Nothing here picks a font size in pixels. Every size is an `em` of the tile
 * block's base, which `EnginePanelBody` sets from the panel's measured box (see
 * `engineTileScale`). That is what makes the same tile legible in a 2×1 cell
 * and worth the space in a 6×4 one; sizes keyed to viewport breakpoints, which
 * is what these used to be, only ever described the display.
 */

import { formatCompactTokens, formatAcceptanceLength, fmtVal, NOT_REPORTED } from '@/lib/format'
import type { Trend } from '@/lib/engineStats'
import { AnimatedCounter } from './AnimatedCounter'

/** The tile's own layout: centred in whatever row height the grid gave it, so
 *  a panel with room to spare spreads its rows instead of stacking them at the
 *  top under a block of empty box. */
const TILE = 'flex flex-col justify-center gap-[0.15em] min-w-0'

/**
 * The label above a value. An em like everything else — a px floor here would
 * buy a readable label by making the row taller than `ROW_EM` says it is, which
 * the panel pays for by clipping a row it was told would fit. The base's own
 * floor is what keeps this legible.
 */
const LABEL = 'text-[0.8em] font-medium uppercase tracking-wider truncate'

/** A headline number. `leading-none` keeps the row height predictable, which is
 *  what `ROW_EM` in `mode.ts` counts on. */
const VALUE = 'text-[1.7em] font-bold font-mono tabular-nums leading-none'

/** The unit after a value, and the trend arrow beside it. */
const UNIT = 'text-[0.72em] ml-[0.35em] text-zinc-500'

/**
 * The grid a panel lays its tiles out on: add the column count.
 *
 * The gap is in the same ems as everything else, so a row costs the same
 * fraction of the box at every scale. Rows share the height evenly — that is
 * what spreads a small tile set down a large panel instead of stacking it in
 * the top corner — but never below their own content: a box too short even for
 * the smallest readable numbers clips its last row, which reads as "make me
 * bigger", where rows squeezed under their content would have drawn over each
 * other.
 */
export const TILE_GRID = 'grid auto-rows-[minmax(min-content,1fr)] gap-[0.4em] min-w-0'

interface TrendArrowProps {
  trend: Trend
  invertColor?: boolean
}

export function TrendArrow({ trend, invertColor }: TrendArrowProps) {
  if (trend === 'stable') {
    return <span className="text-zinc-600 text-[0.72em] ml-[0.25em]">→</span>
  }
  const isUp = trend === 'up'
  const color = invertColor
    ? (isUp ? 'text-red-400' : 'text-[#76B900]')
    : (isUp ? 'text-[#76B900]' : 'text-red-400')
  return <span className={`${color} text-[0.72em] ml-[0.25em]`}>{isUp ? '▲' : '▼'}</span>
}

/**
 * What a tile shows in place of its figure when the engine does not report it:
 * muted, so it reads as a property of the engine rather than a value — never a
 * dash, which says "not yet", and never a zero (ADR-0004).
 */
export function NotReported() {
  return <span className="text-[0.8em] text-zinc-500">{NOT_REPORTED}</span>
}

interface MetricTileProps {
  label: string
  value: string
  unit?: string
  trend?: Trend
  invertTrend?: boolean
  warn?: boolean
  /** Optional small line under the value — used for latency percentiles. */
  subline?: string
  /**
   * The engine does not report this figure: the label stays, the value, unit,
   * trend and subline are not rendered, and "not reported" takes their place.
   * `value` is ignored.
   */
  notReported?: boolean
}

/** Big metric tile with optional trend indicator. */
export function MetricTile({ label, value, unit, trend, invertTrend, warn, subline, notReported }: MetricTileProps) {
  return (
    <div role="group" aria-label={label} className={TILE}>
      <span className={`${LABEL} ${warn ? 'text-red-400/70' : 'text-zinc-400'}`}>
        {label}
      </span>
      {notReported ? (
        <NotReported />
      ) : (
        <>
          <div className="flex items-baseline">
            <span className={`${VALUE} ${warn ? 'text-red-400' : 'text-zinc-100'}`}>
              {value}
            </span>
            {unit && <span className={UNIT}>{unit}</span>}
            {trend && <TrendArrow trend={trend} invertColor={invertTrend} />}
          </div>
          {subline && (
            <span className="text-[0.7em] text-zinc-500 font-mono tabular-nums tracking-tight truncate">
              {subline}
            </span>
          )}
        </>
      )}
    </div>
  )
}

interface LiveWithTotalProps {
  /** Left half: the live throughput tile. */
  liveValue: string
  liveUnit?: string
  trend?: Trend
  /** Right half: the token total since the warmup baseline (animated, abbreviated). */
  totalLabel: string
  total: number | null
  /** The engine reports neither figure: both labels stay, "not reported" replaces both values. */
  notReported?: boolean
}

/**
 * First line of the prefill / decode cards: the live throughput tile on the
 * left, and a compact animated cumulative-token total on the right next to
 * it. Both stay on one line — the numbers are deliberately a step smaller than
 * a full `MetricTile` so the pair never wraps on narrow cards.
 */
export function LiveWithTotal({
  liveValue,
  liveUnit,
  trend,
  totalLabel,
  total,
  notReported,
}: LiveWithTotalProps) {
  return (
    <div role="group" aria-label="Live" className="flex items-center justify-between gap-[0.5em] min-w-0">
      <div className={TILE}>
        <span className={`${LABEL} text-zinc-400`}>Live</span>
        {notReported ? (
          <NotReported />
        ) : (
          <div className="flex items-baseline min-w-0">
            <span className="text-[1.4em] font-bold font-mono tabular-nums leading-none text-zinc-100">
              {liveValue}
            </span>
            {liveUnit && <span className={UNIT}>{liveUnit}</span>}
            {trend && <TrendArrow trend={trend} />}
          </div>
        )}
      </div>
      <div className={`${TILE} items-end text-right`}>
        <span className={`${LABEL} text-zinc-400`}>{totalLabel}</span>
        {notReported ? (
          <NotReported />
        ) : (
          <div className="flex items-baseline min-w-0">
            <AnimatedCounter
              value={total}
              format={formatCompactTokens}
              className="text-[1.4em] font-bold font-mono tabular-nums leading-none text-zinc-100 truncate"
            />
            <span className={UNIT}>tok</span>
          </div>
        )}
      </div>
    </div>
  )
}

interface KvBarProps {
  percent: number
}

/** Mini KV cache utilization bar. Green <70, yellow 70–90, red >90. */
export function KvBar({ percent }: KvBarProps) {
  const color = percent > 90 ? 'bg-red-500' : percent > 70 ? 'bg-yellow-500' : 'bg-[#76B900]'
  return (
    <div className="flex h-[0.25em] min-h-[3px] rounded-full overflow-hidden bg-zinc-700/50 mt-[0.2em]">
      <div className={`${color} transition-all duration-300`} style={{ width: `${percent}%` }} />
    </div>
  )
}

interface SpecDecodeSectionProps {
  /** Lifetime token acceptance rate (TAR), 0-100. */
  acceptanceRate: number | null
  /** Live (windowed) TAR, 0-100. Shown as a secondary line when present. */
  acceptanceRateLive: number | null
  /** Mean accepted tokens per draft attempt. */
  meanAcceptanceLength: number | null
  /** Cumulative accepted tokens (counts up). */
  acceptedTokens: number | null
  /** Cumulative drafted tokens (counts up). */
  draftTokens: number | null
}

/** The rows `SpecDecodeSection` draws, for the panel's scale. */
export const SPEC_DECODE_ROWS = 2

/**
 * Speculative decoding, in four values: the token acceptance rate (lifetime,
 * with the live figure beside it), the mean accepted length, and the two
 * cumulative counters. Rendered only when the served model has speculative
 * decoding enabled — the caller gates on metric presence.
 *
 * Higher acceptance is better, so TAR is coloured green (≥70%), yellow (≥40%),
 * else red. The panel's own title says what the section is, so the tiles do not
 * repeat it: the row that would cost is a row of numbers instead.
 */
export function SpecDecodeSection({
  acceptanceRate,
  acceptanceRateLive,
  meanAcceptanceLength,
  acceptedTokens,
  draftTokens,
}: SpecDecodeSectionProps) {
  const tarColor =
    acceptanceRate === null
      ? 'text-zinc-100'
      : acceptanceRate >= 70
        ? 'text-[#76B900]'
        : acceptanceRate >= 40
          ? 'text-yellow-400'
          : 'text-red-400'
  return (
    <div className={`${TILE_GRID} grid-cols-2`}>
      <div className={TILE}>
        <span className={`${LABEL} text-zinc-400`}>
          TAR
          {acceptanceRateLive !== null && (
            <span className="ml-1 normal-case tracking-normal text-zinc-600">
              {Math.round(acceptanceRateLive)}% live
            </span>
          )}
        </span>
        <div className="flex items-baseline">
          <span className={`${VALUE} ${tarColor}`}>
            {acceptanceRate === null ? '--' : Math.round(acceptanceRate)}
          </span>
          <span className={UNIT}>%</span>
        </div>
      </div>
      <MetricTile
        label="Accept Len"
        value={fmtVal(meanAcceptanceLength, formatAcceptanceLength)}
        unit="tok/draft"
      />
      {/* Cumulative accepted/draft tokens. Each value gets its own line (label
          above) so the abbreviated counters never clip on narrow cards, while
          smaller numbers than the two above keep the acceptance rate the thing
          the eye lands on. */}
      <CounterTile label="Accepted" value={acceptedTokens} />
      <CounterTile label="Draft" value={draftTokens} />
    </div>
  )
}

/** A cumulative token counter that animates upward toward its latest value. */
function CounterTile({ label, value }: { label: string; value: number | null }) {
  return (
    <div className={TILE}>
      <span className={`${LABEL} text-zinc-400`}>{label}</span>
      <div className="flex items-baseline min-w-0">
        <AnimatedCounter
          value={value}
          format={formatCompactTokens}
          className="text-[1.15em] font-bold font-mono tabular-nums leading-none text-zinc-100 truncate"
        />
        <span className={UNIT}>tok</span>
      </div>
    </div>
  )
}

interface GoodputTileProps {
  label: string
  /** 0-100 percentage, or null when no data. */
  pct: number | null
  /** When true, render the value with extra emphasis (used for the headline). */
  emphasize?: boolean
  /** The engine does not report this figure: label stays, "not reported" replaces the value. `pct` is ignored. */
  notReported?: boolean
}

/**
 * SLO goodput tile. Color-codes the percentage:
 * - green at 99%+
 * - yellow 90–99%
 * - red below 90%
 *
 * Returns `--` when there is no data yet.
 */
export function GoodputTile({ label, pct, emphasize, notReported }: GoodputTileProps) {
  const color =
    pct === null
      ? 'text-zinc-100'
      : pct >= 99
        ? 'text-[#76B900]'
        : pct >= 90
          ? 'text-yellow-400'
          : 'text-red-400'
  const display = pct === null ? '--' : pct.toFixed(pct >= 99.95 ? 0 : 1)
  return (
    <div role="group" aria-label={label} className={TILE}>
      <span className={`${LABEL} text-zinc-400`}>{label}</span>
      {notReported ? (
        <NotReported />
      ) : (
        <div className="flex items-baseline">
          <span
            className={`${emphasize ? 'text-[2.4em]' : 'text-[1.7em]'} font-bold font-mono tabular-nums leading-none ${color}`}
          >
            {display}
          </span>
          <span className={UNIT}>%</span>
        </div>
      )}
    </div>
  )
}
