import { useLayoutEffect, type RefObject } from 'react'
import { placePopover } from '@/lib/popoverPlacement'

/**
 * Keeps a `position: fixed` popover next to its trigger and inside the
 * viewport, for as long as `active` is true.
 *
 * For a popover rendered outside the clipping containers it opens from — a
 * portal — which therefore cannot be laid out relative to its trigger by CSS.
 * The placement is `placePopover`'s; this hook supplies the boxes, and places
 * again whenever they can have moved: a scroll of any ancestor (the stacked
 * grid on a phone scrolls its own container, not the page), a resize of the
 * window, or a change in the popover's own size.
 *
 * The coordinates are written straight onto the element rather than held in
 * state: they change on every scroll frame, and nothing else in the render
 * depends on them. It runs as a layout effect, so the popover is placed before
 * the frame it first appears in is painted.
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
      popover.style.top = `${top}px`
      popover.style.left = `${left}px`
    }

    place()
    // Capture, because scroll does not bubble: this hears every scroller.
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    observer?.observe(popover)

    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
      observer?.disconnect()
    }
  }, [active, anchorRef, popoverRef])
}
