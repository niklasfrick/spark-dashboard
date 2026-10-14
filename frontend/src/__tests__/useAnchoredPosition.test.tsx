import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { useRef } from 'react'
import { useAnchoredPosition } from '@/hooks/useAnchoredPosition'
import { POPOVER_GAP } from '@/lib/popoverPlacement'

// The SLO settings follow their cog once a frame while open, because the grid
// moves panels without any event to say so (#123). The browser spec checks that
// the dialog keeps up in a real layout; this one checks what that costs: the
// boxes are read once a frame while open, and not at all once closed.
//
// jsdom lays nothing out, so the boxes are stubbed and the frames are driven
// by hand.

function Anchored({ active }: { active: boolean }) {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  useAnchoredPosition(active, anchorRef, popoverRef)
  return (
    <>
      <button ref={anchorRef} type="button">
        Cog
      </button>
      <div ref={popoverRef} role="dialog" style={{ position: 'fixed' }} />
    </>
  )
}

/** A cog at `top`, 24px square, against the left of a 1280×800 viewport. */
function cogAt(top: number): DOMRect {
  return DOMRect.fromRect({ x: 200, y: top, width: 24, height: 24 })
}

let anchorBox = cogAt(100)
const readAnchor = vi.fn(() => anchorBox)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] })
  anchorBox = cogAt(100)
  readAnchor.mockClear()
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1280)
  vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(800)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Renders closed, gives the cog its box, then opens. */
function renderOpen() {
  const view = render(<Anchored active={false} />)
  const anchor = view.getByRole('button', { name: 'Cog' })
  anchor.getBoundingClientRect = readAnchor
  view.rerender(<Anchored active />)
  return { ...view, popover: view.getByRole('dialog') }
}

describe('useAnchoredPosition', () => {
  it('places the popover when it opens, and moves it in the next frame when the cog moves', () => {
    const { popover } = renderOpen()
    expect(popover.style.top).toBe(`${100 + 24 + POPOVER_GAP}px`)

    // No scroll, no resize: the grid moved the panel the cog sits in.
    anchorBox = cogAt(180)
    vi.advanceTimersToNextFrame()

    expect(popover.style.top).toBe(`${180 + 24 + POPOVER_GAP}px`)
  })

  it('reads the cog once a frame while open, and never once closed', () => {
    const { rerender } = renderOpen()
    const atOpen = readAnchor.mock.calls.length
    vi.advanceTimersToNextFrame()
    vi.advanceTimersToNextFrame()
    expect(readAnchor.mock.calls.length).toBe(atOpen + 2)

    rerender(<Anchored active={false} />)
    const atClose = readAnchor.mock.calls.length
    vi.advanceTimersToNextFrame()
    vi.advanceTimersToNextFrame()

    expect(readAnchor.mock.calls.length).toBe(atClose)
    expect(vi.getTimerCount()).toBe(0)
  })
})
