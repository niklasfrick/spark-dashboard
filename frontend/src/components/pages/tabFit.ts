/**
 * How many page tabs the header shows, and which ones go in the overflow menu.
 *
 * The header is a fixed strip that also carries the product title and the
 * connection badge, so a dashboard with a dozen pages cannot simply grow more
 * tabs — past some number they would push the badge off the end, or wrap the
 * masthead onto a second line and cost the grid below the very viewport height
 * the whole layout is built to fit. Tabs that do not fit move into a menu
 * instead, which is what keeps the header usable at any page count.
 *
 * The decision is a pure function of measured widths so it can be reasoned about
 * and tested without a browser; the measuring itself is `PageTabs`'s job.
 *
 * **Zero available width means unmeasured, not "no room".** jsdom measures every
 * box as 0×0, and so does the first frame before layout — concluding "nothing
 * fits" from that would hide every tab behind a menu on a header that has not
 * been laid out yet, which is precisely the wrong default. Unmeasured shows
 * everything, exactly as an unmeasured grid refuses to conclude anything about a
 * drop.
 */

/** Horizontal gap between tabs, in px. Must match the strip's `gap-*` class. */
export const TAB_GAP = 4

/**
 * Width reserved for the overflow button, in px. A constant rather than a
 * measurement: the button only exists when something overflows, so measuring it
 * would make its width depend on the answer it is an input to. Generous enough
 * to cover its widest label, and being a little conservative only ever moves one
 * more tab into a menu that is already open for business.
 */
export const OVERFLOW_BUTTON_WIDTH = 76

/** Which tabs are on the strip and which are behind the menu, as indices. */
export interface TabLayout {
  /** In document order, so the tabs never reshuffle under the pointer. */
  visible: number[]
  overflow: number[]
}

/**
 * The tabs that fit in `available` px, given each tab's natural width.
 *
 * **The page being viewed is always one of them.** When it sits past the point
 * where the strip runs out, it takes the place of the leading tabs that would
 * otherwise have filled the space — the operator is never left looking at a
 * header that does not say where they are. Everything else fills in from the
 * front, in document order.
 */
export function fitTabs(
  widths: readonly number[],
  activeIndex: number,
  available: number,
): TabLayout {
  const all = widths.map((_, index) => index)
  if (available <= 0 || rowWidth(widths, all) <= available) return { visible: all, overflow: [] }

  // Something is overflowing, so the menu button is on screen and costs width.
  const budget = available - OVERFLOW_BUTTON_WIDTH - TAB_GAP
  const active = activeIndex >= 0 && activeIndex < widths.length ? activeIndex : null

  const chosen = new Set<number>()
  let used = 0

  /** Spends the width one more tab costs, gap included once there is a tab to sit beside. */
  const place = (index: number) => {
    used += widths[index] + (chosen.size > 0 ? TAB_GAP : 0)
    chosen.add(index)
  }

  // The active tab is not negotiable, so its width comes off the top — even when
  // it is the only thing that fits, and even when it does not.
  if (active !== null) place(active)

  for (const index of all) {
    if (chosen.has(index)) continue
    if (used + widths[index] + (chosen.size > 0 ? TAB_GAP : 0) > budget) break
    place(index)
  }

  return {
    visible: all.filter((index) => chosen.has(index)),
    overflow: all.filter((index) => !chosen.has(index)),
  }
}

/** What a row of these tabs measures, gaps between them included. */
function rowWidth(widths: readonly number[], indices: readonly number[]): number {
  if (indices.length === 0) return 0
  const tabs = indices.reduce((total, index) => total + widths[index], 0)
  return tabs + TAB_GAP * (indices.length - 1)
}
