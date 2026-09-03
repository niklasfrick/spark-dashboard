import { describe, expect, it } from 'vitest'
import { FOLLOW, UNREADABLE } from './bindings'
import {
  addPanel,
  applyLayoutChanges,
  judgeDrop,
  refusedPanelTitle,
  removePanel,
  renamePanel,
  repointPanel,
  requestedCells,
  setPanelWindow,
  withPagePanels,
} from './editing'
import { defaultPanelSize } from './panels'
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

describe('what a finished drag or resize was asking for', () => {
  const cell = { width: 50, height: 30 }
  const from = at(3, 2, 4, 2)

  it('moves the panel by the cells the pointer crossed', () => {
    expect(requestedCells('move', from, { dx: 2 * 50, dy: 3 * 30 }, cell)).toEqual(at(5, 5, 4, 2))
  })

  it('grows the panel by the cells the pointer crossed', () => {
    expect(requestedCells('resize', from, { dx: 1 * 50, dy: 2 * 30 }, cell)).toEqual(at(3, 2, 5, 4))
  })

  it('rounds to the nearest cell, the way a dropped panel snaps', () => {
    expect(requestedCells('move', from, { dx: 2 * 50 + 12, dy: 3 * 30 - 11 }, cell)).toEqual(
      at(5, 5, 4, 2),
    )
    expect(requestedCells('move', from, { dx: 14, dy: -9 }, cell)).toEqual(from)
  })

  it('keeps a request that runs past the bottom of the grid, because that is the interesting one', () => {
    // Clamping here would hide exactly what the row cap exists to surface.
    const moved = requestedCells('move', from, { dx: 0, dy: 5 * 30 }, cell)!
    const grown = requestedCells('resize', from, { dx: 0, dy: 5 * 30 }, cell)!

    expect(moved.y + moved.h).toBeGreaterThan(GRID_MAX_ROWS)
    expect(grown.y + grown.h).toBeGreaterThan(GRID_MAX_ROWS)
  })

  it('never asks for a negative cell or an empty panel', () => {
    expect(requestedCells('move', from, { dx: -20 * 50, dy: -20 * 30 }, cell)).toEqual(
      at(0, 0, 4, 2),
    )
    expect(requestedCells('resize', from, { dx: -20 * 50, dy: -20 * 30 }, cell)).toEqual(
      at(3, 2, 1, 1),
    )
  })

  it('knows nothing when the grid has not been measured', () => {
    // jsdom measures every box as 0×0, and so does the first frame before
    // layout. Guessing there would accuse the grid of refusing a drop that
    // never happened.
    expect(requestedCells('move', from, { dx: 0, dy: 0 }, { width: 0, height: 0 })).toBeNull()
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

describe('naming the panel a refusal is about', () => {
  it('uses the title the operator reads, renamed or not', () => {
    const titled = { ...panel('a', at(0, 0, 6, 4)), title: 'RAM, big' }

    expect(refusedPanelTitle([titled], 'a')).toBe('RAM, big')
    expect(refusedPanelTitle([panel('a', at(0, 0, 6, 4))], 'a')).toBe('Memory')
  })

  it('has nothing to say when nothing stands refused', () => {
    const panels = [panel('a', at(0, 0, 6, 4))]

    expect(refusedPanelTitle(panels, null)).toBeNull()
    expect(refusedPanelTitle(panels, 'a-panel-since-removed')).toBeNull()
  })
})

describe('adding a panel from the palette', () => {
  it('places it in the first free slot, so nothing has to be aimed at', () => {
    // The left half of the top rows is taken; reading order puts the new panel
    // immediately to its right rather than below everything.
    const outcome = addPanel([panel('a', at(0, 0, 6, 3))], 'gpu-power')

    expect(outcome).toMatchObject({ status: 'added' })
    if (outcome.status !== 'added') return
    expect(outcome.panels).toHaveLength(2)
    expect(outcome.panels[1].geometry).toEqual({ x: 6, y: 0, ...defaultPanelSize('gpu-power') })
  })

  it('adds it at the size its type asks for', () => {
    const outcome = addPanel([], 'logs')

    expect(outcome.status === 'added' && outcome.panels[0].geometry).toEqual({
      x: 0,
      y: 0,
      ...defaultPanelSize('logs'),
    })
  })

  it('leaves it following the page, so it renders on any host', () => {
    // A panel pinned at birth would name a target the operator never chose,
    // and would be wrong on the next machine the layout is opened on.
    const outcome = addPanel([], 'gpu-power')

    expect(outcome.status === 'added' && outcome.panels[0]).toMatchObject({
      type: 'gpu-power',
      binding: FOLLOW,
      window: DEFAULT_TIME_WINDOW,
    })
    // No title: the type's default is used, so renaming a default later
    // reaches panels an operator added but never renamed.
    expect(outcome.status === 'added' && 'title' in outcome.panels[0]).toBe(false)
  })

  it('gives the panel an id no other panel on the page holds', () => {
    const first = addPanel([], 'gpu-power')
    const second = first.status === 'added' ? addPanel(first.panels, 'gpu-power') : first

    expect(second.status === 'added' && second.panels.map((p) => p.id)).toEqual([
      'gpu-power',
      'gpu-power-2',
    ])
  })

  it('refuses when the page has no room, and changes nothing', () => {
    // The refusal is per panel size rather than per page: what is full is the
    // space this panel would need, which is the only thing the operator can act
    // on.
    const full = [panel('a', at(0, 0, GRID_COLUMNS, GRID_MAX_ROWS))]

    expect(addPanel(full, 'gpu-power')).toEqual({ status: 'out-of-room' })
  })
})

describe('removing a panel', () => {
  it('drops the one named and leaves the rest where they are', () => {
    const panels = [panel('a', at(0, 0, 6, 4)), panel('b', at(6, 0, 6, 4))]

    expect(removePanel(panels, 'a')).toEqual([panels[1]])
  })

  it('hands back the very same list when the page has no such panel', () => {
    const panels = [panel('a', at(0, 0, 6, 4))]

    expect(removePanel(panels, 'ghost')).toBe(panels)
  })
})

describe('renaming a panel', () => {
  it('puts the operator’s own words in the title', () => {
    const [renamed] = renamePanel([panel('a', at(0, 0, 6, 4))], 'a', 'Node 3 RAM')

    expect(renamed.title).toBe('Node 3 RAM')
  })

  it('drops the title entirely when it is cleared', () => {
    // Absent, not empty: the panel goes back to reading as its type's default
    // rather than rendering a blank header, and the document says so.
    const titled = [{ ...panel('a', at(0, 0, 6, 4)), title: 'Node 3 RAM' }]

    expect('title' in renamePanel(titled, 'a', '   ')[0]).toBe(false)
  })

  it('changes nothing else about the panel', () => {
    const original = panel('a', at(0, 0, 6, 4))

    expect(renamePanel([original], 'a', 'Node 3 RAM')[0]).toEqual({
      ...original,
      title: 'Node 3 RAM',
    })
  })
})

describe('a panel’s own time window', () => {
  it('is set on that panel alone, so two can differ on one page', () => {
    const panels = [panel('a', at(0, 0, 6, 4)), panel('b', at(6, 0, 6, 4))]

    const next = setPanelWindow(panels, 'b', '15m')

    expect(next.map((p) => p.window)).toEqual([DEFAULT_TIME_WINDOW, '15m'])
  })
})

describe('pointing a panel at a target', () => {
  it('pins it to the target the operator chose', () => {
    const [pinned] = repointPanel([panel('a', at(0, 0, 6, 4))], 'a', { kind: 'gpu', index: 2 })

    expect(pinned.binding).toEqual({ kind: 'gpu', index: 2 })
  })

  it('puts it back to following the page', () => {
    const pinned = [{ ...panel('a', at(0, 0, 6, 4)), binding: { kind: 'gpu', index: 2 } as const }]

    expect(repointPanel(pinned, 'a', FOLLOW)[0].binding).toEqual(FOLLOW)
  })

  it('is how a binding that could not be read is repaired', () => {
    const broken = [{ ...panel('a', at(0, 0, 6, 4)), binding: UNREADABLE }]

    expect(repointPanel(broken, 'a', FOLLOW)[0].binding).toEqual(FOLLOW)
  })
})
