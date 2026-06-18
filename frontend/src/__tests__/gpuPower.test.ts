import { describe, it, expect } from 'vitest'
import { niceCeiling, powerPeak, computePowerScale } from '../lib/gpuPower'

describe('niceCeiling', () => {
  it('rounds up to a 1-2-5 grid', () => {
    expect(niceCeiling(4)).toBe(5)
    expect(niceCeiling(5)).toBe(5)
    expect(niceCeiling(5.1)).toBe(10)
    expect(niceCeiling(1)).toBe(1)
    expect(niceCeiling(10)).toBe(10)
    expect(niceCeiling(130)).toBe(200)
    expect(niceCeiling(1.5)).toBe(2)
  })

  it('returns null for non-positive or non-finite input', () => {
    expect(niceCeiling(0)).toBeNull()
    expect(niceCeiling(-5)).toBeNull()
    expect(niceCeiling(NaN)).toBeNull()
    expect(niceCeiling(Infinity)).toBeNull()
  })
})

describe('powerPeak', () => {
  it('returns the max across history and the current sample', () => {
    expect(powerPeak([{ value: 3 }, { value: 7 }, { value: 5 }], 4)).toBe(7)
    expect(powerPeak([{ value: 3 }, { value: 7 }], 12)).toBe(12)
  })

  it('handles a missing current reading', () => {
    expect(powerPeak([{ value: 3 }, { value: 7 }], null)).toBe(7)
  })

  it('returns null when nothing usable is present', () => {
    expect(powerPeak([], null)).toBeNull()
  })

  it('uses current alone when history is empty', () => {
    expect(powerPeak([], 4)).toBe(4)
  })
})

describe('computePowerScale', () => {
  it('uses the hardware limit when present', () => {
    const scale = computePowerScale(150, 400, 200)
    expect(scale.source).toBe('limit')
    expect(scale.effectiveMax).toBe(400)
    expect(scale.percent).toBeCloseTo(37.5)
  })

  it('clamps to 100% when draw exceeds the limit', () => {
    const scale = computePowerScale(500, 400, 500)
    expect(scale.percent).toBe(100)
  })

  it('falls back to a nice-rounded peak when the limit is null', () => {
    const scale = computePowerScale(4, null, 4)
    expect(scale.source).toBe('peak')
    expect(scale.effectiveMax).toBe(5) // niceCeiling(4)
    expect(scale.percent).toBeCloseTo(80)
  })

  it('treats a zero limit as absent and uses the peak', () => {
    const scale = computePowerScale(4, 0, 4)
    expect(scale.source).toBe('peak')
    expect(scale.effectiveMax).toBe(5)
  })

  it('returns 0% with no max when neither limit nor peak is usable', () => {
    const scale = computePowerScale(4, null, null)
    expect(scale.percent).toBe(0)
    expect(scale.effectiveMax).toBeNull()
    expect(scale.source).toBeNull()
  })

  it('returns 0% when the current reading is null', () => {
    const scale = computePowerScale(null, null, 50)
    expect(scale.percent).toBe(0)
  })
})
