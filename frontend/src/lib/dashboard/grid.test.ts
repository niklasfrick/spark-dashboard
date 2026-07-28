import { describe, it, expect } from 'vitest'
import {
  GRID_COLUMNS,
  GRID_MAX_ROWS,
  firstFreeSlot,
  isOutOfRoom,
  readGeometry,
  type PanelGeometry,
} from './grid'

/** A geometry literal, so the specs below read as coordinates rather than objects. */
function at(x: number, y: number, w: number, h: number): PanelGeometry {
  return { x, y, w, h }
}

describe('readGeometry', () => {
  it('reads a complete geometry unchanged', () => {
    expect(readGeometry({ x: 3, y: 2, w: 4, h: 5 })).toEqual(at(3, 2, 4, 5))
  })

  it('treats a missing width or height as one', () => {
    // gridstack's save() omits values equal to its defaults, so a 1x1 widget
    // serializes without w/h at all. Guessing anything else here silently
    // resizes every small panel on the next read.
    expect(readGeometry({ x: 5, y: 6 })).toEqual(at(5, 6, 1, 1))
    expect(readGeometry({ x: 5, y: 6, w: 2 })).toEqual(at(5, 6, 2, 1))
    expect(readGeometry({ x: 5, y: 6, h: 2 })).toEqual(at(5, 6, 1, 2))
  })

  it('treats a missing position as the grid origin', () => {
    expect(readGeometry({ w: 2, h: 2 })).toEqual(at(0, 0, 2, 2))
  })

  it('reads a wholly absent geometry as a single cell at the origin', () => {
    expect(readGeometry(undefined)).toEqual(at(0, 0, 1, 1))
    expect(readGeometry(null)).toEqual(at(0, 0, 1, 1))
    expect(readGeometry('nonsense')).toEqual(at(0, 0, 1, 1))
  })

  it('discards values that are not finite numbers', () => {
    expect(readGeometry({ x: '2', y: NaN, w: null, h: Infinity })).toEqual(at(0, 0, 1, 1))
  })

  it('truncates fractional coordinates to whole cells', () => {
    expect(readGeometry({ x: 1.7, y: 2.9, w: 3.4, h: 4.6 })).toEqual(at(1, 2, 3, 4))
  })

  it('clamps a size larger than the grid down to the grid', () => {
    expect(readGeometry({ x: 0, y: 0, w: 99, h: 99 })).toEqual(
      at(0, 0, GRID_COLUMNS, GRID_MAX_ROWS),
    )
  })

  it('raises a zero or negative size to one cell', () => {
    expect(readGeometry({ x: 0, y: 0, w: 0, h: -4 })).toEqual(at(0, 0, 1, 1))
  })

  it('pulls a panel that overhangs the right edge back inside', () => {
    // A 4-wide panel can start no further right than column 8 of 12.
    expect(readGeometry({ x: 11, y: 0, w: 4, h: 1 })).toEqual(at(8, 0, 4, 1))
  })

  it('pulls a panel that overhangs the bottom edge back inside', () => {
    // A 4-tall panel can start no lower than row 4 of 8.
    expect(readGeometry({ x: 0, y: 7, w: 1, h: 4 })).toEqual(at(0, 4, 1, 4))
  })

  it('pulls a negative position back to the origin', () => {
    expect(readGeometry({ x: -3, y: -1, w: 2, h: 2 })).toEqual(at(0, 0, 2, 2))
  })
})

describe('firstFreeSlot', () => {
  it('places the first panel at the origin', () => {
    expect(firstFreeSlot([], { w: 1, h: 1 })).toEqual(at(0, 0, 1, 1))
  })

  it('places a panel beside an occupied block on the same row', () => {
    expect(firstFreeSlot([at(0, 0, 3, 3)], { w: 1, h: 1 })).toEqual(at(3, 0, 1, 1))
  })

  it('drops to the next row when the first is full', () => {
    expect(firstFreeSlot([at(0, 0, GRID_COLUMNS, 1)], { w: 1, h: 1 })).toEqual(at(0, 1, 1, 1))
  })

  it('fills a gap between two panels when the panel is narrow enough', () => {
    const occupied = [at(0, 0, 4, 1), at(8, 0, 4, 1)]
    expect(firstFreeSlot(occupied, { w: 4, h: 1 })).toEqual(at(4, 0, 4, 1))
  })

  it('skips a gap the panel does not fit and takes the next row', () => {
    const occupied = [at(0, 0, 4, 1), at(8, 0, 4, 1)]
    expect(firstFreeSlot(occupied, { w: 5, h: 1 })).toEqual(at(0, 1, 5, 1))
  })

  it('requires the whole height to be free, not just the top row', () => {
    // Column 0 is free on row 0 but taken on row 1, so a 2-tall panel has to
    // start at column 1 — a scan that only checked the first row would put it
    // on top of the existing panel.
    const occupied = [at(0, 1, 1, 1)]
    expect(firstFreeSlot(occupied, { w: 1, h: 2 })).toEqual(at(1, 0, 1, 2))
  })

  it('scans row by row rather than column by column', () => {
    // With column 0 blocked on row 0 only, reading order puts the next panel
    // at (1,0) — not at (0,1) further down the same column.
    expect(firstFreeSlot([at(0, 0, 1, 1)], { w: 1, h: 1 })).toEqual(at(1, 0, 1, 1))
  })

  it('has nowhere to put a panel wider than the grid', () => {
    expect(firstFreeSlot([], { w: GRID_COLUMNS + 1, h: 1 })).toBeNull()
  })

  it('has nowhere to put a panel taller than the row cap', () => {
    expect(firstFreeSlot([], { w: 1, h: GRID_MAX_ROWS + 1 })).toBeNull()
  })

  it('has nowhere to put a panel on a full grid', () => {
    expect(firstFreeSlot([at(0, 0, GRID_COLUMNS, GRID_MAX_ROWS)], { w: 1, h: 1 })).toBeNull()
  })

  it('finds the single remaining cell of an almost-full grid', () => {
    const occupied = [
      at(0, 0, GRID_COLUMNS, GRID_MAX_ROWS - 1),
      at(0, GRID_MAX_ROWS - 1, GRID_COLUMNS - 1, 1),
    ]
    expect(firstFreeSlot(occupied, { w: 1, h: 1 })).toEqual(
      at(GRID_COLUMNS - 1, GRID_MAX_ROWS - 1, 1, 1),
    )
  })
})

describe('isOutOfRoom', () => {
  it('is false while a slot remains', () => {
    expect(isOutOfRoom([], { w: 1, h: 1 })).toBe(false)
  })

  it('is true once the grid is full', () => {
    expect(isOutOfRoom([at(0, 0, GRID_COLUMNS, GRID_MAX_ROWS)], { w: 1, h: 1 })).toBe(true)
  })

  it('is true for a panel that fits nowhere even on an empty grid', () => {
    expect(isOutOfRoom([], { w: GRID_COLUMNS, h: GRID_MAX_ROWS + 1 })).toBe(true)
  })

  it('answers per requested size on the same page', () => {
    // Half a row left: a single cell fits, a full-width panel does not. The
    // predicate has to be asked about the panel being added, not the page.
    const occupied = [
      at(0, 0, GRID_COLUMNS, GRID_MAX_ROWS - 1),
      at(0, GRID_MAX_ROWS - 1, 6, 1),
    ]
    expect(isOutOfRoom(occupied, { w: 1, h: 1 })).toBe(false)
    expect(isOutOfRoom(occupied, { w: GRID_COLUMNS, h: 1 })).toBe(true)
  })
})
