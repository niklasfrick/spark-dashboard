import { describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { PageTabs } from '@/components/pages/PageTabs'
import type { DashboardPage } from '@/lib/dashboard/schema'

// The tab strip in a real layout engine: the #85 acceptance criterion that
// depends on measurement. Which tabs fit is decided from measured widths on a
// ResizeObserver path, and jsdom measures every box as 0×0 — so in the unit
// project every tab always fits and the overflow menu never appears at all.
// Without this spec, a strip that hid every tab, or none, would pass there.
//
// Tailwind classes do not apply here (the browser project runs no Tailwind
// build), so a tab is as wide as its text and nothing else. That is fine and
// deliberate: the assertions are about which tabs are reachable, never about
// pixel counts.

function pages(count: number): DashboardPage[] {
  return Array.from({ length: count }, (_, index) => ({
    // Long names, so a handful of them exceed any reasonable strip.
    id: `page-${index + 1}`,
    name: `Arrangement number ${index + 1} for the wall display`,
    panels: [],
  }))
}

function Harness({ width, list, activePageId }: {
  width: number
  list: DashboardPage[]
  activePageId: string
}) {
  return (
    <div style={{ width, display: 'flex' }}>
      <PageTabs pages={list} activePageId={activePageId} locked={false} onSelect={() => {}} />
    </div>
  )
}

/** The tabs on the strip — the menu's own links are inside its list, not here. */
function stripTabs(): string[] {
  const menu = screen.queryByRole('list', { name: 'More pages' })

  return within(screen.getByRole('navigation', { name: 'Pages' }))
    .getAllByRole('link')
    .filter((tab) => !menu?.contains(tab))
    .map((tab) => tab.textContent ?? '')
}

const overflowButton = () => screen.queryByRole('button', { name: /more$/ })

/**
 * Waits for the strip to have been measured and re-rendered on it.
 *
 * Before the first ResizeObserver callback every width is unknown, which reads
 * as "everything fits" — so an assertion made too early passes on the
 * unmeasured state and proves nothing. Two frames covers the observer (which
 * runs after layout, before paint) and the render it causes.
 */
async function measured(): Promise<void> {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}

describe('the page tabs in a real layout engine', () => {
  it('shows every page when the header has room, with no menu to open', async () => {
    const list = pages(3)
    render(<Harness width={2000} list={list} activePageId="page-1" />)
    await measured()

    expect(stripTabs()).toHaveLength(3)
    expect(overflowButton()).toBeNull()
  })

  it('moves the tabs that do not fit into a menu, and keeps them one click away', async () => {
    const list = pages(8)
    render(<Harness width={600} list={list} activePageId="page-1" />)

    await waitFor(() => expect(overflowButton()).not.toBeNull())

    const visible = stripTabs()
    expect(visible.length).toBeGreaterThan(0)
    expect(visible.length).toBeLessThan(8)

    // Nothing is lost: the strip and the menu together are still every page.
    overflowButton()!.click()
    const hidden = within(await screen.findByRole('list', { name: 'More pages' }))
      .getAllByRole('link')
      .map((tab) => tab.textContent ?? '')
    expect([...visible, ...hidden].sort()).toEqual(list.map((page) => page.name).sort())
  })

  it('never lets the strip run past the header it sits in', async () => {
    render(<Harness width={600} list={pages(8)} activePageId="page-1" />)
    await waitFor(() => expect(overflowButton()).not.toBeNull())

    const nav = screen.getByRole('navigation', { name: 'Pages' }).getBoundingClientRect()
    const rightmost = Math.max(
      ...within(screen.getByRole('navigation', { name: 'Pages' }))
        .getAllByRole('link')
        .map((tab) => tab.getBoundingClientRect().right),
      overflowButton()!.getBoundingClientRect().right,
    )

    expect(rightmost).toBeLessThanOrEqual(nav.right + 1)
  })

  it('keeps the page being viewed on the strip when it sits past the fold', async () => {
    // The last of eight, which no prefix of the list would ever reach.
    render(<Harness width={600} list={pages(8)} activePageId="page-8" />)

    // The overflow button first: it is what proves the strip has been measured,
    // and before that every tab is on it for want of a reason not to be.
    await waitFor(() => expect(overflowButton()).not.toBeNull())
    expect(stripTabs()).toContain('Arrangement number 8 for the wall display')
  })

  it('gives the tabs back when the header is widened again', async () => {
    const list = pages(8)
    const { rerender } = render(<Harness width={600} list={list} activePageId="page-1" />)
    await waitFor(() => expect(overflowButton()).not.toBeNull())

    rerender(<Harness width={4000} list={list} activePageId="page-1" />)

    await waitFor(() => expect(stripTabs()).toHaveLength(8))
    expect(overflowButton()).toBeNull()
  })
})
