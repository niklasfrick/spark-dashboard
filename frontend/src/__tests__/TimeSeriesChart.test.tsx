import type { ComponentProps } from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TimeSeriesChart } from '../components/charts/TimeSeriesChart'
import {
  ChartContainer,
  ChartTooltipContent,
} from '../components/ui/chart'

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

  it('renders short throughput legend labels without the tok/s unit', () => {
    render(
      <TimeSeriesChart
        title="Prefill Throughput (tok/s)"
        hideTooltipLabel
        series={[
          { data: sampleData, label: 'Live', color: '#76B900' },
          { data: sampleData, label: 'Avg', color: '#3b82f6' },
          { data: sampleData, label: 'Per-req', color: '#a855f7' },
        ]}
        unit="tok/s"
      />,
    )
    expect(screen.queryByText('Prefill Throughput (tok/s)')).not.toBeNull()
    expect(screen.queryByText('Live')).not.toBeNull()
    expect(screen.queryByText('Avg')).not.toBeNull()
    expect(screen.queryByText('Per-req')).not.toBeNull()
    // The unit lives in the title now, never in a legend label.
    expect(screen.queryByText('Live tok/s')).toBeNull()
    expect(screen.queryByText('Avg tok/s')).toBeNull()
    expect(screen.queryByText('Per-req tok/s')).toBeNull()
  })

  it('uses tooltipLabel as the tooltip header when provided', () => {
    const config = { s0: { label: 'Live', color: '#76B900' } }
    const payload = [
      { dataKey: 's0', name: 's0', value: 60, color: '#76B900' },
    ] as unknown as ComponentProps<typeof ChartTooltipContent>['payload']
    render(
      <ChartContainer config={config}>
        <ChartTooltipContent
          active
          payload={payload}
          labelFormatter={() => 'Tokens / sec'}
        />
      </ChartContainer>,
    )
    expect(screen.queryByText('Tokens / sec')).not.toBeNull()
  })

  it('falls back to the first series label as tooltip header without tooltipLabel', () => {
    const config = { s0: { label: 'Live', color: '#76B900' } }
    const payload = [
      { dataKey: 's0', name: 's0', value: 60, color: '#76B900' },
    ] as unknown as ComponentProps<typeof ChartTooltipContent>['payload']
    render(
      <ChartContainer config={config}>
        <ChartTooltipContent active payload={payload} />
      </ChartContainer>,
    )
    expect(screen.queryByText('Tokens / sec')).toBeNull()
    expect(screen.queryAllByText('Live').length).toBeGreaterThan(0)
  })

  it('hides the tooltip header when hideLabel is set', () => {
    const config = { s0: { label: 'TTFT', color: '#f59e0b' } }
    const payload = [
      { dataKey: 's0', name: 's0', value: 42, color: '#f59e0b' },
    ] as unknown as ComponentProps<typeof ChartTooltipContent>['payload']
    render(
      <ChartContainer config={config}>
        <ChartTooltipContent active payload={payload} hideLabel />
      </ChartContainer>,
    )
    // Header row gone; the series label still renders in the value row.
    expect(screen.queryAllByText('TTFT').length).toBe(1)
  })

  it('shows the seriesLabel (not the unit) as the single-line tooltip row name', () => {
    // Mirrors the config TimeSeriesChart builds in single-line mode when
    // seriesLabel is provided: { value: { label: seriesLabel } }.
    const config = { value: { label: 'E2E Latency', color: '#76B900' } }
    const payload = [
      { dataKey: 'value', name: 'value', value: 1.2, color: '#76B900' },
    ] as unknown as ComponentProps<typeof ChartTooltipContent>['payload']
    render(
      <ChartContainer config={config}>
        <ChartTooltipContent active payload={payload} hideLabel />
      </ChartContainer>,
    )
    expect(screen.queryByText('E2E Latency')).not.toBeNull()
    expect(screen.queryByText('s')).toBeNull()
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
