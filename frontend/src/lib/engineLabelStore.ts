import { useCallback, useSyncExternalStore } from 'react'

/**
 * Operator-assigned display labels for an engine, keyed by the engine's
 * identity (its endpoint). A llama.cpp model's name is a raw `.gguf` file
 * path — often long and ugly — so an operator can name the engine (e.g.
 * "conf-qwen") and every panel's identity row plus the status tile show that
 * label instead.
 *
 * Stored in `localStorage` under one key per engine so the label survives
 * reloads and is shared across tabs. The listeners exist only to tell this
 * tab's components that a label changed — `storage` events do not fire for
 * the tab that wrote the value.
 */
const PREFIX = 'spark-dashboard:engine-label'

function storageKey(engineKey: string | null): string | null {
  return engineKey ? `${PREFIX}:${engineKey}` : null
}

const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function notify(): void {
  for (const l of listeners) l()
}

function readRaw(key: string | null): string {
  if (!key || typeof window === 'undefined') return ''
  try {
    return window.localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

/** Read an engine's label (or `null`). A plain read — callers re-render on
 *  every snapshot (~1s) anyway, so the value stays in sync without a
 *  subscription. Used by the per-panel identity rows. */
export function readEngineLabel(engineKey: string | null): string | null {
  const v = readRaw(storageKey(engineKey))
  return v === '' ? null : v
}

/** Set (or clear, with an empty value) an engine's label, then notify this
 *  tab's subscribers so the status tile updates immediately. */
export function writeEngineLabel(engineKey: string | null, value: string): void {
  const key = storageKey(engineKey)
  if (!key) return
  const trimmed = value.trim()
  try {
    if (trimmed) window.localStorage.setItem(key, trimmed)
    else window.localStorage.removeItem(key)
  } catch {
    // private mode: the label still applies to this tab via `notify` below.
  }
  notify()
}

export interface EngineLabelHandle {
  label: string | null
  /** Set the label; pass an empty string to clear it. */
  setLabel: (value: string) => void
  isCustomized: boolean
}

/** Reactive handle for one engine's label. The status tile uses this so it
 *  updates the moment the operator saves a label. */
export function useEngineLabel(engineKey: string | null): EngineLabelHandle {
  const key = storageKey(engineKey)
  const getSnapshot = useCallback(() => readRaw(key), [key])
  const raw = useSyncExternalStore(subscribe, getSnapshot)
  const setLabel = useCallback((value: string) => writeEngineLabel(engineKey, value), [engineKey])
  return { label: raw === '' ? null : raw, setLabel, isCustomized: raw !== '' }
}
