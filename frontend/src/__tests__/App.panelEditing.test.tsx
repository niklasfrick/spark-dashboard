import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
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
import { PANEL_TYPE_IDS, defaultPanelTitle } from '../lib/dashboard/panels'
import { DASHBOARD_SCHEMA_VERSION } from '../lib/dashboard/schema'
import type { GpuMetrics, MetricsSnapshot } from '../types/metrics'

// The palette and per-panel configuration through the application seam (#84):
// real routing, real configuration loading and saving over the fetch stub, real
// panels reading the real store, and the shared jsdom grid substitute standing
// in for the layout engine. What an operator adds, removes, renames, repoints
// and rewindows is asserted as they see it, and again after a save and a
// reload — the round trip is the whole point of a configuration.
substituteWebSocket()

vi.mock('@/components/charts/TimeSeriesChart', () => ({
  TimeSeriesChart: (props: { data?: Array<{ value: number }> }) => (
    // Values live in an attribute, not text, so text assertions only ever match
    // what the panels themselves render.
    <div data-testid="chart" data-values={props.data?.map((p) => p.value).join(',')} />
  ),
}))

const GIB = 1_073_741_824

function storedDocument(panels: unknown[]): string {
  return JSON.stringify({
    version: DASHBOARD_SCHEMA_VERSION,
    pages: [{ id: 'watch', name: 'Watch', panels }],
  })
}

/** One panel across the top half, leaving the rest of the page free. */
function onePanel(): unknown[] {
  return [{ id: 'cpu', type: 'cpu-utilization', geometry: { x: 0, y: 0, w: 6, h: 3 } }]
}

/** A page with no free cell at all. */
function fullPage(): unknown[] {
  return [{ id: 'cpu', type: 'cpu-utilization', geometry: { x: 0, y: 0, w: 12, h: 8 } }]
}

function gpu(index: number, utilization: number): GpuMetrics {
  return {
    index,
    name: `NVIDIA GB10 #${index}`,
    utilization_percent: utilization,
    memory_total_bytes: 96 * GIB,
    memory_used_bytes: 24 * GIB,
    temperature_celsius: 55,
    power_watts: 180,
    power_limit_watts: 300,
    clock_graphics_mhz: 1900,
    clock_sm_mhz: 1900,
    clock_memory_mhz: 8000,
    fan_speed_percent: 30,
  }
}

/** A two-GPU host, so a pin has something to be pinned to. */
function snapshot(timestampMs: number, utilization = [10, 90]): MetricsSnapshot {
  const gpus = utilization.map((value, index) => gpu(index, value))

  return {
    timestamp_ms: timestampMs,
    gpu: gpus[0],
    gpus,
    cpu: { name: 'Grace CPU', aggregate_percent: 40, per_core: [{ id: 0, usage_percent: 7 }] },
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
    engines: [],
    gpu_events: [],
  }
}

/** Delivers a snapshot over the newest socket — a reloaded page opens its own. */
function receive(metrics: MetricsSnapshot) {
  act(() => MockWebSocket.instances.at(-1)!.receive(JSON.stringify(metrics)))
}

/** Opens the page at its own URL and settles the configuration it loads. */
async function openPage(fetchMock: FetchMock) {
  window.history.replaceState(null, '', '/pages/watch')
  render(<App />)
  await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  await act(() => configurationResponse(fetchMock))
}

/**
 * Opens the page, delivers `metrics` if the spec needs a host to bind to, and
 * enters edit mode — which is where all of this lives.
 *
 * The snapshot arrives *before* edit mode by necessity: a page being edited
 * holds the last snapshot it had, so a page that entered edit mode having seen
 * none would hold nothing.
 */
async function editPage(fetchMock: FetchMock, metrics?: MetricsSnapshot) {
  await openPage(fetchMock)
  if (metrics) receive(metrics)
  await userEvent.click(screen.getByRole('button', { name: 'Edit layout' }))
}

const palette = () => screen.getByRole('region', { name: 'Panel palette' })
const settings = () => screen.getByRole('region', { name: 'Panel settings' })
const saveLayout = () => screen.getByRole('button', { name: 'Save layout' })

async function openPalette() {
  await userEvent.click(screen.getByRole('button', { name: 'Add panel' }))
}

async function addPanelOfType(title: string) {
  await openPalette()
  await userEvent.click(within(palette()).getByRole('button', { name: title }))
}

async function configure(title: string) {
  await userEvent.click(screen.getByRole('button', { name: `Configure ${title}` }))
}

/** The panels of the one page in the single write the spec expects. */
function savedPanels(fetchMock: FetchMock): Array<Record<string, unknown>> {
  const writes = configurationWrites(fetchMock)
  expect(writes).toHaveLength(1)
  return JSON.parse(writes[0]).pages[0].panels
}

/** Saves, then re-opens the page against exactly what was written. */
async function saveAndReload(fetchMock: FetchMock): Promise<FetchMock> {
  await userEvent.click(saveLayout())
  await waitFor(() => expect(configurationWrites(fetchMock)).toHaveLength(1))

  const reloaded = serveConfiguration({ document: configurationWrites(fetchMock)[0] })
  // The page being reloaded is the same page: unmount the first render, or
  // every assertion after this one matches two of everything.
  cleanup()
  gridSubstitute.reset()
  await openPage(reloaded)
  return reloaded
}

beforeEach(() => {
  MockWebSocket.instances = []
  gridSubstitute.reset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the panel palette', () => {
  it('offers every panel type the dashboard can show', async () => {
    // Including the log panel, which is a panel here rather than a fixed
    // drawer, and the types this build renders as placeholders — a palette
    // that hid them would make the vocabulary unreachable.
    const fetchMock = serveConfiguration({ document: storedDocument(onePanel()) })
    await editPage(fetchMock)
    await openPalette()

    for (const type of PANEL_TYPE_IDS) {
      expect(
        within(palette()).getByRole('button', { name: defaultPanelTitle(type) }),
        type,
      ).toBeInTheDocument()
    }
    within(palette()).getByRole('button', { name: 'Logs' })
  })

  it('is not offered while the page is only being read', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(onePanel()) })
    await openPage(fetchMock)

    expect(screen.queryByRole('button', { name: 'Add panel' })).not.toBeInTheDocument()
  })

  it('places the chosen panel in the first free slot', async () => {
    // Reading order: the top row is half taken, so the new panel goes beside
    // what is there rather than below it. No drag has to be aimed at anything.
    const fetchMock = serveConfiguration({ document: storedDocument(onePanel()) })
    await editPage(fetchMock)
    await addPanelOfType('GPU Power')

    screen.getByRole('region', { name: 'GPU Power' })
    expect(gridSubstitute.geometry().get('gpu-power')).toEqual({ x: 6, y: 0, w: 3, h: 3 })
  })

  it('closes once a panel is placed, so the page it landed on is visible', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(onePanel()) })
    await editPage(fetchMock)
    await addPanelOfType('GPU Power')

    expect(screen.queryByRole('region', { name: 'Panel palette' })).not.toBeInTheDocument()
  })

  it('adds a second panel of a type without colliding with the first', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(onePanel()) })
    await editPage(fetchMock)
    await addPanelOfType('GPU Power')
    await addPanelOfType('GPU Power')

    expect(gridSubstitute.geometry().get('gpu-power')).toEqual({ x: 6, y: 0, w: 3, h: 3 })
    expect(gridSubstitute.geometry().get('gpu-power-2')).toEqual({ x: 9, y: 0, w: 3, h: 3 })
  })

  it('says so, and adds nothing, when the page has no room', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(fullPage()) })
    await editPage(fetchMock)
    await addPanelOfType('GPU Power')

    expect(screen.getByRole('alert')).toHaveTextContent(/no room for .GPU Power./i)
    expect(screen.queryByRole('region', { name: 'GPU Power' })).not.toBeInTheDocument()
  })

  it('keeps an added panel only once the layout is saved', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(onePanel()) })
    await editPage(fetchMock)
    await addPanelOfType('GPU Power')

    // Discarding is the undo: nothing was written, and the panel is gone.
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }))

    expect(configurationWrites(fetchMock)).toEqual([])
    expect(screen.queryByRole('region', { name: 'GPU Power' })).not.toBeInTheDocument()
  })

  it('writes the added panel, and a reload comes back to it', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(onePanel()) })
    await editPage(fetchMock)
    await addPanelOfType('GPU Power')
    await saveAndReload(fetchMock)

    screen.getByRole('region', { name: 'GPU Power' })
    expect(gridSubstitute.geometry().get('gpu-power')).toEqual({ x: 6, y: 0, w: 3, h: 3 })
  })
})

describe('removing a panel', () => {
  it('takes it off the page, and the save writes it out of the document', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(onePanel()) })
    await editPage(fetchMock)
    await configure('CPU')
    await userEvent.click(within(settings()).getByRole('button', { name: 'Remove panel' }))

    expect(screen.queryByRole('region', { name: 'CPU' })).not.toBeInTheDocument()
    // The settings had nothing left to configure and closed with the panel.
    expect(screen.queryByRole('region', { name: 'Panel settings' })).not.toBeInTheDocument()

    await saveAndReload(fetchMock)

    expect(screen.queryByRole('region', { name: 'CPU' })).not.toBeInTheDocument()
  })
})

describe('renaming a panel', () => {
  it('puts the operator’s own words in the header, and keeps them', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(onePanel()) })
    await editPage(fetchMock)
    await configure('CPU')
    await userEvent.type(within(settings()).getByLabelText('Title'), 'CPU load, node 3')

    screen.getByRole('region', { name: 'CPU load, node 3' })

    await saveAndReload(fetchMock)

    screen.getByRole('region', { name: 'CPU load, node 3' })
  })

  it('goes back to the panel type’s own title when the name is cleared', async () => {
    const named = [{ ...(onePanel()[0] as object), title: 'CPU load, node 3' }]
    const fetchMock = serveConfiguration({ document: storedDocument(named) })
    await editPage(fetchMock)
    await configure('CPU load, node 3')
    await userEvent.clear(within(settings()).getByLabelText('Title'))

    screen.getByRole('region', { name: 'CPU' })

    await userEvent.click(saveLayout())
    await waitFor(() => expect(configurationWrites(fetchMock)).toHaveLength(1))
    // Absent rather than empty: the document says "never renamed", so a
    // reworded default reaches this panel later.
    expect(savedPanels(fetchMock)[0]).not.toHaveProperty('title')
  })
})

describe('pinning a panel to one target', () => {
  const gpuPanel = () => screen.getByRole('region', { name: 'GPU Utilization' })

  /** A GPU panel that follows the page, on a page of its own. */
  function followingGpuPanel(): unknown[] {
    return [{ id: 'util', type: 'gpu-utilization', geometry: { x: 0, y: 0, w: 6, h: 3 } }]
  }

  it('shows the pinned GPU’s numbers under the pinned GPU’s name', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(followingGpuPanel()) })
    await editPage(fetchMock, snapshot(1000, [10, 90]))

    // Following the page, which starts on the primary GPU.
    expect(gpuPanel()).toHaveTextContent('10')

    await configure('GPU Utilization')
    await userEvent.selectOptions(within(settings()).getByLabelText('Source'), 'gpu:1')

    expect(gpuPanel()).toHaveTextContent('90')
    expect(gpuPanel()).toHaveTextContent('GPU 1')
  })

  it('keeps the pin across a save and a reload', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(followingGpuPanel()) })
    await editPage(fetchMock, snapshot(1000, [10, 90]))
    await configure('GPU Utilization')
    await userEvent.selectOptions(within(settings()).getByLabelText('Source'), 'gpu:1')

    await saveAndReload(fetchMock)
    receive(snapshot(2000, [10, 90]))

    expect(gpuPanel()).toHaveTextContent('90')
  })

  it('puts a pinned panel back to following the page', async () => {
    const pinned = [
      { ...(followingGpuPanel()[0] as object), binding: { kind: 'gpu', index: 1 } },
    ]
    const fetchMock = serveConfiguration({ document: storedDocument(pinned) })
    await editPage(fetchMock, snapshot(1000, [10, 90]))

    expect(gpuPanel()).toHaveTextContent('90')

    await configure('GPU Utilization')
    await userEvent.selectOptions(within(settings()).getByLabelText('Source'), 'follow')

    expect(gpuPanel()).toHaveTextContent('10')
  })

  it('is how a binding that could not be read is repaired', async () => {
    // A hand-edited file, or a truncated write. The panel says it needs
    // repointing rather than quietly showing the page's selection under a
    // title that may name the target it lost.
    const broken = [{ ...(followingGpuPanel()[0] as object), binding: { kind: 'nonsense' } }]
    const fetchMock = serveConfiguration({ document: storedDocument(broken) })
    await editPage(fetchMock, snapshot(1000, [10, 90]))

    expect(gpuPanel()).not.toHaveTextContent('10')

    await configure('GPU Utilization')
    await userEvent.selectOptions(within(settings()).getByLabelText('Source'), 'gpu:0')

    expect(gpuPanel()).toHaveTextContent('10')
  })

  it('offers nothing to pin on a panel that covers the whole host', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(onePanel()) })
    await editPage(fetchMock, snapshot(1000))
    await configure('CPU')

    expect(within(settings()).queryByLabelText('Source')).not.toBeInTheDocument()
  })
})

describe('a panel’s own time window', () => {
  function gpuPanels(): unknown[] {
    return [
      { id: 'a', type: 'gpu-utilization', geometry: { x: 0, y: 0, w: 6, h: 3 }, window: '5m' },
      { id: 'b', type: 'gpu-utilization', geometry: { x: 6, y: 0, w: 6, h: 3 }, window: '15m' },
    ]
  }

  it('is written for that panel alone', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(onePanel()) })
    await editPage(fetchMock)
    await addPanelOfType('GPU Power')
    await configure('GPU Power')
    await userEvent.selectOptions(within(settings()).getByLabelText('Time window'), '15m')
    await userEvent.click(saveLayout())

    await waitFor(() => expect(configurationWrites(fetchMock)).toHaveLength(1))
    expect(savedPanels(fetchMock).map((panel) => panel.window)).toEqual(['5m', '15m'])
  })

  it('gives two panels on one page charts of different spans', async () => {
    // Ten minutes of history: the five-minute panel has dropped the first
    // reading, the fifteen-minute panel still has it. Same series, same page,
    // different windows.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = serveConfiguration({ document: storedDocument(gpuPanels()) })
    await openPage(fetchMock)

    receive(snapshot(1000, [11, 90]))
    act(() => {
      MockWebSocket.instances.at(-1)!.receive(JSON.stringify(snapshot(601_000, [22, 90])))
      vi.advanceTimersByTime(2000)
    })

    const spans = screen
      .getAllByTestId('chart')
      .map((chart) => chart.getAttribute('data-values'))

    expect(spans).toEqual(['22', '11,22'])
  })

  it('is not offered on a panel whose rendering has no window to cover', async () => {
    // A log tail shows whatever the engine last printed; a window here would
    // be a control that changes nothing.
    const fetchMock = serveConfiguration({ document: storedDocument(onePanel()) })
    await editPage(fetchMock)
    await addPanelOfType('Logs')
    await configure('Logs')

    expect(within(settings()).queryByLabelText('Time window')).not.toBeInTheDocument()
    // Its engine binding is still configurable, because logs bind like any
    // other engine panel.
    within(settings()).getByLabelText('Source')
  })
})
