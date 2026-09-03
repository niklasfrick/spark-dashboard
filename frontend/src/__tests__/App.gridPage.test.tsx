import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import App from '../App'
import {
  configurationResponse,
  serveConfiguration,
  type FetchMock,
} from '../test/configurationServer'
import { DASHBOARD_SCHEMA_VERSION } from '../lib/dashboard/schema'

// The grid page through the application seam: real routing, real configuration
// loading, real registry and store subscriptions — with the grid library
// swapped for the shared document-order substitute (see src/test/gridstack.tsx)
// and the metrics socket quiet, since nothing here is about metrics values.
class SilentWebSocket {
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  readyState = 0
  close() {}
  send() {}
}

/** A stored one-page document; panels default to a readable tracer panel. */
function storedDocument(panels: unknown[], pageId = 'watch', pageName = 'Watch'): string {
  return JSON.stringify({
    version: DASHBOARD_SCHEMA_VERSION,
    pages: [{ id: pageId, name: pageName, panels }],
  })
}

function visit(pathname: string) {
  window.history.replaceState(null, '', pathname)
}

async function configurationSettles(fetchMock: FetchMock) {
  await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  await act(() => configurationResponse(fetchMock))
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', SilentWebSocket as unknown as typeof WebSocket)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  visit('/')
})

describe('the grid page route', () => {
  it('renders a stored page’s panels at that page’s URL', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument([
        { id: 'a', type: 'cpu-utilization', geometry: { x: 0, y: 0, w: 6, h: 4 } },
        { id: 'b', type: 'memory', geometry: { x: 6, y: 0, w: 6, h: 4 } },
      ]),
    })
    visit('/pages/watch')

    render(<App />)
    await configurationSettles(fetchMock)

    expect(screen.getByRole('region', { name: 'CPU' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Memory' })).toBeInTheDocument()
  })

  it('matches the page by id alone, so a stale slug from before a rename still lands', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument(
        [{ id: 'a', type: 'memory', geometry: { x: 0, y: 0, w: 6, h: 4 } }],
        'wall',
        'Wall Display',
      ),
    })
    visit('/pages/wall/old-name-from-before-the-rename')

    render(<App />)
    await configurationSettles(fetchMock)

    expect(screen.getByRole('region', { name: 'Memory' })).toBeInTheDocument()
  })

  it('renders the default preset’s page when nothing is configured', async () => {
    const fetchMock = serveConfiguration({ document: null })
    visit('/pages/overview')

    render(<App />)
    await configurationSettles(fetchMock)

    // Every panel the preset places is implemented (#80/#81), so the page
    // renders in full rather than around placeholders.
    expect(screen.getByRole('region', { name: 'CPU' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Memory' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'GPU Utilization' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Latency' })).toBeInTheDocument()
    expect(screen.queryByText('This panel is not available yet.')).not.toBeInTheDocument()
  })

  // The spec that stood here placed an `inference-timeline` panel to watch a
  // known-but-unimplemented type keep its slot. Every type in the vocabulary
  // has a component now (#110), so there is none left to place; the registry
  // is held against the vocabulary in `panelRegistry.test` instead, and the
  // spec below covers the one placeholder a build can still reach.
  it('keeps an unknown panel type’s slot with a placeholder naming the type', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument([
        { id: 'a', type: 'cpu-utilization', geometry: { x: 0, y: 0, w: 6, h: 4 } },
        { id: 'b', type: 'quantum-flux', geometry: { x: 6, y: 0, w: 6, h: 4 } },
        { id: 'c', type: 'memory', geometry: { x: 0, y: 4, w: 6, h: 4 } },
      ]),
    })
    visit('/pages/watch')

    render(<App />)
    await configurationSettles(fetchMock)

    // The unknown panel says what it is and why it cannot render…
    const unknown = screen.getByRole('region', { name: 'quantum-flux' })
    expect(
      within(unknown).getByText(/cannot render a “quantum-flux” panel/),
    ).toBeInTheDocument()
    // …and its neighbors on both sides still rendered — the page did not break.
    expect(screen.getByRole('region', { name: 'CPU' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Memory' })).toBeInTheDocument()
  })

  it('renders panels in document order, which the grid substitute preserves', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument([
        { id: 'first', type: 'cpu-utilization', geometry: { x: 0, y: 0, w: 6, h: 4 } },
        { id: 'second', type: 'memory', geometry: { x: 6, y: 0, w: 6, h: 4 } },
      ]),
    })
    visit('/pages/watch')

    render(<App />)
    await configurationSettles(fetchMock)

    const regions = screen.getAllByRole('region')
    expect(regions.map((region) => region.getAttribute('aria-label'))).toEqual(['CPU', 'Memory'])
  })

  it('uses the operator’s panel title when one was saved', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument([
        { id: 'a', type: 'memory', title: 'RAM, big', geometry: { x: 0, y: 0, w: 6, h: 4 } },
      ]),
    })
    visit('/pages/watch')

    render(<App />)
    await configurationSettles(fetchMock)

    expect(screen.getByRole('region', { name: 'RAM, big' })).toBeInTheDocument()
  })

  it('says when the URL names a page the configuration does not have', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument([]) })
    visit('/pages/deleted-page')

    render(<App />)
    await configurationSettles(fetchMock)

    expect(screen.getByText('No page at this address')).toBeInTheDocument()
    expect(screen.getByText(/no page “deleted-page”/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /back to the dashboard/i })).toHaveAttribute(
      'href',
      '/',
    )
  })

  it('still shows configuration notices, so a fallback is not silent on a kiosk URL', async () => {
    const fetchMock = serveConfiguration({ document: '{ not a dashboard }' })
    visit('/pages/overview')

    render(<App />)
    await configurationSettles(fetchMock)

    expect(screen.getByRole('alert')).toHaveTextContent(
      /saved dashboard configuration could not be read/i,
    )
    // The preset took over, so its page renders under the banner.
    expect(screen.getByRole('region', { name: 'CPU' })).toBeInTheDocument()
  })

  it('serves the first page at the root, so an operator needs no URL to start', async () => {
    const fetchMock = serveConfiguration({
      document: JSON.stringify({
        version: DASHBOARD_SCHEMA_VERSION,
        pages: [
          { id: 'watch', name: 'Watch', panels: [{ id: 'a', type: 'cpu-utilization' }] },
          { id: 'later', name: 'Later', panels: [{ id: 'b', type: 'memory' }] },
        ],
      }),
    })
    visit('/')

    render(<App />)
    await configurationSettles(fetchMock)

    expect(screen.getByRole('region', { name: 'CPU' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Memory' })).not.toBeInTheDocument()
    // The root follows the page list rather than redirecting into it: an
    // operator who bookmarked “this dashboard” did not bookmark whichever page
    // happened to be first the day they did.
    expect(window.location.pathname).toBe('/')
  })

  it('opens a fresh install on the default preset', async () => {
    // The acceptance test for a stock install: no stored configuration, no URL,
    // and the redesigned preset on screen with nothing unavailable in it.
    const fetchMock = serveConfiguration({ document: null })
    visit('/')

    render(<App />)
    await configurationSettles(fetchMock)

    expect(screen.getByRole('region', { name: 'GPU Utilization' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Decode Throughput' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'CPU' })).toBeInTheDocument()
    expect(screen.queryByText('This panel is not available yet.')).not.toBeInTheDocument()
  })

  it('has a page to serve at the root even when the stored document has none', async () => {
    // The root has no page id to fall back on, so it leans on the loader's rule
    // that an empty page list resolves to the preset. If that ever stopped
    // holding, the root would be the blank screen rather than the dashboard.
    const fetchMock = serveConfiguration({
      document: JSON.stringify({ version: DASHBOARD_SCHEMA_VERSION, pages: [] }),
    })
    visit('/')

    render(<App />)
    await configurationSettles(fetchMock)

    expect(screen.getByRole('region', { name: 'GPU Utilization' })).toBeInTheDocument()
  })
})
