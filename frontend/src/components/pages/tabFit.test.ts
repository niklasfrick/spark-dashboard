import { describe, expect, it } from 'vitest'
import { fitTabs, OVERFLOW_BUTTON_WIDTH, TAB_GAP } from './tabFit'

/** The width a strip of `count` equal tabs needs, gaps included. */
function strip(width: number, count: number): number {
  return width * count + TAB_GAP * (count - 1)
}

describe('fitTabs', () => {
  it('shows every tab when the strip has not been measured, rather than hiding them all', () => {
    expect(fitTabs([100, 100, 100], 0, 0)).toEqual({ visible: [0, 1, 2], overflow: [] })
  })

  it('shows every tab when they all fit, with no menu to open', () => {
    expect(fitTabs([100, 100, 100], 0, strip(100, 3))).toEqual({
      visible: [0, 1, 2],
      overflow: [],
    })
  })

  it('counts the gaps between tabs, not just the tabs', () => {
    // One pixel short of the gaps is one pixel short.
    expect(fitTabs([100, 100, 100], 0, strip(100, 3) - 1).overflow).not.toEqual([])
  })

  it('moves the tabs that do not fit into the menu, keeping document order', () => {
    // Room for two tabs beside the menu button, and no more.
    const available = OVERFLOW_BUTTON_WIDTH + TAB_GAP + strip(100, 2)

    expect(fitTabs([100, 100, 100, 100], 0, available)).toEqual({
      visible: [0, 1],
      overflow: [2, 3],
    })
  })

  it('reserves room for the menu button, so it never lands on top of a tab', () => {
    // Four tabs fit exactly — until the button they overflow into is paid for.
    expect(fitTabs([100, 100, 100, 100, 100], 0, strip(100, 4)).visible).toEqual([0, 1, 2])
  })

  it('keeps the page being viewed on the strip when it sits past the fold', () => {
    const available = OVERFLOW_BUTTON_WIDTH + TAB_GAP + strip(100, 2)
    const layout = fitTabs([100, 100, 100, 100], 3, available)

    // The active tab displaces a leading one rather than reordering the strip.
    expect(layout).toEqual({ visible: [0, 3], overflow: [1, 2] })
  })

  it('shows the page being viewed even when it is the only thing that fits', () => {
    expect(fitTabs([100, 400, 100], 1, 200)).toEqual({ visible: [1], overflow: [0, 2] })
  })

  it('fills from the front when the URL names no page in the list', () => {
    const available = OVERFLOW_BUTTON_WIDTH + TAB_GAP + strip(100, 2)

    expect(fitTabs([100, 100, 100, 100], -1, available)).toEqual({
      visible: [0, 1],
      overflow: [2, 3],
    })
  })

  it('stops at the first tab that does not fit, so a narrow tab never jumps a wide one', () => {
    const available = OVERFLOW_BUTTON_WIDTH + TAB_GAP + strip(100, 2)

    // The 300px tab does not fit; the 40px one behind it stays behind it.
    expect(fitTabs([100, 300, 40], 0, available)).toEqual({ visible: [0], overflow: [1, 2] })
  })

  it('has nothing to show for a document with no pages', () => {
    expect(fitTabs([], -1, 500)).toEqual({ visible: [], overflow: [] })
  })
})
