import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { useEffect } from 'react'
import { GridPanel } from '@/components/grid/GridPanel'
import { LogStreamProvider } from '@/hooks/LogStreamProvider'
import { LiveMotionContext } from '@/hooks/useLiveMotion'
import { MetricsStoreProvider } from '@/hooks/MetricsStoreProvider'
import { PageSelectionProvider } from '@/hooks/PageSelectionProvider'
import { useMetricsStore } from '@/hooks/useMetricsStore'
import { usePageSelection } from '@/hooks/usePageSelection'
import { FOLLOW } from '@/lib/dashboard/bindings'
import { DEFAULT_TIME_WINDOW, type DashboardPanel } from '@/lib/dashboard/schema'
import { MockWebSocket, substituteWebSocket } from '@/test/websocket'
import type { EngineMetrics, EngineSnapshot, MetricsSnapshot } from '@/types/metrics'

// The log panel (#82) through the real frame: the real registry, the real
// binding resolution and the real shared stream store, with the log sockets
// arriving through the substituted WebSocket. What is local to this spec is the
// affordance that changes the page selection and the one that removes a panel —
// both ship with edit mode (#83–#85), and the panel has to be right first.
substituteWebSocket()

const ALPHA = 'http://localhost:8000'
const BETA = 'http://localhost:8001'

function makeEngine(endpoint: string, overrides: Partial<EngineSnapshot> = {}): EngineSnapshot {
  return {
    engine_type: 'Vllm',
    endpoint,
    status: { type: 'Running' },
    model: {
      name: 'Qwen/Qwen3-8B',
      parameter_size: null,
      quantization: null,
      precision: null,
      tensor_type: null,
      model_type: null,
      pipeline_tag: null,
    },
    metrics: { tokens_per_sec: 120 } as EngineMetrics,
    recent_requests: [],
    deployment_mode: 'Docker',
    ...overrides,
  }
}

function snapshot(engines: EngineSnapshot[]): MetricsSnapshot {
  return {
    timestamp_ms: 1000,
    gpu: {
      index: 0,
      name: 'NVIDIA GB10',
      utilization_percent: 11,
      memory_total_bytes: null,
      memory_used_bytes: null,
      temperature_celsius: 40,
      power_watts: 100,
      power_limit_watts: 300,
      clock_graphics_mhz: 2000,
      clock_sm_mhz: null,
      clock_memory_mhz: null,
      fan_speed_percent: null,
    },
    cpu: { name: 'CPU', aggregate_percent: 25, per_core: [] },
    memory: {
      total_bytes: 128,
      used_bytes: 64,
      available_bytes: 64,
      cached_bytes: 8,
      gpu_estimated_bytes: null,
      gpu_memory_total_bytes: null,
      gpu_memory_used_bytes: null,
      is_unified: true,
    },
    disk: { name: 'disk', read_bytes_per_sec: 1, write_bytes_per_sec: 2 },
    network: { name: 'net', rx_bytes_per_sec: 3, tx_bytes_per_sec: 4 },
    engines,
    gpu_events: [],
  }
}

/** A log panel, following the page selection unless a binding is given. */
function logPanel(id: string, title: string, overrides: Partial<DashboardPanel> = {}) {
  return {
    id,
    title,
    type: 'logs',
    geometry: { x: 0, y: 0, w: 4, h: 4 },
    binding: FOLLOW,
    window: DEFAULT_TIME_WINDOW,
    ...overrides,
  } satisfies DashboardPanel
}

function Ingest({ engines }: { engines: EngineSnapshot[] }) {
  const store = useMetricsStore()
  useEffect(() => {
    store.ingest(snapshot(engines))
  }, [store, engines])
  return null
}

/** Stand-in for the page's engine selector, which ships with #84/#85. */
function SelectEngine({ endpoint }: { endpoint: string }) {
  const { selectEngine } = usePageSelection()
  return (
    <button type="button" onClick={() => selectEngine(endpoint)}>
      Select {endpoint}
    </button>
  )
}

function Page({
  engines,
  panels,
  live = true,
}: {
  engines: EngineSnapshot[]
  panels: DashboardPanel[]
  /** False stands in for a page being edited, which holds every panel still. */
  live?: boolean
}) {
  return (
    <MetricsStoreProvider>
      <LogStreamProvider>
        <Ingest engines={engines} />
        <LiveMotionContext.Provider value={live}>
          <PageSelectionProvider>
            <SelectEngine endpoint={BETA} />
            {panels.map((panel) => (
              <GridPanel key={panel.id} panel={panel} />
            ))}
          </PageSelectionProvider>
        </LiveMotionContext.Provider>
      </LogStreamProvider>
    </MetricsStoreProvider>
  )
}

/** Every log socket opened so far, oldest first. */
function sockets(): MockWebSocket[] {
  return MockWebSocket.instances.filter((ws) => ws.url.includes('/ws/logs'))
}

/** The one socket streaming this endpoint. Fails the spec if there is not
 *  exactly one — sharing is the point of the store. */
function socketFor(endpoint: string): MockWebSocket {
  const matching = sockets().filter((ws) => ws.url.includes(encodeURIComponent(endpoint)))
  expect(matching, `sockets for ${endpoint}`).toHaveLength(1)
  return matching[0]
}

function region(name: string): HTMLElement {
  return screen.getByRole('region', { name })
}

function click(name: string) {
  act(() => screen.getByRole('button', { name }).click())
}

beforeEach(() => {
  MockWebSocket.instances = []
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the log panel', () => {
  it('streams the engine it is bound to, addressing it by endpoint', () => {
    render(
      <Page
        engines={[makeEngine(ALPHA), makeEngine(BETA)]}
        panels={[logPanel('logs', 'Engine Logs')]}
      />,
    )

    const socket = socketFor(ALPHA)
    act(() => {
      socket.connect()
      socket.receive('INFO: alpha is serving')
    })

    expect(within(region('Engine Logs')).getByText('INFO: alpha is serving')).toBeInTheDocument()
  })

  it('holds still while the page is being edited, then catches up', () => {
    // The console scrolling under a panel the operator is dragging is the same
    // problem as a chart redrawing under it. The socket stays open throughout —
    // dropping it would lose the output produced while the page was rearranged,
    // which is the output most worth having.
    const props = { engines: [makeEngine(ALPHA)], panels: [logPanel('logs', 'Engine Logs')] }
    const { rerender } = render(<Page {...props} />)

    const socket = socketFor(ALPHA)
    act(() => {
      socket.connect()
      socket.receive('INFO: before the edit')
    })

    rerender(<Page {...props} live={false} />)
    act(() => socket.receive('INFO: during the edit'))

    const panel = () => within(region('Engine Logs'))
    expect(panel().getByText('INFO: before the edit')).toBeInTheDocument()
    expect(panel().queryByText('INFO: during the edit')).not.toBeInTheDocument()
    expect(sockets()).toHaveLength(1)

    rerender(<Page {...props} />)

    expect(panel().getByText('INFO: during the edit')).toBeInTheDocument()
  })

  it('opens one connection for two panels bound to the same engine', () => {
    render(
      <Page
        engines={[makeEngine(ALPHA)]}
        panels={[
          logPanel('following', 'Following Logs'),
          logPanel('pinned', 'Pinned Logs', { binding: { kind: 'engine', endpoint: ALPHA } }),
        ]}
      />,
    )

    // One socket, not two: the connection belongs to the endpoint, and both
    // panels resolved to the same one.
    expect(sockets()).toHaveLength(1)

    const socket = socketFor(ALPHA)
    act(() => {
      socket.connect()
      socket.receive('INFO: shared line')
    })

    // Both panels show it — one stream, read twice.
    expect(within(region('Following Logs')).getByText('INFO: shared line')).toBeInTheDocument()
    expect(within(region('Pinned Logs')).getByText('INFO: shared line')).toBeInTheDocument()
  })

  it('keeps streaming for the panel that remains when the other is removed', () => {
    const engines = [makeEngine(ALPHA)]
    const both = [
      logPanel('following', 'Following Logs'),
      logPanel('pinned', 'Pinned Logs', { binding: { kind: 'engine', endpoint: ALPHA } }),
    ]
    const { rerender } = render(<Page engines={engines} panels={both} />)

    const socket = socketFor(ALPHA)
    act(() => socket.connect())

    rerender(<Page engines={engines} panels={[both[1]]} />)

    // The socket the removed panel shared is still open, still the only one,
    // and still feeding the panel that stayed.
    expect(socket.readyState).toBe(1)
    expect(sockets()).toHaveLength(1)
    act(() => socket.receive('INFO: still streaming'))
    expect(within(region('Pinned Logs')).getByText('INFO: still streaming')).toBeInTheDocument()
  })

  it('closes the connection once the last panel watching it is gone', () => {
    const engines = [makeEngine(ALPHA)]
    const panels = [logPanel('logs', 'Engine Logs')]
    const { rerender } = render(<Page engines={engines} panels={panels} />)

    const socket = socketFor(ALPHA)
    act(() => socket.connect())

    rerender(<Page engines={engines} panels={[]} />)

    // Nothing is watching, so the backend can stop the container stream.
    expect(socket.readyState).toBe(3)
  })

  it('streams each engine separately for panels bound to different engines', () => {
    render(
      <Page
        engines={[makeEngine(ALPHA), makeEngine(BETA)]}
        panels={[
          logPanel('alpha', 'Alpha Logs', { binding: { kind: 'engine', endpoint: ALPHA } }),
          logPanel('beta', 'Beta Logs', { binding: { kind: 'engine', endpoint: BETA } }),
        ]}
      />,
    )

    expect(sockets()).toHaveLength(2)
    const alpha = socketFor(ALPHA)
    const beta = socketFor(BETA)
    act(() => {
      alpha.connect()
      beta.connect()
      alpha.receive('INFO: from alpha')
      beta.receive('INFO: from beta')
    })

    // Each panel shows its own engine's lines and nothing of the other's —
    // logs are the one place where reading the wrong container is worst.
    const alphaPanel = within(region('Alpha Logs'))
    expect(alphaPanel.getByText('INFO: from alpha')).toBeInTheDocument()
    expect(alphaPanel.queryByText('INFO: from beta')).not.toBeInTheDocument()

    const betaPanel = within(region('Beta Logs'))
    expect(betaPanel.getByText('INFO: from beta')).toBeInTheDocument()
    expect(betaPanel.queryByText('INFO: from alpha')).not.toBeInTheDocument()
  })

  it('moves to the engine the page is pointed at, and leaves a pin alone', () => {
    render(
      <Page
        engines={[makeEngine(ALPHA), makeEngine(BETA)]}
        panels={[
          logPanel('following', 'Following Logs'),
          logPanel('pinned', 'Pinned Logs', { binding: { kind: 'engine', endpoint: ALPHA } }),
        ]}
      />,
    )

    const alpha = socketFor(ALPHA)
    act(() => alpha.connect())
    expect(sockets()).toHaveLength(1)

    click(`Select ${BETA}`)

    // The following panel opened Beta's stream; the pinned one is still holding
    // Alpha's, so that connection stayed up rather than being torn down.
    const beta = socketFor(BETA)
    expect(alpha.readyState).toBe(1)
    act(() => {
      beta.connect()
      beta.receive('INFO: from beta')
      alpha.receive('INFO: from alpha')
    })
    expect(within(region('Following Logs')).getByText('INFO: from beta')).toBeInTheDocument()
    expect(within(region('Pinned Logs')).getByText('INFO: from alpha')).toBeInTheDocument()
  })

  it('explains that a disabled log viewer is a deployment choice', () => {
    render(<Page engines={[makeEngine(ALPHA)]} panels={[logPanel('logs', 'Engine Logs')]} />)

    // Closed without ever opening: the backend runs without --enable-log-viewer,
    // so /ws/logs was never registered.
    act(() => socketFor(ALPHA).close())

    expect(
      within(region('Engine Logs')).getByText(/Log viewer not enabled on this server/),
    ).toBeInTheDocument()
    // Nothing to retry: the route does not exist on this deployment.
    act(() => vi.advanceTimersByTime(30_000))
    expect(sockets()).toHaveLength(1)
  })

  it('reconnects after a live connection drops, keeping the lines it had', () => {
    render(<Page engines={[makeEngine(ALPHA)]} panels={[logPanel('logs', 'Engine Logs')]} />)

    const socket = socketFor(ALPHA)
    act(() => {
      socket.connect()
      socket.receive('INFO: before the restart')
      socket.close()
    })

    const panel = within(region('Engine Logs'))
    expect(panel.getByText('INFO: before the restart')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(2000))
    expect(sockets()).toHaveLength(2)
  })

  it('filters and pauses per panel, over the one shared stream', () => {
    render(
      <Page
        engines={[makeEngine(ALPHA)]}
        panels={[
          logPanel('following', 'Following Logs'),
          logPanel('pinned', 'Pinned Logs', { binding: { kind: 'engine', endpoint: ALPHA } }),
        ]}
      />,
    )

    const socket = socketFor(ALPHA)
    act(() => {
      socket.connect()
      socket.receive('ERROR: cuda out of memory')
      socket.receive('INFO: all good')
    })

    const following = within(region('Following Logs'))
    fireEvent.change(following.getByPlaceholderText('Filter lines containing...'), {
      target: { value: 'error' },
    })

    // Filtering is viewport state, not stream state: one panel narrows, the
    // other keeps showing everything from the same buffer.
    expect(following.getByText('ERROR: cuda out of memory')).toBeInTheDocument()
    expect(following.queryByText('INFO: all good')).not.toBeInTheDocument()

    const pinned = within(region('Pinned Logs'))
    expect(pinned.getByText('INFO: all good')).toBeInTheDocument()

    // Pause is per panel too.
    fireEvent.click(following.getByText('⏵ Live'))
    expect(following.getByText('⏸ Paused')).toBeInTheDocument()
    expect(pinned.getByText('⏵ Live')).toBeInTheDocument()
  })

  it('streams an engine that is not serving, which is when logs matter most', () => {
    // No model loaded and no metrics: every metric panel shows a notice here.
    // The log panel is what says why, so it must stream anyway.
    render(
      <Page
        engines={[makeEngine(ALPHA, { model: null, metrics: null })]}
        panels={[logPanel('logs', 'Engine Logs')]}
      />,
    )

    const socket = socketFor(ALPHA)
    act(() => {
      socket.connect()
      socket.receive('ERROR: failed to load model weights')
    })

    expect(
      within(region('Engine Logs')).getByText('ERROR: failed to load model weights'),
    ).toBeInTheDocument()
  })

  it('opens no connection for a panel pinned to an engine that is gone', () => {
    render(
      <Page
        engines={[makeEngine(ALPHA)]}
        panels={[
          logPanel('logs', 'Engine Logs', { binding: { kind: 'engine', endpoint: BETA } }),
        ]}
      />,
    )

    expect(sockets()).toHaveLength(0)
    expect(within(region('Engine Logs')).getByText(`No engine at ${BETA} — repoint this panel.`))
      .toBeInTheDocument()
  })

  it('opens no connection on a host running no engines', () => {
    render(<Page engines={[]} panels={[logPanel('logs', 'Engine Logs')]} />)

    expect(sockets()).toHaveLength(0)
    expect(within(region('Engine Logs')).getByText('No inference engine running.')).toBeInTheDocument()
  })

  it('names the engine it is streaming on a host running several', () => {
    render(
      <Page
        engines={[makeEngine(ALPHA), makeEngine(BETA)]}
        panels={[logPanel('logs', 'Engine Logs')]}
      />,
    )

    expect(within(region('Engine Logs')).getByText('vLLM localhost:8000')).toBeInTheDocument()
  })
})
