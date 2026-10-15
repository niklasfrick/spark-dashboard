import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { GoodputTile, LiveWithTotal, MetricTile } from '../components/engines/EnginePanelPrimitives'

describe('MetricTile', () => {
  it('is a group named by its label', () => {
    render(<MetricTile label="TTFT" value="120" unit="ms" />)
    expect(screen.getByRole('group', { name: 'TTFT' })).toBeInTheDocument()
  })

  it('shows its value, unit and subline when the figure is reported', () => {
    render(<MetricTile label="TTFT" value="120" unit="ms" subline="p99 400" />)
    const tile = screen.getByRole('group', { name: 'TTFT' })
    expect(within(tile).getByText('120')).toBeInTheDocument()
    expect(within(tile).getByText('ms')).toBeInTheDocument()
    expect(within(tile).getByText('p99 400')).toBeInTheDocument()
    expect(within(tile).queryByText('not reported')).not.toBeInTheDocument()
  })

  it('keeps its label and says "not reported" in place of the figure', () => {
    render(<MetricTile label="TTFT" value="--" notReported />)
    const tile = screen.getByRole('group', { name: 'TTFT' })
    expect(within(tile).getByText('TTFT')).toBeInTheDocument()
    expect(within(tile).getByText('not reported')).toBeInTheDocument()
  })

  it('renders no value, unit, trend or subline when not reported', () => {
    render(
      <MetricTile label="TTFT" value="--" unit="ms" trend="up" subline="p99 400" notReported />,
    )
    const tile = screen.getByRole('group', { name: 'TTFT' })
    expect(tile).not.toHaveTextContent('--')
    expect(within(tile).queryByText('ms')).not.toBeInTheDocument()
    expect(within(tile).queryByText('▲')).not.toBeInTheDocument()
    expect(within(tile).queryByText('p99 400')).not.toBeInTheDocument()
  })
})

describe('GoodputTile', () => {
  it('shows its percentage when the figure is reported', () => {
    render(<GoodputTile label="TTFT" pct={99} />)
    const tile = screen.getByRole('group', { name: 'TTFT' })
    expect(within(tile).getByText('99.0')).toBeInTheDocument()
    expect(within(tile).queryByText('not reported')).not.toBeInTheDocument()
  })

  it('keeps its label and says "not reported" in place of the figure', () => {
    render(<GoodputTile label="TTFT" pct={null} notReported />)
    const tile = screen.getByRole('group', { name: 'TTFT' })
    expect(within(tile).getByText('TTFT')).toBeInTheDocument()
    expect(within(tile).getByText('not reported')).toBeInTheDocument()
  })

  it('renders no placeholder dashes or percent sign when not reported', () => {
    render(<GoodputTile label="TTFT" pct={null} notReported />)
    const tile = screen.getByRole('group', { name: 'TTFT' })
    expect(tile).not.toHaveTextContent('--')
    expect(within(tile).queryByText('%')).not.toBeInTheDocument()
  })
})

describe('LiveWithTotal', () => {
  it('shows the live figure and the total when reported', () => {
    render(<LiveWithTotal liveValue="42" liveUnit="tok/s" totalLabel="Total" total={1500} />)
    const tile = screen.getByRole('group', { name: 'Live' })
    expect(within(tile).getByText('42')).toBeInTheDocument()
    expect(within(tile).getByText('Total')).toBeInTheDocument()
    expect(within(tile).queryByText('not reported')).not.toBeInTheDocument()
  })

  it('keeps both labels and says "not reported" in place of both figures', () => {
    render(<LiveWithTotal liveValue="--" totalLabel="Total" total={null} notReported />)
    const tile = screen.getByRole('group', { name: 'Live' })
    expect(within(tile).getByText('Live')).toBeInTheDocument()
    expect(within(tile).getByText('Total')).toBeInTheDocument()
    expect(within(tile).getAllByText('not reported')).toHaveLength(2)
  })

  it('renders no dashes, unit or token suffix when not reported', () => {
    render(<LiveWithTotal liveValue="--" liveUnit="tok/s" totalLabel="Total" total={null} notReported />)
    const tile = screen.getByRole('group', { name: 'Live' })
    expect(tile).not.toHaveTextContent('--')
    expect(within(tile).queryByText('tok/s')).not.toBeInTheDocument()
    expect(within(tile).queryByText('tok')).not.toBeInTheDocument()
  })
})
