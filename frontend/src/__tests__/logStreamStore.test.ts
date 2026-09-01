import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LogStreamStore } from '../lib/logStreamStore'
import { MockWebSocket, substituteWebSocket } from '../test/websocket'

substituteWebSocket()

/** The socket opened most recently, which is the one a fresh stream owns. */
function latest(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1]
}

const ALPHA = 'http://localhost:8000'
const BETA = 'http://localhost:8001'

describe('the log stream store', () => {
  let store: LogStreamStore

  beforeEach(() => {
    MockWebSocket.instances = []
    vi.useFakeTimers()
    store = new LogStreamStore()
  })

  afterEach(() => {
    vi.useRealTimers()
    MockWebSocket.deferCloseEvents = false
  })

  it('opens no socket until something subscribes', () => {
    expect(store.read(ALPHA)).toEqual({ status: 'connecting', lines: [] })
    expect(MockWebSocket.instances).toHaveLength(0)
  })

  it('addresses the engine by endpoint in the socket URL', () => {
    store.subscribe(ALPHA, () => {})

    expect(latest().url).toContain(`/ws/logs?engine=${encodeURIComponent(ALPHA)}`)
  })

  it('opens exactly one socket for several subscribers of the same endpoint', () => {
    store.subscribe(ALPHA, () => {})
    store.subscribe(ALPHA, () => {})
    store.subscribe(ALPHA, () => {})

    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('opens one socket per distinct endpoint', () => {
    store.subscribe(ALPHA, () => {})
    store.subscribe(BETA, () => {})

    expect(MockWebSocket.instances).toHaveLength(2)
    expect(MockWebSocket.instances[0].url).toContain(encodeURIComponent(ALPHA))
    expect(MockWebSocket.instances[1].url).toContain(encodeURIComponent(BETA))
  })

  it('delivers a line to every subscriber of that endpoint, and to no other', () => {
    const first = vi.fn()
    const second = vi.fn()
    const other = vi.fn()
    store.subscribe(ALPHA, first)
    store.subscribe(ALPHA, second)
    store.subscribe(BETA, other)

    const alpha = MockWebSocket.instances[0]
    alpha.connect()
    other.mockClear()
    alpha.receive('INFO: serving')

    expect(first).toHaveBeenCalled()
    expect(second).toHaveBeenCalled()
    expect(other).not.toHaveBeenCalled()
    expect(store.read(ALPHA).lines).toEqual(['INFO: serving'])
    expect(store.read(BETA).lines).toEqual([])
  })

  it('keeps the socket open while another subscriber remains', () => {
    const release = store.subscribe(ALPHA, () => {})
    store.subscribe(ALPHA, () => {})
    const socket = latest()
    socket.connect()
    socket.receive('INFO: still here')

    release()

    expect(socket.readyState).toBe(1)
    expect(store.read(ALPHA).lines).toEqual(['INFO: still here'])
  })

  it('closes the socket when the last subscriber leaves', () => {
    const release = store.subscribe(ALPHA, () => {})
    const socket = latest()
    socket.connect()

    release()

    expect(socket.readyState).toBe(3)
    expect(store.read(ALPHA)).toEqual({ status: 'connecting', lines: [] })
  })

  it('forgets the buffer once the last subscriber leaves', () => {
    const release = store.subscribe(ALPHA, () => {})
    latest().connect()
    latest().receive('INFO: from the previous viewer')
    release()

    store.subscribe(ALPHA, () => {})

    expect(MockWebSocket.instances).toHaveLength(2)
    expect(store.read(ALPHA).lines).toEqual([])
  })

  it('reports a stream as connected once the handshake succeeds', () => {
    store.subscribe(ALPHA, () => {})
    expect(store.read(ALPHA).status).toBe('connecting')

    latest().connect()

    expect(store.read(ALPHA).status).toBe('connected')
  })

  it('marks the stream unavailable when the handshake never succeeds, and does not retry', () => {
    store.subscribe(ALPHA, () => {})

    // Closed without ever opening: /ws/logs is not registered, because the
    // backend runs without --enable-log-viewer.
    latest().close()

    expect(store.read(ALPHA).status).toBe('unavailable')
    vi.advanceTimersByTime(60_000)
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('reconnects after a live connection drops, keeping the lines it had', () => {
    store.subscribe(ALPHA, () => {})
    latest().connect()
    latest().receive('INFO: before the restart')
    latest().close()

    expect(store.read(ALPHA).status).toBe('reconnecting')
    expect(store.read(ALPHA).lines).toEqual(['INFO: before the restart'])

    vi.advanceTimersByTime(2000)

    expect(MockWebSocket.instances).toHaveLength(2)
    expect(MockWebSocket.instances[1].url).toContain(encodeURIComponent(ALPHA))
    latest().connect()
    expect(store.read(ALPHA).status).toBe('connected')
  })

  it('does not reconnect after the last subscriber leaves mid-retry', () => {
    const release = store.subscribe(ALPHA, () => {})
    latest().connect()
    latest().close()

    release()
    vi.advanceTimersByTime(10_000)

    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('ignores a close event that lands after the endpoint changed hands', () => {
    // A real browser fires `close` on a later task than the `close()` call, so
    // a panel removed and re-added — or one switching engines and back — can
    // hand the endpoint to a new connection while the old one's event is still
    // in flight. The stale connection must not reconnect: nothing would ever be
    // able to close the socket it opened.
    MockWebSocket.deferCloseEvents = true
    const release = store.subscribe(ALPHA, () => {})
    latest().connect()

    release()
    store.subscribe(ALPHA, () => {})
    const replacement = latest()
    MockWebSocket.flushCloseEvents()

    vi.advanceTimersByTime(30_000)
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(store.read(ALPHA).status).toBe('connecting')

    // The endpoint's own connection is untouched by the orphan's late event.
    replacement.connect()
    expect(store.read(ALPHA).status).toBe('connected')
  })

  it('drops the oldest lines past the buffer cap', () => {
    store.subscribe(ALPHA, () => {})
    latest().connect()
    for (let i = 0; i < 1010; i++) latest().receive(`line ${i}`)

    const { lines } = store.read(ALPHA)
    expect(lines).toHaveLength(1000)
    expect(lines[0]).toBe('line 10')
    expect(lines[999]).toBe('line 1009')
  })

  it('hands back the same stream value until something changes', () => {
    // `useSyncExternalStore` re-renders whenever the read returns a new value,
    // so an unchanged stream has to be the same object.
    store.subscribe(ALPHA, () => {})
    latest().connect()
    const first = store.read(ALPHA)

    expect(store.read(ALPHA)).toBe(first)

    latest().receive('INFO: something new')
    expect(store.read(ALPHA)).not.toBe(first)
  })

  it('hands back one shared empty stream for an endpoint nothing is watching', () => {
    expect(store.read(ALPHA)).toBe(store.read(BETA))
  })
})
