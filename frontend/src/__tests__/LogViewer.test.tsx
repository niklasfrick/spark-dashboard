import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { LogViewer } from '../components/LogViewer'
import type { EngineSnapshot } from '../types/metrics'

const engine = (
  endpoint: string,
  mode: 'Docker' | 'Native' = 'Docker',
): EngineSnapshot => ({
  engine_type: 'Vllm',
  endpoint,
  status: { type: 'Running' },
  model: null,
  metrics: null,
  recent_requests: [],
  deployment_mode: mode,
  gpu_indexes: [],
})

// Mock WebSocket
class MockWebSocket {
  static instances: MockWebSocket[] = []
  url: string
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  readyState = 0

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  close() {
    this.readyState = 3
    if (this.onclose) this.onclose(new CloseEvent('close'))
  }

  send(_data: string) {}

  // Helper to simulate server messages
  receive(data: string) {
    if (this.onmessage) this.onmessage(new MessageEvent('message', { data }))
  }

  // Helper to simulate connection
  connect() {
    this.readyState = 1
    if (this.onopen) this.onopen(new Event('open'))
  }
}

// Restore original WebSocket type for the mock
(globalThis as any).WebSocket = MockWebSocket as unknown as typeof WebSocket

/** Expand the console (which lazily opens the socket) and return the socket. */
function expand(): MockWebSocket {
  fireEvent.click(screen.getByText('▶ Console Logs'))
  expect(MockWebSocket.instances.length).toBeGreaterThan(0)
  return MockWebSocket.instances[MockWebSocket.instances.length - 1]
}

describe('LogViewer', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders collapsed by default', () => {
    render(<LogViewer />)
    expect(screen.getByText('▶ Console Logs')).toBeDefined()
    // Should not show the expanded log panel
    expect(screen.queryByText('▼ Console Logs')).toBeNull()
  })

  it('does not open a socket while collapsed (lazy connect)', () => {
    render(<LogViewer />)
    expect(MockWebSocket.instances).toHaveLength(0)
    expect(screen.getByText('click to stream')).toBeDefined()
  })

  it('connects on first expand', () => {
    render(<LogViewer />)
    const ws = expand()
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(ws.url).toContain('/ws/logs')
  })

  it('closes the socket when collapsed again', () => {
    render(<LogViewer />)
    const ws = expand()
    act(() => ws.connect())
    fireEvent.click(screen.getByText('▼ Console Logs'))
    expect(ws.readyState).toBe(3)
    expect(screen.getByText('▶ Console Logs')).toBeDefined()
  })

  it('shows live state when connected', () => {
    render(<LogViewer />)
    const ws = expand()
    act(() => ws.connect())
    expect(screen.getByText('⏵ Live')).toBeDefined()
  })

  it('displays log messages from WebSocket', () => {
    render(<LogViewer />)
    const ws = expand()
    act(() => ws.connect())
    act(() => ws.receive('INFO: Server started on port 3000'))
    expect(screen.getByText('INFO: Server started on port 3000')).toBeDefined()
  })

  it('filters log lines by text', () => {
    render(<LogViewer />)
    const ws = expand()
    act(() => ws.connect())
    act(() => {
      ws.receive('ERROR: something broke')
      ws.receive('INFO: all good')
    })
    // Both should be visible initially
    expect(screen.getByText('ERROR: something broke')).toBeDefined()
    expect(screen.getByText('INFO: all good')).toBeDefined()
    // Type filter
    const input = screen.getByPlaceholderText('Filter lines containing...')
    fireEvent.change(input, { target: { value: 'error' } })
    expect(screen.getByText('ERROR: something broke')).toBeDefined()
    expect(screen.queryByText('INFO: all good')).toBeNull()
  })

  it('shows paused state when pause button clicked', () => {
    render(<LogViewer />)
    const ws = expand()
    act(() => ws.connect())
    fireEvent.click(screen.getByText('⏵ Live'))
    expect(screen.getByText('⏸ Paused')).toBeDefined()
  })

  it('shows waiting message when connected but no logs', () => {
    render(<LogViewer />)
    const ws = expand()
    act(() => ws.connect())
    expect(screen.getByText('Waiting for log output...')).toBeDefined()
  })

  it('shows connecting message before the socket opens', () => {
    render(<LogViewer />)
    expand()
    expect(screen.getByText('Connecting...')).toBeDefined()
  })

  it('shows the not-enabled hint when the handshake never succeeds', () => {
    render(<LogViewer />)
    const ws = expand()
    // Close without ever opening: /ws/logs is not registered on the backend.
    act(() => ws.close())
    expect(
      screen.getByText(/Log viewer not enabled on this server/),
    ).toBeDefined()
    // No retry loop against a doomed endpoint.
    act(() => vi.advanceTimersByTime(10000))
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('reconnects after a dropped live connection', () => {
    render(<LogViewer />)
    const ws = expand()
    act(() => ws.connect())
    act(() => ws.close())
    expect(screen.getByText(/reconnecting/)).toBeDefined()
    act(() => vi.advanceTimersByTime(2000))
    expect(MockWebSocket.instances).toHaveLength(2)
  })

  it('highlights error lines in red', () => {
    render(<LogViewer />)
    const ws = expand()
    act(() => ws.connect())
    act(() => ws.receive('ERROR: critical failure'))
    const errorLine = screen.getByText('ERROR: critical failure')
    expect(errorLine.className).toContain('text-red-400')
  })

  it('highlights warning lines in yellow', () => {
    render(<LogViewer />)
    const ws = expand()
    act(() => ws.connect())
    act(() => ws.receive('WARN: deprecated function used'))
    const warnLine = screen.getByText('WARN: deprecated function used')
    expect(warnLine.className).toContain('text-yellow-400')
  })

  it('passes the selected engine endpoint as ?engine=', () => {
    render(
      <LogViewer
        engines={[engine('http://localhost:8000'), engine('http://localhost:8100')]}
        selectedEndpoint="http://localhost:8100"
      />,
    )
    const ws = expand()
    expect(ws.url).toContain(
      `/ws/logs?engine=${encodeURIComponent('http://localhost:8100')}`,
    )
  })

  it('falls back to the first Docker engine when no engine is selected', () => {
    render(
      <LogViewer
        engines={[engine('http://localhost:8000', 'Native'), engine('http://localhost:8100')]}
        selectedEndpoint={null}
      />,
    )
    const ws = expand()
    expect(ws.url).toContain(
      `/ws/logs?engine=${encodeURIComponent('http://localhost:8100')}`,
    )
  })

  it('reconnects and clears the buffer when the selected engine changes', () => {
    const engines = [engine('http://localhost:8000'), engine('http://localhost:8100')]
    const { rerender } = render(
      <LogViewer engines={engines} selectedEndpoint="http://localhost:8000" />,
    )
    const ws = expand()
    act(() => ws.connect())
    act(() => ws.receive('line from engine 8000'))
    expect(screen.getByText('line from engine 8000')).toBeDefined()

    rerender(<LogViewer engines={engines} selectedEndpoint="http://localhost:8100" />)

    // A second socket is opened against the newly selected engine…
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(MockWebSocket.instances[1].url).toContain(
      `/ws/logs?engine=${encodeURIComponent('http://localhost:8100')}`,
    )
    // …and the previous engine's lines are dropped.
    expect(screen.queryByText('line from engine 8000')).toBeNull()
  })

  it('does not show the auto-scroll indicator while following the stream', () => {
    render(<LogViewer />)
    const ws = expand()
    act(() => ws.connect())
    act(() => {
      ws.receive('line 1')
      ws.receive('line 2')
      ws.receive('line 3')
    })
    // Following the bottom: no resume affordance should appear just because
    // new lines came in.
    expect(screen.queryByText('↓ Auto-scroll')).toBeNull()
  })

  it('shows the auto-scroll indicator only after scrolling back, hides it at the bottom', () => {
    const { container } = render(<LogViewer />)
    const ws = expand()
    act(() => ws.connect())
    act(() => ws.receive('line 1'))

    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 200 })

    // User scrolls back up: resume affordance appears.
    scroller.scrollTop = 100
    fireEvent.scroll(scroller)
    expect(screen.getByText('↓ Auto-scroll')).toBeDefined()

    // New lines while scrolled back must not touch the viewport or the button.
    act(() => ws.receive('line 2'))
    expect(scroller.scrollTop).toBe(100)
    expect(screen.getByText('↓ Auto-scroll')).toBeDefined()

    // Back at the bottom (within the 50px threshold): affordance disappears.
    scroller.scrollTop = 990
    fireEvent.scroll(scroller)
    expect(screen.queryByText('↓ Auto-scroll')).toBeNull()
  })

  it('shows which engine is being streamed in the header', () => {
    render(
      <LogViewer engines={[engine('http://localhost:8000')]} selectedEndpoint="http://localhost:8000" />,
    )
    expect(screen.getByText('http://localhost:8000')).toBeDefined()
  })
})
