import { useLatestSnapshot } from '@/hooks/useMetricsStore'
import { engineDisplayName, engineIconSrc } from '@/lib/format'
import type { EngineSnapshot } from '@/types/metrics'

const STATUS_CLASS: Record<EngineSnapshot['status']['type'], string> = {
  Running: 'bg-green-500',
  Loading: 'bg-amber-500',
  Stopped: 'bg-zinc-600',
  Error: 'bg-red-500',
}

const STATUS_WORD: Record<EngineSnapshot['status']['type'], string> = {
  Running: 'serving',
  Loading: 'loading',
  Stopped: 'stopped',
  Error: 'error',
}

/**
 * One chip per detected inference engine, in the app header beside the HEC
 * status dot. Each reads `<status colour> <engine logo> <engine name>` — the
 * at-a-glance answer to "which engines are up on this host", shown for *every*
 * engine rather than the one a panel happens to be bound to (a multi-engine
 * host running vLLM and llama.cpp must not read as vLLM-only).
 *
 * Re-renders on each snapshot because an engine's status is the thing it
 * exists to report; when none are detected yet there is nothing to name, so it
 * disappears rather than render an empty row.
 */
export function EngineStatusStrip() {
  const snapshot = useLatestSnapshot()
  const engines = snapshot?.engines ?? []
  if (engines.length === 0) return null

  return (
    <div className="flex items-center gap-1.5">
      {engines.map((engine) => {
        const type = engine.status.type
        const tooltip =
          engine.status.type === 'Error'
            ? `${engineDisplayName(engine.engine_type)} — ${engine.status.message}`
            : `${engineDisplayName(engine.engine_type)} — ${STATUS_WORD[type]} (${engine.endpoint})`
        return (
          <div
            key={engine.endpoint}
            title={tooltip}
            className="flex items-center gap-1.5 border border-white/[0.06] rounded-md px-2 py-1"
          >
            <span
              aria-label={tooltip}
              className={`inline-block h-2 w-2 rounded-full ${STATUS_CLASS[type]}`}
            />
            <img src={engineIconSrc(engine.engine_type)} alt="" className="h-3.5 w-3.5" />
            <span className="text-sm text-zinc-400 font-normal">
              {engineDisplayName(engine.engine_type)}
            </span>
          </div>
        )
      })}
    </div>
  )
}
