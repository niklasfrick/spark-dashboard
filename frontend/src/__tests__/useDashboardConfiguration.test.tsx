import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useDashboardConfiguration } from '../hooks/useDashboardConfiguration'
import type { MigrationPath } from '../lib/dashboard/migrations'
import { defaultDashboardDocument } from '../lib/dashboard/preset'
import { DASHBOARD_SCHEMA_VERSION, type DashboardDocument } from '../lib/dashboard/schema'
import {
  configurationWrites as writes,
  serveConfiguration,
  serveNothing,
} from '../test/configurationServer'

/** A stored document with one page, at the version this build reads. */
const stored = JSON.stringify({
  version: DASHBOARD_SCHEMA_VERSION,
  pages: [{ id: 'watch', name: 'Watch', panels: [] }],
})

/** Renders the hook and waits for the first response to resolve. */
async function loaded(path?: MigrationPath) {
  const view = renderHook(() => useDashboardConfiguration(path))
  await waitFor(() => expect(view.result.current.document).not.toBeNull())
  return view
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useDashboardConfiguration', () => {
  it('has no document until the server has answered', async () => {
    // The preset must not be rendered while the stored document is still in
    // flight, or an operator with a saved layout watches it flash past.
    serveConfiguration({ document: stored })

    const { result } = renderHook(() => useDashboardConfiguration())

    expect(result.current.document).toBeNull()

    // Settle the in-flight load so its state update lands inside the test.
    await waitFor(() => expect(result.current.document).not.toBeNull())
  })

  it('renders the preset with no notice when nothing is stored', async () => {
    serveConfiguration({ document: null })

    const { result } = await loaded()

    expect(result.current.document).toEqual(defaultDashboardDocument())
    expect(result.current.notices).toEqual([])
  })

  it('renders the stored document', async () => {
    serveConfiguration({ document: stored })

    const { result } = await loaded()

    expect(result.current.document?.pages.map((page) => page.name)).toEqual(['Watch'])
    expect(result.current.notices).toEqual([])
  })

  it('renders the preset and says so when the document cannot be read', async () => {
    serveConfiguration({ document: '{ this is not the document }' })

    const { result } = await loaded()

    expect(result.current.document).toEqual(defaultDashboardDocument())
    expect(result.current.notices).toEqual([{ kind: 'unreadable' }])
  })

  it('renders the preset and says so when the document is from a newer build', async () => {
    serveConfiguration({
      document: JSON.stringify({ version: DASHBOARD_SCHEMA_VERSION + 1, pages: [] }),
    })

    const { result } = await loaded()

    expect(result.current.document).toEqual(defaultDashboardDocument())
    expect(result.current.notices).toEqual([
      {
        kind: 'newer-version',
        documentVersion: DASHBOARD_SCHEMA_VERSION + 1,
        supportedVersion: DASHBOARD_SCHEMA_VERSION,
      },
    ])
  })

  it('renders the preset and says so when no migration reaches this build', async () => {
    serveConfiguration({ document: JSON.stringify({ version: 0, pages: [] }) })

    const { result } = await loaded()

    expect(result.current.document).toEqual(defaultDashboardDocument())
    expect(result.current.notices).toEqual([
      {
        kind: 'unsupported-version',
        documentVersion: 0,
        supportedVersion: DASHBOARD_SCHEMA_VERSION,
      },
    ])
  })

  it('renders the preset and says so when the server could not be asked', async () => {
    serveNothing()

    const { result } = await loaded()

    expect(result.current.document).toEqual(defaultDashboardDocument())
    expect(result.current.notices).toEqual([{ kind: 'unavailable' }])
  })

  it('renders the preset and says so when the server could not read the document', async () => {
    // Distinct from an unreachable server: there is a document, and something
    // on the machine is wrong with it rather than with the network.
    serveConfiguration({ getStatus: 500 })

    const { result } = await loaded()

    expect(result.current.document).toEqual(defaultDashboardDocument())
    expect(result.current.notices).toEqual([{ kind: 'unreadable' }])
  })

  it('reports read-only storage', async () => {
    serveConfiguration({ document: stored, readOnly: true })

    const { result } = await loaded()

    expect(result.current.readOnly).toBe(true)
    expect(result.current.notices).toEqual([{ kind: 'read-only' }])
  })

  it('makes no request when asked to save on a read-only instance', async () => {
    const fetchMock = serveConfiguration({ document: stored, readOnly: true })
    const { result } = await loaded()

    let outcome = ''
    await act(async () => {
      outcome = await result.current.save(defaultDashboardDocument())
    })

    expect(outcome).toBe('read-only')
    expect(writes(fetchMock)).toEqual([])
  })

  it('writes the document on a save the operator asked for', async () => {
    const fetchMock = serveConfiguration({ document: null })
    const { result } = await loaded()
    const edited: DashboardDocument = {
      version: DASHBOARD_SCHEMA_VERSION,
      pages: [{ id: 'wall', name: 'Wall', panels: [] }],
    }

    await act(async () => {
      await result.current.save(edited)
    })

    expect(writes(fetchMock)).toHaveLength(1)
    expect(JSON.parse(writes(fetchMock)[0])).toEqual(edited)
    expect(result.current.document).toEqual(edited)
  })

  it('never autosaves — loading issues no write of any kind', async () => {
    const fetchMock = serveConfiguration({ document: stored })

    await loaded()

    expect(writes(fetchMock)).toEqual([])
  })

  it('migrates in memory and persists only on the next save', async () => {
    // A viewer who merely upgraded and opened the page must not rewrite a
    // document shared with colleagues still on the previous build.
    const path: MigrationPath = {
      target: DASHBOARD_SCHEMA_VERSION,
      migrations: [
        {
          from: DASHBOARD_SCHEMA_VERSION - 1,
          migrate: (document) => ({ pages: document.sheets }),
        },
      ],
    }
    const fetchMock = serveConfiguration({
      document: JSON.stringify({
        version: DASHBOARD_SCHEMA_VERSION - 1,
        sheets: [{ id: 'old', name: 'Old', panels: [] }],
      }),
    })

    const { result } = await loaded(path)

    expect(result.current.document?.pages.map((page) => page.name)).toEqual(['Old'])
    expect(result.current.notices).toEqual([])
    expect(writes(fetchMock)).toEqual([])

    await act(async () => {
      await result.current.save(result.current.document as DashboardDocument)
    })

    expect(JSON.parse(writes(fetchMock)[0])).toEqual({
      version: DASHBOARD_SCHEMA_VERSION,
      pages: [{ id: 'old', name: 'Old', panels: [] }],
    })
  })

  it('clears the fallback notice once the operator has saved over it', async () => {
    // The banner describes the stored document. Saving replaced it, so leaving
    // the banner up would report a problem that no longer exists.
    serveConfiguration({ document: '{ this is not the document }' })
    const { result } = await loaded()

    await act(async () => {
      await result.current.save(defaultDashboardDocument())
    })

    expect(result.current.notices).toEqual([])
  })

  it('says so when a save failed', async () => {
    serveConfiguration({ document: null, putStatus: 500 })
    const { result } = await loaded()

    let outcome = ''
    await act(async () => {
      outcome = await result.current.save(defaultDashboardDocument())
    })

    expect(outcome).toBe('failed')
    expect(result.current.notices).toEqual([{ kind: 'save-failed' }])
  })

  it('says so when the document is too large to store', async () => {
    serveConfiguration({ document: null, putStatus: 413 })
    const { result } = await loaded()

    await act(async () => {
      await result.current.save(defaultDashboardDocument())
    })

    expect(result.current.notices).toEqual([{ kind: 'too-large' }])
  })

  it('turns read-only when a save is refused by storage that was writable', async () => {
    // The directory lost its write permission after startup. The next save is
    // the first thing that can notice.
    serveConfiguration({ document: null, putStatus: 503 })
    const { result } = await loaded()

    expect(result.current.readOnly).toBe(false)

    await act(async () => {
      await result.current.save(defaultDashboardDocument())
    })

    expect(result.current.readOnly).toBe(true)
    expect(result.current.notices).toEqual([{ kind: 'read-only' }])
  })

  it('keeps no copy of the configuration in browser-local storage', async () => {
    // Not on load and not on save. The document is shared by everyone who opens
    // the instance, so a per-browser copy would be a source of truth nobody can
    // see — which is exactly what makes it worse than a visible failure.
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    serveConfiguration({ document: stored })
    const { result } = await loaded()

    await act(async () => {
      await result.current.save(defaultDashboardDocument())
    })

    expect(setItem).not.toHaveBeenCalled()
    setItem.mockRestore()
  })

  it('does not adopt a document the server refused to store', async () => {
    // What this reports is what is stored. The refused edit stays with the
    // session that made it, which is what lets the operator retry the save
    // rather than discover later that only the browser believed it landed.
    serveConfiguration({ document: null, putStatus: 500 })
    const { result } = await loaded()
    const edited: DashboardDocument = {
      version: DASHBOARD_SCHEMA_VERSION,
      pages: [{ id: 'wall', name: 'Wall', panels: [] }],
    }

    await act(async () => {
      await result.current.save(edited)
    })

    expect(result.current.document).toEqual(defaultDashboardDocument())
  })
})
