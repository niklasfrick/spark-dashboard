/**
 * The rules of an edit session: what a layout change does to a page, and what
 * to make of a drag or resize the grid did not grant.
 *
 * Everything here is pure, so the two things that are otherwise only reachable
 * with a real layout engine — normalizing what the grid library reports, and
 * telling a refused drop from a satisfied one — are covered without a browser.
 * The session itself (what is being edited, and when it is written) lives in
 * `useEditSession`; nothing in this module knows about React or the server.
 */

import { readGeometry, GRID_COLUMNS, type PanelGeometry } from './grid'
import type { DashboardDocument, DashboardPanel } from './schema'

/** Where the grid says a panel now sits. */
export interface LayoutChange {
  id: string
  /** As the library reports it: sparse, with its own defaults omitted. */
  geometry: PanelGeometry
}

/**
 * The page's panels with `changes` applied, or the **same array** when nothing
 * actually moved.
 *
 * Identity is part of the contract: the grid reports a change for every node it
 * touched, including ones it put back where they were, and a session that
 * re-created its panel list each time would re-render every panel on the page
 * mid-drag.
 *
 * Geometry is normalized on the way in rather than on the way out, so the
 * session holds cells that are already inside the grid and the serializer has
 * nothing left to guess about.
 */
export function applyLayoutChanges(
  panels: readonly DashboardPanel[],
  changes: readonly LayoutChange[],
): DashboardPanel[] {
  const moved = new Map(changes.map((change) => [change.id, readGeometry(change.geometry)]))
  if (moved.size === 0) return panels as DashboardPanel[]

  let changed = false
  const next = panels.map((panel) => {
    const geometry = moved.get(panel.id)
    if (!geometry || samePlacement(panel.geometry, geometry)) return panel
    changed = true
    return { ...panel, geometry }
  })

  return changed ? next : (panels as DashboardPanel[])
}

/** The document with one page's panels replaced — what an explicit save writes. */
export function withPagePanels(
  document: DashboardDocument,
  pageId: string,
  panels: DashboardPanel[],
): DashboardDocument {
  return {
    ...document,
    pages: document.pages.map((page) => (page.id === pageId ? { ...page, panels } : page)),
  }
}

/** A rectangle in pixels — an element's box, or the grid's own. */
export interface PixelRect {
  left: number
  top: number
  width: number
  height: number
}

/** One grid cell in pixels. */
export interface CellSize {
  width: number
  height: number
}

/**
 * The cells a drag or resize in progress is asking for: where the operator has
 * put the element, converted through the grid's own cell size.
 *
 * Deliberately **not** clamped into the row cap. The whole question this answers
 * is whether the operator asked for something the page has no room for, and a
 * clamp here would quietly turn every such request into a satisfied one.
 * Columns are a different matter — see `judgeDrop`.
 *
 * Null when the grid has not been measured: jsdom measures every box as 0×0,
 * and so does the first frame before layout. There is nothing to conclude from
 * that, and concluding anything would accuse the grid of refusing a drop the
 * operator never made.
 */
export function requestedCells(
  item: PixelRect,
  grid: PixelRect,
  cell: CellSize,
): PanelGeometry | null {
  if (cell.width <= 0 || cell.height <= 0) return null

  return {
    x: Math.max(0, Math.round((item.left - grid.left) / cell.width)),
    y: Math.max(0, Math.round((item.top - grid.top) / cell.height)),
    w: Math.max(1, Math.round(item.width / cell.width)),
    h: Math.max(1, Math.round(item.height / cell.height)),
  }
}

/** What the grid did with the placement a finished drag or resize asked for. */
export type DropVerdict = 'granted' | 'out-of-room'

/**
 * Whether the operator got anywhere with the drag or resize they just finished.
 *
 * The grid enforces the row cap itself — it simulates the move and commits only
 * if the result still fits — so a refused drop is a panel that **did not move at
 * all** while being asked to. That is the whole signature, and it has to be that
 * narrow: the engine reflows around a panel that lands on its neighbours,
 * swapping and pushing them, so "you did not get the exact cells you dropped on"
 * is the normal, successful case and must not be reported as a full page.
 *
 * A drag the operator took back looks identical from the outside — nothing
 * moved — so the request is compared against where the panel started rather than
 * against nothing.
 *
 * Running off the left or right edge is not a refusal either: the grid has a
 * fixed number of columns, and being kept inside them is the frame, not the page
 * being full. Running off the bottom is the opposite — that is exactly the row
 * cap doing its job, and the operator is owed an explanation.
 *
 * A resize the cap cuts short is deliberately *not* refused: the panel visibly
 * grows to the bottom of the page and stops, which explains itself.
 */
export function judgeDrop(
  before: PanelGeometry,
  requested: PanelGeometry | null,
  granted: PanelGeometry,
): DropVerdict {
  if (!requested) return 'granted'
  if (!samePlacement(before, granted)) return 'granted'

  const w = Math.min(requested.w, GRID_COLUMNS)
  const asked = { ...requested, w, x: Math.min(requested.x, GRID_COLUMNS - w) }

  return samePlacement(asked, before) ? 'granted' : 'out-of-room'
}

function samePlacement(a: PanelGeometry, b: PanelGeometry): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}
