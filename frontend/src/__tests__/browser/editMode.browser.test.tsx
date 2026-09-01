import { describe, expect, it } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { GridPageEditor } from '@/components/grid/GridPageEditor'
import { MetricsStoreProvider } from '@/hooks/MetricsStoreProvider'
import { FOLLOW } from '@/lib/dashboard/bindings'
import type { PanelGeometry } from '@/lib/dashboard/grid'
import { DEFAULT_TIME_WINDOW, type DashboardPage } from '@/lib/dashboard/schema'
import type { PanelType } from '@/lib/dashboard/panels'

// Out of room, in a real layout engine (#83). Everything about this is
// measurement: the engine refuses a move by simulating it and keeping the old
// layout, and telling that apart from a drag the operator simply took back
// needs the pixels the panel was left on. jsdom measures every box as 0×0, so
// this can only be shown here.
//
// Deliberately one case. Drag, resize, save-reload and stacking are the #87
// suite; this is the criterion that is #83's own, and the fiddliest interaction
// in the rework.
//
// The drag is driven with **mouse** events, not pointer events: the library
// binds mousedown on the item's content and then move and release on the
// document. Pointer-based helpers silently do nothing, which looks exactly like
// a library defect.

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

function Harness({ content, width = 800 }: { content: DashboardPage; width?: number }) {
  return (
    <MetricsStoreProvider>
      <div style={{ width, height: 480 }}>
        <GridPageEditor page={content} readOnly={false} onSave={async () => 'saved' as const} />
      </div>
    </MetricsStoreProvider>
  )
}

/** Drags an element by a pixel offset, the way the library listens for it. */
function dragBy(element: Element, dx: number, dy: number) {
  const box = element.getBoundingClientRect()
  const from = { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }
  const at = (fraction: number) => ({
    clientX: from.clientX + dx * fraction,
    clientY: from.clientY + dy * fraction,
    bubbles: true,
    button: 0,
  })

  element.dispatchEvent(new MouseEvent('mousedown', { ...from, bubbles: true, button: 0 }))
  // Several moves: the library needs to pass its own start threshold before it
  // is dragging at all, and the last one is what the drop is judged against.
  for (const fraction of [0.1, 0.4, 0.7, 1]) {
    document.dispatchEvent(new MouseEvent('mousemove', at(fraction)))
  }
  document.dispatchEvent(new MouseEvent('mouseup', at(1)))
}

describe('a move the page has no room for', () => {
  it('is refused, and says so instead of snapping back in silence', async () => {
    // A page filled to its cap, and filled unevenly, so there is nothing the
    // engine could swap or push to make the move work.
    const content = page([
      ['top', 'cpu-utilization', { x: 0, y: 0, w: 12, h: 4 }],
      ['bottom', 'memory', { x: 0, y: 4, w: 6, h: 4 }],
      ['beside', 'gpu-utilization', { x: 6, y: 4, w: 6, h: 4 }],
    ])
    const { container, getByRole, queryByRole } = render(<Harness content={content} />)

    await waitFor(() => expect(container.querySelectorAll('.grid-stack-item')).toHaveLength(3))
    act(() => getByRole('button', { name: 'Edit layout' }).click())
    await waitFor(() => expect(getByRole('button', { name: 'Save layout' })).toBeTruthy())

    // Nothing has been refused yet, so nothing is being said about room.
    expect(queryByRole('alert')).toBeNull()

    // Wait for the measured row height before dragging in row-sized units: the
    // grid is 8 rows of a divided container, so until it has been measured a
    // pixel offset means a different number of rows than the drag intends.
    const item = container.querySelector('[gs-id="bottom"]')!
    await waitFor(() => {
      const grid = container.querySelector('.grid-stack')!.getBoundingClientRect()
      expect(item.getBoundingClientRect().bottom - grid.top).toBeLessThanOrEqual(grid.height + 1)
    })

    // Half its own height is two of the four rows it covers: enough to run the
    // page past its cap, whatever the measured row height turned out to be.
    const bottom = item.querySelector('.grid-stack-item-content')!
    act(() => dragBy(bottom, 0, item.getBoundingClientRect().height / 2))

    await waitFor(() => {
      expect(getByRole('alert').textContent).toMatch(/No room for “Memory” there/)
      expect(getByRole('alert').textContent).toMatch(/8 rows tall and full/)
    })

    // And the panel is still where it was: a refused move changes nothing.
    expect(container.querySelector('[gs-id="bottom"]')?.getAttribute('gs-y')).toBe('4')
  })

  it('says nothing when the page reflowed around the drop, which is most drags', async () => {
    // The engine swaps and pushes neighbours out of the way, so a panel rarely
    // ends on the exact cells it was dropped on. That is a successful drag, and
    // an operator who is told the page is full after every one of them stops
    // reading the message that matters.
    const content = page([
      ['top', 'cpu-utilization', { x: 0, y: 0, w: 12, h: 4 }],
      ['bottom', 'memory', { x: 0, y: 4, w: 12, h: 4 }],
    ])
    const { container, getByRole, queryByRole } = render(<Harness content={content} />)

    await waitFor(() => expect(container.querySelectorAll('.grid-stack-item')).toHaveLength(2))
    act(() => getByRole('button', { name: 'Edit layout' }).click())

    const item = container.querySelector('[gs-id="bottom"]')!
    await waitFor(() => {
      const grid = container.querySelector('.grid-stack')!.getBoundingClientRect()
      expect(item.getBoundingClientRect().bottom - grid.top).toBeLessThanOrEqual(grid.height + 1)
    })

    // Upward, onto the panel above: room the page does have, once the engine
    // has moved the other one.
    act(() => dragBy(item.querySelector('.grid-stack-item-content')!, 0, -item.getBoundingClientRect().height / 2))

    await waitFor(() => {
      expect(container.querySelector('[gs-id="bottom"]')?.getAttribute('gs-y')).not.toBe('4')
    })
    expect(queryByRole('alert')).toBeNull()
  })
})

describe('a page narrow enough to have stacked', () => {
  it('is not offered for rearranging, because the stack is not what anyone authored', async () => {
    // Below the breakpoint the engine derives a single column from the desktop
    // layout. Dragging there would author cells in a grid one column wide, and
    // saving them would overwrite the arrangement being displayed.
    const content = page([
      ['top', 'cpu-utilization', { x: 0, y: 0, w: 6, h: 4 }],
      ['bottom', 'memory', { x: 6, y: 0, w: 6, h: 4 }],
    ])
    const { getByText, queryByRole } = render(<Harness content={content} width={360} />)

    await waitFor(() => {
      expect(getByText(/Rearranging needs a wider window/)).toBeTruthy()
    })
    expect(queryByRole('button', { name: 'Edit layout' })).toBeNull()
  })
})
