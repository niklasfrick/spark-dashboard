import { beforeEach, describe, expect, it } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../App'
import {
  configurationResponse,
  configurationWrites,
  serveConfiguration,
  type FetchMock,
} from '../test/configurationServer'
import { gridSubstitute } from '../test/gridSubstitute'
import { MockWebSocket, substituteWebSocket } from '../test/websocket'
import { DASHBOARD_SCHEMA_VERSION } from '../lib/dashboard/schema'
import type { EngineMetrics, EngineSnapshot, MetricsSnapshot } from '../types/metrics'

// The page configuration control: what a page's following panels show — one
// model, all of them combined, or the host default — chosen beside "Edit
// layout" and written to the shared document the moment it is chosen, the way
// a page rename is. Driven through the application seam: real configuration
// loading and saving over the fetch stub, real panels reading the real store.
substituteWebSocket()

const GIB = 1_073_741_824

const ALPHA = 'http://localhost:8000'
const BETA = 'http://localhost:8001'

function storedDocument(page: Record<string, unknown>): string {
  return JSON.stringify({ version: DASHBOARD_SCHEMA_VERSION, pages: [page] })
}

/** A page of one following decode panel and one pinned to Alpha. */
function watchPage(source?: unknown): Record<string, unknown> {
  return {
    id: 'watch',
    name: 'Watch',
    ...(source === undefined ? {} : { source }),
    panels: [
      { id: 'decode', type: 'engine-decode-throughput', geometry: { x: 0, y: 0, w: 6, h: 4 } },
      {
        id: 'pinned',
        type: 'engine-decode-throughput',
        title: 'Pinned to Alpha',
        geometry: { x: 6, y: 0, w: 6, h: 4 },
        binding: { kind: 'engine', endpoint: ALPHA },
      },
    ],
  }
}

function engine(endpoint: string, model: string, tokensPerSec: number): EngineSnapshot {
  return {
    engine_type: 'Vllm',
    endpoint,
    status: { type: 'Running' },
    model: {
      name: model,
      parameter_size: null,
      quantization: null,
      precision: null,
      tensor_type: null,
      model_type: null,
      pipeline_tag: null,
    },
    metrics: { tokens_per_sec: tokensPerSec } as EngineMetrics,
    recent_requests: [],
    deployment_mode: 'Native',
  }
}

function snapshot(timestampMs = 1_000): MetricsSnapshot {
  return {
    timestamp_ms: timestampMs,
    gpu: {
      index: 0,
      name: 'NVIDIA GB10',
      utilization_percent: 40,
      memory_total_bytes: 96 * GIB,
      memory_used_bytes: 24 * GIB,
      temperature_celsius: 55,
      power_watts: 180,
      power_limit_watts: 300,
      clock_graphics_mhz: 1900,
      clock_sm_mhz: 1900,
      clock_memory_mhz: 8000,
      fan_speed_percent: 30,
    },
    cpu: { name: 'Grace CPU', aggregate_percent: 25, per_core: [] },
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
    disk: { name: 'nvme0n1', read_bytes_per_sec: 0, write_bytes_per_sec: 0 },
    network: { name: 'enp1s0', rx_bytes_per_sec: 0, tx_bytes_per_sec: 0 },
    engines: [engine(ALPHA, 'Qwen/Qwen3-8B', 120), engine(BETA, 'meta-llama/Llama-3-8B', 640)],
    gpu_events: [],
  }
}

function receive(metrics: MetricsSnapshot) {
  act(() => MockWebSocket.instances[0].receive(JSON.stringify(metrics)))
}

async function openPage(fetchMock: FetchMock) {
  window.history.replaceState(null, '', '/pages/watch')
  render(<App />)
  await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  await act(() => configurationResponse(fetchMock))
}

const pageConfigButton = () => screen.getByRole('button', { name: 'Page config' })
const configuration = () => screen.getByRole('region', { name: 'Page configuration' })
const followPanel = () => screen.getByRole('region', { name: 'Decode Throughput' })
const pinnedPanel = () => screen.getByRole('region', { name: 'Pinned to Alpha' })

beforeEach(() => {
  MockWebSocket.instances = []
  gridSubstitute.reset()
})

describe('the page configuration control', () => {
  it('offers automatic, all models, and each model on the host', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(watchPage()) })
    await openPage(fetchMock)
    receive(snapshot())

    await userEvent.click(pageConfigButton())

    const options = within(configuration()).getAllByRole('button')
    expect(options.map((option) => option.textContent)).toEqual([
      'Automatic — first serving model',
      'All models — combined',
      'Qwen3-8B — vLLM localhost:8000',
      'Llama-3-8B — vLLM localhost:8001',
    ])
    expect(options[0]).toHaveAttribute('aria-pressed', 'true')
  })

  it('writes the choice immediately and the following panels move to the combined figures', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(watchPage()) })
    await openPage(fetchMock)
    receive(snapshot())

    // Nothing configured: the page follows the first running engine.
    expect(within(followPanel()).getByText('120.0')).toBeInTheDocument()

    await userEvent.click(pageConfigButton())
    await userEvent.click(
      within(configuration()).getByRole('button', { name: 'All models — combined' }),
    )

    // One write, the moment the choice was made — no edit session, no save
    // button — carrying the source on the page it configures.
    await waitFor(() => expect(configurationWrites(fetchMock)).toHaveLength(1))
    const written = JSON.parse(configurationWrites(fetchMock)[0])
    expect(written.pages[0].source).toEqual({ kind: 'all' })

    // The choice landed and the popover's job is done.
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Page configuration' })).not.toBeInTheDocument(),
    )

    // The following panel shows the sum under the aggregate's own name — and
    // the pinned panel stays on the engine its label promises.
    expect(within(followPanel()).getByText('760.0')).toBeInTheDocument()
    expect(within(followPanel()).getByText('All models')).toBeInTheDocument()
    expect(within(followPanel()).getByText('2 of 2 serving')).toBeInTheDocument()
    expect(within(pinnedPanel()).getByText('120.0')).toBeInTheDocument()
  })

  it('renders a stored all-models page as the combined view from the first paint', async () => {
    // The kiosk case: the configuration is in the document, so nobody has to
    // touch the control after a reboot.
    const fetchMock = serveConfiguration({
      document: storedDocument(watchPage({ kind: 'all' })),
    })
    await openPage(fetchMock)
    receive(snapshot())

    expect(within(followPanel()).getByText('760.0')).toBeInTheDocument()
    expect(within(pinnedPanel()).getByText('120.0')).toBeInTheDocument()
    expect(configurationWrites(fetchMock)).toHaveLength(0)
  })

  it('renders a stored default model and clears it on the way back to automatic', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument(watchPage({ kind: 'engine', endpoint: BETA })),
    })
    await openPage(fetchMock)
    receive(snapshot())

    // The page opens on the configured engine, not the host default.
    expect(within(followPanel()).getByText('640.0')).toBeInTheDocument()

    await userEvent.click(pageConfigButton())
    await userEvent.click(
      within(configuration()).getByRole('button', { name: 'Automatic — first serving model' }),
    )

    await waitFor(() => expect(configurationWrites(fetchMock)).toHaveLength(1))
    // Automatic is the absence of the field, not a stored sentinel.
    expect(JSON.parse(configurationWrites(fetchMock)[0]).pages[0]).not.toHaveProperty('source')
    expect(within(followPanel()).getByText('120.0')).toBeInTheDocument()
  })

  it('keeps a configured engine that is not on this host on offer, marked', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument(watchPage({ kind: 'engine', endpoint: 'http://localhost:9999' })),
    })
    await openPage(fetchMock)
    receive(snapshot())

    await userEvent.click(pageConfigButton())

    const dangling = within(configuration()).getByRole('button', {
      name: 'http://localhost:9999 (not on this host)',
    })
    expect(dangling).toHaveAttribute('aria-pressed', 'true')
  })

  it('says why nothing can be chosen on a read-only instance', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument(watchPage()),
      readOnly: true,
    })
    await openPage(fetchMock)
    receive(snapshot())

    await userEvent.click(pageConfigButton())

    expect(
      within(configuration()).getByText(
        'This dashboard is read-only, so the page cannot be reconfigured.',
      ),
    ).toBeInTheDocument()
    for (const option of within(configuration()).getAllByRole('button')) {
      expect(option).toBeDisabled()
    }
  })

  it('withholds the control while a layout edit session is open', async () => {
    // A source change writes the document immediately, and mid-session the
    // document under the unsaved panels must hold still.
    const fetchMock = serveConfiguration({ document: storedDocument(watchPage()) })
    await openPage(fetchMock)
    receive(snapshot())

    await userEvent.click(screen.getByRole('button', { name: 'Edit layout' }))
    expect(screen.queryByRole('button', { name: 'Page config' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(pageConfigButton()).toBeInTheDocument()
  })
})
