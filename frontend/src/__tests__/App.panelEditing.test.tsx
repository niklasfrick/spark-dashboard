import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../App'
import {
  configurationResponse,
  configurationWrites,
  serveConfiguration,
  type FetchMock,
} from '../test/configurationServer'
import { gridSubstitute } from '../test/gridSubstitute'
import { MockWebSocket, substituteWebSocket } from '../test/websocket'
import { PANEL_TYPE_IDS, defaultPanelTitle } from '../lib/dashboard/panels'
import { DASHBOARD_SCHEMA_VERSION } from '../lib/dashboard/schema'

// Adding panels through the application seam (#84): real routing, real
// configuration loading and saving over the fetch stub, real panels reading the
// real store, and the shared jsdom grid substitute standing in for the layout
// engine. What an operator does is asserted as they see it, and again after a
// save and a reload — the round trip is the whole point of a configuration.
substituteWebSocket()

vi.mock('@/components/charts/TimeSeriesChart', () => ({
  TimeSeriesChart: (props: { data?: Array<{ value: number }> }) => (
    // Values live in an attribute, not text, so text assertions only ever match
    // what the panels themselves render.
    <div data-testid="chart" data-values={props.data?.map((p) => p.value).join(',')} />
  ),
}))

function storedDocument(panels: unknown[]): string {
  return JSON.stringify({
    version: DASHBOARD_SCHEMA_VERSION,
    pages: [{ id: 'watch', name: 'Watch', panels }],
  })
}

/** One panel across the top half, leaving the rest of the page free. */
function onePanel(): unknown[] {
  return [{ id: 'cpu', type: 'cpu-utilization', geometry: { x: 0, y: 0, w: 6, h: 3 } }]
}

/** A page with no free cell at all. */
function fullPage(): unknown[] {
  return [{ id: 'cpu', type: 'cpu-utilization', geometry: { x: 0, y: 0, w: 12, h: 8 } }]
}

/** Opens the page at its own URL and settles the configuration it loads. */
async function openPage(fetchMock: FetchMock) {
  window.history.replaceState(null, '', '/pages/watch')
  render(<App />)
  await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  await act(() => configurationResponse(fetchMock))
}

/** Opens the page and enters edit mode, which is where the palette lives. */
async function editPage(fetchMock: FetchMock) {
  await openPage(fetchMock)
  await userEvent.click(screen.getByRole('button', { name: 'Edit layout' }))
}

const palette = () => screen.getByRole('region', { name: 'Panel palette' })
const saveLayout = () => screen.getByRole('button', { name: 'Save layout' })

async function openPalette() {
  await userEvent.click(screen.getByRole('button', { name: 'Add panel' }))
}

async function addPanelOfType(title: string) {
  await openPalette()
  await userEvent.click(within(palette()).getByRole('button', { name: title }))
}

/** Saves, then re-opens the page against exactly what was written. */
async function saveAndReload(fetchMock: FetchMock): Promise<FetchMock> {
  await userEvent.click(saveLayout())
  await waitFor(() => expect(configurationWrites(fetchMock)).toHaveLength(1))

  const reloaded = serveConfiguration({ document: configurationWrites(fetchMock)[0] })
  // The page being reloaded is the same page: unmount the first render, or
  // every assertion after this one matches two of everything.
  cleanup()
  gridSubstitute.reset()
  await openPage(reloaded)
  return reloaded
}

beforeEach(() => {
  MockWebSocket.instances = []
  gridSubstitute.reset()
})

describe('the panel palette', () => {
  it('offers every panel type the dashboard can show', async () => {
    // Including the log panel, which is a panel here rather than a fixed
    // drawer, and the types this build renders as placeholders — a palette
    // that hid them would make the vocabulary unreachable.
    const fetchMock = serveConfiguration({ document: storedDocument(onePanel()) })
    await editPage(fetchMock)
    await openPalette()

    for (const type of PANEL_TYPE_IDS) {
      expect(
        within(palette()).getByRole('button', { name: defaultPanelTitle(type) }),
        type,
      ).toBeInTheDocument()
    }
    within(palette()).getByRole('button', { name: 'Logs' })
  })

  it('is not offered while the page is only being read', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(onePanel()) })
    await openPage(fetchMock)

    expect(screen.queryByRole('button', { name: 'Add panel' })).not.toBeInTheDocument()
  })

  it('places the chosen panel in the first free slot', async () => {
    // Reading order: the top row is half taken, so the new panel goes beside
    // what is there rather than below it. No drag has to be aimed at anything.
    const fetchMock = serveConfiguration({ document: storedDocument(onePanel()) })
    await editPage(fetchMock)
    await addPanelOfType('GPU Power')

    screen.getByRole('region', { name: 'GPU Power' })
    expect(gridSubstitute.geometry().get('gpu-power')).toEqual({ x: 6, y: 0, w: 3, h: 3 })
  })

  it('closes once a panel is placed, so the page it landed on is visible', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(onePanel()) })
    await editPage(fetchMock)
    await addPanelOfType('GPU Power')

    expect(screen.queryByRole('region', { name: 'Panel palette' })).not.toBeInTheDocument()
  })

  it('adds a second panel of a type without colliding with the first', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(onePanel()) })
    await editPage(fetchMock)
    await addPanelOfType('GPU Power')
    await addPanelOfType('GPU Power')

    expect(gridSubstitute.geometry().get('gpu-power')).toEqual({ x: 6, y: 0, w: 3, h: 3 })
    expect(gridSubstitute.geometry().get('gpu-power-2')).toEqual({ x: 9, y: 0, w: 3, h: 3 })
  })

  it('says so, and adds nothing, when the page has no room', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(fullPage()) })
    await editPage(fetchMock)
    await addPanelOfType('GPU Power')

    expect(screen.getByRole('alert')).toHaveTextContent(/no room for .GPU Power./i)
    expect(screen.queryByRole('region', { name: 'GPU Power' })).not.toBeInTheDocument()
  })

  it('keeps an added panel only once the layout is saved', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(onePanel()) })
    await editPage(fetchMock)
    await addPanelOfType('GPU Power')

    // Discarding is the undo: nothing was written, and the panel is gone.
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }))

    expect(configurationWrites(fetchMock)).toEqual([])
    expect(screen.queryByRole('region', { name: 'GPU Power' })).not.toBeInTheDocument()
  })

  it('writes the added panel, and a reload comes back to it', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(onePanel()) })
    await editPage(fetchMock)
    await addPanelOfType('GPU Power')
    await saveAndReload(fetchMock)

    screen.getByRole('region', { name: 'GPU Power' })
    expect(gridSubstitute.geometry().get('gpu-power')).toEqual({ x: 6, y: 0, w: 3, h: 3 })
  })
})
