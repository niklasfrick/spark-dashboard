import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ExportSettingsDialog } from '@/components/ExportSettingsDialog'
import type { DashboardDocument } from '@/lib/dashboard/schema'

/** The document as the server hands it back: token masked. */
const documentWithExport: DashboardDocument = {
  version: 1,
  pages: [],
  export: {
    url: 'https://splunk.example.com:8088/services/collector',
    token: '…-abc',
    index: 'metrics',
    events_index: 'main',
  },
}

function serveExport(
  statusBody: Record<string, unknown>,
  testBody: Record<string, unknown> = { outcome: 'ok', index: 'metrics' },
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string) => {
    if (input.includes('/api/export-status')) {
      return new Response(JSON.stringify(statusBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (input.includes('/api/export/test')) {
      return new Response(JSON.stringify(testBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(null, { status: 204 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function renderDialog(
  props: Partial<React.ComponentProps<typeof ExportSettingsDialog>> = {},
) {
  const save = vi.fn().mockResolvedValue('saved' as const)
  const utils = render(
    <ExportSettingsDialog
      open
      onOpenChange={vi.fn()}
      document={documentWithExport}
      readOnly={false}
      save={save}
      {...props}
    />,
  )
  return { ...utils, save }
}

const exportingStatus = {
  state: 'exporting',
  reachable: true,
  last_ok_ms: 1_723_800_000_000,
  last_error: null,
  dropped_count: 0,
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('ExportSettingsDialog', () => {
  it('shows the masked token with the keep-the-stored-token note', () => {
    serveExport(exportingStatus)
    renderDialog()

    const tokenInput = screen.getByLabelText(/HEC token/i) as HTMLInputElement
    expect(tokenInput).toHaveValue('…-abc')
    expect(screen.getByText(/A token is stored/)).toBeInTheDocument()
  })

  it('saves with an empty token when the masked one was not touched', async () => {
    serveExport(exportingStatus)
    const { save } = renderDialog()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    const next = save.mock.calls[0][0] as DashboardDocument
    expect(next.export?.token).toBe('')
    expect(next.export?.url).toBe(documentWithExport.export?.url)
    expect(next.export?.index).toBe('metrics')
  })

  it('lets the operator replace the token with a fresh one', async () => {
    serveExport(exportingStatus)
    const { save } = renderDialog()
    const user = userEvent.setup()

    const tokenInput = screen.getByLabelText(/HEC token/i)
    await user.clear(tokenInput)
    await user.type(tokenInput, 'brand-new-token')

    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect((save.mock.calls[0][0] as DashboardDocument).export?.token).toBe('brand-new-token')
  })

  it('disable removes the section, token included', async () => {
    serveExport(exportingStatus)
    const { save } = renderDialog()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Disable export' }))

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    const next = save.mock.calls[0][0] as DashboardDocument
    expect(next.export).toBeUndefined()
    expect(next.pages).toEqual(documentWithExport.pages)
  })

  it('maps test outcomes to their operator copy', async () => {
    serveExport(exportingStatus, { outcome: 'index-denied', index: 'metrics' })
    renderDialog()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Test connection' }))

    await waitFor(() =>
      expect(
        screen.getByText('Index not allowed by this token — check the token’s indexes list'),
      ).toBeInTheDocument(),
    )
  })

  it('names the url when the test cannot reach it', async () => {
    serveExport(exportingStatus, { outcome: 'unreachable', index: null })
    renderDialog()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Test connection' }))

    await waitFor(() =>
      expect(
        screen.getByText('Cannot reach https://splunk.example.com:8088/services/collector'),
      ).toBeInTheDocument(),
    )
  })

  it('lights green while reachable, red while down, gray when disabled', async () => {
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [exportingStatus, 'Exporting', 'bg-green-500'],
      [{ ...exportingStatus, state: 'down', reachable: false }, 'Endpoint unreachable — probing every 60 s', 'bg-red-500'],
      [{ ...exportingStatus, state: 'disabled', reachable: false }, 'Export not configured', 'bg-zinc-600'],
    ]

    for (const [body, line, lightClass] of cases) {
      const fetchMock = serveExport(body)
      const { unmount } = renderDialog()
      await waitFor(() => expect(screen.getByText(line)).toBeInTheDocument())
      const dot = document.querySelector(`.${lightClass}`)
      expect(dot, `light ${lightClass} for ${String(body.state)}`).not.toBeNull()
      unmount()
      fetchMock.mockClear()
    }
  })

  it('polls the status only while open', async () => {
    vi.useFakeTimers()
    const fetchMock = serveExport(exportingStatus)
    const { rerender } = render(
      <ExportSettingsDialog
        open
        onOpenChange={vi.fn()}
        document={documentWithExport}
        readOnly={false}
        save={vi.fn().mockResolvedValue('saved' as const)}
      />,
    )

    const countStatusCalls = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/export-status')).length

    await vi.advanceTimersByTimeAsync(0)
    expect(countStatusCalls()).toBe(1)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(countStatusCalls()).toBe(2)

    // Closed: the effect cleans up and nothing further polls.
    rerender(
      <ExportSettingsDialog
        open={false}
        onOpenChange={vi.fn()}
        document={documentWithExport}
        readOnly={false}
        save={vi.fn().mockResolvedValue('saved' as const)}
      />,
    )
    await vi.advanceTimersByTimeAsync(30_000)
    expect(countStatusCalls()).toBe(2)
  })
})
