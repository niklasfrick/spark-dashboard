import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
import type { MetricsSnapshot } from '../types/metrics'

// Edit mode (#83) through the application seam: real routing, real
// configuration loading and saving over the fetch stub, real panels reading the
// real store. The grid library is the shared jsdom substitute, which records
// what the grid was mounted with and lets a spec report the geometry a drag
// would have produced. Whether a real drag produces it — and what the operator
// sees when the page has no room — is the browser suite (#87); jsdom has no
// layout engine to drag in.
substituteWebSocket()

const GIB = 1_073_741_824

function storedDocument(panels: unknown[]): string {
  return JSON.stringify({
    version: DASHBOARD_SCHEMA_VERSION,
    pages: [{ id: 'watch', name: 'Watch', panels }],
  })
}

/** Two panels side by side, filling the top half of the page. */
function twoPanels(): unknown[] {
  return [
    { id: 'cpu', type: 'cpu-utilization', geometry: { x: 0, y: 0, w: 6, h: 4 } },
    { id: 'mem', type: 'memory', geometry: { x: 6, y: 0, w: 6, h: 4 } },
  ]
}

function snapshot(cpuPercent: number, timestampMs: number): MetricsSnapshot {
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
    // The per-core value is held fixed so the aggregate is the only number the
    // CPU panel shows that this spec moves.
    cpu: { name: 'Grace CPU', aggregate_percent: cpuPercent, per_core: [{ id: 0, usage_percent: 7 }] },
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

function receive(metrics: MetricsSnapshot) {
  act(() => MockWebSocket.instances[0].receive(JSON.stringify(metrics)))
}

async function configurationSettles(fetchMock: FetchMock) {
  await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  await act(() => configurationResponse(fetchMock))
}

/** Opens the page at its own URL and settles the configuration it loads. */
async function openPage(fetchMock: FetchMock) {
  window.history.replaceState(null, '', '/pages/watch')
  render(<App />)
  await configurationSettles(fetchMock)
}

const editLayout = () => screen.getByRole('button', { name: 'Edit layout' })
const saveLayout = () => screen.getByRole('button', { name: 'Save layout' })
const discard = () => screen.getByRole('button', { name: 'Discard' })

/** The geometry the grid holds for one panel, as the document would store it. */
function placement(id: string) {
  return gridSubstitute.geometry().get(id)
}

/** The panels of the one page in the single write the spec expects. */
function savedPanels(fetchMock: FetchMock): Array<Record<string, unknown>> {
  const writes = configurationWrites(fetchMock)
  expect(writes).toHaveLength(1)
  return JSON.parse(writes[0]).pages[0].panels
}

beforeEach(() => {
  MockWebSocket.instances = []
  gridSubstitute.reset()
})

describe('entering and leaving edit mode', () => {
  it('leaves the page static until the operator asks to edit it', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(twoPanels()) })
    await openPage(fetchMock)

    // Nothing drags, and no layout change has anywhere to be reported to.
    expect(gridSubstitute.options().staticGrid).toBe(true)
    expect(gridSubstitute.acceptsLayoutChanges()).toBe(false)
    expect(screen.queryByRole('button', { name: 'Save layout' })).not.toBeInTheDocument()

    await userEvent.click(editLayout())

    expect(gridSubstitute.options().staticGrid).toBe(false)
    expect(gridSubstitute.acceptsLayoutChanges()).toBe(true)
    // The row cap becomes the engine's business for the session, which is what
    // makes running out of room a state rather than a scrollbar.
    expect(gridSubstitute.options().maxRow).toBe(8)
  })

  it('puts the page back to static when the session ends', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(twoPanels()) })
    await openPage(fetchMock)

    await userEvent.click(editLayout())
    await userEvent.click(discard())

    expect(gridSubstitute.options().staticGrid).toBe(true)
    expect(gridSubstitute.options().maxRow).toBe(0)
    expect(editLayout()).toBeInTheDocument()
  })
})

describe('saving and discarding a rearranged page', () => {
  it('writes the new layout on an explicit save, and a reload comes back to it', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(twoPanels()) })
    await openPage(fetchMock)

    await userEvent.click(editLayout())
    act(() => gridSubstitute.moved([{ id: 'mem', x: 0, y: 4, w: 12, h: 4 }]))

    expect(placement('mem')).toEqual({ x: 0, y: 4, w: 12, h: 4 })

    await userEvent.click(saveLayout())

    await waitFor(() => expect(configurationWrites(fetchMock)).toHaveLength(1))
    const written = savedPanels(fetchMock)
    expect(written.map((panel) => [panel.id, panel.geometry])).toEqual([
      ['cpu', { x: 0, y: 0, w: 6, h: 4 }],
      ['mem', { x: 0, y: 4, w: 12, h: 4 }],
    ])
    // The session is over — saved work is not still pending.
    expect(editLayout()).toBeInTheDocument()

    // A reload against what was stored lands on the arrangement that was saved.
    screen.getByRole('region', { name: 'Memory' })
    const reloaded = serveConfiguration({ document: JSON.stringify(JSON.parse(configurationWrites(fetchMock)[0])) })
    gridSubstitute.reset()
    await openPage(reloaded)

    expect(placement('mem')).toEqual({ x: 0, y: 4, w: 12, h: 4 })
  })

  it('discards the session without ever telling the server', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(twoPanels()) })
    await openPage(fetchMock)

    await userEvent.click(editLayout())
    act(() => gridSubstitute.moved([{ id: 'mem', x: 0, y: 4, w: 12, h: 4 }]))
    await userEvent.click(discard())

    expect(configurationWrites(fetchMock)).toEqual([])
    // The page is back to the stored arrangement, panel for panel.
    expect(placement('mem')).toEqual({ x: 6, y: 0, w: 6, h: 4 })
  })

  it('writes nothing while the operator is still dragging', async () => {
    // Intermediate positions are not shared state: the configuration is one
    // document for the whole instance, and every save replaces it.
    const fetchMock = serveConfiguration({ document: storedDocument(twoPanels()) })
    await openPage(fetchMock)

    await userEvent.click(editLayout())
    act(() => gridSubstitute.moved([{ id: 'mem', x: 0, y: 4, w: 6, h: 4 }]))
    act(() => gridSubstitute.moved([{ id: 'mem', x: 3, y: 4, w: 6, h: 4 }]))
    act(() => gridSubstitute.moved([{ id: 'mem', x: 6, y: 4, w: 6, h: 4 }]))

    expect(configurationWrites(fetchMock)).toEqual([])
  })

  it('normalizes what the grid reports before it is stored', async () => {
    // The library omits values equal to its own defaults, so a 1×1 panel comes
    // back with neither width nor height. What lands on disk describes itself.
    const fetchMock = serveConfiguration({ document: storedDocument(twoPanels()) })
    await openPage(fetchMock)

    await userEvent.click(editLayout())
    act(() => gridSubstitute.moved([{ id: 'mem', x: 11, y: 7 }]))
    await userEvent.click(saveLayout())

    await waitFor(() => expect(configurationWrites(fetchMock)).toHaveLength(1))
    expect(savedPanels(fetchMock)[1].geometry).toEqual({ x: 11, y: 7, w: 1, h: 1 })
  })
})

describe('a save the server would not take', () => {
  it('says so and keeps the session open, so the work is still there to retry', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(twoPanels()), putStatus: 500 })
    await openPage(fetchMock)

    await userEvent.click(editLayout())
    act(() => gridSubstitute.moved([{ id: 'mem', x: 0, y: 4, w: 12, h: 4 }]))
    await userEvent.click(saveLayout())

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/saving the dashboard configuration failed/i),
    )
    // Still editing, still holding the rearranged layout.
    expect(saveLayout()).toBeInTheDocument()
    expect(placement('mem')).toEqual({ x: 0, y: 4, w: 12, h: 4 })
  })
})

describe('a read-only instance', () => {
  it('cannot save what it lets the operator rearrange', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(twoPanels()), readOnly: true })
    await openPage(fetchMock)

    expect(screen.getByRole('alert')).toHaveTextContent(/dashboard is read-only/i)

    await userEvent.click(editLayout())
    act(() => gridSubstitute.moved([{ id: 'mem', x: 0, y: 4, w: 12, h: 4 }]))

    expect(saveLayout()).toBeDisabled()
    await userEvent.click(saveLayout())

    expect(configurationWrites(fetchMock)).toEqual([])
  })
})

describe('a page being edited holds still', () => {
  // The socket renders its first snapshot at once and batches the rest onto a
  // two-second flush, so every snapshot after the first needs the clock moved.
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function cpuReads(): string {
    return within(screen.getByRole('region', { name: 'CPU' }))
      .getByTestId('arc-value')
      .closest('svg')!
      .querySelector('text')!.textContent!
  }

  it('keeps rendering the snapshot it had, then catches up when the session ends', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(twoPanels()) })

    // Opened by hand rather than through `openPage`: waiting on a real clock
    // is the one thing a frozen clock cannot do. The configuration request goes
    // out with the mount effect, so there is nothing to wait *for* — only its
    // answer to settle.
    window.history.replaceState(null, '', '/pages/watch')
    render(<App />)
    await act(() => configurationResponse(fetchMock))
    await act(async () => {})

    receive(snapshot(37, 1000))

    expect(cpuReads()).toBe('37')

    fireEvent.click(editLayout())
    receive(snapshot(88, 2000))
    act(() => void vi.advanceTimersByTime(2000))

    // Still 37: a panel that redraws under the cursor is a panel that moves
    // while it is being aimed at.
    expect(cpuReads()).toBe('37')

    fireEvent.click(discard())

    expect(cpuReads()).toBe('88')
  })
})
