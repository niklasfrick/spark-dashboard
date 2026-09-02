/**
 * How much history a chart covers. Per-panel configuration since the rework —
 * two panels on one page legitimately want a spike and a trend.
 */
export type TimeWindow = '5m' | '10m' | '15m'

export const TIME_WINDOW_SECONDS: Record<TimeWindow, number> = {
  '5m': 300,
  '10m': 600,
  '15m': 900,
}

/**
 * Every window a panel can cover, shortest first — the order they are offered
 * in. Written out rather than derived from the table above, because the order
 * is part of what this is and object key order is not something to lean on; a
 * spec holds the two in step.
 */
export const TIME_WINDOWS: readonly TimeWindow[] = ['5m', '10m', '15m']
