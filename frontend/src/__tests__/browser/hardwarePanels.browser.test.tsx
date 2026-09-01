import { describe, expect, it } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { GpuUtilizationPanel } from '@/components/grid/panels/GpuUtilizationPanel'
import { MetricsStoreProvider } from '@/hooks/MetricsStoreProvider'
import { useMetricsStore } from '@/hooks/useMetricsStore'
import { FOLLOW } from '@/lib/dashboard/bindings'
import { DEFAULT_TIME_WINDOW, type DashboardPanel } from '@/lib/dashboard/schema'
import type { MetricsSnapshot } from '@/types/metrics'

// A hardware panel adapting to its own box (#80): the mode decision runs on a
// measured content size, which only a real layout engine produces — jsdom
// measures every box as 0×0 and would render the richest layout at any size.
// The thresholds themselves are unit-tested in mode.test.ts; this spec proves
// the measurement actually drives them at the sizes the grid can produce.
//
// Tailwind classes do not apply here (no Tailwind build in the browser
// project), so assertions use structural hooks — the chart container's
// [data-chart] attribute, the compact bar's test id, the gauge's svg text —
// never the product styling.

function snapshot(): MetricsSnapshot {
  return {
    timestamp_ms: 1000,
    gpu: {
      index: 0,
      name: 'GPU 0',
      utilization_percent: 76,
      temperature_celsius: 61,
      power_watts: 220,
      power_limit_watts: 300,
      clock_graphics_mhz: 2100,
      clock_sm_mhz: 2100,
      clock_memory_mhz: 9000,
      fan_speed_percent: 30,
    },
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

const panel: DashboardPanel = {
  id: 'util',
  type: 'gpu-utilization',
  geometry: { x: 0, y: 0, w: 1, h: 1 },
  binding: FOLLOW,
  window: DEFAULT_TIME_WINDOW,
}

function Ingest() {
  const store = useMetricsStore()
  useEffect(() => {
    store.ingest(snapshot())
  }, [store])
  return null
}

function Harness({ width, height }: { width: number; height: number }) {
  return (
    <MetricsStoreProvider>
      <Ingest />
      <div style={{ width, height }}>
        <GpuUtilizationPanel panel={panel} />
      </div>
    </MetricsStoreProvider>
  )
}

describe('a hardware panel in a real layout engine', () => {
  it('renders the compact value, and no chart, at the smallest grid cell', async () => {
    // A 1×1 cell's content box on a laptop viewport: ~100×55px.
    const { container, getByText } = render(<Harness width={100} height={55} />)

    await waitFor(() => {
      // Legible: the current value and its bar are on screen…
      expect(getByText('76')).toBeTruthy()
      expect(container.querySelector('[data-testid="hbar-fill"]')).toBeTruthy()
      // …and nothing tries to squeeze a chart or a gauge into 55px.
      expect(container.querySelector('[data-chart]')).toBeNull()
      expect(container.querySelector('svg text')).toBeNull()
    })
  })

  it('renders gauge and chart when its own box has room for both', async () => {
    const { container, getByText } = render(<Harness width={600} height={400} />)

    await waitFor(() => {
      expect(container.querySelector('[data-chart]')).toBeTruthy()
      // The gauge's center value renders as svg text.
      expect(getByText('76')).toBeTruthy()
    })
  })

  it('gives the whole width to the chart when the box is tall but narrow', async () => {
    const { container } = render(<Harness width={120} height={300} />)

    await waitFor(() => {
      expect(container.querySelector('[data-chart]')).toBeTruthy()
      // No gauge: its center value would render as svg text outside the chart.
      expect(container.querySelector('svg text')).toBeNull()
    })
  })
})
