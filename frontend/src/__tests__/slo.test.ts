import { describe, expect, it } from 'vitest'
import {
  combinedGoodput,
  DEFAULT_SLO,
  fractionLe,
  recomputeGoodputPct,
  SLO,
} from '@/lib/slo'
import type { HistogramBucket } from '@/types/metrics'

const OVERFLOW = Number.MAX_VALUE

function buckets(...pairs: [number, number][]): HistogramBucket[] {
  return pairs.map(([le, cum]) => ({ le_seconds: le, cumulative_count: cum }))
}

const APPROX = 1e-9

describe('DEFAULT_SLO mirrors backend constants', () => {
  it('matches the Rust thresholds (TTFT 500ms, ITL 50ms, E2E 5000ms)', () => {
    expect(DEFAULT_SLO).toEqual({ ttftMs: 500, itlMs: 50, e2eMs: 5000 })
  })

  it('keeps SLO as a backwards-compatible alias of DEFAULT_SLO', () => {
    expect(SLO).toBe(DEFAULT_SLO)
  })
})

// The fractionLe tests below are direct ports of the Rust fraction_le tests
// in src/engines/histogram.rs. Keeping the assertions identical guarantees
// the TS port stays in lockstep with the backend computation.
describe('fractionLe (TS port of Rust fraction_le)', () => {
  it('returns null for empty buckets', () => {
    expect(fractionLe([], 0.5)).toBeNull()
    expect(fractionLe(null, 0.5)).toBeNull()
  })

  it('returns null when total count is zero', () => {
    const b = buckets([0.1, 0], [1.0, 0], [OVERFLOW, 0])
    expect(fractionLe(b, 0.5)).toBeNull()
  })

  it('matches at the bucket boundary', () => {
    // 50 obs at <= 0.1, 100 total. Threshold == 0.1 → 50/100 = 0.5.
    const b = buckets([0.1, 50], [1.0, 100])
    expect(fractionLe(b, 0.1)).toBeCloseTo(0.5, 9)
  })

  it('linearly interpolates within a bucket', () => {
    // 25 by 0.1s, 100 by 1.0s. Threshold 0.4 sits inside bucket 1.
    // bucket has 75 obs over (0.1, 1.0]; (0.4 - 0.1) / 0.9 = 1/3
    // → cum = 25 + (1/3)*75 = 50 → 50/100 = 0.5.
    const b = buckets([0.1, 25], [1.0, 100])
    expect(fractionLe(b, 0.4)).toBeCloseTo(0.5, 9)
  })

  it('linearly interpolates from zero when threshold is below the first bucket', () => {
    // 100 obs in [0, 0.1]. Threshold 0.05 → assume uniform within bucket
    // → 50/100 = 0.5.
    const b = buckets([0.1, 100], [1.0, 100])
    expect(fractionLe(b, 0.05)).toBeCloseTo(0.5, 9)
  })

  it('caps at the last finite cumulative count above finite bounds', () => {
    // 99 in (0, 1.0], 1 in overflow. Threshold 5.0 → 99/100 = 0.99.
    const b = buckets([1.0, 99], [OVERFLOW, 100])
    expect(fractionLe(b, 5.0)).toBeCloseTo(0.99, 9)
  })

  it('saturates at 1 when threshold exceeds all buckets and no overflow exists', () => {
    const b = buckets([0.1, 10], [1.0, 100])
    expect(fractionLe(b, 5.0)).toBeCloseTo(1.0, 9)
  })

  it('returns 0 when first bucket le is zero or negative', () => {
    const b = buckets([0.0, 0], [1.0, 100])
    expect(fractionLe(b, -1.0)).toBeCloseTo(0.0, 9)
  })

  it('returns null for NaN threshold', () => {
    const b = buckets([0.1, 50], [1.0, 100])
    expect(fractionLe(b, Number.NaN)).toBeNull()
  })
})

describe('recomputeGoodputPct', () => {
  it('returns the percentage 0–100 from millisecond thresholds', () => {
    // 50/100 obs at <= 100ms → 50% goodput at TTFT ≤ 100ms.
    const b = buckets([0.1, 50], [1.0, 100])
    const got = recomputeGoodputPct(b, 100)
    expect(got).not.toBeNull()
    expect(got!).toBeCloseTo(50, 9)
  })

  it('returns null when buckets are missing', () => {
    expect(recomputeGoodputPct(null, 500)).toBeNull()
    expect(recomputeGoodputPct([], 500)).toBeNull()
  })

  it('agrees with the backend default goodput within rounding', () => {
    // Backend with TTFT_SLO_MS=500: vllm test data
    //   50 at <=0.05, 80 at <=0.1, 95 at <=0.5, 99 at <=1.0, 100 at +Inf.
    // fractionLe at threshold 0.5s → exactly 95/100 = 0.95 → 95.0%.
    const b = buckets(
      [0.05, 50],
      [0.1, 80],
      [0.5, 95],
      [1.0, 99],
      [OVERFLOW, 100],
    )
    const got = recomputeGoodputPct(b, 500)!
    expect(Math.abs(got - 95)).toBeLessThan(APPROX)
  })

  it('drops sharply when the user tightens the threshold', () => {
    const b = buckets(
      [0.05, 50],
      [0.1, 80],
      [0.5, 95],
      [1.0, 99],
      [OVERFLOW, 100],
    )
    // At a 50ms threshold only the [0, 0.05] bucket fully qualifies → 50%.
    expect(recomputeGoodputPct(b, 50)!).toBeCloseTo(50, 9)
  })
})

describe('combinedGoodput', () => {
  it('returns the minimum of the present values', () => {
    expect(combinedGoodput(99, 95, 88)).toBe(88)
  })

  it('ignores nulls and non-finite values', () => {
    expect(combinedGoodput(99, null, 88)).toBe(88)
    expect(combinedGoodput(99, Number.NaN, 50)).toBe(50)
  })

  it('returns null when all inputs are null', () => {
    expect(combinedGoodput(null, null, null)).toBeNull()
  })
})
