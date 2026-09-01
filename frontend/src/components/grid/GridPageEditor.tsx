import { useCallback, useMemo, useState } from 'react'
import { LiveMotionContext } from '@/hooks/useLiveMotion'
import { useElementSize } from '@/hooks/useElementSize'
import type { SaveOutcome } from '@/lib/dashboard/client'
import { applyLayoutChanges } from '@/lib/dashboard/editing'
import { panelTitle, type DashboardPage, type DashboardPanel } from '@/lib/dashboard/schema'
import { EditModeBar } from './EditModeBar'
import { GridPage, SINGLE_COLUMN_BREAKPOINT, type GridEditing } from './GridPage'

/** An edit session: the page as the operator is rearranging it, and whatever
 *  the grid last refused them. */
interface EditSession {
  panels: DashboardPanel[]
  /** Id of the panel whose last drop had nowhere to go. */
  refused: string | null
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
  // an arrangement anyone authored and must never be saved as one.
  const narrow = width > 0 && width <= SINGLE_COLUMN_BREAKPOINT

  const onLayoutChange = useCallback<GridEditing['onLayoutChange']>((changes) => {
    setSession((current) =>
      current ? { ...current, panels: applyLayoutChanges(current.panels, changes) } : current,
    )
  }, [])

  const onGestureStart = useCallback(() => {
    // What the operator was told last was about the drag before this one.
    setSession((current) => (current?.refused ? { ...current, refused: null } : current))
  }, [])

  const onOutOfRoom = useCallback((panelId: string) => {
    setSession((current) => (current ? { ...current, refused: panelId } : current))
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

  const refusedPanel = session?.refused
    ? (shown.panels.find((panel) => panel.id === session.refused) ?? null)
    : null

  return (
    <div ref={containerRef} className="h-full flex flex-col min-h-0">
      <EditModeBar
        editing={session !== null}
        readOnly={readOnly}
        saving={saving}
        narrow={narrow}
        refusedPanel={refusedPanel && panelTitle(refusedPanel)}
        onBegin={() => setSession({ panels: page.panels, refused: null })}
        onSave={() => void save()}
        onDiscard={() => setSession(null)}
      />

      {/* Everything below holds still while the page is being edited: no tab
          rotation, no counting, no chart redrawing under a panel in flight. */}
      <LiveMotionContext.Provider value={session === null}>
        <div className="flex-1 min-h-0">
          <GridPage page={shown} editing={session ? editingApi : undefined} />
        </div>
      </LiveMotionContext.Provider>
    </div>
  )
}
