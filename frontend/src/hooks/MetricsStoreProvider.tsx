import { useState } from 'react'
import { MetricsHistoryStore } from '@/lib/metricsHistoryStore'
import { MetricsStoreContext } from './useMetricsStore'

/** Owns one `MetricsHistoryStore` for the tree below it. The lazy initializer
 *  runs once; the store is never replaced, so nothing re-renders for it. */
export function MetricsStoreProvider({ children }: { children: React.ReactNode }) {
  const [store] = useState(() => new MetricsHistoryStore())
  return <MetricsStoreContext.Provider value={store}>{children}</MetricsStoreContext.Provider>
}
