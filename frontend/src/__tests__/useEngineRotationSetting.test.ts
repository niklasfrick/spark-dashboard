import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useEngineRotationSetting } from '@/hooks/useEngineRotationSetting'

const STORAGE_KEY = 'spark-dashboard:engine-rotation'

beforeEach(() => {
  // Storage is where the setting lives, so clearing it is a full reset.
  window.localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useEngineRotationSetting', () => {
  it('is off in a browser that never chose', () => {
    expect(renderHook(() => useEngineRotationSetting()).result.current[0]).toBeNull()
  })

  it('starts from the setting this browser left behind', () => {
    // The kiosk case: set once, and still rotating after a reboot.
    window.localStorage.setItem(STORAGE_KEY, '10000')

    expect(renderHook(() => useEngineRotationSetting()).result.current[0]).toBe(10000)
  })

  it('ignores the pre-0.14 carousel’s key', () => {
    // That key was written "on" by every old build on every mount, so it does
    // not say anyone chose rotation.
    window.localStorage.setItem('spark-dashboard:engine-rotation-interval', '10000')

    expect(renderHook(() => useEngineRotationSetting()).result.current[0]).toBeNull()
  })

  it('stores the choice for the next session, off included', () => {
    const { result } = renderHook(() => useEngineRotationSetting())

    act(() => result.current[1](5000))
    expect(result.current[0]).toBe(5000)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('5000')

    act(() => result.current[1](null))
    expect(result.current[0]).toBeNull()
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('off')
  })

  it('moves every consumer in the tab together', () => {
    const first = renderHook(() => useEngineRotationSetting())
    const second = renderHook(() => useEngineRotationSetting())

    act(() => first.result.current[1](3000))

    expect(second.result.current[0]).toBe(3000)
  })

  it('reads as off when storage cannot be read', () => {
    window.localStorage.setItem(STORAGE_KEY, '10000')
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })

    expect(renderHook(() => useEngineRotationSetting()).result.current[0]).toBeNull()
  })

  it('still takes effect for the session when storage refuses the write', () => {
    // Private mode or a full quota costs the choice its persistence, not its
    // effect.
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    const { result } = renderHook(() => useEngineRotationSetting())

    act(() => result.current[1](20000))
    expect(result.current[0]).toBe(20000)

    // Once storage works again, it is the one place the value lives.
    setItem.mockRestore()
    act(() => result.current[1](null))
    expect(result.current[0]).toBeNull()
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('off')
  })
})
