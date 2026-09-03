import { useElementSize } from '@/hooks/useElementSize'
import { useLatestSnapshot } from '@/hooks/useMetricsStore'
import { coreUsageColor } from '@/lib/theme'
import { usePanelDevice } from '../panelDevice'
import { coreGridLayout } from './mode'
import { PanelNotice } from './PanelNotice'
import type { CoreMetrics } from '@/types/metrics'

/**
 * Every CPU core's load at once, given the whole panel.
 *
 * The CPU panel already carries this grid as a strip under its chart, which is
 * enough to see *that* the load is uneven. This panel is for the question that
 * follows — which cores, and by how much — so the cells get the whole box and
 * label themselves once they are big enough to be read rather than only looked
 * at. Host-wide, so nothing binds to it.
 *
 * The layout decision lives in `mode.ts`, where it is testable without a layout
 * engine, on the same terms as the gauge panels' modes.
 */
export function CpuCoresPanel() {
  const snapshot = useLatestSnapshot()
  const [ref, size] = useElementSize<HTMLUListElement>()
  const cores = snapshot?.cpu.per_core ?? []
  const { columns, labelled } = coreGridLayout(size, cores.length)
  usePanelDevice(snapshot?.cpu.name)

  if (!snapshot) return <PanelNotice>Waiting for metrics</PanelNotice>
  if (cores.length === 0) return <PanelNotice>This host reports no per-core load.</PanelNotice>

  return (
    <ul
      ref={ref}
      aria-label="CPU cores"
      className="min-h-0 min-w-0 overflow-hidden grid gap-px"
      // Inline: the height must hold anywhere the component renders — including
      // the browser test project, which runs no Tailwind build — and the column
      // count is computed from the measured box, so it cannot be a class.
      style={{ height: '100%', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {cores.map((core) => (
        <CoreCell key={core.id} core={core} labelled={labelled} />
      ))}
    </ul>
  )
}

function CoreCell({ core, labelled }: { core: CoreMetrics; labelled: boolean }) {
  const percent = Math.round(core.usage_percent)

  return (
    <li
      // The title carries both readings at every size, so the cells that came
      // out too small to label are still identifiable on hover.
      title={`Core ${core.id}: ${percent}%`}
      className="min-w-0 min-h-0 rounded-[2px] overflow-hidden flex items-center justify-between px-1 transition-colors duration-300"
      style={{ backgroundColor: coreUsageColor(core.usage_percent) }}
    >
      {labelled && (
        <>
          <span className="text-[9px] font-mono text-zinc-100/70 truncate">{core.id}</span>
          <span className="text-[10px] font-mono font-semibold tabular-nums text-zinc-50 truncate">
            {percent}%
          </span>
        </>
      )}
    </li>
  )
}
