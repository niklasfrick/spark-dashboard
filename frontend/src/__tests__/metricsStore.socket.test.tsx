import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { useEffect } from 'react'
import { MetricsStoreProvider } from '../hooks/MetricsStoreProvider'
import { useMetricSeries } from '../hooks/useMetricsStore'
import { useMetrics } from '../hooks/useMetrics'
import { useMetricsHistory } from '../hooks/useMetricsHistory'
import { MockWebSocket, substituteWebSocket } from '../test/websocket'
import type { MetricsSnapshot } from '../types/metrics'

// The store is deliberately tested through the substituted WebSocket — the
// same seam the log viewer spec uses — so the real ingest and subscription
// logic runs end to end instead of being mocked away.
substituteWebSocket()

function snapshot(ts: number, util: number, temp: number | null): MetricsSnapshot {
  return {
    timestamp_ms: ts,
    gpu: {
      index: 0,
      name: 'GPU 0',
      utilization_percent: util,
      temperature_celsius: temp,
      power_watts: null,
      power_limit_watts: null,
      clock_graphics_mhz: null,
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
      is_unified: false,
    },
    disk: { name: 'disk', read_bytes_per_sec: 1, write_bytes_per_sec: 2 },
    network: { name: 'net', rx_bytes_per_sec: 3, tx_bytes_per_sec: 4 },
    engines: [],
    gpu_events: [],
  }
}

/** The app's real wiring: the socket hook feeding the store, as App does. */
function Feed() {
  const { metrics } = useMetrics()
  useMetricsHistory(metrics)
  return null
}

const renderCounts: Record<string, number> = {}

/** A component subscribed to a single series, the way a panel will be. The
 *  dependency-less effect runs once per committed render, which is the count
 *  the spec asserts on — a skipped re-render leaves it untouched. */
function Probe({ series }: { series: string }) {
  const data = useMetricSeries(series)
  useEffect(() => {
    renderCounts[series] = (renderCounts[series] ?? 0) + 1
  })
  return <output data-testid={series}>{data.map((p) => p.value).join(',')}</output>
}

describe('metrics store through the substituted socket', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    for (const key of Object.keys(renderCounts)) delete renderCounts[key]
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('re-renders only the subscribers of the series a snapshot changed', () => {
    render(
      <MetricsStoreProvider>
        <Feed />
        <Probe series="gpuUtil" />
        <Probe series="gpuTemp" />
      </MetricsStoreProvider>,
    )
    const socket = MockWebSocket.instances[0]

    // The very first frame flushes into the UI immediately.
    act(() => socket.receive(JSON.stringify(snapshot(1000, 11, 40))))
    expect(screen.getByTestId('gpuUtil')).toHaveTextContent('11')
    expect(screen.getByTestId('gpuTemp')).toHaveTextContent('40')

    const utilRenders = renderCounts['gpuUtil']
    const tempRenders = renderCounts['gpuTemp']

    // The next frame carries no temperature; later frames flush on the timer.
    act(() => {
      socket.receive(JSON.stringify(snapshot(2000, 12, null)))
      vi.advanceTimersByTime(2000)
    })

    expect(screen.getByTestId('gpuUtil')).toHaveTextContent('11,12')
    expect(renderCounts['gpuUtil']).toBeGreaterThan(utilRenders)
    // The temperature series gained nothing, so its subscriber did not render.
    expect(renderCounts['gpuTemp']).toBe(tempRenders)
    expect(screen.getByTestId('gpuTemp')).toHaveTextContent('40')
  })
})
