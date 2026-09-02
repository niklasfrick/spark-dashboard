import { describe, expect, it } from 'vitest'
import { addPage, removePage, renamePage } from './pages'
import { DASHBOARD_SCHEMA_VERSION, type DashboardDocument, type DashboardPage } from './schema'

function documentOf(...pages: Array<Partial<DashboardPage>>): DashboardDocument {
  return {
    version: DASHBOARD_SCHEMA_VERSION,
    pages: pages.map((page, index) => ({
      id: page.id ?? `page-${index + 1}`,
      name: page.name ?? `Page ${index + 1}`,
      panels: page.panels ?? [],
    })),
  }
}

const names = (document: DashboardDocument) => document.pages.map((page) => page.name)
const ids = (document: DashboardDocument) => document.pages.map((page) => page.id)

describe('addPage', () => {
  it('appends an empty page, so the operator drops straight into an edit session on it', () => {
    const outcome = addPage(documentOf({ id: 'overview', name: 'Overview' }))

    expect(outcome.document.pages).toHaveLength(2)
    expect(outcome.document.pages[1]?.panels).toEqual([])
    expect(outcome.document.pages[1]?.id).toBe(outcome.pageId)
  })

  it('names the page after its position, which is what the schema calls an unnamed one', () => {
    const outcome = addPage(documentOf({ id: 'overview', name: 'Overview' }))

    expect(names(outcome.document)).toEqual(['Overview', 'Page 2'])
  })

  it('skips a positional name the operator already used, rather than making two “Page 2” tabs', () => {
    const outcome = addPage(documentOf({ name: 'Overview' }, { name: 'Page 3' }))

    expect(names(outcome.document)).toEqual(['Overview', 'Page 3', 'Page 4'])
  })

  it('derives the id from the name, so the URL reads as the page did when it was made', () => {
    const outcome = addPage(documentOf({ id: 'overview', name: 'Overview' }), 'Training View')

    expect(outcome.pageId).toBe('training-view')
    expect(names(outcome.document)).toEqual(['Overview', 'Training View'])
  })

  it('never reuses an id, because two pages on one id is two pages at one URL', () => {
    const outcome = addPage(documentOf({ id: 'training-view', name: 'Training View' }), 'Training View')

    expect(outcome.pageId).toBe('training-view-2')
    expect(ids(outcome.document)).toEqual(['training-view', 'training-view-2'])
  })

  it('falls back to a positional id when the name has nothing a URL can carry', () => {
    const outcome = addPage(documentOf({ id: 'overview' }), '???')

    expect(outcome.pageId).toBe('page')
    expect(outcome.document.pages[1]?.name).toBe('???')
  })

  it('leaves the other pages untouched, panels and all', () => {
    const before = documentOf({ id: 'overview', name: 'Overview' })
    const outcome = addPage(before)

    expect(outcome.document.pages[0]).toBe(before.pages[0])
    expect(outcome.document.version).toBe(before.version)
  })
})

describe('renamePage', () => {
  it('renames the page named and nothing else', () => {
    const next = renamePage(documentOf({ id: 'a', name: 'Overview' }, { id: 'b', name: 'Logs' }), 'b', 'Debugging')

    expect(names(next)).toEqual(['Overview', 'Debugging'])
  })

  it('keeps the id, which is the whole point of the id being separate from the name', () => {
    const next = renamePage(documentOf({ id: 'overview', name: 'Overview' }), 'overview', 'Wall Display')

    expect(ids(next)).toEqual(['overview'])
  })

  it('trims what the operator typed', () => {
    const next = renamePage(documentOf({ id: 'a', name: 'Overview' }), 'a', '  Wall Display  ')

    expect(names(next)).toEqual(['Wall Display'])
  })

  it('refuses a blank name, because a page with no name has no tab to click', () => {
    const before = documentOf({ id: 'a', name: 'Overview' })

    expect(renamePage(before, 'a', '   ')).toBe(before)
  })

  it('is the same document back when no page has that id', () => {
    const before = documentOf({ id: 'a', name: 'Overview' })

    expect(renamePage(before, 'gone', 'Anything')).toBe(before)
  })
})

describe('removePage', () => {
  /** Narrows the outcome, so a spec reads the removal rather than the union. */
  function removed(document: DashboardDocument, pageId: string) {
    const outcome = removePage(document, pageId)
    if (outcome.status !== 'removed') throw new Error(`expected a removal, got ${outcome.status}`)
    return outcome
  }

  it('removes the page and lands on the one before it', () => {
    const outcome = removed(documentOf({ id: 'a' }, { id: 'b' }, { id: 'c' }), 'c')

    expect(ids(outcome.document)).toEqual(['a', 'b'])
    expect(outcome.nextPageId).toBe('b')
  })

  it('lands on the page after when the first one goes, so there is always somewhere to be', () => {
    expect(removed(documentOf({ id: 'a' }, { id: 'b' }), 'a').nextPageId).toBe('b')
  })

  it('refuses the last page, which would leave the dashboard with nothing to show', () => {
    expect(removePage(documentOf({ id: 'only' }), 'only')).toEqual({ status: 'last-page' })
  })

  it('changes nothing for a page the document does not have', () => {
    const outcome = removed(documentOf({ id: 'a' }, { id: 'b' }), 'gone')

    expect(ids(outcome.document)).toEqual(['a', 'b'])
    expect(outcome.nextPageId).toBe('a')
  })
})
