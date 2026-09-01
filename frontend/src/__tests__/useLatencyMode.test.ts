import { beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useLatencyMode } from '@/hooks/useLatencyMode'

const STORAGE_KEY = 'spark-dashboard:latency-mode'

beforeEach(() => {
  // Storage is where the setting lives, so clearing it is a full reset.
  window.localStorage.clear()
})

describe('useLatencyMode', () => {
  it('starts from the setting the operator left behind', () => {
    window.localStorage.setItem(STORAGE_KEY, 'p95')

    const { result } = renderHook(() => useLatencyMode())

    expect(result.current[0]).toBe('p95')
  })

  it('falls back to the average when nothing readable is stored', () => {
    window.localStorage.setItem(STORAGE_KEY, 'p42')

    expect(renderHook(() => useLatencyMode()).result.current[0]).toBe('avg')
  })

  it('moves every consumer together', () => {
    // Two latency panels on one page must not show different statistics:
    // comparing a p95 tile against an average one is how a tail-latency
    // problem gets misread.
    const first = renderHook(() => useLatencyMode())
    const second = renderHook(() => useLatencyMode())

    act(() => first.result.current[1]('p99'))

    expect(first.result.current[0]).toBe('p99')
    expect(second.result.current[0]).toBe('p99')
  })

  it('stores the choice for the next session', () => {
    const { result } = renderHook(() => useLatencyMode())

    act(() => result.current[1]('p50'))

    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('p50')
  })
})
