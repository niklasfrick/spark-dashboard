import { useLayoutEffect, type RefObject } from 'react'
import { placePopover } from '@/lib/popoverPlacement'

/**
 * Keeps a `position: fixed` popover next to its trigger and inside the
 * viewport, for as long as `active` is true.
 *
 * For a popover rendered outside the clipping containers it opens from — a
 * portal — which therefore cannot be laid out relative to its trigger by CSS.
 * The placement is `placePopover`'s; this hook supplies the boxes, and places
 * again in every frame in which any of them has moved.
 *
 * Every frame, because the trigger can move with no event to say so. The grid
 * animates its panels to a new row height for 300ms after the window has
 * finished resizing, and it does the same when a notice above the page takes
 * some of its height, which fires no event at all. No observer reports an
 * element's position either; ResizeObserver only sees its size. So the boxes
 * are read once a frame while the popover is open, which also covers a scroll
 * of any ancestor (the stacked grid on a phone scrolls its own container, not
 * the page), a resized window and a popover that changes size. Nothing runs
 * while it is closed, and a frame in which nothing moved writes nothing.
 *
 * The coordinates are written straight onto the element rather than held in
 * state: they change on every frame of a move, and nothing else in the render
 * depends on them. The first placement runs as a layout effect, so the popover
 * is placed before the frame it first appears in is painted.
 */
export function useAnchoredPosition(
  active: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  popoverRef: RefObject<HTMLElement | null>,
): void {
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const popover = popoverRef.current
    if (!active || !anchor || !popover) return

    let placed = ''
    function place() {
      if (!anchor || !popover) return
      const box = popover.getBoundingClientRect()
      const { top, left } = placePopover(
        anchor.getBoundingClientRect(),
        { width: box.width, height: box.height },
        {
          width: document.documentElement.clientWidth,
          height: document.documentElement.clientHeight,
        },
      )
      const at = `${top},${left}`
      if (at === placed) return
      placed = at
      popover.style.top = `${top}px`
      popover.style.left = `${left}px`
    }

    place()
    let frame = requestAnimationFrame(function follow() {
      place()
      frame = requestAnimationFrame(follow)
    })

    return () => cancelAnimationFrame(frame)
  }, [active, anchorRef, popoverRef])
}
