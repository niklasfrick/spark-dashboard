import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { AnimatedCounter } from '@/components/engines/AnimatedCounter'
import { LiveMotionContext, useHeldWhileFrozen } from '@/hooks/useLiveMotion'
import { useTabRotation } from '@/hooks/useTabRotation'

// What "the dashboard holds still" means, at the three places motion comes
// from. Edit mode is what freezes them in the product (#83); here each is
// driven directly, because the point is that any page can hold still and none
// of them knows what an edit session is.

function Motion({ live, children }: { live: boolean; children: ReactNode }) {
  return <LiveMotionContext.Provider value={live}>{children}</LiveMotionContext.Provider>
}

describe('a frozen counter', () => {
  beforeEach(() => {
    // A tween would need frames; a frozen counter must need none, so the queue
    // stays unflushed on purpose and anything animating would be caught here.
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the new number at once instead of counting up to it', () => {
    const { rerender } = render(
      <Motion live={false}>
        <AnimatedCounter value={1000} format={String} />
      </Motion>,
    )

    rerender(
      <Motion live={false}>
        <AnimatedCounter value={9000} format={String} />
      </Motion>,
    )

    expect(screen.getByText('9000')).toBeInTheDocument()
  })

  it('lands on its target when the dashboard freezes mid-count', () => {
    const { rerender } = render(
      <Motion live>
        <AnimatedCounter value={1000} format={String} />
      </Motion>,
    )
    rerender(
      <Motion live>
        <AnimatedCounter value={9000} format={String} />
      </Motion>,
    )
    // Mid-tween: no frame has run, so the counter still reads where it started.
    expect(screen.getByText('1000')).toBeInTheDocument()

    rerender(
      <Motion live={false}>
        <AnimatedCounter value={9000} format={String} />
      </Motion>,
    )

    expect(screen.getByText('9000')).toBeInTheDocument()
  })
})

describe('frozen tab rotation', () => {
  function Rotation({ intervalMs = 1000 }: { intervalMs?: number }) {
    const [tab, setTab] = useState('a')
    useTabRotation({
      order: ['a', 'b'],
      activeTab: tab,
      onAdvance: setTab,
      intervalMs,
      enabled: true,
    })
    return <span>{tab}</span>
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not advance while the dashboard is held still, and picks up again after', () => {
    const { rerender } = render(
      <Motion live={false}>
        <Rotation />
      </Motion>,
    )

    act(() => void vi.advanceTimersByTime(5000))
    expect(screen.getByText('a')).toBeInTheDocument()

    rerender(
      <Motion live>
        <Rotation />
      </Motion>,
    )
    act(() => void vi.advanceTimersByTime(1000))

    expect(screen.getByText('b')).toBeInTheDocument()
  })
})

describe('a value held while the dashboard is frozen', () => {
  function Held({ live, value }: { live: boolean; value: string }) {
    return (
      <Motion live={live}>
        <Reader value={value} />
      </Motion>
    )
  }

  function Reader({ value }: { value: string }) {
    return <span>{useHeldWhileFrozen(value)}</span>
  }

  it('keeps what was on screen when motion stopped, then catches up', () => {
    const { rerender } = render(<Held live value="first" />)
    expect(screen.getByText('first')).toBeInTheDocument()

    // Frozen: the panel still re-renders — its geometry moves under the drag —
    // but what it renders is the value it had when the freeze began.
    rerender(<Held live={false} value="first" />)
    rerender(<Held live={false} value="second" />)
    expect(screen.getByText('first')).toBeInTheDocument()

    rerender(<Held live value="second" />)
    expect(screen.getByText('second')).toBeInTheDocument()
  })
})
