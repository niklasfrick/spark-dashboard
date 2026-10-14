import { describe, it, expect } from 'vitest'
import { GRID_COLUMNS, GRID_MAX_ROWS, isOutOfRoom } from './grid'
import { isKnownPanelType, panelBindingKind } from './panels'
import {
  DASHBOARD_SCHEMA_VERSION,
  parseDashboardDocument,
  serializeDashboardDocument,
  type DashboardDocument,
  type DashboardPanel,
} from './schema'
import { LEGACY_LAYOUT, STARTING_LAYOUTS } from './startingLayouts'

/**
 * The panels the way the eye crosses them — and the way a phone stacks them,
 * since the single-column layout is derived from this same order.
 */
function readingOrder(panels: readonly DashboardPanel[]): DashboardPanel[] {
  return [...panels].sort((a, b) => a.geometry.y - b.geometry.y || a.geometry.x - b.geometry.x)
}

describe('the starting layouts', () => {
  it('offer Legacy, and only Legacy so far', () => {
    expect(STARTING_LAYOUTS.map((layout) => layout.name)).toEqual(['Legacy'])
  })

  for (const layout of STARTING_LAYOUTS) {
    describe(layout.name, () => {
      it('parses as a page of a current-version document', () => {
        const document: DashboardDocument = {
          version: DASHBOARD_SCHEMA_VERSION,
          pages: [{ id: 'page', name: layout.name, panels: layout.panels() }],
        }

        expect(parseDashboardDocument(JSON.parse(serializeDashboardDocument(document)))).toEqual(
          document,
        )
      })

      it('contains no concrete bindings', () => {
        // Same reason as the preset: a page made on a one-GPU laptop and one
        // made on a four-GPU server are the same page, because nothing in it
        // names a GPU index or an endpoint.
        for (const panel of layout.panels()) {
          expect(panel.binding, panel.id).toEqual({ kind: 'follow' })
        }
      })

      it('only uses panel types this build implements', () => {
        for (const panel of layout.panels()) {
          expect(isKnownPanelType(panel.type), panel.type).toBe(true)
        }
      })

      it('places no log panel', () => {
        // The log viewer is off by default, so a log panel here would open the
        // new page on a notice that a feature is unavailable.
        for (const panel of layout.panels()) {
          expect(panel.type, panel.id).not.toBe('logs')
        }
      })

      it('keeps each band together in the order a phone stacks them', () => {
        const kinds = readingOrder(layout.panels()).map((panel) => panelBindingKind(panel.type))
        const runs = kinds.filter((kind, index) => kind !== kinds[index - 1])

        expect(runs).toEqual([...new Set(runs)])
      })

      it('gives every panel a distinct identifier', () => {
        const ids = layout.panels().map((panel) => panel.id)
        expect(new Set(ids).size).toBe(ids.length)
      })

      it('tiles the grid exactly, with no overlap and no empty cells', () => {
        // A new page from a starting layout fits the viewport like the preset
        // does: covering every cell once both fills the screen and proves no
        // two panels were placed on top of each other.
        const geometries = layout.panels().map((panel) => panel.geometry)
        const covered = geometries.reduce((sum, { w, h }) => sum + w * h, 0)

        expect(covered).toBe(GRID_COLUMNS * GRID_MAX_ROWS)
        expect(isOutOfRoom(geometries, { w: 1, h: 1 })).toBe(true)
      })

      it('stays inside the grid', () => {
        for (const { x, y, w, h } of layout.panels().map((panel) => panel.geometry)) {
          expect(x + w).toBeLessThanOrEqual(GRID_COLUMNS)
          expect(y + h).toBeLessThanOrEqual(GRID_MAX_ROWS)
        }
      })

      it('hands out fresh panels each time', () => {
        // Two pages made from one layout are two pages: editing the first must
        // not reach the second.
        const first = layout.panels()
        first[0].title = 'Edited'
        first[0].geometry.w = 1

        const second = layout.panels()
        expect(second[0].title).toBeUndefined()
        expect(second[0].geometry.w).not.toBe(1)
      })
    })
  }
})

describe('the Legacy layout', () => {
  it('reads in the old fixed dashboard’s order', () => {
    // Engine identity across the top; the engine cards left to right, with
    // cache and speculative decoding in the one card's position they shared;
    // the GPU row; the host row, with the old CPU card's core heatmap beside it.
    expect(readingOrder(LEGACY_LAYOUT.panels()).map((panel) => panel.type)).toEqual([
      'engine-status',
      'engine-prefill-throughput',
      'engine-decode-throughput',
      'engine-latency',
      'engine-slo-goodput',
      'engine-requests',
      'engine-cache',
      'engine-spec-decode',
      'gpu-utilization',
      'gpu-temperature',
      'gpu-power',
      'gpu-clock',
      'cpu-utilization',
      'cpu-cores',
      'memory',
      'disk-io',
      'network-io',
    ])
  })

  it('puts the engine’s identity across the whole width, above everything it describes', () => {
    const [first] = readingOrder(LEGACY_LAYOUT.panels())

    expect(first.type).toBe('engine-status')
    expect(first.geometry).toEqual({ x: 0, y: 0, w: GRID_COLUMNS, h: 1 })
  })

  it('stacks cache and speculative decoding in one column, where their shared card was', () => {
    const panels = LEGACY_LAYOUT.panels()
    const cache = panels.find((panel) => panel.type === 'engine-cache')
    const specDecode = panels.find((panel) => panel.type === 'engine-spec-decode')

    expect(specDecode?.geometry.x).toBe(cache?.geometry.x)
    expect(specDecode?.geometry.w).toBe(cache?.geometry.w)
    expect(specDecode?.geometry.y).toBe((cache?.geometry.y ?? 0) + (cache?.geometry.h ?? 0))
  })
})
