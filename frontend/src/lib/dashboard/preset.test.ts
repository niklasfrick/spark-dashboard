import { describe, it, expect } from 'vitest'
import { defaultDashboardDocument } from './preset'
import { GRID_COLUMNS, GRID_MAX_ROWS, isOutOfRoom } from './grid'
import { isKnownPanelType } from './panels'
import { DASHBOARD_SCHEMA_VERSION, parseDashboardDocument, serializeDashboardDocument } from './schema'

describe('the default preset', () => {
  it('parses as a document of the current version', () => {
    const preset = defaultDashboardDocument()

    expect(preset.version).toBe(DASHBOARD_SCHEMA_VERSION)
    expect(parseDashboardDocument(JSON.parse(serializeDashboardDocument(preset)))).toEqual(preset)
  })

  it('has at least one page, each with a name and panels', () => {
    const preset = defaultDashboardDocument()

    expect(preset.pages.length).toBeGreaterThan(0)
    for (const page of preset.pages) {
      expect(page.id).toBeTruthy()
      expect(page.name).toBeTruthy()
      expect(page.panels.length).toBeGreaterThan(0)
    }
  })

  it('contains no concrete bindings', () => {
    // This is what makes one static document correct on a one-GPU laptop and on
    // a four-GPU server: nothing in it names a GPU index or an endpoint, so
    // there is nothing to be wrong about the host it lands on.
    for (const page of defaultDashboardDocument().pages) {
      for (const panel of page.panels) {
        expect(panel.binding, panel.id).toEqual({ kind: 'follow' })
      }
    }
  })

  it('only uses panel types this build implements', () => {
    for (const page of defaultDashboardDocument().pages) {
      for (const panel of page.panels) {
        expect(isKnownPanelType(panel.type), panel.type).toBe(true)
      }
    }
  })

  it('gives every panel on a page a distinct identifier', () => {
    for (const page of defaultDashboardDocument().pages) {
      const ids = page.panels.map((panel) => panel.id)
      expect(new Set(ids).size, page.id).toBe(ids.length)
    }
  })

  it('tiles each page exactly, with no overlap and no empty cells', () => {
    // The dashboard's defining property is that the desktop layout fits the
    // viewport. A preset that covers every cell exactly once both fills the
    // screen and proves no two panels were placed on top of each other.
    const cells = GRID_COLUMNS * GRID_MAX_ROWS

    for (const page of defaultDashboardDocument().pages) {
      const geometries = page.panels.map((panel) => panel.geometry)
      const covered = geometries.reduce((sum, { w, h }) => sum + w * h, 0)

      expect(covered, page.id).toBe(cells)
      expect(isOutOfRoom(geometries, { w: 1, h: 1 }), page.id).toBe(true)
    }
  })

  it('stays inside the grid', () => {
    for (const page of defaultDashboardDocument().pages) {
      for (const { x, y, w, h } of page.panels.map((panel) => panel.geometry)) {
        expect(x + w, page.id).toBeLessThanOrEqual(GRID_COLUMNS)
        expect(y + h, page.id).toBeLessThanOrEqual(GRID_MAX_ROWS)
      }
    }
  })

  it('hands out a fresh document each time', () => {
    // Edit mode works on the preset when nothing is saved, so a shared instance
    // would let one session's dragging leak into the next reset.
    const first = defaultDashboardDocument()
    first.pages[0].panels[0].title = 'Edited'
    first.pages[0].panels[0].binding = { kind: 'gpu', index: 3 }

    const second = defaultDashboardDocument()
    expect(second.pages[0].panels[0].title).toBeUndefined()
    expect(second.pages[0].panels[0].binding).toEqual({ kind: 'follow' })
  })
})
