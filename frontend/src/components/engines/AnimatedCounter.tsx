/**
 * A number that tweens up to its target with a quick ease-out animation,
 * rendered through a caller-supplied formatter (e.g. K/M/B abbreviation).
 *
 * Behavior:
 * - Counts UP only. vLLM token counters reset to a lower value on engine
 *   restart; we snap straight to a lower target instead of animating
 *   backward, then resume count-up from there.
 * - Honors `prefers-reduced-motion`: snaps directly to the value, no tween.
 * - `null` renders as `--` with no animation.
 */

import { useEffect, useRef, useState } from 'react'

interface AnimatedCounterProps {
  value: number | null
  format: (n: number) => string
  className?: string
  /** Tween duration in ms. */
  durationMs?: number
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

// Ease-out cubic: fast start, gentle settle.
function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

export function AnimatedCounter({
  value,
  format,
  className,
  durationMs = 550,
}: AnimatedCounterProps) {
  const [display, setDisplay] = useState<number | null>(value)
  const displayRef = useRef<number | null>(value)
  const rafRef = useRef<number | null>(null)
  const [prevValue, setPrevValue] = useState<number | null>(value)

  // A target we snap to rather than animate towards is derived state, so it is
  // applied during render. Doing it from the effect below would commit one
  // frame of the stale number before correcting it.
  //
  // `display` is read here instead of `displayRef` — during render the state
  // itself is the committed value the ref mirrors, and refs must not be read
  // while rendering. The effect syncing `display` into `displayRef` is
  // declared first, so the animation effect below still sees the snapped
  // value without the ref being written during render.
  if (prevValue !== value) {
    setPrevValue(value)
    const from = display
    // No previous numeric value, reduced motion, or a counter reset
    // (target below current) -> snap, never animate downward.
    if (
      value === null ||
      from === null ||
      from === value ||
      prefersReducedMotion() ||
      value < from
    ) {
      setDisplay(value)
    }
  }

  useEffect(() => {
    displayRef.current = display
  }, [display])

  useEffect(() => {
    const cancel = () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }

    if (value === null) {
      cancel()
      return
    }

    const from = displayRef.current
    // Snapped during render — nothing left to animate.
    if (from === null || from === value || prefersReducedMotion() || value < from) {
      cancel()
      return
    }

    const start = performance.now()
    const delta = value - from

    const tick = (now: number) => {
      const elapsed = now - start
      const t = Math.min(1, elapsed / durationMs)
      const next = from + delta * easeOut(t)
      if (t >= 1) {
        setDisplay(value)
        rafRef.current = null
      } else {
        setDisplay(next)
        rafRef.current = requestAnimationFrame(tick)
      }
    }

    cancel()
    rafRef.current = requestAnimationFrame(tick)
    return cancel
  }, [value, durationMs])

  return (
    <span className={className}>
      {display === null ? '--' : format(display)}
    </span>
  )
}
