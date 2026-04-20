import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { TimeSeriesChart } from '../components/charts/TimeSeriesChart'

const sampleData = [
  { timestamp: 1700000000000, value: 50 },
  { timestamp: 1700000001000, value: 55 },
  { timestamp: 1700000002000, value: 60 },
  { timestamp: 1700000003000, value: 58 },
]

describe('TimeSeriesChart', () => {
  it('renders chart container', () => {
    const { container } = render(<TimeSeriesChart data={sampleData} />)
    const chart = container.querySelector('[data-slot="chart"]')
    expect(chart).not.toBeNull()
  })

  it('renders without crashing with events', () => {
    const events = [
      {
        timestamp: 1700000001000,
        type: 'thermal',
        detail: 'Thermal throttling active',
      },
    ]
    const { container } = render(
      <TimeSeriesChart data={sampleData} events={events} />,
    )
    const chart = container.querySelector('[data-slot="chart"]')
    expect(chart).not.toBeNull()
  })

  it('renders without crashing with requests', () => {
    const requests = [
      {
        start: 1700000000000,
        end: 1700000002000,
        tps: 25.5,
        ttft: 120,
      },
    ]
    const { container } = render(
      <TimeSeriesChart data={sampleData} requests={requests} />,
    )
    const chart = container.querySelector('[data-slot="chart"]')
    expect(chart).not.toBeNull()
  })
})
