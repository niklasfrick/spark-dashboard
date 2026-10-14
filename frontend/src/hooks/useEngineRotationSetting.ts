import { useSyncExternalStore } from 'react'
import {
  parseEngineRotation,
  serializeEngineRotation,
  type EngineRotationSetting,
} from '@/lib/engineRotation'

/**
 * A new key rather than the pre-0.14 `spark-dashboard:engine-rotation-interval`.
 * The old carousel wrote its on-by-default state back on every mount, so that
 * key reads "on" in every browser that ever opened an old build — reusing it
 * would turn rotation on in browsers where nobody chose it.
 */
const ENGINE_ROTATION_STORAGE_KEY = 'spark-dashboard:engine-rotation'

/**
 * Whether this browser rotates engines, and how fast — off, or one of the
 * intervals in `lib/engineRotation`.
 *
 * Kept in browser storage on the same pattern as the latency mode, and never in
 * the dashboard configuration: it is a choice about how this screen watches the
 * instance, not about what the instance shows everyone (ADR-0003). A kiosk sets
 * it once and keeps it across reloads and reboots.
 *
 * The choice lives outside React so every consumer reads one value; storage
 * seeds it and records it for the next session. The listeners exist only to
 * tell this tab that it changed, which storage events do not do for the tab
 * that wrote them.
 */
export function useEngineRotationSetting(): [
  EngineRotationSetting,
  (next: EngineRotationSetting) => void,
] {
  const setting = useSyncExternalStore(subscribe, readStoredSetting, readStoredSetting)
  return [setting, chooseSetting]
}

const listeners = new Set<() => void>()

/** The choice, held here **only** while storage cannot hold it. Undefined in
 *  the normal case, so storage stays the one place the value lives — null is
 *  a real setting (off), so it cannot double as "nothing held". */
let unstored: EngineRotationSetting | undefined

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function chooseSetting(next: EngineRotationSetting): void {
  try {
    window.localStorage.setItem(ENGINE_ROTATION_STORAGE_KEY, serializeEngineRotation(next))
    unstored = undefined
  } catch {
    // Storage errors (private mode, quota) cost the choice its persistence,
    // not its effect: it still holds for the rest of this session.
    unstored = next
  }
  for (const listener of listeners) listener()
}

function readStoredSetting(): EngineRotationSetting {
  if (unstored !== undefined) return unstored
  if (typeof window === 'undefined') return parseEngineRotation(null)
  try {
    return parseEngineRotation(window.localStorage.getItem(ENGINE_ROTATION_STORAGE_KEY))
  } catch {
    return parseEngineRotation(null)
  }
}
