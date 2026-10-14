import { describe, expect, it } from 'vitest'
import { placePopover, POPOVER_GAP, VIEWPORT_MARGIN, type AnchorBox } from './popoverPlacement'

// The SLO settings dialog is 14rem wide and about 200px tall; the cog is 24px.
const DIALOG = { width: 224, height: 200 }
const LAPTOP = { width: 1280, height: 800 }

/** A 24px trigger with its top-left corner at (x, y). */
function cogAt(x: number, y: number): AnchorBox {
  return { left: x, top: y, right: x + 24, bottom: y + 24 }
}

describe('placePopover', () => {
  it('opens below the trigger with right edges aligned when there is room', () => {
    const cog = cogAt(600, 100)

    expect(placePopover(cog, DIALOG, LAPTOP)).toEqual({
      top: cog.bottom + POPOVER_GAP,
      left: cog.right - DIALOG.width,
    })
  })

  it('opens rightwards from a trigger at the left of the page', () => {
    // A single-engine host: the cog leads the panel's actions row, and the
    // panel sits at the page's left edge.
    const cog = cogAt(20, 100)

    expect(placePopover(cog, DIALOG, LAPTOP)).toEqual({
      top: cog.bottom + POPOVER_GAP,
      left: cog.left,
    })
  })

  it('shifts in from the right edge of the viewport', () => {
    const cog = cogAt(LAPTOP.width - 26, 100)

    expect(placePopover(cog, DIALOG, LAPTOP).left).toBe(
      LAPTOP.width - VIEWPORT_MARGIN - DIALOG.width,
    )
  })

  it('shifts in from the left edge when neither alignment fits there', () => {
    // A trigger hard against the left edge, and a popover wider than the room
    // to its left: aligned to the trigger it would still touch the edge.
    const cog = cogAt(2, 100)

    expect(placePopover(cog, DIALOG, LAPTOP).left).toBe(VIEWPORT_MARGIN)
  })

  it('flips above a trigger near the bottom of the viewport', () => {
    const cog = cogAt(600, 700)

    expect(placePopover(cog, DIALOG, LAPTOP).top).toBe(cog.top - POPOVER_GAP - DIALOG.height)
  })

  it('shifts up to fit when there is room neither below nor above', () => {
    const short = { width: 1280, height: 300 }
    const cog = cogAt(600, 120)

    expect(placePopover(cog, DIALOG, short).top).toBe(
      short.height - VIEWPORT_MARGIN - DIALOG.height,
    )
  })

  it('keeps the top-left corner on screen when the viewport is smaller than the popover', () => {
    const tiny = { width: 200, height: 150 }

    expect(placePopover(cogAt(150, 100), DIALOG, tiny)).toEqual({
      top: VIEWPORT_MARGIN,
      left: VIEWPORT_MARGIN,
    })
  })

  it('stays inside the viewport wherever the trigger is', () => {
    for (let x = 0; x <= LAPTOP.width - 24; x += 64) {
      for (let y = 0; y <= LAPTOP.height - 24; y += 64) {
        const { top, left } = placePopover(cogAt(x, y), DIALOG, LAPTOP)

        expect(left, `left at (${x}, ${y})`).toBeGreaterThanOrEqual(VIEWPORT_MARGIN)
        expect(top, `top at (${x}, ${y})`).toBeGreaterThanOrEqual(VIEWPORT_MARGIN)
        expect(left + DIALOG.width, `right at (${x}, ${y})`).toBeLessThanOrEqual(
          LAPTOP.width - VIEWPORT_MARGIN,
        )
        expect(top + DIALOG.height, `bottom at (${x}, ${y})`).toBeLessThanOrEqual(
          LAPTOP.height - VIEWPORT_MARGIN,
        )
      }
    }
  })
})
