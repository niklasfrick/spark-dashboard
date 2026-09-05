import type { ReactNode } from 'react'
import { useElementSize } from '@/hooks/useElementSize'
import type { EngineIdentity } from './engineLabel'
import { ProviderMark } from './engineIdentity'
import { enginePanelMode } from './mode'

interface EnginePanelBodyProps {
  /** Which engine this panel is showing — its name, and the provider of the
   *  model it serves. Both null on a single-engine host, which keeps the row
   *  out of the layout entirely. */
  identity?: EngineIdentity
  /** Controls belonging to this panel — the SLO thresholds, the latency mode.
   *  They share the label row, so they cost no height of their own. */
  actions?: ReactNode
  /** The values. Always rendered: they are what the panel is for. */
  tiles: ReactNode
  /** The trend chart, given the room the tiles leave. Omitted by panels that
   *  have no series worth charting. */
  chart?: ReactNode
}

/**
 * The shared body of every engine panel: measures its own box and drops the
 * chart when the tiles have taken the height.
 *
 * The label row is how a panel keeps its promise not to show one engine's
 * numbers under another's name — with several engines on a host, "Latency"
 * alone does not say whose.
 */
export function EnginePanelBody({ identity, actions, tiles, chart }: EnginePanelBodyProps) {
  const { label, model, logo, modelWarning } = identity ?? {
    label: null,
    model: null,
    logo: null,
    modelWarning: null,
  }
  const [ref, size] = useElementSize<HTMLDivElement>()
  const mode = enginePanelMode(size)

  return (
    <div
      ref={ref}
      // Inline rather than `h-full`: the measured height decides the mode, so it
      // must hold anywhere the component renders — including the browser test
      // project, which runs no Tailwind build (same rule as GridPage).
      style={{ height: '100%' }}
      className="flex flex-col min-h-0 min-w-0 overflow-hidden gap-1"
    >
      {(label || actions) && (
        <div className="shrink-0 flex items-center justify-between gap-2 min-w-0">
          {label && (
            // The model first, because that is what an operator is thinking
            // about; the endpoint after it, because that is what actually tells
            // two engines apart when both serve the same model.
            <span
              className="flex items-center gap-1.5 min-w-0"
              title={
                [model, label, modelWarning].filter(Boolean).join(' — ') || undefined
              }
            >
              {logo && <ProviderMark logo={logo} />}
              {/* The row has no room for the warning's words, so it wears the
                  mark and carries the words in the row's tooltip. */}
              {modelWarning && (
                <span aria-label={modelWarning} className="text-[10px] leading-none text-amber-400">
                  ⚠
                </span>
              )}
              {model && (
                <span className="text-[10px] font-medium text-zinc-300 truncate">{model}</span>
              )}
              <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500 truncate">
                {label}
              </span>
            </span>
          )}
          {actions}
        </div>
      )}
      <div className="shrink-0 min-w-0">{tiles}</div>
      {mode === 'full' && chart && <div className="flex-1 min-h-0 min-w-0">{chart}</div>}
    </div>
  )
}
