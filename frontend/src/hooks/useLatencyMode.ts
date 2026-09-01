import { useSyncExternalStore } from 'react'
import { parseLatencyMode, serializeLatencyMode, type LatencyMode } from '@/lib/latencyMode'

const LATENCY_MODE_STORAGE_KEY = 'spark-dashboard:latency-mode'

/**
 * Which latency statistic the dashboard shows — average, or one of the
 * histogram percentiles.
 *
 * One setting for the whole dashboard, not per panel: comparing a p95 tile
 * against an average one is how a tail-latency problem gets misread, so
 * choosing p95 in one panel moves every other panel with it. Stored under the
 * key the pre-grid dashboard has always used, so the setting survives the
 * cutover.
 *
 * The choice lives outside React so every consumer reads one value; storage
 * seeds it and records it for the next session. The listeners exist only to
 * tell this tab's other panels that it changed, which storage events do not do
 * for the tab that wrote them.
 */
export function useLatencyMode(): [LatencyMode, (next: LatencyMode) => void] {
  const mode = useSyncExternalStore(subscribe, readStoredLatencyMode, readStoredLatencyMode)
  return [mode, chooseLatencyMode]
}

const listeners = new Set<() => void>()

/** The choice, held here **only** while storage cannot hold it. Null in the
 *  normal case, so storage stays the one place the value lives. */
let unstored: LatencyMode | null = null

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function chooseLatencyMode(next: LatencyMode): void {
  try {
    window.localStorage.setItem(LATENCY_MODE_STORAGE_KEY, serializeLatencyMode(next))
    unstored = null
  } catch {
    // Storage errors (private mode, quota) cost the choice its persistence,
    // not its effect: it still holds for the rest of this session.
    unstored = next
  }
  for (const listener of listeners) listener()
}

function readStoredLatencyMode(): LatencyMode {
  if (unstored !== null) return unstored
  if (typeof window === 'undefined') return parseLatencyMode(null)
  try {
    return parseLatencyMode(window.localStorage.getItem(LATENCY_MODE_STORAGE_KEY))
  } catch {
    return parseLatencyMode(null)
  }
}
