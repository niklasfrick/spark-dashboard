import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { HecStatusDot } from '@/components/HecStatusDot'

function serveStatus(body: Record<string, unknown>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })),
  )
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HecStatusDot', () => {
  it('labels the indicator "HEC Connection" regardless of state', async () => {
    serveStatus({
      state: 'exporting',
      reachable: true,
      last_ok_ms: 1,
      last_error: null,
      dropped_count: 0,
    })
    render(<HecStatusDot />)

    await waitFor(() => expect(screen.getByText('HEC Connection')).toBeInTheDocument())
  })

  it('shows green when reachable and red when down', async () => {
    serveStatus({
      state: 'exporting',
      reachable: true,
      last_ok_ms: 1,
      last_error: null,
      dropped_count: 0,
    })
    const { unmount } = render(<HecStatusDot />)
    await waitFor(() => expect(document.querySelector('.bg-green-500')).not.toBeNull())
    unmount()

    serveStatus({
      state: 'down',
      reachable: false,
      last_ok_ms: null,
      last_error: 'connection-failed',
      dropped_count: 3,
    })
    render(<HecStatusDot />)
    await waitFor(() => expect(document.querySelector('.bg-red-500')).not.toBeNull())
  })

  it('is gray when not configured', async () => {
    serveStatus({
      state: 'disabled',
      reachable: false,
      last_ok_ms: null,
      last_error: null,
      dropped_count: 0,
    })
    render(<HecStatusDot />)
    await waitFor(() => expect(document.querySelector('.bg-zinc-600')).not.toBeNull())
  })
})
