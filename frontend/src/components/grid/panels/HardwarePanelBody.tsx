import type { ReactNode } from 'react'
import { useElementSize } from '@/hooks/useElementSize'
import { gaugeSizePx, hardwarePanelMode } from './mode'

interface HardwarePanelBodyProps {
  /** The value-only rendering for a box too short to chart in. */
  compact: ReactNode
  /** The gauge column, given its square size in px. Omitted for panels whose
   *  full rendering is chart-only. */
  gauge?: (sizePx: number) => ReactNode
  /** The trend chart; fills whatever the gauge column leaves. */
  chart: ReactNode
  /** Rendered under the chart row in `full` mode only (e.g. the core heatmap). */
  below?: ReactNode
}

/**
 * The shared body of every hardware panel: measures its own box and swaps
 * between the full gauge-and-chart rendering, a chart-only rendering for
 * narrow boxes, and the compact value-only rendering for short ones. Panels
 * supply the pieces; the mode decision lives in `mode.ts` where it is testable
 * without a layout engine.
 */
export function HardwarePanelBody({ compact, gauge, chart, below }: HardwarePanelBodyProps) {
  const [ref, size] = useElementSize<HTMLDivElement>()
  const mode = hardwarePanelMode(size)

  return (
    <div
      ref={ref}
      // Inline rather than `h-full`: the measured height decides the mode, so
      // it must hold anywhere the component renders — including the browser
      // test project, which runs no Tailwind build (same rule as GridPage).
      style={{ height: '100%' }}
      className="flex flex-col min-h-0 min-w-0 overflow-hidden"
    >
      {mode === 'compact' ? (
        <div className="flex-1 min-h-0 min-w-0 flex flex-col justify-center">{compact}</div>
      ) : (
        <>
          <div className="flex-1 flex items-center gap-2 min-w-0 min-h-0 overflow-hidden">
            {mode === 'full' && gauge && <div className="shrink-0">{gauge(gaugeSizePx(size.height))}</div>}
            <div className="flex-1 min-w-0 h-full min-h-0">{chart}</div>
          </div>
          {mode === 'full' && below}
        </>
      )}
    </div>
  )
}
