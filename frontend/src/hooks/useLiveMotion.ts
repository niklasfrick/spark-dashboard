/**
 * Whether the dashboard is moving.
 *
 * Everything below a page that is being edited holds still: tab rotation stops,
 * counters stop counting, and panels keep rendering the last snapshot they got.
 * Dragging a panel whose contents rotate and re-draw underneath the cursor is
 * disorienting, and a chart that redraws mid-drag looks like the drag doing it.
 *
 * Motion is live by default, so nothing outside an edit session — the root
 * dashboard, a panel rendered in a spec — has to know this exists.
 */

import { createContext, useContext, useState } from 'react'

/**
 * Exported for the edit session that suspends motion; read it through
 * `useLiveMotion`. A provider and hooks cannot share a file without breaking
 * fast refresh, so the provider is wherever the session lives.
 */
export const LiveMotionContext = createContext(true)

/** True while the dashboard is allowed to move. */
export function useLiveMotion(): boolean {
  return useContext(LiveMotionContext)
}

/**
 * The live value while the dashboard is moving, and the value as of the moment
 * motion stopped while it is frozen.
 *
 * A frozen panel still re-renders — its geometry changes under the operator's
 * drag — so unsubscribing from a store is not on its own enough to hold what is
 * on screen. The latch is adjusted during render rather than from an effect,
 * which is the same rule the rotation and counter state follow: doing it in an
 * effect commits one frame of the value that was supposed to be frozen out.
 */
export function useHeldWhileFrozen<T>(live: T): T {
  const frozen = !useLiveMotion()
  const [held, setHeld] = useState({ frozen, value: live })

  if (held.frozen !== frozen) {
    setHeld({ frozen, value: live })
    return live
  }

  return frozen ? held.value : live
}
