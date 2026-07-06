import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { GpuCard } from '../components/GpuCard'
import type { GpuMetrics } from '../types/metrics'

const GIB = 1_073_741_824

const gpu: GpuMetrics = {
  index: 1,
  name: 'NVIDIA RTX PRO 6000',
  utilization_percent: 77,
  memory_total_bytes: 48 * GIB,
  memory_used_bytes: 24 * GIB,
  temperature_celsius: 61,
  power_watts: 220,
  power_limit_watts: 300,
  clock_graphics_mhz: 2100,
  clock_sm_mhz: 2100,
  clock_memory_mhz: 9500,
  fan_speed_percent: 45,
}

describe('GpuCard multi-GPU display', () => {
  it('labels the GPU by NVML index and renders per-device VRAM', () => {
    render(<GpuCard metrics={gpu} />)

    expect(screen.getByText('GPU 1')).toBeTruthy()
    expect(screen.getByText('NVIDIA RTX PRO 6000')).toBeTruthy()
    expect(screen.getByText('VRAM')).toBeTruthy()
    expect(screen.getByText('24.0 GB / 48.0 GB')).toBeTruthy()
  })

  it('filters chart events to the matching GPU index', () => {
    render(
      <GpuCard
        metrics={gpu}
        showCharts
        chartData={{
          utilization: [{ timestamp: 1000, value: 77 }],
          temperature: [{ timestamp: 1000, value: 61 }],
          power: [{ timestamp: 1000, value: 220 }],
          clockGraphics: [{ timestamp: 1000, value: 2100 }],
        }}
        events={[
          { timestamp_ms: 1000, gpu_index: 0, event_type: 'thermal', detail: 'GPU 0 event' },
          { timestamp_ms: 1000, gpu_index: 1, event_type: 'thermal', detail: 'GPU 1 event' },
        ]}
      />,
    )

    expect(screen.queryByText('GPU 0 event')).toBeNull()
  })
})
