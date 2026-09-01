/**
 * When a page is showing the collapsed single column rather than the layout the
 * operator authored.
 *
 * Its own module because two components have to mean exactly the same thing by
 * it: the grid, which goes static and drops its row cap when the column
 * collapses, and the edit bar above it, which withholds saving for as long as
 * that is true. Two answers to this question would leave a stacked grid
 * draggable and a phone layout saveable over a desktop one.
 */

/**
 * Container width in px at or below which the grid collapses to one column.
 * The collapse is the engine's own responsive path, driven by the grid
 * element's measured size (`breakpointForWindow` defaults to false): gridstack
 * caches the authored 12-column layout before collapsing and restores it
 * verbatim on the way back, which the #68 spike confirmed is lossless. Never
 * persist what the collapsed grid looks like.
 */
export const SINGLE_COLUMN_BREAKPOINT = 640

/** Zero width is not narrow — it is unmeasured, which is what jsdom and the
 *  first frame before layout both report. */
export function isNarrow(width: number): boolean {
  return width > 0 && width <= SINGLE_COLUMN_BREAKPOINT
}
