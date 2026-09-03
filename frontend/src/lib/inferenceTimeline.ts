import { TIME_WINDOW_SECONDS, type TimeWindow } from '@/types/events'
import type { InferenceRequestData } from '@/types/metrics'

/**
 * The geometry and the summary behind the inference-request timeline, kept
 * out of the component so both are testable without a layout engine — the same
 * rule the panel modes in `components/grid/panels/mode.ts` follow.
 */

/** Where one request sits on the timeline's axis, as percentages of its width. */
export interface TimelineSpan {
  /** Distance from the left edge, 0–100. */
  leftPercent: number
  /** Width, 0–100, and never so small the bar disappears. */
  widthPercent: number
}

/**
 * A bar narrower than this is invisible, so a request that finished in
 * milliseconds would silently drop off a 15-minute axis. It is drawn at the
 * floor instead: the timeline's job is to say *when* requests happened and how
 * they overlap, and a request that is there has to be visible to say it.
 */
const MIN_WIDTH_PERCENT = 0.8

/** The window a timeline covers: the axis every span is positioned against. */
export interface TimelineAxis {
  /** Timestamp (ms) of the left edge. */
  from: number
  /** Timestamp (ms) of the right edge — the latest sample, not wall clock. */
  to: number
}

/**
 * The axis a panel's window describes, ending at the newest sample rather than
 * at `Date.now()`. Anchoring on the data is what keeps the bars still between
 * snapshots, and what makes the rendering reproducible in a spec.
 */
export function timelineAxis(latestMs: number, window: TimeWindow): TimelineAxis {
  return { from: latestMs - TIME_WINDOW_SECONDS[window] * 1000, to: latestMs }
}

/**
 * One request's bar on the axis. A request that started before the window
 * opened is clipped to it rather than dropped — the part inside the window is
 * true, and dropping it would hide a long-running request entirely.
 */
export function timelineSpan(request: InferenceRequestData, axis: TimelineAxis): TimelineSpan {
  const span = Math.max(1, axis.to - axis.from)
  const start = clampPercent(((request.start_ms - axis.from) / span) * 100)
  const end = clampPercent(((request.end_ms - axis.from) / span) * 100)
  return {
    leftPercent: Math.min(start, 100 - MIN_WIDTH_PERCENT),
    widthPercent: Math.max(MIN_WIDTH_PERCENT, end - start),
  }
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

/** What the timeline's tiles say about the requests in the window. */
export interface RequestSummary {
  /** How many requests finished inside the window. */
  count: number
  /** Median generation throughput, null when there were no requests. */
  medianTps: number | null
  /** Median time to first token in ms, null when there were no requests. */
  medianTtftMs: number | null
}

/**
 * The window's requests summarized. Medians rather than means: a single slow
 * cold-start request drags a mean far enough to misreport what the engine is
 * doing, and the timeline beside the tiles already shows the outlier.
 */
export function requestSummary(requests: readonly InferenceRequestData[]): RequestSummary {
  return {
    count: requests.length,
    medianTps: median(requests.map((r) => r.tokens_per_sec)),
    medianTtftMs: median(requests.map((r) => r.ttft_ms)),
  }
}

/** The median of the finite values, or null when there are none. */
function median(values: readonly number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/** The window's requests newest-first, which is the order they are read in. */
export function newestFirst(requests: readonly InferenceRequestData[]): InferenceRequestData[] {
  return [...requests].sort((a, b) => b.end_ms - a.end_ms)
}
