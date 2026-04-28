import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryCard } from '../components/MemoryCard'
import type { MemoryMetrics } from '../types/metrics'

const GIB = 1_073_741_824

const mockMemoryMetrics: MemoryMetrics = {
  total_bytes: 128 * GIB,
  used_bytes: 64 * GIB,
  available_bytes: 44 * GIB,
  cached_bytes: 10 * GIB,
  gpu_estimated_bytes: 20 * GIB,
  gpu_memory_total_bytes: null,
  gpu_memory_used_bytes: null,
  is_unified: true,
}

const discreteGpuMetrics: MemoryMetrics = {
  total_bytes: 64 * GIB,
  used_bytes: 32 * GIB,
  available_bytes: 28 * GIB,
  cached_bytes: 6 * GIB,
  gpu_estimated_bytes: null,
  gpu_memory_total_bytes: 24 * GIB,
  gpu_memory_used_bytes: 12 * GIB,
  is_unified: false,
}

describe('MemoryCard', () => {
  it('renders unified memory legend entries with correct labels', () => {
    render(<MemoryCard metrics={mockMemoryMetrics} />)

    // Verify segment legend labels are present
    expect(screen.getByText(/GPU \(est\.\):/)).toBeTruthy()
    expect(screen.getByText(/^CPU:/)).toBeTruthy()
    expect(screen.getByText(/^Cached:/)).toBeTruthy()
    expect(screen.getByText(/^Free:/)).toBeTruthy()
  })

  it('renders 4 colored legend dots for the 4 memory segments', () => {
    const { container } = render(<MemoryCard metrics={mockMemoryMetrics} />)

    // Legend dots are span elements with inline background-color
    const legendDots = container.querySelectorAll('span[style*="background-color"]')
    expect(legendDots.length).toBe(4)

    // GPU dot is NVIDIA green
    expect((legendDots[0] as HTMLElement).style.backgroundColor).toBe('rgb(118, 185, 0)')
    // CPU dot is blue-500
    expect((legendDots[1] as HTMLElement).style.backgroundColor).toBe('rgb(59, 130, 246)')
    // Cached dot is zinc-500
    expect((legendDots[2] as HTMLElement).style.backgroundColor).toBe('rgb(113, 113, 122)')
    // Free dot is zinc-800
    expect((legendDots[3] as HTMLElement).style.backgroundColor).toBe('rgb(39, 39, 42)')
  })

  it('renders the ArcGauge SVG with multiple segment arcs', () => {
    const { container } = render(<MemoryCard metrics={mockMemoryMetrics} />)

    // ArcGauge renders an SVG
    const svg = container.querySelector('svg')
    expect(svg).toBeTruthy()

    // With segments, there should be multiple value circles (one per segment + background track)
    const circles = svg!.querySelectorAll('circle')
    expect(circles.length).toBe(5) // 1 background track + 4 segments

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

  describe('discrete GPU (is_unified=false)', () => {
    it('renders system RAM and a separate GPU VRAM section', () => {
      render(<MemoryCard metrics={discreteGpuMetrics} />)

      // Title and subtitle switch for discrete
      expect(screen.getByText(/64 GB system RAM/)).toBeTruthy()
      expect(screen.getByText('GPU VRAM')).toBeTruthy()
      expect(screen.getByText(/24 GB total/)).toBeTruthy()

      // VRAM section renders its own used/free legend entries
      const used = screen.getAllByText(/^Used:/)
      expect(used.length).toBeGreaterThanOrEqual(1)

      // Discrete case must not show the unified "GPU (est.)" segment
      expect(screen.queryByText(/GPU \(est\.\):/)).toBeNull()
      // Nor the unified-only warning
      expect(screen.queryByText('GPU memory estimation unavailable')).toBeNull()
    })

    it('hides the VRAM section when gpu_memory_total_bytes is null', () => {
      const noVramMetrics: MemoryMetrics = {
        ...discreteGpuMetrics,
        gpu_memory_total_bytes: null,
        gpu_memory_used_bytes: null,
      }
      render(<MemoryCard metrics={noVramMetrics} />)
      expect(screen.queryByText('GPU VRAM')).toBeNull()
    })
  })
})
