import type { DataPoint } from './metricsHistoryStore'

/**
 * The sum of two series, aligned by timestamp. A timestamp only one series
 * carries contributes that series' value alone — the buffers append per
 * snapshot, so in practice the timestamps line up and the edge case only
 * appears while one series is still warming up.
 */
export function sumSeries(a: readonly DataPoint[], b: readonly DataPoint[]): DataPoint[] {
  const map = new Map<number, number>()
  for (const p of a) map.set(p.timestamp, p.value)
  for (const p of b) map.set(p.timestamp, (map.get(p.timestamp) ?? 0) + p.value)
  return Array.from(map.entries())
    .sort((x, y) => x[0] - y[0])
    .map(([timestamp, value]) => ({ timestamp, value }))
}
