import { TabsTrigger } from '@/components/ui/tabs'
import { engineDisplayName } from '@/lib/format'
import { getProviderLogo } from '@/lib/providerLogo'
import type { EngineSnapshot } from '@/types/metrics'

interface EngineTabProps {
  engine: EngineSnapshot
  /** Rotation cycle counter — used as `key` so the CSS countdown animation restarts per cycle. */
  cycle?: number
  /** Current cycle duration in ms. `0` disables the countdown animation. */
  intervalMs?: number
  /** `true` when this tab is the active tab AND rotation is enabled. */
  showCountdown?: boolean
}

/**
 * Strip the "organization/" prefix from a HuggingFace-style id so only the
 * model name itself shows (e.g. "Qwen/Qwen2.5-7B-Instruct" -> "Qwen2.5-7B-Instruct").
 * No length cap — let CSS handle ellipsis when the tab row is too narrow.
 */
function shortenModelName(name: string): string {
  return name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name
}

/** Pull ":port" from an endpoint URL. Returns null if parsing fails. */
function portFromEndpoint(endpoint: string): string | null {
  try {
    const url = new URL(endpoint)
    return url.port ? `:${url.port}` : null
  } catch {
    const match = endpoint.match(/:(\d+)(?:\/|$)/)
    return match ? `:${match[1]}` : null
  }
}

export function EngineTab({ engine, cycle, intervalMs, showCountdown }: EngineTabProps) {
  const displayName = engineDisplayName(engine.engine_type)
  const statusLabel = engine.status.type === 'Error'
    ? `Error: ${engine.status.message}`
    : engine.status.type
  const isStopped = engine.status.type === 'Stopped'
  const isDocker = engine.deployment_mode === 'Docker'
  const modeLabel = isDocker ? 'Docker' : 'Direct'

  const instanceLabel = engine.model?.name
    ? shortenModelName(engine.model.name)
    : portFromEndpoint(engine.endpoint) ?? displayName

  const providerLogo = getProviderLogo(engine.model?.name)

  const showBar = showCountdown === true && typeof intervalMs === 'number' && intervalMs > 0

  return (
    <TabsTrigger
      value={`${engine.engine_type}-${engine.endpoint}`}
      className={`relative flex items-center gap-2.5 px-6 py-4 leading-none rounded-md transition-colors duration-200 min-w-0 !flex-initial hover:bg-white/[0.03] data-[active]:bg-white/[0.05] ${
        isStopped ? 'opacity-40' : ''
      } data-[active]:border-b-2 data-[active]:border-[#76B900]`}
      aria-label={`${displayName} ${instanceLabel} · ${modeLabel} - ${statusLabel}`}
    >
      {providerLogo && (
        <span className="h-5 w-5 shrink-0 rounded bg-white p-0.5 flex items-center justify-center ring-1 ring-white/[0.06]">
          <img
            src={providerLogo.url}
            alt={providerLogo.alt}
            className="h-full w-full object-contain"
            onError={(e) => {
              const tile = e.currentTarget.parentElement
              if (tile) tile.style.display = 'none'
            }}
          />
        </span>
      )}
      <span
        className={`text-xs font-semibold tracking-tight leading-none truncate min-w-0 ${
          isStopped ? 'text-zinc-600' : 'text-zinc-200'
        }`}
        title={engine.model?.name ?? engine.endpoint}
      >
        {instanceLabel}
      </span>
      {showBar && (
        <span
          key={cycle}
          aria-hidden="true"
          className="tab-rotation-bar absolute left-0 bottom-0 h-0.5 w-full bg-[#76B900]/70"
          style={{ ['--rotation-duration' as string]: `${intervalMs}ms` }}
        />
      )}
    </TabsTrigger>
  )
}
