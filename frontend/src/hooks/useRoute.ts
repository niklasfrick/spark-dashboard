import { useMemo, useSyncExternalStore } from 'react'
import { parseRoute, type Route } from '@/lib/dashboard/routes'

/**
 * The view the browser's current path names, kept current across history
 * navigation. `popstate` covers back/forward; a programmatic `pushState` must
 * be followed by dispatching a `popstate` event, which is the deal the future
 * in-app navigation (#85) signs up to — no custom event channel until someone
 * actually navigates.
 */
export function useRoute(): Route {
  const pathname = useSyncExternalStore(subscribe, readPathname)
  return useMemo(() => parseRoute(pathname), [pathname])
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange)
  return () => window.removeEventListener('popstate', onChange)
}

function readPathname(): string {
  return window.location.pathname
}
