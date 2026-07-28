import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Dashboard } from '../components/views/Dashboard'
import type { EngineSnapshot, GpuMetrics, MetricsSnapshot } from '../types/metrics'
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

function makeSnapshot(gpus: GpuMetrics[] | undefined, engines: EngineSnapshot[] = []): MetricsSnapshot {
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
    engines,
    gpu_events: [],
  }
}

function makeEngine(gpuIndexes?: number[]): EngineSnapshot {
  return {
    engine_type: 'Vllm',
    endpoint: 'http://localhost:8000',
    status: { type: 'Running' },
    model: {
      name: 'test-model',
      parameter_size: null,
      precision: null,
      quantization: null,
      tensor_type: null,
      model_type: null,
      pipeline_tag: null,
    },
    metrics: null,
    recent_requests: [],
    deployment_mode: 'Native',
    gpu_indexes: gpuIndexes,
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
  it('switches all GPU chart panels and gauges to the clicked GPU', async () => {
    const user = userEvent.setup()
    const history = stubHistory()
    render(<Dashboard metrics={makeSnapshot([gpu0, gpu1])} history={history} events={[]} requests={[]} />)

    expect(gpuSelector()).toBeInTheDocument()
    // Primary GPU selected by default: per-GPU keys for GPU 0, gauge shows its util
    expect(history.calls).toContain('gpu:0:gpuUtil')
    expect(screen.getByText('11')).toBeInTheDocument()

    history.calls.length = 0
    await user.click(screen.getByRole('button', { name: /GPU 1/ }))

    for (const key of ['gpu:1:gpuUtil', 'gpu:1:gpuTemp', 'gpu:1:gpuPower', 'gpu:1:gpuClockGraphics']) {
      expect(history.calls).toContain(key)
    }
    expect(history.calls.filter((c) => c.startsWith('gpu:0:'))).toEqual([])
    // Gauges now show GPU 1's utilization / temperature / power
    expect(screen.getByText('77')).toBeInTheDocument()
    expect(screen.getByText('61')).toBeInTheDocument()
    expect(screen.getByText('220')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /GPU 1/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /GPU 0/ })).toHaveAttribute('aria-pressed', 'false')
  })

  it('chart event markers follow the selected GPU', async () => {
    const user = userEvent.setup()
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

    await user.click(screen.getByRole('button', { name: /GPU 1/ }))

    details = screen.getAllByTestId('chart-event').map((e) => e.textContent)
    expect(details).toContain('gpu1 throttle')
    expect(details).toContain('global xid')
    expect(details).not.toContain('gpu0 thermal')
  })

  it('survives the metrics null → first-snapshot transition (initial WebSocket connect)', () => {
    // Regression: with hooks split across the `if (!metrics) return null` early
    // return, the first snapshot changed the hook count mid-life and React threw
    // "Rendered more hooks than during the previous render" — a white screen.
    const history = stubHistory()
    const { rerender } = render(<Dashboard metrics={null} history={history} events={[]} requests={[]} />)

    expect(() =>
      rerender(
        <Dashboard metrics={makeSnapshot([gpu0, gpu1])} history={history} events={[]} requests={[]} />,
      ),
    ).not.toThrow()
    expect(gpuSelector()).toBeInTheDocument()
  })

  it('keeps the selected GPU when a new snapshot arrives', async () => {
    const user = userEvent.setup()
    const history = stubHistory()
    const snapshot = makeSnapshot([gpu0, gpu1])
    const { rerender } = render(<Dashboard metrics={snapshot} history={history} events={[]} requests={[]} />)

    await user.click(screen.getByRole('button', { name: /GPU 1/ }))
    history.calls.length = 0

    rerender(
      <Dashboard metrics={{ ...snapshot, timestamp_ms: 2000 }} history={history} events={[]} requests={[]} />,
    )

    expect(screen.getByRole('button', { name: /GPU 1/ })).toHaveAttribute('aria-pressed', 'true')
    expect(history.calls).toContain('gpu:1:gpuUtil')
    expect(history.calls.filter((c) => c.startsWith('gpu:0:'))).toEqual([])
  })

  it('falls back to the primary GPU when the selected GPU disappears', async () => {
    const user = userEvent.setup()
    const history = stubHistory()
    const { rerender } = render(
      <Dashboard metrics={makeSnapshot([gpu0, gpu1])} history={history} events={[]} requests={[]} />,
    )
    await user.click(screen.getByRole('button', { name: /GPU 1/ }))

    rerender(<Dashboard metrics={makeSnapshot([gpu0])} history={history} events={[]} requests={[]} />)

    expect(gpuSelector()).not.toBeInTheDocument()
    expect(screen.getByText('11')).toBeInTheDocument()
  })
})

describe('Dashboard engine GPU binding', () => {
  it('automatically follows the selected engine GPU', async () => {
    const user = userEvent.setup()
    const history = stubHistory()
    const engine0 = makeEngine([0])
    const engine1 = { ...makeEngine([1]), endpoint: 'http://localhost:8001', model: { ...makeEngine([1]).model!, name: 'second-model' } }
    render(
      <Dashboard
        metrics={makeSnapshot([gpu0, gpu1], [engine0, engine1])}
        history={history}
        events={[]}
        requests={[]}
      />,
    )

    await user.click(screen.getByRole('tab', { name: /second-model/ }))

    expect(screen.getByRole('button', { name: /GPU 1/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('77')).toBeInTheDocument()
  })

  it('keeps the manual GPU when the selected engine spans it', async () => {
    const user = userEvent.setup()
    const history = stubHistory()
    const engine0 = makeEngine([0])
    const engineBoth = { ...makeEngine([0, 1]), endpoint: 'http://localhost:8001', model: { ...makeEngine([0, 1]).model!, name: 'parallel-model' } }
    render(
      <Dashboard
        metrics={makeSnapshot([gpu0, gpu1], [engine0, engineBoth])}
        history={history}
        events={[]}
        requests={[]}
      />,
    )

    await user.click(screen.getByRole('button', { name: /GPU 1/ }))
    await user.click(screen.getByRole('tab', { name: /parallel-model/ }))

    expect(screen.getByRole('button', { name: /GPU 1/ })).toHaveAttribute('aria-pressed', 'true')
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
    expect(gpuSelector()).not.toBeInTheDocument()
    expect(screen.queryByText('GPU 0')).not.toBeInTheDocument()
    expect(container.querySelector('[aria-pressed]')).not.toBeInTheDocument()

    // Card subtitles carry the plain GPU name, not the multi-GPU "GPU n · name" form
    expect(screen.getAllByText('NVIDIA Alpha 0').length).toBeGreaterThan(0)
    expect(screen.queryByText(/GPU 0 · /)).not.toBeInTheDocument()

    // Charts read the legacy un-prefixed history keys
    for (const key of ['gpuUtil', 'gpuTemp', 'gpuPower', 'gpuClockGraphics']) {
      expect(history.calls).toContain(key)
    }
    expect(history.calls.filter((c) => c.startsWith('gpu:'))).toEqual([])
  })
})
