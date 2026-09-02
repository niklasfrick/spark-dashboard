/**
 * Driving and reading a real grid, for the specs that run in a real browser.
 *
 * Only the browser project ever loads this: the unit project swaps the library
 * for `gridstack.tsx`'s substitute, because jsdom has no layout engine and so
 * has nothing to drag. One copy, for the same reason `configurationServer.ts`
 * is one copy — two spellings of "this is how the library listens for a drag"
 * is how the specs drift from the library they exist to guard.
 *
 * **Drags are driven with mouse events, not pointer events.** The library binds
 * mousedown on the item's content element and then move and release on the
 * document. Pointer-based helpers silently do nothing, which looks exactly like
 * a library defect and costs an afternoon to tell apart from one.
 */

import { expect } from 'vitest'
import { waitFor } from '@testing-library/react'
import { type PanelGeometry } from '@/lib/dashboard/grid'

/**
 * The engine's geometry for each panel, with gridstack's sparse defaults filled
 * in — what the document would store if the layout were saved as it stands.
 */
export function panelGeometry(container: HTMLElement): Map<string, PanelGeometry> {
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

/**
 * The named panel, once the grid has actually been measured.
 *
 * Every gesture here is expressed in the panel's own size, so one started
 * before the row height has settled covers a different number of rows than it
 * means to — which looks exactly like the feature not working, and lands as a
 * drop the page had no room for.
 */
export async function measuredPanel(container: HTMLElement, id: string): Promise<HTMLElement> {
  const item = container.querySelector(`[gs-id="${id}"]`) as HTMLElement

  await waitFor(() => {
    const grid = container.querySelector('.grid-stack')!
    // The row height the engine settled on, from the variable it lays every
    // item out with. Absent until the container has been measured, which parses
    // as NaN and fails the comparison — which is the point.
    const cellHeight = Number.parseFloat(
      getComputedStyle(grid).getPropertyValue('--gs-cell-height'),
    )
    // The panel is as tall as the rows the engine has it covering. Its rendered
    // box lags the row height by an animation rather than a frame, so this waits
    // for the box the gesture will be expressed in, not merely a plausible one.
    const rows = Number(item.getAttribute('gs-h') ?? 1)
    expect(Math.abs(item.getBoundingClientRect().height - rows * cellHeight)).toBeLessThan(1)
  })

  return item
}

/** Drags a panel by a pixel offset, the way the library listens for it. */
export function dragPanelBy(item: HTMLElement, dx: number, dy: number): void {
  const grip = item.querySelector('.grid-stack-item-content')!
  const box = grip.getBoundingClientRect()
  dragFrom(grip, { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }, dx, dy)
}

/**
 * Pulls a panel's bottom-right corner by a pixel offset.
 *
 * The grab starts at the panel's own corner rather than at the handle's box:
 * the library autohides the handle, so it measures 0×0 until hovered, and a
 * resize that begins at the origin is one the library reads as dragging the
 * corner in from the far left — it shrinks the panel sideways instead.
 */
export function resizePanelBy(item: HTMLElement, dx: number, dy: number): void {
  const box = item.getBoundingClientRect()
  const handle = item.querySelector('.ui-resizable-se')!
  dragFrom(handle, { clientX: box.right, clientY: box.bottom }, dx, dy)
}

function dragFrom(
  element: Element,
  from: { clientX: number; clientY: number },
  dx: number,
  dy: number,
): void {
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
