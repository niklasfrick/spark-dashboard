import { useEffect, useEffectEvent, useMemo, useRef } from 'react'
import { pageSelection } from '@/lib/dashboard/selection'
import {
  nextRotationTarget,
  rotationCycle,
  rotationTargetKey,
  type EngineRotationSetting,
} from '@/lib/engineRotation'
import { useEngineRotationSetting } from './useEngineRotationSetting'
import { useLiveMotion } from './useLiveMotion'
import { useLatestSnapshot } from './useMetricsStore'
import { usePageSelection } from './usePageSelection'

export interface EngineRotation {
  /** What this browser chose: how long each target is held, or null for off. */
  setting: EngineRotationSetting
  /** Records a new setting for this browser. Choosing off hands the page back
   *  to its source at once. */
  choose: (next: EngineRotationSetting) => void
  /** Two or more engines are running, so there is something to rotate between. */
  available: boolean
  /** Rotating right now: switched on, available, and the page is not frozen. */
  running: boolean
  /**
   * Names the step being counted down, and changes exactly when a countdown
   * starts again — key the countdown indicator by it to restart it in step
   * with the clock.
   */
  stepKey: string
}

/**
 * Steps one page's engine selection on a clock: all models, then each running
 * engine in snapshot order, then all models again.
 *
 * Rotation writes the page selection's **session** layer — the one a choice
 * made while looking at the page goes into, which is never saved — so it
 * overrides the page's source for this browser only, and only following engine
 * panels move: pinned panels name their own engine, and GPU and host panels do
 * not read the engine target at all.
 *
 * Each step is taken from wherever the page is now, against the engines running
 * at that moment, so turning rotation on does not jump the page anywhere until
 * the first interval has passed, and an engine that starts or stops is picked
 * up on the next step rather than restarting the cycle.
 *
 * It holds still with the rest of the page in edit mode: the clock stops and
 * the page keeps the target it had, and Save layout or Discard starts a fresh
 * countdown rather than finishing one that ran out while the page was held.
 * Rotation that **stops** — switched off, or down to fewer than two engines —
 * gives the page back to its source rather than leaving it on whichever engine
 * it last reached.
 *
 * Must run inside the page's `PageSelectionProvider`; every hook is above any
 * early return a caller makes, so it is safe before the first snapshot.
 */
export function useEngineRotation(): EngineRotation {
  const [setting, chooseSetting] = useEngineRotationSetting()
  const snapshot = useLatestSnapshot()
  const { chosen, source, selectEngine } = usePageSelection()
  const live = useLiveMotion()

  const cycle = useMemo(() => rotationCycle(snapshot?.engines ?? []), [snapshot])
  const available = cycle.length > 0
  const running = setting !== null && available && live

  const current = pageSelection(snapshot, chosen, source).engineTarget
  const currentKey = rotationTargetKey(current)

  // Whether the session's engine choice is one this hook made, and so one it
  // is entitled to take back. A ref rather than state: it decides what an
  // effect does, never what renders.
  const holding = useRef(false)

  // An Effect Event, so the step reads the engines and the target as they are
  // when the clock runs out — not as they were when it was started.
  const step = useEffectEvent(() => {
    const next = nextRotationTarget(cycle, current)
    if (next === null) return
    holding.current = true
    selectEngine(next)
  })

  // One countdown per step. Selecting the next target changes the current one,
  // which ends this effect and starts the next countdown — so the cycle runs
  // as a chain of timeouts with nothing to drift.
  useEffect(() => {
    if (!running || setting === null) return
    const id = window.setTimeout(() => step(), setting)
    return () => window.clearTimeout(id)
  }, [running, setting, currentKey])

  // Frozen is not stopped: in edit mode the page keeps what rotation showed.
  const stopped = setting === null || !available
  useEffect(() => {
    if (!stopped || !holding.current) return
    holding.current = false
    selectEngine(null)
  }, [stopped, selectEngine])

  return {
    setting,
    choose: chooseSetting,
    available,
    running,
    stepKey: `${setting}|${currentKey}`,
  }
}
