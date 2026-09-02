import { useMemo, useSyncExternalStore } from 'react'
import { parseRoute, type Route } from '@/lib/dashboard/routes'

/**
 * The view the browser's current path names, kept current across history
 * navigation. `popstate` covers back/forward; a programmatic `pushState` is
 * followed by dispatching a `popstate` event — see `navigateTo` — so in-app
 * navigation needs no custom event channel of its own.
 */
export function useRoute(): Route {
  const pathname = useSyncExternalStore(subscribe, readPathname)
  return useMemo(() => parseRoute(pathname), [pathname])
}

/**
 * Goes to another page without reloading the document.
 *
 * The browser fires `popstate` for its own back and forward, but not for a
 * `pushState` — so this raises it, which is what `useRoute` subscribes to. Doing
 * it here rather than in a store keeps the browser's history as the one source
 * of truth for which page is showing: the URL is the state, so a reload, a
 * bookmark and a back button all land in the same place.
 *
 * Navigating to where you already are is a no-op rather than a history entry, so
 * clicking the tab you are on does not fill the back button with itself.
 */
export function navigateTo(pathname: string): void {
  go(pathname, 'push')
}

/**
 * Corrects the current URL in place, without a history entry.
 *
 * This is what a rename does: the id in the path still matches, so the page has
 * not changed and pressing back should leave the page rather than undo a slug.
 */
export function replacePath(pathname: string): void {
  go(pathname, 'replace')
}

function go(pathname: string, how: 'push' | 'replace'): void {
  if (pathname === window.location.pathname) return

  if (how === 'push') window.history.pushState(null, '', pathname)
  else window.history.replaceState(null, '', pathname)

  window.dispatchEvent(new PopStateEvent('popstate'))
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange)
  return () => window.removeEventListener('popstate', onChange)
}

function readPathname(): string {
  return window.location.pathname
}
