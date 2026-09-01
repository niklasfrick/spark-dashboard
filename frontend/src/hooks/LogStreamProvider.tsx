import { useState } from 'react'
import { LogStreamStore } from '@/lib/logStreamStore'
import { LogStreamContext } from './useLogStream'

/** Owns one `LogStreamStore` for the tree below it, so every log panel and the
 *  pre-grid console share a connection per engine. The lazy initializer runs
 *  once; the store is never replaced, so nothing re-renders for it. */
export function LogStreamProvider({ children }: { children: React.ReactNode }) {
  const [store] = useState(() => new LogStreamStore())
  return <LogStreamContext.Provider value={store}>{children}</LogStreamContext.Provider>
}
