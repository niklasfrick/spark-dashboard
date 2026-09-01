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
  dragFrom(element, { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }, dx, dy)
}

/**
 * Pulls a panel's bottom-right corner by a pixel offset.
 *
 * The grab starts at the panel's own corner rather than at the handle's box: the
 * library autohides the handle, so it measures 0×0 until hovered, and a resize
 * that begins at the origin is one the library reads as dragging the corner in
 * from the far left — it shrinks the panel sideways instead.
 */
function resizeBy(item: HTMLElement, dx: number, dy: number) {
  const box = item.getBoundingClientRect()
  const handle = item.querySelector('.ui-resizable-se')!
  dragFrom(handle, { clientX: box.right, clientY: box.bottom }, dx, dy)
}

function dragFrom(
  element: Element,
  from: { clientX: number; clientY: number },
  dx: number,
  dy: number,
) {
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

/**
 * The named item, once the grid has actually been measured.
 *
 * Every drag here is expressed in the item's own height, so a drag started
 * before the ResizeObserver has fired covers a different number of rows than it
 * means to — which looks exactly like the feature not working. A four-row panel
 * in an eight-row grid is half the grid tall; the pre-measurement fallback row
 * height is not.
 */
async function measuredItem(container: HTMLElement, id: string): Promise<HTMLElement> {
  const item = container.querySelector(`[gs-id="${id}"]`) as HTMLElement

  await waitFor(() => {
    const grid = container.querySelector('.grid-stack')!.getBoundingClientRect()
    // Half the grid, less a margin's worth. The item's own size lags the row
    // height by a frame, so "taller than the fallback" is not enough of a
    // condition — it passes while the panel is still catching up.
    expect(item.getBoundingClientRect().height).toBeGreaterThan(grid.height * 0.45)
  })

  return item
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

    // Half its own height is two of the four rows it covers: enough to run the
    // page past its cap, whatever the measured row height turned out to be.
    const item = await measuredItem(container, 'bottom')
    act(() => dragBy(item.querySelector('.grid-stack-item-content')!, 0, item.offsetHeight / 2))

    await waitFor(() => {
      expect(getByRole('alert').textContent).toMatch(/No room for “Memory” there/)
      expect(getByRole('alert').textContent).toMatch(/8 rows tall/)
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

    // Upward, onto the panel above: room the page does have, once the engine
    // has moved the other one.
    const item = await measuredItem(container, 'bottom')
    act(() => dragBy(item.querySelector('.grid-stack-item-content')!, 0, -item.offsetHeight / 2))

    await waitFor(() => {
      expect(container.querySelector('[gs-id="bottom"]')?.getAttribute('gs-y')).not.toBe('4')
    })
    expect(queryByRole('alert')).toBeNull()
  })
})

describe('a resize the page has no room for', () => {
  it('is refused with the same message a move gets', async () => {
    // The bottom panel already reaches the last row, so there is nothing below
    // it to grow into.
    const content = page([
      ['top', 'cpu-utilization', { x: 0, y: 0, w: 12, h: 4 }],
      ['bottom', 'memory', { x: 0, y: 4, w: 6, h: 4 }],
      ['beside', 'gpu-utilization', { x: 6, y: 4, w: 6, h: 4 }],
    ])
    const { container, getByRole } = render(<Harness content={content} />)

    await waitFor(() => expect(container.querySelectorAll('.grid-stack-item')).toHaveLength(3))
    act(() => getByRole('button', { name: 'Edit layout' }).click())

    // The corner the library makes resizable in edit mode, pulled down by half
    // the panel — two more rows the page does not have.
    const item = await measuredItem(container, 'bottom')
    act(() => resizeBy(item, 0, item.offsetHeight / 2))

    await waitFor(() => {
      expect(getByRole('alert').textContent).toMatch(/No room for “Memory” there/)
    })
    // Still four of the page's eight rows: it had nothing to give. Measured
    // against the grid rather than in pixels, since the row height is whatever
    // dividing the container came to.
    const grid = container.querySelector('.grid-stack')!.getBoundingClientRect()
    expect(item.offsetHeight).toBeLessThan(grid.height * 0.6)
  })
})

describe('a session open when the window narrows', () => {
  it('is suspended rather than ended: nothing drags, nothing saves, the work survives', async () => {
    const content = page([
      ['top', 'cpu-utilization', { x: 0, y: 0, w: 6, h: 4 }],
      ['bottom', 'memory', { x: 6, y: 0, w: 6, h: 4 }],
    ])
    const { container, getByRole, rerender } = render(<Harness content={content} />)

    await waitFor(() => expect(container.querySelectorAll('.grid-stack-item')).toHaveLength(2))
    act(() => getByRole('button', { name: 'Edit layout' }).click())
    await waitFor(() => {
      expect(container.querySelector('.grid-stack')?.classList.contains('grid-stack-static')).toBe(
        false,
      )
    })

    rerender(<Harness content={content} width={360} />)

    await waitFor(() => {
      // Static again, so the stacked column cannot be dragged into an
      // arrangement that has nothing to do with the desktop one…
      expect(container.querySelector('.grid-stack')?.classList.contains('grid-stack-static')).toBe(
        true,
      )
      // …and it cannot be written either, while the session itself is still open.
      expect(getByRole('button', { name: 'Save layout' })).toBeDisabled()
    })
    expect(getByRole('button', { name: 'Discard' })).toBeTruthy()
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
