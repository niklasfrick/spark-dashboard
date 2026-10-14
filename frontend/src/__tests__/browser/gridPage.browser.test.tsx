import { describe, expect, it } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { GridPage } from '@/components/grid/GridPage'
import { MetricsStoreProvider } from '@/hooks/MetricsStoreProvider'
import { FOLLOW } from '@/lib/dashboard/bindings'
import { GRID_MAX_ROWS, type PanelGeometry } from '@/lib/dashboard/grid'
import { defaultDashboardDocument } from '@/lib/dashboard/preset'
import { DEFAULT_TIME_WINDOW, type DashboardPage } from '@/lib/dashboard/schema'
import type { PanelType } from '@/lib/dashboard/panels'
import { panelGeometry } from '@/test/gridEngine'

// The real grid engine, which only a real layout engine can drive: the #79
// acceptance criteria that depend on measurement. Fit-to-viewport (row height
// divided out of a measured container) and the responsive collapse both run on
// ResizeObserver paths that jsdom never fires. Drag, resize and the row cap
// are edit-mode behavior and belong to the #87 suite.
//
// Tailwind classes do not apply here (the browser project runs no Tailwind
// build), so assertions read the engine's own geometry — element rects and the
// gs-* attributes — never the product styling.

function page(panels: Array<[string, PanelType, PanelGeometry]>): DashboardPage {
  return {
    id: 'p',
    name: 'P',
    panels: panels.map(([id, type, geometry]) => ({
      id,
      type,
      geometry,
      binding: FOLLOW,
      window: DEFAULT_TIME_WINDOW,
    })),
  }
}

function Harness({ width, height, content }: { width: number; height: number; content: DashboardPage }) {
  return (
    <MetricsStoreProvider>
      <div style={{ width, height }}>
        {/* Keyed by page, as the application keys the editor around it: a
            different page is a fresh grid. */}
        <GridPage key={content.id} page={content} />
      </div>
    </MetricsStoreProvider>
  )
}

describe('the grid page in a real layout engine', () => {
  it('fits the viewport: the measured container height is divided into rows, and a full page does not overflow', async () => {
    const content = page([
      ['top', 'cpu-utilization', { x: 0, y: 0, w: 12, h: 4 }],
      ['bottom', 'memory', { x: 0, y: 4, w: 12, h: 4 }],
    ])
    const { container } = render(<Harness width={800} height={480} content={content} />)

    await waitFor(() => {
      const items = [...container.querySelectorAll('.grid-stack-item')]
      expect(items).toHaveLength(2)
      const outer = container.querySelector('.grid-stack')!.getBoundingClientRect()
      const bottoms = items.map((el) => el.getBoundingClientRect().bottom)
      // Filled to the bottom row — proof the row height came from the measured
      // 480px, not from the pre-measurement fallback (which would give 640).
      expect(Math.max(...bottoms) - outer.top).toBeLessThanOrEqual(481)
      expect(Math.max(...bottoms) - outer.top).toBeGreaterThan(432) // 90% of 480
    })
  })

  it('collapses to one column below the breakpoint — uncapped — and restores the authored layout exactly', async () => {
    // Stacked single-column: 5 + 5 = 10 rows, deliberately more than the
    // 8-row cap, proving the phone stack is not clamped into the cap.
    const content = page([
      ['left', 'cpu-utilization', { x: 0, y: 0, w: 6, h: 5 }],
      ['right', 'memory', { x: 6, y: 0, w: 6, h: 5 }],
    ])
    const { container, rerender } = render(<Harness width={800} height={480} content={content} />)

    await waitFor(() => {
      expect(panelGeometry(container).get('right')).toMatchObject({ x: 6, y: 0, w: 6 })
    })

    // Narrow: both panels full-width in one column, stacked in reading order.
    rerender(<Harness width={360} height={480} content={content} />)
    await waitFor(() => {
      const items = panelGeometry(container)
      expect(items.get('left')).toMatchObject({ x: 0, w: 1, h: 5 })
      expect(items.get('right')).toMatchObject({ x: 0, w: 1, h: 5 })
      const ys = [items.get('left')!.y, items.get('right')!.y].sort((a, b) => a - b)
      expect(ys).toEqual([0, 5]) // 10 rows deep — nothing squeezed into the cap
    })

    // Wide again: the authored desktop layout, not a recompacted approximation.
    rerender(<Harness width={800} height={480} content={content} />)
    await waitFor(() => {
      const items = panelGeometry(container)
      expect(items.get('left')).toMatchObject({ x: 0, y: 0, w: 6, h: 5 })
      expect(items.get('right')).toMatchObject({ x: 6, y: 0, w: 6, h: 5 })
    })
  })

  it('lays the shipped preset out to fill a desktop, and stacks it in reading order on a phone', async () => {
    // The preset's own acceptance criteria (#86), which only a layout engine
    // can answer: a fresh install fits the viewport without scrolling, and the
    // same document collapses to one readable column on a phone.
    const [preset] = defaultDashboardDocument().pages
    const { container, rerender } = render(<Harness width={1440} height={800} content={preset} />)

    await waitFor(() => {
      const items = [...container.querySelectorAll('.grid-stack-item')]
      expect(items).toHaveLength(preset.panels.length)
      const outer = container.querySelector('.grid-stack')!.getBoundingClientRect()
      const filled = Math.max(...items.map((el) => el.getBoundingClientRect().bottom)) - outer.top
      // Reaches the bottom row and does not pass it: the preset tiles the grid
      // exactly, so "fills the viewport" and "does not scroll" are one check.
      expect(filled).toBeLessThanOrEqual(801)
      expect(filled).toBeGreaterThan(720)
    })

    rerender(<Harness width={390} height={800} content={preset} />)
    await waitFor(() => {
      const items = panelGeometry(container)
      expect(items.size).toBe(preset.panels.length)
      for (const [id, geometry] of items) {
        expect(geometry, id).toMatchObject({ x: 0, w: 1 })
      }
      // Desktop reading order — left to right, then down — is the order the
      // column is in, so the phone reads as the same dashboard.
      const stacked = [...items.entries()].sort((a, b) => a[1].y - b[1].y).map(([id]) => id)
      const authored = [...preset.panels]
        .sort((a, b) => a.geometry.y - b.geometry.y || a.geometry.x - b.geometry.x)
        .map((panel) => panel.id)
      expect(stacked).toEqual(authored)
    })
  })

  it('keeps every panel subtree mounted through the engine’s DOM manipulation', async () => {
    const content = page([['only', 'memory', { x: 0, y: 0, w: 6, h: 4 }]])
    const { container, getByRole } = render(
      <Harness width={800} height={480} content={content} />,
    )

    await waitFor(() => {
      // The panel content rendered through the portal, inside the engine's own
      // item element — the frame carries its accessible name.
      expect(getByRole('region', { name: 'Memory' })).toBeTruthy()
      expect(container.querySelector('.grid-stack-item .grid-stack-item-content')).toBeTruthy()
    })
  })
})

describe('a page opened at phone width', () => {
  // Every spec above starts wide and narrows. A phone never does: its page is
  // one column from the first frame, and every page switch mounts a fresh grid
  // at that width. Narrowing sorts the panels into reading order; mounting
  // narrow has to come out the same (#139).

  it('stacks the shipped preset in reading order from the first frame', async () => {
    const [preset] = defaultDashboardDocument().pages
    const { container } = render(<Harness width={390} height={800} content={preset} />)

    // Nothing has been painted yet, so this is the frame a phone shows first:
    // already the stack, rather than the desktop layout or a stack about to be
    // shuffled into order.
    expectReadingOrderStack(container, preset)

    // And still the stack once the container has been measured.
    await settled(container, 800)
    expectReadingOrderStack(container, preset)
  })

  it('stacks a page stored out of reading order in reading order, and the page switched to next', async () => {
    const { container, rerender } = render(
      <Harness width={390} height={800} content={STORED_OUT_OF_ORDER} />,
    )
    expectReadingOrderStack(container, STORED_OUT_OF_ORDER)
    await settled(container, 800)
    expectReadingOrderStack(container, STORED_OUT_OF_ORDER)

    const [preset] = defaultDashboardDocument().pages
    rerender(<Harness width={390} height={800} content={preset} />)
    expectReadingOrderStack(container, preset)
    await settled(container, 800)
    expectReadingOrderStack(container, preset)
  })

  it('gives every panel its authored cells back when widened, and stacks them again when narrowed', async () => {
    const { container, rerender } = render(
      <Harness width={390} height={800} content={STORED_OUT_OF_ORDER} />,
    )
    await settled(container, 800)

    rerender(<Harness width={1280} height={800} content={STORED_OUT_OF_ORDER} />)
    await waitFor(() => {
      const cells = panelGeometry(container)
      for (const panel of STORED_OUT_OF_ORDER.panels) {
        expect(cells.get(panel.id), panel.id).toEqual(panel.geometry)
      }
    })

    rerender(<Harness width={390} height={800} content={STORED_OUT_OF_ORDER} />)
    await waitFor(() => expectReadingOrderStack(container, STORED_OUT_OF_ORDER))
  })
})

/**
 * A page whose panels are stored in an order that is not its reading order
 * (cpu, slo, memory, disk, net), as an operator's edits leave them.
 *
 * The heights are uneven, so a panel stacked out of turn leaves rows empty.
 * And one panel is a single column wide at the left edge, so it already fits a
 * one-column grid as it is: unless the grid collapsed from the authored layout,
 * nothing has recorded its desktop cells for widening to restore.
 */
const STORED_OUT_OF_ORDER = page([
  ['memory', 'memory', { x: 0, y: 3, w: 6, h: 2 }],
  ['net', 'network-io', { x: 0, y: 5, w: 1, h: 3 }],
  ['disk', 'disk-io', { x: 6, y: 4, w: 6, h: 4 }],
  ['slo', 'engine-slo-goodput', { x: 6, y: 0, w: 6, h: 4 }],
  ['cpu', 'cpu-utilization', { x: 0, y: 0, w: 6, h: 3 }],
])

/** Desktop reading order: by row, then by column, of the authored geometry. */
function readingOrder(content: DashboardPage): string[] {
  return [...content.panels]
    .sort((a, b) => a.geometry.y - b.geometry.y || a.geometry.x - b.geometry.x)
    .map((panel) => panel.id)
}

/**
 * The page is one full-width column, top to bottom in reading order, and no
 * row between two panels is empty.
 *
 * Width and order are read off where the panels are drawn rather than off the
 * engine's numbers, so a panel still on its way into the stack does not pass.
 */
function expectReadingOrderStack(container: HTMLElement, content: DashboardPage): void {
  const grid = container.querySelector('.grid-stack')!.getBoundingClientRect()
  const drawn = [...container.querySelectorAll('.grid-stack-item')].map((el) => ({
    id: el.getAttribute('gs-id')!,
    box: el.getBoundingClientRect(),
  }))
  expect(drawn).toHaveLength(content.panels.length)
  for (const { id, box } of drawn) {
    expect(Math.round(box.width), `${id} spans the page`).toBe(Math.round(grid.width))
  }

  const stacked = drawn.sort((a, b) => a.box.top - b.box.top).map(({ id }) => id)
  expect(stacked).toEqual(readingOrder(content))

  // Each panel starts on the row the one above it ends on.
  const cells = panelGeometry(container)
  let row = 0
  for (const id of stacked) {
    expect(cells.get(id), id).toMatchObject({ x: 0, y: row, w: 1 })
    row += cells.get(id)!.h
  }
}

/**
 * Waits for the grid to have arrived: the row height divided out of the
 * measured container, and no panel still moving to where the engine put it.
 */
async function settled(container: HTMLElement, height: number): Promise<void> {
  await waitFor(() => {
    const grid = container.querySelector<HTMLElement>('.grid-stack')!
    expect(grid.style.getPropertyValue('--gs-cell-height')).toBe(
      `${Math.floor(height / GRID_MAX_ROWS)}px`,
    )
    for (const item of container.querySelectorAll('.grid-stack-item')) {
      expect(item.getAnimations()).toEqual([])
    }
  })
}
