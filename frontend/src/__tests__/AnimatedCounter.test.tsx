import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { AnimatedCounter } from '../components/engines/AnimatedCounter'
import { formatCompactTokens } from '../lib/format'

// Drive requestAnimationFrame manually so we can run a tween to completion.
let rafQueue: FrameRequestCallback[] = []
let clock = 0

function flushFrames(steps = 60, dtMs = 16) {
  act(() => {
    for (let i = 0; i < steps; i++) {
      const cbs = rafQueue
      rafQueue = []
      if (cbs.length === 0) break
      clock += dtMs
      cbs.forEach(cb => cb(clock))
    }
  })
}

beforeEach(() => {
  rafQueue = []
  clock = 0
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafQueue.push(cb)
    return rafQueue.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('AnimatedCounter', () => {
  it('renders -- for null without animating', () => {
    render(<AnimatedCounter value={null} format={formatCompactTokens} />)
    expect(screen.getByText('--')).toBeDefined()
  })

  it('tweens up and lands on the final formatted value', () => {
    const { rerender } = render(
      <AnimatedCounter value={1000} format={formatCompactTokens} />,
    )
    // First render snaps (no prior value): shows 1K.
    expect(screen.getByText('1K')).toBeDefined()

    rerender(<AnimatedCounter value={2_000_000} format={formatCompactTokens} />)
    flushFrames()
    expect(screen.getByText('2M')).toBeDefined()
  })

  it('snaps down on a counter reset instead of animating backward', () => {
    const { rerender } = render(
      <AnimatedCounter value={5000} format={formatCompactTokens} />,
    )
    rerender(<AnimatedCounter value={500} format={formatCompactTokens} />)
    // No frames flushed: must already show the lower value (snap, no tween).
    expect(screen.getByText('500')).toBeDefined()
    expect(rafQueue.length).toBe(0)
  })

  it('snaps directly to the value under prefers-reduced-motion', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }) as MediaQueryList)
    const { rerender } = render(
      <AnimatedCounter value={1000} format={formatCompactTokens} />,
    )
    rerender(<AnimatedCounter value={9_000_000} format={formatCompactTokens} />)
    expect(screen.getByText('9M')).toBeDefined()
    expect(rafQueue.length).toBe(0)
  })
})
