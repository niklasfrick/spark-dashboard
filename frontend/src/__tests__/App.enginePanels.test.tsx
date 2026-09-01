import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import App from '../App'
import {
  configurationResponse,
  serveConfiguration,
  type FetchMock,
} from '../test/configurationServer'
import { MockWebSocket, substituteWebSocket } from '../test/websocket'
import { DASHBOARD_SCHEMA_VERSION } from '../lib/dashboard/schema'
import type { EngineMetrics, EngineSnapshot, MetricsSnapshot } from '../types/metrics'

// The engine panels through the application seam (#81): real routing, real
// configuration loading, real registry, store and binding resolution, with the
// snapshot arriving over the substituted metrics socket — the same seam the
// hardware panels use. The chart is substituted so the series each panel
// requested is assertable; every value assertion is on what the panels
// themselves render.
substituteWebSocket()

vi.mock('@/components/charts/TimeSeriesChart', () => ({
  TimeSeriesChart: (props: {
    data?: Array<{ value: number }>
    series?: Array<{ label: string; data: Array<{ value: number }> }>
  }) => (
    <div data-testid="chart" data-values={props.data?.map((p) => p.value).join(',')}>
      {props.series?.map((s) => (
        <div
          key={s.label}
          data-testid={`chart-series-${s.label}`}
          data-values={s.data.map((p) => p.value).join(',')}
        />
      ))}
    </div>
  ),
}))

const ALPHA = 'http://localhost:8000'
const BETA = 'http://localhost:8001'

/** A stored page holding panels; binding omitted means `follow`. */
function storedDocument(panels: unknown[]): string {
  return JSON.stringify({
    version: DASHBOARD_SCHEMA_VERSION,
    pages: [{ id: 'engines', name: 'Engines', panels }],
  })
}

function engineMetrics(overrides: Partial<EngineMetrics> = {}): EngineMetrics {
  return {
    tokens_per_sec: 120,
    avg_tokens_per_sec: 100,
    per_request_tps: 40,
    ttft_ms: 210,
    active_requests: 3,
    queued_requests: 1,
    kv_cache_percent: 42,
    kv_cache_is_estimated: false,
    total_requests: 900,
    e2e_latency_ms: 4200,
    prompt_tokens_per_sec: 3000,
    avg_prompt_tokens_per_sec: 2500,
    per_request_prompt_tps: 800,
    swapped_requests: 0,
    prefix_cache_hit_rate: 55,
    queue_time_ms: 12,
    inter_token_latency_ms: 9,
    preemptions_total: 0,
    total_prompt_tokens: 1_000_000,
    total_generation_tokens: 500_000,
    prefix_cache_queries_total: 2_000_000,
    avg_batch_size: 6.5,
    ttft_percentiles: { p50_ms: 200, p95_ms: 400, p99_ms: 900 },
    itl_percentiles: null,
    e2e_percentiles: null,
    ttft_goodput_pct: 99,
    itl_goodput_pct: 98,
    e2e_goodput_pct: 97,
    ttft_buckets: null,
    itl_buckets: null,
    e2e_buckets: null,
    tpot_ms: 8,
    tpot_percentiles: null,
    tpot_goodput_pct: 96,
    tpot_buckets: null,
    spec_decode_draft_tokens_total: null,
    spec_decode_accepted_tokens_total: null,
    spec_decode_drafts_total: null,
    spec_decode_acceptance_rate: null,
    spec_decode_acceptance_rate_live: null,
    spec_decode_mean_acceptance_length: null,
    ...overrides,
  }
}

function makeEngine(
  endpoint: string,
  overrides: Partial<EngineSnapshot> = {},
  metricOverrides: Partial<EngineMetrics> = {},
): EngineSnapshot {
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
    metrics: engineMetrics(metricOverrides),
    recent_requests: [],
    deployment_mode: 'Native',
    ...overrides,
  }
}

function makeSnapshot(ts: number, engines: EngineSnapshot[]): MetricsSnapshot {
  return {
    timestamp_ms: ts,
    gpu: {
      index: 0,
      name: 'NVIDIA GB10',
      utilization_percent: 76,
      memory_total_bytes: null,
      memory_used_bytes: null,
      temperature_celsius: 61,
      power_watts: 220,
      power_limit_watts: 300,
      clock_graphics_mhz: 2100,
      clock_sm_mhz: null,
      clock_memory_mhz: null,
      fan_speed_percent: null,
    },
    cpu: { name: 'Grace CPU', aggregate_percent: 25, per_core: [] },
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
    disk: { name: 'nvme0n1', read_bytes_per_sec: 1, write_bytes_per_sec: 2 },
    network: { name: 'enp1s0', rx_bytes_per_sec: 3, tx_bytes_per_sec: 4 },
    engines,
    gpu_events: [],
  }
}

function visit(pathname: string) {
  window.history.replaceState(null, '', pathname)
}

async function configurationSettles(fetchMock: FetchMock) {
  await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  await act(() => configurationResponse(fetchMock))
}

/** The metrics socket delivers one snapshot; the first frame flushes at once,
 *  later ones on the 2s coalescing timer the socket hook runs. */
function receive(snapshot: MetricsSnapshot) {
  act(() => {
    MockWebSocket.instances[0].receive(JSON.stringify(snapshot))
    vi.advanceTimersByTime(2000)
  })
}

function region(name: string): HTMLElement {
  return screen.getByRole('region', { name })
}

/** The four metric panels this page shows, tiled inside the 12×8 grid. */
function enginePanels(): unknown[] {
  return [
    { id: 'prefill', type: 'engine-prefill-throughput', geometry: { x: 0, y: 0, w: 3, h: 4 } },
    { id: 'decode', type: 'engine-decode-throughput', geometry: { x: 3, y: 0, w: 3, h: 4 } },
    { id: 'latency', type: 'engine-latency', geometry: { x: 6, y: 0, w: 3, h: 4 } },
    { id: 'requests', type: 'engine-requests', geometry: { x: 9, y: 0, w: 3, h: 4 } },
  ]
}

beforeEach(() => {
  MockWebSocket.instances = []
  window.localStorage.clear()
  vi.useFakeTimers({ shouldAdvanceTime: true })
  visit('/pages/engines')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the engine panels on a grid page', () => {
  it('renders each metric from the followed engine', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(enginePanels()) })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(1000, [makeEngine(ALPHA)]))

    const prefill = region('Prefill Throughput')
    expect(within(prefill).getByText('3000.0')).toBeInTheDocument()
    expect(within(prefill).getByText('2500.0')).toBeInTheDocument()
    expect(within(prefill).getByText('Processed')).toBeInTheDocument()

    const decode = region('Decode Throughput')
    expect(within(decode).getByText('120.0')).toBeInTheDocument()
    expect(within(decode).getByText('Generated')).toBeInTheDocument()

    const latency = region('Latency')
    expect(within(latency).getByText('210')).toBeInTheDocument()
    expect(within(latency).getByText('4.20')).toBeInTheDocument()
    expect(within(latency).getByText('6.5')).toBeInTheDocument()

    const requests = region('Requests')
    expect(within(requests).getByText('3')).toBeInTheDocument()
    expect(within(requests).getByText('900')).toBeInTheDocument()
    // Swapped and preempted stay hidden while they are zero.
    expect(within(requests).queryByText('Swapped')).not.toBeInTheDocument()

    // Every panel on the page is implemented — no slot-keeping placeholders.
    expect(screen.queryByText('This panel is not available yet.')).not.toBeInTheDocument()
  })

  it('charts each panel’s own series over the panel’s window', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(enginePanels()) })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(1000, [makeEngine(ALPHA)]))
    receive(makeSnapshot(2000, [makeEngine(ALPHA, {}, { tokens_per_sec: 140, ttft_ms: 250 })]))

    expect(within(region('Decode Throughput')).getByTestId('chart-series-Live')).toHaveAttribute(
      'data-values',
      '120,140',
    )
    expect(within(region('Latency')).getByTestId('chart-series-TTFT')).toHaveAttribute(
      'data-values',
      '210,250',
    )
  })

  it('shows two engines side by side when the panels are pinned to them', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument([
        {
          id: 'alpha',
          type: 'engine-decode-throughput',
          title: 'Alpha decode',
          binding: { kind: 'engine', endpoint: ALPHA },
          geometry: { x: 0, y: 0, w: 6, h: 4 },
        },
        {
          id: 'beta',
          type: 'engine-decode-throughput',
          title: 'Beta decode',
          binding: { kind: 'engine', endpoint: BETA },
          geometry: { x: 6, y: 0, w: 6, h: 4 },
        },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(
      makeSnapshot(1000, [
        makeEngine(ALPHA, {}, { tokens_per_sec: 120 }),
        makeEngine(BETA, {}, { tokens_per_sec: 640 }),
      ]),
    )

    // Both engines are on screen at once, each panel showing its own — value
    // and chart series, so no panel is reading the other engine's history.
    const alpha = region('Alpha decode')
    expect(within(alpha).getByText('120.0')).toBeInTheDocument()
    expect(within(alpha).getByTestId('chart-series-Live')).toHaveAttribute('data-values', '120')

    const beta = region('Beta decode')
    expect(within(beta).getByText('640.0')).toBeInTheDocument()
    expect(within(beta).getByTestId('chart-series-Live')).toHaveAttribute('data-values', '640')

    // With several engines each panel names the one it is showing.
    expect(within(alpha).getByText('vLLM localhost:8000')).toBeInTheDocument()
    expect(within(beta).getByText('vLLM localhost:8001')).toBeInTheDocument()
  })

  it('keeps the slot of a panel pinned to an engine that is gone, naming it', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument([
        {
          id: 'moved',
          type: 'engine-latency',
          binding: { kind: 'engine', endpoint: 'http://localhost:9999' },
          geometry: { x: 0, y: 0, w: 6, h: 4 },
        },
        { id: 'requests', type: 'engine-requests', geometry: { x: 6, y: 0, w: 6, h: 4 } },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(1000, [makeEngine(ALPHA)]))

    // The endpoint the operator pinned is named, never substituted — and the
    // neighbour still renders, so the page did not break or reflow.
    expect(
      within(region('Latency')).getByText('No engine at http://localhost:9999 — repoint this panel.'),
    ).toBeInTheDocument()
    expect(within(region('Requests')).getByText('900')).toBeInTheDocument()
  })

  it('degrades to an empty state on a host running no engines', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(enginePanels()) })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(1000, []))

    // Every panel keeps its slot and says why it is empty; nothing breaks the
    // page, which is what keeps the dashboard useful for hardware alone.
    expect(screen.getAllByText('No inference engine running.')).toHaveLength(4)
  })

  it('tells an engine that is still starting apart from one that is not running', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument([
        {
          id: 'starting',
          type: 'engine-decode-throughput',
          title: 'Starting',
          binding: { kind: 'engine', endpoint: ALPHA },
          geometry: { x: 0, y: 0, w: 6, h: 4 },
        },
        {
          id: 'stopped',
          type: 'engine-decode-throughput',
          title: 'Stopped',
          binding: { kind: 'engine', endpoint: BETA },
          geometry: { x: 6, y: 0, w: 6, h: 4 },
        },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(
      makeSnapshot(1000, [
        makeEngine(ALPHA, { status: { type: 'Loading' }, metrics: null }),
        makeEngine(BETA, { status: { type: 'Stopped' } }),
      ]),
    )

    expect(
      within(region('Starting')).getByText('vLLM localhost:8000 has no metrics yet.'),
    ).toBeInTheDocument()
    expect(
      within(region('Stopped')).getByText('vLLM localhost:8001 is not running.'),
    ).toBeInTheDocument()
  })

  it('waits quietly before the first snapshot, then fills in when it arrives', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(enginePanels()) })

    render(<App />)
    await configurationSettles(fetchMock)

    expect(screen.getAllByText('Waiting for metrics')).toHaveLength(4)

    // The first snapshot must not trip the changed-hook-count trap.
    receive(makeSnapshot(1000, [makeEngine(ALPHA)]))
    expect(screen.queryByText('Waiting for metrics')).not.toBeInTheDocument()
    expect(within(region('Decode Throughput')).getByText('120.0')).toBeInTheDocument()
  })
})
