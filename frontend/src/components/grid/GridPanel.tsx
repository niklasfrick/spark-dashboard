import { Settings2, X } from 'lucide-react'
import { useState } from 'react'
import { isKnownPanelType } from '@/lib/dashboard/panels'
import { panelTitle, type DashboardPanel } from '@/lib/dashboard/schema'
import { PanelDeviceContext } from './panelDevice'
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
 * that is where the panel's own settings and removal live; the grid library
 * declines to start a drag on a button, so the two do not fight.
 */
export function GridPanel({
  panel,
  editing = false,
  configuring = false,
  onConfigure,
  onRemove,
}: {
  panel: DashboardPanel
  editing?: boolean
  /** This panel's settings are the ones open, so its frame says so. */
  configuring?: boolean
  onConfigure?: () => void
  onRemove?: () => void
}) {
  const title = panelTitle(panel)
  // Reported up by the content, which is the only thing that knows what its
  // binding resolved to — see `panelDevice`.
  const [device, setDevice] = useState<string | null>(null)

  return (
    <section
      aria-label={title}
      className={`h-full min-h-0 flex flex-col rounded-md border bg-[#151519] px-2 py-1.5 overflow-hidden ${
        editing ? 'cursor-move select-none' : ''
      } ${editing ? (configuring ? 'border-[#76B900]' : 'border-[#76B900]/40') : 'border-white/[0.04]'}`}
    >
      <div className="shrink-0 flex items-center gap-1">
        <h3 className="shrink-0 text-[11px] font-semibold text-zinc-200 truncate">{title}</h3>
        {/* The hardware, beside the name of the metric — the title never gives
            up room for it, and it truncates away to nothing on a panel too
            narrow to hold both. The separator sits inside the span so the two
            disappear together rather than leaving a stray dot. */}
        {device && (
          <span
            className="flex-1 min-w-0 truncate text-[10px] text-zinc-500"
            title={device}
          >
            <span className="text-zinc-600">·</span> {device}
          </span>
        )}
        {editing && onConfigure && (
          <button
            type="button"
            aria-label={`Configure ${title}`}
            onClick={onConfigure}
            className={`ml-auto shrink-0 rounded p-0.5 transition-colors ${
              configuring ? 'text-[#76B900]' : 'text-zinc-500 hover:text-zinc-200'
            }`}
          >
            <Settings2 aria-hidden="true" className="w-3 h-3" />
          </button>
        )}
        {editing && onRemove && (
          <button
            type="button"
            aria-label={`Remove ${title}`}
            onClick={onRemove}
            className={`${onConfigure ? '' : 'ml-auto '}shrink-0 rounded p-0.5 text-red-500 hover:text-red-400 transition-colors`}
          >
            <X aria-hidden="true" className="w-3 h-3" />
          </button>
        )}
      </div>
      <div className={`flex-1 min-h-0 min-w-0 ${editing ? 'pointer-events-none' : ''}`}>
        <PanelDeviceContext.Provider value={setDevice}>
          {renderPanelContent(panel) ?? <PanelPlaceholder type={panel.type} />}
        </PanelDeviceContext.Provider>
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
