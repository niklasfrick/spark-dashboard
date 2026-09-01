import type { ElementSize } from '@/hooks/useElementSize'

/**
 * How a hardware panel renders inside its own measured box.
 *
 * The pre-grid dashboard sized every card by one global heuristic — grid height
 * divided by the card count. On the grid each panel adapts to nothing but its
 * own content box:
 *
 *   - `full`    — gauge (or headline value) beside a trend chart.
 *   - `chart`   — the chart alone; the box is too narrow for a gauge column.
 *   - `compact` — the current value as a horizontal bar or rate row; the box is
 *                 too short for a chart to be legible.
 */
export type HardwarePanelMode = 'full' | 'chart' | 'compact'

/** Below this content height (px) a chart is illegible; show the value alone. */
const COMPACT_BELOW_PX = 96

/** Below this content width (px) the gauge column would starve the chart. */
const NARROW_BELOW_PX = 168

/**
 * Pick the mode for a measured content box. A zero dimension means "not
 * measured yet" (jsdom, or the first frame before ResizeObserver fires); the
 * contract of `useElementSize` is to fall back to the richest layout then.
 */
export function hardwarePanelMode({ width, height }: ElementSize): HardwarePanelMode {
  if (height > 0 && height < COMPACT_BELOW_PX) return 'compact'
  if (width > 0 && width < NARROW_BELOW_PX) return 'chart'
  return 'full'
}

/**
 * How an engine panel renders inside its own measured box.
 *
 *   - `full`  — the tile values with their trend chart underneath.
 *   - `tiles` — the values alone; the box has no room left for a chart once the
 *               tiles have taken what they need.
 *
 * Engine tiles are read, not glanced at — several labelled numbers rather than
 * one gauge — so they claim their height first and the chart takes what is left.
 */
export type EnginePanelMode = 'full' | 'tiles'

/**
 * Below this content height (px) the tiles leave too little for a chart to say
 * anything. Deliberately higher than the hardware panels' threshold: those give
 * their chart the whole box beside a gauge, while here it shares the box with
 * two or three rows of values.
 */
const TILES_ONLY_BELOW_PX = 200

/** Pick the mode for a measured content box, on the same unmeasured-means-
 *  richest terms as `hardwarePanelMode`. */
export function enginePanelMode({ height }: ElementSize): EnginePanelMode {
  return height > 0 && height < TILES_ONLY_BELOW_PX ? 'tiles' : 'full'
}

/**
 * The gauge column's square size for a measured content height: fill the row
 * up to the size the pre-grid dashboard capped its gauges at. Unmeasured
 * boxes get the cap, consistent with `hardwarePanelMode`'s richest-layout
 * fallback.
 */
export function gaugeSizePx(height: number): number {
  if (height <= 0) return 96
  return Math.max(40, Math.min(96, height - 8))
}
