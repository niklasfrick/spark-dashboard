import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryCard } from '../components/MemoryCard'
import type { MemoryMetrics } from '../types/metrics'

const mockMemoryMetrics: MemoryMetrics = {
  total_bytes: 128_000_000_000,
  used_bytes: 64_000_000_000,
  available_bytes: 44_000_000_000,
  cached_bytes: 10_000_000_000,
  gpu_estimated_bytes: 20_000_000_000,
  is_unified: true,
}

describe('MemoryCard', () => {
  it('renders unified memory segments with NVIDIA-branded colors', () => {
    const { container } = render(<MemoryCard metrics={mockMemoryMetrics} />)

    // Verify 4 segment labels are present
    expect(screen.getByText(/GPU \(est\.\):/)).toBeTruthy()
    expect(screen.getByText(/^CPU:/)).toBeTruthy()
    expect(screen.getByText(/^Cached:/)).toBeTruthy()
    expect(screen.getByText(/^Free:/)).toBeTruthy()

    // Verify NVIDIA green color class for GPU segment
    const greenSegments = container.querySelectorAll('.bg-\\[\\#76B900\\]')
    expect(greenSegments.length).toBeGreaterThanOrEqual(1)

    // Verify blue color class for CPU segment
    const blueSegments = container.querySelectorAll('.bg-blue-500')
    expect(blueSegments.length).toBeGreaterThanOrEqual(1)

    // Verify zinc-500 color class for Cached segment
    const cachedSegments = container.querySelectorAll('.bg-zinc-500')
    expect(cachedSegments.length).toBeGreaterThanOrEqual(1)

    // Verify zinc-700 color class for Free segment
    const freeSegments = container.querySelectorAll('.bg-zinc-700')
    expect(freeSegments.length).toBeGreaterThanOrEqual(1)
  })

  it('renders all 4 colored bar segments', () => {
    const { container } = render(<MemoryCard metrics={mockMemoryMetrics} />)

    // StackedBar renders a flex row with one div per non-zero segment
    const barContainer = container.querySelector('.flex.h-2\\.5.rounded-full.overflow-hidden')
    expect(barContainer).toBeTruthy()

    // All 4 mock segments are > 0, so all 4 render (GPU, CPU, Cached, Free)
    const segments = barContainer!.querySelectorAll(':scope > div')
    expect(segments.length).toBe(4)
  })

  it('renders the ArcGauge for memory usage', () => {
    const { container } = render(<MemoryCard metrics={mockMemoryMetrics} />)

    // ArcGauge renders an SVG
    const svg = container.querySelector('svg')
    expect(svg).toBeTruthy()

    // Memory label
    expect(screen.getByText('Memory')).toBeTruthy()
  })

  it('does not show GPU estimation warning when gpu_estimated_bytes is present', () => {
    render(<MemoryCard metrics={mockMemoryMetrics} />)
    expect(screen.queryByText('GPU memory estimation unavailable')).toBeNull()
  })

  it('shows GPU estimation warning when gpu_estimated_bytes is null', () => {
    const noGpuMetrics: MemoryMetrics = {
      ...mockMemoryMetrics,
      gpu_estimated_bytes: null,
    }
    render(<MemoryCard metrics={noGpuMetrics} />)
    expect(screen.getByText('GPU memory estimation unavailable')).toBeTruthy()
  })
})
