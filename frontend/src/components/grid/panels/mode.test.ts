import { describe, expect, it } from 'vitest'
import { enginePanelMode, gaugeSizePx, hardwarePanelMode } from './mode'

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
