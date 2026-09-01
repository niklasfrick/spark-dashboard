import { describe, expect, it, vi } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import { useEffect } from 'react'
import { GridPanel } from '@/components/grid/GridPanel'
import { PageSelectionProvider } from '@/hooks/PageSelectionProvider'
import { MetricsStoreProvider } from '@/hooks/MetricsStoreProvider'
import { useMetricsStore } from '@/hooks/useMetricsStore'
import { usePageSelection } from '@/hooks/usePageSelection'
import { FOLLOW } from '@/lib/dashboard/bindings'
import { DEFAULT_TIME_WINDOW, type DashboardPanel } from '@/lib/dashboard/schema'
import type { GpuMetrics, MetricsSnapshot } from '@/types/metrics'

// The page-level selection (#81): what every `follow` panel on a page defers
// to. The panels are the real ones, rendered through the real frame; only the
// affordance that changes the selection is local to this spec, because the UI
// for changing it ships later (#84/#85) and the machinery has to be right
// first.
vi.mock('@/components/charts/TimeSeriesChart', () => ({
  TimeSeriesChart: (props: { data?: Array<{ value: number }> }) => (
    <div data-testid="chart" data-values={props.data?.map((p) => p.value).join(',')} />
  ),
}))

function makeGpu(index: number, utilization: number): GpuMetrics {
  return {
    index,
    name: `NVIDIA Alpha ${index}`,
    utilization_percent: utilization,
    memory_total_bytes: null,
    memory_used_bytes: null,
    temperature_celsius: 40 + index,
    power_watts: 100 + index,
    power_limit_watts: 300,
    clock_graphics_mhz: 2000 + index,
    clock_sm_mhz: null,
    clock_memory_mhz: null,
    fan_speed_percent: null,
  }
}

function snapshot(): MetricsSnapshot {
  const gpus = [makeGpu(0, 11), makeGpu(1, 77)]
  return {
    timestamp_ms: 1000,
    gpu: gpus[0],
    gpus,
    cpu: { name: 'CPU', aggregate_percent: 25, per_core: [] },
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
    disk: { name: 'disk', read_bytes_per_sec: 1, write_bytes_per_sec: 2 },
    network: { name: 'net', rx_bytes_per_sec: 3, tx_bytes_per_sec: 4 },
    engines: [],
    gpu_events: [],
  }
}

function panel(id: string, type: string): DashboardPanel {
  return {
    id,
    type,
    geometry: { x: 0, y: 0, w: 3, h: 3 },
    binding: FOLLOW,
    window: DEFAULT_TIME_WINDOW,
  }
}

/** Stands in for the selector UI that ships with #84/#85. */
function SelectGpu({ index }: { index: number | null }) {
  const { selectGpu } = usePageSelection()
  return (
    <button type="button" onClick={() => selectGpu(index)}>
      Select GPU {index ?? 'default'}
    </button>
  )
}

function Ingest() {
  const store = useMetricsStore()
  useEffect(() => {
    store.ingest(snapshot())
  }, [store])
  return null
}

function Page() {
  return (
    <MetricsStoreProvider>
      <Ingest />
      <PageSelectionProvider>
        <SelectGpu index={1} />
        <SelectGpu index={null} />
        <GridPanel panel={panel('util', 'gpu-utilization')} />
        <GridPanel panel={panel('temp', 'gpu-temperature')} />
        <GridPanel
          panel={{ ...panel('pinned', 'gpu-utilization'), title: 'Pinned to GPU 0', binding: { kind: 'gpu', index: 0 } }}
        />
      </PageSelectionProvider>
    </MetricsStoreProvider>
  )
}

function region(name: string): HTMLElement {
  return screen.getByRole('region', { name })
}

function click(name: string) {
  act(() => screen.getByRole('button', { name }).click())
}

describe('the page-level GPU selection', () => {
  it('starts on the primary GPU, moves every following panel together, and leaves pins alone', () => {
    render(<Page />)

    // Nothing chosen: the page follows the host's primary GPU.
    expect(within(region('GPU Utilization')).getByText('11')).toBeInTheDocument()
    expect(within(region('GPU Temp')).getByText('40')).toBeInTheDocument()

    click('Select GPU 1')

    // One selection change, and every following panel moved with it — value and
    // chart series, so no panel is showing another GPU's numbers.
    const util = region('GPU Utilization')
    expect(within(util).getByText('77')).toBeInTheDocument()
    expect(within(util).getByTestId('chart')).toHaveAttribute('data-values', '77')
    expect(within(region('GPU Temp')).getByText('41')).toBeInTheDocument()

    // The pinned panel stayed where it was pinned.
    expect(within(region('Pinned to GPU 0')).getByText('11')).toBeInTheDocument()

    click('Select GPU default')
    expect(within(region('GPU Utilization')).getByText('11')).toBeInTheDocument()
  })
})
