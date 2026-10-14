/**
 * Where a popover anchored to a trigger goes, so that all of it is on screen.
 *
 * A popover that opens from inside a panel cannot be positioned within it: the
 * panel, its frame and the grid all clip, and a dialog cut off at the panel's
 * edge cannot be used. So it is positioned against the viewport instead, from
 * the trigger's own box, and this is the arithmetic that keeps it in view.
 *
 * Pure, so the rules are tested here rather than through a layout engine.
 */

/** The parts of a `DOMRect` placement reads; one is assignable to it. */
export interface AnchorBox {
  top: number
  left: number
  right: number
  bottom: number
}

export interface BoxSize {
  width: number
  height: number
}

/** Viewport coordinates for the popover's top-left corner. */
export interface PopoverPlacement {
  top: number
  left: number
}

/** Between the trigger and the popover. */
export const POPOVER_GAP = 4

/** Kept clear between the popover and the viewport's edges. */
export const VIEWPORT_MARGIN = 8

/**
 * Below the trigger with right edges aligned — where the dashboard's popovers
 * have always opened — unless that leaves the viewport:
 *
 * - **Horizontally**, a popover that would run off the left edge is aligned to
 *   the trigger's left instead, so it opens rightwards. A trigger at the left of
 *   the page is exactly where an operator on a single-engine host finds the
 *   SLO cog. Whatever is chosen is then shifted to fit.
 * - **Vertically**, one with no room below flips above the trigger when there
 *   is room there, and otherwise is shifted up until its bottom fits.
 *
 * When the viewport is smaller than the popover, its top-left corner wins: the
 * start of a dialog is the part that says what it is.
 */
export function placePopover(
  anchor: AnchorBox,
  popover: BoxSize,
  viewport: BoxSize,
): PopoverPlacement {
  const rightAligned = anchor.right - popover.width
  const left = clamp(
    rightAligned >= VIEWPORT_MARGIN ? rightAligned : anchor.left,
    VIEWPORT_MARGIN,
    viewport.width - VIEWPORT_MARGIN - popover.width,
  )

  const below = anchor.bottom + POPOVER_GAP
  const above = anchor.top - POPOVER_GAP - popover.height
  const fitsBelow = below + popover.height <= viewport.height - VIEWPORT_MARGIN
  const top =
    !fitsBelow && above >= VIEWPORT_MARGIN
      ? above
      : clamp(below, VIEWPORT_MARGIN, viewport.height - VIEWPORT_MARGIN - popover.height)

  return { top, left }
}

/** `value` within `[min, max]`, with `min` winning when the range is empty. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}
