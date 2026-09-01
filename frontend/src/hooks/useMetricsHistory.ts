import { useCallback, useSyncExternalStore } from 'react'
import { useMetricsIngest } from './useMetricsIngest'
import { useMetricsStore } from './useMetricsStore'
import type { TimeWindow } from '../types/events'
import type { GpuEventData, InferenceRequestData, MetricsSnapshot } from '../types/metrics'

/**
 * Feeds incoming snapshots into the metrics store and exposes its read
 * accessors to the pre-grid dashboard, which reads many series from one
 * component and therefore subscribes to every ingested snapshot — exactly the
 * granularity it had before the store existed. Panels that want one series
 * subscribe through `useMetricSeries` instead.
 */
export function useMetricsHistory(metrics: MetricsSnapshot | null) {
  const store = useMetricsStore()

  useMetricsIngest(metrics)

  const subscribeAll = useCallback(
    (listener: () => void) => store.subscribeAll(listener),
    [store],
  )
  const getIngestVersion = useCallback(() => store.ingestVersion(), [store])
  const version = useSyncExternalStore(subscribeAll, getIngestVersion)

  // The accessors change identity with every ingested snapshot, so memoized
  // consumers (the event and request mappings in App) recompute exactly as
  // often as they did under the old version counter.
  const getChartData = useCallback(
    (metric: string, window?: TimeWindow) => {
      void version
      return store.getChartData(metric, window)
    },
    [store, version],
  )

  const getSparklineData = useCallback(
    (metric: string, count = 30): number[] => {
      void version
      return store.getSparklineData(metric, count)
    },
    [store, version],
  )

  const getEvents = useCallback(
    (window?: TimeWindow): GpuEventData[] => {
      void version
      return store.getEvents(window)
    },
    [store, version],
  )

  /** Recent requests, optionally narrowed to one engine. `key` is an engine
   *  key as produced by `engineKey()`; omit it for every engine's requests. */
  const getRequests = useCallback(
    (key?: string, window?: TimeWindow): InferenceRequestData[] => {
      void version
      return store.getRequests(key, window)
    },
    [store, version],
  )

  return { getChartData, getSparklineData, getEvents, getRequests }
}
