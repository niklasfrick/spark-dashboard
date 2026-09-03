import { useState } from 'react'
import { navigateTo, replacePath } from '@/hooks/useRoute'
import type { ResetOutcome, SaveOutcome } from '@/lib/dashboard/client'
import { addPage, canRemovePage, removePage, renamePage } from '@/lib/dashboard/pages'
import { defaultDashboardDocument } from '@/lib/dashboard/preset'
import { pagePath } from '@/lib/dashboard/routes'
import type { DashboardDocument } from '@/lib/dashboard/schema'
import { PagesMenu } from './PagesMenu'
import { PageTabs } from './PageTabs'

interface PageBarProps {
  document: DashboardDocument
  /** The page the URL names. Not necessarily one the document still has. */
  activePageId: string
  /** Nothing can be written on this instance; the standing banner says why. */
  readOnly: boolean
  /** A layout edit session is open on the page being viewed. */
  editing: boolean
  save: (document: DashboardDocument) => Promise<SaveOutcome['status']>
  reset: () => Promise<ResetOutcome['status']>
}

/**
 * The page list in the header, and everything an operator does to it.
 *
 * This is where the rule that a page edit is **written immediately** is carried
 * out — see `lib/dashboard/pages` for why — and where each one decides where the
 * operator ends up afterwards. Navigation and persistence are deliberately in
 * the same place: a page that is created and not navigated to is invisible, and
 * one that is navigated to before the write lands would 404 on a reload.
 *
 * **Nothing moves until the write is accepted.** A failed save leaves the
 * operator on the page they were on, looking at the banner the save path already
 * raises, rather than at a page that does not exist on the server.
 *
 * The whole bar goes quiet while a layout is being edited. The edit session
 * lives in the page below and dies with it, so leaving mid-edit would silently
 * discard work the operator has been told is unsaved — and the way out is the
 * Save and Discard buttons that are already on screen.
 */
export function PageBar({ document, activePageId, readOnly, editing, save, reset }: PageBarProps) {
  // A second page write while the first is in flight would race it, and the
  // loser would be written from a document that never had the winner's page.
  const [busy, setBusy] = useState(false)
  const page = document.pages.find((candidate) => candidate.id === activePageId)

  async function run(work: () => Promise<void>): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      await work()
    } finally {
      setBusy(false)
    }
  }

  /** Goes to a page of `next`, which is the document the server just took. */
  function go(next: DashboardDocument, pageId: string, replace = false): void {
    const target = next.pages.find((candidate) => candidate.id === pageId)
    if (!target) return
    ;(replace ? replacePath : navigateTo)(pagePath(target))
  }

  const create = () =>
    run(async () => {
      const { document: next, pageId } = addPage(document)
      if ((await save(next)) === 'saved') go(next, pageId)
    })

  const rename = (name: string) =>
    run(async () => {
      const next = renamePage(document, activePageId, name)
      if (next === document) return
      // Replace rather than push: the page has not changed, only the slug that
      // describes it, so back should leave the page rather than undo a rename.
      if ((await save(next)) === 'saved') go(next, activePageId, true)
    })

  const remove = () =>
    run(async () => {
      const outcome = removePage(document, activePageId)
      if (outcome.status !== 'removed') return
      if ((await save(outcome.document)) === 'saved') go(outcome.document, outcome.nextPageId)
    })

  const resetEverything = () =>
    run(async () => {
      if ((await reset()) !== 'reset') return
      // The stored document is gone, so what renders now is the preset — and
      // whatever page the operator was on is very likely not one of its pages.
      const first = defaultDashboardDocument().pages[0]
      if (first) navigateTo(pagePath(first))
    })

  return (
    <>
      <PageTabs
        pages={document.pages}
        activePageId={activePageId}
        locked={editing || busy}
        onSelect={(selected) => navigateTo(pagePath(selected))}
      />

      {/* No menu without a page to act on: the URL names one the document does
          not have, and the tabs beside it are the way back to one that exists. */}
      {page && (
        <PagesMenu
          page={page}
          canDelete={canRemovePage(document)}
          readOnly={readOnly}
          locked={editing}
          busy={busy}
          onCreate={create}
          onRename={rename}
          onDelete={remove}
          onResetEverything={resetEverything}
        />
      )}
    </>
  )
}
