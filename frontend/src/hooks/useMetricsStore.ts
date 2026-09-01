import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react'
import { MetricsHistoryStore, type DataPoint } from '@/lib/metricsHistoryStore'
import { useHeldWhileFrozen, useLiveMotion } from './useLiveMotion'
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
 *
 * Frozen while a page is being edited: ingestion carries on filling the ring
 * buffers, and the panel simply keeps drawing the window it had. Freezing the
 * reader rather than the writer is what leaves no gap in the history once the
 * operator saves and the dashboard starts moving again.
 */
export function useMetricSeries(
  series: string,
  window: TimeWindow = DEFAULT_TIME_WINDOW,
): DataPoint[] {
  const store = useMetricsStore()
  const live = useLiveMotion()
  const subscribe = useCallback(
    (listener: () => void) => (live ? store.subscribe(series, listener) : noop),
    [store, series, live],
  )
  const getVersion = useCallback(() => store.seriesVersion(series), [store, series])
  const version = useSyncExternalStore(subscribe, getVersion)
  const data = useMemo(() => {
    void version // the series changed; re-read the window
    return store.getChartData(series, window)
  }, [store, series, window, version])
  return useHeldWhileFrozen(data)
}

/**
 * The most recent snapshot, re-rendering on every ingest. This is the
 * subscription for a panel's *current-value* display — a gauge, a rate pair, a
 * segment split — which needs more of the snapshot than any one series holds
 * and legitimately changes every second. Null until the first snapshot lands.
 *
 * Frozen while a page is being edited, for the same reason and in the same way
 * as a series.
 */
export function useLatestSnapshot(): MetricsSnapshot | null {
  const store = useMetricsStore()
  const live = useLiveMotion()
  const subscribe = useCallback(
    (listener: () => void) => (live ? store.subscribeAll(listener) : noop),
    [store, live],
  )
  const getVersion = useCallback(() => store.ingestVersion(), [store])
  useSyncExternalStore(subscribe, getVersion)
  return useHeldWhileFrozen(store.latest())
}

/** Unsubscribing from a store that is not being listened to. */
function noop(): void {}
