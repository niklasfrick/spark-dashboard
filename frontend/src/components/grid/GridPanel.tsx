import { isKnownPanelType } from '@/lib/dashboard/panels'
import { panelTitle, type DashboardPanel } from '@/lib/dashboard/schema'
import { renderPanelContent } from './panelRegistry'

/**
 * One panel on the grid: the product's card chrome around whatever the type's
 * registered component renders. When nothing is registered the frame stays and
 * a placeholder says why — a panel must keep its slot rather than break the
 * page or silently vanish, because the layout around it is something the
 * operator authored.
 */
export function GridPanel({ panel }: { panel: DashboardPanel }) {
  return (
    <section
      aria-label={panelTitle(panel)}
      className="h-full min-h-0 flex flex-col rounded-md border border-white/[0.04] bg-[#151519] px-2 py-1.5 overflow-hidden"
    >
      <h3 className="shrink-0 text-[11px] font-semibold text-zinc-200 truncate">
        {panelTitle(panel)}
      </h3>
      <div className="flex-1 min-h-0 min-w-0">
        {renderPanelContent(panel) ?? <PanelPlaceholder type={panel.type} />}
      </div>
    </section>
  )
}

/**
 * The two ways a panel can have no content, told apart because the operator's
 * next move differs: an unknown type means this build was rolled back past the
 * one that created the panel, while a known type without a component is simply
 * not built yet (#80–#82) and needs no action at all.
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
