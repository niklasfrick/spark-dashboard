import { describe, expect, it } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { GridPage } from '@/components/grid/GridPage'
import { MetricsStoreProvider } from '@/hooks/MetricsStoreProvider'
import { FOLLOW } from '@/lib/dashboard/bindings'
import type { PanelGeometry } from '@/lib/dashboard/grid'
import { DEFAULT_TIME_WINDOW, type DashboardPage } from '@/lib/dashboard/schema'
import type { PanelType } from '@/lib/dashboard/panels'

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
        <GridPage page={content} />
      </div>
    </MetricsStoreProvider>
  )
}

/** The engine's geometry for each item, with gridstack's sparse defaults filled in. */
function itemGeometry(container: HTMLElement): Map<string, PanelGeometry> {
  const found = new Map<string, PanelGeometry>()
  for (const el of container.querySelectorAll('.grid-stack-item')) {
    const id = el.getAttribute('gs-id')
    if (!id) continue
    found.set(id, {
      x: Number(el.getAttribute('gs-x') ?? 0),
      y: Number(el.getAttribute('gs-y') ?? 0),
      // The library omits values equal to its defaults — missing means 1.
      w: Number(el.getAttribute('gs-w') ?? 1),
      h: Number(el.getAttribute('gs-h') ?? 1),
    })
  }
  return found
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
      expect(itemGeometry(container).get('right')).toMatchObject({ x: 6, y: 0, w: 6 })
    })

    // Narrow: both panels full-width in one column, stacked in reading order.
    rerender(<Harness width={360} height={480} content={content} />)
    await waitFor(() => {
      const items = itemGeometry(container)
      expect(items.get('left')).toMatchObject({ x: 0, w: 1, h: 5 })
      expect(items.get('right')).toMatchObject({ x: 0, w: 1, h: 5 })
      const ys = [items.get('left')!.y, items.get('right')!.y].sort((a, b) => a - b)
      expect(ys).toEqual([0, 5]) // 10 rows deep — nothing squeezed into the cap
    })

    // Wide again: the authored desktop layout, not a recompacted approximation.
    rerender(<Harness width={800} height={480} content={content} />)
    await waitFor(() => {
      const items = itemGeometry(container)
      expect(items.get('left')).toMatchObject({ x: 0, y: 0, w: 6, h: 5 })
      expect(items.get('right')).toMatchObject({ x: 6, y: 0, w: 6, h: 5 })
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
