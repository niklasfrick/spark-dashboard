import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ConnectionBadge } from '@/components/ConnectionBadge'

describe('ConnectionBadge', () => {
  it('labels the indicator "vLLM Connection" regardless of state', () => {
    render(<ConnectionBadge status="connected" isStale={false} />)
    expect(screen.getByText('vLLM Connection')).toBeInTheDocument()
  })

  it('shows green when connected and red when disconnected', () => {
    const { unmount } = render(<ConnectionBadge status="connected" isStale={false} />)
    expect(document.querySelector('.bg-green-500')).not.toBeNull()
    unmount()

    render(<ConnectionBadge status="disconnected" isStale={false} />)
    expect(document.querySelector('.bg-red-500')).not.toBeNull()
  })

  it('pulses yellow while reconnecting', () => {
    render(<ConnectionBadge status="reconnecting" isStale={false} />)
    const dot = document.querySelector('.bg-yellow-500')
    expect(dot).not.toBeNull()
    expect(dot).toHaveClass('animate-pulse-dot')
  })

  it('still shows the stale annotation alongside the fixed label', () => {
    render(<ConnectionBadge status="connected" isStale={true} />)
    expect(screen.getByText('vLLM Connection')).toBeInTheDocument()
    expect(screen.getByText('(stale)')).toBeInTheDocument()
  })
})
