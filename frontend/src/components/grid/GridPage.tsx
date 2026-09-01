import 'gridstack/dist/gridstack.css'
import { useCallback, useMemo, useRef } from 'react'
import {
  GridStack,
  GridStackItem,
  type GridItemHTMLElement,
  type GridStackNode,
  type GridStackOptions,
} from 'gridstack/dist/react'
import { PageSelectionProvider } from '@/hooks/PageSelectionProvider'
import { useElementSize } from '@/hooks/useElementSize'
import {
  judgeDrop,
  requestedCells,
  type Gesture,
  type LayoutChange,
} from '@/lib/dashboard/editing'
import { readGeometry, GRID_COLUMNS, GRID_MAX_ROWS, type PanelGeometry } from '@/lib/dashboard/grid'
import type { DashboardPage } from '@/lib/dashboard/schema'
import { isNarrow, SINGLE_COLUMN_BREAKPOINT } from './breakpoint'
import { GridPanel } from './GridPanel'

/**
 * Row height until the container has been measured. jsdom never measures, so
 * this is also what every unit test runs on; the number itself is arbitrary
 * because fit-to-viewport replaces it on the first ResizeObserver tick.
 */
const FALLBACK_CELL_HEIGHT = 80

/**
 * Where the pointer was when the grid raised a gesture event.
 *
 * The library hands its own synthetic event to the callback, carrying the
 * pointer coordinates copied off the mouse event underneath. Null for anything
 * without them, which is what keeps a missing coordinate from reading as a drag
 * back to the top-left corner.
 */
function pointerAt(event: Event): { x: number; y: number } | null {
  const { clientX, clientY } = event as MouseEvent

  return typeof clientX === 'number' && typeof clientY === 'number'
    ? { x: clientX, y: clientY }
    : null
}

/** What an edit session wants to hear from the grid. Absent means read-only
 *  viewing, which is what the dashboard is nearly all of the time. */
export interface GridEditing {
  /** Where the engine has put panels, after a drop it accepted. */
  onLayoutChange: (changes: LayoutChange[]) => void
  /** A drag or resize has begun, so whatever the operator was told last is spent. */
  onGestureStart: () => void
  /** The named panel asked for a placement the page had no room for. */
  onOutOfRoom: (panelId: string) => void
}

/**
 * The per-panel affordances an open session adds to each frame.
 *
 * Separate from `GridEditing` on purpose: that object is the grid library's
 * contract and is held stable for the life of the session, while this one
 * changes every time the operator opens another panel's settings.
 */
export interface PanelChrome {
  /** The panel whose settings are open, or null while none are. */
  configuringId: string | null
  onConfigure: (panelId: string) => void
}

/**
 * One dashboard page as a grid of panels.
 *
 * Fit-to-viewport is the defining property: the row height is the measured
 * container height divided by the row cap, so a full page exactly fills the
 * space and never scrolls on desktop. Below the breakpoint the engine stacks
 * panels into a single column and the container scrolls instead — the one place
 * scrolling is the design.
 *
 * The grid is static unless an edit session is passed (#83), which is what keeps
 * every panel interaction — chart tooltips, log filters, engine tabs — working
 * the rest of the time.
 */
export function GridPage({
  page,
  editing,
  chrome,
}: {
  page: DashboardPage
  editing?: GridEditing
  chrome?: PanelChrome
}) {
  const [containerRef, { width, height }] = useElementSize<HTMLDivElement>()
  const narrow = isNarrow(width)
  const cellHeight = height > 0 ? Math.floor(height / GRID_MAX_ROWS) : FALLBACK_CELL_HEIGHT
  // A session survives the window narrowing, but nothing may be rearranged
  // while it does: the collapsed column is derived from the layout being
  // edited, so a drag there would author cells in a grid one column wide.
  const draggable = Boolean(editing) && !narrow

  const options = useMemo(
    (): GridStackOptions => ({
      column: GRID_COLUMNS,
      columnOpts: {
        columnMax: GRID_COLUMNS,
        breakpoints: [{ w: SINGLE_COLUMN_BREAKPOINT, c: 1 }],
      },
      // The cap is the engine's only while an edit session is open, and only on
      // a desktop-width grid. Outside one it must stay off: the engine clamps
      // every node into the cap when it re-adds them during a column change,
      // and the single-column stack legitimately needs more rows than the cap.
      // Zero, not undefined — `updateOptions` ignores an absent maxRow, so
      // leaving edit mode has to say the cap is gone in as many words.
      maxRow: draggable ? GRID_MAX_ROWS : 0,
      cellHeight,
      margin: 3,
      // Authored gaps are authored. Without floating, the engine compacts
      // everything upward on load and quietly rewrites the operator's layout.
      float: true,
      staticGrid: !draggable,
    }),
    [cellHeight, draggable],
  )

  // The gesture under way: what it is doing, where the panel started, and where
  // the pointer was when it began.
  const gesture = useRef<{
    kind: Gesture
    before: PanelGeometry
    from: { x: number; y: number }
  } | null>(null)

  const beginGesture = useCallback(
    (kind: Gesture) => (event: Event, element: GridItemHTMLElement) => {
      const node = element.gridstackNode
      const from = pointerAt(event)
      gesture.current = node && from ? { kind, before: readGeometry(node), from } : null
      editing?.onGestureStart()
    },
    [editing],
  )

  const endGesture = useCallback(
    (event: Event, element: GridItemHTMLElement) => {
      const attempt = gesture.current
      gesture.current = null

      const node = element.gridstackNode
      const to = pointerAt(event)
      const grid = node?.grid
      if (!attempt || !to || !grid || node.id === undefined) return

      const requested = requestedCells(
        attempt.kind,
        attempt.before,
        { dx: to.x - attempt.from.x, dy: to.y - attempt.from.y },
        { width: grid.cellWidth(), height: grid.getCellHeight(true) },
      )

      if (judgeDrop(attempt.before, requested, readGeometry(node)) === 'out-of-room') {
        editing?.onOutOfRoom(String(node.id))
      }
    },
    [editing],
  )

  const beginMove = useMemo(() => beginGesture('move'), [beginGesture])
  const beginResize = useMemo(() => beginGesture('resize'), [beginGesture])

  const handleChange = useCallback(
    (_event: Event, nodes: GridStackNode[]) => {
      // Belt and braces with the static grid above: a collapsed grid reports
      // one-column coordinates, which are derived rather than authored, and
      // recording them would let a save overwrite a desktop layout with a
      // phone's.
      if (narrow) return
      editing?.onLayoutChange(
        nodes
          .filter((node) => node.id !== undefined)
          .map((node) => ({ id: String(node.id), geometry: readGeometry(node) })),
      )
    },
    [narrow, editing],
  )

  return (
    <div
      ref={containerRef}
      // Inline rather than `h-full`: the height feeds the row-height math, so
      // it must hold anywhere the component renders — including the browser
      // test project, which runs no Tailwind build.
      style={{ height: '100%' }}
      className={`min-h-0 ${narrow ? 'overflow-y-auto' : 'overflow-hidden'}`}
    >
      {/* The selection is per page and lives inside it: every following panel
          on this page reads the same GPU and engine, and a page mounted at
          another id starts from the host's defaults again. */}
      <PageSelectionProvider>
        <GridStack
          options={options}
          onChange={draggable ? handleChange : undefined}
          onDragStart={draggable ? beginMove : undefined}
          onDragStop={draggable ? endGesture : undefined}
          onResizeStart={draggable ? beginResize : undefined}
          onResizeStop={draggable ? endGesture : undefined}
        >
          {page.panels.map((panel) => (
            <GridStackItem key={panel.id} id={panel.id} options={panel.geometry}>
              <GridPanel
                panel={panel}
                editing={Boolean(editing)}
                configuring={chrome?.configuringId === panel.id}
                onConfigure={chrome && (() => chrome.onConfigure(panel.id))}
              />
            </GridStackItem>
          ))}
        </GridStack>
      </PageSelectionProvider>
    </div>
  )
}
