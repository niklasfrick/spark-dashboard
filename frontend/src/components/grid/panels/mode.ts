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

/** How the CPU-cores panel tiles its box. */
export interface CoreGridLayout {
  /** Cells per row. */
  columns: number
  /** Whether a cell has room for the core's own number and load, or is only
   *  big enough to be a block of colour in the texture. */
  labelled: boolean
}

/** The aspect ratio assumed for a box nothing has measured yet — wider than
 *  tall, which is what a grid cell is at every preset size. */
const UNMEASURED_ASPECT = 2

/** A cell narrower than this cannot hold "63" and "100%" beside each other. */
const LABEL_MIN_WIDTH_PX = 44
/** A cell shorter than this cannot hold the two lines a label needs. */
const LABEL_MIN_HEIGHT_PX = 26

/**
 * How to lay `cores` core cells out in a measured box: the column count that
 * gets the cells closest to square, and whether they came out big enough to
 * label.
 *
 * Square cells are the goal because the grid is read as a texture — a row of
 * slivers says nothing about which cores are busy. A 96-core host in a 1×1
 * cell therefore gets an unlabelled block of colour, and the same host across a
 * 6×4 panel gets a labelled one, from the same component.
 *
 * Unmeasured boxes get the richest layout, the same fallback rule as
 * `hardwarePanelMode`.
 */
export function coreGridLayout({ width, height }: ElementSize, cores: number): CoreGridLayout {
  if (cores <= 0) return { columns: 1, labelled: true }

  const measured = width > 0 && height > 0
  const aspect = measured ? width / height : UNMEASURED_ASPECT
  const columns = Math.min(cores, Math.max(1, Math.round(Math.sqrt(cores * aspect))))
  if (!measured) return { columns, labelled: true }

  const rows = Math.ceil(cores / columns)
  const labelled =
    width / columns >= LABEL_MIN_WIDTH_PX && height / rows >= LABEL_MIN_HEIGHT_PX
  return { columns, labelled }
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
