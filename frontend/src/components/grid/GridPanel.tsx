import { Settings2 } from 'lucide-react'
import { isKnownPanelType } from '@/lib/dashboard/panels'
import { panelTitle, type DashboardPanel } from '@/lib/dashboard/schema'
import { renderPanelContent } from './panelRegistry'

/**
 * One panel on the grid: the product's card chrome around whatever the type's
 * registered component renders. When nothing is registered the frame stays and
 * a placeholder says why — a panel must keep its slot rather than break the
 * page or silently vanish, because the layout around it is something the
 * operator authored.
 *
 * In edit mode the frame says it is draggable, and its contents stop taking the
 * pointer — the drag would start either way, since the grid listens on the frame
 * and the event bubbles, but a chart that pops a tooltip under a panel in flight
 * is noise the operator did not ask for. The header keeps its pointer, because
 * that is where the panel's own settings are opened from; the grid library
 * declines to start a drag on a button, so the two do not fight.
 */
export function GridPanel({
  panel,
  editing = false,
  configuring = false,
  onConfigure,
}: {
  panel: DashboardPanel
  editing?: boolean
  /** This panel's settings are the ones open, so its frame says so. */
  configuring?: boolean
  onConfigure?: () => void
}) {
  const title = panelTitle(panel)

  return (
    <section
      aria-label={title}
      className={`h-full min-h-0 flex flex-col rounded-md border bg-[#151519] px-2 py-1.5 overflow-hidden ${
        editing ? 'cursor-move select-none' : ''
      } ${editing ? (configuring ? 'border-[#76B900]' : 'border-[#76B900]/40') : 'border-white/[0.04]'}`}
    >
      <div className="shrink-0 flex items-center gap-1">
        <h3 className="flex-1 min-w-0 text-[11px] font-semibold text-zinc-200 truncate">{title}</h3>
        {editing && onConfigure && (
          <button
            type="button"
            aria-label={`Configure ${title}`}
            onClick={onConfigure}
            className={`shrink-0 rounded p-0.5 transition-colors ${
              configuring ? 'text-[#76B900]' : 'text-zinc-500 hover:text-zinc-200'
            }`}
          >
            <Settings2 aria-hidden="true" className="w-3 h-3" />
          </button>
        )}
      </div>
      <div className={`flex-1 min-h-0 min-w-0 ${editing ? 'pointer-events-none' : ''}`}>
        {renderPanelContent(panel) ?? <PanelPlaceholder type={panel.type} />}
      </div>
    </section>
  )
}

/**
 * The two ways a panel can have no content, told apart because the operator's
 * next move differs: an unknown type means this build was rolled back past the
 * one that created the panel, while a known type without a component is simply
 * not built yet and needs no action at all.
 */
function PanelPlaceholder({ type }: { type: string }) {
  return (
    <div className="h-full flex items-center justify-center text-center">
      <p className="text-xs text-zinc-500">
        {isKnownPanelType(type)
          ? 'This panel is not available yet.'
          : `This version of the dashboard cannot render a “${type}” panel.`}
      </p>
    </div>
  )
}
