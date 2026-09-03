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
 * What one tile row costs, in ems of the base: the label line, the gap under
 * it, the value line, and the gap to the next row. Everything inside a tile is
 * sized in `em`, so this ratio holds at every scale.
 */
const ROW_EM = 3.2

/** In `full` mode the chart shares the box, so the tiles size to this much of
 *  it rather than to all of it. */
const TILES_SHARE = 0.55

/** The identity row above the tiles: fixed-size chrome, not part of the scale. */
const LABEL_ROW_PX = 16

/** Width the tile block wants, in ems of the base — two columns of a value and
 *  its unit, with room for the longest label above them. Below this the base
 *  comes off the width instead of the height, so a tall sliver of a panel does
 *  not render numbers wider than itself. */
const WIDTH_EM = 20

/**
 * The size range for the base, which everything in a tile is an em of. The two
 * ends are set by the value — the headline number at 1.7em, the thing an
 * operator actually reads across the room — with the label above it at 0.8em
 * coming along for the ride:
 *
 *   - 10px  → a 17px value, 8px label. The floor is what a 1×2 cell can hold
 *             two rows of; higher and the panels that only just fit today start
 *             clipping a row, which costs a whole value rather than some of its
 *             stroke weight.
 *   - 18px  → a 31px value, 14px label: what the old breakpoints gave a 1920px
 *             display, which is the size these numbers have always been read
 *             at. Past it a panel given a quarter of the page reads as signage
 *             rather than as a dashboard.
 */
const MIN_TILE_PX = 10
const MAX_TILE_PX = 18

/** The base for an unmeasured box (jsdom, the frame before ResizeObserver
 *  fires): what the tiles used to render at on a 1080p display, the same
 *  richest-layout fallback the modes take. */
const UNMEASURED_TILE_PX = 13

/**
 * The base font size (px) for an engine panel's tiles, from the box they have
 * to live in.
 *
 * Tile typography used to key off *viewport* breakpoints, which says nothing
 * about the panel it is inside: a 2×1 cell on a 4K display got the largest
 * numbers in the set and cut them off, while a panel given a quarter of the
 * page kept its 1080p numbers and left the rest of the box empty. One base
 * here scales the whole block, because every size inside a tile is an `em`.
 *
 * `rows` is what the panel stacks vertically — the row count of its tile grid,
 * passed in because only the panel knows it. Fractional is meaningful: a
 * headline tile half again as tall as the ones under it costs 1.5.
 */
export function engineTileScale(
  { width, height }: ElementSize,
  rows: number,
  mode: EnginePanelMode,
): number {
  if (width <= 0 || height <= 0) return UNMEASURED_TILE_PX

  const forTiles = Math.max(0, height - LABEL_ROW_PX) * (mode === 'full' ? TILES_SHARE : 1)
  const byHeight = forTiles / (Math.max(rows, 1) * ROW_EM)
  const byWidth = width / WIDTH_EM

  return Math.min(Math.max(Math.min(byHeight, byWidth), MIN_TILE_PX), MAX_TILE_PX)
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
