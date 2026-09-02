import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import App from '../App'
import {
  configurationResponse,
  serveConfiguration,
  serveNothing,
  type FetchMock,
} from '../test/configurationServer'
import { DASHBOARD_SCHEMA_VERSION } from '../lib/dashboard/schema'

// The application root opens the metrics socket on mount. Nothing here is about
// metrics, so the socket only has to exist and stay quiet. The log viewer's spec
// keeps a richer substitute of its own, which drives frames and reconnection —
// this needs none of that.
class SilentWebSocket {
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  readyState = 0
  close() {}
  send() {}
}

/** A stored document at the version this build reads. */
function document(pages: unknown[] = [{ id: 'watch', name: 'Watch', panels: [] }]): string {
  return JSON.stringify({ version: DASHBOARD_SCHEMA_VERSION, pages })
}

/** Waits for the configuration request to resolve and for React to render it. */
async function configurationSettles(fetchMock: FetchMock) {
  await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  await act(() => configurationResponse(fetchMock))
}

/**
 * The dashboard itself, proving a banner never replaced it with a dead screen.
 *
 * The page navigation is the marker because it renders only once a document has
 * resolved — stored, preset, or fallback — so every branch this file drives ends
 * up either here or on nothing at all.
 */
function dashboardIsRendered() {
  expect(screen.getByRole('navigation', { name: 'Pages' })).toBeInTheDocument()
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', SilentWebSocket as unknown as typeof WebSocket)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.localStorage.clear()
  window.sessionStorage.clear()
})

describe('the dashboard configuration at the application root', () => {
  it('shows no banner when nothing is configured', async () => {
    // A fresh install is not a fault: the preset renders and says nothing.
    const fetchMock = serveConfiguration({ document: null })

    render(<App />)
    await configurationSettles(fetchMock)

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    dashboardIsRendered()
  })

  it('shows no banner when the stored configuration loads', async () => {
    const fetchMock = serveConfiguration({ document: document() })

    render(<App />)
    await configurationSettles(fetchMock)

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    dashboardIsRendered()
  })

  it('names the problem when the stored configuration will not parse', async () => {
    const fetchMock = serveConfiguration({ document: '{ not a dashboard }' })

    render(<App />)
    await configurationSettles(fetchMock)

    expect(screen.getByRole('alert')).toHaveTextContent(
      /saved dashboard configuration could not be read/i,
    )
    dashboardIsRendered()
  })

  it('names the problem when the server could not read the stored document', async () => {
    // The server has a document and failed to read it — to the operator, the
    // same problem as one that will not parse, and the same banner.
    const fetchMock = serveConfiguration({ getStatus: 500 })

    render(<App />)
    await configurationSettles(fetchMock)

    expect(screen.getByRole('alert')).toHaveTextContent(
      /saved dashboard configuration could not be read/i,
    )
    dashboardIsRendered()
  })

  it('says so when the stored configuration is from a newer build', async () => {
    const fetchMock = serveConfiguration({
      document: JSON.stringify({ version: DASHBOARD_SCHEMA_VERSION + 1, pages: [] }),
    })

    render(<App />)
    await configurationSettles(fetchMock)

    expect(screen.getByRole('alert')).toHaveTextContent(/from a newer version/i)
    dashboardIsRendered()
  })

  it('says so when the stored configuration is too old to bring forward', async () => {
    // No migration reaches this build from version 0, so there is nothing to
    // render but the preset — and the operator has to know their pages are not
    // lost, merely unreachable from here.
    const fetchMock = serveConfiguration({
      document: JSON.stringify({ version: 0, pages: [] }),
    })

    render(<App />)
    await configurationSettles(fetchMock)

    expect(screen.getByRole('alert')).toHaveTextContent(/too old to read/i)
    dashboardIsRendered()
  })

  it('says so when the server could not be asked for the configuration', async () => {
    const fetchMock = serveNothing()

    render(<App />)
    await configurationSettles(fetchMock)

    expect(screen.getByRole('alert')).toHaveTextContent(/could not be loaded/i)
    dashboardIsRendered()
  })

  it('says so when the dashboard is read-only', async () => {
    const fetchMock = serveConfiguration({ document: null, readOnly: true })

    render(<App />)
    await configurationSettles(fetchMock)

    expect(screen.getByRole('alert')).toHaveTextContent(/read-only/i)
    dashboardIsRendered()
  })

  it('writes nothing about the configuration to browser-local storage', async () => {
    // A per-browser copy of a document shared by everyone on the instance would
    // be an invisible second source of truth. The failing path is the tempting
    // one, so that is the one asserted.
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const fetchMock = serveConfiguration({ document: '{ not a dashboard }' })

    render(<App />)
    await configurationSettles(fetchMock)

    // Targeted rather than "nothing was written at all": other features
    // legitimately keep browser-local preferences, and this contract is about
    // the shared configuration document only.
    const configurationLike = /dashboard|panel|page|preset/i
    expect(
      setItem.mock.calls.filter(([key, value]) => configurationLike.test(`${key} ${value}`)),
    ).toEqual([])
    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (const key of Object.keys(storage)) {
        expect(`${key} ${storage.getItem(key)}`).not.toMatch(configurationLike)
      }
    }
  })
})
