import type { ReactNode } from 'react'
import { useElementSize } from '@/hooks/useElementSize'
import type { EngineIdentity } from './engineLabel'
import { ProviderMark } from './engineIdentity'
import { engineTileScale, enginePanelMode } from './mode'

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
  /** How many rows the tiles stack into — what the type scale is divided by.
   *  Panels count their own, because only they know how many tiles they drew;
   *  see `engineTileScale`. */
  tileRows?: number
  /** The trend chart, given the room the tiles leave. Omitted by panels that
   *  have no series worth charting. */
  chart?: ReactNode
}

/**
 * The shared body of every engine panel: measures its own box, sizes the tiles
 * to it, and drops the chart when the tiles have taken the height.
 *
 * Both halves of "adapt to the box" live here. The chart goes when there is no
 * height for it, and the tiles that remain are scaled and spread to fill what
 * is left — a panel resized small shrinks its numbers instead of cutting them
 * off, and one resized large grows them instead of leaving the box empty under
 * them.
 *
 * The label row is how a panel keeps its promise not to show one engine's
 * numbers under another's name — with several engines on a host, "Latency"
 * alone does not say whose.
 */
export function EnginePanelBody({
  identity,
  actions,
  tiles,
  tileRows = 2,
  chart,
}: EnginePanelBodyProps) {
  const { label, model, logo, modelWarning, coverage } = identity ?? {
    label: null,
    model: null,
    logo: null,
    modelWarning: null,
    coverage: null,
  }
  const [ref, size] = useElementSize<HTMLDivElement>()
  // A panel that hands over no chart is in the same position as one whose box
  // is too short to hold it: the tiles have the whole box, so they are sized
  // and spread against all of it.
  const charted = enginePanelMode(size) === 'full' && Boolean(chart)
  const scale = engineTileScale(size, tileRows, charted ? 'full' : 'tiles')

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
                [model, label, coverage, modelWarning].filter(Boolean).join(' — ') ||
                undefined
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
              {/* After "2 of 3 serving", so the two counts read together: how
                  many engines are serving, and how many the figures cover. */}
              {coverage && (
                <span className="text-[10px] font-medium text-zinc-500 truncate">{coverage}</span>
              )}
            </span>
          )}
          {actions}
        </div>
      )}
      <div
        // The scale is the tile block's own font size, and every size inside a
        // tile is an em of it. Inline for the same reason the height is: the
        // measurement has to reach the tiles wherever this renders.
        data-panel-tiles
        style={{ fontSize: `${scale}px` }}
        className={
          charted
            ? 'shrink-0 min-w-0'
            : // Uncharted: the tiles are the panel, so they take the box. The
              // child is whatever grid the panel drew, stretched to fill it.
              'flex-1 min-h-0 min-w-0 flex flex-col [&>*]:flex-1 [&>*]:min-h-0'
        }
      >
        {tiles}
      </div>
      {charted && <div className="flex-1 min-h-0 min-w-0">{chart}</div>}
    </div>
  )
}
