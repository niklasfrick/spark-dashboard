import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HBar } from '../components/gauges/HBar'
import type { GaugeSegment } from '../components/gauges/ArcGauge'

describe('HBar', () => {
  it('renders a single value with label and unit', () => {
    render(<HBar value={42} label="GPU Util" unit="%" />)
    expect(screen.getByText('GPU Util')).toBeTruthy()
    expect(screen.getByText('42')).toBeTruthy()
    expect(screen.getByText('%')).toBeTruthy()
  })

  it('fills the bar proportionally to value/max', () => {
    render(<HBar value={30} max={120} label="X" unit="W" />)
    const fill = screen.getByTestId('hbar-fill') as HTMLElement
    // 30/120 = 25%
    expect(fill.style.width).toBe('25%')
  })

  it('clamps the fill width to [0, 100]%', () => {
    render(<HBar value={500} max={100} label="X" unit="%" />)
    expect((screen.getByTestId('hbar-fill') as HTMLElement).style.width).toBe('100%')
  })

  it('prefers displayValue over value for the readout', () => {
    render(<HBar value={75} displayValue={150} label="GPU Power" unit="W" />)
    expect(screen.getByText('150')).toBeTruthy()
  })

  it('renders stacked segments with a legend and no single-value fill', () => {
    // Mirrors how the Memory card calls it: an explicit `value` (used %) plus
    // segments for the stacked breakdown.
    const segments: GaugeSegment[] = [
      { value: 25, total: 100, color: '#76B900', label: 'GPU: 25' },
      { value: 25, total: 100, color: '#3B82F6', label: 'CPU: 25' },
      { value: 50, total: 100, color: '#27272A', label: 'Free: 50' },
    ]
    render(<HBar value={50} label="" unit="%" segments={segments} />)
    // No single-value fill is rendered in segment mode.
    expect(screen.queryByTestId('hbar-fill')).toBeNull()
    // Legend labels present.
    expect(screen.getByText('GPU: 25')).toBeTruthy()
    expect(screen.getByText('Free: 50')).toBeTruthy()
    // Readout uses the explicit value (used %), matching ArcGauge precedence.
    expect(screen.getByText('50')).toBeTruthy()
  })
})
