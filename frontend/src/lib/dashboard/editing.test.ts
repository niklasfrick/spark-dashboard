import { describe, expect, it } from 'vitest'
import { FOLLOW } from './bindings'
import { applyLayoutChanges, judgeDrop, requestedCells, withPagePanels } from './editing'
import { GRID_COLUMNS, GRID_MAX_ROWS, type PanelGeometry } from './grid'
import { DEFAULT_TIME_WINDOW, type DashboardDocument, type DashboardPanel } from './schema'

function panel(id: string, geometry: PanelGeometry): DashboardPanel {
  return { id, type: 'memory', geometry, binding: FOLLOW, window: DEFAULT_TIME_WINDOW }
}

const at = (x: number, y: number, w: number, h: number): PanelGeometry => ({ x, y, w, h })

describe('applying a layout change', () => {
  it('moves the panel the change names and leaves the others alone', () => {
    const panels = [panel('a', at(0, 0, 6, 4)), panel('b', at(6, 0, 6, 4))]

    const moved = applyLayoutChanges(panels, [{ id: 'b', geometry: at(0, 4, 6, 4) }])

    expect(moved.map((p) => [p.id, p.geometry])).toEqual([
      ['a', at(0, 0, 6, 4)],
      ['b', at(0, 4, 6, 4)],
    ])
  })

  it('keeps everything the panel is besides its geometry', () => {
    const titled = { ...panel('a', at(0, 0, 6, 4)), title: 'RAM, big', window: '15m' as const }

    const [moved] = applyLayoutChanges([titled], [{ id: 'a', geometry: at(2, 2, 4, 2) }])

    expect(moved).toEqual({ ...titled, geometry: at(2, 2, 4, 2) })
  })

  it('reads a sparse geometry the way the grid library writes one', () => {
    // The library omits values equal to its defaults, so a 1×1 panel arrives
    // with neither width nor height. Normalizing here is what keeps the
    // document dense enough for a later migration to read without guessing.
    const [moved] = applyLayoutChanges(
      [panel('a', at(0, 0, 6, 4))],
      [{ id: 'a', geometry: { x: 3, y: 2 } as PanelGeometry }],
    )

    expect(moved.geometry).toEqual(at(3, 2, 1, 1))
  })

  it('ignores a change naming a panel this page does not have', () => {
    const panels = [panel('a', at(0, 0, 6, 4))]

    expect(applyLayoutChanges(panels, [{ id: 'ghost', geometry: at(0, 4, 6, 4) }])).toBe(panels)
  })

  it('hands back the very same list when nothing actually moved', () => {
    // Identity is the signal a caller uses to leave its state untouched, so a
    // change event that repeats the current geometry costs no re-render.
    const panels = [panel('a', at(0, 0, 6, 4))]

    expect(applyLayoutChanges(panels, [{ id: 'a', geometry: at(0, 0, 6, 4) }])).toBe(panels)
    expect(applyLayoutChanges(panels, [])).toBe(panels)
  })
})

describe('putting a page’s panels back into the document', () => {
  const document = (): DashboardDocument => ({
    version: 1,
    pages: [
      { id: 'one', name: 'One', panels: [panel('a', at(0, 0, 6, 4))] },
      { id: 'two', name: 'Two', panels: [panel('b', at(0, 0, 6, 4))] },
    ],
  })

  it('replaces only the named page’s panels', () => {
    const next = withPagePanels(document(), 'two', [panel('b', at(6, 0, 6, 4))])

    expect(next.pages[0]).toEqual(document().pages[0])
    expect(next.pages[1].panels[0].geometry).toEqual(at(6, 0, 6, 4))
    expect(next.pages[1].name).toBe('Two')
  })

  it('leaves a document with no such page exactly as it was', () => {
    const before = document()

    expect(withPagePanels(before, 'gone', [])).toEqual(document())
  })
})

describe('what a drag or resize in progress is asking for', () => {
  const cell = { width: 50, height: 30 }
  const grid = { left: 100, top: 200, width: 600, height: 240 }

  it('reads the element’s pixels as whole cells', () => {
    const requested = requestedCells(
      { left: 100 + 3 * 50, top: 200 + 2 * 30, width: 4 * 50, height: 2 * 30 },
      grid,
      cell,
    )

    expect(requested).toEqual(at(3, 2, 4, 2))
  })

  it('rounds to the nearest cell, the way a dropped panel snaps', () => {
    const requested = requestedCells(
      { left: 100 + 3 * 50 + 12, top: 200 + 2 * 30 - 11, width: 4 * 50, height: 2 * 30 },
      grid,
      cell,
    )

    expect(requested).toEqual(at(3, 2, 4, 2))
  })

  it('keeps a request that runs past the bottom of the grid, because that is the interesting one', () => {
    // Clamping here would hide exactly what the row cap exists to surface.
    const requested = requestedCells(
      { left: 100, top: 200 + 7 * 30, width: 2 * 50, height: 4 * 30 },
      grid,
      cell,
    )

    expect(requested).toEqual(at(0, 7, 2, 4))
    expect(requested!.y + requested!.h).toBeGreaterThan(GRID_MAX_ROWS)
  })

  it('never asks for a negative cell or an empty panel', () => {
    const requested = requestedCells({ left: 0, top: 0, width: 4, height: 3 }, grid, cell)

    expect(requested).toEqual(at(0, 0, 1, 1))
  })

  it('knows nothing when the grid has not been measured', () => {
    // jsdom measures every box as 0×0, and so does the first frame before
    // layout. Guessing there would accuse the grid of refusing a drop that
    // never happened.
    expect(requestedCells({ left: 0, top: 0, width: 0, height: 0 }, grid, { width: 0, height: 0 }))
      .toBeNull()
  })
})

describe('judging what the grid did with a drop', () => {
  const from = at(0, 4, 6, 4)

  it('is granted when the panel landed where it was asked to', () => {
    expect(judgeDrop(from, at(3, 2, 6, 4), at(3, 2, 6, 4))).toBe('granted')
  })

  it('is out of room when the panel was asked to move and did not', () => {
    expect(judgeDrop(from, at(0, 6, 6, 4), from)).toBe('out-of-room')
  })

  it('is out of room when a resize was refused outright', () => {
    expect(judgeDrop(from, at(0, 4, 6, 6), from)).toBe('out-of-room')
  })

  it('is granted when the engine reflowed the page around the drop', () => {
    // Landing on a neighbour makes the engine swap or push it, so the cells the
    // panel ends on are routinely not the ones it was dropped on. Calling that
    // a full page would put a refusal in front of nearly every successful drag.
    expect(judgeDrop(from, at(0, 0, 6, 4), at(0, 1, 6, 4))).toBe('granted')
  })

  it('is granted when the operator put the panel back where it came from', () => {
    expect(judgeDrop(from, from, from)).toBe('granted')
  })

  it('does not call the grid’s own edges a refusal', () => {
    // Dragging past the left or right edge is the operator meeting the frame,
    // not the page being full: the grid keeps the panel inside its columns and
    // that is the placement they got.
    const wide = at(GRID_COLUMNS - 4, 0, 4, 2)
    expect(judgeDrop(wide, at(GRID_COLUMNS, 0, 4, 2), wide)).toBe('granted')

    const full = at(0, 0, GRID_COLUMNS, 2)
    expect(judgeDrop(full, at(0, 0, GRID_COLUMNS + 3, 2), full)).toBe('granted')
  })

  it('says nothing when there was no measurable request', () => {
    expect(judgeDrop(from, null, from)).toBe('granted')
  })
})
