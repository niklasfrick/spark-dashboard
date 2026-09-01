import { useCallback, useMemo, useState } from 'react'
import { LiveMotionContext } from '@/hooks/useLiveMotion'
import { useElementSize } from '@/hooks/useElementSize'
import type { SaveOutcome } from '@/lib/dashboard/client'
import { applyLayoutChanges, refusedPanelTitle } from '@/lib/dashboard/editing'
import type { DashboardPage, DashboardPanel } from '@/lib/dashboard/schema'
import { EditModeBar } from './EditModeBar'
import { isNarrow } from './breakpoint'
import { GridPage, type GridEditing } from './GridPage'

/** An edit session: the page as the operator is rearranging it, and whatever
 *  the grid last refused them. */
interface EditSession {
  panels: DashboardPanel[]
  /** Id of the panel whose last drop had nowhere to go. */
  refusedPanelId: string | null
}

interface GridPageEditorProps {
  page: DashboardPage
  /** Nothing can be written on this instance; the standing banner says why. */
  readOnly: boolean
  onSave: (panels: DashboardPanel[]) => Promise<SaveOutcome['status']>
}

/**
 * A page, plus the ability to rearrange it.
 *
 * The session is a working copy that lives only here: the grid moves panels
 * inside it, and the stored configuration is untouched until the operator saves.
 * That is what makes discarding free, and it is the only thing standing between
 * an experimental drag and a layout every colleague on this instance loads.
 *
 * There is no undo. Discarding the session is the substitute — an undo stack
 * over a grid that reflows on collision is far deeper than what it would buy.
 */
export function GridPageEditor({ page, readOnly, onSave }: GridPageEditorProps) {
  const [session, setSession] = useState<EditSession | null>(null)
  const [saving, setSaving] = useState(false)
  const [containerRef, { width }] = useElementSize<HTMLDivElement>()
  // Below the breakpoint the grid stacks into one derived column, which is not
  // an arrangement anyone authored and must never be saved as one. A session
  // open when the window narrows is suspended rather than ended: the grid goes
  // static and saving is withheld, so the work is still there when the window
  // is wide again.
  const narrow = isNarrow(width)

  const onLayoutChange = useCallback<GridEditing['onLayoutChange']>((changes) => {
    setSession((current) =>
      current ? { ...current, panels: applyLayoutChanges(current.panels, changes) } : current,
    )
  }, [])

  const onGestureStart = useCallback(() => {
    // What the operator was told last was about the drag before this one.
    setSession((current) =>
      current?.refusedPanelId ? { ...current, refusedPanelId: null } : current,
    )
  }, [])

  const onOutOfRoom = useCallback((panelId: string) => {
    setSession((current) => (current ? { ...current, refusedPanelId: panelId } : current))
  }, [])

  // One object for the life of the editor, so a drag does not re-bind the
  // grid's event handlers on every cell it crosses.
  const editingApi = useMemo(
    (): GridEditing => ({ onLayoutChange, onGestureStart, onOutOfRoom }),
    [onLayoutChange, onGestureStart, onOutOfRoom],
  )

  const shown = useMemo(
    () => (session ? { ...page, panels: session.panels } : page),
    [page, session],
  )

  const save = useCallback(async () => {
    if (!session || saving) return
    setSaving(true)
    const status = await onSave(session.panels)
    setSaving(false)
    // A save the server did not take leaves the session open: the work is still
    // in the browser, and closing edit mode here would throw it away on the one
    // occasion the operator most needs to try again.
    if (status === 'saved') setSession(null)
  }, [session, saving, onSave])

  const refusedPanel = useMemo(
    () => refusedPanelTitle(shown.panels, session?.refusedPanelId ?? null),
    [shown, session?.refusedPanelId],
  )

  return (
    <div
      ref={containerRef}
      // Inline rather than Tailwind, for the same reason `GridPage` measures
      // itself inline: the height it hands down is what the grid divides into
      // rows, so the column has to hold up in the browser test project too,
      // which runs no Tailwind build.
      style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      <EditModeBar
        editing={session !== null}
        readOnly={readOnly}
        saving={saving}
        narrow={narrow}
        refusedPanel={refusedPanel}
        onBegin={() => setSession({ panels: page.panels, refusedPanelId: null })}
        onSave={() => void save()}
        onDiscard={() => setSession(null)}
      />

      {/* Everything below holds still while the page is being edited: no tab
          rotation, no counting, no chart or log redrawing under a panel in
          flight. */}
      <LiveMotionContext.Provider value={session === null}>
        <div style={{ flex: 1, minHeight: 0 }}>
          <GridPage page={shown} editing={session ? editingApi : undefined} />
        </div>
      </LiveMotionContext.Provider>
    </div>
  )
}
