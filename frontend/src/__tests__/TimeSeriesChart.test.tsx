import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
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

  it('renders both line labels for the Cache (KV + Prefix Hit) multi-series chart', () => {
    const prefixData = [
      { timestamp: 1700000000000, value: 10 },
      { timestamp: 1700000001000, value: 20 },
    ]
    const { container } = render(
      <TimeSeriesChart
        title="Cache"
        series={[
          { data: sampleData, label: 'KV Cache', color: '#76B900' },
          { data: prefixData, label: 'Prefix Hit', color: '#3b82f6' },
        ]}
        yDomain={[0, 100]}
        unit="%"
      />,
    )
    const chart = container.querySelector('[data-slot="chart"]')
    expect(chart).not.toBeNull()
    expect(screen.queryByText('KV Cache')).not.toBeNull()
    expect(screen.queryByText('Prefix Hit')).not.toBeNull()
  })

  it('renders all four labels for the Latency (TTFT + Queue + ITL + TPOT) chart', () => {
    const other = [
      { timestamp: 1700000000000, value: 12 },
      { timestamp: 1700000001000, value: 14 },
    ]
    const { container } = render(
      <TimeSeriesChart
        title="Latency · Avg"
        series={[
          { data: sampleData, label: 'TTFT', color: '#f59e0b', axis: 'left' },
          { data: other, label: 'Queue', color: '#8b5cf6', axis: 'right' },
          { data: other, label: 'ITL', color: '#14b8a6', axis: 'right' },
          { data: other, label: 'TPOT', color: '#ec4899', axis: 'right' },
        ]}
        unit="ms"
      />,
    )
    const chart = container.querySelector('[data-slot="chart"]')
    expect(chart).not.toBeNull()
    expect(screen.queryByText('TTFT')).not.toBeNull()
    expect(screen.queryByText('Queue')).not.toBeNull()
    expect(screen.queryByText('ITL')).not.toBeNull()
    expect(screen.queryByText('TPOT')).not.toBeNull()
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
