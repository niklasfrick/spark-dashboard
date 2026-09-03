import { useMemo } from 'react'
import { useLatestSnapshot, useMetricSeries } from '@/hooks/useMetricsStore'
import { usePageSelection } from '@/hooks/usePageSelection'
import { resolveGpuBinding } from '@/lib/dashboard/bindings'
import { pageSelection } from '@/lib/dashboard/selection'
import { gpuIndexOf, snapshotGpus } from '@/lib/identity'
import { gpuSeries, type DataPoint, type GpuSeriesMetric } from '@/lib/metricsHistoryStore'
import type { DashboardPanel } from '@/lib/dashboard/schema'
import type { GpuMetrics } from '@/types/metrics'

export type GpuPanelResolution =
  /** No snapshot has arrived yet; there are no GPUs to resolve against. */
  | { status: 'waiting' }
  | {
      status: 'resolved'
      gpu: GpuMetrics
      multiGpu: boolean
      /** The history series key for this GPU's metric — per-GPU keys on
       *  multi-GPU hosts, the legacy un-prefixed keys on single-GPU ones. */
      seriesFor: (metric: GpuSeriesMetric) => string
    }
  | { status: 'missing'; requested: string }
  | { status: 'unselected' }
  | { status: 'unreadable' }

/**
 * What a GPU panel renders on this host: its binding resolved against the
 * latest snapshot's GPUs, plus the series-key vocabulary for its charts.
 *
 * A following panel resolves to the page-level GPU selection, which is the
 * primary GPU until the operator points the page somewhere else — so a page of
 * following panels moves to another GPU coherently, all at once.
 *
 * Exported for the panels that bind to a GPU without charting one of its
 * series — the event list. Panels that do chart one take
 * `useGpuPanelSeries`, which resolves and subscribes together.
 */
export function useGpuPanel(panel: DashboardPanel): GpuPanelResolution {
  const snapshot = useLatestSnapshot()
  const { chosen } = usePageSelection()

  return useMemo(() => {
    if (!snapshot) return { status: 'waiting' }

    const gpus = snapshotGpus(snapshot)
    const resolution = resolveGpuBinding(
      panel.binding,
      gpus,
      pageSelection(snapshot, chosen).gpuIndex,
    )
    if (resolution.status !== 'resolved') return resolution

    const multiGpu = gpus.length > 1
    const index = gpuIndexOf(resolution.target)
    return {
      status: 'resolved',
      gpu: resolution.target,
      multiGpu,
      seriesFor: (metric: GpuSeriesMetric) => gpuSeries(metric, index, multiGpu),
    }
  }, [snapshot, chosen, panel.binding])
}

/**
 * A GPU panel's whole subscription in one call: the resolved binding and the
 * chart data for `metric` over the panel's own window. Every hook lives in
 * here, above any caller's unresolved early return; while unresolved, the
 * legacy un-prefixed key keeps the series subscription alive until the first
 * snapshot names the real one.
 */
export function useGpuPanelSeries(
  panel: DashboardPanel,
  metric: GpuSeriesMetric,
): { resolution: GpuPanelResolution; data: DataPoint[] } {
  const resolution = useGpuPanel(panel)
  const series = resolution.status === 'resolved' ? resolution.seriesFor(metric) : metric
  const data = useMetricSeries(series, panel.window)
  return { resolution, data }
}
