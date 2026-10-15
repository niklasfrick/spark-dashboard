import type { ChartSeries } from '@/components/charts/TimeSeriesChart'

/**
 * The chart lines of a panel's reported groups. Each entry is its line, or a
 * falsy value when its group is not reported (ADR-0004) — those draw nothing.
 */
export function reportedLines(
  lines: ReadonlyArray<ChartSeries | false | null | undefined>,
): ChartSeries[] {
  return lines.filter((line): line is ChartSeries => Boolean(line))
}
