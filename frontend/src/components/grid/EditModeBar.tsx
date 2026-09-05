import type { ReactNode } from 'react'
import { GRID_MAX_ROWS } from '@/lib/dashboard/grid'
import type { PanelType } from '@/lib/dashboard/panels'
import { BarButton } from './BarButton'
import { PanelPalette } from './PanelPalette'

/**
 * Something the page had no room for, named by the title the operator reads.
 *
 * A drop and an addition are told apart because the advice differs: a refused
 * drag has somewhere else to go, while a panel that will not fit anywhere needs
 * room made for it first.
 */
export interface Refusal {
  kind: 'drop' | 'add'
  title: string
}

interface EditModeBarProps {
  editing: boolean
  /** No save can succeed on this instance; the standing banner says why. */
  readOnly: boolean
  /** A save is in flight, so the session must not be written twice. */
  saving: boolean
  /**
   * The page is stacked into one column, where a drag would author a layout
   * that has nothing to do with the desktop arrangement being edited.
   */
  narrow: boolean
  /** What the page would not take, or null when nothing stands refused. */
  refused: Refusal | null
  /**
   * The page-level configuration control, shown beside “Edit layout”. Withheld
   * while a session is open: a source change writes the document immediately,
   * and mid-session the document under the unsaved panels must hold still.
   */
  pageConfig?: ReactNode
  onBegin: () => void
  onAdd: (type: PanelType) => void
  onSave: () => void
  onDiscard: () => void
}

/**
 * The one affordance that turns a page from something you read into something
 * you rearrange, and the only place a layout is written from.
 *
 * Edit mode is explicit because the alternative is not: with panels that are
 * interactive on every pixel — chart tooltips, log filters, engine tabs — an
 * always-draggable grid fights all of them, and a stray drag would rewrite a
 * configuration everyone on this instance shares. For the same reason there is
 * no autosave: an intermediate drag position must never become what a colleague
 * loads.
 */
export function EditModeBar({
  editing,
  readOnly,
  saving,
  narrow,
  refused,
  pageConfig,
  onBegin,
  onAdd,
  onSave,
  onDiscard,
}: EditModeBarProps) {
  return (
    <div className="shrink-0 flex items-center justify-between gap-3 pb-2 min-h-7">
      <Status editing={editing} narrow={narrow} readOnly={readOnly} refused={refused} />

      <div className="flex items-center gap-2">
        {editing ? (
          <>
            {/* The rule for the collapsed column is about *cells*, not about
                editing: adding chooses a slot, so it is withheld there exactly
                as a drag is, and the operator is not placing panels into a
                layout they cannot see. What a panel *is* — its title, window
                and source — is not geometry, so its settings stay available at
                any width. */}
            {!narrow && <PanelPalette onAdd={onAdd} />}
            <BarButton onClick={onDiscard} disabled={saving}>
              Discard
            </BarButton>
            {/* Narrow suspends the session rather than ending it: the stacked
                column is not the layout being edited, so there is nothing there
                worth writing, and the work survives until the window is wide
                again. */}
            <BarButton primary onClick={onSave} disabled={readOnly || saving || narrow}>
              {saving ? 'Saving…' : 'Save layout'}
            </BarButton>
          </>
        ) : (
          <>
            {/* Unlike editing, the page's configuration is not geometry, so it
                stays available on the stacked column too. */}
            {pageConfig}
            {!narrow && <BarButton onClick={onBegin}>Edit layout</BarButton>}
          </>
        )}
      </div>
    </div>
  )
}

function Status({
  editing,
  narrow,
  readOnly,
  refused,
}: Pick<EditModeBarProps, 'editing' | 'narrow' | 'readOnly' | 'refused'>) {
  // The refusal outranks everything else the bar could be saying: it is the
  // answer to what the operator just tried to do. It is an alert rather than a
  // quiet status because the alternative — a panel that slides back, or one
  // that never appears, with no explanation — reads as a broken interaction
  // rather than as a page with no room.
  if (refused) {
    return (
      <p role="alert" className="text-xs text-amber-300 truncate">
        {/* One sentence of fact, then the advice, which is the only half that
            differs. What the drop message says is only what is certain: the
            grid refuses a drop it cannot fit under the row cap *and* one the
            panels around it cannot make way for, and this side cannot tell
            which — so the wording covers both. */}
        No room for “{refused.title}”{refused.kind === 'drop' ? ' there' : ' on this page'}. The
        page is {GRID_MAX_ROWS} rows tall{' '}
        {refused.kind === 'drop'
          ? 'and the panels around it cannot make way — try somewhere else, or make one of them smaller.'
          : 'and has no free space that size — remove a panel, or make one smaller, and add it again.'}
      </p>
    )
  }

  if (narrow) {
    return (
      <p className="text-xs text-zinc-500 truncate">
        Panels are stacked to fit this screen. Rearranging needs a wider window.
      </p>
    )
  }

  if (!editing) return <span />

  return (
    <p className="text-xs text-zinc-400 truncate">
      {readOnly
        ? 'This dashboard is read-only, so a rearranged layout cannot be saved.'
        : 'Drag a panel to move it, or its bottom-right corner to resize it. Nothing is saved until you save.'}
    </p>
  )
}
