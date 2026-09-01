import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react'
import { MetricsHistoryStore, type DataPoint } from '@/lib/metricsHistoryStore'
import { DEFAULT_TIME_WINDOW } from '@/lib/dashboard/schema'
import type { TimeWindow } from '@/types/events'
import type { MetricsSnapshot } from '@/types/metrics'

/**
 * The metrics history store, provided through context rather than a module
 * singleton so every test (and any future second root) gets its own instance.
 * The store itself lives outside React — see `MetricsHistoryStore`.
 *
 * Exported only for `MetricsStoreProvider`, which lives in its own file
 * because a component and hooks cannot share one without breaking fast
 * refresh; read the store through `useMetricsStore`.
 */
export const MetricsStoreContext = createContext<MetricsHistoryStore | null>(null)

export function useMetricsStore(): MetricsHistoryStore {
  const store = useContext(MetricsStoreContext)
  if (!store) {
    throw new Error('useMetricsStore requires a <MetricsStoreProvider> above it')
  }
  return store
}

/**
 * One chart series over the given time window, re-rendering only when that
 * series gains data. This is the subscription a panel uses: a snapshot that
 * changes other series does not touch this component.
 */
export function useMetricSeries(
  series: string,
  window: TimeWindow = DEFAULT_TIME_WINDOW,
): DataPoint[] {
  const store = useMetricsStore()
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(series, listener),
    [store, series],
  )
  const getVersion = useCallback(() => store.seriesVersion(series), [store, series])
  const version = useSyncExternalStore(subscribe, getVersion)
  return useMemo(() => {
    void version // the series changed; re-read the window
    return store.getChartData(series, window)
  }, [store, series, window, version])
}

/**
 * The most recent snapshot, re-rendering on every ingest. This is the
 * subscription for a panel's *current-value* display — a gauge, a rate pair, a
 * segment split — which needs more of the snapshot than any one series holds
 * and legitimately changes every second. Null until the first snapshot lands.
 */
export function useLatestSnapshot(): MetricsSnapshot | null {
  const store = useMetricsStore()
  const subscribe = useCallback((listener: () => void) => store.subscribeAll(listener), [store])
  const getVersion = useCallback(() => store.ingestVersion(), [store])
  useSyncExternalStore(subscribe, getVersion)
  return store.latest()
}
