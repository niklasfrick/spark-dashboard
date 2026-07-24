import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { LogViewer } from '../components/LogViewer'

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
    expect(screen.getByText('Console Logs')).toBeDefined()
    // Should not show the expanded log panel
    expect(screen.queryByText('▼ Console Logs')).toBeNull()
  })

  it('shows disconnected state when collapsed', () => {
    render(<LogViewer />)
    expect(screen.getByText('○ Disconnected')).toBeDefined()
  })

  it('expands when clicked', () => {
    render(<LogViewer />)
    fireEvent.click(screen.getByText('Console Logs'))
    expect(screen.getByText('▼ Console Logs')).toBeDefined()
  })

  it('collapses when expanded and collapse button clicked', () => {
    render(<LogViewer />)
    // Expand
    fireEvent.click(screen.getByText('Console Logs'))
    expect(screen.getByText('▼ Console Logs')).toBeDefined()
    // Collapse
    fireEvent.click(screen.getByText('▼ Console Logs'))
    expect(screen.queryByText('▼ Console Logs')).toBeNull()
    expect(screen.getByText('Console Logs')).toBeDefined()
  })

  it('connects to WebSocket on mount', () => {
    render(<LogViewer />)
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(MockWebSocket.instances[0].url).toContain('/ws/logs')
  })

  it('shows live indicator when connected', () => {
    render(<LogViewer />)
    const ws = MockWebSocket.instances[0]
    act(() => ws.connect())
    expect(screen.getByText('● Live')).toBeDefined()
  })

  it('displays log messages from WebSocket', () => {
    render(<LogViewer />)
    const ws = MockWebSocket.instances[0]
    act(() => ws.connect())
    // Expand
    fireEvent.click(screen.getByText('Console Logs'))
    // Receive a log line
    act(() => ws.receive('INFO: Server started on port 3000'))
    expect(screen.getByText('INFO: Server started on port 3000')).toBeDefined()
  })

  it('filters log lines by text', () => {
    render(<LogViewer />)
    const ws = MockWebSocket.instances[0]
    act(() => ws.connect())
    fireEvent.click(screen.getByText('Console Logs'))
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
    const ws = MockWebSocket.instances[0]
    act(() => ws.connect())
    fireEvent.click(screen.getByText('Console Logs'))
    fireEvent.click(screen.getByText('⏵ Live'))
    expect(screen.getByText('⏸ Paused')).toBeDefined()
  })

  it('shows waiting message when connected but no logs', () => {
    render(<LogViewer />)
    const ws = MockWebSocket.instances[0]
    act(() => ws.connect())
    fireEvent.click(screen.getByText('Console Logs'))
    expect(screen.getByText('Waiting for log output...')).toBeDefined()
  })

  it('shows connecting message when not connected', () => {
    render(<LogViewer />)
    fireEvent.click(screen.getByText('Console Logs'))
    expect(screen.getByText('Connecting...')).toBeDefined()
  })

  it('highlights error lines in red', () => {
    render(<LogViewer />)
    const ws = MockWebSocket.instances[0]
    act(() => ws.connect())
    fireEvent.click(screen.getByText('Console Logs'))
    act(() => ws.receive('ERROR: critical failure'))
    const errorLine = screen.getByText('ERROR: critical failure')
    expect(errorLine.className).toContain('text-red-400')
  })

  it('highlights warning lines in yellow', () => {
    render(<LogViewer />)
    const ws = MockWebSocket.instances[0]
    act(() => ws.connect())
    fireEvent.click(screen.getByText('Console Logs'))
    act(() => ws.receive('WARN: deprecated function used'))
    const warnLine = screen.getByText('WARN: deprecated function used')
    expect(warnLine.className).toContain('text-yellow-400')
  })
})
