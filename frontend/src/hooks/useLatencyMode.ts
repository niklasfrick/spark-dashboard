import { useCallback, useState } from 'react'
import { parseLatencyMode, serializeLatencyMode, type LatencyMode } from '@/lib/latencyMode'

const LATENCY_MODE_STORAGE_KEY = 'spark-dashboard:latency-mode'

/**
 * Which latency statistic the dashboard shows — average, or one of the
 * histogram percentiles.
 *
 * A dashboard-wide preference rather than per-panel state: an operator who
 * reads p95 reads p95 everywhere, and comparing a p95 tile against an average
 * one is how a latency problem gets misread. It is stored under the key the
 * pre-grid dashboard has always used, so the setting survives the cutover.
 *
 * Each consumer holds its own copy of the current value and adopts the stored
 * one when it mounts; two latency panels on one page therefore agree from the
 * next reload rather than instantly. Making the choice reach a second panel
 * live is per-panel configuration's problem (#84), which may well make the mode
 * a panel setting outright.
 */
export function useLatencyMode(): [LatencyMode, (next: LatencyMode) => void] {
  const [mode, setMode] = useState<LatencyMode>(readStoredLatencyMode)

  const chooseMode = useCallback((next: LatencyMode) => {
    setMode(next)
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(LATENCY_MODE_STORAGE_KEY, serializeLatencyMode(next))
    } catch {
      // ignore storage errors (private mode, quota, etc.)
    }
  }, [])

  return [mode, chooseMode]
}

function readStoredLatencyMode(): LatencyMode {
  if (typeof window === 'undefined') return parseLatencyMode(null)
  try {
    return parseLatencyMode(window.localStorage.getItem(LATENCY_MODE_STORAGE_KEY))
  } catch {
    return parseLatencyMode(null)
  }
}
