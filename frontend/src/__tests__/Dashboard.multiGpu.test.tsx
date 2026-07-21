import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Dashboard } from '../components/views/Dashboard'
import type { GpuMetrics, MetricsSnapshot } from '../types/metrics'
import type { GpuEvent } from '../types/events'

// Stub out recharts so event overlays are assertable: the real chart renders
// event markers as SVG reference lines whose text is just the event type's
// first letter, which cannot distinguish events from different GPUs.
vi.mock('@/components/charts/TimeSeriesChart', () => ({
  TimeSeriesChart: ({ events }: { events?: Array<{ detail: string }> }) => (
    <div data-testid="time-series-chart">
      {events?.map((e, i) => (
        <span key={i} data-testid="chart-event">
          {e.detail}
        </span>
      ))}
    </div>
  ),
}))

const GIB = 1_073_741_824

function makeGpu(index: number, overrides: Partial<GpuMetrics> = {}): GpuMetrics {
  return {
    index,
    name: `NVIDIA Alpha ${index}`,
    utilization_percent: 11,
    memory_total_bytes: 48 * GIB,
    memory_used_bytes: 24 * GIB,
    temperature_celsius: 40,
    power_watts: 100,
    power_limit_watts: 300,
    clock_graphics_mhz: 1800,
    clock_sm_mhz: 1800,
    clock_memory_mhz: 9000,
    fan_speed_percent: 30,
    ...overrides,
  }
}

const gpu0 = makeGpu(0)
const gpu1 = makeGpu(1, {
  name: 'NVIDIA Beta 1',
  utilization_percent: 77,
  temperature_celsius: 61,
  power_watts: 220,
  clock_graphics_mhz: 2100,
})

function makeSnapshot(gpus: GpuMetrics[] | undefined): MetricsSnapshot {
  return {
    timestamp_ms: 1000,
    gpu: gpus?.[0] ?? gpu0,
    ...(gpus ? { gpus } : {}),
    cpu: { name: 'CPU', aggregate_percent: 25, per_core: [] },
    memory: {
      total_bytes: 128 * GIB,
      display_total_bytes: 128 * GIB,
      used_bytes: 64 * GIB,
      available_bytes: 64 * GIB,
      cached_bytes: 8 * GIB,
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

function stubHistory() {
  const calls: string[] = []
  return {
    calls,
    getChartData: (metric: string) => {
      calls.push(metric)
      return []
    },
    getSparklineData: () => [],
  }
}

function gpuSelector() {
  return screen.queryByRole('group', { name: 'GPU selector' })
}

describe('Dashboard multi-GPU selection', () => {
  it('switches all GPU chart panels and gauges to the clicked GPU', () => {
    const history = stubHistory()
    render(<Dashboard metrics={makeSnapshot([gpu0, gpu1])} history={history} events={[]} requests={[]} />)

    expect(gpuSelector()).not.toBeNull()
    // Primary GPU selected by default: per-GPU keys for GPU 0, gauge shows its util
    expect(history.calls).toContain('gpu:0:gpuUtil')
    expect(screen.getByText('11')).toBeTruthy()

    history.calls.length = 0
    fireEvent.click(screen.getByRole('button', { name: /GPU 1/ }))

    for (const key of ['gpu:1:gpuUtil', 'gpu:1:gpuTemp', 'gpu:1:gpuPower', 'gpu:1:gpuClockGraphics']) {
      expect(history.calls).toContain(key)
    }
    expect(history.calls.filter((c) => c.startsWith('gpu:0:'))).toEqual([])
    // Gauges now show GPU 1's utilization / temperature / power
    expect(screen.getByText('77')).toBeTruthy()
    expect(screen.getByText('61')).toBeTruthy()
    expect(screen.getByText('220')).toBeTruthy()
    expect(screen.getByRole('button', { name: /GPU 1/ }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: /GPU 0/ }).getAttribute('aria-pressed')).toBe('false')
  })

  it('chart event markers follow the selected GPU', () => {
    const events: GpuEvent[] = [
      { timestamp_ms: 900, gpu_index: 0, event_type: 'thermal', detail: 'gpu0 thermal' },
      { timestamp_ms: 950, gpu_index: 1, event_type: 'throttle', detail: 'gpu1 throttle' },
      { timestamp_ms: 980, gpu_index: null, event_type: 'xid', detail: 'global xid' },
    ]
    render(<Dashboard metrics={makeSnapshot([gpu0, gpu1])} history={stubHistory()} events={events} requests={[]} />)

    let details = screen.getAllByTestId('chart-event').map((e) => e.textContent)
    expect(details).toContain('gpu0 thermal')
    expect(details).toContain('global xid')
    expect(details).not.toContain('gpu1 throttle')

    fireEvent.click(screen.getByRole('button', { name: /GPU 1/ }))

    details = screen.getAllByTestId('chart-event').map((e) => e.textContent)
    expect(details).toContain('gpu1 throttle')
    expect(details).toContain('global xid')
    expect(details).not.toContain('gpu0 thermal')
  })

  it('keeps the selected GPU when a new snapshot arrives', () => {
    const history = stubHistory()
    const snapshot = makeSnapshot([gpu0, gpu1])
    const { rerender } = render(<Dashboard metrics={snapshot} history={history} events={[]} requests={[]} />)

    fireEvent.click(screen.getByRole('button', { name: /GPU 1/ }))
    history.calls.length = 0

    rerender(
      <Dashboard metrics={{ ...snapshot, timestamp_ms: 2000 }} history={history} events={[]} requests={[]} />,
    )

    expect(screen.getByRole('button', { name: /GPU 1/ }).getAttribute('aria-pressed')).toBe('true')
    expect(history.calls).toContain('gpu:1:gpuUtil')
    expect(history.calls.filter((c) => c.startsWith('gpu:0:'))).toEqual([])
  })

  it('falls back to the primary GPU when the selected GPU disappears', () => {
    const history = stubHistory()
    const { rerender } = render(
      <Dashboard metrics={makeSnapshot([gpu0, gpu1])} history={history} events={[]} requests={[]} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /GPU 1/ }))

    rerender(<Dashboard metrics={makeSnapshot([gpu0])} history={history} events={[]} requests={[]} />)

    expect(gpuSelector()).toBeNull()
    expect(screen.getByText('11')).toBeTruthy()
  })
})

describe('Dashboard single-GPU regression', () => {
  it.each<[string, MetricsSnapshot]>([
    ['single-entry gpus array', makeSnapshot([gpu0])],
    ['legacy gpu-only payload', makeSnapshot(undefined)],
  ])('renders the pre-multi-GPU UI for a %s', (_label, snapshot) => {
    const history = stubHistory()
    const { container } = render(
      <Dashboard metrics={snapshot} history={history} events={[]} requests={[]} />,
    )

    // No selector strip, no per-GPU chrome
    expect(gpuSelector()).toBeNull()
    expect(screen.queryByText('GPU 0')).toBeNull()
    expect(container.querySelector('[aria-pressed]')).toBeNull()

    // Card subtitles carry the plain GPU name, not the multi-GPU "GPU n · name" form
    expect(screen.getAllByText('NVIDIA Alpha 0').length).toBeGreaterThan(0)
    expect(screen.queryByText(/GPU 0 · /)).toBeNull()

    // Charts read the legacy un-prefixed history keys
    for (const key of ['gpuUtil', 'gpuTemp', 'gpuPower', 'gpuClockGraphics']) {
      expect(history.calls).toContain(key)
    }
    expect(history.calls.filter((c) => c.startsWith('gpu:'))).toEqual([])
  })
})
