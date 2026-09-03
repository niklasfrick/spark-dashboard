import { describe, it, expect } from 'vitest'
import {
  NVIDIA_THEME,
  THRESHOLDS,
  coreUsageColor,
  gpuEventColor,
  thresholdColor,
} from '../lib/theme'

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

  describe('coreUsageColor', () => {
    // More bands than `thresholdColor`, and dimmer at the bottom: a core grid
    // is read as a texture, so an idle core has to recede rather than sit at
    // full green beside a saturated one.
    it('recedes below a tenth of a core', () => {
      expect(coreUsageColor(0)).toBe('#27272a')
      expect(coreUsageColor(9)).toBe('#27272a')
    })

    it('dims a core that is doing something but not much', () => {
      expect(coreUsageColor(10)).toBe('#365314')
      expect(coreUsageColor(39)).toBe('#365314')
    })

    it('reaches the accent at a busy core', () => {
      expect(coreUsageColor(40)).toBe('#76B900')
      expect(coreUsageColor(69)).toBe('#76B900')
    })

    it('warns, then alarms, on a saturated core', () => {
      expect(coreUsageColor(70)).toBe('#eab308')
      expect(coreUsageColor(89)).toBe('#eab308')
      expect(coreUsageColor(90)).toBe('#ef4444')
      expect(coreUsageColor(100)).toBe('#ef4444')
    })
  })

  describe('gpuEventColor', () => {
    it('alarms on the two an operator has to act on', () => {
      // A cooling problem or a hardware fault.
      expect(gpuEventColor('thermal')).toBe('#ef4444')
      expect(gpuEventColor('xid')).toBe('#ef4444')
    })

    it('only warns on the machine working as configured', () => {
      // Spending the alarm on a power cap would spend it on the ordinary case.
      expect(gpuEventColor('throttle')).toBe('#eab308')
      expect(gpuEventColor('power_brake')).toBe('#eab308')
    })

    it('warns rather than alarming on an event type it has never seen', () => {
      // A newer driver, or a newer collector: an unrecognized event is still
      // an event, and it must not read as more serious than a thermal one.
      expect(gpuEventColor('some_future_reason')).toBe('#eab308')
    })
  })
})
