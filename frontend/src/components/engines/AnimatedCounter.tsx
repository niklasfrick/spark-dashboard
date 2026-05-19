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
      setDisplay(null)
      return
    }

    const from = displayRef.current
    // No previous numeric value, reduced motion, or a counter reset
    // (target below current) -> snap, never animate downward.
    if (from === null || from === value || prefersReducedMotion() || value < from) {
      cancel()
      setDisplay(value)
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
