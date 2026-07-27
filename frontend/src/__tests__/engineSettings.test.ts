import { describe, it, expect } from 'vitest'
import {
  parseLatencyMode,
  serializeLatencyMode,
  pickLatencyValue,
  latencyModeLabel,
} from '@/lib/latencyMode'
import { parseRotationState, serializeRotationState } from '@/lib/rotation'
import { computeTrend, percentileSubline, type ChartDataPoint } from '@/lib/engineStats'
import { fmtVal, fmtInt } from '@/lib/format'

// These helpers were extracted out of the engine control/primitive components
// so those files export components only. The behaviour is unchanged; these
// specs pin it at the new module boundary.

describe('parseLatencyMode', () => {
  it('accepts every valid mode', () => {
    expect(parseLatencyMode('avg')).toBe('avg')
    expect(parseLatencyMode('p50')).toBe('p50')
    expect(parseLatencyMode('p95')).toBe('p95')
    expect(parseLatencyMode('p99')).toBe('p99')
  })

  it('falls back to avg for absent or unrecognised values', () => {
    expect(parseLatencyMode(null)).toBe('avg')
    expect(parseLatencyMode(undefined)).toBe('avg')
    expect(parseLatencyMode('')).toBe('avg')
    expect(parseLatencyMode('p42')).toBe('avg')
  })

  it('round-trips through serialization', () => {
    expect(parseLatencyMode(serializeLatencyMode('p95'))).toBe('p95')
  })
})

describe('pickLatencyValue', () => {
  const percentiles = { p50_ms: 10, p95_ms: 20, p99_ms: 30 }

  it('returns the average for avg mode, ignoring percentiles', () => {
    expect(pickLatencyValue('avg', 5, percentiles)).toBe(5)
    expect(pickLatencyValue('avg', null, percentiles)).toBeNull()
  })

  it('selects the matching quantile', () => {
    expect(pickLatencyValue('p50', 5, percentiles)).toBe(10)
    expect(pickLatencyValue('p95', 5, percentiles)).toBe(20)
    expect(pickLatencyValue('p99', 5, percentiles)).toBe(30)
  })

  it('returns null when percentiles have not been observed', () => {
    expect(pickLatencyValue('p95', 5, null)).toBeNull()
  })
})

describe('latencyModeLabel', () => {
  it('labels avg in lowercase and passes quantiles through', () => {
    expect(latencyModeLabel('avg')).toBe('avg')
    expect(latencyModeLabel('p99')).toBe('p99')
  })
})

describe('parseRotationState', () => {
  it("reads 'off' as disabled while keeping the default interval", () => {
    expect(parseRotationState('off')).toEqual({ enabled: false, interval: 10000 })
  })

  it('reads a supported interval as enabled', () => {
    expect(parseRotationState('3000')).toEqual({ enabled: true, interval: 3000 })
    expect(parseRotationState('20000')).toEqual({ enabled: true, interval: 20000 })
  })

  it('falls back to the default interval for junk or absent values', () => {
    expect(parseRotationState(null)).toEqual({ enabled: true, interval: 10000 })
    expect(parseRotationState('7500')).toEqual({ enabled: true, interval: 10000 })
  })

  it('round-trips through serialization', () => {
    const off = { enabled: false, interval: 5000 } as const
    expect(parseRotationState(serializeRotationState(off)).enabled).toBe(false)
    const on = { enabled: true, interval: 5000 } as const
    expect(parseRotationState(serializeRotationState(on))).toEqual(on)
  })
})

describe('computeTrend', () => {
  const series = (values: number[]): ChartDataPoint[] =>
    values.map((value, i) => ({ timestamp: i, value }))

  it('is stable below the minimum sample count', () => {
    expect(computeTrend(series([1, 2, 3, 4, 5]))).toBe('stable')
  })

  it('detects a rise beyond the threshold', () => {
    expect(computeTrend(series([1, 1, 1, 1, 1, 1, 10, 10, 10]))).toBe('up')
  })

  it('detects a fall beyond the threshold', () => {
    expect(computeTrend(series([10, 10, 10, 10, 10, 10, 1, 1, 1]))).toBe('down')
  })

  it('stays stable inside the threshold band', () => {
    expect(computeTrend(series([100, 100, 100, 100, 100, 100, 101, 101, 101]))).toBe('stable')
  })

  it('treats growth from a zero baseline as a rise', () => {
    expect(computeTrend(series([0, 0, 0, 0, 0, 0, 5, 5, 5]))).toBe('up')
  })
})

describe('percentileSubline', () => {
  it('renders all three quantiles', () => {
    expect(percentileSubline({ p50_ms: 10.4, p95_ms: 20.6, p99_ms: 30 })).toBe(
      'p50 10 · p95 21 · p99 30',
    )
  })

  it('dashes individual missing quantiles', () => {
    expect(percentileSubline({ p50_ms: 10, p95_ms: null, p99_ms: 30 })).toBe(
      'p50 10 · p95 — · p99 30',
    )
  })

  it('returns undefined when there is nothing to show', () => {
    expect(percentileSubline(null)).toBeUndefined()
    expect(percentileSubline(undefined)).toBeUndefined()
    expect(percentileSubline({ p50_ms: null, p95_ms: null, p99_ms: null })).toBeUndefined()
  })
})

describe('fmtVal / fmtInt', () => {
  it('renders the placeholder for absent values', () => {
    expect(fmtVal(null, (n) => `${n}`)).toBe('--')
    expect(fmtInt(null)).toBe('--')
  })

  it('applies the formatter and rounds integers', () => {
    expect(fmtVal(3, (n) => `${n} tps`)).toBe('3 tps')
    expect(fmtInt(3.6)).toBe('4')
    expect(fmtInt(0)).toBe('0')
  })
})
