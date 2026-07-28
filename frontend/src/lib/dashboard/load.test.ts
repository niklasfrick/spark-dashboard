import { describe, it, expect } from 'vitest'
import { loadDashboardConfiguration } from './load'
import { defaultDashboardDocument } from './preset'
import { DASHBOARD_SCHEMA_VERSION, serializeDashboardDocument } from './schema'
import type { MigrationPath } from './migrations'

/** A document the current build reads, as it would come back from the server. */
function storedDocument(): string {
  return serializeDashboardDocument({
    version: DASHBOARD_SCHEMA_VERSION,
    pages: [
      {
        id: 'mine',
        name: 'Mine',
        panels: [
          {
            id: 'a',
            type: 'gpu-power',
            title: 'Trainer',
            geometry: { x: 0, y: 0, w: 6, h: 4 },
            binding: { kind: 'gpu', index: 1 },
            window: '15m',
          },
        ],
      },
    ],
  })
}

describe('loadDashboardConfiguration with nothing stored', () => {
  it('renders the preset with no banner', () => {
    // Nothing is configured out of the box, and a fresh install is not a fault.
    const loaded = loadDashboardConfiguration(null)

    expect(loaded.document).toEqual(defaultDashboardDocument())
    expect(loaded.isDefault).toBe(true)
    expect(loaded.fallback).toBeNull()
    expect(loaded.migrated).toBe(false)
  })

  it('treats an absent body the same way', () => {
    expect(loadDashboardConfiguration(undefined).fallback).toBeNull()
  })
})

describe('loadDashboardConfiguration with a readable document', () => {
  it('renders what the operator saved', () => {
    const loaded = loadDashboardConfiguration(storedDocument())

    expect(loaded.isDefault).toBe(false)
    expect(loaded.fallback).toBeNull()
    expect(loaded.migrated).toBe(false)
    expect(loaded.document.pages[0].name).toBe('Mine')
    expect(loaded.document.pages[0].panels[0].title).toBe('Trainer')
    expect(loaded.document.pages[0].panels[0].binding).toEqual({ kind: 'gpu', index: 1 })
    expect(loaded.document.pages[0].panels[0].window).toBe('15m')
  })
})

describe('loadDashboardConfiguration with an unreadable document', () => {
  it('renders the preset and reports why, rather than a blank screen', () => {
    const loaded = loadDashboardConfiguration('{ "pages": [')

    expect(loaded.document).toEqual(defaultDashboardDocument())
    expect(loaded.isDefault).toBe(true)
    expect(loaded.fallback).toEqual({ kind: 'unreadable' })
  })

  it('reports valid JSON that is not a dashboard document', () => {
    expect(loadDashboardConfiguration('[]').fallback).toEqual({ kind: 'unreadable' })
    expect(loadDashboardConfiguration('"overview"').fallback).toEqual({ kind: 'unreadable' })
    expect(loadDashboardConfiguration('{"pages":[]}').fallback).toEqual({ kind: 'unreadable' })
  })

  it('renders the preset without a banner for a document with no pages', () => {
    // Nothing to render is the position a fresh install is in, and nothing
    // failed — so no banner claims the configuration could not be read.
    const loaded = loadDashboardConfiguration(
      JSON.stringify({ version: DASHBOARD_SCHEMA_VERSION, pages: [] }),
    )

    expect(loaded.document).toEqual(defaultDashboardDocument())
    expect(loaded.isDefault).toBe(true)
    expect(loaded.fallback).toBeNull()
  })

  it('reports a document with no version at all', () => {
    // Without the version field there is no way to tell which build wrote it,
    // which is exactly why the field ships from the first release.
    expect(loadDashboardConfiguration('{"pages":[{"id":"p","panels":[]}]}').fallback).toEqual({
      kind: 'unreadable',
    })
    expect(loadDashboardConfiguration('{"version":"1","pages":[]}').fallback).toEqual({
      kind: 'unreadable',
    })
  })

  it('reports a stored document that says nothing', () => {
    // A file that exists but is empty means a write went wrong. Writes are
    // atomic, so this should not happen — and if it does the operator is told.
    expect(loadDashboardConfiguration('').fallback).toEqual({ kind: 'unreadable' })
    expect(loadDashboardConfiguration('   \n').fallback).toEqual({ kind: 'unreadable' })
  })

  it('reports a document whose pages are unreadable', () => {
    const loaded = loadDashboardConfiguration(
      JSON.stringify({ version: DASHBOARD_SCHEMA_VERSION, pages: 'overview' }),
    )

    expect(loaded.fallback).toEqual({ kind: 'unreadable' })
    expect(loaded.isDefault).toBe(true)
  })
})

describe('loadDashboardConfiguration with a document from another version', () => {
  it('falls back with the versions named when the document is newer', () => {
    // Rolling the dashboard back has to be recoverable, and there is no
    // down-migration, so the preset renders and the banner explains it.
    const loaded = loadDashboardConfiguration(
      JSON.stringify({
        version: DASHBOARD_SCHEMA_VERSION + 1,
        pages: [{ id: 'p', name: 'P', panels: [] }],
      }),
    )

    expect(loaded.document).toEqual(defaultDashboardDocument())
    expect(loaded.isDefault).toBe(true)
    expect(loaded.fallback).toEqual({
      kind: 'newer-version',
      documentVersion: DASHBOARD_SCHEMA_VERSION + 1,
      supportedVersion: DASHBOARD_SCHEMA_VERSION,
    })
  })

  it('falls back when the document is too old to bring forward', () => {
    const loaded = loadDashboardConfiguration(
      JSON.stringify({ version: 0, pages: [{ id: 'p', name: 'P', panels: [] }] }),
    )

    expect(loaded.isDefault).toBe(true)
    expect(loaded.fallback).toEqual({
      kind: 'unsupported-version',
      documentVersion: 0,
      supportedVersion: DASHBOARD_SCHEMA_VERSION,
    })
  })

  it('never throws, whatever it is handed', () => {
    const inputs = ['', '{', 'null', 'true', '[1,2]', '{"version":-1}', '{"version":1e309}']
    for (const input of inputs) {
      expect(() => loadDashboardConfiguration(input), input).not.toThrow()
      expect(loadDashboardConfiguration(input).document.pages.length, input).toBeGreaterThan(0)
    }
  })
})

describe('loadDashboardConfiguration with a document that needed migrating', () => {
  /** A stand-in path from an imagined earlier version up to the current one. */
  const path: MigrationPath = {
    migrations: [
      {
        from: DASHBOARD_SCHEMA_VERSION - 1,
        migrate: (document) => ({
          ...document,
          pages: [{ id: 'brought-forward', name: 'Brought forward', panels: [] }],
        }),
      },
    ],
    target: DASHBOARD_SCHEMA_VERSION,
  }

  const stored = JSON.stringify({ version: DASHBOARD_SCHEMA_VERSION - 1, legacyPages: [] })

  it('renders the migrated document', () => {
    const loaded = loadDashboardConfiguration(stored, path)

    expect(loaded.isDefault).toBe(false)
    expect(loaded.fallback).toBeNull()
    expect(loaded.document.pages[0].id).toBe('brought-forward')
  })

  it('says it migrated, so the caller knows not to write it back', () => {
    // The configuration is shared by everyone on the instance. Writing back on
    // load would let one upgraded viewer lock out colleagues still on the
    // previous build merely by opening the page.
    expect(loadDashboardConfiguration(stored, path).migrated).toBe(true)
  })
})
