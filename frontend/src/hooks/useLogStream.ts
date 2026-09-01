import { createContext, useCallback, useContext, useSyncExternalStore } from 'react'
import { LogStreamStore, type LogStream } from '@/lib/logStreamStore'

/**
 * The log stream store, provided through context rather than a module singleton
 * for the same reason the metrics store is: every test (and any future second
 * root) gets its own, so no socket outlives the tree that opened it.
 *
 * Exported only for `LogStreamProvider`, which lives in its own file because a
 * component and hooks cannot share one without breaking fast refresh.
 */
export const LogStreamContext = createContext<LogStreamStore | null>(null)

export function useLogStreamStore(): LogStreamStore {
  const store = useContext(LogStreamContext)
  if (!store) {
    throw new Error('useLogStream requires a <LogStreamProvider> above it')
  }
  return store
}

/**
 * One engine's live logs, for as long as this component is mounted.
 *
 * Mounting is the subscription: the first component to want an endpoint opens
 * its socket and the last one to unmount closes it. A component that should not
 * be streaming — a collapsed console, a panel bound to nothing — must therefore
 * not call this hook, rather than call it and ignore the result.
 */
export function useLogStream(endpoint: string): LogStream {
  const store = useLogStreamStore()
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(endpoint, listener),
    [store, endpoint],
  )
  const read = useCallback(() => store.read(endpoint), [store, endpoint])
  return useSyncExternalStore(subscribe, read)
}
