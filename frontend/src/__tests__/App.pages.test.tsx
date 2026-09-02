import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../App'
import {
  configurationResets,
  configurationResponse,
  configurationWrites,
  serveConfiguration,
  type FetchMock,
} from '../test/configurationServer'
import { gridSubstitute } from '../test/gridSubstitute'
import { MockWebSocket, substituteWebSocket } from '../test/websocket'
import { DASHBOARD_SCHEMA_VERSION, type DashboardPage } from '../lib/dashboard/schema'

// Multiple pages through the application seam (#85): real routing and history,
// real configuration loading, saving and resetting over the fetch stub, and the
// shared jsdom grid substitute standing in for the layout engine. Every
// assertion is what an operator sees — a tab, an address bar, a page that came
// back after a reload — rather than how the document is shaped on the way there.
//
// jsdom measures every box as 0×0, so the tab strip here always has room for
// every tab. What happens when it does not is `pageTabs.browser.test.tsx`.
substituteWebSocket()

/** One panel, so a page is told apart by what is on it rather than by its name alone. */
function pageOf(id: string, name: string, panelType: string): Record<string, unknown> {
  return {
    id,
    name,
    panels: [{ id: 'only', type: panelType, geometry: { x: 0, y: 0, w: 6, h: 3 } }],
  }
}

function storedDocument(...pages: Array<Record<string, unknown>>): string {
  return JSON.stringify({ version: DASHBOARD_SCHEMA_VERSION, pages })
}

/** The two-page configuration most of these specs start from. */
function twoPages(): string {
  return storedDocument(
    pageOf('watch', 'Watch', 'cpu-utilization'),
    pageOf('wall', 'Wall Display', 'memory'),
  )
}

async function openPage(fetchMock: FetchMock, pathname = '/pages/watch') {
  window.history.replaceState(null, '', pathname)
  render(<App />)
  await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  await act(() => configurationResponse(fetchMock))
}

const tabs = () => screen.getByRole('navigation', { name: 'Pages' })
const tabNames = () =>
  within(tabs())
    .getAllByRole('link')
    .map((tab) => tab.textContent)

const menu = () => screen.getByRole('region', { name: 'Page settings' })

async function openMenu() {
  await userEvent.click(screen.getByRole('button', { name: 'Pages' }))
}

/** The pages of the single write the spec expects, as the server stored them. */
function savedPages(fetchMock: FetchMock): DashboardPage[] {
  const writes = configurationWrites(fetchMock)
  expect(writes).toHaveLength(1)
  return JSON.parse(writes[0]).pages
}

/** Re-opens the application against exactly what the server is now holding. */
async function reload(fetchMock: FetchMock, pathname: string): Promise<FetchMock> {
  cleanup()
  gridSubstitute.reset()
  // The same stub keeps serving: it holds what was written, which is the only
  // way a reload can be said to have restored anything.
  await openPage(fetchMock, pathname)
  return fetchMock
}

beforeEach(() => {
  MockWebSocket.instances = []
  gridSubstitute.reset()
})

afterEach(() => {
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
})

describe('the page tabs', () => {
  it('names every page in the configuration', async () => {
    await openPage(serveConfiguration({ document: twoPages() }))

    expect(tabNames()).toEqual(['Watch', 'Wall Display'])
  })

  it('marks the page the URL names as the one being viewed', async () => {
    await openPage(serveConfiguration({ document: twoPages() }), '/pages/wall')

    expect(within(tabs()).getByRole('link', { current: 'page' })).toHaveTextContent('Wall Display')
  })

  it('switches page in one click, without reloading the document', async () => {
    await openPage(serveConfiguration({ document: twoPages() }))
    expect(screen.getByRole('region', { name: 'CPU' })).toBeInTheDocument()

    await userEvent.click(within(tabs()).getByRole('link', { name: 'Wall Display' }))

    expect(screen.getByRole('region', { name: 'Memory' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'CPU' })).not.toBeInTheDocument()
  })

  it('puts the page it switched to in the address bar, so a reload stays there', async () => {
    const fetchMock = serveConfiguration({ document: twoPages() })
    await openPage(fetchMock)

    await userEvent.click(within(tabs()).getByRole('link', { name: 'Wall Display' }))
    expect(window.location.pathname).toBe('/pages/wall/wall-display')

    await reload(fetchMock, window.location.pathname)
    expect(screen.getByRole('region', { name: 'Memory' })).toBeInTheDocument()
  })

  it('leaves the tab a real link, so a kiosk URL can be copied out of it', async () => {
    await openPage(serveConfiguration({ document: twoPages() }))

    expect(within(tabs()).getByRole('link', { name: 'Wall Display' })).toHaveAttribute(
      'href',
      '/pages/wall/wall-display',
    )
  })

  it('comes back to the previous page on the browser’s back button', async () => {
    await openPage(serveConfiguration({ document: twoPages() }))
    await userEvent.click(within(tabs()).getByRole('link', { name: 'Wall Display' }))

    act(() => window.history.back())
    await waitFor(() => expect(screen.getByRole('region', { name: 'CPU' })).toBeInTheDocument())
  })

  it('shows no tabs on the root dashboard, which the grid has not taken over yet', async () => {
    await openPage(serveConfiguration({ document: twoPages() }), '/')

    expect(screen.queryByRole('navigation', { name: 'Pages' })).not.toBeInTheDocument()
  })
})

describe('creating a page', () => {
  it('stores the new page and lands the operator on it, empty and ready to fill', async () => {
    const fetchMock = serveConfiguration({ document: twoPages() })
    await openPage(fetchMock)

    await openMenu()
    await userEvent.click(screen.getByRole('button', { name: 'New page' }))

    await waitFor(() => expect(window.location.pathname).toBe('/pages/page-3'))
    expect(savedPages(fetchMock).map((page) => page.name)).toEqual([
      'Watch',
      'Wall Display',
      'Page 3',
    ])
    // No panels: a new page is empty, so the operator adds what they came for
    // rather than deleting a preset they did not ask for.
    expect(within(screen.getByRole('main')).queryAllByRole('region')).toEqual([])
  })

  it('stays open on the new page’s name, so creating and naming it is one job', async () => {
    const fetchMock = serveConfiguration({ document: twoPages() })
    await openPage(fetchMock)

    await openMenu()
    await userEvent.click(screen.getByRole('button', { name: 'New page' }))
    await waitFor(() => expect(window.location.pathname).toBe('/pages/page-3'))

    // The menu did not close, and the field now names the page just made.
    const name = within(menu()).getByLabelText('Page name')
    expect(name).toHaveValue('Page 3')

    await userEvent.clear(name)
    await userEvent.type(name, 'Training View')
    await userEvent.click(within(menu()).getByRole('button', { name: 'Rename' }))

    await waitFor(() => expect(tabNames()).toEqual(['Watch', 'Wall Display', 'Training View']))
    // The id was fixed at creation, so naming it afterwards left the URL alone.
    expect(window.location.pathname).toBe('/pages/page-3/training-view')
  })

  it('survives a reload, which is the only reason to store it at all', async () => {
    const fetchMock = serveConfiguration({ document: twoPages() })
    await openPage(fetchMock)

    await openMenu()
    await userEvent.click(screen.getByRole('button', { name: 'New page' }))
    await waitFor(() => expect(window.location.pathname).toBe('/pages/page-3'))

    await reload(fetchMock, '/pages/page-3')
    expect(tabNames()).toEqual(['Watch', 'Wall Display', 'Page 3'])
  })

  it('stays where it is when the server refuses the write', async () => {
    const fetchMock = serveConfiguration({ document: twoPages(), putStatus: 500 })
    await openPage(fetchMock)

    await openMenu()
    await userEvent.click(screen.getByRole('button', { name: 'New page' }))

    await waitFor(() =>
      expect(screen.getByText('Saving the dashboard configuration failed.')).toBeInTheDocument(),
    )
    // Not on a page the server has never heard of.
    expect(window.location.pathname).toBe('/pages/watch')
    expect(tabNames()).toEqual(['Watch', 'Wall Display'])
  })
})

describe('renaming a page', () => {
  it('renames the tab and keeps the panels where they were', async () => {
    const fetchMock = serveConfiguration({ document: twoPages() })
    await openPage(fetchMock)

    await openMenu()
    await userEvent.clear(within(menu()).getByLabelText('Page name'))
    await userEvent.type(within(menu()).getByLabelText('Page name'), 'Training View')
    await userEvent.click(within(menu()).getByRole('button', { name: 'Rename' }))

    await waitFor(() => expect(tabNames()).toEqual(['Training View', 'Wall Display']))
    expect(screen.getByRole('region', { name: 'CPU' })).toBeInTheDocument()
    expect(savedPages(fetchMock)[0]).toMatchObject({ id: 'watch', name: 'Training View' })
  })

  it('keeps the page’s URL working, which is what a kiosk display is pointed at', async () => {
    const fetchMock = serveConfiguration({ document: twoPages() })
    // The kiosk was configured with the slug the page had before the rename.
    await openPage(fetchMock, '/pages/watch/watch')

    await openMenu()
    await userEvent.clear(within(menu()).getByLabelText('Page name'))
    await userEvent.type(within(menu()).getByLabelText('Page name'), 'Training View')
    await userEvent.click(within(menu()).getByRole('button', { name: 'Rename' }))
    await waitFor(() => expect(tabNames()).toEqual(['Training View', 'Wall Display']))

    // The address bar reads as the page does now…
    expect(window.location.pathname).toBe('/pages/watch/training-view')
    // …and the kiosk's stale URL still lands on the same page.
    await reload(fetchMock, '/pages/watch/watch')
    expect(screen.getByRole('region', { name: 'CPU' })).toBeInTheDocument()
    expect(within(tabs()).getByRole('link', { current: 'page' })).toHaveTextContent('Training View')
  })

  it('does not offer to rename a page to nothing', async () => {
    await openPage(serveConfiguration({ document: twoPages() }))

    await openMenu()
    await userEvent.clear(within(menu()).getByLabelText('Page name'))

    expect(within(menu()).getByRole('button', { name: 'Rename' })).toBeDisabled()
  })
})

describe('deleting a page', () => {
  it('removes the page and lands on its neighbour', async () => {
    const fetchMock = serveConfiguration({ document: twoPages() })
    await openPage(fetchMock, '/pages/wall')

    await openMenu()
    await userEvent.click(screen.getByRole('button', { name: 'Delete “Wall Display”' }))

    await waitFor(() => expect(window.location.pathname).toBe('/pages/watch'))
    expect(tabNames()).toEqual(['Watch'])
    expect(savedPages(fetchMock).map((page) => page.id)).toEqual(['watch'])
  })

  it('never takes the last page, which would leave nothing to show', async () => {
    const fetchMock = serveConfiguration({
      document: storedDocument(pageOf('watch', 'Watch', 'cpu-utilization')),
    })
    await openPage(fetchMock)
    await openMenu()

    expect(screen.getByRole('button', { name: 'Delete “Watch”' })).toBeDisabled()
    expect(screen.getByText('The dashboard always has at least one page.')).toBeInTheDocument()
    expect(configurationWrites(fetchMock)).toEqual([])
  })
})

describe('resetting everything', () => {
  it('asks before it takes every page', async () => {
    const fetchMock = serveConfiguration({ document: twoPages() })
    await openPage(fetchMock)

    await openMenu()
    await userEvent.click(within(menu()).getByRole('button', { name: 'Reset everything' }))

    expect(within(menu()).getByRole('group', { name: 'Confirm reset' })).toHaveTextContent(
      /cannot be undone/i,
    )
    expect(configurationResets(fetchMock)).toBe(0)
  })

  it('removes the stored document and comes back on the default preset', async () => {
    const fetchMock = serveConfiguration({ document: twoPages() })
    await openPage(fetchMock)

    await openMenu()
    await userEvent.click(within(menu()).getByRole('button', { name: 'Reset everything' }))
    await userEvent.click(
      within(screen.getByRole('group', { name: 'Confirm reset' })).getByRole('button', {
        name: 'Reset everything',
      }),
    )

    await waitFor(() => expect(window.location.pathname).toBe('/pages/overview'))
    expect(configurationResets(fetchMock)).toBe(1)
    expect(tabNames()).toEqual(['Overview'])
    // The preset, not an empty dashboard: a reset is a working dashboard back.
    expect(screen.getByRole('region', { name: 'GPU Utilization' })).toBeInTheDocument()

    // And it is a reset, not a write: the server is holding nothing again.
    await reload(fetchMock, '/pages/overview')
    expect(tabNames()).toEqual(['Overview'])
  })

  it('takes nothing when the operator backs out', async () => {
    const fetchMock = serveConfiguration({ document: twoPages() })
    await openPage(fetchMock)

    await openMenu()
    await userEvent.click(within(menu()).getByRole('button', { name: 'Reset everything' }))
    await userEvent.click(within(menu()).getByRole('button', { name: 'Cancel' }))

    expect(configurationResets(fetchMock)).toBe(0)
    expect(tabNames()).toEqual(['Watch', 'Wall Display'])
  })

  it('says so when the removal failed, and leaves the pages alone', async () => {
    const fetchMock = serveConfiguration({ document: twoPages(), deleteStatus: 500 })
    await openPage(fetchMock)

    await openMenu()
    await userEvent.click(within(menu()).getByRole('button', { name: 'Reset everything' }))
    await userEvent.click(
      within(screen.getByRole('group', { name: 'Confirm reset' })).getByRole('button', {
        name: 'Reset everything',
      }),
    )

    await waitFor(() =>
      expect(screen.getByText('Resetting the dashboard configuration failed.')).toBeInTheDocument(),
    )
    expect(tabNames()).toEqual(['Watch', 'Wall Display'])
  })
})

describe('a dashboard that cannot be written', () => {
  it('withholds every page edit and says why', async () => {
    await openPage(serveConfiguration({ document: twoPages(), readOnly: true }))
    await openMenu()

    expect(
      within(menu()).getByText('This dashboard is read-only, so its pages cannot be changed.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New page' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete “Watch”' })).toBeDisabled()
    expect(within(menu()).getByRole('button', { name: 'Reset everything' })).toBeDisabled()
  })

  it('still switches pages, because reading them was never a write', async () => {
    await openPage(serveConfiguration({ document: twoPages(), readOnly: true }))

    await userEvent.click(within(tabs()).getByRole('link', { name: 'Wall Display' }))

    expect(screen.getByRole('region', { name: 'Memory' })).toBeInTheDocument()
  })
})

describe('a layout being edited', () => {
  it('holds the page list still, so unsaved work cannot be navigated away from', async () => {
    await openPage(serveConfiguration({ document: twoPages() }))
    await userEvent.click(screen.getByRole('button', { name: 'Edit layout' }))

    await userEvent.click(within(tabs()).getByRole('link', { name: 'Wall Display' }))

    expect(screen.getByRole('region', { name: 'CPU' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/pages/watch')

    await openMenu()
    expect(
      within(menu()).getByText(
        'Save or discard your layout changes to add, rename or delete pages.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New page' })).toBeDisabled()
  })

  it('gives the page list back the moment the edit is discarded', async () => {
    await openPage(serveConfiguration({ document: twoPages() }))
    await userEvent.click(screen.getByRole('button', { name: 'Edit layout' }))
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }))

    await userEvent.click(within(tabs()).getByRole('link', { name: 'Wall Display' }))

    expect(screen.getByRole('region', { name: 'Memory' })).toBeInTheDocument()
  })
})
