import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useMetrics } from '../hooks/useMetrics'
import { MockWebSocket, substituteWebSocket } from '../test/websocket'

substituteWebSocket()

const frame = (ts: number) => JSON.stringify({ timestamp_ms: ts, gpu_events: [] })

describe('useMetrics on a socket that goes silent without closing', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    MockWebSocket.deferCloseEvents = true
    vi.useFakeTimers()
  })

  afterEach(() => {
    MockWebSocket.flushCloseEvents()
    MockWebSocket.deferCloseEvents = false
    vi.useRealTimers()
  })

  it('drops the dead socket and dials exactly one new one', () => {
    const { result } = renderHook(() => useMetrics())
    const first = MockWebSocket.instances[0]
    act(() => {
      first.connect()
      first.receive(frame(1))
    })

    act(() => vi.advanceTimersByTime(16000))

    expect(first.readyState).toBe(3)
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(result.current.connectionStatus).toBe('reconnecting')

    // The old socket's late close event must not schedule a second reconnect.
    act(() => {
      MockWebSocket.flushCloseEvents()
      vi.advanceTimersByTime(10000)
    })
    expect(MockWebSocket.instances).toHaveLength(2)

    act(() => MockWebSocket.instances[1].connect())
    expect(result.current.connectionStatus).toBe('connected')
  })

  it('leaves a socket alone while messages keep arriving', () => {
    renderHook(() => useMetrics())
    const socket = MockWebSocket.instances[0]
    act(() => socket.connect())

    for (let i = 1; i <= 60; i++) {
      act(() => {
        socket.receive(frame(i * 1000))
        vi.advanceTimersByTime(1000)
      })
    }

    expect(MockWebSocket.instances).toHaveLength(1)
    expect(socket.readyState).toBe(1)
  })
})
