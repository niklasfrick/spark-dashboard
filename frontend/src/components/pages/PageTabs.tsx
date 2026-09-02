import { useLayoutEffect, useState } from 'react'
import { useDismissablePopover } from '@/hooks/useDismissablePopover'
import { useElementSize } from '@/hooks/useElementSize'
import { pagePath } from '@/lib/dashboard/routes'
import type { DashboardPage } from '@/lib/dashboard/schema'
import { fitTabs, TAB_GAP } from './tabFit'

interface PageTabsProps {
  pages: readonly DashboardPage[]
  /** The page being viewed. Not necessarily one of `pages` — a URL can name a
   *  page that has since been deleted. */
  activePageId: string
  /**
   * A layout is being edited, so leaving the page would throw the session away.
   * The tabs stay visible and say where the operator is; they just do not go
   * anywhere until the edit is saved or discarded.
   */
  locked: boolean
  onSelect: (page: DashboardPage) => void
}

/**
 * The pages of this dashboard, as tabs in the masthead.
 *
 * Tabs rather than a sidebar: a sidebar costs horizontal space permanently, in a
 * layout whose entire premise is fitting the viewport, and on a wall display a
 * visible row of page names beats a dropdown nobody is standing close enough to
 * open. Tabs that do not fit move into a menu, so a dashboard with a dozen pages
 * degrades to a shorter strip rather than an unusable header.
 *
 * Every tab is a real link to the page's own URL, so middle-click, open-in-new-
 * tab and bookmarking all work; the click handler takes over only to avoid
 * reloading the application and dropping every metrics socket with it.
 */
export function PageTabs({ pages, activePageId, locked, onSelect }: PageTabsProps) {
  const [stripRef, strip] = useElementSize<HTMLDivElement>()
  // The natural width of every tab, measured off a hidden copy of the whole
  // strip. Measuring the *visible* tabs instead would be circular — hiding a tab
  // is what removes its width, so the widths would depend on the answer they are
  // the input to, and the strip would oscillate.
  const [measureRef, measured] = useElementSize<HTMLDivElement>()
  const [widths, setWidths] = useState<readonly number[]>([])

  useLayoutEffect(() => {
    const row = measureRef.current
    if (!row) return

    const next = Array.from(row.children).map((child) => (child as HTMLElement).offsetWidth)
    setWidths((current) => (sameWidths(current, next) ? current : next))
    // The measured row's own width stands in for everything that can change a
    // tab's width without changing the page list — a font finishing loading,
    // most of all.
  }, [pages, measured.width, measureRef])

  const activeIndex = pages.findIndex((page) => page.id === activePageId)
  const { visible, overflow } = fitTabs(
    // Before the first measurement every width is missing, which reads as
    // unmeasured and shows every tab — the same thing jsdom sees.
    pages.map((_, index) => widths[index] ?? 0),
    activeIndex,
    strip.width,
  )

  if (pages.length === 0) return null

  return (
    // Everything that decides a width is inline rather than Tailwind, for the
    // reason `GridPage` measures itself inline: the widths here are the input to
    // which tabs are shown, so they have to hold in the browser test project,
    // which runs no Tailwind build. The gap is the constant the fit is computed
    // from, so the strip and the arithmetic cannot drift apart. Colour, type and
    // radius stay in classes — nothing there changes a measurement.
    <nav aria-label="Pages" style={{ flex: 1, minWidth: 0 }}>
      <div ref={stripRef} style={ROW}>
        {/* Bare spans, not list items: a span measures its own content wherever
            it lands, while a block-level wrapper would measure the container
            it sits in and report every tab as full width. */}
        <div ref={measureRef} aria-hidden style={MEASURING_ROW}>
          {pages.map((page) => (
            <span key={page.id} className={tabClass(false)}>
              {page.name}
            </span>
          ))}
        </div>

        <ul style={{ display: 'flex', alignItems: 'center', gap: TAB_GAP }}>
          {visible.map((index) => (
            <li key={pages[index].id}>
              <PageLink
                page={pages[index]}
                active={index === activeIndex}
                locked={locked}
                onSelect={onSelect}
              />
            </li>
          ))}
        </ul>

        {overflow.length > 0 && (
          <OverflowMenu
            pages={overflow.map((index) => pages[index])}
            activePageId={activePageId}
            locked={locked}
            onSelect={onSelect}
          />
        )}
      </div>
    </nav>
  )
}

const ROW: React.CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  gap: TAB_GAP,
  // A tab is never half on screen: what does not fit is in the menu, not
  // clipped at the edge. The padding keeps that clip off the tabs themselves,
  // so an active tab's border is inside the box rather than on its boundary.
  paddingBlock: 2,
  overflow: 'hidden',
}

/**
 * The hidden copy every width is read off. Out of flow and at its natural width,
 * so it neither pushes the real strip around nor gets squeezed by it — a
 * measuring row that the container had already narrowed would measure the answer
 * rather than the question.
 */
const MEASURING_ROW: React.CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
  display: 'flex',
  gap: TAB_GAP,
  width: 'max-content',
  visibility: 'hidden',
  pointerEvents: 'none',
}

/** The pages that did not fit, behind one button, still one click away. */
function OverflowMenu({
  pages,
  activePageId,
  locked,
  onSelect,
}: {
  pages: readonly DashboardPage[]
  activePageId: string
  locked: boolean
  onSelect: (page: DashboardPage) => void
}) {
  const { open, setOpen, toggle, containerRef } = useDismissablePopover<HTMLDivElement>()

  return (
    <div ref={containerRef} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="text-[11px] px-2 py-1 rounded-md border border-white/[0.08] text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.06] transition-colors whitespace-nowrap"
      >
        {pages.length} more
      </button>

      {open && (
        <ul
          aria-label="More pages"
          className="absolute left-0 top-full z-20 mt-1 w-52 max-h-[60vh] overflow-y-auto rounded-md border border-white/[0.08] bg-[#0d0d10] p-1 shadow-xl"
        >
          {pages.map((page) => (
            <li key={page.id}>
              <PageLink
                page={page}
                active={page.id === activePageId}
                locked={locked}
                onSelect={(selected) => {
                  setOpen(false)
                  onSelect(selected)
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function PageLink({
  page,
  active,
  locked,
  onSelect,
}: {
  page: DashboardPage
  active: boolean
  locked: boolean
  onSelect: (page: DashboardPage) => void
}) {
  return (
    <a
      href={pagePath(page)}
      // The current page is announced as such rather than only coloured, so the
      // strip says where the operator is without relying on the accent green.
      aria-current={active ? 'page' : undefined}
      aria-disabled={locked || undefined}
      title={locked ? 'Save or discard your layout changes to switch pages.' : undefined}
      onClick={(event) => {
        // Never a full page load: the metrics socket, the history buffers and
        // the log connections all live above the router and must survive a page
        // switch. Modified clicks are left to the browser, which is the whole
        // reason these are links.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        if (!locked) onSelect(page)
      }}
      className={`${tabClass(active)} ${locked ? 'cursor-not-allowed opacity-50' : ''}`}
    >
      {page.name}
    </a>
  )
}

/**
 * One class list, so the hidden measuring row measures the tabs that ship.
 *
 * `block` is load-bearing, not styling. An inline anchor's vertical padding and
 * border hang outside its line box, so the strip — which clips what does not fit
 * — would cut the bottom off the tab the operator is on.
 */
function tabClass(active: boolean): string {
  return `block whitespace-nowrap rounded-md px-2.5 py-1 text-[11px] transition-colors ${
    active
      ? 'bg-[#76B900]/15 text-[#cfe98a] border border-[#76B900]/30'
      : 'border border-transparent text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.06]'
  }`
}

function sameWidths(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((width, index) => width === b[index])
}
