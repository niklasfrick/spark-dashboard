import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_SLO, type SloThresholds } from '@/lib/slo'

const STORAGE_PREFIX = 'spark-dashboard:slo'

/**
 * Build the localStorage key for an engine+model pair. Returns `null` when
 * no model is loaded — there is nothing to scope per-model settings to in
 * that case, so the hook stays read-only with the defaults.
 */
function storageKey(engineKey: string, modelName: string | null): string | null {
  if (!modelName) return null
  return `${STORAGE_PREFIX}:${engineKey}:${modelName}`
}

/**
 * Validate a parsed JSON blob from localStorage. Discards anything that
 * isn't three positive finite numbers — protects against partial writes,
 * shape drift across releases, and user tampering.
 */
function parseStored(raw: string | null): SloThresholds | null {
  if (raw === null) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  const ttftMs = candidate.ttftMs
  const itlMs = candidate.itlMs
  const e2eMs = candidate.e2eMs
  if (
    typeof ttftMs !== 'number' || !Number.isFinite(ttftMs) || ttftMs <= 0 ||
    typeof itlMs !== 'number' || !Number.isFinite(itlMs) || itlMs <= 0 ||
    typeof e2eMs !== 'number' || !Number.isFinite(e2eMs) || e2eMs <= 0
  ) {
    return null
  }
  return { ttftMs, itlMs, e2eMs }
}

function readFromStorage(key: string | null): SloThresholds | null {
  if (key === null || typeof window === 'undefined') return null
  try {
    return parseStored(window.localStorage.getItem(key))
  } catch {
    return null
  }
}

/**
 * Per-model SLO threshold state. Mirrors the localStorage pattern used by
 * the engine rotation, latency mode, and active tab settings (see
 * `EngineSection.tsx`). When the engine has no loaded model, returns the
 * defaults and a no-op setter — nothing to persist.
 */
export function useSloSettings(engineKey: string, modelName: string | null): {
  thresholds: SloThresholds
  setThresholds: (next: SloThresholds) => void
  reset: () => void
  isCustomized: boolean
} {
  const key = storageKey(engineKey, modelName)
  const [thresholds, setThresholdsState] = useState<SloThresholds>(() => {
    return readFromStorage(key) ?? DEFAULT_SLO
  })

  // When the engine/model identity changes (e.g. user switches tabs to a
  // different served model in the same browser session), reload the value
  // for that key. Without this effect, the hook would stick to whatever
  // was loaded on first mount.
  useEffect(() => {
    setThresholdsState(readFromStorage(key) ?? DEFAULT_SLO)
  }, [key])

  const setThresholds = useCallback(
    (next: SloThresholds) => {
      setThresholdsState(next)
      if (key === null || typeof window === 'undefined') return
      try {
        window.localStorage.setItem(key, JSON.stringify(next))
      } catch {
        // ignore storage errors (private mode, quota, etc.)
      }
    },
    [key],
  )

  const reset = useCallback(() => {
    setThresholdsState(DEFAULT_SLO)
    if (key === null || typeof window === 'undefined') return
    try {
      window.localStorage.removeItem(key)
    } catch {
      // ignore storage errors (private mode, quota, etc.)
    }
  }, [key])

  const isCustomized =
    thresholds.ttftMs !== DEFAULT_SLO.ttftMs ||
    thresholds.itlMs !== DEFAULT_SLO.itlMs ||
    thresholds.e2eMs !== DEFAULT_SLO.e2eMs

  return { thresholds, setThresholds, reset, isCustomized }
}
