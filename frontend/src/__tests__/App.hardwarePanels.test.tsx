import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import App from '../App'
import {
  configurationResponse,
  serveConfiguration,
  type FetchMock,
} from '../test/configurationServer'
import { MockWebSocket, substituteWebSocket } from '../test/websocket'
import { DASHBOARD_SCHEMA_VERSION } from '../lib/dashboard/schema'
import type { GpuMetrics, MetricsSnapshot } from '../types/metrics'

// The hardware panels through the application seam (#80): real routing, real
// configuration loading, real registry, store and subscriptions, with the
// snapshot arriving over the substituted metrics socket — the same seam the
// store spec uses. The chart component is substituted so the series a panel
// requested is assertable; everything the panels themselves render (gauge
// values, rates, legends, placeholders) is asserted as the operator sees it.
substituteWebSocket()

vi.mock('@/components/charts/TimeSeriesChart', () => ({
  TimeSeriesChart: (props: {
    data?: Array<{ value: number }>
    series?: Array<{ label: string; data: Array<{ value: number }> }>
  }) => (
    // Values live in attributes, not text, so text assertions only ever match
    // what the panels themselves render.
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

const GIB = 1_073_741_824
const MIB = 1_048_576
const KIB = 1024

/** A stored page holding panels; binding omitted means `follow`. */
function storedDocument(panels: unknown[]): string {
  return JSON.stringify({
    version: DASHBOARD_SCHEMA_VERSION,
    pages: [{ id: 'hw', name: 'Hardware', panels }],
  })
}

/** All eight hardware panels, tiled inside the 12×8 grid. */
function allHardwarePanels(): unknown[] {
  return [
    { id: 'util', type: 'gpu-utilization', geometry: { x: 0, y: 0, w: 3, h: 3 } },
    { id: 'temp', type: 'gpu-temperature', geometry: { x: 3, y: 0, w: 3, h: 3 } },
    { id: 'power', type: 'gpu-power', geometry: { x: 6, y: 0, w: 3, h: 3 } },
    { id: 'clock', type: 'gpu-clock', geometry: { x: 9, y: 0, w: 3, h: 3 } },
    { id: 'cpu', type: 'cpu-utilization', geometry: { x: 0, y: 3, w: 3, h: 3 } },
    { id: 'mem', type: 'memory', geometry: { x: 3, y: 3, w: 3, h: 3 } },
    { id: 'disk', type: 'disk-io', geometry: { x: 6, y: 3, w: 3, h: 3 } },
    { id: 'net', type: 'network-io', geometry: { x: 9, y: 3, w: 3, h: 3 } },
  ]
}

function makeGpu(index: number, overrides: Partial<GpuMetrics> = {}): GpuMetrics {
  return {
    index,
    name: `NVIDIA Alpha ${index}`,
    utilization_percent: 76,
    memory_total_bytes: 48 * GIB,
    memory_used_bytes: 24 * GIB,
    temperature_celsius: 61,
    power_watts: 220,
    power_limit_watts: 300,
    clock_graphics_mhz: 2100,
    clock_sm_mhz: 2100,
    clock_memory_mhz: 9000,
    fan_speed_percent: 30,
    ...overrides,
  }
}

function makeSnapshot(ts: number, gpus?: GpuMetrics[]): MetricsSnapshot {
  return {
    timestamp_ms: ts,
    gpu: gpus?.[0] ?? makeGpu(0),
    ...(gpus ? { gpus } : {}),
    cpu: {
      name: 'Grace CPU',
      aggregate_percent: 25,
      per_core: [
        { id: 0, usage_percent: 10 },
        { id: 1, usage_percent: 95 },
      ],
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
    disk: { name: 'nvme0n1', read_bytes_per_sec: 12 * MIB, write_bytes_per_sec: 3.5 * MIB },
    network: { name: 'enp1s0', rx_bytes_per_sec: 900 * KIB, tx_bytes_per_sec: 2 * MIB },
    engines: [],
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

/** The metrics socket delivers one snapshot; the first frame flushes at once. */
function receive(snapshot: MetricsSnapshot) {
  act(() => MockWebSocket.instances[0].receive(JSON.stringify(snapshot)))
}

function region(name: string): HTMLElement {
  return screen.getByRole('region', { name })
}

beforeEach(() => {
  MockWebSocket.instances = []
  visit('/pages/hw')
})

describe('the hardware panels on a grid page', () => {
  it('renders every hardware metric from the live snapshot', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(allHardwarePanels()) })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(1000))

    // The four GPU panels show the primary GPU's current values.
    expect(within(region('GPU Utilization')).getByText('76')).toBeInTheDocument()
    expect(within(region('GPU Temp')).getByText('61')).toBeInTheDocument()
    expect(within(region('GPU Power')).getByText('220')).toBeInTheDocument()
    expect(within(region('GPU Clock')).getByText('2100 MHz')).toBeInTheDocument()

    // CPU: the aggregate gauge and the per-core heatmap.
    expect(within(region('CPU')).getByText('25')).toBeInTheDocument()
    expect(within(region('CPU')).getByText('Core Heatmap')).toBeInTheDocument()

    // Memory: used share of the pool, split into the product's segments.
    expect(within(region('Memory')).getByText('50')).toBeInTheDocument()
    expect(within(region('Memory')).getByText('GPU: 24.0 GB')).toBeInTheDocument()
    expect(within(region('Memory')).getByText('Cache: 8.0 GB')).toBeInTheDocument()

    // Disk and network: the current rate pairs.
    expect(within(region('Disk I/O')).getByText('12.0 MB/s')).toBeInTheDocument()
    expect(within(region('Disk I/O')).getByText('3.5 MB/s')).toBeInTheDocument()
    expect(within(region('Network')).getByText('900.0 KB/s')).toBeInTheDocument()
    expect(within(region('Network')).getByText('2.0 MB/s')).toBeInTheDocument()

    // Every one of the eight is implemented — no slot-keeping placeholders.
    expect(screen.queryByText('This panel is not available yet.')).not.toBeInTheDocument()
  })

  it('names the hardware each panel is reading', async () => {
    // "76%" without saying what is at 76% is only useful to someone who
    // already knows the machine — and on a host with several GPUs, or a
    // machine an operator does not administer, nobody does.
    const fetchMock = serveConfiguration({ document: storedDocument(allHardwarePanels()) })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(1000))

    for (const panel of ['GPU Utilization', 'GPU Temp', 'GPU Power', 'GPU Clock']) {
      expect(within(region(panel)).getByText('NVIDIA Alpha 0'), panel).toBeInTheDocument()
    }
    expect(within(region('CPU')).getByText('Grace CPU')).toBeInTheDocument()
    // The memory pool's size stands in for a device name, and says whether the
    // GPU is drawing from the same pool.
    expect(within(region('Memory')).getByText('128 GB Unified')).toBeInTheDocument()
    expect(within(region('Disk I/O')).getByText('nvme0n1')).toBeInTheDocument()
    expect(within(region('Network')).getByText('enp1s0')).toBeInTheDocument()
  })

  it('names the GPU a pinned panel actually resolved to, not the primary one', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument([
        {
          id: 'pinned',
          type: 'gpu-utilization',
          binding: { kind: 'gpu', index: 1 },
          geometry: { x: 0, y: 0, w: 6, h: 4 },
        },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(1000, [makeGpu(0), makeGpu(1, { name: 'NVIDIA Beta 1' })]))

    expect(within(region('GPU Utilization')).getByText('NVIDIA Beta 1')).toBeInTheDocument()
  })

  it('waits quietly before the first snapshot, then fills in when it arrives', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(allHardwarePanels()) })

    render(<App />)
    await configurationSettles(fetchMock)

    // Every panel keeps its slot and says it is waiting — nothing crashes on a
    // metrics-null first render.
    expect(screen.getAllByText('Waiting for metrics')).toHaveLength(8)

    // The first snapshot must not trip the changed-hook-count trap.
    receive(makeSnapshot(1000))
    expect(screen.queryByText('Waiting for metrics')).not.toBeInTheDocument()
    expect(within(region('GPU Utilization')).getByText('76')).toBeInTheDocument()
  })

  it('serves a pinned GPU panel from that GPU’s own series on a multi-GPU host', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument([
        { id: 'following', type: 'gpu-utilization', geometry: { x: 0, y: 0, w: 6, h: 4 } },
        {
          id: 'pinned',
          type: 'gpu-utilization',
          title: 'Second GPU',
          binding: { kind: 'gpu', index: 1 },
          geometry: { x: 6, y: 0, w: 6, h: 4 },
        },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(
      makeSnapshot(1000, [
        makeGpu(0, { utilization_percent: 11 }),
        makeGpu(1, { utilization_percent: 77 }),
      ]),
    )

    // The following panel resolves to the primary GPU; the pinned one to GPU 1
    // — both value and chart series, so the label and the data agree.
    const following = region('GPU Utilization')
    expect(within(following).getByText('11')).toBeInTheDocument()
    expect(within(following).getByTestId('chart')).toHaveAttribute('data-values', '11')

    const pinned = region('Second GPU')
    expect(within(pinned).getByText('77')).toBeInTheDocument()
    expect(within(pinned).getByTestId('chart')).toHaveAttribute('data-values', '77')

    // With several GPUs, each panel names the one it shows.
    expect(within(following).getByText('GPU 0')).toBeInTheDocument()
    expect(within(pinned).getByText('GPU 1')).toBeInTheDocument()
  })

  it('keeps the slot of a panel pinned to a GPU the host does not have, naming it', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument([
        {
          id: 'gone',
          type: 'gpu-temperature',
          binding: { kind: 'gpu', index: 3 },
          geometry: { x: 0, y: 0, w: 6, h: 4 },
        },
        { id: 'mem', type: 'memory', geometry: { x: 6, y: 0, w: 6, h: 4 } },
      ]),
    })

    render(<App />)
    await configurationSettles(fetchMock)
    receive(makeSnapshot(1000))

    // The missing target is named, never silently substituted — and the
    // neighbor still renders, so the page did not break.
    expect(
      within(region('GPU Temp')).getByText('GPU 3 is not on this host.'),
    ).toBeInTheDocument()
    expect(within(region('Memory')).getByText('50')).toBeInTheDocument()
  })
})
