/**
 * The dashboard's URLs: which view a path names, and what a page's URL is.
 *
 * Routing is history-based and deliberately minimal — the requirement is
 * rendering one of N pages, not nested routes or data loading, so this is a
 * pair of pure functions rather than a routing framework. The server already
 * serves the app shell for every unmatched path, so no backend knows these
 * shapes.
 *
 * A page URL is `/pages/<id>` or `/pages/<id>/<slug>`. **Only the id
 * matches.** The slug is derived from the page's name purely so the URL reads
 * like something — it is ignored on the way in, which is what keeps a kiosk
 * bookmark working after the page is renamed.
 *
 * Every path that names nothing renders the root dashboard, exactly as the
 * whole site did before these routes existed.
 */

import type { DashboardPage } from './schema'

export type Route =
  /** The pre-grid dashboard at the root — today's view, untouched until the #86 cutover. */
  | { kind: 'dashboard' }
  /** One grid page, named by its stable id. */
  | { kind: 'page'; pageId: string }

/** The view a browser path names. */
export function parseRoute(pathname: string): Route {
  const segments = pathname.split('/').filter(Boolean)

  if (segments[0] === 'pages' && segments[1]) {
    return { kind: 'page', pageId: decodeURIComponent(segments[1]) }
  }

  return { kind: 'dashboard' }
}

/**
 * The canonical URL of a page. The slug is omitted when it adds nothing —
 * empty, or already what the id says.
 */
export function pagePath(page: Pick<DashboardPage, 'id' | 'name'>): string {
  const base = `/pages/${encodeURIComponent(page.id)}`
  const slug = pageSlug(page.name)
  return slug && slug !== page.id ? `${base}/${slug}` : base
}

/**
 * A page name reduced to something that can sit in a URL: lowercased, runs of
 * anything but letters and digits collapsed to single dashes. Empty when the
 * name has nothing usable in it, and the URL is just the id.
 */
export function pageSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
}
