import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
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

// Engine rotation (#124): a browser setting that steps a page's following
// engine panels through all models and each running engine, for wall displays.
// Driven through the application seam — real configuration loading over the
// fetch stub, real panels reading the real store, the control in the real page
// bar — on a fake clock, because the clock is the feature.
substituteWebSocket()

const GIB = 1_073_741_824
const STORAGE_KEY = 'spark-dashboard:engine-rotation'

const ALPHA = 'http://localhost:8000'
const BETA = 'http://localhost:8001'
const GAMMA = 'http://localhost:8002'

/** Decode throughput per engine, chosen so every sum is distinct too. */
const TOKENS: Record<string, number> = { [ALPHA]: 120, [BETA]: 640, [GAMMA]: 40 }

function storedDocument(source?: unknown): string {
  return JSON.stringify({
    version: DASHBOARD_SCHEMA_VERSION,
    pages: [
      {
        id: 'watch',
        name: 'Watch',
        ...(source === undefined ? {} : { source }),
        panels: [
          { id: 'decode', type: 'engine-decode-throughput', geometry: { x: 0, y: 0, w: 4, h: 4 } },
          {
            id: 'pinned',
            type: 'engine-decode-throughput',
            title: 'Pinned to Alpha',
            geometry: { x: 4, y: 0, w: 4, h: 4 },
            binding: { kind: 'engine', endpoint: ALPHA },
          },
          { id: 'gpu', type: 'gpu-temperature', geometry: { x: 8, y: 0, w: 4, h: 4 } },
        ],
      },
    ],
  })
}

function engine(endpoint: string, status: EngineSnapshot['status'] = { type: 'Running' }): EngineSnapshot {
  return {
    engine_type: 'Vllm',
    endpoint,
    status,
    model: {
      name: 'Qwen/Qwen3-8B',
      parameter_size: null,
      quantization: null,
      precision: null,
      tensor_type: null,
      model_type: null,
      pipeline_tag: null,
    },
    metrics: status.type === 'Running' ? ({ tokens_per_sec: TOKENS[endpoint] } as EngineMetrics) : null,
    recent_requests: [],
    deployment_mode: 'Native',
  }
}

function snapshot(engines: EngineSnapshot[], timestampMs = 1_000): MetricsSnapshot {
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
    engines,
    gpu_events: [],
  }
}

const TWO_ENGINES = [engine(ALPHA), engine(BETA)]

/**
 * Opened by hand rather than waiting on the request: a frozen clock cannot
 * wait. The configuration request goes out with the mount effect, so there is
 * only its answer to settle. No snapshot has arrived yet, so the edit bar's
 * first render is the one without metrics.
 */
async function openPage(fetchMock: FetchMock) {
  window.history.replaceState(null, '', '/pages/watch')
  render(<App />)
  await act(() => configurationResponse(fetchMock))
  await act(async () => {})
}

/** The first snapshot renders at once; the socket batches later ones onto a
 *  two-second flush, so those need the clock moved to land. */
function receive(metrics: MetricsSnapshot) {
  act(() => MockWebSocket.instances[0].receive(JSON.stringify(metrics)))
}

function elapse(ms: number) {
  act(() => void vi.advanceTimersByTime(ms))
}

const rotation = () => screen.getByRole('combobox', { name: 'Engine rotation' })
const queryRotation = () => screen.queryByRole('combobox', { name: 'Engine rotation' })
const countdown = () => screen.queryByTestId('engine-rotation-countdown')

function choose(value: string) {
  fireEvent.change(rotation(), { target: { value } })
}

/** What the following decode panel shows right now. */
function following(): HTMLElement {
  return screen.getByRole('region', { name: 'Decode Throughput' })
}

function followingShows(value: string) {
  expect(within(following()).getByText(value)).toBeInTheDocument()
}

function pinnedShowsAlpha() {
  expect(
    within(screen.getByRole('region', { name: 'Pinned to Alpha' })).getByText('120.0'),
  ).toBeInTheDocument()
}

beforeEach(() => {
  MockWebSocket.instances = []
  gridSubstitute.reset()
  window.localStorage.clear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the engine rotation control', () => {
  it('is off by default, and offers off and the four intervals', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument() })
    await openPage(fetchMock)
    receive(snapshot(TWO_ENGINES))

    expect(rotation()).toHaveValue('off')
    expect(within(rotation()).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Off',
      '3 s',
      '5 s',
      '10 s',
      '20 s',
    ])
    // It sits in the edit bar beside the page config.
    expect(screen.getByRole('button', { name: 'Page config' })).toBeInTheDocument()

    // Off means off: the page stays on the first running engine.
    elapse(60_000)
    followingShows('120.0')
    expect(countdown()).not.toBeInTheDocument()
  })

  it('is hidden, and rotates nothing, with fewer than two engines running', async () => {
    // Switched on in this browser, but a host with one serving engine has
    // nothing to rotate between.
    window.localStorage.setItem(STORAGE_KEY, '3000')
    const fetchMock = serveConfiguration({ document: storedDocument() })
    await openPage(fetchMock)
    receive(snapshot([engine(ALPHA), engine(BETA, { type: 'Stopped' })]))

    expect(queryRotation()).not.toBeInTheDocument()
    followingShows('120.0')
    elapse(30_000)
    followingShows('120.0')
  })
})

describe('a rotating page', () => {
  it('steps following panels through all models and each engine, and leaves the rest alone', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument({ kind: 'all' }) })
    await openPage(fetchMock)
    receive(snapshot(TWO_ENGINES))

    // The page's source: all models, combined.
    followingShows('760.0')

    choose('5000')

    // Running, and saying so.
    expect(rotation()).toHaveValue('5000')
    expect(screen.getByText('Rotating')).toBeInTheDocument()
    expect(countdown()).toBeInTheDocument()

    // Nothing moves until the interval is up.
    elapse(4_999)
    followingShows('760.0')

    elapse(1)
    followingShows('120.0')
    // The panel names the engine it moved to, so a wall display stays legible.
    expect(within(following()).getByText('vLLM localhost:8000')).toBeInTheDocument()
    pinnedShowsAlpha()

    elapse(5_000)
    followingShows('640.0')
    expect(within(following()).getByText('vLLM localhost:8001')).toBeInTheDocument()
    pinnedShowsAlpha()

    // …and back to all models, under the aggregate's own name.
    elapse(5_000)
    followingShows('760.0')
    expect(within(following()).getByText('All models')).toBeInTheDocument()
    pinnedShowsAlpha()

    // GPU panels do not read the engine target at all.
    expect(
      within(screen.getByRole('region', { name: 'GPU Temp' })).getByText('55'),
    ).toBeInTheDocument()
  })

  it('takes its first step from wherever the page is', async () => {
    // An automatic page shows the first running engine; rotation carries on
    // from there instead of jumping to all models the moment it is turned on.
    const fetchMock = serveConfiguration({ document: storedDocument() })
    await openPage(fetchMock)
    receive(snapshot(TWO_ENGINES))
    followingShows('120.0')

    choose('3000')
    followingShows('120.0')

    elapse(3_000)
    followingShows('640.0')
    elapse(3_000)
    followingShows('760.0')
    elapse(3_000)
    followingShows('120.0')
  })

  it('picks up engines that start or stop on the next step', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument() })
    await openPage(fetchMock)
    receive(snapshot(TWO_ENGINES))
    choose('10000')

    // A third engine starts two seconds in, mid-countdown.
    receive(snapshot([engine(ALPHA), engine(BETA), engine(GAMMA)], 2_000))
    elapse(2_000)
    followingShows('120.0')

    elapse(8_000)
    followingShows('640.0')
    elapse(10_000)
    followingShows('40.0')
    elapse(10_000)
    followingShows('800.0')
    elapse(10_000)
    followingShows('120.0')
    elapse(10_000)
    followingShows('640.0')

    // Beta, the engine on screen, stops, and Gamma goes away: one engine is
    // nothing to rotate between, so the control goes, and the page is handed
    // back to its source rather than left on a stopped engine.
    receive(snapshot([engine(ALPHA), engine(BETA, { type: 'Stopped' })], 3_000))
    elapse(2_000)

    expect(queryRotation()).not.toBeInTheDocument()
    followingShows('120.0')
    elapse(60_000)
    followingShows('120.0')
  })

  it('returns following panels to the page source when it is turned off', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument({ kind: 'engine', endpoint: BETA }),
    })
    await openPage(fetchMock)
    receive(snapshot(TWO_ENGINES))
    followingShows('640.0')

    choose('5000')
    elapse(5_000)
    // Beta is the last engine in the cycle, so the next step is all models.
    followingShows('760.0')

    choose('off')

    followingShows('640.0')
    expect(screen.getByText('Rotate')).toBeInTheDocument()
    expect(countdown()).not.toBeInTheDocument()
    elapse(30_000)
    followingShows('640.0')
  })

  it('is remembered by this browser and never written to the configuration', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument() })
    await openPage(fetchMock)
    receive(snapshot(TWO_ENGINES))

    choose('20000')
    elapse(20_000)

    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('20000')
    // One browser's preference must not change what everyone else sees (ADR-0003).
    expect(configurationWrites(fetchMock)).toEqual([])
  })

  it('starts on its own in a browser that turned it on before', async () => {
    // The kiosk case: set once, and rotating again after a reboot with nobody
    // at the screen.
    window.localStorage.setItem(STORAGE_KEY, '10000')
    const fetchMock = serveConfiguration({ document: storedDocument({ kind: 'all' }) })
    await openPage(fetchMock)
    receive(snapshot(TWO_ENGINES))

    expect(rotation()).toHaveValue('10000')
    elapse(10_000)
    followingShows('120.0')
  })
})

describe('rotation and edit mode', () => {
  const editLayout = () => screen.getByRole('button', { name: 'Edit layout' })

  it('holds the page still while it is edited and resumes with a fresh countdown after Discard', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument({ kind: 'all' }) })
    await openPage(fetchMock)
    receive(snapshot(TWO_ENGINES))
    choose('5000')

    elapse(5_000)
    followingShows('120.0')

    // Two seconds into the next countdown, the operator starts editing.
    elapse(2_000)
    fireEvent.click(editLayout())

    // The control goes with the page config, and the page stays on the target
    // it had, however long the session lasts.
    expect(queryRotation()).not.toBeInTheDocument()
    elapse(60_000)
    followingShows('120.0')

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))

    // Back, and counting a whole interval again rather than finishing the one
    // the session interrupted.
    expect(rotation()).toHaveValue('5000')
    expect(countdown()).toBeInTheDocument()
    elapse(4_999)
    followingShows('120.0')
    elapse(1)
    followingShows('640.0')
  })

  it('resumes after Save layout too', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument({ kind: 'all' }) })
    await openPage(fetchMock)
    receive(snapshot(TWO_ENGINES))
    choose('3000')

    fireEvent.click(editLayout())
    elapse(30_000)
    followingShows('760.0')

    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }))
    await act(async () => {})
    expect(configurationWrites(fetchMock)).toHaveLength(1)
    // The layout was written; the rotation setting was not.
    expect(configurationWrites(fetchMock)[0]).not.toContain('rotation')

    expect(rotation()).toHaveValue('3000')
    elapse(3_000)
    followingShows('120.0')
  })
})
