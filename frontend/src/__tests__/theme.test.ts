import { describe, it, expect } from 'vitest'
import { NVIDIA_THEME, THRESHOLDS, thresholdColor } from '../lib/theme'

describe('theme', () => {
  it('NVIDIA_THEME.accent is NVIDIA green', () => {
    expect(NVIDIA_THEME.accent).toBe('#76B900')
  })

  it('THRESHOLDS.gpuTemp has correct warning and critical values', () => {
    expect(THRESHOLDS.gpuTemp.warning).toBe(70)
    expect(THRESHOLDS.gpuTemp.critical).toBe(85)
  })

  describe('thresholdColor', () => {
    it('returns healthy green for values below warning', () => {
      expect(thresholdColor(50, 70, 85)).toBe('#76B900')
    })

    it('returns warning yellow for values at or above warning but below critical', () => {
      expect(thresholdColor(75, 70, 85)).toBe('#eab308')
    })

    it('returns critical red for values at or above critical', () => {
      expect(thresholdColor(90, 70, 85)).toBe('#ef4444')
    })

    it('returns warning yellow at exactly the warning threshold', () => {
      expect(thresholdColor(70, 70, 85)).toBe('#eab308')
    })

    it('returns critical red at exactly the critical threshold', () => {
      expect(thresholdColor(85, 70, 85)).toBe('#ef4444')
    })
  })
})
