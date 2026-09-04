import { describe, it, expect } from 'vitest'
import {
  DASHBOARD_SCHEMA_VERSION,
  DEFAULT_TIME_WINDOW,
  panelTitle,
  parseDashboardDocument,
  serializeDashboardDocument,
} from './schema'
import { FOLLOW } from './bindings'

/** A minimal well-formed raw document, as it would sit on disk. */
function rawDocument(overrides: Record<string, unknown> = {}) {
  return {
    version: DASHBOARD_SCHEMA_VERSION,
    pages: [
      {
        id: 'overview',
        name: 'Overview',
        panels: [
          {
            id: 'util',
            type: 'gpu-utilization',
            geometry: { x: 0, y: 0, w: 3, h: 2 },
            binding: { kind: 'follow' },
            window: '5m',
          },
        ],
      },
    ],
    ...overrides,
  }
}

describe('parseDashboardDocument', () => {
  it('yields typed pages and panels', () => {
    const document = parseDashboardDocument(rawDocument())

    expect(document).not.toBeNull()
    expect(document!.version).toBe(DASHBOARD_SCHEMA_VERSION)
    expect(document!.pages).toHaveLength(1)

    const page = document!.pages[0]
    expect(page.id).toBe('overview')
    expect(page.name).toBe('Overview')
    expect(page.panels).toEqual([
      {
        id: 'util',
        type: 'gpu-utilization',
        geometry: { x: 0, y: 0, w: 3, h: 2 },
        binding: FOLLOW,
        window: '5m',
      },
    ])
  })

  it('keeps a pinned binding and a per-panel window', () => {
    const document = parseDashboardDocument(
      rawDocument({
        pages: [
          {
            id: 'compare',
            name: 'Compare',
            panels: [
              {
                id: 'a',
                type: 'gpu-power',
                geometry: { x: 0, y: 0, w: 6, h: 4 },
                binding: { kind: 'gpu', index: 1 },
                window: '15m',
              },
              {
                id: 'b',
                type: 'engine-latency',
                geometry: { x: 6, y: 0, w: 6, h: 4 },
                binding: { kind: 'engine', endpoint: 'http://localhost:8000' },
                window: '10m',
              },
            ],
          },
        ],
      }),
    )

    expect(document!.pages[0].panels[0].binding).toEqual({ kind: 'gpu', index: 1 })
    expect(document!.pages[0].panels[0].window).toBe('15m')
    expect(document!.pages[0].panels[1].binding).toEqual({
      kind: 'engine',
      endpoint: 'http://localhost:8000',
    })
    expect(document!.pages[0].panels[1].window).toBe('10m')
  })

  it('keeps a panel type this build does not implement', () => {
    // Dropping it would silently reflow an arrangement the operator authored.
    // The panel keeps its slot; rendering it is the placeholder's problem.
    const document = parseDashboardDocument(
      rawDocument({
        pages: [
          {
            id: 'p',
            name: 'P',
            panels: [{ id: 'x', type: 'gpu-voltage', geometry: { x: 0, y: 0, w: 1, h: 1 } }],
          },
        ],
      }),
    )

    expect(document!.pages[0].panels[0].type).toBe('gpu-voltage')
  })

  it('resolves a sparse geometry to single cells', () => {
    // The grid serializer omits values equal to its defaults, so a 1x1 panel
    // arrives with no width or height at all.
    const document = parseDashboardDocument(
      rawDocument({
        pages: [
          {
            id: 'p',
            name: 'P',
            panels: [{ id: 'x', type: 'memory', geometry: { x: 4, y: 3 } }],
          },
        ],
      }),
    )

    expect(document!.pages[0].panels[0].geometry).toEqual({ x: 4, y: 3, w: 1, h: 1 })
  })

  it('defaults an absent binding and window', () => {
    const document = parseDashboardDocument(
      rawDocument({
        pages: [
          {
            id: 'p',
            name: 'P',
            panels: [{ id: 'x', type: 'gpu-temperature', geometry: { x: 0, y: 0, w: 2, h: 2 } }],
          },
        ],
      }),
    )

    expect(document!.pages[0].panels[0].binding).toEqual(FOLLOW)
    expect(document!.pages[0].panels[0].window).toBe(DEFAULT_TIME_WINDOW)
  })

  it('falls back to the default window for one it does not recognize', () => {
    const document = parseDashboardDocument(
      rawDocument({
        pages: [
          {
            id: 'p',
            name: 'P',
            panels: [
              { id: 'x', type: 'memory', geometry: { x: 0, y: 0, w: 1, h: 1 }, window: '4h' },
            ],
          },
        ],
      }),
    )

    expect(document!.pages[0].panels[0].window).toBe(DEFAULT_TIME_WINDOW)
  })

  it('names a page and its panels when the identifiers are missing', () => {
    // Identifiers key the grid and the page URLs, so one has to exist; deriving
    // it from position keeps every panel the operator arranged.
    const document = parseDashboardDocument(
      rawDocument({
        pages: [{ panels: [{ type: 'memory' }, { type: 'disk-io' }] }],
      }),
    )

    expect(document!.pages[0].id).toBe('page-1')
    expect(document!.pages[0].name).toBe('Page 1')
    expect(document!.pages[0].panels.map((panel) => panel.id)).toEqual(['panel-1', 'panel-2'])
  })

  it('makes duplicated identifiers unique instead of losing a panel', () => {
    const document = parseDashboardDocument(
      rawDocument({
        pages: [
          { id: 'dup', name: 'One', panels: [{ id: 'same', type: 'memory' }] },
          { id: 'dup', name: 'Two', panels: [{ id: 'same', type: 'memory' }, { id: 'same', type: 'disk-io' }] },
        ],
      }),
    )

    expect(document!.pages.map((page) => page.id)).toEqual(['dup', 'dup-2'])
    expect(document!.pages[1].panels.map((panel) => panel.id)).toEqual(['same', 'same-2'])
  })

  it('keeps an operator-authored panel title and drops a blank one', () => {
    const document = parseDashboardDocument(
      rawDocument({
        pages: [
          {
            id: 'p',
            name: 'P',
            panels: [
              { id: 'a', type: 'memory', title: '  Host RAM  ' },
              { id: 'b', type: 'disk-io', title: '   ' },
            ],
          },
        ],
      }),
    )

    expect(document!.pages[0].panels[0].title).toBe('Host RAM')
    expect(document!.pages[0].panels[1].title).toBeUndefined()
  })

  it('keeps a page source naming an engine or all models', () => {
    const document = parseDashboardDocument(
      rawDocument({
        pages: [
          { id: 'qwen', name: 'Qwen', source: { kind: 'engine', endpoint: 'http://localhost:8000' }, panels: [] },
          { id: 'global', name: 'Global', source: { kind: 'all' }, panels: [] },
        ],
      }),
    )

    expect(document!.pages[0].source).toEqual({ kind: 'engine', endpoint: 'http://localhost:8000' })
    expect(document!.pages[1].source).toEqual({ kind: 'all' })
  })

  it('reads an absent or unreadable page source as automatic', () => {
    // Automatic is the state every page began in, and no panel label promises
    // the lost target — a following panel names whatever it resolves to.
    const document = parseDashboardDocument(
      rawDocument({
        pages: [
          { id: 'a', name: 'A', panels: [] },
          { id: 'b', name: 'B', source: { kind: 'engine' }, panels: [] },
          { id: 'c', name: 'C', source: 'all', panels: [] },
          { id: 'd', name: 'D', source: { kind: 'everything' }, panels: [] },
        ],
      }),
    )

    for (const page of document!.pages) {
      expect(page.source).toBeUndefined()
    }
  })

  it('drops a panel that is not an object at all', () => {
    const document = parseDashboardDocument(
      rawDocument({
        pages: [{ id: 'p', name: 'P', panels: ['gpu-utilization', null, { id: 'a', type: 'memory' }] }],
      }),
    )

    expect(document!.pages[0].panels.map((panel) => panel.type)).toEqual(['memory'])
  })

  it('accepts a page with no panels', () => {
    // An operator can empty a page while rearranging; that is not corruption.
    const document = parseDashboardDocument(
      rawDocument({ pages: [{ id: 'p', name: 'P', panels: [] }] }),
    )

    expect(document!.pages[0].panels).toEqual([])
  })

  it('accepts a document with no pages', () => {
    // Deleting the last page is something an operator can do, so it must not be
    // reported as a configuration that cannot be read.
    expect(parseDashboardDocument(rawDocument({ pages: [] }))?.pages).toEqual([])
  })

  it('rejects a document that is not a document', () => {
    expect(parseDashboardDocument(null)).toBeNull()
    expect(parseDashboardDocument(undefined)).toBeNull()
    expect(parseDashboardDocument('{}')).toBeNull()
    expect(parseDashboardDocument(42)).toBeNull()
    expect(parseDashboardDocument([])).toBeNull()
    expect(parseDashboardDocument({})).toBeNull()
  })

  it('rejects a document whose pages could not be read', () => {
    // Distinct from an empty list: entries were stored here and none of them
    // survived, which is corruption the operator has to be told about rather
    // than a configuration they emptied themselves.
    expect(parseDashboardDocument(rawDocument({ pages: 'overview' }))).toBeNull()
    expect(parseDashboardDocument(rawDocument({ pages: [7, null] }))).toBeNull()
  })

  it('rejects a version other than the one this build reads', () => {
    // Choosing a fallback is the loader's job, which knows whether the document
    // is from the future or merely unmigrated.
    expect(parseDashboardDocument(rawDocument({ version: DASHBOARD_SCHEMA_VERSION + 1 }))).toBeNull()
    expect(parseDashboardDocument(rawDocument({ version: undefined }))).toBeNull()
    expect(parseDashboardDocument(rawDocument({ version: '1' }))).toBeNull()
  })
})

describe('serializeDashboardDocument', () => {
  it('round-trips a document unchanged', () => {
    const document = parseDashboardDocument(rawDocument())!
    expect(parseDashboardDocument(JSON.parse(serializeDashboardDocument(document)))).toEqual(document)
  })

  it('round-trips a document that arrived sparse', () => {
    const sparse = rawDocument({
      pages: [{ id: 'p', name: 'P', panels: [{ id: 'x', type: 'memory', geometry: { x: 2, y: 1 } }] }],
    })
    const once = parseDashboardDocument(sparse)!
    const twice = parseDashboardDocument(JSON.parse(serializeDashboardDocument(once)))!

    expect(twice).toEqual(once)
    expect(twice.pages[0].panels[0].geometry).toEqual({ x: 2, y: 1, w: 1, h: 1 })
  })

  it('writes geometry in full so what lands on disk is never sparse', () => {
    // Reading tolerates sparse geometry because the grid library hands it to us
    // that way; writing is dense so a future migration reading the file has
    // every value in front of it rather than having to know the defaults.
    const document = parseDashboardDocument(
      rawDocument({
        pages: [{ id: 'p', name: 'P', panels: [{ id: 'x', type: 'memory', geometry: { x: 2, y: 1 } }] }],
      }),
    )!
    const written = JSON.parse(serializeDashboardDocument(document))

    expect(written.pages[0].panels[0].geometry).toEqual({ x: 2, y: 1, w: 1, h: 1 })
  })

  it('stamps the schema version it wrote', () => {
    const document = parseDashboardDocument(rawDocument())!
    expect(JSON.parse(serializeDashboardDocument(document)).version).toBe(DASHBOARD_SCHEMA_VERSION)
  })

  it('omits a title the operator never set', () => {
    const document = parseDashboardDocument(rawDocument())!
    expect(JSON.parse(serializeDashboardDocument(document)).pages[0].panels[0]).not.toHaveProperty(
      'title',
    )
  })

  it('round-trips a page source and omits one that was never set', () => {
    const document = parseDashboardDocument(
      rawDocument({
        pages: [
          { id: 'auto', name: 'Auto', panels: [] },
          { id: 'global', name: 'Global', source: { kind: 'all' }, panels: [] },
          { id: 'qwen', name: 'Qwen', source: { kind: 'engine', endpoint: 'http://localhost:8000' }, panels: [] },
        ],
      }),
    )!
    const written = JSON.parse(serializeDashboardDocument(document))

    expect(written.pages[0]).not.toHaveProperty('source')
    expect(written.pages[1].source).toEqual({ kind: 'all' })
    expect(written.pages[2].source).toEqual({ kind: 'engine', endpoint: 'http://localhost:8000' })
    expect(parseDashboardDocument(written)).toEqual(document)
  })
})

describe('panelTitle', () => {
  it('prefers the operator-authored title', () => {
    expect(panelTitle({ type: 'gpu-utilization', title: 'Trainer GPU' })).toBe('Trainer GPU')
  })

  it('falls back to the panel type default', () => {
    expect(panelTitle({ type: 'gpu-utilization' })).toBe('GPU Utilization')
  })
})
