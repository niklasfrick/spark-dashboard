/**
 * The dashboard grid's coordinate system: where a panel sits, and whether one
 * more will fit.
 *
 * The grid is a fixed number of columns by a hard-capped number of rows. The
 * cap is what makes "out of room" a real state the operator can be told about
 * rather than a page that silently grows a scrollbar — the dashboard's defining
 * property is that a desktop layout fits the viewport. Row *height* is a
 * rendering concern derived from the measured container; nothing here knows
 * about pixels.
 *
 * Everything in this module is pure, so the interesting cases (a sparse
 * geometry, a full page) are covered without a browser.
 *
 * These constants are the **single source** for the grid's dimensions. Whoever
 * mounts the grid library must configure its own column count and row cap from
 * them, rather than restating the numbers: the library answers the same
 * "will it fit" question during a drag, and two independent answers would
 * disagree the moment either changed.
 */

import { isRecord } from './json'

/** A panel's placement in grid cells. Origin is the top-left cell. */
export interface PanelGeometry {
  x: number
  y: number
  w: number
  h: number
}

/** Just the size half of a geometry — what a not-yet-placed panel knows. */
export type PanelSize = Pick<PanelGeometry, 'w' | 'h'>

/**
 * Columns in the authored desktop layout. Twelve divides by 2, 3, 4 and 6, so
 * the common row arrangements land on whole columns.
 *
 * Narrow viewports collapse to fewer columns at render time; that is derived,
 * never persisted, so the authored layout survives a resize round trip.
 */
export const GRID_COLUMNS = 12

/**
 * Hard cap on rows. Doubles as the panel-count limit — there is no separate
 * one, because a page that cannot fit another cell cannot fit another panel.
 */
export const GRID_MAX_ROWS = 8

/**
 * Reads a persisted geometry into one guaranteed to be inside the grid.
 *
 * This is the single place sparse and hostile input is dealt with, and the
 * contract is **normalize on read**: gridstack's `save()` omits values equal to
 * its own defaults, so a panel at width and height of one is persisted with
 * neither key. Missing width or height therefore means one. Writing is
 * deliberately dense as well (see `serializeDashboardDocument`), but reading is
 * the side that has to be tolerant, because the sparse objects also arrive
 * straight from the library at runtime.
 *
 * Out-of-bounds values are clamped rather than rejected: a clamped panel is
 * still visible and still recognizable, whereas discarding it — or the page
 * holding it — loses work the operator did. A clamp can put two panels on the
 * same cells; the grid reflows them on mount, which is visible and recoverable.
 */
export function readGeometry(raw: unknown): PanelGeometry {
  const source = isRecord(raw) ? raw : {}

  const w = clamp(cell(source.w, 1), 1, GRID_COLUMNS)
  const h = clamp(cell(source.h, 1), 1, GRID_MAX_ROWS)

  return {
    x: clamp(cell(source.x, 0), 0, GRID_COLUMNS - w),
    y: clamp(cell(source.y, 0), 0, GRID_MAX_ROWS - h),
    w,
    h,
  }
}

/**
 * The first cell, in reading order, where a panel of `size` fits without
 * overlapping any of `occupied`. Null when it fits nowhere.
 *
 * Reading order — left to right, then top to bottom — is what makes an added
 * panel appear where the operator's eye already is, so click-to-add needs no
 * aiming. The whole rectangle must be free, not just its first row.
 */
export function firstFreeSlot(
  occupied: readonly PanelGeometry[],
  size: PanelSize,
): PanelGeometry | null {
  const { w, h } = size
  if (w < 1 || h < 1 || w > GRID_COLUMNS || h > GRID_MAX_ROWS) return null

  const taken = occupancy(occupied)

  for (let y = 0; y <= GRID_MAX_ROWS - h; y++) {
    for (let x = 0; x <= GRID_COLUMNS - w; x++) {
      if (isFree(taken, x, y, w, h)) return { x, y, w, h }
    }
  }

  return null
}

/**
 * Whether a panel of `size` has nowhere to go on a page holding `occupied`.
 *
 * The question is asked per panel rather than per page: a page with half a row
 * left has room for a small panel and none for a wide one. A drop that would be
 * out of room is rejected visibly, so a failed drag reads as "the page is full"
 * instead of as a bug.
 */
export function isOutOfRoom(occupied: readonly PanelGeometry[], size: PanelSize): boolean {
  return firstFreeSlot(occupied, size) === null
}

/** Row-major occupancy bitmap of the whole grid. */
function occupancy(panels: readonly PanelGeometry[]): boolean[] {
  const taken = new Array<boolean>(GRID_COLUMNS * GRID_MAX_ROWS).fill(false)

  for (const panel of panels) {
    const { x, y, w, h } = readGeometry(panel)
    for (let row = y; row < y + h; row++) {
      for (let col = x; col < x + w; col++) {
        taken[row * GRID_COLUMNS + col] = true
      }
    }
  }

  return taken
}

function isFree(taken: readonly boolean[], x: number, y: number, w: number, h: number): boolean {
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) {
      if (taken[row * GRID_COLUMNS + col]) return false
    }
  }
  return true
}

/** A whole number of cells, or `fallback` when the value is not a usable number. */
function cell(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi)
}
