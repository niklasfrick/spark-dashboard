import { AnimatedCounter } from '@/components/engines/AnimatedCounter'
import { formatExactTokens } from '@/lib/format'
import { EnginePanelBody } from './EnginePanelBody'
import { engineIdentity } from './engineLabel'
import { EnginePanelNotice } from './PanelNotice'
import { MultiEnginePanelBody } from './MultiEnginePanelBody'
import { useEnginePanel, useEngineRows } from './useEnginePanel'
import type { PanelContentProps } from '../panelRegistry'

/**
 * The engine's lifetime token volumes: the prompts it has read, the tokens it
 * has written, and the sum of the two — the three counters in one panel,
 * rather than a total an operator has to derive off two throughput panels.
 *
 * The counters are cumulative since engine start, so the panel wears them as
 * animated counters and charts nothing — the same shape as the speculative-
 * decoding panel, which also reads only cumulative counters.
 */
export function EngineTokensPanel({ panel }: PanelContentProps) {
  const rows = useEngineRows(panel)
  const resolution = useEnginePanel(panel)
  if (rows.status === 'rows') {
    // One row per engine, each on its own lifetime total — the combined
    // figure the panel could show on an all-models page is gone, the way the
    // throughput panels divided across engines.
    return (
      <MultiEnginePanelBody
        seriesLabel="Total tokens"
        rows={rows.rows}
        pick={(row) => {
          const metric = row.metric
          if (!metric) return { value: null, unit: ' tok', data: [] }
          const input = metric('total_prompt_tokens')
          const output = metric('total_generation_tokens')
          // The total is the sum of the two counters; one absent counter
          // means the sum cannot be read, so it stands dashed.
          const total = input !== null && output !== null ? input + output : null
          return {
            value: total,
            // The total wears a row of its own beside Input and Output — the
            // shape the single view stacks it into — at half the single view's
            // size, and it is no longer the row's headline figure.
            hideValue: true,
            unit: ' tok',
            tiles: (
              <div className="flex flex-col gap-1.5">
                <TokenCounter
                  label="Input"
                  value={input}
                  valueColor="text-[#3b82f6]"
                  valueClass={ROW_TOKEN_SIZE}
                />
                <TokenCounter
                  label="Output"
                  value={output}
                  valueColor="text-[#a855f7]"
                  valueClass={ROW_TOKEN_SIZE}
                />
                <TokenCounter
                  label="Total Tokens"
                  value={total}
                  valueColor="text-[#76B900]"
                  valueClass={ROW_TOKEN_SIZE}
                />
              </div>
            ),
            data: [],
          }
        }}
      />
    )
  }
  if (resolution.status !== 'resolved' && resolution.status !== 'aggregate') {
    return <EnginePanelNotice resolution={resolution} />
  }

  const { metric } = resolution
  const input = metric('total_prompt_tokens')
  const output = metric('total_generation_tokens')
  const total = input !== null && output !== null ? input + output : null

  return (
    <EnginePanelBody
      identity={engineIdentity(resolution)}
      tiles={
        // No chart, so the counters own the whole box: one per row, centered
        // in it and set large enough to read across the room.
        <div className="flex h-full min-w-0 flex-col justify-center gap-2 2xl:gap-3">
          <TokenCounter label="Input" value={input} valueColor="text-[#3b82f6]" />
          <TokenCounter label="Output" value={output} valueColor="text-[#a855f7]" />
          <TokenCounter label="Total Tokens" value={total} headline valueColor="text-[#76B900]" />
        </div>
      }
    />
  )
}

/** One cumulative token counter: its label, the exact figure and its unit.
 *  Exact rather than abbreviated — at 100M+ tokens the compact form hides
 *  the per-second motion, while the full figure ticks visibly. The label
 *  keeps the KPI name's light grey, one step larger than the other panels'
 *  for a panel whose content is the figures; the figure itself carries the
 *  counter's colour. Shared with the row view, which wears the non-headline
 *  size for its In/Out figures. */

/** The row view's counter figures at half the single view's tile size —
 *  30/36/48/60/72px halved, on the nearest Tailwind step (15→16). */
const ROW_TOKEN_SIZE =
  'text-base xl:text-lg 2xl:text-2xl min-[1920px]:text-3xl min-[2560px]:text-4xl'

export function TokenCounter({
  label,
  value,
  headline,
  valueColor,
  valueClass,
}: {
  label: string
  value: number | null
  headline?: boolean
  /** The figure's colour — each counter is named by its number. */
  valueColor?: string
  /** Replaces the counter's default size — the row view wears half size. */
  valueClass?: string
}) {
  const sizeClass =
    valueClass ??
    (headline
      ? 'text-4xl xl:text-5xl 2xl:text-6xl min-[1920px]:text-7xl min-[2560px]:text-8xl'
      : 'text-3xl xl:text-4xl 2xl:text-5xl min-[1920px]:text-6xl min-[2560px]:text-7xl')
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-xs 2xl:text-sm min-[1920px]:text-base font-medium uppercase tracking-wider truncate text-zinc-400">
        {label}
      </span>
      <div className="flex items-baseline min-w-0">
        <AnimatedCounter
          value={value}
          format={formatExactTokens}
          className={`${sizeClass} font-bold font-mono tabular-nums leading-none truncate ${valueColor ?? 'text-zinc-100'}`}
        />
        <span className="text-xs 2xl:text-sm min-[1920px]:text-base ml-1.5 text-zinc-500">tok</span>
      </div>
    </div>
  )
}
