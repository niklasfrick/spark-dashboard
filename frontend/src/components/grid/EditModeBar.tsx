import { GRID_MAX_ROWS } from '@/lib/dashboard/grid'

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
  /** The panel whose last drop the grid would not take, by the title the
   *  operator reads. */
  refusedPanel: string | null
  onBegin: () => void
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
  refusedPanel,
  onBegin,
  onSave,
  onDiscard,
}: EditModeBarProps) {
  return (
    <div className="shrink-0 flex items-center justify-between gap-3 pb-2 min-h-7">
      <Status editing={editing} narrow={narrow} readOnly={readOnly} refusedPanel={refusedPanel} />

      <div className="flex items-center gap-2">
        {editing ? (
          <>
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
          !narrow && <BarButton onClick={onBegin}>Edit layout</BarButton>
        )}
      </div>
    </div>
  )
}

function Status({
  editing,
  narrow,
  readOnly,
  refusedPanel,
}: Pick<EditModeBarProps, 'editing' | 'narrow' | 'readOnly' | 'refusedPanel'>) {
  // The refusal outranks everything else the bar could be saying: it is the
  // answer to what the operator just tried to do. It is an alert rather than a
  // quiet status because the alternative — a panel that slides back with no
  // explanation — reads as a broken drag rather than as a page with no room.
  //
  // It says only what is certain. The grid refuses a drop it cannot fit under
  // the row cap *and* one the panels around it cannot make way for, and this
  // side cannot tell which — so the wording covers both and the advice works
  // for either.
  if (refusedPanel) {
    return (
      <p role="alert" className="text-xs text-amber-300 truncate">
        No room for “{refusedPanel}” there. The page is {GRID_MAX_ROWS} rows tall and the panels
        around it cannot make way — try somewhere else, or make one of them smaller.
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

function BarButton({
  primary = false,
  disabled = false,
  onClick,
  children,
}: {
  primary?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`text-[10px] uppercase tracking-wider px-2 py-1 rounded border transition-colors ${
        disabled
          ? 'border-white/[0.04] text-zinc-600 cursor-not-allowed opacity-60'
          : primary
            ? 'bg-[#76B900]/20 hover:bg-[#76B900]/30 border-[#76B900]/40 text-[#cfe98a]'
            : 'border-white/[0.08] text-zinc-300 hover:bg-white/[0.06]'
      }`}
    >
      {children}
    </button>
  )
}
