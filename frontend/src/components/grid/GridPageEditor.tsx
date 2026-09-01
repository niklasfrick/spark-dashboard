import { useCallback, useMemo, useState } from 'react'
import { LiveMotionContext } from '@/hooks/useLiveMotion'
import { useElementSize } from '@/hooks/useElementSize'
import type { PanelBinding } from '@/lib/dashboard/bindings'
import type { SaveOutcome } from '@/lib/dashboard/client'
import {
  addPanel,
  applyLayoutChanges,
  refusedPanelTitle,
  removePanel,
  renamePanel,
  repointPanel,
  setPanelWindow,
} from '@/lib/dashboard/editing'
import { defaultPanelTitle, type PanelType } from '@/lib/dashboard/panels'
import type { DashboardPage, DashboardPanel } from '@/lib/dashboard/schema'
import type { TimeWindow } from '@/types/events'
import { EditModeBar, type Refusal } from './EditModeBar'
import { PanelSettings } from './PanelSettings'
import { isNarrow } from './breakpoint'
import { GridPage, type GridEditing, type PanelChrome } from './GridPage'

/** What the page last had no room for: a drop the grid would not take, or a
 *  panel the palette could not place. */
type RefusedRequest =
  | { kind: 'drop'; panelId: string }
  | { kind: 'add'; type: PanelType }

/** An edit session: the page as the operator is changing it, whatever the page
 *  last refused them, and which panel's settings are open. */
interface EditSession {
  panels: DashboardPanel[]
  refused: RefusedRequest | null
  configuringId: string | null
}

interface GridPageEditorProps {
  page: DashboardPage
  /** Nothing can be written on this instance; the standing banner says why. */
  readOnly: boolean
  onSave: (panels: DashboardPanel[]) => Promise<SaveOutcome['status']>
}

/**
 * A page, plus the ability to change it: where the panels sit, which panels
 * there are at all, and what each one is.
 *
 * The session is a working copy that lives only here: the grid moves panels
 * inside it, the palette adds to it and the settings row edits it, and the
 * stored configuration is untouched until the operator saves. That is what
 * makes discarding free, and it is the only thing standing between an
 * experimental layout and one every colleague on this instance loads.
 *
 * There is no undo. Discarding the session is the substitute — an undo stack
 * over a grid that reflows on collision is far deeper than what it would buy —
 * which is also why removing a panel is behind its settings rather than one
 * click on the frame.
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
    setSession((current) => (current?.refused ? { ...current, refused: null } : current))
  }, [])

  const onOutOfRoom = useCallback((panelId: string) => {
    setSession((current) =>
      current ? { ...current, refused: { kind: 'drop', panelId } } : current,
    )
  }, [])

  // One object for the life of the editor, so a drag does not re-bind the
  // grid's event handlers on every cell it crosses.
  const editingApi = useMemo(
    (): GridEditing => ({ onLayoutChange, onGestureStart, onOutOfRoom }),
    [onLayoutChange, onGestureStart, onOutOfRoom],
  )

  const add = useCallback((type: PanelType) => {
    setSession((current) => {
      if (!current) return current
      const outcome = addPanel(current.panels, type)

      return outcome.status === 'added'
        ? { ...current, panels: outcome.panels, refused: null }
        : { ...current, refused: { kind: 'add', type } }
    })
  }, [])

  /** One edit to the panel whose settings are open. */
  const editConfigured = useCallback(
    (edit: (panels: DashboardPanel[], panelId: string) => DashboardPanel[]) => {
      setSession((current) =>
        current?.configuringId
          ? { ...current, panels: edit(current.panels, current.configuringId) }
          : current,
      )
    },
    [],
  )

  const remove = useCallback(() => {
    // The settings close with the panel: there is nothing left to configure,
    // and a refusal about it is no longer about anything.
    setSession((current) =>
      current?.configuringId
        ? {
            panels: removePanel(current.panels, current.configuringId),
            configuringId: null,
            refused: null,
          }
        : current,
    )
  }, [])

  const chrome = useMemo(
    (): PanelChrome => ({
      configuringId: session?.configuringId ?? null,
      onConfigure: (panelId) =>
        setSession((current) =>
          current
            ? { ...current, configuringId: current.configuringId === panelId ? null : panelId }
            : current,
        ),
    }),
    [session?.configuringId],
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

  const refused = useMemo((): Refusal | null => {
    const request = session?.refused
    if (!request) return null
    if (request.kind === 'add') return { kind: 'add', title: defaultPanelTitle(request.type) }

    const title = refusedPanelTitle(shown.panels, request.panelId)
    return title ? { kind: 'drop', title } : null
  }, [shown, session?.refused])

  const configured = session?.configuringId
    ? shown.panels.find((panel) => panel.id === session.configuringId)
    : undefined

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
        refused={refused}
        onBegin={() => setSession({ panels: page.panels, refused: null, configuringId: null })}
        onAdd={add}
        onSave={() => void save()}
        onDiscard={() => setSession(null)}
      />

      {/* Everything below holds still while the page is being edited: no tab
          rotation, no counting, no chart or log redrawing under a panel in
          flight — and no target appearing in the settings row's own lists
          while the operator is choosing between them. */}
      <LiveMotionContext.Provider value={session === null}>
        {configured && (
          <PanelSettings
            // Keyed by the panel, so opening another one's settings starts its
            // title field from that panel rather than from the last.
            key={configured.id}
            panel={configured}
            onRename={(title) => editConfigured((panels, id) => renamePanel(panels, id, title))}
            onWindowChange={(window: TimeWindow) =>
              editConfigured((panels, id) => setPanelWindow(panels, id, window))
            }
            onRepoint={(binding: PanelBinding) =>
              editConfigured((panels, id) => repointPanel(panels, id, binding))
            }
            onRemove={remove}
            onClose={() =>
              setSession((current) => (current ? { ...current, configuringId: null } : current))
            }
          />
        )}

        <div style={{ flex: 1, minHeight: 0 }}>
          <GridPage
            page={shown}
            editing={session ? editingApi : undefined}
            chrome={session ? chrome : undefined}
          />
        </div>
      </LiveMotionContext.Provider>
    </div>
  )
}
