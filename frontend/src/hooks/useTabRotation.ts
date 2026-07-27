import { useEffect, useMemo, useRef, useState } from 'react'

export const ROTATION_INTERVAL_MS = 10_000

interface UseTabRotationArgs {
  order: string[]
  activeTab: string
  onAdvance: (next: string) => void
  intervalMs: number
  enabled: boolean
}

interface UseTabRotationResult {
  /**
   * Increments every time a new rotation cycle starts. Components render the
   * countdown bar with `key={cycle}` to restart the CSS animation without any
   * per-frame React work.
   */
  cycle: number
  /** Effective interval for the current cycle. 0 when rotation is disabled. */
  activeIntervalMs: number
}

export function useTabRotation({
  order,
  activeTab,
  onAdvance,
  intervalMs,
  enabled,
}: UseTabRotationArgs): UseTabRotationResult {
  const [cycle, setCycle] = useState(0)
  const onAdvanceRef = useRef(onAdvance)
  const orderRef = useRef(order)
  const activeTabRef = useRef(activeTab)

  useEffect(() => {
    onAdvanceRef.current = onAdvance
  }, [onAdvance])

  useEffect(() => {
    orderRef.current = order
  }, [order])

  useEffect(() => {
    activeTabRef.current = activeTab
  }, [activeTab])

  // Stable signature of the tab order so the effect re-runs only when the set
  // of tabs actually changes, not on every new array reference from metrics.
  const orderKey = useMemo(() => order.join(' '), [order])

  const active = enabled && intervalMs > 0 && order.length > 1

  // A new rotation cycle starts whenever any input to the timer changes. That
  // makes `cycle` derived state, so it is adjusted during render rather than
  // from an effect — calling setState synchronously inside the timer effect
  // below would schedule a second render pass on every cycle.
  const cycleKey = `${active}|${intervalMs}|${activeTab}|${orderKey}`
  const [prevCycleKey, setPrevCycleKey] = useState<string | null>(null)
  if (prevCycleKey !== cycleKey) {
    setPrevCycleKey(cycleKey)
    // Deactivating ends the current cycle without starting a new one, so the
    // countdown bar is not restarted just to be hidden.
    if (active) setCycle((c) => c + 1)
  }

  useEffect(() => {
    if (!active) return

    const id = window.setTimeout(() => {
      const currentOrder = orderRef.current
      const currentActive = activeTabRef.current
      const idx = currentOrder.indexOf(currentActive)
      const nextIdx = idx < 0 ? 0 : (idx + 1) % currentOrder.length
      const next = currentOrder[nextIdx]
      if (next && next !== currentActive) {
        onAdvanceRef.current(next)
      }
    }, intervalMs)

    return () => window.clearTimeout(id)
  }, [active, intervalMs, activeTab, orderKey])

  return {
    cycle,
    activeIntervalMs: active ? intervalMs : 0,
  }
}
