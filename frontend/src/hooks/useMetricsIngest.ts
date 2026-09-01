import { useEffect } from 'react'
import { useMetricsStore } from './useMetricsStore'
import type { MetricsSnapshot } from '@/types/metrics'

/**
 * Feeds incoming snapshots into the metrics store — and nothing else. The grid
 * page mounts this once at its root and stays out of the render path: panels
 * subscribe to their own series through `useMetricSeries`, so a snapshot
 * re-renders the panels it touched rather than the whole page. The pre-grid
 * dashboard keeps `useMetricsHistory`, which layers its subscribe-to-everything
 * accessors on top of this.
 */
export function useMetricsIngest(metrics: MetricsSnapshot | null): void {
  const store = useMetricsStore()

  useEffect(() => {
    if (metrics) store.ingest(metrics)
  }, [store, metrics])
}
