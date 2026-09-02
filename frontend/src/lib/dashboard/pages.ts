/**
 * The page list an operator keeps by hand: making a page, naming it, and
 * throwing one away.
 *
 * Pages are how one dashboard holds more than one arrangement — a training view
 * and an idle health view, kept side by side instead of one being chosen
 * permanently. Everything here is pure, and every function is a **replacement**:
 * a document in, a document out, with the pages that were not touched kept by
 * identity.
 *
 * Unlike a panel edit, a page edit is not part of an edit session. Creating,
 * renaming and deleting are each a deliberate, named request rather than a
 * side effect of dragging, so they are written when they are made — see
 * `GridPageContent`, which is where that decision is carried out.
 *
 * Two invariants live here rather than in the UI, because they are properties of
 * the document and every future caller needs them:
 *
 * - **A page id is never reused.** It is what a page's URL is built from, so two
 *   pages sharing one would be two pages at one address.
 * - **The last page cannot be deleted.** A document with no pages has nothing to
 *   render; starting over is what a reset is for, and it asks first.
 */

import { pageSlug } from './routes'
import type { DashboardDocument, DashboardPage } from './schema'

/** A page was made; `pageId` is the one to navigate to. */
export interface AddPageOutcome {
  document: DashboardDocument
  pageId: string
}

/**
 * The document with one more page at the end, empty.
 *
 * Empty rather than pre-populated: a new page exists because the preset's
 * arrangement is not the one wanted, so seeding it with the preset's panels
 * would be work to undo. The operator lands on it and adds what they came for.
 *
 * `name` is optional because creating a page and naming it are separate moves —
 * the tab appears first, and renaming it is the same action as renaming any
 * other page.
 */
export function addPage(document: DashboardDocument, name?: string): AddPageOutcome {
  const chosen = name?.trim() || unusedPageName(document.pages)
  const pageId = unusedPageId(document.pages, chosen)

  return {
    pageId,
    document: { ...document, pages: [...document.pages, { id: pageId, name: chosen, panels: [] }] },
  }
}

/**
 * The document with one page renamed. The **id is untouched**, which is the
 * whole reason it is separate from the name: a kiosk browser pointed at the page
 * comes back to it after the rename.
 *
 * A blank name is refused rather than stored. There is nothing to click on a tab
 * with no name, and unlike a panel title — which falls back to its type's
 * default — a page has no second name to fall back to.
 */
export function renamePage(
  document: DashboardDocument,
  pageId: string,
  name: string,
): DashboardDocument {
  const trimmed = name.trim()
  const page = document.pages.find((candidate) => candidate.id === pageId)
  if (!page || trimmed.length === 0 || trimmed === page.name) return document

  return {
    ...document,
    pages: document.pages.map((candidate) =>
      candidate.id === pageId ? { ...candidate, name: trimmed } : candidate,
    ),
  }
}

/** What became of a request to delete a page. */
export type RemovePageOutcome =
  | {
      status: 'removed'
      document: DashboardDocument
      /** The page to show next — the neighbour of the one that went. */
      nextPageId: string
    }
  /** The only page there is. Deleting it would leave nothing to render. */
  | { status: 'last-page' }

/**
 * The document without one page, and where the operator goes instead.
 *
 * The page before it, or the one after when the first page went. Somewhere
 * concrete either way: dropping the operator on a URL that names nothing would
 * turn a delete into an error page.
 */
export function removePage(document: DashboardDocument, pageId: string): RemovePageOutcome {
  if (document.pages.length <= 1) return { status: 'last-page' }

  const position = document.pages.findIndex((page) => page.id === pageId)
  const pages = document.pages.filter((page) => page.id !== pageId)
  // Below zero is a page the document never had; the first remaining page is as
  // good an answer as any, and better than none.
  const neighbour = pages[Math.max(0, position - 1)] ?? pages[0]

  return { status: 'removed', document: { ...document, pages }, nextPageId: neighbour.id }
}

/** Whether deleting is available at all, so the control can say why it is not. */
export function canRemovePage(document: DashboardDocument): boolean {
  return document.pages.length > 1
}

/**
 * A name nothing else holds, following the numbering the schema itself uses for
 * a page that arrived without one. It starts past the end of the list, so the
 * name usually matches the tab's position — and it skips anything taken, because
 * two identically named tabs are indistinguishable to the operator clicking one.
 */
function unusedPageName(pages: readonly DashboardPage[]): string {
  const taken = new Set(pages.map((page) => page.name))

  for (let position = pages.length + 1; ; position++) {
    const candidate = `Page ${position}`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * An id nothing else holds, derived from the name so the URL reads as the page
 * did when it was made — the preset's own `overview` is the same shape.
 *
 * It is derived **once, at creation**, and never again: from here on the id and
 * the name are independent, which is what lets the URL survive a rename.
 */
function unusedPageId(pages: readonly DashboardPage[], name: string): string {
  const taken = new Set(pages.map((page) => page.id))
  // A name of nothing but punctuation slugs to nothing, and every page still
  // needs an address.
  const base = pageSlug(name) || 'page'
  if (!taken.has(base)) return base

  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}
