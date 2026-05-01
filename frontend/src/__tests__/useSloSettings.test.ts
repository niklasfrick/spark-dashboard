import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useSloSettings } from '@/hooks/useSloSettings'
import { DEFAULT_SLO } from '@/lib/slo'

const ENGINE = 'Vllm-http://127.0.0.1:8000'
const MODEL = 'meta-llama/Llama-3-8B'

describe('useSloSettings', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })
  afterEach(() => {
    window.localStorage.clear()
  })

  it('returns DEFAULT_SLO when nothing is stored', () => {
    const { result } = renderHook(() => useSloSettings(ENGINE, MODEL))
    expect(result.current.thresholds).toEqual(DEFAULT_SLO)
    expect(result.current.isCustomized).toBe(false)
  })

  it('persists thresholds to localStorage and reloads them on mount', () => {
    const first = renderHook(() => useSloSettings(ENGINE, MODEL))
    act(() => {
      first.result.current.setThresholds({ ttftMs: 250, itlMs: 25, e2eMs: 3000 })
    })
    expect(first.result.current.thresholds).toEqual({
      ttftMs: 250,
      itlMs: 25,
      e2eMs: 3000,
    })
    expect(first.result.current.isCustomized).toBe(true)

    // Simulate page reload — fresh hook instance, same key.
    const second = renderHook(() => useSloSettings(ENGINE, MODEL))
    expect(second.result.current.thresholds).toEqual({
      ttftMs: 250,
      itlMs: 25,
      e2eMs: 3000,
    })
  })

  it('keys settings per engine+model so different models stay independent', () => {
    const a = renderHook(() => useSloSettings(ENGINE, MODEL))
    act(() => {
      a.result.current.setThresholds({ ttftMs: 250, itlMs: 25, e2eMs: 3000 })
    })

    const b = renderHook(() => useSloSettings(ENGINE, 'mistral-7b'))
    expect(b.result.current.thresholds).toEqual(DEFAULT_SLO)
  })

  it('clears the stored value on reset', () => {
    const { result } = renderHook(() => useSloSettings(ENGINE, MODEL))
    act(() => {
      result.current.setThresholds({ ttftMs: 100, itlMs: 10, e2eMs: 1000 })
    })
    expect(window.localStorage.getItem(`spark-dashboard:slo:${ENGINE}:${MODEL}`))
      .not.toBeNull()

    act(() => {
      result.current.reset()
    })
    expect(result.current.thresholds).toEqual(DEFAULT_SLO)
    expect(result.current.isCustomized).toBe(false)
    expect(window.localStorage.getItem(`spark-dashboard:slo:${ENGINE}:${MODEL}`))
      .toBeNull()
  })

  it('discards corrupt stored JSON and falls back to defaults', () => {
    window.localStorage.setItem(
      `spark-dashboard:slo:${ENGINE}:${MODEL}`,
      '{ this is not valid json',
    )
    const { result } = renderHook(() => useSloSettings(ENGINE, MODEL))
    expect(result.current.thresholds).toEqual(DEFAULT_SLO)
  })

  it('rejects stored values that are not three positive finite numbers', () => {
    window.localStorage.setItem(
      `spark-dashboard:slo:${ENGINE}:${MODEL}`,
      JSON.stringify({ ttftMs: -1, itlMs: 50, e2eMs: 5000 }),
    )
    const { result } = renderHook(() => useSloSettings(ENGINE, MODEL))
    expect(result.current.thresholds).toEqual(DEFAULT_SLO)
  })

  it('returns defaults and never writes when modelName is null', () => {
    const { result } = renderHook(() => useSloSettings(ENGINE, null))
    act(() => {
      result.current.setThresholds({ ttftMs: 100, itlMs: 10, e2eMs: 1000 })
    })
    // No model → no key. Nothing should land in storage.
    expect(window.localStorage.length).toBe(0)
  })
})
