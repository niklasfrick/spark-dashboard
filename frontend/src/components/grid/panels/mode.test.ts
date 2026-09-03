import { describe, expect, it } from 'vitest'
import { coreGridLayout, enginePanelMode, gaugeSizePx, hardwarePanelMode } from './mode'

describe('hardwarePanelMode', () => {
  it('renders the richest layout while the box is unmeasured', () => {
    // jsdom, and the first frame before ResizeObserver fires, both report 0.
    expect(hardwarePanelMode({ width: 0, height: 0 })).toBe('full')
  })

  it('drops to the compact value when the box is too short for a chart', () => {
    // A 1×1 cell on a laptop: ~100px wide, ~55px of content height.
    expect(hardwarePanelMode({ width: 100, height: 55 })).toBe('compact')
  })

  it('drops the gauge column when the box is tall but narrow', () => {
    expect(hardwarePanelMode({ width: 120, height: 300 })).toBe('chart')
  })

  it('shows gauge and chart when there is room for both', () => {
    // A 3×2 preset cell on a desktop viewport.
    expect(hardwarePanelMode({ width: 300, height: 140 })).toBe('full')
  })

  it('prefers compact over chart-only when the box is both short and narrow', () => {
    expect(hardwarePanelMode({ width: 100, height: 40 })).toBe('compact')
  })
})

describe('enginePanelMode', () => {
  it('renders the richest layout while the box is unmeasured', () => {
    expect(enginePanelMode({ width: 0, height: 0 })).toBe('full')
  })

  it('keeps the values and drops the chart in a short box', () => {
    // Two rows of engine tiles alone need most of this height.
    expect(enginePanelMode({ width: 400, height: 150 })).toBe('tiles')
  })

  it('charts under the values when the box is tall enough for both', () => {
    // A 4×3 preset cell on a desktop viewport.
    expect(enginePanelMode({ width: 400, height: 260 })).toBe('full')
  })

  it('keeps the chart in a narrow box, unlike the hardware panels', () => {
    // Engine panels have no gauge column competing for the width, so narrow is
    // not a reason to drop anything.
    expect(enginePanelMode({ width: 120, height: 300 })).toBe('full')
  })
})

describe('coreGridLayout', () => {
  it('renders the richest layout while the box is unmeasured', () => {
    // jsdom reports 0×0, and so does the first frame before ResizeObserver
    // fires — the same fallback the panel modes take.
    expect(coreGridLayout({ width: 0, height: 0 }, 8)).toEqual({ columns: 4, labelled: true })
  })

  it('tiles a wide box in more columns than a square one', () => {
    // Square cells are the goal: a row of slivers says nothing about which
    // cores are busy.
    expect(coreGridLayout({ width: 400, height: 100 }, 8).columns).toBe(6)
    expect(coreGridLayout({ width: 200, height: 200 }, 8).columns).toBe(3)
  })

  it('never asks for more columns than there are cores', () => {
    expect(coreGridLayout({ width: 400, height: 100 }, 2).columns).toBe(2)
  })

  it('labels the cells once they are big enough to read', () => {
    // A 6×3 panel on a desktop viewport, on a 16-core host.
    expect(coreGridLayout({ width: 480, height: 200 }, 16).labelled).toBe(true)
  })

  it('drops the labels when the cells come out as texture', () => {
    // 96 cores in a 1×1 cell: a block of colour is all that fits, and it is
    // still worth showing — the load is legible as a pattern.
    const layout = coreGridLayout({ width: 100, height: 55 }, 96)
    expect(layout.labelled).toBe(false)
    expect(layout.columns).toBeGreaterThan(1)
  })

  it('survives a host that reports no cores at all', () => {
    expect(coreGridLayout({ width: 400, height: 100 }, 0)).toEqual({ columns: 1, labelled: true })
  })
})

describe('gaugeSizePx', () => {
  it('caps at the size the pre-grid dashboard used', () => {
    expect(gaugeSizePx(400)).toBe(96)
  })

  it('fills the row height when the box is smaller than the cap', () => {
    expect(gaugeSizePx(80)).toBe(72)
  })

  it('never shrinks below legibility, and treats unmeasured as the cap', () => {
    expect(gaugeSizePx(30)).toBe(40)
    expect(gaugeSizePx(0)).toBe(96)
  })
})
