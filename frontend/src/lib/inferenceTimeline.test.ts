import { describe, expect, it } from 'vitest'
import {
  newestFirst,
  requestSummary,
  timelineAxis,
  timelineSpan,
  type TimelineAxis,
} from './inferenceTimeline'
import type { InferenceRequestData } from '@/types/metrics'

function request(overrides: Partial<InferenceRequestData> = {}): InferenceRequestData {
  return { start_ms: 0, end_ms: 1000, tokens_per_sec: 100, ttft_ms: 200, ...overrides }
}

/** A one-second axis, so a percentage reads as a millisecond count over ten. */
const AXIS: TimelineAxis = { from: 0, to: 1000 }

describe('timelineAxis', () => {
  it('ends at the newest sample rather than at wall clock', () => {
    // Anchoring on the data is what holds the bars still between snapshots,
    // and what makes the rendering reproducible in a spec.
    expect(timelineAxis(1_000_000, '5m')).toEqual({ from: 700_000, to: 1_000_000 })
    expect(timelineAxis(1_000_000, '15m')).toEqual({ from: 100_000, to: 1_000_000 })
  })
})

describe('timelineSpan', () => {
  it('positions a request by when it happened', () => {
    expect(timelineSpan(request({ start_ms: 500, end_ms: 750 }), AXIS)).toEqual({
      leftPercent: 50,
      widthPercent: 25,
    })
  })

  it('clips a request that started before the window opened', () => {
    // The part inside the window is true; dropping it would hide a
    // long-running request entirely.
    expect(timelineSpan(request({ start_ms: -5000, end_ms: 250 }), AXIS)).toEqual({
      leftPercent: 0,
      widthPercent: 25,
    })
  })

  it('keeps a request that finished in milliseconds visible', () => {
    // A bar of width zero would silently drop the request off the axis.
    const span = timelineSpan(request({ start_ms: 100, end_ms: 100 }), AXIS)
    expect(span.leftPercent).toBe(10)
    expect(span.widthPercent).toBeGreaterThan(0)
  })

  it('keeps a request at the right edge on the axis', () => {
    const span = timelineSpan(request({ start_ms: 1000, end_ms: 1000 }), AXIS)
    expect(span.leftPercent + span.widthPercent).toBeLessThanOrEqual(100)
    expect(span.widthPercent).toBeGreaterThan(0)
  })

  it('does not divide by a zero-width axis', () => {
    // Before any snapshot has landed there is no window to position against.
    const span = timelineSpan(request(), { from: 0, to: 0 })
    expect(Number.isFinite(span.leftPercent)).toBe(true)
    expect(Number.isFinite(span.widthPercent)).toBe(true)
  })
})

describe('requestSummary', () => {
  it('reports nothing rather than zero when no request finished', () => {
    expect(requestSummary([])).toEqual({ count: 0, medianTps: null, medianTtftMs: null })
  })

  it('takes the median, so one cold start does not misreport the engine', () => {
    const summary = requestSummary([
      request({ tokens_per_sec: 100, ttft_ms: 200 }),
      request({ tokens_per_sec: 110, ttft_ms: 210 }),
      // The outlier: a mean would put throughput at 70 and TTFT near a second.
      request({ tokens_per_sec: 1, ttft_ms: 2400 }),
    ])
    expect(summary).toEqual({ count: 3, medianTps: 100, medianTtftMs: 210 })
  })

  it('averages the middle pair on an even count', () => {
    const summary = requestSummary([
      request({ tokens_per_sec: 100, ttft_ms: 200 }),
      request({ tokens_per_sec: 120, ttft_ms: 300 }),
    ])
    expect(summary.medianTps).toBe(110)
    expect(summary.medianTtftMs).toBe(250)
  })
})

describe('newestFirst', () => {
  it('orders the requests the way they are read', () => {
    const ordered = newestFirst([
      request({ end_ms: 100 }),
      request({ end_ms: 900 }),
      request({ end_ms: 500 }),
    ])
    expect(ordered.map((r) => r.end_ms)).toEqual([900, 500, 100])
  })

  it('leaves the list it was given alone', () => {
    const given = [request({ end_ms: 100 }), request({ end_ms: 900 })]
    newestFirst(given)
    expect(given.map((r) => r.end_ms)).toEqual([100, 900])
  })
})
