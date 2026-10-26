import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import App from '../App'
import {
  configurationResponse,
  serveConfiguration,
  type FetchMock,
} from '../test/configurationServer'
import { gridSubstitute } from '../test/gridSubstitute'
import { MockWebSocket, substituteWebSocket } from '../test/websocket'
import {
  PANEL_TYPE_IDS,
  defaultPanelTitle,
  panelMetricGroups,
  type PanelType,
} from '../lib/dashboard/panels'
import { DASHBOARD_SCHEMA_VERSION } from '../lib/dashboard/schema'
import { metricGroupOf } from '../lib/engineMetrics'
import { LLAMA_CPP_GROUPS, SGLANG_GROUPS, TENSORFOLD_GROUPS } from '../test/engineGroups'
import { HF_QWEN, OLLAMA_ENDPOINT, TINYLLAMA, ollamaEngine } from '../test/ollama'
import {
  METRIC_GROUPS,
  type EngineMetrics,
  type EngineSnapshot,
  type InferenceRequestData,
  type LoadedModel,
  type MetricGroup,
  type MetricsSnapshot,
  type ModelInfo,
} from '../types/metrics'

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

/** Every panel type that shows an engine's metrics, two to a row. */
const metricPanels = PANEL_TYPE_IDS.filter((type) => panelMetricGroups(type).length > 0).map(
  (type, i) => ({
    id: type,
    type,
    geometry: { x: (i % 2) * 6, y: Math.floor(i / 2) * 2, w: 6, h: 2 },
  }),
)

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

/** A served model, identified by name alone; specs that care about the rest
 *  spread this and override what they need. */
function modelNamed(name: string): ModelInfo {
  return {
    name,
    parameter_size: null,
    quantization: null,
    precision: null,
    tensor_type: null,
    model_type: null,
    pipeline_tag: null,
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
    model: modelNamed('Qwen/Qwen3-8B'),
    metrics: engineMetrics(metricOverrides),
    recent_requests: [],
    deployment_mode: 'Native',
    ...overrides,
  }
}

/** An engine declaring `groups`, with its metrics as the backend puts them on
 *  the wire for it: every field of a group it does not declare is null. */
function declaring(
  endpoint: string,
  groups: readonly MetricGroup[],
  overrides: Partial<EngineMetrics> = {},
): EngineSnapshot {
  const metrics = engineMetrics(overrides)
  for (const key of Object.keys(metrics) as Array<keyof EngineMetrics>) {
    if (groups.includes(metricGroupOf(key))) continue
    Object.assign(metrics, { [key]: key === 'kv_cache_is_estimated' ? false : null })
  }
  return makeEngine(endpoint, { metric_groups: [...groups], metrics })
}

/** A llama-server with `--metrics`, as the backend puts it on the wire: the
 *  groups it declares carry its figures, with speculative decoding configured,
 *  and everything else is null. */
function llamaCpp(overrides: Partial<EngineSnapshot> = {}): EngineSnapshot {
  return {
    ...declaring(ALPHA, LLAMA_CPP_GROUPS, SPEC_DECODE),
    engine_type: 'LlamaCpp',
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
      pcie_rx_bytes_per_sec: null,
      pcie_tx_bytes_per_sec: null,
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

/** One tile of a panel, by the label it wears. Numbers repeat across tiles, so a
 *  value is looked for inside the tile it belongs to. */
function tile(panel: HTMLElement, name: string): HTMLElement {
  return within(panel).getByRole('group', { name })
}

/** The engine block's six tiles as panels, tiled inside the 12×8 grid. Cache
 *  and speculative decoding are one tile on the old card and two panels here,
 *  because a panel is one metric. */
function enginePanels(): unknown[] {
  return [
    { id: 'prefill', type: 'engine-prefill-throughput', geometry: { x: 0, y: 0, w: 3, h: 4 } },
    { id: 'decode', type: 'engine-decode-throughput', geometry: { x: 3, y: 0, w: 3, h: 4 } },
    { id: 'latency', type: 'engine-latency', geometry: { x: 6, y: 0, w: 3, h: 4 } },
    { id: 'requests', type: 'engine-requests', geometry: { x: 9, y: 0, w: 3, h: 4 } },
    { id: 'goodput', type: 'engine-slo-goodput', geometry: { x: 0, y: 4, w: 4, h: 4 } },
    { id: 'cache', type: 'engine-cache', geometry: { x: 4, y: 4, w: 4, h: 4 } },
    { id: 'spec', type: 'engine-spec-decode', geometry: { x: 8, y: 4, w: 4, h: 4 } },
  ]
}

/** Speculative decoding, as an engine that has it enabled reports it. */
const SPEC_DECODE: Partial<EngineMetrics> = {
  spec_decode_draft_tokens_total: 400_000,
  spec_decode_accepted_tokens_total: 300_000,
  spec_decode_drafts_total: 100_000,
  spec_decode_acceptance_rate: 75,
  spec_decode_acceptance_rate_live: 71,
  spec_decode_mean_acceptance_length: 3,
}

/** The four latency means, without their percentiles. */
const LATENCY_MEANS: MetricGroup[] = ['TtftMean', 'E2eMean', 'ItlMean', 'TpotMean']

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

    // Goodput falls back to the backend's percentages while the engine ships
    // no histogram buckets, and the combined figure is the worst of the three.
    const goodput = region('SLO Goodput')
    expect(within(goodput).getByText('Combined')).toBeInTheDocument()
    // Combined is the worst of the three dimensions, so it reads as E2E's own
    // figure — the same number twice, deliberately.
    expect(within(goodput).getAllByText('97.0')).toHaveLength(2)
    expect(within(goodput).getByText('99.0')).toBeInTheDocument()
    expect(within(goodput).getByText('TTFT ≤ 500ms')).toBeInTheDocument()
    expect(within(goodput).getByText('E2E ≤ 5s')).toBeInTheDocument()

    const cache = region('Cache')
    expect(within(cache).getByText('42')).toBeInTheDocument()
    expect(within(cache).getByText('55')).toBeInTheDocument()
    expect(within(cache).getByText('2M')).toBeInTheDocument()

    // This engine is not speculating, so the panel says so rather than
    // rendering a section of dashes.
    expect(
      within(region('Speculative Decoding')).getByText(
        'This engine is not using speculative decoding.',
      ),
    ).toBeInTheDocument()

    // Every panel on the page is implemented — no slot-keeping placeholders.
    expect(screen.queryByText('This panel is not available yet.')).not.toBeInTheDocument()
    // A backend older than the declaration reported every group: no tile says
    // otherwise.
    expect(screen.queryByText('not reported')).not.toBeInTheDocument()

    // One engine on the host: nothing to tell apart, so no panel wears its
    // name or its provider mark.
    expect(within(region('Latency')).queryByRole('img')).not.toBeInTheDocument()
    expect(screen.queryByText('vLLM localhost:8000')).not.toBeInTheDocument()
  })

  it('says which engine it is and what it is serving', async () => {
    // The identity the fixed dashboard carried in its engine header, now a
    // panel of its own — placed once, rather than repeated on all six metric
    // panels an operator would then read the same model name off.
    const fetchMock = serveConfiguration({
      document: storedDocument([
        { id: 'who', type: 'engine-status', geometry: { x: 0, y: 0, w: 6, h: 4 } },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(
      makeSnapshot(1000, [
        makeEngine(ALPHA, {
          model: {
            ...modelNamed('Qwen/Qwen3-8B'),
            parameter_size: '8B',
            quantization: 'AWQ',
            precision: 'bf16',
          },
          gpu_indexes: [0, 1],
        }),
      ]),
    )

    const status = region('Engine')
    // The organization prefix goes: the provider mark beside it already says it.
    expect(within(status).getByText('Qwen3-8B')).toBeInTheDocument()
    expect(within(status).getByRole('img', { name: 'Qwen' })).toBeInTheDocument()
    expect(within(status).getByText('Serving')).toBeInTheDocument()

    // The deployment and the weights, each omitted rather than dashed when the
    // backend did not report it.
    for (const tag of ['vLLM', 'Direct', 'GPU 0+1', '8B', 'AWQ', 'bf16']) {
      expect(within(status).getByText(tag), tag).toBeInTheDocument()
    }
  })

  // The engine chip's icon is the engine type's own — the status panel used
  // to show vLLM's on every engine.
  it.each([
    ['Vllm', 'vLLM', '/icons/vllm.svg'],
    ['Sglang', 'SGLang', '/icons/sglang.svg'],
    ['LlamaCpp', 'llama.cpp', '/icons/llamacpp.svg'],
    ['Tensorfold', 'TensorFold', '/icons/tensorfold.svg'],
  ] as const)('shows a %s engine under its own name and icon', async (engineType, name, icon) => {
    const fetchMock = serveConfiguration({
      document: storedDocument([
        { id: 'who', type: 'engine-status', geometry: { x: 0, y: 0, w: 6, h: 4 } },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(1000, [makeEngine(ALPHA, { engine_type: engineType })]))

    const chip = within(region('Engine')).getByText(name).parentElement
    expect(chip?.querySelector('img')?.getAttribute('src')).toBe(icon)
  })

  it('says an engine has no model rather than showing an empty identity', async () => {
    // The auth-gated case: /v1/models is refused, so the engine is up and
    // reporting metrics with nothing to say about what it is serving.
    const fetchMock = serveConfiguration({
      document: storedDocument([
        { id: 'who', type: 'engine-status', geometry: { x: 0, y: 0, w: 6, h: 4 } },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(1000, [makeEngine(ALPHA, { model: null })]))

    const status = region('Engine')
    // The absence is the headline, and the engine is still described as
    // serving — it has metrics, only its model could not be read.
    expect(within(status).getByText('No model loaded')).toBeInTheDocument()
    expect(within(status).getByText('Serving')).toBeInTheDocument()
  })

  const AUTH_WARNING =
    'Engine requires authentication — configure the provider API key to read the model name.'

  it('warns beside the fallback name when /v1/models rejects the dashboard', async () => {
    // Issue #90: the engine's /v1/models is auth-gated and the dashboard has
    // no key. The name recovered from the launch command line still shows —
    // it is the best guess there is — but the warning says it is only a
    // guess, and what to configure to make it not one.
    const fetchMock = serveConfiguration({
      document: storedDocument([
        { id: 'who', type: 'engine-status', geometry: { x: 0, y: 0, w: 6, h: 4 } },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(
      makeSnapshot(1000, [
        makeEngine(ALPHA, {
          model: modelNamed('google/gemma-4-31B-it'),
          model_metadata_error: 'AuthRequired',
        }),
      ]),
    )

    const status = region('Engine')
    expect(within(status).getByText('gemma-4-31B-it')).toBeInTheDocument()
    expect(within(status).getByText(AUTH_WARNING)).toBeInTheDocument()
    // The engine itself is fine — metrics flow, so it still reads as serving.
    expect(within(status).getByText('Serving')).toBeInTheDocument()
  })

  it('lets the auth warning stand alone when no name resolved at all', async () => {
    // No command-line hint either: nothing resolved, but "unavailable" is a
    // better headline than "no model loaded" — the model may well be loaded,
    // only its name is unreadable without the key.
    const fetchMock = serveConfiguration({
      document: storedDocument([
        { id: 'who', type: 'engine-status', geometry: { x: 0, y: 0, w: 6, h: 4 } },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(
      makeSnapshot(1000, [
        makeEngine(ALPHA, { model: null, model_metadata_error: 'AuthRequired' }),
      ]),
    )

    const status = region('Engine')
    expect(within(status).getByText('Model name unavailable')).toBeInTheDocument()
    expect(within(status).getByText(AUTH_WARNING)).toBeInTheDocument()
    expect(within(status).queryByText('No model loaded')).not.toBeInTheDocument()
  })

  it('does not warn when metadata resolved, or failed for non-auth reasons', async () => {
    // A key would not fix an unreachable /v1/models, so no warning may send
    // the operator configuring one. The resolved case is the everyday one:
    // nothing to warn about at all.
    const fetchMock = serveConfiguration({
      document: storedDocument([
        { id: 'who', type: 'engine-status', geometry: { x: 0, y: 0, w: 6, h: 4 } },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(
      makeSnapshot(1000, [
        makeEngine(ALPHA, { model_metadata_error: 'Unavailable' }),
      ]),
    )

    const status = region('Engine')
    expect(within(status).getByText('Qwen3-8B')).toBeInTheDocument()
    expect(within(status).queryByText(AUTH_WARNING)).not.toBeInTheDocument()

    // Metadata resolves once the key is configured — the warning clears.
    receive(makeSnapshot(2000, [makeEngine(ALPHA, { model_metadata_error: null })]))
    expect(within(region('Engine')).queryByText(AUTH_WARNING)).not.toBeInTheDocument()
  })

  it('sums every engine on the host into one overview', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument([
        { id: 'all', type: 'engines-overview', geometry: { x: 0, y: 0, w: 6, h: 4 } },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(
      makeSnapshot(1000, [
        makeEngine(ALPHA, {}, { tokens_per_sec: 120, active_requests: 3, queued_requests: 1 }),
        makeEngine(
          BETA,
          { model: modelNamed('meta-llama/Llama-3.1-8B') },
          { tokens_per_sec: 640, active_requests: 4, queued_requests: 2 },
        ),
      ]),
    )

    const all = region('All Engines')
    // Throughput and counts sum: concurrent workers compose additively.
    expect(within(all).getByText('760.0')).toBeInTheDocument()
    expect(within(all).getByText('7')).toBeInTheDocument() // active: 3 + 4
    expect(within(all).getByText('3')).toBeInTheDocument() // queued: 1 + 2
    // Both engines are running, and each provider is named once with its count.
    expect(within(all).getByText('2/2 running')).toBeInTheDocument()
    // Labelled by the model's own organization prefix, which is authoritative
    // — `custom-org/llama-3b` is not Meta's, whatever the weights are.
    expect(within(all).getByText('Qwen (1)')).toBeInTheDocument()
    expect(within(all).getByText('meta-llama (1)')).toBeInTheDocument()
  })

  it('says the host is running nothing rather than summing zero engines', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument([
        { id: 'all', type: 'engines-overview', geometry: { x: 0, y: 0, w: 6, h: 4 } },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(1000, []))

    expect(
      within(region('All Engines')).getByText('No inference engine running.'),
    ).toBeInTheDocument()
  })

  it('names the engine when it says one is not speculating', async () => {
    // On a page holding two engines, "this engine" would not say which.
    const fetchMock = serveConfiguration({
      document: storedDocument([
        {
          id: 'alpha-spec',
          type: 'engine-spec-decode',
          title: 'Alpha speculation',
          binding: { kind: 'engine', endpoint: ALPHA },
          geometry: { x: 0, y: 0, w: 6, h: 4 },
        },
        {
          id: 'beta-spec',
          type: 'engine-spec-decode',
          title: 'Beta speculation',
          binding: { kind: 'engine', endpoint: BETA },
          geometry: { x: 6, y: 0, w: 6, h: 4 },
        },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(1000, [makeEngine(ALPHA, {}, SPEC_DECODE), makeEngine(BETA)]))

    expect(within(region('Alpha speculation')).getByText('75')).toBeInTheDocument()
    expect(
      within(region('Beta speculation')).getByText(
        'vLLM localhost:8001 is not using speculative decoding.',
      ),
    ).toBeInTheDocument()
  })

  it('shows speculative decoding once the engine has drafted tokens', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(enginePanels()) })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(1000, [makeEngine(ALPHA, {}, SPEC_DECODE)]))

    const spec = region('Speculative Decoding')
    expect(within(spec).getByText('75')).toBeInTheDocument()
    expect(within(spec).getByText('71% live')).toBeInTheDocument()
    expect(within(spec).getByText('300K')).toBeInTheDocument()
    expect(within(spec).getByText('400K')).toBeInTheDocument()
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
    expect(within(region('Cache')).getByTestId('chart-series-KV Cache')).toHaveAttribute(
      'data-values',
      '42,42',
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
        makeEngine(BETA, { model: modelNamed('meta-llama/Llama-3.1-8B') }, { tokens_per_sec: 640 }),
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

    // With several engines each panel names the one it is showing…
    expect(within(alpha).getByText('vLLM localhost:8000')).toBeInTheDocument()
    expect(within(beta).getByText('vLLM localhost:8001')).toBeInTheDocument()

    // …and marks whose model it is serving, which is the half of the identity
    // two engines on localhost do not carry in their endpoints.
    expect(within(alpha).getByRole('img', { name: 'Qwen' })).toHaveAttribute(
      'src',
      '/icons/providers/qwen.svg',
    )
    expect(within(beta).getByRole('img', { name: 'meta-llama' })).toHaveAttribute(
      'src',
      '/icons/providers/meta.svg',
    )
  })

  it('marks a provisional model name on the identity row too', async () => {
    // The identity row a metric panel wears on a multi-engine host has no
    // room for the warning's words, so it wears a mark carrying them — a
    // panel must not present the command-line fallback as settled identity
    // anywhere the name shows.
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
        makeEngine(ALPHA),
        makeEngine(BETA, {
          model: modelNamed('meta-llama/Llama-3.1-8B'),
          model_metadata_error: 'AuthRequired',
        }),
      ]),
    )

    // Only the engine whose metadata was refused wears the mark.
    expect(within(region('Beta decode')).getByLabelText(AUTH_WARNING)).toBeInTheDocument()
    expect(within(region('Alpha decode')).queryByLabelText(AUTH_WARNING)).not.toBeInTheDocument()
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
    expect(screen.getAllByText('No inference engine running.')).toHaveLength(7)
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

    expect(screen.getAllByText('Waiting for metrics')).toHaveLength(7)

    // The first snapshot must not trip the changed-hook-count trap.
    receive(makeSnapshot(1000, [makeEngine(ALPHA)]))
    expect(screen.queryByText('Waiting for metrics')).not.toBeInTheDocument()
    expect(within(region('Decode Throughput')).getByText('120.0')).toBeInTheDocument()
  })
})

// What an engine reports is declared on its snapshot (ADR-0004, #128). Only
// vLLM exists yet and it reports every group, so these specs hand the panels
// snapshots that declare a partial set — exactly what the next engine type's
// adapter will put on the wire.
describe('an engine that does not report a panel’s metric group', () => {
  /** What each engine metric panel says, bound to an engine reporting nothing. */
  const NOT_REPORTED: Partial<Record<PanelType, string>> = {
    'engine-prefill-throughput': 'vLLM localhost:8000 does not report throughput or TTFT mean.',
    'engine-decode-throughput': 'vLLM localhost:8000 does not report throughput or TPOT mean.',
    'engine-latency':
      'vLLM localhost:8000 does not report latency means, latency percentiles or queue time.',
    'engine-slo-goodput': 'vLLM localhost:8000 does not report latency percentiles.',
    'engine-requests': 'vLLM localhost:8000 does not report requests or preemptions.',
    'engine-cache': 'vLLM localhost:8000 does not report KV cache or prefix cache.',
    'engine-spec-decode': 'vLLM localhost:8000 does not report speculative decoding.',
  }

  beforeEach(() => gridSubstitute.reset())

  it('keeps every engine metric panel’s slot and says so, naming the engine type', async () => {
    // Held against the vocabulary, so a panel type added later that shows
    // engine metrics is in this spec the moment it declares its groups.
    expect(metricPanels.map((p) => p.type).sort()).toEqual(Object.keys(NOT_REPORTED).sort())

    const fetchMock = serveConfiguration({
      document: storedDocument([
        ...metricPanels,
        { id: 'who', type: 'engine-status', geometry: { x: 0, y: 8, w: 6, h: 2 } },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(1000, [makeEngine(ALPHA, { metric_groups: [] })]))

    for (const { id, type, geometry } of metricPanels) {
      const panel = region(defaultPanelTitle(type))
      expect(within(panel).getByText(NOT_REPORTED[type]!), type).toBeInTheDocument()
      // Never a zero or a dash in the group's place, and never a chart of one.
      expect(within(panel).queryByText('--'), type).not.toBeInTheDocument()
      expect(within(panel).queryByText('0'), type).not.toBeInTheDocument()
      expect(within(panel).queryByTestId('chart'), type).not.toBeInTheDocument()
      // The slot is the one the operator authored; nothing reflowed around it.
      expect(gridSubstitute.geometry().get(id), type).toEqual(geometry)
    }

    // The engine's identity is not a metric group: it still says what it is.
    expect(within(region('Engine')).getByText('Qwen3-8B')).toBeInTheDocument()
  })

  it('says so beside a neighbour that does report, naming whose limitation it is', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument([
        {
          id: 'alpha',
          type: 'engine-cache',
          title: 'Alpha cache',
          binding: { kind: 'engine', endpoint: ALPHA },
          geometry: { x: 0, y: 0, w: 6, h: 4 },
        },
        {
          id: 'beta',
          type: 'engine-cache',
          title: 'Beta cache',
          binding: { kind: 'engine', endpoint: BETA },
          geometry: { x: 6, y: 0, w: 6, h: 4 },
        },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(
      makeSnapshot(1000, [
        makeEngine(ALPHA),
        makeEngine(BETA, { metric_groups: ['Throughput', 'ActiveRequests'] }),
      ]),
    )

    expect(within(region('Alpha cache')).getByText('42')).toBeInTheDocument()
    expect(
      within(region('Beta cache')).getByText(
        'vLLM localhost:8001 does not report KV cache or prefix cache.',
      ),
    ).toBeInTheDocument()
    expect(gridSubstitute.geometry().get('alpha')).toEqual({ x: 0, y: 0, w: 6, h: 4 })
    expect(gridSubstitute.geometry().get('beta')).toEqual({ x: 6, y: 0, w: 6, h: 4 })
  })

  it('says so rather than "no metrics yet" — the group is not coming', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument([
        { id: 'spec', type: 'engine-spec-decode', geometry: { x: 0, y: 0, w: 6, h: 4 } },
        { id: 'decode', type: 'engine-decode-throughput', geometry: { x: 6, y: 0, w: 6, h: 4 } },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(
      makeSnapshot(1000, [
        makeEngine(ALPHA, {
          status: { type: 'Loading' },
          metrics: null,
          metric_groups: ['Throughput'],
        }),
      ]),
    )

    // The unreported group says so in every state of the engine; the reported
    // one keeps today's "not yet", which will pass.
    expect(
      within(region('Speculative Decoding')).getByText(
        'vLLM localhost:8000 does not report speculative decoding.',
      ),
    ).toBeInTheDocument()
    expect(
      within(region('Decode Throughput')).getByText('vLLM localhost:8000 has no metrics yet.'),
    ).toBeInTheDocument()
  })

  it('keeps the slot of each latency tile that is not reported, and says so', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument([
        { id: 'latency', type: 'engine-latency', geometry: { x: 0, y: 0, w: 6, h: 4 } },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(1000, [makeEngine(ALPHA, { metric_groups: LATENCY_MEANS })]))

    const latency = region('Latency')
    // The means are all there, under their plain names in the average mode…
    expect(within(tile(latency, 'TTFT')).getByText('210')).toBeInTheDocument()
    expect(within(tile(latency, 'E2E')).getByText('4.20')).toBeInTheDocument()
    expect(within(tile(latency, 'ITL')).getByText('9')).toBeInTheDocument()
    // …while queue time and the batch size keep their slots and say they are
    // not reported, rather than being dashed or left out.
    expect(within(tile(latency, 'Queue')).getByText('not reported')).toBeInTheDocument()
    expect(within(tile(latency, 'Batch')).getByText('not reported')).toBeInTheDocument()
    expect(within(latency).queryByText('--')).not.toBeInTheDocument()
    expect(within(latency).queryByTestId('chart-series-Queue')).not.toBeInTheDocument()
    expect(within(latency).getByTestId('chart-series-TTFT')).toHaveAttribute('data-values', '210')
  })

  it('shows the mean, labelled as the mean, in a percentile mode on a means-only engine', async () => {
    window.localStorage.setItem('spark-dashboard:latency-mode', 'p95')
    const fetchMock = serveConfiguration({
      document: storedDocument([
        { id: 'latency', type: 'engine-latency', geometry: { x: 0, y: 0, w: 6, h: 4 } },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(
      makeSnapshot(1000, [
        makeEngine(ALPHA, { metric_groups: [...LATENCY_MEANS, 'QueueTime', 'BatchSize'] }),
      ]),
    )

    const latency = region('Latency')
    // The header still names p95; each figure says it is the mean instead —
    // the mean TTFT (210), never the p95 the snapshot also happens to carry.
    expect(within(latency).getByRole('combobox', { name: 'Statistic display mode' })).toHaveValue(
      'p95',
    )
    for (const label of ['TTFT mean', 'E2E mean', 'ITL mean', 'TPOT mean']) {
      expect(within(latency).getByText(label), label).toBeInTheDocument()
    }
    expect(within(latency).queryByText('TTFT')).not.toBeInTheDocument()
    expect(within(latency).getByText('210')).toBeInTheDocument()
    expect(within(latency).queryByText('400')).not.toBeInTheDocument()
    // The chart draws the mean's own series, under the same label.
    expect(within(latency).getByTestId('chart-series-TTFT mean')).toHaveAttribute(
      'data-values',
      '210',
    )
    // Queue time and batch size are reported here, and read as they always have.
    expect(within(latency).getByText('Queue')).toBeInTheDocument()
    expect(within(latency).getByText('6.5')).toBeInTheDocument()
  })

  it('keeps percentile headings on an engine that reports percentiles', async () => {
    // vLLM's own behavior in a percentile mode, pinned beside the fallback.
    window.localStorage.setItem('spark-dashboard:latency-mode', 'p95')
    const fetchMock = serveConfiguration({
      document: storedDocument([
        { id: 'latency', type: 'engine-latency', geometry: { x: 0, y: 0, w: 6, h: 4 } },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(1000, [makeEngine(ALPHA, { metric_groups: [...METRIC_GROUPS] })]))

    const latency = region('Latency')
    expect(within(latency).getByText('TTFT')).toBeInTheDocument()
    expect(within(latency).getByText('400')).toBeInTheDocument()
    expect(within(latency).queryByText('TTFT mean')).not.toBeInTheDocument()
  })

  it('says SLO goodput is not reported by an engine with means but no percentiles', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument([
        { id: 'goodput', type: 'engine-slo-goodput', geometry: { x: 0, y: 0, w: 6, h: 4 } },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(1000, [makeEngine(ALPHA, { metric_groups: LATENCY_MEANS })]))

    const goodput = region('SLO Goodput')
    expect(
      within(goodput).getByText('vLLM localhost:8000 does not report latency percentiles.'),
    ).toBeInTheDocument()
    // Not the backend's goodput figures, which this snapshot still carries.
    expect(within(goodput).queryByText('97.0')).not.toBeInTheDocument()
  })

  it('keeps the slots of the cache half the engine does not report, and says so', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument([
        {
          id: 'prefix',
          type: 'engine-cache',
          title: 'Prefix only',
          binding: { kind: 'engine', endpoint: ALPHA },
          geometry: { x: 0, y: 0, w: 6, h: 4 },
        },
        {
          id: 'kv',
          type: 'engine-cache',
          title: 'KV only',
          binding: { kind: 'engine', endpoint: BETA },
          geometry: { x: 6, y: 0, w: 6, h: 4 },
        },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(
      makeSnapshot(1000, [
        makeEngine(ALPHA, { metric_groups: ['PrefixCache'] }),
        makeEngine(BETA, { metric_groups: ['KvCache'] }),
      ]),
    )

    // Each half reads as before; the other keeps its slots, says it is not
    // reported — not the value this snapshot happens to carry — and draws no line.
    const prefix = region('Prefix only')
    expect(within(tile(prefix, 'Prefix Hit')).getByText('55')).toBeInTheDocument()
    expect(within(tile(prefix, 'Prefix Queries')).getByText('2M')).toBeInTheDocument()
    expect(within(tile(prefix, 'KV Cache')).getByText('not reported')).toBeInTheDocument()
    expect(within(prefix).queryByText('42')).not.toBeInTheDocument()
    expect(within(prefix).queryByTestId('chart-series-KV Cache')).not.toBeInTheDocument()
    expect(within(prefix).getByTestId('chart-series-Prefix Hit')).toBeInTheDocument()

    const kv = region('KV only')
    expect(within(tile(kv, 'KV Cache')).getByText('42')).toBeInTheDocument()
    expect(within(tile(kv, 'Prefix Hit')).getByText('not reported')).toBeInTheDocument()
    expect(within(tile(kv, 'Prefix Queries')).getByText('not reported')).toBeInTheDocument()
    expect(within(kv).queryByText('55')).not.toBeInTheDocument()
    expect(within(kv).queryByTestId('chart-series-Prefix Hit')).not.toBeInTheDocument()
    expect(within(kv).getByTestId('chart-series-KV Cache')).toBeInTheDocument()
  })

  it('changes nothing for an engine that declares every group', async () => {
    // What vLLM puts on the wire. Rendered exactly as the older backend's
    // snapshot without the field is in the specs above.
    const fetchMock = serveConfiguration({ document: storedDocument(enginePanels()) })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(1000, [makeEngine(ALPHA, { metric_groups: [...METRIC_GROUPS] })]))

    expect(screen.queryByText(/does not report/)).not.toBeInTheDocument()
    expect(screen.queryByText('not reported')).not.toBeInTheDocument()
    expect(within(region('Decode Throughput')).getByText('120.0')).toBeInTheDocument()
    expect(within(region('Latency')).getByText('Queue')).toBeInTheDocument()
    expect(within(region('Latency')).getByText('6.5')).toBeInTheDocument()
    expect(within(region('Cache')).getByText('42')).toBeInTheDocument()
    expect(within(region('SLO Goodput')).getByText('99.0')).toBeInTheDocument()
    // Speculative decoding is reported, and this engine is not configured for
    // it — which the panel says exactly as it did before groups existed.
    expect(
      within(region('Speculative Decoding')).getByText(
        'This engine is not using speculative decoding.',
      ),
    ).toBeInTheDocument()
  })
})

// The grain of a metric group is the tile (#142): a panel some of whose groups
// are reported shows those, and every tile of a group that is not keeps its
// slot and says so — so a panel's tiles are the same whichever engine it shows.
describe('a tile whose metric group is not reported', () => {
  beforeEach(() => gridSubstitute.reset())

  async function showEngine(engine: EngineSnapshot, panels: unknown[] = enginePanels()) {
    const fetchMock = serveConfiguration({ document: storedDocument(panels) })
    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(1000, [engine]))
  }

  it('says which tiles an SGLang-shaped engine does not report, and shows the rest', async () => {
    await showEngine(declaring(ALPHA, SGLANG_GROUPS))

    const latency = region('Latency')
    expect(within(tile(latency, 'TTFT')).getByText('210')).toBeInTheDocument()
    expect(within(tile(latency, 'E2E')).getByText('4.20')).toBeInTheDocument()
    expect(within(tile(latency, 'ITL')).getByText('9')).toBeInTheDocument()
    expect(within(tile(latency, 'Queue')).getByText('12')).toBeInTheDocument()
    expect(within(tile(latency, 'TPOT')).getByText('not reported')).toBeInTheDocument()
    expect(within(tile(latency, 'Batch')).getByText('not reported')).toBeInTheDocument()
    // No TPOT line, while the reported latencies keep theirs.
    expect(within(latency).queryByTestId('chart-series-TPOT')).not.toBeInTheDocument()
    expect(within(latency).getByTestId('chart-series-TTFT')).toBeInTheDocument()

    // Per-request decode throughput is derived from TPOT; prefill's from TTFT.
    const decode = region('Decode Throughput')
    expect(within(tile(decode, 'Live')).getByText('120.0')).toBeInTheDocument()
    expect(within(tile(decode, 'Avg')).getByText('100.0')).toBeInTheDocument()
    expect(within(tile(decode, 'Per-Req Avg')).getByText('not reported')).toBeInTheDocument()
    expect(within(decode).queryByTestId('chart-series-Per-req')).not.toBeInTheDocument()
    expect(within(decode).getByTestId('chart-series-Live')).toBeInTheDocument()
    const prefill = region('Prefill Throughput')
    expect(within(tile(prefill, 'Per-Req Avg')).getByText('800.0')).toBeInTheDocument()
    expect(within(prefill).getByTestId('chart-series-Per-req')).toBeInTheDocument()

    const requests = region('Requests')
    expect(within(tile(requests, 'Active')).getByText('3')).toBeInTheDocument()
    expect(within(tile(requests, 'Queued')).getByText('1')).toBeInTheDocument()
    expect(within(tile(requests, 'Total')).getByText('900')).toBeInTheDocument()
    expect(within(tile(requests, 'Swapped')).getByText('not reported')).toBeInTheDocument()
    expect(within(tile(requests, 'Preempt')).getByText('not reported')).toBeInTheDocument()

    const goodput = region('SLO Goodput')
    expect(within(tile(goodput, 'TTFT ≤ 500ms')).getByText('99.0')).toBeInTheDocument()
    expect(within(tile(goodput, 'ITL ≤ 50ms')).getByText('98.0')).toBeInTheDocument()
    expect(within(tile(goodput, 'E2E ≤ 5s')).getByText('97.0')).toBeInTheDocument()
    expect(within(tile(goodput, 'Combined')).getByText('97.0')).toBeInTheDocument()
    expect(within(tile(goodput, 'TPOT ≤ 50ms')).getByText('not reported')).toBeInTheDocument()

    const cache = region('Cache')
    expect(within(cache).getByText('42')).toBeInTheDocument()
    expect(within(cache).getByText('55')).toBeInTheDocument()
    expect(within(cache).queryByText('not reported')).not.toBeInTheDocument()
  })

  // TensorFold declares every group but the queue-wait histogram and the
  // separate inter-token histogram. Nothing here is keyed by engine type: the
  // panel reads the declaration the backend sends (ADR-0004).
  it('renders a TensorFold engine from its declared groups, and names the two tiles it lacks', async () => {
    await showEngine({
      ...declaring(ALPHA, TENSORFOLD_GROUPS),
      engine_type: 'Tensorfold',
    })

    const latency = region('Latency')
    expect(within(tile(latency, 'TTFT')).getByText('210')).toBeInTheDocument()
    expect(within(tile(latency, 'E2E')).getByText('4.20')).toBeInTheDocument()
    expect(within(tile(latency, 'TPOT')).getByText('8')).toBeInTheDocument()
    expect(within(tile(latency, 'Batch')).getByText('6.5')).toBeInTheDocument()
    // No queue-wait histogram and no separate inter-token histogram.
    expect(within(tile(latency, 'Queue')).getByText('not reported')).toBeInTheDocument()
    expect(within(tile(latency, 'ITL')).getByText('not reported')).toBeInTheDocument()
    expect(within(latency).queryByTestId('chart-series-ITL')).not.toBeInTheDocument()
    expect(within(latency).queryByTestId('chart-series-Queue')).not.toBeInTheDocument()

    // The groups it does declare render generically, like any other engine's.
    expect(
      within(tile(region('Prefill Throughput'), 'Live')).getByText('3000.0'),
    ).toBeInTheDocument()
    expect(within(tile(region('Requests'), 'Total')).getByText('900')).toBeInTheDocument()
    expect(within(region('Cache')).getByText('42')).toBeInTheDocument()
    expect(
      within(region('Speculative Decoding')).getByText(
        'This engine is not using speculative decoding.',
      ),
    ).toBeInTheDocument()

    // Its inter-token goodput tile falls with the percentiles group it lacks.
    expect(
      within(tile(region('SLO Goodput'), 'ITL ≤ 50ms')).getByText('not reported'),
    ).toBeInTheDocument()
  })

  // Its latency mean is a mean in every mode: plain under the "avg" the header
  // names, as every engine's mean is there, and labelled as the mean under a
  // percentile.
  it.each([
    ['avg', 'ITL'],
    ['p95', 'ITL mean'],
  ])('shows a llama.cpp-shaped engine’s ITL mean in %s, and says the rest is not reported', async (mode, itlLabel) => {
    window.localStorage.setItem('spark-dashboard:latency-mode', mode)
    await showEngine(llamaCpp())

    const latency = region('Latency')
    expect(within(tile(latency, itlLabel)).getByText('9')).toBeInTheDocument()
    for (const name of ['TTFT', 'E2E', 'TPOT', 'Queue', 'Batch']) {
      expect(within(tile(latency, name)).getByText('not reported'), name).toBeInTheDocument()
    }
    expect(within(latency).getByTestId(`chart-series-${itlLabel}`)).toBeInTheDocument()
    expect(within(latency).queryByTestId('chart-series-TTFT')).not.toBeInTheDocument()

    const requests = region('Requests')
    expect(within(tile(requests, 'Active')).getByText('3')).toBeInTheDocument()
    expect(within(tile(requests, 'Queued')).getByText('1')).toBeInTheDocument()
    for (const name of ['Total', 'Swapped', 'Preempt']) {
      expect(within(tile(requests, name)).getByText('not reported'), name).toBeInTheDocument()
    }
    expect(within(requests).queryByTestId('chart-series-Total')).not.toBeInTheDocument()

    for (const [title, live] of [
      ['Prefill Throughput', '3000.0'],
      ['Decode Throughput', '120.0'],
    ]) {
      const throughput = region(title)
      expect(within(tile(throughput, 'Live')).getByText(live), title).toBeInTheDocument()
      expect(within(tile(throughput, 'Avg')).queryByText('not reported'), title).toBeNull()
      expect(within(tile(throughput, 'Per-Req Avg')).getByText('not reported'), title).toBeInTheDocument()
    }

    expect(
      within(region('SLO Goodput')).getByText(
        'llama.cpp localhost:8000 does not report latency percentiles.',
      ),
    ).toBeInTheDocument()
    expect(
      within(region('Cache')).getByText(
        'llama.cpp localhost:8000 does not report KV cache or prefix cache.',
      ),
    ).toBeInTheDocument()

    // Speculative decoding is the one group beyond throughput, requests and ITL
    // it reports: its own counters, shown as they are.
    const spec = region('Speculative Decoding')
    expect(within(spec).getByText('75')).toBeInTheDocument()
    expect(within(spec).getByText('300K')).toBeInTheDocument()
    expect(within(spec).queryByText(/does not report/)).not.toBeInTheDocument()

    // No stand-in for what it has no counter for: the vLLM fixture's TTFT,
    // end-to-end latency, total and percentiles appear nowhere on the page.
    for (const stand of ['210', '4.20', '900', '400']) {
      expect(screen.queryByText(stand), stand).not.toBeInTheDocument()
    }
    expect(within(latency).queryByTestId('chart-series-E2E')).not.toBeInTheDocument()
  })

  it('keeps the same tiles in the same slots whichever engine the panel shows', async () => {
    // What engine rotation does to a following panel: the next snapshot shows
    // another engine. Its tiles must not come and go and reflow the panel.
    // The Requests panel is left out on purpose: vLLM's Swapped and Preempt
    // tiles stay hidden while they read zero (the vLLM specs above pin that),
    // so its tile set differs by design between engines.
    const fetchMock = serveConfiguration({ document: storedDocument(enginePanels()) })
    render(<App />)
    await configurationSettles(fetchMock)

    const tiles = (title: string) =>
      within(region(title))
        .getAllByRole('group')
        .map((group) => group.getAttribute('aria-label'))
    const shown: Record<string, Array<string | null>>[] = []
    for (const [ts, engine] of [
      [1000, makeEngine(ALPHA)],
      [2000, declaring(ALPHA, SGLANG_GROUPS)],
      [3000, llamaCpp()],
    ] as const) {
      receive(makeSnapshot(ts, [engine]))
      shown.push(
        Object.fromEntries(
          ['Latency', 'Prefill Throughput', 'Decode Throughput'].map((title) => [title, tiles(title)]),
        ),
      )
    }

    expect(shown[0].Latency).toEqual(['TTFT', 'E2E', 'Queue', 'ITL', 'TPOT', 'Batch'])
    expect(shown[1]).toEqual(shown[0])
    expect(shown[2]).toEqual(shown[0])
  })

  it('never reads as a dash or a zero', async () => {
    // On the wire, every field of an undeclared group is null — which a tile
    // left to itself renders as the "not yet" dash.
    await showEngine(llamaCpp())

    const notReported = screen.getAllByText('not reported')
    // TTFT, E2E, Queue, TPOT, Batch; Total, Swapped, Preempt; two Per-Req.
    expect(notReported).toHaveLength(10)
    for (const text of notReported) {
      const group = text.closest('[role="group"]') as HTMLElement
      expect(group, group.getAttribute('aria-label') ?? '').not.toHaveTextContent('--')
      expect(within(group).queryByText('0')).not.toBeInTheDocument()
    }
  })

  it('goes by what the engine declares, not by a value it happens to carry', async () => {
    // A snapshot declaring no TPOT or preemption group, with a TPOT figure and
    // zero counters in it all the same.
    await showEngine(
      makeEngine(ALPHA, { metric_groups: ['Throughput', 'TtftMean', 'ActiveRequests'] }),
    )

    const tpot = tile(region('Latency'), 'TPOT')
    expect(within(tpot).getByText('not reported')).toBeInTheDocument()
    expect(within(tpot).queryByText('8')).not.toBeInTheDocument()
    const perRequest = tile(region('Decode Throughput'), 'Per-Req Avg')
    expect(within(perRequest).getByText('not reported')).toBeInTheDocument()
    expect(within(perRequest).queryByText('40.0')).not.toBeInTheDocument()
    // Not hidden as a reported zero would be: the engine has no such counter.
    expect(within(tile(region('Requests'), 'Preempt')).getByText('not reported')).toBeInTheDocument()
    expect(within(tile(region('Requests'), 'Swapped')).getByText('not reported')).toBeInTheDocument()
  })

  it('still dashes a figure of a reported group that has no value yet', async () => {
    // "Not yet" and "not reported" side by side: the ITL percentiles are
    // reported and have no sample, TPOT is not reported at all.
    window.localStorage.setItem('spark-dashboard:latency-mode', 'p95')
    await showEngine(declaring(ALPHA, SGLANG_GROUPS, { itl_percentiles: null }))

    const latency = region('Latency')
    const itl = tile(latency, 'ITL')
    expect(within(itl).getByText('--')).toBeInTheDocument()
    expect(within(itl).queryByText('not reported')).not.toBeInTheDocument()
    expect(within(tile(latency, 'TPOT')).getByText('not reported')).toBeInTheDocument()
  })

  it('applies the latency mode to each latency on its own', async () => {
    // Percentiles for TTFT, only a mean for ITL, nothing for E2E or TPOT.
    window.localStorage.setItem('spark-dashboard:latency-mode', 'p95')
    await showEngine(declaring(ALPHA, ['TtftPercentiles', 'TtftMean', 'ItlMean']))

    const latency = region('Latency')
    expect(within(tile(latency, 'TTFT')).getByText('400')).toBeInTheDocument()
    expect(within(tile(latency, 'ITL mean')).getByText('9')).toBeInTheDocument()
    expect(within(tile(latency, 'E2E')).getByText('not reported')).toBeInTheDocument()
    expect(within(tile(latency, 'TPOT')).getByText('not reported')).toBeInTheDocument()
    expect(within(latency).queryByText('TTFT mean')).not.toBeInTheDocument()
    // Each line is drawn in the statistic its tile shows, under the same label.
    expect(within(latency).getByTestId('chart-series-TTFT')).toHaveAttribute('data-values', '400')
    expect(within(latency).getByTestId('chart-series-ITL mean')).toHaveAttribute('data-values', '9')
    expect(within(latency).queryByTestId('chart-series-TPOT')).not.toBeInTheDocument()
  })

  it('decides SLO goodput for each latency on its own', async () => {
    await showEngine(declaring(ALPHA, ['TtftPercentiles']))

    const goodput = region('SLO Goodput')
    expect(within(tile(goodput, 'TTFT ≤ 500ms')).getByText('99.0')).toBeInTheDocument()
    // The combined figure is the worst of the latencies that are reported.
    expect(within(tile(goodput, 'Combined')).getByText('99.0')).toBeInTheDocument()
    for (const name of ['ITL ≤ 50ms', 'E2E ≤ 5s', 'TPOT ≤ 50ms']) {
      expect(within(tile(goodput, name)).getByText('not reported'), name).toBeInTheDocument()
    }
  })

  it('says the combined goodput is not reported when none of its latencies is', async () => {
    // Combined is the worst of TTFT, ITL and E2E; TPOT alone does not enter it,
    // so without those three it would be a dash that never fills.
    await showEngine(declaring(ALPHA, ['TpotPercentiles']))

    const goodput = region('SLO Goodput')
    expect(within(tile(goodput, 'TPOT ≤ 50ms')).getByText('96.0')).toBeInTheDocument()
    const combined = tile(goodput, 'Combined')
    expect(within(combined).getByText('not reported')).toBeInTheDocument()
    expect(combined).not.toHaveTextContent('--')
  })
})

// A page configured for all models combines each figure from the engines that
// report its group (#130): one that does not report it, or whose metrics are
// off, is left out rather than entering as a zero — and the panel says how many
// engines its figures cover whenever that is not all of them.
describe('all models on engines that report different groups', () => {
  /** A stored page of these panels, configured to show all models combined. */
  function allModelsDocument(panels: unknown[]): string {
    return JSON.stringify({
      version: DASHBOARD_SCHEMA_VERSION,
      pages: [{ id: 'engines', name: 'Engines', source: { kind: 'all' }, panels }],
    })
  }

  const decodePanel = {
    id: 'decode',
    type: 'engine-decode-throughput',
    geometry: { x: 0, y: 0, w: 6, h: 4 },
  }

  /** Every group but the one named — what an engine without it declares. */
  const allGroupsBut = (group: MetricGroup) => METRIC_GROUPS.filter((g) => g !== group)

  async function showAllModels(panels: unknown[], engines: EngineSnapshot[]) {
    const fetchMock = serveConfiguration({ document: allModelsDocument(panels) })
    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(1000, engines))
  }

  it('leaves out an engine that does not report throughput, and says how many it covers', async () => {
    await showAllModels(
      [decodePanel],
      [
        makeEngine(ALPHA),
        // Its throughput figure would be read as a sample; it is not reported.
        makeEngine(BETA, { metric_groups: ['ActiveRequests'] }, { tokens_per_sec: 640 }),
      ],
    )

    const decode = region('Decode Throughput')
    expect(within(decode).getByText('120.0')).toBeInTheDocument()
    expect(within(decode).queryByText('760.0')).not.toBeInTheDocument()
    // Still the aggregate's own name, and still every engine serving…
    expect(within(decode).getByText('All models')).toBeInTheDocument()
    expect(within(decode).getByText('2 of 2 serving')).toBeInTheDocument()
    // …with how many of them the figures actually cover beside it.
    expect(within(decode).getByText('1 of 2 engines')).toBeInTheDocument()
    expect(
      within(decode).getByTitle('All models — 2 of 2 serving — 1 of 2 engines'),
    ).toBeInTheDocument()
  })

  it('leaves out an engine whose metrics are off', async () => {
    await showAllModels(
      [decodePanel],
      [makeEngine(ALPHA), makeEngine(BETA, { metrics_off: '--enable-metrics', metrics: null })],
    )

    const decode = region('Decode Throughput')
    expect(within(decode).getByText('120.0')).toBeInTheDocument()
    expect(within(decode).getByText('2 of 2 serving')).toBeInTheDocument()
    expect(within(decode).getByText('1 of 2 engines')).toBeInTheDocument()
  })

  it('leaves out an engine whose metrics endpoint refuses the key', async () => {
    await showAllModels(
      [decodePanel],
      [makeEngine(ALPHA), makeEngine(BETA, { metrics_error: 'AuthRequired', metrics: null })],
    )

    const decode = region('Decode Throughput')
    expect(within(decode).getByText('120.0')).toBeInTheDocument()
    expect(within(decode).getByText('2 of 2 serving')).toBeInTheDocument()
    expect(within(decode).getByText('1 of 2 engines')).toBeInTheDocument()
  })

  it('reads exactly as before when every engine reports every group', async () => {
    await showAllModels(enginePanels(), [
      makeEngine(ALPHA, { metric_groups: [...METRIC_GROUPS] }),
      makeEngine(BETA, { metric_groups: [...METRIC_GROUPS] }, { tokens_per_sec: 640 }),
    ])

    const decode = region('Decode Throughput')
    expect(within(decode).getByText('760.0')).toBeInTheDocument()
    expect(within(decode).getByText('2 of 2 serving')).toBeInTheDocument()
    expect(within(decode).getByTitle('All models — 2 of 2 serving')).toBeInTheDocument()
    // No panel on the page counts its engines when it covers all of them.
    expect(screen.queryByText(/of \d+ engines/)).not.toBeInTheDocument()
    expect(screen.queryByText(/No running engine reports/)).not.toBeInTheDocument()
    expect(
      within(region('Speculative Decoding')).getByText('No model is using speculative decoding.'),
    ).toBeInTheDocument()
  })

  it('says a group no running engine reports is not reported, rather than showing a zero', async () => {
    /** What each engine metric panel says when no running engine reports its groups. */
    const NOT_REPORTED_BY_ANY: Partial<Record<PanelType, string>> = {
      'engine-prefill-throughput': 'No running engine reports throughput or TTFT mean.',
      'engine-decode-throughput': 'No running engine reports throughput or TPOT mean.',
      'engine-latency':
        'No running engine reports latency means, latency percentiles or queue time.',
      'engine-slo-goodput': 'No running engine reports latency percentiles.',
      'engine-requests': 'No running engine reports requests or preemptions.',
      'engine-cache': 'No running engine reports KV cache or prefix cache.',
      'engine-spec-decode': 'No running engine reports speculative decoding.',
    }
    const panels = enginePanels() as Array<{ type: PanelType }>
    // Every engine metric panel type, so one added later is held to this too.
    expect(panels.map((p) => p.type).sort()).toEqual(Object.keys(NOT_REPORTED_BY_ANY).sort())

    await showAllModels(panels, [
      makeEngine(ALPHA, { metric_groups: [] }),
      makeEngine(BETA, { metric_groups: [] }),
    ])

    for (const { type } of panels) {
      const panel = region(defaultPanelTitle(type))
      expect(within(panel).getByText(NOT_REPORTED_BY_ANY[type]!), type).toBeInTheDocument()
      expect(within(panel).queryByText('0'), type).not.toBeInTheDocument()
      expect(within(panel).queryByText('--'), type).not.toBeInTheDocument()
      expect(within(panel).queryByTestId('chart'), type).not.toBeInTheDocument()
    }
  })

  it('combines each half of the cache panel from the engines that report it', async () => {
    await showAllModels(
      [{ id: 'cache', type: 'engine-cache', geometry: { x: 0, y: 0, w: 6, h: 4 } }],
      [
        makeEngine(ALPHA, { metric_groups: ['KvCache'] }, { prefix_cache_hit_rate: 15 }),
        makeEngine(BETA, { metric_groups: ['PrefixCache'] }, { kv_cache_percent: 90 }),
      ],
    )

    const cache = region('Cache')
    // KV from Alpha alone (not the mean with Beta's 90, 66)…
    expect(within(cache).getByText('42')).toBeInTheDocument()
    expect(within(cache).queryByText('66')).not.toBeInTheDocument()
    // …and the prefix cache from Beta alone (not the mean with Alpha's 15, 35,
    // nor both engines' queries summed, 4M).
    expect(within(cache).getByText('55')).toBeInTheDocument()
    expect(within(cache).getByText('2M')).toBeInTheDocument()
    expect(within(cache).queryByText('35')).not.toBeInTheDocument()
    expect(within(cache).queryByText('4M')).not.toBeInTheDocument()
    // Each figure covers one engine of two, so the count is said once.
    expect(within(cache).getByText('1 of 2 engines')).toBeInTheDocument()
  })

  it('weights latency only by the engines that report requests', async () => {
    await showAllModels(
      [{ id: 'latency', type: 'engine-latency', geometry: { x: 0, y: 0, w: 6, h: 4 } }],
      [
        makeEngine(ALPHA),
        // Means without a request total carry no weight, so they cannot enter.
        makeEngine(BETA, { metric_groups: ['TtftMean'] }, { ttft_ms: 99_999 }),
      ],
    )

    const latency = region('Latency')
    expect(within(latency).getByText('210')).toBeInTheDocument()
    expect(within(latency).getByText('1 of 2 engines')).toBeInTheDocument()
  })

  it('combines TPOT from the engines that report it, and says how many that is', async () => {
    await showAllModels(
      [{ id: 'latency', type: 'engine-latency', geometry: { x: 0, y: 0, w: 6, h: 4 } }],
      [makeEngine(ALPHA), declaring(BETA, SGLANG_GROUPS)],
    )

    const latency = region('Latency')
    // vLLM's TPOT alone: the SGLang-shaped engine has none to enter.
    expect(within(tile(latency, 'TPOT')).getByText('8')).toBeInTheDocument()
    expect(within(tile(latency, 'TTFT')).getByText('210')).toBeInTheDocument()
    expect(within(latency).getByText(/TPOT mean 1 of 2/)).toBeInTheDocument()
    expect(within(latency).queryByText('not reported')).not.toBeInTheDocument()
  })

  it('says a tile no running engine reports is not reported', async () => {
    await showAllModels(enginePanels(), [
      declaring(ALPHA, SGLANG_GROUPS),
      declaring(BETA, SGLANG_GROUPS),
    ])

    const latency = region('Latency')
    expect(within(tile(latency, 'TPOT')).getByText('not reported')).toBeInTheDocument()
    expect(within(tile(latency, 'Batch')).getByText('not reported')).toBeInTheDocument()
    expect(within(tile(latency, 'TTFT')).getByText('210')).toBeInTheDocument()
    expect(within(latency).queryByTestId('chart-series-TPOT')).not.toBeInTheDocument()
    expect(
      within(tile(region('Decode Throughput'), 'Per-Req Avg')).getByText('not reported'),
    ).toBeInTheDocument()
    expect(within(tile(region('Requests'), 'Preempt')).getByText('not reported')).toBeInTheDocument()
    // Every figure shown covers both engines, so no count is said.
    expect(screen.queryByText(/of 2 engines/)).not.toBeInTheDocument()
  })

  it('says speculative decoding is not reported rather than not in use', async () => {
    await showAllModels(
      [{ id: 'spec', type: 'engine-spec-decode', geometry: { x: 0, y: 0, w: 6, h: 4 } }],
      [
        makeEngine(ALPHA, { metric_groups: allGroupsBut('SpeculativeDecoding') }),
        makeEngine(BETA, { metric_groups: allGroupsBut('SpeculativeDecoding') }),
      ],
    )

    const spec = region('Speculative Decoding')
    expect(
      within(spec).getByText('No running engine reports speculative decoding.'),
    ).toBeInTheDocument()
    expect(
      within(spec).queryByText('No model is using speculative decoding.'),
    ).not.toBeInTheDocument()
  })
})

// The engine type the palette offered and no build rendered (#110), through the
// same seam as the seven above.
describe('the inference-request timeline', () => {
  /** Four finished requests, including a cold start that a mean would hide
   *  behind — the outlier is the point of showing them individually. */
  const REQUESTS: InferenceRequestData[] = [
    { start_ms: 590_000, end_ms: 600_000, tokens_per_sec: 100, ttft_ms: 200 },
    { start_ms: 595_000, end_ms: 599_000, tokens_per_sec: 120, ttft_ms: 300 },
    { start_ms: 400_000, end_ms: 410_000, tokens_per_sec: 1, ttft_ms: 2400 },
    { start_ms: 560_000, end_ms: 570_000, tokens_per_sec: 140, ttft_ms: 400 },
  ]

  /** The timeline's own rows inside one panel, in the order they are drawn. */
  function requestRows(panelName: string): HTMLElement[] {
    const list = within(region(panelName)).getByRole('list', { name: 'Inference requests' })
    return within(list).getAllByRole('listitem')
  }

  function timelinePanel(extra: Record<string, unknown> = {}): unknown {
    return { id: 'timeline', type: 'inference-timeline', geometry: { x: 0, y: 0, w: 6, h: 4 }, ...extra }
  }

  it('draws every request in the window, and summarizes them by median', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument([timelinePanel()]) })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(600_000, [makeEngine(ALPHA, { recent_requests: REQUESTS })]))

    const timeline = region('Inference Requests')
    expect(within(timeline).getByText('Requests')).toBeInTheDocument()
    expect(within(timeline).getByText('4')).toBeInTheDocument()
    // Medians, not means: the cold start at 1 tok/s would drag a mean to 90.
    expect(within(timeline).getByText('110.0')).toBeInTheDocument()
    expect(within(timeline).getByText('350')).toBeInTheDocument()

    // One row per request, newest first — the only place in the dashboard the
    // requests themselves are visible rather than an aggregate over them.
    const rows = requestRows('Inference Requests')
    expect(rows).toHaveLength(4)
    expect(rows.map((row) => row.textContent)).toEqual(['100.0', '120.0', '140.0', '1.0'])

    expect(screen.queryByText('This panel is not available yet.')).not.toBeInTheDocument()
  })

  it('shows a pinned engine only its own requests', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument([
        timelinePanel({ id: 'alpha', title: 'Alpha timeline' }),
        {
          id: 'beta',
          type: 'inference-timeline',
          title: 'Beta timeline',
          binding: { kind: 'engine', endpoint: BETA },
          geometry: { x: 6, y: 0, w: 6, h: 4 },
        },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(
      makeSnapshot(600_000, [
        makeEngine(ALPHA, { recent_requests: REQUESTS }),
        makeEngine(BETA, {
          recent_requests: [
            { start_ms: 599_000, end_ms: 600_000, tokens_per_sec: 7, ttft_ms: 50 },
          ],
        }),
      ]),
    )

    // Never the other engine's requests under this engine's name.
    expect(within(region('Alpha timeline')).getByText('4')).toBeInTheDocument()
    expect(within(region('Beta timeline')).getByText('1')).toBeInTheDocument()
    expect(requestRows('Beta timeline').map((row) => row.textContent)).toEqual(['7.0'])
    expect(within(region('Alpha timeline')).queryByText('7.0')).not.toBeInTheDocument()
  })

  it('says the window was quiet rather than drawing an empty axis', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument([timelinePanel()]) })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(600_000, [makeEngine(ALPHA)]))

    const timeline = region('Inference Requests')
    expect(within(timeline).getByText('No requests finished in the last 5m.')).toBeInTheDocument()
    // The tiles still stand, saying nothing happened rather than nothing loaded.
    expect(within(timeline).getByText('0')).toBeInTheDocument()
    expect(within(timeline).getAllByText('N/A')).toHaveLength(2)
  })

  it('keeps the slot of a panel pinned to an engine that is gone, naming it', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument([
        timelinePanel({ binding: { kind: 'engine', endpoint: 'http://localhost:9999' } }),
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(600_000, [makeEngine(ALPHA, { recent_requests: REQUESTS })]))

    // Named, never silently substituted — another engine's requests under this
    // panel's title would be worse than no requests at all.
    expect(
      within(region('Inference Requests')).getByText(
        'No engine at http://localhost:9999 — repoint this panel.',
      ),
    ).toBeInTheDocument()
  })
})

describe('an engine running with its metrics endpoint off', () => {
  it('names the launch flag instead of calling the engine silent, and still shows what the engine is', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument([
        { id: 'latency', type: 'engine-latency', geometry: { x: 0, y: 0, w: 6, h: 4 } },
        { id: 'who', type: 'engine-status', geometry: { x: 6, y: 0, w: 6, h: 4 } },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(
      makeSnapshot(1000, [
        makeEngine(ALPHA, {
          engine_type: 'Sglang',
          metrics: null,
          metrics_off: '--enable-metrics',
        }),
      ]),
    )

    // The distinct wire state: not "does not report" (the engine could — it
    // was launched without the flag), not "not yet" (no traffic fixes it).
    expect(
      within(region('Latency')).getByText(
        'SGLang localhost:8000 is running with metrics off — relaunch it with --enable-metrics.',
      ),
    ).toBeInTheDocument()

    // Identity and liveness are not metrics: the status panel says exactly
    // what is running, and on which port, while the metric panels wait.
    expect(within(region('Engine')).getByText('SGLang')).toBeInTheDocument()
    expect(within(region('Engine')).getByText('Qwen3-8B')).toBeInTheDocument()
  })

  it('leaves an engine without the wire field untouched — absent means metrics are on', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument([
        { id: 'latency', type: 'engine-latency', geometry: { x: 0, y: 0, w: 6, h: 4 } },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    const engine = makeEngine(ALPHA, { engine_type: 'Sglang' })
    expect(engine.metrics_off).toBeUndefined()
    receive(makeSnapshot(1000, [engine]))

    expect(within(region('Latency')).queryByText(/metrics off/)).not.toBeInTheDocument()
  })
})

// The engine publishes metrics, and its endpoint refused the dashboard for want
// of the engine's API key (llama-server started with --api-key, #131). Reported
// the way a refused /v1/models is — a key to configure — never as metrics off,
// which would send the operator relaunching an engine that needs no new flag.
describe('an engine whose metrics endpoint refuses the dashboard’s API key', () => {
  const METRICS_REFUSED =
    'SGLang localhost:8000 requires authentication — configure the provider API key to read its metrics.'

  function refused(overrides: Partial<EngineSnapshot> = {}): EngineSnapshot {
    return makeEngine(ALPHA, {
      engine_type: 'Sglang',
      metrics: null,
      metrics_error: 'AuthRequired',
      ...overrides,
    })
  }

  it('says every metric panel needs the key, not that metrics are off', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(metricPanels) })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(1000, [refused()]))

    expect(metricPanels.length).toBeGreaterThan(0)
    for (const { type } of metricPanels) {
      const panel = region(defaultPanelTitle(type))
      expect(within(panel).getByText(METRICS_REFUSED), type).toBeInTheDocument()
      // Not a launch flag, not a moment that passes, not a property of the engine.
      expect(within(panel).queryByText(/metrics off/), type).not.toBeInTheDocument()
      expect(within(panel).queryByText(/has no metrics yet/), type).not.toBeInTheDocument()
      expect(within(panel).queryByText(/does not report/), type).not.toBeInTheDocument()
      expect(within(panel).queryByText('--'), type).not.toBeInTheDocument()
      expect(within(panel).queryByTestId('chart'), type).not.toBeInTheDocument()
    }
  })

  it('says it beside the model-name warning when /v1/models refuses the key too', async () => {
    // A llama-server with an API key refuses everything but /health, so both
    // warnings arrive together: the Engine panel says what it says about the
    // model name, and the metric panels say the same about their metrics.
    const fetchMock = serveConfiguration({
      document: storedDocument([
        { id: 'latency', type: 'engine-latency', geometry: { x: 0, y: 0, w: 6, h: 4 } },
        { id: 'who', type: 'engine-status', geometry: { x: 6, y: 0, w: 6, h: 4 } },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(1000, [refused({ model_metadata_error: 'AuthRequired' })]))

    expect(within(region('Latency')).getByText(METRICS_REFUSED)).toBeInTheDocument()
    const status = region('Engine')
    expect(
      within(status).getByText(
        'Engine requires authentication — configure the provider API key to read the model name.',
      ),
    ).toBeInTheDocument()
    // Identity and liveness are not metrics: the Engine panel still says what
    // is running, and does not repeat the metric panels' notice.
    expect(within(status).getByText('SGLang')).toBeInTheDocument()
    expect(within(status).getByText('Serving')).toBeInTheDocument()
    expect(within(status).queryByText(METRICS_REFUSED)).not.toBeInTheDocument()
  })

  it('shows the metrics once the key is configured', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument([
        { id: 'decode', type: 'engine-decode-throughput', geometry: { x: 0, y: 0, w: 6, h: 4 } },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(1000, [refused()]))
    expect(within(region('Decode Throughput')).getByText(METRICS_REFUSED)).toBeInTheDocument()

    receive(makeSnapshot(3000, [makeEngine(ALPHA, { engine_type: 'Sglang', metrics_error: null })]))
    const decode = region('Decode Throughput')
    expect(within(decode).queryByText(METRICS_REFUSED)).not.toBeInTheDocument()
    expect(within(decode).getByText('120.0')).toBeInTheDocument()
  })

  it('leaves an engine without the wire field untouched — absent means nothing refused', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument([
        { id: 'latency', type: 'engine-latency', geometry: { x: 0, y: 0, w: 6, h: 4 } },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    const engine = makeEngine(ALPHA, { engine_type: 'Sglang' })
    expect(engine.metrics_error).toBeUndefined()
    receive(makeSnapshot(1000, [engine]))

    expect(
      within(region('Latency')).queryByText(/requires authentication/),
    ).not.toBeInTheDocument()
  })
})

describe('speculative decoding on an engine that reports gauges instead of counters', () => {
  it('shows the acceptance figures an SGLang drafter reports — no counters exist there', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument([
        { id: 'spec', type: 'engine-spec-decode', geometry: { x: 0, y: 0, w: 6, h: 4 } },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(
      makeSnapshot(1000, [
        makeEngine(ALPHA, {
          engine_type: 'Sglang',
          metrics: engineMetrics({
            spec_decode_draft_tokens_total: null,
            spec_decode_accepted_tokens_total: null,
            spec_decode_drafts_total: null,
            spec_decode_acceptance_rate: 60,
            spec_decode_mean_acceptance_length: 2.8,
          }),
        }),
      ]),
    )

    const panel = region('Speculative Decoding')
    expect(within(panel).queryByText('SGLang localhost:8000 is not using speculative decoding.')).not.toBeInTheDocument()
    expect(within(panel).getByText('60')).toBeInTheDocument()
    expect(within(panel).getByText('2.80')).toBeInTheDocument()
  })

  it('keeps a zero vLLM counter reading as "not yet", never as "not configured"', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument([
        { id: 'spec', type: 'engine-spec-decode', geometry: { x: 0, y: 0, w: 6, h: 4 } },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(
      makeSnapshot(1000, [
        makeEngine(
          ALPHA,
          {},
          {
            spec_decode_draft_tokens_total: 0,
            spec_decode_accepted_tokens_total: 0,
            spec_decode_drafts_total: 0,
            spec_decode_acceptance_rate: null,
            spec_decode_acceptance_rate_live: null,
            spec_decode_mean_acceptance_length: null,
          },
        ),
      ]),
    )

    expect(
      within(region('Speculative Decoding')).getByText('This engine has drafted no tokens yet.'),
    ).toBeInTheDocument()
  })

  // An SGLang drafter logs its acceptance gauges as 0 until it verifies a
  // draft, exactly like a server with none; the backend tells them apart and
  // reports the configured one as zero draft rounds.
  it('says an idle SGLang drafter has drafted nothing yet, not that it runs none', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument([
        { id: 'spec', type: 'engine-spec-decode', geometry: { x: 0, y: 0, w: 6, h: 4 } },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(
      makeSnapshot(1000, [
        makeEngine(ALPHA, {
          engine_type: 'Sglang',
          metrics: engineMetrics({ spec_decode_drafts_total: 0 }),
        }),
      ]),
    )

    const panel = region('Speculative Decoding')
    expect(within(panel).getByText('This engine has drafted no tokens yet.')).toBeInTheDocument()
    expect(
      within(panel).queryByText('This engine is not using speculative decoding.'),
    ).not.toBeInTheDocument()
  })

  it('says an SGLang engine without a drafter is not using speculative decoding', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument([
        { id: 'spec', type: 'engine-spec-decode', geometry: { x: 0, y: 0, w: 6, h: 4 } },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(
      makeSnapshot(1000, [
        makeEngine(ALPHA, { engine_type: 'Sglang', metrics: engineMetrics() }),
      ]),
    )

    expect(
      within(region('Speculative Decoding')).getByText(
        'This engine is not using speculative decoding.',
      ),
    ).toBeInTheDocument()
  })

  // Rounds drafted but no acceptance figure logged yet (SGLang logs its
  // gauges every few dozen decode steps): the drafter has drafted, so the
  // panel shows its section, with dashes where a figure has yet to arrive.
  it('shows the section once an SGLang drafter has drafted, before its gauges log', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument([
        { id: 'spec', type: 'engine-spec-decode', geometry: { x: 0, y: 0, w: 6, h: 4 } },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(
      makeSnapshot(1000, [
        makeEngine(ALPHA, {
          engine_type: 'Sglang',
          metrics: engineMetrics({ spec_decode_drafts_total: 12 }),
        }),
      ]),
    )

    const panel = region('Speculative Decoding')
    expect(within(panel).queryByText(/drafted no tokens yet/)).not.toBeInTheDocument()
    expect(within(panel).getByText('Accept Len')).toBeInTheDocument()
  })
})

// One Ollama server is one engine holding a list of models in place of one
// (#132): it is named by that list wherever the UI names an engine by its model.
describe('an Ollama engine', () => {
  it('shows an Ollama engine under its own name and icon', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument([
        { id: 'who', type: 'engine-status', geometry: { x: 0, y: 0, w: 6, h: 4 } },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(1000, [ollamaEngine([TINYLLAMA])]))

    const chip = within(region('Engine')).getByText('Ollama').parentElement
    expect(chip?.querySelector('img')?.getAttribute('src')).toBe('/icons/ollama.svg')
  })

  it('names it on a panel’s identity row by the models it holds, marking no one provider', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument([
        {
          id: 'ollama',
          type: 'inference-timeline',
          title: 'Ollama requests',
          binding: { kind: 'engine', endpoint: OLLAMA_ENDPOINT },
          geometry: { x: 0, y: 0, w: 6, h: 4 },
        },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(1000, [makeEngine(ALPHA), ollamaEngine([HF_QWEN, TINYLLAMA])]))

    const panel = region('Ollama requests')
    expect(within(panel).getByText('Qwen3-8B-GGUF:Q4_K_M +1 more')).toBeInTheDocument()
    expect(within(panel).getByText('Ollama localhost:11434')).toBeInTheDocument()
    // Two providers' models on one engine: one mark would claim one for both.
    expect(within(panel).queryByRole('img')).not.toBeInTheDocument()
  })

  it('marks the identity row only for a single model whose name spells out its provider', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument([
        {
          id: 'ollama',
          type: 'inference-timeline',
          title: 'Ollama requests',
          binding: { kind: 'engine', endpoint: OLLAMA_ENDPOINT },
          geometry: { x: 0, y: 0, w: 6, h: 4 },
        },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(1000, [makeEngine(ALPHA), ollamaEngine([HF_QWEN])]))
    expect(within(region('Ollama requests')).getByRole('img', { name: 'Qwen' })).toHaveAttribute(
      'src',
      '/icons/providers/qwen.svg',
    )

    // tinyllama carries "llama" in its name and is still not Meta's.
    receive(makeSnapshot(3000, [makeEngine(ALPHA), ollamaEngine([TINYLLAMA])]))
    const panel = region('Ollama requests')
    expect(within(panel).getByText('tinyllama:latest')).toBeInTheDocument()
    expect(within(panel).queryByRole('img')).not.toBeInTheDocument()
  })

  it('counts it once on the All Engines overview, by what it holds', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument([
        { id: 'all', type: 'engines-overview', geometry: { x: 0, y: 0, w: 6, h: 4 } },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(1000, [makeEngine(ALPHA), ollamaEngine([])]))

    const all = region('All Engines')
    // Idle is running: the engine is up with nothing loaded.
    expect(within(all).getByText('2/2 running')).toBeInTheDocument()
    expect(within(all).getByText('Qwen (1)')).toBeInTheDocument()
    expect(within(all).getByText('No model loaded (1)')).toBeInTheDocument()

    receive(makeSnapshot(3000, [makeEngine(ALPHA), ollamaEngine([HF_QWEN, TINYLLAMA])]))
    expect(within(region('All Engines')).getByText('Multi-model (1)')).toBeInTheDocument()
  })
})

// The Engine panel lists what an Ollama engine holds now, one row per model, and
// re-renders it from every snapshot (#132).
describe('the Engine panel on an Ollama engine', () => {
  function statusPanel(extra: Record<string, unknown> = {}): unknown {
    return { id: 'who', type: 'engine-status', geometry: { x: 0, y: 0, w: 6, h: 4 }, ...extra }
  }

  /** The panel's rows of loaded models, in the order they are drawn. */
  function loadedRows(panel: HTMLElement): HTMLElement[] {
    const list = within(panel).getByRole('list', { name: 'Loaded models' })
    return within(list).getAllByRole('listitem')
  }

  it('lists each loaded model with what Ollama says about it', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument([statusPanel()]) })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(1000, [ollamaEngine([HF_QWEN, TINYLLAMA])]))

    const status = region('Engine')
    expect(within(status).getByText('Qwen3-8B-GGUF:Q4_K_M +1 more')).toBeInTheDocument()
    expect(within(status).getByText('Serving')).toBeInTheDocument()

    const [qwen, tinyllama] = loadedRows(status)
    // In the backend's name order, each with its size, quantization and memory —
    // the VRAM share only where the model is not wholly in VRAM.
    for (const fact of ['Qwen3-8B-GGUF:Q4_K_M', '8.2B', 'Q4_K_M', '6.0 GB (4.0 GB VRAM)']) {
      expect(within(qwen).getByText(fact), fact).toBeInTheDocument()
    }
    for (const fact of ['tinyllama:latest', '1B', 'Q4_0', '763.4 MB']) {
      expect(within(tinyllama).getByText(fact), fact).toBeInTheDocument()
    }

    // A row is marked when its name spells out a provider; tinyllama's does not.
    expect(within(qwen).getByRole('img', { name: 'Qwen' })).toHaveAttribute(
      'src',
      '/icons/providers/qwen.svg',
    )
    expect(within(tinyllama).queryByRole('img')).not.toBeInTheDocument()
    // The engine as a whole holds two providers' models, so it wears no mark:
    // the Qwen row's is the only one in the panel.
    expect(within(status).getAllByRole('img')).toHaveLength(1)
  })

  it('reads the captured tinyllama as Ollama reported it, with no provider guessed', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument([statusPanel()]) })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(1000, [ollamaEngine([TINYLLAMA])]))

    const status = region('Engine')
    const rows = loadedRows(status)
    expect(rows).toHaveLength(1)
    for (const fact of ['tinyllama:latest', '1B', 'Q4_0', '763.4 MB']) {
      expect(within(rows[0]).getByText(fact), fact).toBeInTheDocument()
    }
    // "llama" is in the name and Meta is not the provider: no mark anywhere.
    expect(within(status).queryByRole('img')).not.toBeInTheDocument()
  })

  it('shows each loaded model\'s context window, and when it unloads on hover', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument([statusPanel()]) })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(1000, [ollamaEngine([HF_QWEN, TINYLLAMA])]))

    const [qwen, tinyllama] = loadedRows(region('Engine'))
    // The captured tinyllama: a 2048-token window, unloading at a set time.
    expect(within(tinyllama).getByText('2K ctx')).toBeInTheDocument()
    expect(tinyllama.getAttribute('title')).toMatch(/^Unloads at \S/)
    // A model with no expiry says nothing on hover.
    expect(within(qwen).getByText('4K ctx')).toBeInTheDocument()
    expect(qwen).not.toHaveAttribute('title')
  })

  it('omits the context window of a model that does not report one', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument([statusPanel()]) })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(
      makeSnapshot(1000, [ollamaEngine([{ ...TINYLLAMA, context_length: null, expires_at: null }])]),
    )

    const [row] = loadedRows(region('Engine'))
    expect(within(row).queryByText(/ctx$/)).not.toBeInTheDocument()
    expect(row).not.toHaveAttribute('title')
  })

  it('says an idle engine has no model loaded, and shows it running', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument([statusPanel()]) })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(1000, [ollamaEngine([])]))

    const status = region('Engine')
    expect(within(status).getByText('No model loaded')).toBeInTheDocument()
    expect(within(status).getByText('Serving')).toBeInTheDocument()
    expect(within(status).queryByRole('list', { name: 'Loaded models' })).not.toBeInTheDocument()
    // Still the engine, with everything else it says about itself.
    expect(within(status).getByText('Ollama')).toBeInTheDocument()
    expect(within(status).getByText('Direct')).toBeInTheDocument()
  })

  it('follows models as they load and unload, pinned or named by the page source', async () => {
    // One Ollama server is one engine, identified by its endpoint: a panel
    // pinned to it and a page source naming it keep pointing at it while its
    // models change — beside a vLLM engine the page would otherwise default to.
    const fetchMock = serveConfiguration({
      document: JSON.stringify({
        version: DASHBOARD_SCHEMA_VERSION,
        pages: [
          {
            id: 'engines',
            name: 'Engines',
            source: { kind: 'engine', endpoint: OLLAMA_ENDPOINT },
            panels: [
              statusPanel({
                id: 'pinned',
                title: 'Pinned',
                binding: { kind: 'engine', endpoint: OLLAMA_ENDPOINT },
              }),
              statusPanel({
                id: 'following',
                title: 'Following',
                geometry: { x: 6, y: 0, w: 6, h: 4 },
              }),
            ],
          },
        ],
      }),
    })

    render(<App />)
    await configurationSettles(fetchMock)

    /** The names a panel's rows show, in order; none while nothing is loaded. */
    const names = (title: string) => {
      const list = within(region(title)).queryByRole('list', { name: 'Loaded models' })
      if (!list) return []
      return within(list)
        .getAllByRole('listitem')
        .map((row) => within(row).getByTitle(/.+/).textContent)
    }

    receive(makeSnapshot(1000, [makeEngine(ALPHA), ollamaEngine([])]))
    for (const title of ['Pinned', 'Following']) {
      expect(within(region(title)).getByText('No model loaded'), title).toBeInTheDocument()
      expect(names(title), title).toEqual([])
    }

    receive(makeSnapshot(3000, [makeEngine(ALPHA), ollamaEngine([TINYLLAMA])]))
    for (const title of ['Pinned', 'Following']) {
      expect(names(title), title).toEqual(['tinyllama:latest'])
    }

    receive(makeSnapshot(5000, [makeEngine(ALPHA), ollamaEngine([HF_QWEN, TINYLLAMA])]))
    for (const title of ['Pinned', 'Following']) {
      expect(
        within(region(title)).getByText('Qwen3-8B-GGUF:Q4_K_M +1 more'),
        title,
      ).toBeInTheDocument()
      expect(names(title), title).toEqual(['Qwen3-8B-GGUF:Q4_K_M', 'tinyllama:latest'])
    }

    receive(makeSnapshot(7000, [makeEngine(ALPHA), ollamaEngine([])]))
    for (const title of ['Pinned', 'Following']) {
      expect(within(region(title)).getByText('No model loaded'), title).toBeInTheDocument()
      expect(names(title), title).toEqual([])
      // Never repointed, and never the vLLM engine's identity in its place.
      expect(within(region(title)).queryByText(/No engine at/), title).not.toBeInTheDocument()
      expect(within(region(title)).queryByText('Qwen3-8B'), title).not.toBeInTheDocument()
    }
  })
})

// Ollama exposes no server-side metrics: it declares no metric group, so every
// metric panel bound to it says so — not "no metrics yet", not "no model", and
// not metrics off, since no launch flag would turn any on (#132).
describe('metric panels bound to an Ollama engine', () => {
  const NOT_REPORTED: Partial<Record<PanelType, string>> = {
    'engine-prefill-throughput': 'Ollama localhost:11434 does not report throughput or TTFT mean.',
    'engine-decode-throughput': 'Ollama localhost:11434 does not report throughput or TPOT mean.',
    'engine-latency':
      'Ollama localhost:11434 does not report latency means, latency percentiles or queue time.',
    'engine-slo-goodput': 'Ollama localhost:11434 does not report latency percentiles.',
    'engine-requests': 'Ollama localhost:11434 does not report requests or preemptions.',
    'engine-cache': 'Ollama localhost:11434 does not report KV cache or prefix cache.',
    'engine-spec-decode': 'Ollama localhost:11434 does not report speculative decoding.',
  }

  const NOTHING_LOADED: LoadedModel[] = []

  it.each([
    ['nothing loaded', NOTHING_LOADED],
    ['a model loaded', [TINYLLAMA]],
  ])('says every metric panel is not reported, with %s', async (_, loaded) => {
    expect(metricPanels.map((p) => p.type).sort()).toEqual(Object.keys(NOT_REPORTED).sort())

    const fetchMock = serveConfiguration({ document: storedDocument(metricPanels) })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(1000, [ollamaEngine(loaded)]))

    for (const { type } of metricPanels) {
      const panel = region(defaultPanelTitle(type))
      expect(within(panel).getByText(NOT_REPORTED[type]!), type).toBeInTheDocument()
      // Not a moment in the engine's life that passes, and not a flag to set.
      expect(within(panel).queryByText(/has no metrics yet/), type).not.toBeInTheDocument()
      expect(within(panel).queryByText(/has no model loaded/), type).not.toBeInTheDocument()
      expect(within(panel).queryByText(/metrics off/), type).not.toBeInTheDocument()
      expect(within(panel).queryByText('--'), type).not.toBeInTheDocument()
      expect(within(panel).queryByTestId('chart'), type).not.toBeInTheDocument()
    }
  })

  it('keeps saying so as its models change', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument([
        {
          id: 'decode',
          type: 'engine-decode-throughput',
          binding: { kind: 'engine', endpoint: OLLAMA_ENDPOINT },
          geometry: { x: 0, y: 0, w: 6, h: 4 },
        },
        {
          id: 'latency',
          type: 'engine-latency',
          binding: { kind: 'engine', endpoint: OLLAMA_ENDPOINT },
          geometry: { x: 6, y: 0, w: 6, h: 4 },
        },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)

    const states: Array<[number, LoadedModel[]]> = [
      [1000, [TINYLLAMA]],
      [3000, [HF_QWEN, TINYLLAMA]],
      [5000, []],
    ]
    for (const [ts, loaded] of states) {
      receive(makeSnapshot(ts, [makeEngine(ALPHA), ollamaEngine(loaded)]))
      expect(
        within(region('Decode Throughput')).getByText(NOT_REPORTED['engine-decode-throughput']!),
      ).toBeInTheDocument()
      expect(
        within(region('Latency')).getByText(NOT_REPORTED['engine-latency']!),
      ).toBeInTheDocument()
    }
  })

  it('says no running engine reports them on a page of all models over Ollama alone', async () => {
    const fetchMock = serveConfiguration({
      document: JSON.stringify({
        version: DASHBOARD_SCHEMA_VERSION,
        pages: [
          {
            id: 'engines',
            name: 'Engines',
            source: { kind: 'all' },
            panels: [
              {
                id: 'decode',
                type: 'engine-decode-throughput',
                geometry: { x: 0, y: 0, w: 6, h: 4 },
              },
              { id: 'latency', type: 'engine-latency', geometry: { x: 6, y: 0, w: 6, h: 4 } },
            ],
          },
        ],
      }),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(1000, [ollamaEngine([TINYLLAMA])]))

    expect(
      within(region('Decode Throughput')).getByText(
        'No running engine reports throughput or TPOT mean.',
      ),
    ).toBeInTheDocument()
    expect(
      within(region('Latency')).getByText(
        'No running engine reports latency means, latency percentiles or queue time.',
      ),
    ).toBeInTheDocument()
  })
})

// A llama-server answers /metrics only when launched with `--metrics` (#131).
// Without it the engine is running and every metric panel names the flag, with
// the engine named the way the other panels name it.
describe('a llama.cpp engine launched without --metrics', () => {
  it('says every metric panel is running with metrics off, and names --metrics', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(metricPanels) })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(
      makeSnapshot(1000, [
        makeEngine(ALPHA, {
          engine_type: 'LlamaCpp',
          metric_groups: [...LLAMA_CPP_GROUPS],
          metrics: null,
          metrics_off: '--metrics',
        }),
      ]),
    )

    expect(metricPanels.length).toBeGreaterThan(0)
    for (const { type } of metricPanels) {
      const panel = region(defaultPanelTitle(type))
      expect(
        within(panel).getByText(
          'llama.cpp localhost:8000 is running with metrics off — relaunch it with --metrics.',
        ),
        type,
      ).toBeInTheDocument()
      expect(within(panel).queryByText(/does not report/), type).not.toBeInTheDocument()
    }
  })
})

// A llama-server started with no model is a router that spawns one server per
// model. It is a running engine that reports no metric group, and no flag
// would change that — so "not reported", never metrics off (#131).
describe('a llama.cpp router', () => {
  const NOT_REPORTED: Partial<Record<PanelType, string>> = {
    'engine-prefill-throughput': 'llama.cpp localhost:8000 does not report throughput or TTFT mean.',
    'engine-decode-throughput': 'llama.cpp localhost:8000 does not report throughput or TPOT mean.',
    'engine-latency':
      'llama.cpp localhost:8000 does not report latency means, latency percentiles or queue time.',
    'engine-slo-goodput': 'llama.cpp localhost:8000 does not report latency percentiles.',
    'engine-requests': 'llama.cpp localhost:8000 does not report requests or preemptions.',
    'engine-cache': 'llama.cpp localhost:8000 does not report KV cache or prefix cache.',
    'engine-spec-decode': 'llama.cpp localhost:8000 does not report speculative decoding.',
  }

  it('says every metric panel is not reported, not that metrics are off', async () => {
    expect(metricPanels.map((p) => p.type).sort()).toEqual(Object.keys(NOT_REPORTED).sort())

    const fetchMock = serveConfiguration({ document: storedDocument(metricPanels) })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(
      makeSnapshot(1000, [
        makeEngine(ALPHA, {
          engine_type: 'LlamaCpp',
          model: null,
          metric_groups: [],
          metrics: null,
        }),
      ]),
    )

    for (const { type } of metricPanels) {
      const panel = region(defaultPanelTitle(type))
      expect(within(panel).getByText(NOT_REPORTED[type]!), type).toBeInTheDocument()
      expect(within(panel).queryByText(/metrics off/), type).not.toBeInTheDocument()
      expect(within(panel).queryByText(/has no model/), type).not.toBeInTheDocument()
      expect(within(panel).queryByText('--'), type).not.toBeInTheDocument()
      expect(within(panel).queryByTestId('chart'), type).not.toBeInTheDocument()
    }
  })
})
