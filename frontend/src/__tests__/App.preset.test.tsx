import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import App from '../App'
import { configurationResponse, serveConfiguration, type FetchMock } from '../test/configurationServer'
import { MockWebSocket, substituteWebSocket } from '../test/websocket'
import { defaultDashboardDocument } from '../lib/dashboard/preset'
import type { EngineSnapshot, GpuMetrics, MetricsSnapshot } from '../types/metrics'

// The default preset on the hosts it has to land on unmodified (#86): one GPU,
// four GPUs, and a machine running no inference engine at all. It is one static
// document with `follow` bindings throughout, so what is being tested is that
// the same bytes are right in all three places — the alternative the spec
// rejected was generating a layout per host.
//
// Driven through the application seam with nothing configured on the server,
// which is exactly the state a fresh install is in.
substituteWebSocket()

vi.mock('@/components/charts/TimeSeriesChart', () => ({
  TimeSeriesChart: () => <div data-testid="chart" />,
}))

const GIB = 1_073_741_824
const MIB = 1_048_576

function makeGpu(index: number, overrides: Partial<GpuMetrics> = {}): GpuMetrics {
  return {
    index,
    name: `NVIDIA GB10 ${index}`,
    utilization_percent: 70 + index,
    memory_total_bytes: 48 * GIB,
    memory_used_bytes: 24 * GIB,
    temperature_celsius: 60 + index,
    power_watts: 220,
    power_limit_watts: 300,
    clock_graphics_mhz: 2100,
    clock_sm_mhz: 2100,
    clock_memory_mhz: 9000,
    fan_speed_percent: 30,
    ...overrides,
  }
}

function makeEngine(): EngineSnapshot {
  return {
    engine_type: 'Vllm',
    endpoint: 'http://localhost:8000',
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
    metrics: {
      tokens_per_sec: 812,
      avg_tokens_per_sec: 800,
      per_request_tps: 40,
      ttft_ms: 210,
      active_requests: 4,
      queued_requests: 1,
      kv_cache_percent: 42,
      kv_cache_is_estimated: false,
      total_requests: 900,
      e2e_latency_ms: 4200,
      prompt_tokens_per_sec: 1500,
      avg_prompt_tokens_per_sec: 1400,
      per_request_prompt_tps: 800,
      swapped_requests: 0,
      prefix_cache_hit_rate: 55,
      queue_time_ms: 12,
      inter_token_latency_ms: 9,
      preemptions_total: 0,
      total_prompt_tokens: 2_000_000,
      total_generation_tokens: 1_000_000,
      prefix_cache_queries_total: 2_000_000,
      avg_batch_size: 6.5,
      ttft_percentiles: null,
      itl_percentiles: null,
      e2e_percentiles: null,
      ttft_goodput_pct: null,
      itl_goodput_pct: null,
      e2e_goodput_pct: null,
      ttft_buckets: null,
      itl_buckets: null,
      e2e_buckets: null,
      tpot_ms: 8,
      tpot_percentiles: null,
      tpot_goodput_pct: null,
      tpot_buckets: null,
      spec_decode_draft_tokens_total: null,
      spec_decode_accepted_tokens_total: null,
      spec_decode_drafts_total: null,
      spec_decode_acceptance_rate: null,
      spec_decode_acceptance_rate_live: null,
      spec_decode_mean_acceptance_length: null,
    },
    recent_requests: [],
    deployment_mode: 'Native',
  }
}

function makeSnapshot(gpus: GpuMetrics[], engines: EngineSnapshot[]): MetricsSnapshot {
  return {
    timestamp_ms: 1000,
    gpu: gpus[0],
    ...(gpus.length > 1 ? { gpus } : {}),
    cpu: {
      name: 'Grace CPU',
      aggregate_percent: 25,
      per_core: [{ id: 0, usage_percent: 10 }],
    },
    memory: {
      total_bytes: 128 * GIB,
      display_total_bytes: 128 * GIB,
      used_bytes: 64 * GIB,
      available_bytes: 64 * GIB,
      cached_bytes: 8 * GIB,
      gpu_estimated_bytes: 24 * GIB,
      gpu_memory_total_bytes: null,
      gpu_memory_used_bytes: null,
      is_unified: true,
    },
    disk: { name: 'nvme0n1', read_bytes_per_sec: 12 * MIB, write_bytes_per_sec: 3 * MIB },
    network: { name: 'enp1s0', rx_bytes_per_sec: 1 * MIB, tx_bytes_per_sec: 2 * MIB },
    engines,
    gpu_events: [],
  }
}

/** Nothing configured on the server — the fresh install the preset is for. */
async function openFreshInstall(): Promise<FetchMock> {
  const fetchMock = serveConfiguration({ document: null })
  render(<App />)
  await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  await act(() => configurationResponse(fetchMock))
  return fetchMock
}

function receive(snapshot: MetricsSnapshot) {
  act(() => MockWebSocket.instances[0].receive(JSON.stringify(snapshot)))
}

/** Every panel the preset places, by the name its frame carries. */
const PRESET_PANELS = [
  'GPU Utilization',
  'GPU Power',
  'GPU Temp',
  'Decode Throughput',
  'Latency',
  'Requests',
  'CPU',
  'Memory',
  'Disk I/O',
  'Network',
]

beforeEach(() => {
  MockWebSocket.instances = []
  window.history.replaceState(null, '', '/')
})

describe('the default preset on the hosts it ships to', () => {
  it('places every panel on the page, whatever the host turns out to be', () => {
    // The document itself, before any host is involved: what the three specs
    // below then check renders correctly on their own hardware.
    const [page] = defaultDashboardDocument().pages
    expect(page.panels).toHaveLength(PRESET_PANELS.length)
  })

  it('works on a one-GPU host running an engine', async () => {
    await openFreshInstall()
    receive(makeSnapshot([makeGpu(0)], [makeEngine()]))

    for (const name of PRESET_PANELS) {
      expect(screen.getByRole('region', { name }), name).toBeInTheDocument()
    }

    // Live values, not placeholders, on both halves of the page.
    expect(within(screen.getByRole('region', { name: 'GPU Utilization' })).getByText('70')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Decode Throughput' })).getByText('812.0')).toBeInTheDocument()
    expect(screen.queryByText('No inference engine running.')).not.toBeInTheDocument()
    expect(screen.queryByText('No GPU on this host.')).not.toBeInTheDocument()
    expect(screen.queryByText('This panel is not available yet.')).not.toBeInTheDocument()
  })

  it('works unmodified on a four-GPU host', async () => {
    await openFreshInstall()
    receive(makeSnapshot([makeGpu(0), makeGpu(1), makeGpu(2), makeGpu(3)], [makeEngine()]))

    // Same document, no editing: every panel follows the page's GPU selection
    // rather than naming an index the preset could have guessed wrong.
    for (const name of PRESET_PANELS) {
      expect(screen.getByRole('region', { name }), name).toBeInTheDocument()
    }

    const utilization = screen.getByRole('region', { name: 'GPU Utilization' })
    expect(within(utilization).getByText('70')).toBeInTheDocument()
    // With several GPUs the panel says which one it is showing, so no panel is
    // read as the whole host.
    expect(within(utilization).getByText(/GPU 0/)).toBeInTheDocument()
    expect(screen.queryByText('is not on this host.')).not.toBeInTheDocument()
  })

  it('is still worth opening on a host running no engines', async () => {
    await openFreshInstall()
    receive(makeSnapshot([makeGpu(0)], []))

    // The hardware the machine does have is on screen and reading correctly…
    expect(within(screen.getByRole('region', { name: 'GPU Utilization' })).getByText('70')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'CPU' })).getByText('25')).toBeInTheDocument()

    // …and the engine band says what is missing in plain words, keeping its
    // slots rather than reflowing the arrangement around them.
    for (const name of ['Decode Throughput', 'Latency', 'Requests']) {
      expect(
        within(screen.getByRole('region', { name })).getByText('No inference engine running.'),
        name,
      ).toBeInTheDocument()
    }
  })

  it('opens on a panel with data on it, not on one explaining what is missing', async () => {
    // The engineless host is the one that can greet an operator with a notice.
    // The band that can carry one is deliberately not the first thing read.
    await openFreshInstall()
    receive(makeSnapshot([makeGpu(0)], []))

    const first = screen.getAllByRole('region')[0]
    expect(first).toHaveAccessibleName('GPU Utilization')
    expect(within(first).queryByText(/No inference engine/)).not.toBeInTheDocument()
  })
})
