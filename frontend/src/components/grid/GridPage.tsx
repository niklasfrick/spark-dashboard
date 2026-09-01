import 'gridstack/dist/gridstack.css'
import { useMemo } from 'react'
import { GridStack, GridStackItem, type GridStackOptions } from 'gridstack/dist/react'
import { useElementSize } from '@/hooks/useElementSize'
import { GRID_COLUMNS, GRID_MAX_ROWS } from '@/lib/dashboard/grid'
import type { DashboardPage } from '@/lib/dashboard/schema'
import { GridPanel } from './GridPanel'

/**
 * Container width in px at or below which the grid collapses to one column.
 * The collapse is the engine's own responsive path, driven by the grid
 * element's measured size (`breakpointForWindow` defaults to false): gridstack
 * caches the authored 12-column layout before collapsing and restores it
 * verbatim on the way back, which the #68 spike confirmed is lossless. Never
 * persist what the collapsed grid looks like.
 */
export const SINGLE_COLUMN_BREAKPOINT = 640

/**
 * Row height until the container has been measured. jsdom never measures, so
 * this is also what every unit test runs on; the number itself is arbitrary
 * because fit-to-viewport replaces it on the first ResizeObserver tick.
 */
const FALLBACK_CELL_HEIGHT = 80

/**
 * One dashboard page as a grid of panels.
 *
 * Fit-to-viewport is the defining property: the row height is the measured
 * container height divided by the row cap, so a full page exactly fills the
 * space and never scrolls on desktop. Below the breakpoint the engine stacks
 * panels into a single column and the container scrolls instead — the one place
 * scrolling is the design.
 *
 * The grid is static here: rendering from the stored document is this ticket
 * (#79); dragging, resizing and saving are edit mode (#83).
 */
export function GridPage({ page }: { page: DashboardPage }) {
  const [containerRef, { width, height }] = useElementSize<HTMLDivElement>()
  const narrow = width > 0 && width <= SINGLE_COLUMN_BREAKPOINT
  const cellHeight = height > 0 ? Math.floor(height / GRID_MAX_ROWS) : FALLBACK_CELL_HEIGHT

  const options = useMemo(
    (): GridStackOptions => ({
      column: GRID_COLUMNS,
      columnOpts: {
        columnMax: GRID_COLUMNS,
        breakpoints: [{ w: SINGLE_COLUMN_BREAKPOINT, c: 1 }],
      },
      // `maxRow` is deliberately NOT set on the engine here. The engine clamps
      // every node into the cap when it re-adds them during a column change,
      // and the single-column stack legitimately needs more rows than the cap
      // — setting it would mangle the phone layout. A static grid cannot
      // violate the cap anyway: `readGeometry` clamps persisted geometry into
      // `GRID_MAX_ROWS` on read. Edit mode (#83) wires the cap into the engine
      // (`maxRow` + `willItFit`) for the desktop-only edit session, where
      // "will one more fit" is actually a question.
      cellHeight,
      margin: 3,
      // Authored gaps are authored. Without floating, the engine compacts
      // everything upward on load and quietly rewrites the operator's layout.
      float: true,
      staticGrid: true,
    }),
    [cellHeight],
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
      <GridStack options={options}>
        {page.panels.map((panel) => (
          <GridStackItem key={panel.id} id={panel.id} options={panel.geometry}>
            <GridPanel panel={panel} />
          </GridStackItem>
        ))}
      </GridStack>
    </div>
  )
}
