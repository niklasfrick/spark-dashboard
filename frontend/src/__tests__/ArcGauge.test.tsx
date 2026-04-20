import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ArcGauge } from '../components/gauges/ArcGauge'

describe('ArcGauge', () => {
  it('renders SVG with value and unit', () => {
    const { container } = render(
      <ArcGauge value={75} max={100} label="GPU Util" unit="%" />,
    )
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(screen.getByText('75')).toBeDefined()
    expect(screen.getByText('%')).toBeDefined()
  })

  it('uses NVIDIA green when no thresholds', () => {
    const { container } = render(
      <ArcGauge value={50} max={100} label="GPU Util" unit="%" />,
    )
    const valueArc = container.querySelector('[data-testid="arc-value"]')
    expect(valueArc?.getAttribute('stroke')).toBe('#76B900')
  })

  it('uses yellow for warning threshold', () => {
    const { container } = render(
      <ArcGauge
        value={75}
        max={100}
        label="Temp"
        unit="C"
        thresholds={{ warning: 70, critical: 85 }}
      />,
    )
    const valueArc = container.querySelector('[data-testid="arc-value"]')
    expect(valueArc?.getAttribute('stroke')).toBe('#eab308')
  })

  it('uses red for critical threshold', () => {
    const { container } = render(
      <ArcGauge
        value={90}
        max={100}
        label="Temp"
        unit="C"
        thresholds={{ warning: 70, critical: 85 }}
      />,
    )
    const valueArc = container.querySelector('[data-testid="arc-value"]')
    expect(valueArc?.getAttribute('stroke')).toBe('#ef4444')
  })

  it('renders the label text', () => {
    render(
      <ArcGauge value={50} max={100} label="Memory" unit="%" />,
    )
    expect(screen.getByText('Memory')).toBeDefined()
  })
})
