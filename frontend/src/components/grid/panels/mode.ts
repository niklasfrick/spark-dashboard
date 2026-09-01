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
 * The gauge column's square size for a measured content height: fill the row
 * up to the size the pre-grid dashboard capped its gauges at. Unmeasured
 * boxes get the cap, consistent with `hardwarePanelMode`'s richest-layout
 * fallback.
 */
export function gaugeSizePx(height: number): number {
  if (height <= 0) return 96
  return Math.max(40, Math.min(96, height - 8))
}
