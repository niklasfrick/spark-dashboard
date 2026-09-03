import { describe, expect, it } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { EngineDecodeThroughputPanel } from '@/components/grid/panels/EngineThroughputPanel'
import { MetricsStoreProvider } from '@/hooks/MetricsStoreProvider'
import { useMetricsStore } from '@/hooks/useMetricsStore'
import { FOLLOW } from '@/lib/dashboard/bindings'
import { DEFAULT_TIME_WINDOW, type DashboardPanel } from '@/lib/dashboard/schema'
import type { EngineMetrics, EngineSnapshot, MetricsSnapshot } from '@/types/metrics'

// An engine panel adapting to its own box (#81): the mode decision runs on a
// measured content size, which only a real layout engine produces — jsdom
// measures every box as 0×0 and would render the chart at any size. The
// thresholds themselves are unit-tested in mode.test.ts; this spec proves the
// measurement drives them at the sizes the grid can produce.
//
// Tailwind classes do not apply here (no Tailwind build in the browser
// project), so assertions use structural hooks — the chart container's
// [data-chart] attribute — never the product styling.

function engine(): EngineSnapshot {
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
      tokens_per_sec: 120,
      avg_tokens_per_sec: 100,
      per_request_tps: 40,
      total_generation_tokens: 500_000,
    } as EngineMetrics,
    recent_requests: [],
    deployment_mode: 'Native',
  }
}

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
      clock_sm_mhz: null,
      clock_memory_mhz: null,
      fan_speed_percent: null,
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
    engines: [engine()],
    gpu_events: [],
  }
}

const panel: DashboardPanel = {
  id: 'decode',
  type: 'engine-decode-throughput',
  geometry: { x: 0, y: 0, w: 3, h: 3 },
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
        <EngineDecodeThroughputPanel panel={panel} />
      </div>
    </MetricsStoreProvider>
  )
}

describe('an engine panel in a real layout engine', () => {
  it('keeps its values and drops the chart in a short grid cell', async () => {
    const { container, getByText } = render(<Harness width={320} height={140} />)

    await waitFor(() => {
      // The values are what the panel is for, so they survive the squeeze…
      expect(getByText('120.0')).toBeTruthy()
      // …and nothing tries to squeeze a chart into what is left.
      expect(container.querySelector('[data-chart]')).toBeNull()
    })
  })

  it('charts under its values when its own box has room for both', async () => {
    const { container, getByText } = render(<Harness width={320} height={320} />)

    await waitFor(() => {
      expect(getByText('120.0')).toBeTruthy()
      expect(container.querySelector('[data-chart]')).toBeTruthy()
    })
  })
})
