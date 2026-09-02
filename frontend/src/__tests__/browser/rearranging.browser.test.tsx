import { describe, expect, it } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { GridPageEditor } from '@/components/grid/GridPageEditor'
import { useDashboardConfiguration } from '@/hooks/useDashboardConfiguration'
import { MetricsStoreProvider } from '@/hooks/MetricsStoreProvider'
import { withPagePanels } from '@/lib/dashboard/editing'
import { DASHBOARD_SCHEMA_VERSION } from '@/lib/dashboard/schema'
import {
  configurationWrites,
  serveConfiguration,
  type FetchMock,
} from '@/test/configurationServer'
import { dragPanelBy, measuredPanel, panelGeometry, resizePanelBy } from '@/test/gridEngine'

// What a real drag is worth: the geometry it leaves on disk (#87).
//
// This is the spec the whole browser project exists for. Everywhere else the
// grid library is the jsdom substitute, and a spec tells it a panel moved — so
// the chain from "the operator dragged something" to "these bytes were stored"
// is asserted from its second link onward, and a library upgrade that stopped
// dragging altogether would break nothing. The library's React wrapper is very
// new and declares no React peer dependency, so nothing warns either.
//
// Here a mouse drags a panel across a real layout engine and the assertion is
// on the PUT body and on what a reload comes back to. **Mouse events, not
// pointer events** — see `test/gridEngine.ts`, which owns that gotcha.
//
// The configuration goes over the real client, against the same stub server the
// jsdom specs use: it holds what it was given, so a reload here is a real round
// trip rather than a spec handing itself the answer.
//
// Deliberately three cases, because the project they run in costs CI a browser
// download:
//
//   - a drag, saved and reloaded
//   - a resize, saved and reloaded
//   - a narrowed window, which must never write the column it derives
//
// Two of #87's criteria were already met by the time it was written. The row
// cap refusing a drop is `editMode.browser.test.tsx`'s, from #83, and is not
// restated. The collapse and restore of an authored layout is
// `gridPage.browser.test.tsx`'s, from #79 — the third case here crosses that
// ground again on its way to the thing only a saveable page can be asked: that
// the column it derives is never the one that gets written.
//
// Panel types are covered through the application seam in the jsdom suite —
// there are no per-panel browser tests, and there should not be.

function storedDocument(panels: unknown[]): string {
  return JSON.stringify({
    version: DASHBOARD_SCHEMA_VERSION,
    pages: [{ id: 'watch', name: 'Watch', panels }],
  })
}

/** Two panels side by side, filling the top half of the page. */
function sideBySide(): unknown[] {
  return [
    { id: 'cpu', type: 'cpu-utilization', geometry: { x: 0, y: 0, w: 6, h: 4 } },
    { id: 'mem', type: 'memory', geometry: { x: 6, y: 0, w: 6, h: 4 } },
  ]
}

/**
 * The dashboard as the application wires it: the configuration hook over the
 * real client, and the editor saving the page back into the whole document.
 *
 * Not `App` itself, for the reason every spec in this directory renders a
 * component instead: the browser project runs no Tailwind build, so the classes
 * that give the app its height do nothing, and a grid told to fill an auto-height
 * parent halves its own row height on every measurement until it vanishes. The
 * box below is what Tailwind would have given it. Everything under that box is
 * the real thing.
 */
function Dashboard({ width = 1024 }: { width?: number }) {
  const { document: stored, readOnly, save } = useDashboardConfiguration()
  const page = stored?.pages[0]

  return (
    <MetricsStoreProvider>
      <div style={{ width, height: 640 }}>
        {stored && page && (
          <GridPageEditor
            page={page}
            readOnly={readOnly}
            onSave={(panels) => save(withPagePanels(stored, page.id, panels))}
          />
        )}
      </div>
    </MetricsStoreProvider>
  )
}

const editLayout = () => screen.getByRole('button', { name: 'Edit layout' })
const saveLayout = () => screen.getByRole('button', { name: 'Save layout' })

/** Renders the dashboard and waits for the stored page to have been laid out. */
async function openDashboard(panelCount: number, width?: number): Promise<HTMLElement> {
  const { container } = render(<Dashboard width={width} />)
  await waitFor(() =>
    expect(container.querySelectorAll('.grid-stack-item')).toHaveLength(panelCount),
  )
  return container
}

/** The geometry each panel of the one page has, in the write already waited for. */
function savedGeometry(fetchMock: FetchMock): Map<string, unknown> {
  const [written] = configurationWrites(fetchMock)
  const panels = JSON.parse(written).pages[0].panels as Array<Record<string, unknown>>
  return new Map(panels.map((panel) => [String(panel.id), panel.geometry]))
}

describe('a panel dragged across a real grid', () => {
  it('is stored where it was dropped, and a reload comes back to it', async () => {
    const fetchMock = serveConfiguration({ document: storedDocument(sideBySide()) })
    const container = await openDashboard(2)

    act(() => editLayout().click())

    // Straight down by its own height: the four rows that take it from the top
    // half of the page to the bottom one.
    const item = await measuredPanel(container, 'mem')
    act(() => dragPanelBy(item, 0, item.offsetHeight))

    await waitFor(() => {
      expect(panelGeometry(container).get('mem')).toEqual({ x: 6, y: 4, w: 6, h: 4 })
    })

    await userEvent.click(saveLayout())

    await waitFor(() => expect(configurationWrites(fetchMock)).toHaveLength(1))
    // The panel that was dragged, and the one that was not.
    const saved = savedGeometry(fetchMock)
    expect(saved.get('mem')).toEqual({ x: 6, y: 4, w: 6, h: 4 })
    expect(saved.get('cpu')).toEqual({ x: 0, y: 0, w: 6, h: 4 })

    // And the page still looks like what was stored: ending the session takes
    // the row cap off the engine, which must not be an occasion to compact the
    // arrangement that was just saved.
    expect(panelGeometry(container).get('mem')).toEqual({ x: 6, y: 4, w: 6, h: 4 })

    // A reload against the same server, which is now answering with the bytes
    // it took: the arrangement survives the round trip it was saved for.
    cleanup()
    const reloaded = await openDashboard(2)
    expect(panelGeometry(reloaded).get('mem')).toEqual({ x: 6, y: 4, w: 6, h: 4 })
  })
})

describe('a panel resized on a real grid', () => {
  it('is stored at the size it was pulled to, and a reload comes back to it', async () => {
    // One panel, so the resize has room to grow into rather than a neighbour to
    // push around: what is being asserted is the gesture, not the reflow.
    const fetchMock = serveConfiguration({
      document: storedDocument([
        { id: 'cpu', type: 'cpu-utilization', geometry: { x: 0, y: 0, w: 6, h: 4 } },
      ]),
    })
    const container = await openDashboard(1)

    act(() => editLayout().click())

    // One column wider and one row taller, in the panel's own units.
    const item = await measuredPanel(container, 'cpu')
    act(() => resizePanelBy(item, item.offsetWidth / 6, item.offsetHeight / 4))

    await waitFor(() => {
      expect(panelGeometry(container).get('cpu')).toEqual({ x: 0, y: 0, w: 7, h: 5 })
    })

    await userEvent.click(saveLayout())

    await waitFor(() => expect(configurationWrites(fetchMock)).toHaveLength(1))
    expect(savedGeometry(fetchMock).get('cpu')).toEqual({ x: 0, y: 0, w: 7, h: 5 })

    cleanup()
    const reloaded = await openDashboard(1)
    expect(panelGeometry(reloaded).get('cpu')).toEqual({ x: 0, y: 0, w: 7, h: 5 })
  })
})

describe('a window narrow enough to stack the page', () => {
  it('never writes the column it derived, and gives the saved layout back on the way out', async () => {
    // The hazard this guards is silent and permanent: the single column is
    // derived from the authored layout, and a save that caught it would replace
    // every colleague's desktop arrangement with one phone's. jsdom cannot get
    // near it — the collapse runs on measured width, which there is always 0.
    const fetchMock = serveConfiguration({ document: storedDocument(sideBySide()) })
    const { container, rerender } = render(<Dashboard />)
    await waitFor(() => expect(container.querySelectorAll('.grid-stack-item')).toHaveLength(2))

    act(() => editLayout().click())
    const item = await measuredPanel(container, 'mem')
    act(() => dragPanelBy(item, 0, item.offsetHeight))
    await waitFor(() => {
      expect(panelGeometry(container).get('mem')).toEqual({ x: 6, y: 4, w: 6, h: 4 })
    })
    await userEvent.click(saveLayout())
    await waitFor(() => expect(configurationWrites(fetchMock)).toHaveLength(1))

    // A phone-width window: one column, every panel across it.
    rerender(<Dashboard width={360} />)
    await waitFor(() => {
      const stacked = panelGeometry(container)
      expect(stacked.get('cpu')).toMatchObject({ x: 0, w: 1 })
      expect(stacked.get('mem')).toMatchObject({ x: 0, w: 1 })
    })

    // Wide again: the layout that was saved, not the column that was displayed.
    rerender(<Dashboard width={1024} />)
    await waitFor(() => {
      expect(panelGeometry(container).get('mem')).toEqual({ x: 6, y: 4, w: 6, h: 4 })
    })
    expect(panelGeometry(container).get('cpu')).toEqual({ x: 0, y: 0, w: 6, h: 4 })

    // And the stack was never stored: still the one write, from the drag.
    expect(configurationWrites(fetchMock)).toHaveLength(1)
  })
})
