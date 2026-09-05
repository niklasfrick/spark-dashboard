/**
 * The rules of an edit session: what a layout change does to a page, what an
 * operator's own edits do to it, and what to make of a drag, resize or addition
 * the page had no room for.
 *
 * Everything here is pure, so the two things that are otherwise only reachable
 * with a real layout engine — normalizing what the grid library reports, and
 * telling a refused drop from a satisfied one — are covered without a browser.
 * The session itself (what is being edited, and when it is written) lives in
 * `GridPageEditor`; nothing in this module knows about React or the server.
 *
 * Every edit is a **replacement**: a panel list in, a new panel list out, with
 * the untouched panels kept by identity. The session holds the result, and
 * nothing reaches the server until the operator saves.
 */

import type { PanelBinding } from './bindings'
import { FOLLOW } from './bindings'
import { firstFreeSlot, readGeometry, GRID_COLUMNS, type PanelGeometry } from './grid'
import { defaultPanelSize, type PanelType } from './panels'
import {
  panelTitle,
  DEFAULT_TIME_WINDOW,
  type DashboardDocument,
  type DashboardPanel,
} from './schema'
import type { TimeWindow } from '@/types/events'

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

/** One grid cell in pixels. */
export interface CellSize {
  width: number
  height: number
}

/** How far a pointer travelled over the course of a gesture, in pixels. */
export interface Travel {
  dx: number
  dy: number
}

/** Which of the two things a finished gesture was doing. */
export type Gesture = 'move' | 'resize'

/**
 * The cells a finished drag or resize asked for: where the panel started, moved
 * or grown by however far the pointer travelled.
 *
 * Read from the **pointer**, not from the panel. The library reports a panel in
 * flight only while it is accepting the move — a refused one produces no event
 * and never leaves its cells — so the panel's own position answers the wrong
 * question. The pointer says what the operator asked for whether or not they got
 * it, which is the only thing that distinguishes a refusal from a drag taken
 * back.
 *
 * Deliberately **not** clamped into the row cap: a clamp here would quietly turn
 * every out-of-room request into a satisfied one. Columns are a different
 * matter — see `judgeDrop`.
 *
 * Null when the grid has not been measured: jsdom measures every box as 0×0, and
 * so does the first frame before layout. Concluding anything from that would
 * accuse the grid of refusing a drop the operator never made.
 */
export function requestedCells(
  gesture: Gesture,
  before: PanelGeometry,
  travel: Travel,
  cell: CellSize,
): PanelGeometry | null {
  if (cell.width <= 0 || cell.height <= 0) return null

  const columns = Math.round(travel.dx / cell.width)
  const rows = Math.round(travel.dy / cell.height)

  return gesture === 'move'
    ? { ...before, x: Math.max(0, before.x + columns), y: Math.max(0, before.y + rows) }
    : { ...before, w: Math.max(1, before.w + columns), h: Math.max(1, before.h + rows) }
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

/**
 * The title to name in a refusal, or null when nothing stands refused.
 *
 * Deliberately just the title. Whether the *page* is full is a different
 * question from whether the panel could go where it was dropped — and a much
 * harder one, since a panel is never in its own way, so the obvious predicate
 * answers "not full" for a page with room for exactly one thing in the space
 * the panel already occupies. The message says what is certain instead.
 */
export function refusedPanelTitle(
  panels: readonly DashboardPanel[],
  panelId: string | null,
): string | null {
  const refused = panels.find((panel) => panel.id === panelId)
  return refused ? panelTitle(refused) : null
}

/** What became of a click on the palette. */
export type AddPanelOutcome =
  | { status: 'added'; panels: DashboardPanel[]; panelId: string }
  /** Nothing on the page could make way for a panel of this size. */
  | { status: 'out-of-room' }

/**
 * The page with one more panel of `type`, placed in the first free slot.
 *
 * Click-to-add rather than drag-from-palette: the operator picks a type and the
 * panel appears where their eye already is, then they drag it into position.
 * Aiming a drag at empty space is the thing this avoids, and it is much the
 * worse of the two on touch.
 *
 * The new panel **follows the page** and takes the default window. Pinning it
 * at birth would name a target the operator never chose — and one that may not
 * exist on the next host the layout is opened on.
 *
 * Out of room is a first-class outcome rather than a silent no-op: the page is
 * a fixed number of rows, so "there is nowhere to put this" is a state the
 * operator is owed an explanation for.
 */
export function addPanel(panels: readonly DashboardPanel[], type: PanelType): AddPanelOutcome {
  const geometry = firstFreeSlot(
    panels.map((panel) => panel.geometry),
    defaultPanelSize(type),
  )
  if (!geometry) return { status: 'out-of-room' }

  const panelId = unusedPanelId(panels, type)

  return {
    status: 'added',
    panelId,
    // No title: the type's own default is used, so a default reworded in a
    // later release reaches every panel nobody renamed.
    panels: [
      ...panels,
      { id: panelId, type, geometry, binding: FOLLOW, window: DEFAULT_TIME_WINDOW },
    ],
  }
}

/**
 * The page without the panel named. There is no undo — discarding the session
 * is the substitute, which is what makes the one-click X on the frame (and the
 * button in the panel's settings) safe: nothing is written until the save.
 */
export function removePanel(
  panels: readonly DashboardPanel[],
  panelId: string,
): DashboardPanel[] {
  const next = panels.filter((panel) => panel.id !== panelId)
  return next.length === panels.length ? (panels as DashboardPanel[]) : next
}

/**
 * The page with one panel titled in the operator's own vocabulary.
 *
 * A title that is blank or only whitespace is **dropped** rather than stored:
 * the panel goes back to reading as its type's default, which is the only way
 * back from a rename once the original wording is gone.
 */
export function renamePanel(
  panels: readonly DashboardPanel[],
  panelId: string,
  title: string,
): DashboardPanel[] {
  const trimmed = title.trim()

  return mapPanel(panels, panelId, (panel) => {
    if (trimmed.length > 0) return { ...panel, title: trimmed }
    const cleared = { ...panel }
    delete cleared.title
    return cleared
  })
}

/**
 * The page with one panel's chart covering a different span. Per panel, so a
 * short spike and a longer trend can sit side by side on the same page.
 */
export function setPanelWindow(
  panels: readonly DashboardPanel[],
  panelId: string,
  window: TimeWindow,
): DashboardPanel[] {
  return mapPanel(panels, panelId, (panel) => ({ ...panel, window }))
}

/**
 * The page with one panel pointed somewhere else — pinned to a concrete GPU or
 * engine, or put back to following the page's selection.
 *
 * This is also the only repair for a binding that could not be read: the panel
 * says it needs repointing, and repointing it is what the operator does.
 */
export function repointPanel(
  panels: readonly DashboardPanel[],
  panelId: string,
  binding: PanelBinding,
): DashboardPanel[] {
  return mapPanel(panels, panelId, (panel) => ({ ...panel, binding }))
}

/**
 * An id nothing else on the page holds, derived from the type so a saved
 * document reads as what it is. Ids are unique per page, and the grid keys its
 * items by them, so a collision would put two panels in one slot.
 */
function unusedPanelId(panels: readonly DashboardPanel[], type: string): string {
  const taken = new Set(panels.map((panel) => panel.id))
  if (!taken.has(type)) return type

  for (let suffix = 2; ; suffix++) {
    const candidate = `${type}-${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}

/** One panel replaced, the others kept by identity. The same list back when the
 *  page has no panel by that id — a panel removed under an open settings row. */
function mapPanel(
  panels: readonly DashboardPanel[],
  panelId: string,
  edit: (panel: DashboardPanel) => DashboardPanel,
): DashboardPanel[] {
  if (!panels.some((panel) => panel.id === panelId)) return panels as DashboardPanel[]
  return panels.map((panel) => (panel.id === panelId ? edit(panel) : panel))
}

function samePlacement(a: PanelGeometry, b: PanelGeometry): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}
