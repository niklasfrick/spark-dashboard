import { useMemo } from 'react'
import { useLatestSnapshot } from '@/hooks/useMetricsStore'
import { resolveGpuBinding } from '@/lib/dashboard/bindings'
import { gpuIndexOf, snapshotGpus } from '@/lib/identity'
import { gpuSeries, type GpuSeriesMetric } from '@/lib/metricsHistoryStore'
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
 * A following panel resolves to the primary GPU for now — the page-level GPU
 * selection this defers to arrives with #81, and the primary GPU is what the
 * pre-grid dashboard defaults to as well.
 */
export function useGpuPanel(panel: DashboardPanel): GpuPanelResolution {
  const snapshot = useLatestSnapshot()

  return useMemo(() => {
    if (!snapshot) return { status: 'waiting' }

    const gpus = snapshotGpus(snapshot)
    const resolution = resolveGpuBinding(panel.binding, gpus, gpuIndexOf(gpus[0]))
    if (resolution.status !== 'resolved') return resolution

    const multiGpu = gpus.length > 1
    const index = gpuIndexOf(resolution.target)
    return {
      status: 'resolved',
      gpu: resolution.target,
      multiGpu,
      seriesFor: (metric: GpuSeriesMetric) => gpuSeries(metric, index, multiGpu),
    }
  }, [snapshot, panel.binding])
}
