import { describe, expect, it } from 'vitest'
import { pagePath, pageSlug, parseRoute } from './routes'

describe('parseRoute', () => {
  it('routes the root to whichever page comes first', () => {
    expect(parseRoute('/')).toEqual({ kind: 'first-page' })
  })

  it('routes a page URL to that page by id', () => {
    expect(parseRoute('/pages/overview')).toEqual({ kind: 'page', pageId: 'overview' })
  })

  it('ignores the slug — only the id matches, so a rename breaks no bookmark', () => {
    expect(parseRoute('/pages/abc123/training-view')).toEqual({ kind: 'page', pageId: 'abc123' })
    expect(parseRoute('/pages/abc123/completely-stale-slug')).toEqual({
      kind: 'page',
      pageId: 'abc123',
    })
  })

  it('tolerates a trailing slash', () => {
    expect(parseRoute('/pages/overview/')).toEqual({ kind: 'page', pageId: 'overview' })
  })

  it('decodes an id that needed URL encoding', () => {
    expect(parseRoute('/pages/page%202')).toEqual({ kind: 'page', pageId: 'page 2' })
  })

  it('routes every path that names nothing to the first page, as the server-side shell always did', () => {
    expect(parseRoute('/pages')).toEqual({ kind: 'first-page' })
    expect(parseRoute('/pages/')).toEqual({ kind: 'first-page' })
    expect(parseRoute('/settings')).toEqual({ kind: 'first-page' })
    expect(parseRoute('/index.html')).toEqual({ kind: 'first-page' })
  })
})

describe('pagePath', () => {
  it('builds an id-plus-slug URL that parses back to the same page', () => {
    const page = { id: 'p-7f3a', name: 'Training View' }
    expect(pagePath(page)).toBe('/pages/p-7f3a/training-view')
    expect(parseRoute(pagePath(page))).toEqual({ kind: 'page', pageId: 'p-7f3a' })
  })

  it('drops a slug that only repeats the id', () => {
    expect(pagePath({ id: 'overview', name: 'Overview' })).toBe('/pages/overview')
  })

  it('drops a slug the name has nothing usable for', () => {
    expect(pagePath({ id: 'p-1', name: '???' })).toBe('/pages/p-1')
  })

  it('encodes an id that cannot sit in a path verbatim', () => {
    const page = { id: 'page 2', name: 'Wall Display' }
    expect(pagePath(page)).toBe('/pages/page%202/wall-display')
    expect(parseRoute(pagePath(page))).toEqual({ kind: 'page', pageId: 'page 2' })
  })
})

describe('pageSlug', () => {
  it('lowercases and dashes a human name', () => {
    expect(pageSlug('Training View')).toBe('training-view')
  })

  it('collapses runs of punctuation and trims the edges', () => {
    expect(pageSlug('  GPU / Engine — watch!  ')).toBe('gpu-engine-watch')
  })

  it('keeps letters beyond ASCII rather than mangling them', () => {
    expect(pageSlug('Übersicht')).toBe('übersicht')
  })

  it('is empty when nothing usable remains', () => {
    expect(pageSlug('!!!')).toBe('')
  })
})
